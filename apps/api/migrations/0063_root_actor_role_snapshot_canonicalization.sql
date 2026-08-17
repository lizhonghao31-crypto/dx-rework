-- Operation events persist actor roles in canonical lexical order.  The
-- database-side authorization snapshot must use the identical order, or a
-- Root who also has normal business roles fails an otherwise valid controlled
-- write at the audit trigger boundary.

CREATE OR REPLACE FUNCTION access_authorized_actor_roles(
  requested_actor_id uuid,
  required_capability text
) RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE
  actor_roles text[];
  capability_allowed boolean;
BEGIN
  SELECT array_agg(DISTINCT ura.role_code ORDER BY ura.role_code)
  INTO actor_roles
  FROM user_role_assignments ura
  JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
  JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
  WHERE ura.user_id=requested_actor_id AND ura.revoked_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM identity_mappings i
      JOIN access_security_policy policy
        ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
      WHERE i.user_id=ura.user_id AND i.provider='dingtalk'
        AND i.active=true AND i.employed=true
    );

  IF access_is_root_actor(requested_actor_id) THEN
    SELECT array_agg(role_code ORDER BY role_code)
    INTO actor_roles
    FROM unnest(array_append(COALESCE(actor_roles,'{}'::text[]),'root_superuser'))
      AS snapshot(role_code);
    RETURN actor_roles;
  END IF;

  SELECT
    EXISTS (
      SELECT 1
      FROM user_role_assignments ura
      JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
      JOIN role_capabilities rc ON rc.role_code=ura.role_code
      WHERE ura.user_id=requested_actor_id AND ura.revoked_at IS NULL
        AND rc.capability=required_capability
    )
    OR EXISTS (
      SELECT 1
      FROM delegated_authorizations da
      WHERE da.grantee_user_id=requested_actor_id
        AND da.capability=required_capability
        AND da.scope_type='global' AND da.scope_id IS NULL
        AND da.revoked_at IS NULL
        AND da.valid_from <= CURRENT_TIMESTAMP
        AND da.valid_until > CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1
          FROM app_users grantor
          JOIN identity_mappings i ON i.user_id=grantor.id
          JOIN access_security_policy policy
            ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
          WHERE grantor.id=da.grantor_user_id AND grantor.enabled=true
            AND i.provider='dingtalk' AND i.active=true AND i.employed=true
        )
        AND EXISTS (
          SELECT 1
          FROM user_role_assignments grantor_role
          JOIN business_roles grantor_business_role
            ON grantor_business_role.role_code=grantor_role.role_code
            AND grantor_business_role.enabled=true
          JOIN role_capabilities grantor_capability
            ON grantor_capability.role_code=grantor_role.role_code
          WHERE grantor_role.user_id=da.grantor_user_id
            AND grantor_role.revoked_at IS NULL
            AND grantor_capability.capability=da.capability
        )
    )
  INTO capability_allowed;

  IF actor_roles IS NULL OR capability_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'actor is not authorized for capability %', required_capability
      USING ERRCODE = '42501';
  END IF;
  RETURN actor_roles;
END;
$$;
