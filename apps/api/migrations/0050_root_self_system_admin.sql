-- Permit only the immutable Root identity to self-assign the technical system_admin role.
-- Every other self-assignment remains forbidden; protected-role and organization guards stay intact.

CREATE OR REPLACE FUNCTION guard_user_role_assignment_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.role_assign_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.role_assign_request_id', true), '');
  bootstrap_enabled text := nullif(current_setting('dx_rework.owner_bootstrap_enabled', true), '');
  bootstrap_event_id text := nullif(current_setting('dx_rework.owner_bootstrap_event_id', true), '');
  bootstrap_request_id text := nullif(current_setting('dx_rework.owner_bootstrap_request_id', true), '');
  audit_actor_roles text[];
  root_actor boolean;
BEGIN
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'new role assignments cannot start revoked'
      USING ERRCODE = '23514';
  END IF;

  IF bootstrap_enabled='true'
     AND NEW.role_code='owner_group'
     AND NEW.user_id=NEW.granted_by
  THEN
    IF bootstrap_event_id IS NULL OR bootstrap_request_id IS NULL
       OR bootstrap_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
    THEN
      RAISE EXCEPTION 'owner bootstrap requires trusted audit context'
        USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'));
    IF EXISTS (
      SELECT 1
      FROM user_role_assignments
      WHERE role_code='owner_group'
    ) THEN
      RAISE EXCEPTION 'owner bootstrap is permanently closed after owner history exists'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM owner_bootstrap_consumptions c
      JOIN identity_mappings i
        ON i.user_id=c.user_id
       AND i.provider='dingtalk'
       AND i.provider_user_id=c.provider_user_id
       AND i.corp_id=c.corp_id
      JOIN app_users u ON u.id=c.user_id
      JOIN access_security_policy policy
        ON policy.policy_key='primary' AND policy.dingtalk_corp_id=c.corp_id
      WHERE c.singleton=true
        AND c.user_id=NEW.user_id
        AND u.enabled=true
        AND i.active=true
        AND i.employed=true
    ) THEN
      RAISE EXCEPTION 'owner bootstrap identity is not eligible'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM business_roles WHERE role_code='owner_group' AND enabled=true
    ) THEN
      RAISE EXCEPTION 'owner group is unavailable'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO operation_events(
      event_id,request_id,actor_id,actor_roles,authorization_capability,
      action,entity_type,entity_id,after_state,reason
    ) VALUES (
      bootstrap_event_id::uuid,bootstrap_request_id,NEW.user_id,ARRAY['bootstrap_candidate'],'access:bootstrap',
      'access.owner.bootstrap','user_role_assignment',NEW.assignment_id::text,
      jsonb_build_object('userId',NEW.user_id,'roleCode',NEW.role_code),
      NEW.grant_reason
    );
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM access_security_policy WHERE policy_key='primary') THEN
    RETURN NEW;
  END IF;
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'role assignment requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.user_id=NEW.granted_by
     AND NOT (
       NEW.role_code='system_admin'
       AND access_is_root_actor(NEW.granted_by)
     )
  THEN
    RAISE EXCEPTION 'users cannot grant a role to themselves except root assigning system_admin'
      USING ERRCODE = '42501';
  END IF;

  audit_actor_roles := access_role_manager_roles(NEW.granted_by);
  root_actor := access_is_root_actor(NEW.granted_by);

  IF NEW.role_code IN ('owner_group','system_admin') AND NOT root_actor THEN
    RAISE EXCEPTION 'protected roles can only be maintained by root'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.role_code='owner_group' THEN
    PERFORM pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_users u
    JOIN identity_mappings i ON i.user_id=u.id
    JOIN access_security_policy policy
      ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
    WHERE u.id=NEW.user_id AND u.enabled=true
      AND i.provider='dingtalk' AND i.active=true AND i.employed=true
  ) THEN
    RAISE EXCEPTION 'role target must be an active employee in the configured corporation'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM business_roles WHERE role_code=NEW.role_code AND enabled=true
  ) THEN
    RAISE EXCEPTION 'role is unavailable'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.granted_by,audit_actor_roles,'access:admin',
    'access.role.assign','user_role_assignment',NEW.assignment_id::text,
    jsonb_build_object('userId',NEW.user_id,'roleCode',NEW.role_code),
    NEW.grant_reason
  );
  RETURN NEW;
END;
$$;

