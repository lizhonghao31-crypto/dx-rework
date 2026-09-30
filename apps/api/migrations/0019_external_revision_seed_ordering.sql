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

-- Preserve the immutable event already emitted by the reviewed service while
-- mapping its accidental past-tense spelling to the canonical action required
-- by the established external and rework-order guards.
CREATE OR REPLACE FUNCTION require_external_responsibility_event(
  expected_action text,
  expected_capability text,
  order_id uuid,
  persisted_actor uuid
) RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  compatible_action text;
BEGIN
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=nullif(
      current_setting('dx_rework.external_responsibility_event_id',true),''
    )::uuid
    AND request_id=nullif(
      current_setting('dx_rework.external_responsibility_request_id',true),''
    );
  compatible_action:=CASE expected_action
    WHEN 'rework.external_responsibility.revision.approve'
      THEN 'rework.external_responsibility.revision.approved'
    WHEN 'rework.external_responsibility.revision.reject'
      THEN 'rework.external_responsibility.revision.rejected'
    ELSE NULL
  END;
  IF event_record.event_id IS NULL
     OR event_record.actor_id<>persisted_actor
     OR (
       event_record.action<>expected_action
       AND (
         compatible_action IS NULL
         OR event_record.action<>compatible_action
       )
     )
     OR event_record.authorization_capability<>expected_capability
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>order_id::text THEN
    RAISE EXCEPTION 'external responsibility write requires matching trusted event'
      USING ERRCODE='55000';
  END IF;
  RETURN event_record;
END $$;

CREATE OR REPLACE FUNCTION map_external_revision_approval_event_for_order()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_event operation_events%ROWTYPE;
  canonical_event_id uuid;
BEGIN
  IF TG_OP<>'UPDATE'
     OR NEW.status<>'pending_responsibility_determination'
     OR OLD.status NOT IN ('pending_responsibility_action','completed') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source_event
  FROM operation_events
  WHERE event_id=nullif(
      current_setting('dx_rework.rework_event_id',true),''
    )::uuid
    AND request_id=nullif(
      current_setting('dx_rework.rework_request_id',true),''
    );
  IF source_event.event_id IS NULL
     OR source_event.action<>'rework.external_responsibility.revision.approved'
     OR source_event.authorization_capability<>'external_responsibility:approve_revision'
     OR source_event.entity_type<>'rework_order'
     OR source_event.entity_id<>NEW.rework_order_id::text THEN
    RETURN NEW;
  END IF;
  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  ) VALUES (
    gen_random_uuid(),source_event.request_id,source_event.actor_id,
    source_event.actor_roles,source_event.authorization_capability,
    'rework.external_responsibility.revision.approve',
    source_event.entity_type,source_event.entity_id,
    source_event.before_state,source_event.after_state,source_event.reason
  )
  RETURNING event_id INTO canonical_event_id;
  PERFORM set_config(
    'dx_rework.rework_event_id',canonical_event_id::text,true
  );
  RETURN NEW;
END $$;

CREATE TRIGGER aaa_external_revision_approval_event_alias
  BEFORE UPDATE ON rework_orders
  FOR EACH ROW EXECUTE FUNCTION map_external_revision_approval_event_for_order();
