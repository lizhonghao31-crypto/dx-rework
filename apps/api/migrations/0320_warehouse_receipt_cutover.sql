-- One append-only epoch per legacy whole-entry group. Unlisted groups retain
-- their existing write/read path; safe_read never restores the legacy write.
CREATE TABLE digital_warehouse_receipt_cutovers (
 resource_kind text NOT NULL CHECK (resource_kind IN ('source','order')),
 resource_id uuid NOT NULL,
 generation integer NOT NULL CHECK (generation>0),
 mode text NOT NULL CHECK (mode IN ('active','safe_read')),
 scope_keys jsonb NOT NULL CHECK (jsonb_typeof(scope_keys)='array' AND jsonb_array_length(scope_keys)>0),
 request_id uuid NOT NULL UNIQUE,
 release_sha text NOT NULL CHECK (release_sha ~ '^[0-9a-f]{40}$'),
 operator_label text NOT NULL CHECK (length(btrim(operator_label)) BETWEEN 1 AND 120),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
 basis jsonb NOT NULL CHECK (jsonb_typeof(basis)='object'),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (resource_kind,resource_id,generation)
);
CREATE TRIGGER warehouse_receipt_cutover_no_edit BEFORE UPDATE OR DELETE ON digital_warehouse_receipt_cutovers
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER warehouse_receipt_cutover_no_truncate BEFORE TRUNCATE ON digital_warehouse_receipt_cutovers
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_warehouse_receipt_cutovers
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT $1->>''resource_kind'' AS kind,($1->>''resource_id'')::uuid AS id');
