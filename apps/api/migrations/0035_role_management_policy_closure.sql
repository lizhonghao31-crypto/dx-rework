-- Align runtime role management with the confirmed Root/owner policy.
-- Root identity is the consumed first-owner bootstrap identity at database level.
-- Application RootAuthority still validates the configured DingTalk Root identity.

DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
DROP TRIGGER role_capabilities_no_delete ON role_capabilities;

INSERT INTO role_capabilities(role_code, capability) VALUES
  ('owner_group', 'access:admin')
ON CONFLICT DO NOTHING;

DELETE FROM role_capabilities
WHERE role_code='system_admin' AND capability='access:admin';

CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_delete
  BEFORE DELETE ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION access_is_root_actor(
  requested_actor_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM owner_bootstrap_consumptions root
    JOIN app_users u ON u.id=root.user_id AND u.enabled=true
    JOIN identity_mappings i
      ON i.user_id=root.user_id
     AND i.provider='dingtalk'
     AND i.provider_user_id=root.provider_user_id
     AND i.corp_id=root.corp_id
     AND i.active=true
     AND i.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=root.corp_id
    WHERE root.singleton=true
      AND root.user_id=requested_actor_id
  );
$$;

CREATE OR REPLACE FUNCTION access_role_manager_roles(
  requested_actor_id uuid
) RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE
  actor_roles text[];
  root_actor boolean;
BEGIN
  SELECT array_agg(DISTINCT ura.role_code ORDER BY ura.role_code)
  INTO actor_roles
  FROM user_role_assignments ura
  JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
  JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
  WHERE ura.user_id=requested_actor_id
    AND ura.revoked_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM identity_mappings i
      JOIN access_security_policy policy
        ON policy.policy_key='primary'
       AND policy.dingtalk_corp_id=i.corp_id
      WHERE i.user_id=ura.user_id
        AND i.provider='dingtalk'
        AND i.active=true
        AND i.employed=true
    );

  root_actor := access_is_root_actor(requested_actor_id);

  IF root_actor THEN
    RETURN array_append(COALESCE(actor_roles, '{}'::text[]), 'root_superuser');
  END IF;

  IF actor_roles IS NULL OR NOT (actor_roles @> ARRAY['owner_group']) THEN
    RAISE EXCEPTION 'business roles can only be maintained by an active owner or root'
      USING ERRCODE = '42501';
  END IF;

  RETURN actor_roles;
END;
$$;

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
  IF NEW.user_id=NEW.granted_by THEN
    RAISE EXCEPTION 'users cannot grant a role to themselves'
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

CREATE OR REPLACE FUNCTION guard_user_role_assignment_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.role_revoke_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.role_revoke_request_id', true), '');
  audit_actor_roles text[];
  usable_owner_count bigint;
  target_is_usable boolean;
  root_actor boolean;
BEGIN
  IF OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revoke_reason IS NULL
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role_code IS DISTINCT FROM OLD.role_code
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.grant_reason IS DISTINCT FROM OLD.grant_reason
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
  THEN
    RAISE EXCEPTION 'role assignments are immutable except for one audited revocation'
      USING ERRCODE = '55000';
  END IF;
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'role revocation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;

  audit_actor_roles := access_role_manager_roles(NEW.revoked_by);
  root_actor := access_is_root_actor(NEW.revoked_by);

  IF OLD.role_code IN ('owner_group','system_admin') AND NOT root_actor THEN
    RAISE EXCEPTION 'protected roles can only be maintained by root'
      USING ERRCODE = '42501';
  END IF;
  IF root_actor
     AND OLD.user_id=NEW.revoked_by
     AND OLD.role_code IN ('owner_group','system_admin')
  THEN
    RAISE EXCEPTION 'root cannot revoke its own protected role'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.role_code='owner_group' THEN
    PERFORM pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'));
    SELECT count(*), bool_or(ura.user_id=OLD.user_id)
    INTO usable_owner_count, target_is_usable
    FROM user_role_assignments ura
    JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
    WHERE ura.role_code='owner_group' AND ura.revoked_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM identity_mappings i
        JOIN access_security_policy policy
          ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
        WHERE i.user_id=ura.user_id AND i.provider='dingtalk'
          AND i.active=true AND i.employed=true
      );
    IF target_is_usable IS TRUE AND usable_owner_count <= 1 THEN
      RAISE EXCEPTION 'cannot revoke the last usable owner'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.revoked_by,audit_actor_roles,'access:admin',
    'access.role.revoke','user_role_assignment',OLD.assignment_id::text,
    jsonb_build_object('userId',OLD.user_id,'roleCode',OLD.role_code),
    jsonb_build_object(
      'userId',NEW.user_id,
      'roleCode',NEW.role_code,
      'revokedAt',NEW.revoked_at,
      'revokedBy',NEW.revoked_by,
      'revokeReason',NEW.revoke_reason
    ),
    NEW.revoke_reason
  );
  RETURN NEW;
END;
$$;
