-- Corrections are append-only facts, not replacement rows in the creation table.
-- Cutting must reference the immutable approved line and its owning case.
-- Keep the existing (approval_snapshot_id, sourcing_line_position) foreign key
-- and matching-source trigger. Validate the replacement ownership FK before
-- removing the obsolete creation-line FK; no business rows are rewritten.
ALTER TABLE sourcing_approval_snapshots
  ADD CONSTRAINT sourcing_approval_snapshots_case_identity
  UNIQUE (sourcing_case_id, sourcing_approval_snapshot_id);

ALTER TABLE cutting_orders
  ADD CONSTRAINT cutting_orders_approval_case_identity_fkey
  FOREIGN KEY (sourcing_case_id, approval_snapshot_id)
  REFERENCES sourcing_approval_snapshots (sourcing_case_id, sourcing_approval_snapshot_id);

ALTER TABLE cutting_orders
  DROP CONSTRAINT cutting_orders_sourcing_case_id_sourcing_line_position_fkey;
