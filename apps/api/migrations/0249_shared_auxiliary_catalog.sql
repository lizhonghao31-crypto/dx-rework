-- Dedicated shared directory. Never import or rewrite historical order materials.
-- Existing immutable capability catalogs are opened only for these reviewed
-- additions inside the migration transaction, then restored before app use.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('auxiliary_catalog:read','共享辅料目录查看','读取共享辅料目录'),('auxiliary_catalog:write','共享辅料目录维护','新增、改名、合并重复辅料及停用') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability)
 SELECT r,c FROM unnest(ARRAY['order_merchandiser','sample_designer','production_management','owner_group']) r
 CROSS JOIN unnest(ARRAY['auxiliary_catalog:read','auxiliary_catalog:write']) c ON CONFLICT DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

CREATE TABLE auxiliary_catalog_items (
 auxiliary_id uuid PRIMARY KEY,
 version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
 specification text NOT NULL CHECK(length(specification)<=100),
 supplier text NOT NULL CHECK(length(supplier)<=100),
 auxiliary_kind text NOT NULL CHECK(auxiliary_kind IN ('普通辅料','拉链','扁机')),
 active boolean NOT NULL,
 merged_into uuid REFERENCES auxiliary_catalog_items(auxiliary_id),
 changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(merged_into IS NULL OR (merged_into<>auxiliary_id AND NOT active))
);
CREATE UNIQUE INDEX auxiliary_catalog_current_combination ON auxiliary_catalog_items(lower(btrim(name)),lower(btrim(specification)),lower(btrim(supplier))) WHERE active AND merged_into IS NULL;
CREATE TABLE auxiliary_catalog_versions (
 auxiliary_id uuid NOT NULL REFERENCES auxiliary_catalog_items(auxiliary_id),
 version integer NOT NULL CHECK(version>0),
 name text NOT NULL,specification text NOT NULL,supplier text NOT NULL,
 auxiliary_kind text NOT NULL CHECK(auxiliary_kind IN ('普通辅料','拉链','扁机')),
 active boolean NOT NULL,merged_into uuid REFERENCES auxiliary_catalog_items(auxiliary_id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 changed_by uuid NOT NULL REFERENCES app_users(id),
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(auxiliary_id,version)
);
CREATE TABLE auxiliary_catalog_merges (
 source_id uuid PRIMARY KEY REFERENCES auxiliary_catalog_items(auxiliary_id),
 target_id uuid NOT NULL REFERENCES auxiliary_catalog_items(auxiliary_id),
 source_version integer NOT NULL,target_version integer NOT NULL,
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 CHECK(source_id<>target_id),
 FOREIGN KEY(source_id,source_version) REFERENCES auxiliary_catalog_versions(auxiliary_id,version),
 FOREIGN KEY(target_id,target_version) REFERENCES auxiliary_catalog_versions(auxiliary_id,version)
);
CREATE TRIGGER auxiliary_catalog_version_immutable BEFORE UPDATE OR DELETE ON auxiliary_catalog_versions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER auxiliary_catalog_merge_immutable BEFORE UPDATE OR DELETE ON auxiliary_catalog_merges
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
