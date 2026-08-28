-- Root-only pre-rework correction may merge a typo batch into the existing
-- canonical style batch and may replace incorrectly uploaded receiving images.
-- Immutable receipt facts and retired image objects remain auditable.

CREATE TABLE receiving_attachment_retirements (
  attachment_id uuid PRIMARY KEY REFERENCES attachments(attachment_id),
  receiving_batch_id uuid NOT NULL REFERENCES receiving_batches(receiving_batch_id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  retired_by uuid NOT NULL REFERENCES app_users(id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  retired_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX receiving_attachment_retirements_batch_idx
  ON receiving_attachment_retirements(receiving_batch_id,retired_at,attachment_id);

CREATE OR REPLACE FUNCTION guard_receiving_attachment_retirement_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=NEW.operation_event_id
      AND event.request_id=NEW.request_id
      AND event.actor_id=NEW.retired_by
      AND event.authorization_capability='receiving:correct'
      AND event.actor_roles @> ARRAY['root_superuser']::text[]
      AND event.action='receiving.batch.images.replace'
      AND event.entity_type='receiving_batch'
      AND event.entity_id=NEW.receiving_batch_id::text
      AND event.after_state->'replacedAttachmentIds' ? NEW.attachment_id::text
  ) THEN
    RAISE EXCEPTION 'receiving image retirement requires matching root audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receiving_attachment_retirements_guard_insert
  BEFORE INSERT ON receiving_attachment_retirements
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_attachment_retirement_insert();
CREATE TRIGGER receiving_attachment_retirements_no_update
  BEFORE UPDATE ON receiving_attachment_retirements
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER receiving_attachment_retirements_no_delete
  BEFORE DELETE ON receiving_attachment_retirements
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER receiving_attachment_retirements_no_truncate
  BEFORE TRUNCATE ON receiving_attachment_retirements
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_receiving_receipt_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text:=nullif(current_setting('dx_rework.receiving_event_id',true),'');
  audit_request_id text:=nullif(current_setting('dx_rework.receiving_request_id',true),'');
BEGIN
  IF to_jsonb(NEW)-'receiving_batch_id' IS DISTINCT FROM to_jsonb(OLD)-'receiving_batch_id'
     OR NEW.receiving_batch_id IS NOT DISTINCT FROM OLD.receiving_batch_id
  THEN
    RAISE EXCEPTION 'receiving receipt facts are immutable' USING ERRCODE='55000';
  END IF;
  IF audit_event_id IS NULL OR audit_request_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid
      AND event.request_id=audit_request_id
      AND event.authorization_capability='receiving:correct'
      AND event.actor_roles @> ARRAY['root_superuser']::text[]
      AND event.action='receiving.batch.merge'
      AND event.entity_type='receiving_batch'
      AND event.entity_id=NEW.receiving_batch_id::text
      AND event.after_state->>'sourceReceivingBatchId'=OLD.receiving_batch_id::text
      AND event.after_state->>'targetReceivingBatchId'=NEW.receiving_batch_id::text
  ) THEN
    RAISE EXCEPTION 'receiving receipt merge requires matching root audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER receiving_receipts_no_update ON receiving_receipts;
CREATE TRIGGER receiving_receipts_no_update
  BEFORE UPDATE ON receiving_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_receipt_update();

CREATE OR REPLACE FUNCTION guard_receiving_attachment_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text:=nullif(current_setting('dx_rework.receiving_event_id',true),'');
  audit_request_id text:=nullif(current_setting('dx_rework.receiving_request_id',true),'');
BEGIN
  IF OLD.entity_type='receiving_batch' THEN
    IF NEW.entity_type='receiving_batch'
       AND NEW.entity_id IS DISTINCT FROM OLD.entity_id
       AND to_jsonb(NEW)-'entity_id' IS NOT DISTINCT FROM to_jsonb(OLD)-'entity_id'
       AND audit_event_id IS NOT NULL
       AND audit_request_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM operation_events event
         WHERE event.event_id=audit_event_id::uuid
           AND event.request_id=audit_request_id
           AND event.authorization_capability='receiving:correct'
           AND event.actor_roles @> ARRAY['root_superuser']::text[]
           AND event.action='receiving.batch.merge'
           AND event.entity_type='receiving_batch'
           AND event.entity_id=NEW.entity_id
           AND event.after_state->>'sourceReceivingBatchId'=OLD.entity_id
           AND event.after_state->>'targetReceivingBatchId'=NEW.entity_id
       )
    THEN
      RETURN NEW;
    END IF;
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound receiving evidence is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entity_type IS DISTINCT FROM 'receiving_batch' THEN RETURN NEW; END IF;
  IF OLD.entity_type IS NOT NULL OR OLD.entity_id IS NOT NULL OR NEW.entity_id IS NULL THEN
    RAISE EXCEPTION 'receiving evidence cannot be moved directly between entities'
      USING ERRCODE='23514';
  END IF;
  IF NEW.status<>'ready' THEN
    RAISE EXCEPTION 'only ready receiving evidence can be bound' USING ERRCODE='23514';
  END IF;
  IF audit_event_id IS NULL OR audit_request_id IS NULL THEN
    RAISE EXCEPTION 'receiving attachment binding requires trusted audit context'
      USING ERRCODE='55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid
      AND event.request_id=audit_request_id
      AND event.actor_id=NEW.uploaded_by
      AND event.authorization_capability='receiving:create'
      AND event.action='receiving.receipt.create'
      AND event.entity_type='receiving_receipt'
      AND event.after_state->>'receivingBatchId'=NEW.entity_id
      AND event.after_state->'attachmentIds' ? NEW.attachment_id::text
  ) OR EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid
      AND event.request_id=audit_request_id
      AND event.actor_id=NEW.uploaded_by
      AND event.authorization_capability='receiving:correct'
      AND event.actor_roles @> ARRAY['root_superuser']::text[]
      AND event.action='receiving.batch.images.replace'
      AND event.entity_type='receiving_batch'
      AND event.entity_id=NEW.entity_id
      AND event.after_state->'attachmentIds' ? NEW.attachment_id::text
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'receiving attachment audit event does not match the binding'
    USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_receiving_batch_root_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),'');
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'deleted receiving batch is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.receiving_batch_id IS DISTINCT FROM OLD.receiving_batch_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version<>OLD.version+1 OR NEW.updated_at<=OLD.updated_at
     OR NEW.updated_by IS NULL OR NEW.last_operation_event_id IS NULL OR NEW.last_request_id IS NULL
  THEN RAISE EXCEPTION 'invalid receiving batch correction shape' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM rework_orders rework WHERE rework.source_receiving_batch_id=OLD.receiving_batch_id) THEN
    RAISE EXCEPTION 'receiving batch is locked after rework initiation' USING ERRCODE='55000';
  END IF;
  SELECT * INTO event_record FROM operation_events event
  WHERE event.event_id=NEW.last_operation_event_id AND event.request_id=NEW.last_request_id
    AND event.actor_id=NEW.updated_by AND event.authorization_capability='receiving:correct'
    AND event.actor_roles @> ARRAY['root_superuser']::text[]
    AND event.entity_type='receiving_batch' AND event.entity_id=NEW.receiving_batch_id::text;
  IF event_record.event_id IS NULL THEN RAISE EXCEPTION 'receiving batch change requires trusted root audit event' USING ERRCODE='55000'; END IF;

  IF action_name IN ('correct','merge') THEN
    IF event_record.action<>CASE WHEN action_name='merge' THEN 'receiving.batch.merge' ELSE 'receiving.batch.correct' END
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
       OR (NEW.document_quantity_adjustment+(SELECT COALESCE(sum(document_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id))<=0
       OR (NEW.actual_quantity_adjustment+(SELECT COALESCE(sum(actual_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id))<0
       OR event_record.after_state->>'styleNo' IS DISTINCT FROM NEW.style_no
       OR (event_record.after_state->>'documentQuantity')::bigint IS DISTINCT FROM (NEW.document_quantity_adjustment+(SELECT COALESCE(sum(document_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id))
       OR (event_record.after_state->>'actualQuantity')::bigint IS DISTINCT FROM (NEW.actual_quantity_adjustment+(SELECT COALESCE(sum(actual_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id))
    THEN RAISE EXCEPTION 'receiving correction does not match root audit event' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF action_name='delete' THEN
    IF event_record.action<>'receiving.batch.delete' OR NEW.style_no IS DISTINCT FROM OLD.style_no
       OR NEW.document_quantity_adjustment<>OLD.document_quantity_adjustment OR NEW.actual_quantity_adjustment<>OLD.actual_quantity_adjustment
       OR NEW.deleted_at IS NULL OR NEW.deleted_by IS DISTINCT FROM NEW.updated_by
       OR event_record.after_state->>'deleted' IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'receiving deletion does not match root audit event' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'receiving batch history is immutable' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_receiving_batch_defective_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),''); effective_defective bigint; effective_actual bigint; audited_defective bigint;
BEGIN
  IF action_name IN ('correct','merge') THEN
    effective_defective:=NEW.defective_quantity_adjustment+(SELECT COALESCE(sum(defective_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id);
    effective_actual:=NEW.actual_quantity_adjustment+(SELECT COALESCE(sum(actual_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id);
    SELECT (event.after_state->>'defectiveQuantity')::bigint INTO audited_defective FROM operation_events event WHERE event.event_id=NEW.last_operation_event_id;
    IF effective_defective<0 OR effective_defective>effective_actual OR audited_defective IS DISTINCT FROM effective_defective
    THEN RAISE EXCEPTION 'receiving defective correction does not match root audit event' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF action_name='delete' THEN
    IF NEW.defective_quantity_adjustment<>OLD.defective_quantity_adjustment THEN RAISE EXCEPTION 'receiving deletion cannot change defective quantity' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'receiving defective history is immutable' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_receiving_batch_delivery_note_quantity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),''); effective_document bigint; audited_document bigint;
BEGIN
  IF action_name IN ('correct','merge') THEN
    effective_document:=NEW.document_quantity_adjustment+(SELECT COALESCE(sum(document_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id);
    SELECT (event.after_state->>'documentQuantity')::bigint INTO audited_document FROM operation_events event WHERE event.event_id=NEW.last_operation_event_id;
    IF NEW.delivery_note_quantity IS DISTINCT FROM effective_document OR audited_document IS DISTINCT FROM NEW.delivery_note_quantity
    THEN RAISE EXCEPTION 'receiving delivery-note correction does not match root audit event' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF action_name='delete' THEN
    IF NEW.delivery_note_quantity IS DISTINCT FROM OLD.delivery_note_quantity THEN RAISE EXCEPTION 'receiving deletion cannot change delivery-note quantity' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'receiving delivery-note total is immutable' USING ERRCODE='55000';
END;
$$;
