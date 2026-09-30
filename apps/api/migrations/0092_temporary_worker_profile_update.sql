-- Root UAT PR-03: controlled temporary-worker profile updates and an explicit
-- N02 default-roster save path. Private values never enter operation_events.

CREATE OR REPLACE FUNCTION guard_business_person_deactivation_only()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  profile_event_id text := nullif(current_setting('dx_rework.temporary_worker_profile_event_id', true), '');
  profile_request_id text := nullif(current_setting('dx_rework.temporary_worker_profile_request_id', true), '');
  profile_actor_id uuid;
  profile_capability text;
  audit_event_id text := nullif(current_setting('dx_rework.person_deactivate_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.person_deactivate_request_id', true), '');
  audit_actor_roles text[];
BEGIN
  IF OLD.active IS TRUE
     AND NEW.active IS TRUE
     AND OLD.person_type='temporary'
     AND (to_jsonb(NEW) - ARRAY[
       'temporary_remark','temporary_phone_number','temporary_identity_number'
     ]) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY[
       'temporary_remark','temporary_phone_number','temporary_identity_number'
     ])
     AND (
       NEW.temporary_remark IS DISTINCT FROM OLD.temporary_remark
       OR NEW.temporary_phone_number IS DISTINCT FROM OLD.temporary_phone_number
       OR NEW.temporary_identity_number IS DISTINCT FROM OLD.temporary_identity_number
     )
  THEN
    IF profile_event_id IS NULL OR profile_request_id IS NULL
       OR profile_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
    THEN
      RAISE EXCEPTION 'temporary worker profile update requires trusted audit context'
        USING ERRCODE='55000';
    END IF;

    SELECT event.actor_id,event.authorization_capability
    INTO profile_actor_id,profile_capability
    FROM operation_events event
    WHERE event.event_id=profile_event_id::uuid
      AND event.request_id=profile_request_id;

    IF profile_actor_id IS NULL
       OR profile_capability NOT IN ('temporary_worker:manage','master_data:manage')
    THEN
      RAISE EXCEPTION 'temporary worker profile update requires an authorized capability'
        USING ERRCODE='42501';
    END IF;
    audit_actor_roles := access_authorized_actor_roles(profile_actor_id,profile_capability);

    IF NOT EXISTS (
      SELECT 1
      FROM operation_events event
      WHERE event.event_id=profile_event_id::uuid
        AND event.request_id=profile_request_id
        AND event.actor_id=profile_actor_id
        AND event.actor_roles=audit_actor_roles
        AND event.authorization_capability=profile_capability
        AND event.action='master_data.temporary_worker_profile.update'
        AND event.entity_type='business_person'
        AND event.entity_id=OLD.person_id::text
        AND (event.before_state->>'hasTemporaryRemark')::boolean=(OLD.temporary_remark IS NOT NULL)
        AND (event.before_state->>'hasTemporaryPhoneNumber')::boolean=(OLD.temporary_phone_number IS NOT NULL)
        AND (event.before_state->>'hasTemporaryIdentityNumber')::boolean=(OLD.temporary_identity_number IS NOT NULL)
        AND (event.after_state->>'hasTemporaryRemark')::boolean=(NEW.temporary_remark IS NOT NULL)
        AND (event.after_state->>'hasTemporaryPhoneNumber')::boolean=(NEW.temporary_phone_number IS NOT NULL)
        AND (event.after_state->>'hasTemporaryIdentityNumber')::boolean=(NEW.temporary_identity_number IS NOT NULL)
        AND length(btrim(event.reason)) BETWEEN 1 AND 500
    ) THEN
      RAISE EXCEPTION 'temporary worker profile update event does not match the row'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.active IS DISTINCT FROM true
     OR NEW.active IS DISTINCT FROM false
     OR NEW.deactivated_at IS NULL OR NEW.deactivated_by IS NULL OR NEW.deactivate_reason IS NULL
     OR (to_jsonb(NEW) - ARRAY[
       'active','deactivated_at','deactivated_by','deactivate_reason'
     ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
       'active','deactivated_at','deactivated_by','deactivate_reason'
     ])
  THEN
    RAISE EXCEPTION 'business person identity is immutable except for one controlled deactivation'
      USING ERRCODE='55000';
  END IF;
  IF OLD.person_type <> 'temporary' THEN
    RAISE EXCEPTION 'internal person status is controlled by DingTalk employment state'
      USING ERRCODE='23514';
  END IF;
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'business person deactivation requires trusted audit context'
      USING ERRCODE='55000';
  END IF;
  audit_actor_roles := access_authorized_actor_roles(NEW.deactivated_by,'master_data:manage');
  IF EXISTS (
    SELECT 1 FROM business_person_aliases alias
    WHERE alias.person_id=OLD.person_id AND alias.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'active aliases must be revoked before person deactivation'
      USING ERRCODE='23514';
  END IF;

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.deactivated_by,audit_actor_roles,'master_data:manage',
    'master_data.person.deactivate','business_person',OLD.person_id::text,
    jsonb_build_object(
      'personType',OLD.person_type,
      'appUserId',OLD.app_user_id,
      'displayName',OLD.display_name,
      'active',OLD.active
    ),
    jsonb_build_object(
      'active',NEW.active,
      'deactivatedAt',NEW.deactivated_at,
      'deactivatedBy',NEW.deactivated_by,
      'deactivateReason',NEW.deactivate_reason
    ),
    NEW.deactivate_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_process_default_worker_roster_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_roles text[];
  audit_capability text;
BEGIN
  IF cardinality(NEW.person_ids) <> (
    SELECT count(DISTINCT person_id) FROM unnest(NEW.person_ids) AS person(person_id)
  ) THEN
    RAISE EXCEPTION 'default worker roster contains duplicate people' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.person_ids) AS selected(person_id)
    LEFT JOIN business_people person ON person.person_id=selected.person_id
    WHERE person.person_id IS NULL OR person.active=false OR NOT (
      person.person_type='temporary'
      OR EXISTS (
        SELECT 1 FROM user_role_assignments assignment
        WHERE assignment.user_id=person.app_user_id
          AND assignment.role_code='worker' AND assignment.revoked_at IS NULL
      )
    )
  ) THEN
    RAISE EXCEPTION 'default worker roster contains an ineligible person' USING ERRCODE='23514';
  END IF;

  SELECT event.authorization_capability
  INTO audit_capability
  FROM operation_events event
  WHERE event.event_id=NEW.operation_event_id
    AND event.actor_id=NEW.changed_by;
  IF audit_capability NOT IN ('master_data:manage','process:configure') THEN
    RAISE EXCEPTION 'default worker roster requires an authorized capability' USING ERRCODE='42501';
  END IF;
  expected_roles := access_authorized_actor_roles(NEW.changed_by,audit_capability);
  IF audit_capability='process:configure'
     AND NOT (expected_roles @> ARRAY['tail_supervisor'] OR expected_roles @> ARRAY['root_superuser'])
  THEN
    RAISE EXCEPTION 'only a tail supervisor may save defaults from N02' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=NEW.operation_event_id
      AND event.actor_id=NEW.changed_by
      AND event.actor_roles=expected_roles
      AND event.authorization_capability=audit_capability
      AND event.action='master_data.process_default_workers.replace'
      AND event.entity_type='process_default_worker_roster'
      AND event.entity_id=NEW.process_id::text
      AND (event.after_state->>'rosterVersion')::integer=NEW.roster_version
      AND event.after_state->'personIds'=to_jsonb(NEW.person_ids)
      AND event.reason=NEW.change_reason
  ) THEN
    RAISE EXCEPTION 'default worker roster requires matching audit event' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
