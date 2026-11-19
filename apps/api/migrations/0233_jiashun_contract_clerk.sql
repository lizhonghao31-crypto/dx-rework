-- Dedicated, supplier-scoped contract-return role. No employee assignments are created.
-- Bind the three supplied factory codes to stable supplier IDs automatically; no manual whitelist step.
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_insert;
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;

INSERT INTO business_roles(role_code,display_name,description)
VALUES ('jiashun_contract_clerk','嘉顺专职文员','仅嘉顺七厂、九厂、十厂订单只读，并可回传当前版本合同');
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('sourcing:jiashun:read','嘉顺三厂订单限定读取','仅按自动绑定的三厂供应商ID读取，不包含分析和导出'),
 ('sourcing:jiashun:contract_return','嘉顺合同回传','仅允许当前可回签版本的合同附件提交，不允许生成或修改合同'),
 ('tools:jiashun_contract_file','嘉顺合同文件暂存','仅为指定订单当前版本准备 PDF/JPG/PNG 文件');
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('jiashun_contract_clerk','sourcing:jiashun:read'),
 ('jiashun_contract_clerk','sourcing:jiashun:contract_return'),
 ('jiashun_contract_clerk','tools:jiashun_contract_file');

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_insert;

CREATE TABLE sourcing_jiashun_allowed_factories (
  factory_slot smallint PRIMARY KEY CHECK(factory_slot IN (7,9,10)),
  supplier_id uuid NOT NULL UNIQUE REFERENCES supplier_catalog_items(supplier_id),
  verified_name text NOT NULL CHECK(verified_name IN ('嘉顺七厂','嘉顺九厂','嘉顺十厂')),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT jiashun_slot_name_matches CHECK(
    (factory_slot=7 AND verified_name='嘉顺七厂') OR
    (factory_slot=9 AND verified_name='嘉顺九厂') OR
    (factory_slot=10 AND verified_name='嘉顺十厂'))
);

-- Zero-touch: bind the three supplied supplier codes to immutable IDs on migration,
-- or automatically on first role grant if supplier seed ran after migrations.
CREATE FUNCTION sourcing_jiashun_auto_bind_factories() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE matching_count int;
DECLARE distinct_id_count int;
BEGIN
  IF (SELECT COUNT(*) FROM sourcing_jiashun_allowed_factories)=3 THEN RETURN 3; END IF;
  WITH expected(slot,name,code) AS (VALUES
    (7,'嘉顺七厂','FAC_601BEF926B41'),
    (9,'嘉顺九厂','FAC_386DAEFCCF2E'),
    (10,'嘉顺十厂','FAC_7AACCD28B81F')),
  matches AS (
    SELECT expected.slot,expected.name,COUNT(catalog.supplier_id)::int AS candidates
    FROM expected LEFT JOIN current_supplier_catalog catalog
      ON catalog.supplier_code=expected.code
        AND catalog.supplier_type='factory' AND catalog.active
    GROUP BY expected.slot,expected.name
  )
  SELECT COUNT(*) INTO matching_count FROM matches WHERE candidates=1;
  SELECT COUNT(DISTINCT supplier_id) INTO distinct_id_count FROM current_supplier_catalog
  WHERE supplier_code IN ('FAC_601BEF926B41','FAC_386DAEFCCF2E','FAC_7AACCD28B81F')
    AND supplier_type='factory' AND active;
  -- Codes, not display names, are the bootstrap identity; the resulting IDs
  -- remain frozen even if the supplier display name changes later.
  IF matching_count=3 AND distinct_id_count=3 THEN
    INSERT INTO sourcing_jiashun_allowed_factories(factory_slot,supplier_id,verified_name)
      SELECT expected.slot,catalog.supplier_id,expected.name
      FROM (VALUES
        (7,'嘉顺七厂','FAC_601BEF926B41'),
        (9,'嘉顺九厂','FAC_386DAEFCCF2E'),
        (10,'嘉顺十厂','FAC_7AACCD28B81F')) expected(slot,name,code)
      JOIN current_supplier_catalog catalog
        ON catalog.supplier_code=expected.code
          AND catalog.supplier_type='factory' AND catalog.active
      ON CONFLICT(factory_slot) DO NOTHING;
  END IF;
  RETURN (SELECT COUNT(*)::integer FROM sourcing_jiashun_allowed_factories);
END $$;
SELECT sourcing_jiashun_auto_bind_factories();

-- Serializes assignment, revocation and delegated writes for the same user even
-- when concurrent administrator requests enter through different endpoints.
CREATE FUNCTION guard_jiashun_exclusive_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM app_users WHERE id=NEW.user_id FOR UPDATE;
  IF NEW.role_code='jiashun_contract_clerk' THEN
    IF sourcing_jiashun_auto_bind_factories() <> 3 THEN
      RAISE EXCEPTION 'Jiashun supplier codes not found uniquely; role cannot be activated' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM user_role_assignments a
      WHERE a.user_id=NEW.user_id AND a.revoked_at IS NULL
        AND a.assignment_id IS DISTINCT FROM NEW.assignment_id
        AND a.role_code <> 'jiashun_contract_clerk')
       OR EXISTS (SELECT 1 FROM owner_bootstrap_consumptions root_identity WHERE root_identity.user_id=NEW.user_id)
       OR EXISTS (SELECT 1 FROM delegated_authorizations d
         WHERE d.grantee_user_id=NEW.user_id AND d.revoked_at IS NULL
           AND d.valid_until>CURRENT_TIMESTAMP) THEN
      RAISE EXCEPTION 'Jiashun clerk account must not hold another role or delegation' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM user_role_assignments a
    WHERE a.user_id=NEW.user_id AND a.role_code='jiashun_contract_clerk' AND a.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Jiashun clerk cannot take another business role' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_role_assignments_jiashun_exclusive
  BEFORE INSERT OR UPDATE OF role_code,revoked_at ON user_role_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_jiashun_exclusive_role();

CREATE FUNCTION guard_jiashun_no_delegation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL OR NEW.valid_until<=CURRENT_TIMESTAMP THEN RETURN NEW; END IF;
  PERFORM 1 FROM app_users WHERE id=NEW.grantee_user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM user_role_assignments a
    WHERE a.user_id=NEW.grantee_user_id AND a.role_code='jiashun_contract_clerk' AND a.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Jiashun clerk cannot receive delegated capabilities' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delegated_authorizations_jiashun_exclusive
  BEFORE INSERT OR UPDATE OF grantee_user_id,revoked_at,valid_until ON delegated_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_jiashun_no_delegation();

-- The unique root identity is not a conventional role assignment. It must
-- never be rebound to the isolated clerk identity through later maintenance.
CREATE FUNCTION guard_jiashun_no_root_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM app_users WHERE id=NEW.user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM user_role_assignments assignment
    WHERE assignment.user_id=NEW.user_id AND assignment.role_code='jiashun_contract_clerk'
      AND assignment.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Jiashun clerk cannot become the root identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_bootstrap_consumptions_jiashun_exclusive
  BEFORE INSERT OR UPDATE OF user_id ON owner_bootstrap_consumptions
  FOR EACH ROW EXECUTE FUNCTION guard_jiashun_no_root_identity();

-- Each upload intent is tied to a case and exactly one document version.
-- Unbound content can never be submitted for another case or contract version.
CREATE TABLE sourcing_jiashun_contract_uploads (
  attachment_id uuid PRIMARY KEY REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  sourcing_contract_document_id uuid NOT NULL REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sourcing_jiashun_contract_uploads_case_idx
  ON sourcing_jiashun_contract_uploads(sourcing_case_id,sourcing_contract_document_id);
