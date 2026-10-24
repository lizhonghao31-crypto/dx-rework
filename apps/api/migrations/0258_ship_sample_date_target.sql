-- Date targets have no fabricated processing start or elapsed-time warning.
-- Existing duration rows retain their original invariants and immutable history.
ALTER TABLE digital_production_deadline_revisions ADD COLUMN deadline_kind text NOT NULL DEFAULT 'duration'
 CHECK(deadline_kind IN ('duration','date_target'));
ALTER TABLE digital_production_deadline_revisions DROP CONSTRAINT digital_production_deadline_revisions_check;
ALTER TABLE digital_production_deadline_revisions DROP CONSTRAINT digital_production_deadline_revisions_check1;
ALTER TABLE digital_production_deadline_revisions ADD CONSTRAINT digital_deadline_typed_boundary CHECK(
 (deadline_kind='duration' AND (warning_at IS NULL)=(due_at IS NULL)
  AND (due_at IS NULL OR (entered_at IS NOT NULL AND warning_at>=entered_at AND due_at>=warning_at)))
 OR (deadline_kind='date_target' AND policy_node_key='bulk_ship_sample' AND entered_at IS NULL AND warning_at IS NULL
  AND coalesce(sla_basis->>'precision'='date' AND sla_basis->>'exclusive'='true'
    AND length(sla_basis->>'snapshotId')>0,false))
);
