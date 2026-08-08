-- Permission authority closure after single-user pilot UAT.
-- Keeps one immutable Root authority, makes owner_group the explicit all-business
-- reader, removes historical business access from system_admin, and lets Root
-- act through existing business guards without weakening ordinary-role rules.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
DROP TRIGGER role_capabilities_no_delete ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('business:read_all','查看全部业务事实','老板权限组查看全部返工、工序、上数、责任、扣款、工资与报表事实')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('owner_group','business:read_all'),
  ('owner_group','audit:read')
ON CONFLICT DO NOTHING;

-- system_admin is a technical administrator, not a business superuser.
DELETE FROM role_capabilities
WHERE role_code='system_admin'
  AND capability IN (
    'dashboard:management:read',
    'master_data:manage',
    'people:read',
    'process_catalog:read',
    'supplier_catalog:read',
    'delegation:manage',
    'wage:view'
  );

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_delete
  BEFORE DELETE ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

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
    RETURN array_append(COALESCE(actor_roles,'{}'::text[]),'root_superuser');
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

-- Root can execute a controlled business action under an explicit acting role.
-- Ordinary users still require the real direct role and capability.
CREATE OR REPLACE FUNCTION responsibility_actor_has_direct_role(
  candidate uuid,
  required_capability text,
  allowed_roles text[]
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
  OR (
    responsibility_actor_is_active(candidate)
    AND EXISTS (
      SELECT 1
      FROM user_role_assignments assignment
      JOIN business_roles role
        ON role.role_code=assignment.role_code AND role.enabled=true
      JOIN role_capabilities capability
        ON capability.role_code=assignment.role_code
       AND capability.capability=required_capability
      WHERE assignment.user_id=candidate
        AND assignment.role_code=ANY(allowed_roles)
        AND assignment.revoked_at IS NULL
    )
  )
$$;

CREATE OR REPLACE FUNCTION wage_has_direct_role(
  requested_actor_id uuid,
  required_role text,
  required_capability text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(requested_actor_id)
  OR EXISTS(
    SELECT 1
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code=assignment.role_code AND role.enabled=true
    JOIN role_capabilities capability
      ON capability.role_code=assignment.role_code
    JOIN app_users target_user
      ON target_user.id=assignment.user_id AND target_user.enabled=true
    JOIN identity_mappings identity
      ON identity.user_id=target_user.id
     AND identity.provider='dingtalk'
     AND identity.active=true
     AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    WHERE assignment.user_id=requested_actor_id
      AND assignment.role_code=required_role
      AND assignment.revoked_at IS NULL
      AND capability.capability=required_capability
  )
$$;

CREATE OR REPLACE FUNCTION external_responsibility_direct_role(
  candidate uuid,
  required_capability text,
  allowed_roles text[]
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
    OR responsibility_actor_has_direct_role(
      candidate,required_capability,allowed_roles
    )
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_sign(
  candidate uuid,
  order_id uuid,
  responsibility_type text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
  OR CASE
    WHEN responsibility_type IN ('processing_factory','fabric_supplier') THEN
      EXISTS (
        SELECT 1 FROM rework_orders order_record
        WHERE order_record.rework_order_id=order_id
          AND order_record.merchandiser_user_id=candidate
          AND external_responsibility_direct_role(
            candidate,'external_responsibility:sign',ARRAY['order_merchandiser']
          )
      ) OR external_responsibility_active_delegation(
        candidate,'external_responsibility:sign',order_id,ARRAY['order_merchandiser']
      )
    WHEN responsibility_type IN ('embroidery_factory','washing_factory') THEN
      external_responsibility_direct_role(
        candidate,'external_responsibility:sign',ARRAY['embroidery_washing_merchandiser']
      ) OR external_responsibility_active_delegation(
        candidate,'external_responsibility:sign',order_id,
        ARRAY['embroidery_washing_merchandiser']
      )
    ELSE false
  END
$$;
