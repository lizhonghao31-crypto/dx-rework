-- Rework/cutting piecework PR01: classify rework orders without changing the existing QC workflow.
-- Existing and legacy orders remain QC rework. New in-house finishing is enabled in a later PR.
ALTER TABLE rework_orders
  ADD COLUMN rework_kind text NOT NULL DEFAULT 'qc_rework'
  CHECK (rework_kind IN ('qc_rework','inhouse_finishing'));

CREATE INDEX rework_orders_kind_status_idx
  ON rework_orders(rework_kind,status,updated_at DESC)
  WHERE status<>'deleted';
