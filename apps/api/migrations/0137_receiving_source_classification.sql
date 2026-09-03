-- Classify repeated receipts so warehouse staff can keep the original delivery-note
-- total for 嘉顺 receipts while explicitly adding a new delivery-note quantity for
-- other factories. Existing immutable receipts retain the neutral legacy source.

ALTER TABLE receiving_receipts
  ADD COLUMN receiving_source text NOT NULL DEFAULT 'legacy'
    CHECK(receiving_source IN ('legacy','initial','backfill','jiashun','other_factory'));

CREATE OR REPLACE FUNCTION guard_receiving_receipt_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text:=nullif(current_setting('dx_rework.receiving_event_id',true),'');
  audit_request_id text:=nullif(current_setting('dx_rework.receiving_request_id',true),'');
BEGIN
  IF NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
     OR NEW.style_no IS DISTINCT FROM OLD.style_no
     OR NEW.document_quantity IS DISTINCT FROM OLD.document_quantity
     OR NEW.actual_quantity IS DISTINCT FROM OLD.actual_quantity
     OR NEW.defective_quantity IS DISTINCT FROM OLD.defective_quantity
     OR NEW.receiving_source IS DISTINCT FROM OLD.receiving_source
     OR NEW.received_by IS DISTINCT FROM OLD.received_by
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
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

CREATE OR REPLACE FUNCTION guard_receiving_batch_root_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),'');
  delivery_increment bigint;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'deleted receiving batch is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.receiving_batch_id IS DISTINCT FROM OLD.receiving_batch_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version<>OLD.version+1 OR NEW.updated_at<=OLD.updated_at
     OR NEW.updated_by IS NULL OR NEW.last_operation_event_id IS NULL OR NEW.last_request_id IS NULL
  THEN RAISE EXCEPTION 'invalid receiving batch correction shape' USING ERRCODE='23514'; END IF;

  IF action_name='append_other_factory' THEN
    SELECT * INTO event_record FROM operation_events event
    WHERE event.event_id=NEW.last_operation_event_id AND event.request_id=NEW.last_request_id
      AND event.actor_id=NEW.updated_by AND event.authorization_capability='receiving:create'
      AND event.action='receiving.receipt.create' AND event.entity_type='receiving_receipt'
      AND event.after_state->>'receivingBatchId'=NEW.receiving_batch_id::text
      AND event.after_state->>'receivingSource'='other_factory';
    IF event_record.event_id IS NULL
       OR COALESCE(event_record.after_state->>'deliveryNoteIncrement','') !~ '^[1-9][0-9]*$'
    THEN RAISE EXCEPTION 'other factory delivery-note update requires matching trusted receiving event' USING ERRCODE='55000'; END IF;
    delivery_increment:=(event_record.after_state->>'deliveryNoteIncrement')::bigint;
    IF NEW.style_no IS DISTINCT FROM OLD.style_no
       OR NEW.document_quantity_adjustment<>OLD.document_quantity_adjustment
       OR NEW.actual_quantity_adjustment<>OLD.actual_quantity_adjustment
       OR NEW.defective_quantity_adjustment<>OLD.defective_quantity_adjustment
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
       OR NEW.delivery_note_quantity IS DISTINCT FROM OLD.delivery_note_quantity+delivery_increment
    THEN RAISE EXCEPTION 'other factory delivery-note update does not match receiving event' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;

  IF action_name NOT IN ('correct','merge')
     AND EXISTS(SELECT 1 FROM rework_orders rework WHERE rework.source_receiving_batch_id=OLD.receiving_batch_id)
  THEN RAISE EXCEPTION 'receiving batch is locked after rework initiation' USING ERRCODE='55000'; END IF;
  SELECT * INTO event_record FROM operation_events event
  WHERE event.event_id=NEW.last_operation_event_id AND event.request_id=NEW.last_request_id
    AND event.actor_id=NEW.updated_by AND event.authorization_capability='receiving:correct'
    AND event.actor_roles @> ARRAY['root_superuser']::text[]
    AND event.entity_type='receiving_batch' AND event.entity_id=NEW.receiving_batch_id::text;
  IF event_record.event_id IS NULL THEN RAISE EXCEPTION 'receiving batch change requires trusted root audit event' USING ERRCODE='55000'; END IF;

  IF action_name IN ('correct','merge') THEN
    IF event_record.action<>(CASE WHEN action_name='merge' THEN 'receiving.batch.merge' ELSE 'receiving.batch.correct' END)
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
  IF action_name='append_other_factory' THEN
    IF NEW.defective_quantity_adjustment<>OLD.defective_quantity_adjustment THEN
      RAISE EXCEPTION 'other factory delivery receipt cannot change defective correction' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
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
DECLARE action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),''); effective_document bigint; audited_document bigint; event_record operation_events%ROWTYPE; delivery_increment bigint;
BEGIN
  IF action_name='append_other_factory' THEN
    SELECT * INTO event_record FROM operation_events event
    WHERE event.event_id=NEW.last_operation_event_id AND event.request_id=NEW.last_request_id
      AND event.actor_id=NEW.updated_by AND event.authorization_capability='receiving:create'
      AND event.action='receiving.receipt.create' AND event.entity_type='receiving_receipt'
      AND event.after_state->>'receivingBatchId'=NEW.receiving_batch_id::text
      AND event.after_state->>'receivingSource'='other_factory';
    IF event_record.event_id IS NULL
       OR COALESCE(event_record.after_state->>'deliveryNoteIncrement','') !~ '^[1-9][0-9]*$'
    THEN RAISE EXCEPTION 'other factory delivery-note update requires matching trusted receiving event' USING ERRCODE='55000'; END IF;
    delivery_increment:=(event_record.after_state->>'deliveryNoteIncrement')::bigint;
    IF NEW.delivery_note_quantity IS DISTINCT FROM OLD.delivery_note_quantity+delivery_increment THEN
      RAISE EXCEPTION 'other factory delivery-note quantity does not match receiving event' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
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
