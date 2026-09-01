-- Root may merge a typo receiving batch into the canonical batch even when the
-- canonical batch already owns a rework order. The rework link stays on the
-- canonical batch; immutable receipt rows remain available for audit.

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
