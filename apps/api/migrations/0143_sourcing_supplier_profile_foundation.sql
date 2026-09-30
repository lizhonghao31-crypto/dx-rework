-- SSP-01: extend the existing supplier catalog into the shared supplier profile foundation.
-- This migration adds no external data-transfer path and no second supplier directory.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('supplier_profile:read','供应商资料查看','查看供应商基础、联系、工艺与常规产能资料'),
  ('supplier_profile:write','供应商资料维护','新增、修订和停用版本化供应商资料'),
  ('supplier_contract_data:read','供应商合同资料查看','查看合同主体、乙方代表与收款资料')
ON CONFLICT (capability) DO NOTHING;

INSERT INTO role_capabilities(role_code,capability)
SELECT DISTINCT source.role_code,'supplier_profile:read'
FROM role_capabilities source
WHERE source.capability IN ('supplier_catalog:read','sourcing:view')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability)
SELECT role.role_code,'supplier_contract_data:read'
FROM business_roles role
WHERE role.role_code IN (
  'order_merchandiser','production_management','owner_group',
  'factory_payables','finance_director'
)
ON CONFLICT DO NOTHING;

-- The HTTP boundary remains root-only in SSP-01. The protected system role grant lets
-- the database verify immutable writes without hard-coding a person's name or ID.
INSERT INTO role_capabilities(role_code,capability)
SELECT role_code,'supplier_profile:write'
FROM business_roles
WHERE role_code='system_admin'
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

ALTER TABLE supplier_catalog_versions
  ADD COLUMN notes text NOT NULL DEFAULT ''
    CHECK(length(notes) <= 1000),
  ADD COLUMN contact_person text
    CHECK(contact_person IS NULL OR length(btrim(contact_person)) BETWEEN 1 AND 100),
  ADD COLUMN contact_phone text
    CHECK(contact_phone IS NULL OR length(btrim(contact_phone)) BETWEEN 1 AND 50),
  ADD COLUMN address text
    CHECK(address IS NULL OR length(btrim(address)) BETWEEN 1 AND 500),
  ADD COLUMN contract_entity_name text
    CHECK(contract_entity_name IS NULL OR length(btrim(contract_entity_name)) BETWEEN 1 AND 200),
  ADD COLUMN party_b_representative text
    CHECK(party_b_representative IS NULL OR length(btrim(party_b_representative)) BETWEEN 1 AND 100),
  ADD COLUMN payee_name text
    CHECK(payee_name IS NULL OR length(btrim(payee_name)) BETWEEN 1 AND 100),
  ADD COLUMN bank_account text
    CHECK(bank_account IS NULL OR length(btrim(bank_account)) BETWEEN 1 AND 100),
  ADD COLUMN bank_name text
    CHECK(bank_name IS NULL OR length(btrim(bank_name)) BETWEEN 1 AND 200),
  ADD COLUMN supported_crafts text[] NOT NULL DEFAULT '{}'::text[]
    CHECK(cardinality(supported_crafts) <= 50 AND array_position(supported_crafts,NULL) IS NULL),
  ADD COLUMN daily_capacity integer
    CHECK(daily_capacity IS NULL OR daily_capacity > 0);

-- Preserve the existing order-scoped temporary-supplier path while recording
-- normal profile maintenance against its dedicated capability.
CREATE OR REPLACE FUNCTION guard_supplier_catalog_version_creation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.supplier_version_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.supplier_version_request_id', true), '');
  audit_authorization_capability text := COALESCE(
    nullif(current_setting('dx_rework.supplier_version_authorization_capability', true), ''),
    'master_data:manage'
  );
  external_supplier_order_id text := nullif(current_setting('dx_rework.external_supplier_order_id', true), '');
  audit_actor_roles text[];
  previous_record supplier_catalog_versions%ROWTYPE;
  stable_supplier_code text;
  stable_supplier_type text;
  previous_state jsonb;
  audit_action text;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'supplier catalog version creation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  IF audit_authorization_capability NOT IN (
    'master_data:manage',
    'supplier_profile:write',
    'external_responsibility:sign'
  ) THEN
    RAISE EXCEPTION 'supplier catalog creation capability is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF audit_authorization_capability='external_responsibility:sign' THEN
    SELECT array_agg(DISTINCT assignment.role_code ORDER BY assignment.role_code)
    INTO audit_actor_roles
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code=assignment.role_code AND role.enabled=true
    JOIN app_users user_record
      ON user_record.id=assignment.user_id AND user_record.enabled=true
    WHERE assignment.user_id=NEW.changed_by
      AND assignment.revoked_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM identity_mappings identity_mapping
        JOIN access_security_policy policy
          ON policy.policy_key='primary'
          AND policy.dingtalk_corp_id=identity_mapping.corp_id
        WHERE identity_mapping.user_id=assignment.user_id
          AND identity_mapping.provider='dingtalk'
          AND identity_mapping.active=true
          AND identity_mapping.employed=true
      );
    IF audit_actor_roles IS NULL THEN
      RAISE EXCEPTION 'supplier catalog creation requires an active business actor'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    audit_actor_roles := access_authorized_actor_roles(
      NEW.changed_by,
      audit_authorization_capability
    );
  END IF;

  SELECT item.supplier_code,item.supplier_type
  INTO stable_supplier_code,stable_supplier_type
  FROM supplier_catalog_items item
  WHERE item.supplier_id=NEW.supplier_id
  FOR UPDATE;
  IF stable_supplier_code IS NULL THEN
    RAISE EXCEPTION 'supplier catalog item does not exist'
      USING ERRCODE = '23503';
  END IF;

  SELECT version.*
  INTO previous_record
  FROM supplier_catalog_versions version
  WHERE version.supplier_id=NEW.supplier_id
  ORDER BY version.version DESC
  LIMIT 1;

  IF audit_authorization_capability='external_responsibility:sign' THEN
    IF previous_record.version IS NOT NULL
       OR external_supplier_order_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM rework_external_responsibility_batches batch
         JOIN rework_external_responsibility_items item ON item.batch_id=batch.batch_id
         WHERE batch.rework_order_id=external_supplier_order_id::uuid
           AND batch.status='active'
           AND external_responsibility_expected_supplier_type(item.responsibility_type)=stable_supplier_type
           AND external_responsibility_can_sign(
             NEW.changed_by,
             batch.rework_order_id,
             item.responsibility_type
           )
       )
    THEN
      RAISE EXCEPTION 'temporary supplier creation is not authorized for this external responsibility'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'temporary supplier first version must be 1'
        USING ERRCODE = '23514';
    END IF;
    previous_state := NULL;
    audit_action := 'rework.external_responsibility.temporary_supplier.create';
  ELSIF previous_record.version IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'first supplier catalog version must be 1'
        USING ERRCODE = '23514';
    END IF;
    previous_state := NULL;
    audit_action := 'master_data.supplier.create';
  ELSE
    IF NEW.version <> previous_record.version + 1 THEN
      RAISE EXCEPTION 'supplier catalog versions must be sequential'
        USING ERRCODE = '23514';
    END IF;
    previous_state := jsonb_build_object(
      'supplierCode',stable_supplier_code,
      'supplierType',stable_supplier_type,
      'version',previous_record.version,
      'supplierName',previous_record.supplier_name,
      'active',previous_record.active,
      'notes',previous_record.notes,
      'contactPerson',previous_record.contact_person,
      'contactPhone',previous_record.contact_phone,
      'address',previous_record.address,
      'contractEntityName',previous_record.contract_entity_name,
      'partyBRepresentative',previous_record.party_b_representative,
      'payeeName',previous_record.payee_name,
      'bankAccountMasked',CASE
        WHEN previous_record.bank_account IS NULL THEN NULL
        WHEN length(previous_record.bank_account)<=6
          THEN repeat('*',length(previous_record.bank_account))
        ELSE left(previous_record.bank_account,2)
          || repeat('*',greatest(length(previous_record.bank_account)-6,0))
          || right(previous_record.bank_account,4)
      END,
      'bankName',previous_record.bank_name,
      'supportedCrafts',previous_record.supported_crafts,
      'dailyCapacity',previous_record.daily_capacity
    );
    audit_action := 'master_data.supplier.revise';
  END IF;

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.changed_by,audit_actor_roles,
    audit_authorization_capability,audit_action,'supplier_catalog',NEW.supplier_id::text,
    previous_state,
    jsonb_build_object(
      'supplierCode',stable_supplier_code,
      'supplierType',stable_supplier_type,
      'version',NEW.version,
      'supplierName',NEW.supplier_name,
      'active',NEW.active,
      'notes',NEW.notes,
      'contactPerson',NEW.contact_person,
      'contactPhone',NEW.contact_phone,
      'address',NEW.address,
      'contractEntityName',NEW.contract_entity_name,
      'partyBRepresentative',NEW.party_b_representative,
      'payeeName',NEW.payee_name,
      'bankAccountMasked',CASE
        WHEN NEW.bank_account IS NULL THEN NULL
        WHEN length(NEW.bank_account)<=6 THEN repeat('*',length(NEW.bank_account))
        ELSE left(NEW.bank_account,2)
          || repeat('*',greatest(length(NEW.bank_account)-6,0))
          || right(NEW.bank_account,4)
      END,
      'bankName',NEW.bank_name,
      'supportedCrafts',NEW.supported_crafts,
      'dailyCapacity',NEW.daily_capacity
    ),
    NEW.change_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION require_supplier_catalog_initial_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM supplier_catalog_versions version
    JOIN operation_events event
      ON event.entity_type='supplier_catalog'
      AND event.entity_id=NEW.supplier_id::text
      AND event.actor_id=version.changed_by
      AND event.reason=version.change_reason
      AND (
        (
          event.action='master_data.supplier.create'
          AND event.authorization_capability IN ('master_data:manage','supplier_profile:write')
        )
        OR (
          event.action='rework.external_responsibility.temporary_supplier.create'
          AND event.authorization_capability='external_responsibility:sign'
        )
      )
    WHERE version.supplier_id=NEW.supplier_id AND version.version=1
      AND event.after_state->>'supplierCode'=NEW.supplier_code
      AND event.after_state->>'supplierType'=NEW.supplier_type
      AND (event.after_state->>'version')::integer=1
      AND event.after_state->>'supplierName'=version.supplier_name
      AND (event.after_state->>'active')::boolean=version.active
  ) THEN
    RAISE EXCEPTION 'supplier catalog item requires an authorized audited initial version in the same transaction'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_active_supplier_profile_name()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active THEN
    PERFORM pg_advisory_xact_lock(hashtext('dx_rework:active_supplier_profile_name'));
    IF EXISTS (
      SELECT 1
      FROM current_supplier_catalog current_supplier
      WHERE current_supplier.supplier_id<>NEW.supplier_id
        AND current_supplier.active=true
        AND lower(btrim(current_supplier.supplier_name))=lower(btrim(NEW.supplier_name))
    ) THEN
      RAISE EXCEPTION 'active supplier display name already exists'
        USING ERRCODE='23505', CONSTRAINT='supplier_profile_active_name_unique';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_profile_active_name_guard
  BEFORE INSERT ON supplier_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION guard_active_supplier_profile_name();

CREATE OR REPLACE VIEW current_supplier_catalog AS
  SELECT DISTINCT ON (item.supplier_id)
    item.supplier_id,
    item.supplier_code,
    item.supplier_type,
    version.version,
    version.supplier_name,
    version.active,
    version.created_at,
    version.notes,
    version.contact_person,
    version.contact_phone,
    version.address,
    version.contract_entity_name,
    version.party_b_representative,
    version.payee_name,
    version.bank_account,
    version.bank_name,
    version.supported_crafts,
    version.daily_capacity,
    version.change_reason,
    version.changed_by
  FROM supplier_catalog_items item
  JOIN supplier_catalog_versions version ON version.supplier_id=item.supplier_id
  ORDER BY item.supplier_id,version.version DESC;
