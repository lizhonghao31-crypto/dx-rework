CREATE TABLE access_security_policy (
  policy_key text PRIMARY KEY CHECK (policy_key = 'primary'),
  dingtalk_corp_id text NOT NULL UNIQUE CHECK (length(btrim(dingtalk_corp_id)) BETWEEN 1 AND 200),
  configured_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER access_security_policy_no_update BEFORE UPDATE ON access_security_policy FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER access_security_policy_no_delete BEFORE DELETE ON access_security_policy FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER access_security_policy_no_truncate BEFORE TRUNCATE ON access_security_policy FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION lock_owner_eligibility_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='identity_mappings' THEN
    IF (OLD.active,OLD.employed) IS DISTINCT FROM (NEW.active,NEW.employed) THEN
      PERFORM pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'));
    END IF;
  ELSIF TG_TABLE_NAME='app_users' THEN
    IF OLD.enabled IS DISTINCT FROM NEW.enabled THEN
      PERFORM pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_mappings_owner_guard BEFORE UPDATE ON identity_mappings FOR EACH ROW EXECUTE FUNCTION lock_owner_eligibility_change();
CREATE TRIGGER app_users_owner_guard BEFORE UPDATE ON app_users FOR EACH ROW EXECUTE FUNCTION lock_owner_eligibility_change();
CREATE TRIGGER identity_mappings_no_delete BEFORE DELETE ON identity_mappings FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER identity_mappings_no_truncate BEFORE TRUNCATE ON identity_mappings FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE capability_catalog (
  capability text PRIMARY KEY CHECK (capability ~ '^[a-z][a-z0-9:_-]{2,127}$'),
  display_name text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE business_roles (
  role_code text PRIMARY KEY CHECK (role_code ~ '^[a-z][a-z0-9:_-]{2,63}$'),
  display_name text NOT NULL,
  description text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  system_role boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE role_capabilities (
  role_code text NOT NULL REFERENCES business_roles(role_code),
  capability text NOT NULL REFERENCES capability_catalog(capability),
  granted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_code, capability)
);

CREATE TABLE user_role_assignments (
  assignment_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  role_code text NOT NULL REFERENCES business_roles(role_code),
  granted_by uuid NOT NULL REFERENCES app_users(id),
  grant_reason text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 500),
  granted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES app_users(id),
  revoke_reason text,
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX user_role_assignments_active_idx
  ON user_role_assignments (user_id, role_code)
  WHERE revoked_at IS NULL;
CREATE INDEX user_role_assignments_user_history_idx
  ON user_role_assignments (user_id, granted_at DESC);

COMMENT ON TABLE user_capabilities IS
  'Legacy pre-role grants retained only for migration traceability; authorization ignores this table from schema 0005 onward.';

CREATE OR REPLACE FUNCTION access_authorized_actor_roles(
  requested_actor_id uuid,
  required_capability text
) RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE
  actor_roles text[];
  capability_allowed boolean;
BEGIN
  SELECT array_agg(DISTINCT ura.role_code ORDER BY ura.role_code),
         bool_or(rc.capability = required_capability)
  INTO actor_roles, capability_allowed
  FROM user_role_assignments ura
  JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
  JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
  LEFT JOIN role_capabilities rc ON rc.role_code=ura.role_code
  WHERE ura.user_id=requested_actor_id AND ura.revoked_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM identity_mappings i
      JOIN access_security_policy policy
        ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
      WHERE i.user_id=ura.user_id AND i.provider='dingtalk'
        AND i.active=true AND i.employed=true
    );
  IF actor_roles IS NULL OR capability_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'actor is not authorized for capability %', required_capability
      USING ERRCODE = '42501';
  END IF;
  RETURN actor_roles;
END;
$$;

CREATE OR REPLACE FUNCTION guard_user_role_assignment_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.role_revoke_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.role_revoke_request_id', true), '');
  audit_actor_roles text[];
  usable_owner_count bigint;
  target_is_usable boolean;
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

  audit_actor_roles := access_authorized_actor_roles(NEW.revoked_by, 'access:admin');
  IF OLD.role_code='owner_group' THEN
    IF NOT (audit_actor_roles @> ARRAY['owner_group']) THEN
      RAISE EXCEPTION 'owner group can only be maintained by an active owner'
        USING ERRCODE = '42501';
    END IF;
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
CREATE OR REPLACE FUNCTION guard_user_role_assignment_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.role_assign_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.role_assign_request_id', true), '');
  audit_actor_roles text[];
BEGIN
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'new role assignments cannot start revoked'
      USING ERRCODE = '23514';
  END IF;

  -- The immutable corporation policy is intentionally configured only after a
  -- database administrator has inserted the first controlled admin/owner rows.
  -- Every assignment after first application start is authorized and audited.
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
CREATE TRIGGER user_role_assignments_guard_creation BEFORE INSERT ON user_role_assignments FOR EACH ROW EXECUTE FUNCTION guard_user_role_assignment_creation();
CREATE TRIGGER user_role_assignments_revoke_only BEFORE UPDATE ON user_role_assignments FOR EACH ROW EXECUTE FUNCTION guard_user_role_assignment_revocation();
CREATE TRIGGER user_role_assignments_no_delete BEFORE DELETE ON user_role_assignments FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER user_role_assignments_no_truncate BEFORE TRUNCATE ON user_role_assignments FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE business_people (
  person_id uuid PRIMARY KEY,
  person_type text NOT NULL CHECK (person_type IN ('internal', 'temporary')),
  app_user_id uuid UNIQUE REFERENCES app_users(id),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_at timestamptz,
  CHECK ((person_type = 'internal') = (app_user_id IS NOT NULL)),
  CHECK ((active = true) = (deactivated_at IS NULL))
);
CREATE INDEX business_people_type_active_idx ON business_people (person_type, active, display_name);

CREATE TABLE business_person_aliases (
  alias_id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  alias text NOT NULL CHECK (length(btrim(alias)) BETWEEN 1 AND 100),
  normalized_alias text NOT NULL CHECK (length(btrim(normalized_alias)) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES app_users(id),
  revoke_reason text,
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX business_person_aliases_active_alias_idx
  ON business_person_aliases (normalized_alias)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX business_person_aliases_person_active_idx
  ON business_person_aliases (person_id, normalized_alias)
  WHERE revoked_at IS NULL;
CREATE OR REPLACE FUNCTION allow_business_person_alias_revocation_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.alias_revoke_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.alias_revoke_request_id', true), '');
  audit_actor_roles text[];
BEGIN
  IF OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revoke_reason IS NULL
     OR NEW.alias_id IS DISTINCT FROM OLD.alias_id
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.alias IS DISTINCT FROM OLD.alias
     OR NEW.normalized_alias IS DISTINCT FROM OLD.normalized_alias
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'business person aliases are immutable except for one audited revocation'
      USING ERRCODE = '55000';
  END IF;

  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'business person alias revocation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  audit_actor_roles := access_authorized_actor_roles(NEW.revoked_by, 'master_data:manage');

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.revoked_by,audit_actor_roles,'master_data:manage',
    'master_data.person_alias.revoke','business_person_alias',OLD.alias_id::text,
    jsonb_build_object(
      'personId',OLD.person_id,
      'alias',OLD.alias,
      'normalizedAlias',OLD.normalized_alias
    ),
    jsonb_build_object(
      'personId',NEW.person_id,
      'alias',NEW.alias,
      'normalizedAlias',NEW.normalized_alias,
      'revokedAt',NEW.revoked_at,
      'revokedBy',NEW.revoked_by,
      'revokeReason',NEW.revoke_reason
    ),
    NEW.revoke_reason
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER business_person_aliases_revoke_only BEFORE UPDATE ON business_person_aliases FOR EACH ROW EXECUTE FUNCTION allow_business_person_alias_revocation_only();
CREATE TRIGGER business_person_aliases_no_delete BEFORE DELETE ON business_person_aliases FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER business_person_aliases_no_truncate BEFORE TRUNCATE ON business_person_aliases FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE process_catalog_items (
  process_id uuid PRIMARY KEY,
  process_code text NOT NULL UNIQUE CHECK (process_code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE process_catalog_versions (
  process_id uuid NOT NULL REFERENCES process_catalog_items(process_id),
  version integer NOT NULL CHECK (version > 0),
  process_name text NOT NULL CHECK (length(btrim(process_name)) BETWEEN 1 AND 100),
  pricing_unit text NOT NULL CHECK (pricing_unit IN ('piece', 'hour')),
  active boolean NOT NULL,
  change_reason text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 1 AND 500),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (process_id, version)
);
CREATE TRIGGER process_catalog_versions_no_update BEFORE UPDATE ON process_catalog_versions FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER process_catalog_versions_no_delete BEFORE DELETE ON process_catalog_versions FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER process_catalog_versions_no_truncate BEFORE TRUNCATE ON process_catalog_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE VIEW current_process_catalog AS
  SELECT DISTINCT ON (i.process_id)
    i.process_id, i.process_code, v.version, v.process_name, v.pricing_unit, v.active, v.created_at
  FROM process_catalog_items i
  JOIN process_catalog_versions v ON v.process_id = i.process_id
  ORDER BY i.process_id, v.version DESC;

CREATE TABLE supplier_catalog_items (
  supplier_id uuid PRIMARY KEY,
  supplier_code text NOT NULL UNIQUE CHECK (supplier_code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  supplier_type text NOT NULL CHECK (supplier_type IN ('factory', 'embroidery_washing', 'fabric', 'other')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE supplier_catalog_versions (
  supplier_id uuid NOT NULL REFERENCES supplier_catalog_items(supplier_id),
  version integer NOT NULL CHECK (version > 0),
  supplier_name text NOT NULL CHECK (length(btrim(supplier_name)) BETWEEN 1 AND 200),
  active boolean NOT NULL,
  change_reason text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 1 AND 500),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (supplier_id, version)
);
CREATE TRIGGER supplier_catalog_versions_no_update BEFORE UPDATE ON supplier_catalog_versions FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER supplier_catalog_versions_no_delete BEFORE DELETE ON supplier_catalog_versions FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER supplier_catalog_versions_no_truncate BEFORE TRUNCATE ON supplier_catalog_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE VIEW current_supplier_catalog AS
  SELECT DISTINCT ON (i.supplier_id)
    i.supplier_id, i.supplier_code, i.supplier_type, v.version, v.supplier_name, v.active, v.created_at
  FROM supplier_catalog_items i
  JOIN supplier_catalog_versions v ON v.supplier_id = i.supplier_id
  ORDER BY i.supplier_id, v.version DESC;

CREATE TABLE delegated_authorizations (
  delegation_id uuid PRIMARY KEY,
  grantor_user_id uuid NOT NULL REFERENCES app_users(id),
  grantee_user_id uuid NOT NULL REFERENCES app_users(id),
  capability text NOT NULL REFERENCES capability_catalog(capability),
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'rework_order', 'process', 'supplier')),
  scope_id text,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  granted_by uuid NOT NULL REFERENCES app_users(id),
  grant_reason text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES app_users(id),
  revoke_reason text,
  CHECK (grantor_user_id <> grantee_user_id),
  CHECK (valid_until > valid_from),
  CHECK ((scope_type = 'global') = (scope_id IS NULL)),
  CHECK (capability <> 'own_factory:approve' OR (scope_type = 'rework_order' AND scope_id IS NOT NULL)),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 1 AND 500)
);
CREATE INDEX delegated_authorizations_grantee_active_idx
  ON delegated_authorizations (grantee_user_id, capability, valid_from, valid_until)
  WHERE revoked_at IS NULL;
CREATE INDEX delegated_authorizations_grantor_history_idx
  ON delegated_authorizations (grantor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_delegated_authorization_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.delegation_create_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.delegation_create_request_id', true), '');
  audit_actor_roles text[];
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'delegation creation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.grantee_user_id=NEW.granted_by THEN
    RAISE EXCEPTION 'operators cannot delegate a capability to themselves'
      USING ERRCODE = '42501';
  END IF;

  audit_actor_roles := access_authorized_actor_roles(NEW.granted_by, 'delegation:manage');
  IF NOT EXISTS (
    SELECT 1
    FROM app_users u
    JOIN identity_mappings i ON i.user_id=u.id
    JOIN access_security_policy policy
      ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
    WHERE u.id=NEW.grantor_user_id AND u.enabled=true
      AND i.provider='dingtalk' AND i.active=true AND i.employed=true
  ) OR NOT EXISTS (
    SELECT 1
    FROM app_users u
    JOIN identity_mappings i ON i.user_id=u.id
    JOIN access_security_policy policy
      ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
    WHERE u.id=NEW.grantee_user_id AND u.enabled=true
      AND i.provider='dingtalk' AND i.active=true AND i.employed=true
  ) THEN
    RAISE EXCEPTION 'delegation parties must be active employees in the configured corporation'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM user_role_assignments ura
    JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
    JOIN role_capabilities rc ON rc.role_code=ura.role_code
    WHERE ura.user_id=NEW.grantor_user_id AND ura.revoked_at IS NULL
      AND rc.capability=NEW.capability
  ) THEN
    RAISE EXCEPTION 'delegation grantor does not hold the delegated capability'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.capability='own_factory:approve' AND NOT EXISTS (
    SELECT 1
    FROM user_role_assignments ura
    JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
    WHERE ura.user_id=NEW.grantor_user_id AND ura.role_code='owner_group'
      AND ura.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'own-factory approval can only be delegated by an active owner'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.granted_by,audit_actor_roles,'delegation:manage',
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

CREATE OR REPLACE FUNCTION guard_delegated_authorization_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.delegation_revoke_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.delegation_revoke_request_id', true), '');
  audit_actor_roles text[];
BEGIN
  IF OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revoke_reason IS NULL
     OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
     OR NEW.grantor_user_id IS DISTINCT FROM OLD.grantor_user_id
     OR NEW.grantee_user_id IS DISTINCT FROM OLD.grantee_user_id
     OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.grant_reason IS DISTINCT FROM OLD.grant_reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'delegations are immutable except for one audited revocation'
      USING ERRCODE = '55000';
  END IF;
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'delegation revocation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;

  audit_actor_roles := access_authorized_actor_roles(NEW.revoked_by, 'delegation:manage');
  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.revoked_by,audit_actor_roles,'delegation:manage',
    'access.delegation.revoke','delegated_authorization',OLD.delegation_id::text,
    jsonb_build_object(
      'grantorUserId',OLD.grantor_user_id,
      'granteeUserId',OLD.grantee_user_id,
      'capability',OLD.capability,
      'scopeType',OLD.scope_type,
      'scopeId',OLD.scope_id,
      'validFrom',OLD.valid_from,
      'validUntil',OLD.valid_until
    ),
    jsonb_build_object(
      'grantorUserId',NEW.grantor_user_id,
      'granteeUserId',NEW.grantee_user_id,
      'capability',NEW.capability,
      'scopeType',NEW.scope_type,
      'scopeId',NEW.scope_id,
      'validFrom',NEW.valid_from,
      'validUntil',NEW.valid_until,
      'revokedAt',NEW.revoked_at,
      'revokedBy',NEW.revoked_by,
      'revokeReason',NEW.revoke_reason
    ),
    NEW.revoke_reason
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER delegated_authorizations_guard_creation BEFORE INSERT ON delegated_authorizations FOR EACH ROW EXECUTE FUNCTION guard_delegated_authorization_creation();
CREATE TRIGGER delegated_authorizations_revoke_only BEFORE UPDATE ON delegated_authorizations FOR EACH ROW EXECUTE FUNCTION guard_delegated_authorization_revocation();
CREATE TRIGGER delegated_authorizations_no_delete BEFORE DELETE ON delegated_authorizations FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER delegated_authorizations_no_truncate BEFORE TRUNCATE ON delegated_authorizations FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

INSERT INTO capability_catalog(capability, display_name, description) VALUES
  ('tools:user', '公共工具', '使用附件、导出等公共工具'),
  ('dashboard:management:read', '管理座舱', '查看完整管理事实与下钻数据'),
  ('dashboard:site:read', '现场工作台', '查看尾部现场管理信息'),
  ('rework:initiate', '发起返工', '创建和维护待提交返工单'),
  ('process:configure', '配置工序', '配置返工工序、数量、单位与价格'),
  ('process:review', '审核工序', '审核工序与价格'),
  ('task:assign', '分配任务', '分配个人或集体计件任务'),
  ('submission:self', '本人上数', '提交本人计件记录'),
  ('submission:proxy', '代录上数', '为临时工或授权人员代录'),
  ('submission:audit', '整单审核', '审核返工单全部上数'),
  ('quantity:adjust', '数量调整', '按规则调整计划数量'),
  ('liability:decide', '责任判定', '判定责任、倍率与比例'),
  ('liability:takeover', '责任接管', '介入或接管责任处理'),
  ('own_factory:approve', '本厂承担审批', '完成本厂承担最终审批'),
  ('external_liability:sign', '外责签收', '签收外部责任并选择供应商'),
  ('deduction:manage', '扣款跟进', '维护拟扣、实扣与差额'),
  ('payroll:review', '工资核对', '核对工资与调整记录'),
  ('payroll:close', '工资月结', '人工锁定工资月份'),
  ('finance:read', '财务查看', '查看授权财务事实'),
  ('master_data:manage', '基础资料管理', '维护人员、工序和供应商目录'),
  ('people:read', '人员目录查看', '查看内部人员和临时工目录'),
  ('process_catalog:read', '工序目录查看', '查看当前公共工序目录'),
  ('supplier_catalog:read', '供应商目录查看', '查看当前供应商目录'),
  ('access:admin', '角色管理', '管理非受保护业务角色'),
  ('delegation:manage', '授权代理', '配置受控临时授权'),
  ('audit:read', '审计查看', '查看操作和授权审计');

INSERT INTO business_roles(role_code, display_name, description) VALUES
  ('quality_control', '品控', '发起返工并维护提交前资料'),
  ('tail_supervisor', '尾部主管', '配置工序、分工、整单审核和工资初核'),
  ('ie_reviewer', 'IE', '审核工序及价格'),
  ('worker', '工人', '提交本人计件记录'),
  ('production_management', '生产管理', '完整管理信息、责任判定与执行，不含本厂承担最终审批'),
  ('owner_group', '老板权限组', '李总与伍总同级同权的完整管理与本厂承担审批'),
  ('order_merchandiser', '订单跟单', '签收外部责任并跟进扣款'),
  ('factory_payables', '加工厂应付会计', '加工厂扣款确认与跟进'),
  ('embroidery_washing_payables', '印绣花洗水应付会计', '印绣花及洗水扣款确认与跟进'),
  ('fabric_payables', '面料供应商应付会计', '面料商扣款确认与跟进'),
  ('payroll_review', '工资复核', '复核工资资料'),
  ('payroll_close', '工资月结会计', '人工锁定工资月份'),
  ('finance_read', '财务全局查看', '财务全量只读'),
  ('system_admin', '系统管理员', '角色、基础配置、授权和审计；无本厂承担最终审批');

INSERT INTO role_capabilities(role_code, capability) VALUES
  ('quality_control', 'tools:user'), ('quality_control', 'rework:initiate'), ('quality_control', 'supplier_catalog:read'),
  ('tail_supervisor', 'tools:user'), ('tail_supervisor', 'dashboard:site:read'), ('tail_supervisor', 'process:configure'),
  ('tail_supervisor', 'task:assign'), ('tail_supervisor', 'submission:proxy'), ('tail_supervisor', 'submission:audit'),
  ('tail_supervisor', 'quantity:adjust'), ('tail_supervisor', 'payroll:review'), ('tail_supervisor', 'people:read'),
  ('tail_supervisor', 'process_catalog:read'), ('tail_supervisor', 'supplier_catalog:read'),
  ('ie_reviewer', 'tools:user'), ('ie_reviewer', 'process:review'), ('ie_reviewer', 'process_catalog:read'),
  ('worker', 'tools:user'), ('worker', 'submission:self'),
  ('production_management', 'tools:user'), ('production_management', 'dashboard:management:read'),
  ('production_management', 'liability:decide'), ('production_management', 'liability:takeover'),
  ('production_management', 'people:read'), ('production_management', 'process_catalog:read'), ('production_management', 'supplier_catalog:read'),
  ('owner_group', 'tools:user'), ('owner_group', 'dashboard:management:read'), ('owner_group', 'liability:decide'),
  ('owner_group', 'liability:takeover'), ('owner_group', 'own_factory:approve'), ('owner_group', 'access:admin'),
  ('owner_group', 'delegation:manage'), ('owner_group', 'people:read'), ('owner_group', 'process_catalog:read'), ('owner_group', 'supplier_catalog:read'),
  ('order_merchandiser', 'tools:user'), ('order_merchandiser', 'external_liability:sign'), ('order_merchandiser', 'deduction:manage'),
  ('order_merchandiser', 'supplier_catalog:read'),
  ('factory_payables', 'tools:user'), ('factory_payables', 'deduction:manage'), ('factory_payables', 'finance:read'), ('factory_payables', 'supplier_catalog:read'),
  ('embroidery_washing_payables', 'tools:user'), ('embroidery_washing_payables', 'deduction:manage'), ('embroidery_washing_payables', 'finance:read'), ('embroidery_washing_payables', 'supplier_catalog:read'),
  ('fabric_payables', 'tools:user'), ('fabric_payables', 'deduction:manage'), ('fabric_payables', 'finance:read'), ('fabric_payables', 'supplier_catalog:read'),
  ('payroll_review', 'tools:user'), ('payroll_review', 'payroll:review'),
  ('payroll_close', 'tools:user'), ('payroll_close', 'payroll:close'), ('payroll_close', 'finance:read'),
  ('finance_read', 'tools:user'), ('finance_read', 'finance:read'),
  ('system_admin', 'tools:user'), ('system_admin', 'dashboard:management:read'), ('system_admin', 'master_data:manage'),
  ('system_admin', 'people:read'), ('system_admin', 'process_catalog:read'), ('system_admin', 'supplier_catalog:read'),
  ('system_admin', 'access:admin'), ('system_admin', 'delegation:manage'), ('system_admin', 'audit:read');
