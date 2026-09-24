-- Rework business type foundation and source-link search support.
-- Existing orders are QC rework by definition; future in-house finishing
-- orders reuse the same rework lifecycle until the dedicated branch point.

ALTER TABLE rework_orders
  ADD COLUMN rework_kind text NOT NULL DEFAULT 'qc_rework'
  CHECK (rework_kind IN ('qc_rework','inhouse_finishing'));

CREATE INDEX rework_orders_kind_status_idx
  ON rework_orders(rework_kind,status,updated_at DESC)
  WHERE status<>'deleted';
