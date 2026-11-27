-- An audit trail of links to immutable evidence. It contains no receipt amounts.
CREATE TABLE digital_warehouse_receipt_reconciliations (
  resource_kind text NOT NULL CHECK (resource_kind IN ('order','source')),
  resource_id uuid NOT NULL,
  original_record_id uuid NOT NULL,
  original_version integer NOT NULL,
  quantity_row_key text NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  state text NOT NULL CHECK (state IN ('confirmed','revoked')),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding)='object'),
  proof_attachment_ids uuid[] NOT NULL DEFAULT '{}',
  actor_id uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (original_record_id,original_version,quantity_row_key,generation),
  FOREIGN KEY (original_record_id,original_version) REFERENCES digital_preparation_material_versions (record_id,version)
);

CREATE INDEX warehouse_receipt_reconciliation_resource
  ON digital_warehouse_receipt_reconciliations (resource_kind,resource_id,original_record_id,original_version,generation DESC);

CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_warehouse_receipt_reconciliations
  FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT $1->>''resource_kind'' AS kind,($1->>''resource_id'')::uuid AS id');

CREATE TRIGGER warehouse_receipt_reconciliation_no_edit BEFORE UPDATE OR DELETE ON digital_warehouse_receipt_reconciliations
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TRIGGER warehouse_receipt_reconciliation_no_truncate BEFORE TRUNCATE ON digital_warehouse_receipt_reconciliations
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
