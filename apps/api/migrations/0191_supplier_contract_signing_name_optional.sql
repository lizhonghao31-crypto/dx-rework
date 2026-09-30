-- Contract signing name is optional. When omitted, the supplier display name is the effective legal name.
-- Preserve raw NULL for optional values while projecting a deterministic fallback to all current readers.

CREATE OR REPLACE FUNCTION normalize_optional_supplier_contract_entity_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_record supplier_catalog_versions%ROWTYPE;
BEGIN
  IF NEW.contract_entity_name IS NOT NULL AND btrim(NEW.contract_entity_name)='' THEN
    NEW.contract_entity_name := NULL;
  END IF;

  IF NEW.version > 1 THEN
    SELECT *
    INTO previous_record
    FROM supplier_catalog_versions
    WHERE supplier_id=NEW.supplier_id
    ORDER BY version DESC
    LIMIT 1;

    -- Application revisions that omit this optional field may carry the previous
    -- effective fallback value back into the next version. Keep it semantically
    -- optional by restoring NULL when the prior version had no explicit override.
    IF previous_record.version IS NOT NULL
       AND previous_record.contract_entity_name IS NULL
       AND NEW.contract_entity_name IS NOT NULL
       AND btrim(NEW.contract_entity_name)=btrim(previous_record.supplier_name)
    THEN
      NEW.contract_entity_name := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aaa_supplier_contract_entity_name_optional ON supplier_catalog_versions;
CREATE TRIGGER aaa_supplier_contract_entity_name_optional
  BEFORE INSERT ON supplier_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION normalize_optional_supplier_contract_entity_name();

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
    COALESCE(NULLIF(btrim(version.contract_entity_name),''),version.supplier_name) AS contract_entity_name,
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

-- Existing pending contract documents were prepared under the old rule.
-- Removing only this derived missing-field marker preserves the immutable approval
-- snapshot; runtime rendering now falls back to supplierName for the party-B name.
UPDATE sourcing_contract_documents
SET missing_fields=array_remove(missing_fields,'contractEntityName'),
    status=CASE
      WHEN status='pending_supplement'
       AND cardinality(array_remove(missing_fields,'contractEntityName'))=0
      THEN 'generation_pending'
      ELSE status
    END
WHERE status<>'ready'
  AND 'contractEntityName'=ANY(missing_fields);
