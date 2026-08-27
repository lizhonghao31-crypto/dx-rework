-- Existing orders must retain the historical mandatory-tail behavior. Adding a
-- non-null column with a true default materializes true for every existing row
-- and makes true the server-side default for all future inserts.
ALTER TABLE rework_orders
  ADD COLUMN tail_inspection_required boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN rework_orders.tail_inspection_required IS
  'Whether this order requires the tail-inspection task and reconciliation flow; historical orders default to true.';
