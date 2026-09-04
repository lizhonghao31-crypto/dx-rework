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
