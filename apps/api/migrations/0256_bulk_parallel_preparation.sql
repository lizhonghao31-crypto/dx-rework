-- Preserve existing routes and immutable history; only new SLA routes use version 2.
ALTER TABLE digital_bulk_preparations ALTER COLUMN approval_snapshot_id DROP NOT NULL;
ALTER TABLE digital_bulk_preparations ADD COLUMN workflow_version integer NOT NULL DEFAULT 1;
ALTER TABLE digital_bulk_preparations ADD COLUMN sla_snapshot_id uuid REFERENCES digital_sla_order_snapshots(snapshot_id);
ALTER TABLE digital_bulk_preparations ADD CONSTRAINT digital_bulk_workflow_version CHECK (
 (workflow_version=1 AND approval_snapshot_id IS NOT NULL)
 OR (workflow_version=2 AND preshrink='需要预缩' AND sla_snapshot_id IS NOT NULL)
);
COMMENT ON COLUMN digital_bulk_preparations.approval_snapshot_id IS
 'Approval captured when available; technical preparation may precede approval. Cutting checks the current effective business approval.';
