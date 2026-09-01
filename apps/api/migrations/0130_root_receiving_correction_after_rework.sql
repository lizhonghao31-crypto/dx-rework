-- Root may correct a receiving batch after rework initiation. The immutable
-- receipt facts stay untouched; the receiving adjustment ledger is the source
-- of corrected quantities, and linked rework style identity follows the batch.

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
  IF action_name<>'correct'
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

DO $migration$
DECLARE
  guard_source text;
  insertion_point integer;
  root_correction_guard constant text := $guard$
  IF TG_OP='UPDATE'
     AND current_setting('dx_rework.receiving_root_action',true)='correct'
     AND NEW.source_receiving_batch_id IS NOT NULL
     AND NEW.source_receiving_batch_id IS NOT DISTINCT FROM OLD.source_receiving_batch_id
     AND NEW.version=OLD.version+1
     AND NEW.updated_at>OLD.updated_at
     AND (to_jsonb(NEW)-ARRAY['style_no','updated_by','version','updated_at'])
         IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['style_no','updated_by','version','updated_at'])
     AND EXISTS(
       SELECT 1 FROM operation_events event
       WHERE event.event_id=nullif(current_setting('dx_rework.receiving_event_id',true),'')::uuid
         AND event.request_id=current_setting('dx_rework.receiving_request_id',true)
         AND event.actor_id=NEW.updated_by
         AND event.actor_roles @> ARRAY['root_superuser']::text[]
         AND event.authorization_capability='receiving:correct'
         AND event.action='receiving.batch.correct'
         AND event.entity_type='receiving_batch'
         AND event.entity_id=NEW.source_receiving_batch_id::text
         AND event.before_state->>'styleNo' IS NOT DISTINCT FROM OLD.style_no
         AND event.after_state->>'styleNo' IS NOT DISTINCT FROM NEW.style_no
     )
  THEN
    RETURN NEW;
  END IF;
$guard$;
BEGIN
  SELECT proc.prosrc
  INTO guard_source
  FROM pg_proc proc
  JOIN pg_namespace ns ON ns.oid=proc.pronamespace
  WHERE ns.nspname=current_schema()
    AND proc.proname='guard_rework_order_write'
    AND pg_get_function_identity_arguments(proc.oid)=''
  ORDER BY proc.oid DESC
  LIMIT 1;

  IF guard_source IS NULL THEN
    RAISE EXCEPTION 'guard_rework_order_write() is required before migration 0130';
  END IF;
  IF position('receiving.batch.correct' IN guard_source)>0 THEN
    RETURN;
  END IF;
  insertion_point:=position('BEGIN' IN guard_source);
  IF insertion_point=0 THEN
    RAISE EXCEPTION 'unexpected rework write guard shape in migration 0130';
  END IF;
  guard_source:=overlay(
    guard_source
    placing 'BEGIN' || root_correction_guard
    from insertion_point
    for length('BEGIN')
  );
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS %L',
    guard_source
  );
END;
$migration$;
