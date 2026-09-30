-- Root may correct or logically delete a receiving batch only before any
-- rework draft has ever been created. Immutable receipt facts stay untouched;
-- the batch stores the audited aggregate adjustment used by business views.

ALTER TABLE receiving_batches
  ADD COLUMN document_quantity_adjustment bigint NOT NULL DEFAULT 0,
  ADD COLUMN actual_quantity_adjustment bigint NOT NULL DEFAULT 0,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
  ADD COLUMN updated_by uuid REFERENCES app_users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES app_users(id),
  ADD COLUMN last_operation_event_id uuid REFERENCES operation_events(event_id),
  ADD COLUMN last_request_id text
    CHECK(last_request_id IS NULL OR last_request_id ~ '^[A-Za-z0-9._:-]{1,200}$');

CREATE INDEX receiving_batches_active_style_time_idx
  ON receiving_batches(style_no,created_at,receiving_batch_id)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION guard_receiving_batch_root_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),'');
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'deleted receiving batch is immutable' USING ERRCODE='55000';
  END IF;

  IF NEW.receiving_batch_id IS DISTINCT FROM OLD.receiving_batch_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version<>OLD.version+1
     OR NEW.updated_at<=OLD.updated_at
     OR NEW.updated_by IS NULL
     OR NEW.last_operation_event_id IS NULL
     OR NEW.last_request_id IS NULL
  THEN
    RAISE EXCEPTION 'invalid receiving batch correction shape' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM rework_orders rework
    WHERE rework.source_receiving_batch_id=OLD.receiving_batch_id
  ) THEN
    RAISE EXCEPTION 'receiving batch is locked after rework initiation' USING ERRCODE='55000';
  END IF;

  SELECT * INTO event_record
  FROM operation_events event
  WHERE event.event_id=NEW.last_operation_event_id
    AND event.request_id=NEW.last_request_id
    AND event.actor_id=NEW.updated_by
    AND event.authorization_capability='receiving:correct'
    AND event.actor_roles @> ARRAY['root_superuser']::text[]
    AND event.entity_type='receiving_batch'
    AND event.entity_id=NEW.receiving_batch_id::text;

  IF event_record.event_id IS NULL THEN
    RAISE EXCEPTION 'receiving batch change requires trusted root audit event'
      USING ERRCODE='55000';
  END IF;

  IF action_name='correct' THEN
    IF event_record.action<>'receiving.batch.correct'
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
       OR (NEW.document_quantity_adjustment + (
             SELECT COALESCE(sum(document_quantity),0)
             FROM receiving_receipts receipt
             WHERE receipt.receiving_batch_id=NEW.receiving_batch_id
           ))<=0
       OR (NEW.actual_quantity_adjustment + (
             SELECT COALESCE(sum(actual_quantity),0)
             FROM receiving_receipts receipt
             WHERE receipt.receiving_batch_id=NEW.receiving_batch_id
           ))<0
       OR event_record.after_state->>'styleNo' IS DISTINCT FROM NEW.style_no
       OR (event_record.after_state->>'documentQuantity')::bigint IS DISTINCT FROM
          (NEW.document_quantity_adjustment + (
             SELECT COALESCE(sum(document_quantity),0)
             FROM receiving_receipts receipt
             WHERE receipt.receiving_batch_id=NEW.receiving_batch_id
           ))
       OR (event_record.after_state->>'actualQuantity')::bigint IS DISTINCT FROM
          (NEW.actual_quantity_adjustment + (
             SELECT COALESCE(sum(actual_quantity),0)
             FROM receiving_receipts receipt
             WHERE receipt.receiving_batch_id=NEW.receiving_batch_id
           ))
    THEN
      RAISE EXCEPTION 'receiving correction does not match root audit event'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF action_name='delete' THEN
    IF event_record.action<>'receiving.batch.delete'
       OR NEW.style_no IS DISTINCT FROM OLD.style_no
       OR NEW.document_quantity_adjustment<>OLD.document_quantity_adjustment
       OR NEW.actual_quantity_adjustment<>OLD.actual_quantity_adjustment
       OR NEW.deleted_at IS NULL
       OR NEW.deleted_by IS DISTINCT FROM NEW.updated_by
       OR event_record.after_state->>'deleted' IS DISTINCT FROM 'true'
    THEN
      RAISE EXCEPTION 'receiving deletion does not match root audit event'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'receiving batch history is immutable' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER receiving_batches_no_update ON receiving_batches;
CREATE TRIGGER receiving_batches_no_update
  BEFORE UPDATE ON receiving_batches
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_batch_root_update();

