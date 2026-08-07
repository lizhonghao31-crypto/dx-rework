CREATE TABLE employee_directory_profiles (
  user_id uuid PRIMARY KEY REFERENCES app_users(id),
  department_names text[] NOT NULL DEFAULT '{}'::text[],
  last_directory_synced_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (array_position(department_names, NULL) IS NULL)
);

CREATE TABLE owner_bootstrap_consumptions (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  user_id uuid NOT NULL REFERENCES app_users(id),
  provider_user_id text NOT NULL CHECK (length(btrim(provider_user_id)) BETWEEN 1 AND 200),
  corp_id text NOT NULL CHECK (length(btrim(corp_id)) BETWEEN 1 AND 200),
  consumed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER owner_bootstrap_consumptions_no_update
  BEFORE UPDATE ON owner_bootstrap_consumptions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER owner_bootstrap_consumptions_no_delete
  BEFORE DELETE ON owner_bootstrap_consumptions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER owner_bootstrap_consumptions_no_truncate
  BEFORE TRUNCATE ON owner_bootstrap_consumptions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_last_usable_owner_disable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  usable_owner_count bigint;
  target_is_usable_owner boolean;
BEGIN
  IF OLD.enabled IS DISTINCT FROM true OR NEW.enabled IS DISTINCT FROM false THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'));
  SELECT
    count(*)::bigint,
    bool_or(ura.user_id=OLD.id)
  INTO usable_owner_count,target_is_usable_owner
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

  IF target_is_usable_owner IS TRUE AND usable_owner_count <= 1 THEN
    RAISE EXCEPTION 'cannot disable the last usable owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER app_users_last_usable_owner_disable
  BEFORE UPDATE OF enabled ON app_users
  FOR EACH ROW EXECUTE FUNCTION guard_last_usable_owner_disable();

CREATE OR REPLACE FUNCTION guard_user_role_assignment_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.role_assign_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.role_assign_request_id', true), '');
  bootstrap_enabled text := nullif(current_setting('dx_rework.owner_bootstrap_enabled', true), '');
  bootstrap_event_id text := nullif(current_setting('dx_rework.owner_bootstrap_event_id', true), '');
  bootstrap_request_id text := nullif(current_setting('dx_rework.owner_bootstrap_request_id', true), '');
  audit_actor_roles text[];
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

  -- Preserve the existing pre-policy controlled initialization behavior.
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

  audit_actor_roles := access_authorized_actor_roles(NEW.granted_by, 'access:admin');
  IF NEW.role_code='owner_group' AND NOT (audit_actor_roles @> ARRAY['owner_group']) THEN
    RAISE EXCEPTION 'owner group can only be maintained by an active owner'
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

CREATE OR REPLACE FUNCTION bootstrap_first_owner(
  p_assignment_id uuid,
  p_user_id uuid,
  p_provider_user_id text,
  p_corp_id text,
  p_event_id uuid,
  p_request_id text,
  p_reason text
) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  IF p_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'invalid owner bootstrap audit context'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'));

  IF EXISTS (
    SELECT 1 FROM user_role_assignments WHERE role_code='owner_group'
  ) OR EXISTS (
    SELECT 1 FROM owner_bootstrap_consumptions WHERE singleton=true
  ) THEN
    RAISE EXCEPTION 'owner bootstrap has already been consumed'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app_users u
    JOIN identity_mappings i
      ON i.user_id=u.id
     AND i.provider='dingtalk'
    JOIN access_security_policy policy
      ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
    WHERE u.id=p_user_id
      AND u.enabled=true
      AND i.provider_user_id=p_provider_user_id
      AND i.corp_id=p_corp_id
      AND i.active=true
      AND i.employed=true
  ) THEN
    RAISE EXCEPTION 'owner bootstrap target must be an active employee in the configured corporation'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id)
  VALUES(true,p_user_id,p_provider_user_id,p_corp_id);

  PERFORM set_config('dx_rework.owner_bootstrap_enabled','true',true);
  PERFORM set_config('dx_rework.owner_bootstrap_event_id',p_event_id::text,true);
  PERFORM set_config('dx_rework.owner_bootstrap_request_id',p_request_id,true);

  INSERT INTO user_role_assignments(
    assignment_id,user_id,role_code,granted_by,grant_reason
  ) VALUES (
    p_assignment_id,p_user_id,'owner_group',p_user_id,p_reason
  );

  RETURN p_assignment_id;
END;
$$;
