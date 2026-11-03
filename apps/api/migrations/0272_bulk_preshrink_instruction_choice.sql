-- New preparations retain the published instruction's explicit preshrink choice.
-- Existing preparations, instructions, facts, tasks and SLA snapshots are not updated.
ALTER TABLE digital_bulk_preparations DROP CONSTRAINT digital_bulk_workflow_version;
ALTER TABLE digital_bulk_preparations ADD CONSTRAINT digital_bulk_workflow_version CHECK (
 (workflow_version=1 AND approval_snapshot_id IS NOT NULL)
 OR (workflow_version=2 AND sla_snapshot_id IS NOT NULL)
);
