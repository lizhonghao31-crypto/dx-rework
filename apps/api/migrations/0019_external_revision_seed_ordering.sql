CREATE OR REPLACE FUNCTION guard_external_batch_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_revision rework_external_responsibility_revision_requests%ROWTYPE;
  current_actor uuid;
BEGIN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.finalized_determination_id IS DISTINCT FROM OLD.finalized_determination_id
     OR NEW.finalized_determination_version IS DISTINCT FROM OLD.finalized_determination_version
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.batch_version<>OLD.batch_version+1 THEN
    RAISE EXCEPTION 'external batch source history is immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status='active' AND NEW.status='active' THEN
    SELECT actor_id INTO current_actor
    FROM operation_events
    WHERE event_id=nullif(
      current_setting('dx_rework.external_responsibility_event_id',true),''
    )::uuid;
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.allocate',
      'external_responsibility:sign',
      NEW.rework_order_id,
      current_actor
    );
    RETURN NEW;
  END IF;
  IF OLD.status<>'active' OR NEW.status<>'superseded' THEN
    RAISE EXCEPTION 'invalid external responsibility batch transition'
      USING ERRCODE='23514';
  END IF;
  IF external_responsibility_superseded_by_finalization(
    OLD.finalized_determination_id,NEW.rework_order_id
  ) THEN
    RETURN NEW;
  END IF;
  SELECT revision.* INTO target_revision
  FROM rework_external_responsibility_revision_requests revision
  JOIN rework_external_responsibility_cases target_case
    ON target_case.case_id=revision.case_id
  WHERE target_case.batch_id=NEW.batch_id
    AND revision.status IN ('pending','approved')
  ORDER BY revision.created_at DESC
  LIMIT 1;
  IF target_revision.revision_request_id IS NULL THEN
    RAISE EXCEPTION 'external batch supersession requires its revision request'
      USING ERRCODE='55000';
  END IF;
  SELECT actor_id INTO current_actor
  FROM operation_events
  WHERE event_id=nullif(
    current_setting('dx_rework.external_responsibility_event_id',true),''
  )::uuid;
  PERFORM require_external_responsibility_event(
    'rework.external_responsibility.revision.approve',
    'external_responsibility:approve_revision',
    NEW.rework_order_id,
    current_actor
  );
  RETURN NEW;
END $$;
