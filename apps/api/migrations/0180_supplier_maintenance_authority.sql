-- Approved supplier maintenance roles; Root is resolved from the existing database authority.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;
DELETE FROM role_capabilities WHERE capability='supplier_profile:write';
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('owner_group','supplier_profile:write'),('production_management','supplier_profile:write');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;

CREATE FUNCTION supplier_profile_authorized_roles(actor_id uuid) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE roles text[];
BEGIN
  roles := access_authorized_actor_roles(actor_id,'supplier_profile:write');
  IF NOT (roles && ARRAY['root_superuser','owner_group','production_management']) THEN
    RAISE EXCEPTION 'supplier maintenance requires owner or production authority' USING ERRCODE='42501';
  END IF;
  RETURN roles;
END;
$$;

CREATE FUNCTION guard_supplier_profile_maintenance_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Retain the separately authorized, order-scoped temporary supplier workflow.
  IF COALESCE(current_setting('dx_rework.supplier_version_authorization_capability',true),'') <> 'external_responsibility:sign' THEN
    PERFORM supplier_profile_authorized_roles(NEW.changed_by);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_profile_maintenance_authority BEFORE INSERT ON supplier_catalog_versions
FOR EACH ROW EXECUTE FUNCTION guard_supplier_profile_maintenance_authority();

CREATE FUNCTION normalize_supplier_name(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT lower(regexp_replace(btrim(value), '\s+', ' ', 'g'))
$$;

-- This shared version trigger covers single entry, batch entry and approval creation.
-- Inactive profiles still reserve their identity. Existing duplicates are not rewritten.
CREATE OR REPLACE FUNCTION guard_active_supplier_profile_name() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('dx_rework:active_supplier_profile_name'));
  IF EXISTS (SELECT 1 FROM current_supplier_catalog c WHERE c.supplier_id=NEW.supplier_id
    AND normalize_supplier_name(c.supplier_name)=normalize_supplier_name(NEW.supplier_name)) THEN
    RETURN NEW;
  END IF;
  SELECT supplier_type INTO kind FROM supplier_catalog_items WHERE supplier_id=NEW.supplier_id;
  IF EXISTS (SELECT 1 FROM current_supplier_catalog c WHERE c.supplier_id<>NEW.supplier_id
    AND c.supplier_type=kind AND normalize_supplier_name(c.supplier_name)=normalize_supplier_name(NEW.supplier_name)) THEN
    RAISE EXCEPTION 'supplier name and type already exist' USING ERRCODE='23505', CONSTRAINT='supplier_profile_identity_unique';
  END IF;
  RETURN NEW;
END;
$$;
