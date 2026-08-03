-- PR-09 S2: allow only the direct holder to grant order-scoped responsibility determination.
CREATE OR REPLACE FUNCTION guard_delegated_authorization_creation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.delegation_create_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.delegation_create_request_id', true), '');
  audit_actor_roles text[];
  audit_capability text := 'delegation:manage';
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'delegation creation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.grantee_user_id = NEW.granted_by THEN
    RAISE EXCEPTION 'operators cannot delegate a capability to themselves'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.capability = 'responsibility:determine' THEN
    IF NEW.scope_type <> 'rework_order' OR NEW.scope_id IS NULL
       OR NEW.granted_by IS DISTINCT FROM NEW.grantor_user_id THEN
      RAISE EXCEPTION 'responsibility determination must be delegated directly by its holder for one rework order'
        USING ERRCODE = '42501';
    END IF;
    SELECT array_agg(DISTINCT assignment.role_code ORDER BY assignment.role_code)
    INTO audit_actor_roles
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code = assignment.role_code AND role.enabled = true
    JOIN role_capabilities role_capability
      ON role_capability.role_code = assignment.role_code
     AND role_capability.capability = 'responsibility:determine'
    WHERE assignment.user_id = NEW.granted_by
      AND assignment.revoked_at IS NULL
      AND assignment.role_code IN ('production_management', 'owner_group');
    IF audit_actor_roles IS NULL
       OR NOT responsibility_actor_is_active(NEW.granted_by) THEN
      RAISE EXCEPTION 'responsibility delegation grantor must be a direct active holder'
        USING ERRCODE = '42501';
    END IF;
    audit_capability := 'responsibility:determine';
  ELSE
    audit_actor_roles := access_authorized_actor_roles(NEW.granted_by, 'delegation:manage');
  END IF;

  IF NEW.capability = 'own_factory:approve'
     AND (
       NEW.granted_by IS DISTINCT FROM NEW.grantor_user_id
       OR NOT (audit_actor_roles @> ARRAY['owner_group'])
     ) THEN
    RAISE EXCEPTION 'own-factory approval must be delegated directly by the operating owner'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app_users user_account
    JOIN identity_mappings identity ON identity.user_id = user_account.id
    JOIN access_security_policy policy
      ON policy.policy_key = 'primary'
     AND policy.dingtalk_corp_id = identity.corp_id
    WHERE user_account.id = NEW.grantor_user_id
      AND user_account.enabled = true
      AND identity.provider = 'dingtalk'
      AND identity.active = true
      AND identity.employed = true
  ) OR NOT EXISTS (
    SELECT 1
    FROM app_users user_account
    JOIN identity_mappings identity ON identity.user_id = user_account.id
    JOIN access_security_policy policy
      ON policy.policy_key = 'primary'
     AND policy.dingtalk_corp_id = identity.corp_id
    WHERE user_account.id = NEW.grantee_user_id
      AND user_account.enabled = true
      AND identity.provider = 'dingtalk'
      AND identity.active = true
      AND identity.employed = true
  ) THEN
    RAISE EXCEPTION 'delegation parties must be active employees in the configured corporation'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code = assignment.role_code AND role.enabled = true
    JOIN role_capabilities role_capability
      ON role_capability.role_code = assignment.role_code
    WHERE assignment.user_id = NEW.grantor_user_id
      AND assignment.revoked_at IS NULL
      AND role_capability.capability = NEW.capability
  ) THEN
    RAISE EXCEPTION 'delegation grantor does not hold the delegated capability'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.capability = 'own_factory:approve' AND NOT EXISTS (
    SELECT 1
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code = assignment.role_code AND role.enabled = true
    WHERE assignment.user_id = NEW.grantor_user_id
      AND assignment.role_code = 'owner_group'
      AND assignment.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'own-factory approval can only be delegated by an active owner'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.granted_by,audit_actor_roles,audit_capability,
    'access.delegation.create','delegated_authorization',NEW.delegation_id::text,
    jsonb_build_object(
      'grantorUserId',NEW.grantor_user_id,
      'granteeUserId',NEW.grantee_user_id,
      'capability',NEW.capability,
      'scopeType',NEW.scope_type,
      'scopeId',NEW.scope_id,
      'validFrom',NEW.valid_from,
      'validUntil',NEW.valid_until
    ),
    NEW.grant_reason
  );
  RETURN NEW;
END;
$$;
