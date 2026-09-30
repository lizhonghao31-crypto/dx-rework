-- Repair the tail-stage defective quantity write path and make its ledger
-- append-only under the same trusted audit context as the parent order update.

CREATE OR REPLACE FUNCTION guard_rework_tail_defective_quantity_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_orders target
    WHERE target.rework_order_id=NEW.rework_order_id
      AND target.status IN (
        'pending_process_configuration',
        'pending_ie_review',
        'pending_task_assignment',
        'in_progress',
        'pending_order_review',
        'pending_final_quantity_ie_review',
        'pending_quantity_adjustment_ie_review',
        'pending_responsibility_determination',
        'pending_owner_signature',
        'pending_responsibility_action'
      )
  ) THEN
    RAISE EXCEPTION 'tail defective quantity requires an active rework order'
      USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=NEW.operation_event_id
      AND event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=NEW.request_id
      AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.actor_id=NEW.recorded_by
      AND event.actor_roles && ARRAY['tail_supervisor','owner_group','root_superuser']::text[]
      AND event.action='rework.tail_defective_quantity.add'
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
      AND event.after_state @> jsonb_build_object(
        'reworkOrderId',NEW.rework_order_id,
        'entryId',NEW.entry_id,
        'addedQuantity',NEW.quantity
      )
  ) THEN
    RAISE EXCEPTION 'tail defective quantity requires matching trusted audit event'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_tail_defective_quantity_entries_guard_insert
  BEFORE INSERT ON rework_tail_defective_quantity_entries
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_defective_quantity_entry();
CREATE TRIGGER rework_tail_defective_quantity_entries_no_update
  BEFORE UPDATE ON rework_tail_defective_quantity_entries
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_defective_quantity_entries_no_delete
  BEFORE DELETE ON rework_tail_defective_quantity_entries
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_defective_quantity_entries_no_truncate
  BEFORE TRUNCATE ON rework_tail_defective_quantity_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

DO $migration$
DECLARE
  guard_source text;
  insertion_point integer;
  tail_defective_guard constant text := $guard$
  IF TG_OP='UPDATE'
     AND NEW.version=OLD.version+1
     AND NEW.updated_at>OLD.updated_at
     AND NEW.status=OLD.status
     AND NEW.status IN (
       'pending_process_configuration',
       'pending_ie_review',
       'pending_task_assignment',
       'in_progress',
       'pending_order_review',
       'pending_final_quantity_ie_review',
       'pending_quantity_adjustment_ie_review',
       'pending_responsibility_determination',
       'pending_owner_signature',
       'pending_responsibility_action'
     )
     AND (to_jsonb(NEW)-ARRAY['updated_by','version','updated_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['updated_by','version','updated_at'])
     AND EXISTS (
       SELECT 1
       FROM operation_events event
       WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.actor_id=NEW.updated_by
         AND event.actor_roles && ARRAY['tail_supervisor','owner_group','root_superuser']::text[]
         AND event.action='rework.tail_defective_quantity.add'
         AND event.entity_type='rework_order'
         AND event.entity_id=NEW.rework_order_id::text
         AND event.before_state @> jsonb_build_object(
           'reworkOrderId',OLD.rework_order_id,
           'version',OLD.version
         )
         AND event.after_state @> jsonb_build_object(
           'reworkOrderId',NEW.rework_order_id,
           'version',NEW.version
         )
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
    RAISE EXCEPTION 'guard_rework_order_write() is required before migration 0136';
  END IF;
  IF position('rework.tail_defective_quantity.add' IN guard_source)>0 THEN
    RETURN;
  END IF;
  insertion_point:=position('BEGIN' IN guard_source);
  IF insertion_point=0 THEN
    RAISE EXCEPTION 'unexpected rework write guard shape in migration 0136';
  END IF;
  guard_source:=overlay(
    guard_source
    placing 'BEGIN' || tail_defective_guard
    from insertion_point
    for length('BEGIN')
  );
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS %L',
    guard_source
  );
END;
$migration$;
