-- Independent cutting groups permit first packing; corrections remain Root-only.
CREATE OR REPLACE FUNCTION guard_receiving_packing_revision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record operation_events%ROWTYPE; actual_roles text[]; style_key text; cutting_id uuid; operation_key text;
BEGIN
  actual_roles:=receiving_authorized_board_operator(NEW.recorded_by,'receiving:packing_manage');
  SELECT upper(btrim(style_no)),cutting_order_id INTO style_key,cutting_id
  FROM receiving_batches WHERE receiving_batch_id=NEW.receiving_batch_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packing requires an active receiving batch' USING ERRCODE='55000';
  END IF;
  -- Match the API's cutting group and legacy style locks. Same-style POs are independent.
  operation_key:=CASE WHEN cutting_id IS NULL THEN style_key ELSE 'cutting:'||cutting_id::text END;
  PERFORM pg_advisory_xact_lock(hashtext(operation_key));
  IF NOT 'root_superuser'=ANY(actual_roles) AND EXISTS (
    SELECT 1 FROM receiving_packing_revisions revision JOIN receiving_batches batch USING(receiving_batch_id)
    WHERE batch.deleted_at IS NULL AND (
      (cutting_id IS NOT NULL AND batch.cutting_order_id=cutting_id)
      OR (cutting_id IS NULL AND batch.cutting_order_id IS NULL AND upper(btrim(batch.style_no))=style_key)
    )
  ) THEN
    RAISE EXCEPTION 'only Root may correct recorded packing quantity' USING ERRCODE='42501',CONSTRAINT='receiving_packing_root_correction_only';
  END IF;
  SELECT * INTO event_record FROM operation_events event
  WHERE event.event_id=NEW.operation_event_id
    AND event.request_id=NEW.request_id
    AND event.actor_id=NEW.recorded_by
    AND event.authorization_capability='receiving:packing_manage'
    AND event.action='receiving.packing.record'
    AND event.entity_type='receiving_batch'
    AND event.entity_id=NEW.receiving_batch_id::text;
  IF event_record.event_id IS NULL
     OR (event_record.after_state->>'packingRevisionId')::uuid IS DISTINCT FROM NEW.packing_revision_id
     OR (event_record.after_state->>'packingQuantity')::bigint IS DISTINCT FROM NEW.packing_quantity
  THEN
    RAISE EXCEPTION 'packing revision requires matching trusted event' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
