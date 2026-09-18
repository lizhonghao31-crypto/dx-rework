-- Backfill stable cutting tasks for historical sourcing cases that already have an owner-approved snapshot.
-- This migration creates missing task identities only. It never invents cutting quantities or rewrites existing tasks.

WITH latest_approval AS MATERIALIZED (
  SELECT DISTINCT ON (snapshot.sourcing_case_id)
         snapshot.sourcing_case_id,
         snapshot.sourcing_approval_snapshot_id
  FROM sourcing_approval_snapshots snapshot
  JOIN sourcing_cases source_case
    ON source_case.sourcing_case_id=snapshot.sourcing_case_id
   AND source_case.deleted_at IS NULL
  ORDER BY snapshot.sourcing_case_id,
           snapshot.decision_version DESC,
           snapshot.approved_at DESC,
           snapshot.sourcing_approval_snapshot_id DESC
),
eligible_lines AS MATERIALIZED (
  SELECT approval.sourcing_case_id,
         line.position AS sourcing_line_position,
         approval.sourcing_approval_snapshot_id
  FROM latest_approval approval
  JOIN sourcing_approval_snapshot_lines line
    ON line.sourcing_approval_snapshot_id=approval.sourcing_approval_snapshot_id
  JOIN sourcing_case_lines source_line
    ON source_line.sourcing_case_id=approval.sourcing_case_id
   AND source_line.position=line.position
)
INSERT INTO cutting_orders(
  cutting_order_id,
  sourcing_case_id,
  sourcing_line_position,
  approval_snapshot_id
)
SELECT gen_random_uuid(),
       eligible.sourcing_case_id,
       eligible.sourcing_line_position,
       eligible.sourcing_approval_snapshot_id
FROM eligible_lines eligible
ON CONFLICT(sourcing_case_id,sourcing_line_position) DO NOTHING;
