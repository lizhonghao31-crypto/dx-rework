-- Default-deny employee access and bind account lifecycle to effective authorization.

ALTER TABLE app_users
  ADD COLUMN manual_access_disabled boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION access_user_has_effective_authorization(
  requested_user_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM user_role_assignments assignment
      JOIN business_roles role
        ON role.role_code=assignment.role_code
       AND role.enabled=true
      WHERE assignment.user_id=requested_user_id
        AND assignment.revoked_at IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM delegated_authorizations delegation
      WHERE delegation.grantee_user_id=requested_user_id
        AND delegation.revoked_at IS NULL
        AND delegation.valid_from <= CURRENT_TIMESTAMP
        AND delegation.valid_until > CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1
          FROM app_users grantor
          JOIN identity_mappings identity
            ON identity.user_id=grantor.id
           AND identity.provider='dingtalk'
          JOIN access_security_policy policy
            ON policy.policy_key='primary'
           AND policy.dingtalk_corp_id=identity.corp_id
          WHERE grantor.id=delegation.grantor_user_id
            AND grantor.enabled=true
            AND identity.active=true
            AND identity.employed=true
        )
        AND EXISTS (
          SELECT 1
          FROM user_role_assignments grantor_assignment
          JOIN business_roles grantor_role
            ON grantor_role.role_code=grantor_assignment.role_code
           AND grantor_role.enabled=true
          JOIN role_capabilities grantor_capability
            ON grantor_capability.role_code=grantor_assignment.role_code
          WHERE grantor_assignment.user_id=delegation.grantor_user_id
            AND grantor_assignment.revoked_at IS NULL
            AND grantor_capability.capability=delegation.capability
        )
    );
$$;

CREATE OR REPLACE FUNCTION guard_last_usable_owner_disable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  usable_owner_count bigint;
  target_is_usable_owner boolean;
BEGIN
  IF OLD.enabled IS DISTINCT FROM true OR NEW.enabled IS DISTINCT FROM false THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM owner_bootstrap_consumptions root
    WHERE root.singleton=true AND root.user_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'root access cannot be disabled'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'));
  SELECT
    count(*)::bigint,
    bool_or(assignment.user_id=OLD.id)
  INTO usable_owner_count,target_is_usable_owner
  FROM user_role_assignments assignment
  JOIN app_users app_user
    ON app_user.id=assignment.user_id
   AND app_user.enabled=true
  WHERE assignment.role_code='owner_group'
    AND assignment.revoked_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM identity_mappings identity
      JOIN access_security_policy policy
        ON policy.policy_key='primary'
       AND policy.dingtalk_corp_id=identity.corp_id
      WHERE identity.user_id=assignment.user_id
        AND identity.provider='dingtalk'
        AND identity.active=true
        AND identity.employed=true
    );

  IF target_is_usable_owner IS TRUE AND usable_owner_count <= 1 THEN
    RAISE EXCEPTION 'cannot disable the last usable owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE app_users ALTER COLUMN enabled SET DEFAULT false;

UPDATE app_users app_user
SET manual_access_disabled=true,updated_at=CURRENT_TIMESTAMP
WHERE app_user.enabled=false
  AND access_user_has_effective_authorization(app_user.id)
  AND NOT EXISTS (
    SELECT 1
    FROM owner_bootstrap_consumptions root
    WHERE root.singleton=true AND root.user_id=app_user.id
  );

UPDATE app_users app_user
SET enabled=true,manual_access_disabled=false,updated_at=CURRENT_TIMESTAMP
WHERE app_user.enabled=false
  AND EXISTS (
    SELECT 1
    FROM owner_bootstrap_consumptions root
    WHERE root.singleton=true AND root.user_id=app_user.id
  );

WITH disabled AS (
  UPDATE app_users app_user
  SET enabled=false,updated_at=CURRENT_TIMESTAMP
  WHERE app_user.enabled=true
    AND NOT EXISTS (
      SELECT 1
      FROM owner_bootstrap_consumptions root
      WHERE root.singleton=true AND root.user_id=app_user.id
    )
    AND NOT access_user_has_effective_authorization(app_user.id)
  RETURNING app_user.id
)
UPDATE auth_sessions session
SET revoked_at=CURRENT_TIMESTAMP
WHERE session.revoked_at IS NULL
  AND session.user_id IN (SELECT id FROM disabled);
