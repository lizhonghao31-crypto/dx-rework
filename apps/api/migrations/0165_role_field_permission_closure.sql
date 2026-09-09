-- PR-03 permission closure: make personnel/role administration Root-only and retire obsolete human roles.
-- Historical assignments and audit facts are preserved; disabled roles cannot be used for new active business access.

ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;

DELETE FROM role_capabilities
WHERE capability='access:admin';

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;

ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_update;

UPDATE business_roles
SET enabled=false,
    updated_at=CURRENT_TIMESTAMP
WHERE role_code IN ('administrative_clerk','sample_approver','tail_inspector')
  AND enabled=true;

ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_update;

CREATE OR REPLACE FUNCTION access_role_manager_roles(
  requested_actor_id uuid
) RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE
  actor_roles text[];
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

  IF access_is_root_actor(requested_actor_id) THEN
    RETURN array_append(COALESCE(actor_roles, '{}'::text[]), 'root_superuser');
  END IF;

  RAISE EXCEPTION 'business roles can only be maintained by root'
    USING ERRCODE = '42501';
END;
$$;
