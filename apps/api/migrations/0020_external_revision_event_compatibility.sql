-- PR-11 review closure: preserve the immutable event already emitted by the
-- reviewed service while mapping its accidental `.approved` spelling to the
-- canonical `.approve` action required by the established order state guard.

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
