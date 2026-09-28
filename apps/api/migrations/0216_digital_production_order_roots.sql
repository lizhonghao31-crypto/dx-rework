-- Digital production v1 starts from explicit new root records only.
-- Existing sourcing, cutting, receiving, rework and pattern-room orders are deliberately not backfilled.
CREATE TABLE production_order_roots (
  production_order_id uuid PRIMARY KEY,
  workflow_generation text NOT NULL CHECK (workflow_generation = 'digital_production_v1'),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX production_order_roots_created_at_idx
  ON production_order_roots(created_at DESC, production_order_id DESC);

CREATE FUNCTION guard_production_order_root_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'production order root identity is immutable' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER production_order_roots_immutable
BEFORE UPDATE OR DELETE ON production_order_roots
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

COMMENT ON TABLE production_order_roots IS
  'Root identity for orders created in the digital production workflow. Historical orders are intentionally absent.';
COMMENT ON COLUMN production_order_roots.workflow_generation IS
  'Immutable routing generation. Existing legacy orders never receive this value by backfill.';
