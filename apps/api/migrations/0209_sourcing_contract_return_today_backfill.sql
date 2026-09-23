-- Include orders approved on 2026-09-23 in the Shanghai business day, including
-- approvals completed before the rollout cutoff. Older approvals stay outside scope.
-- Seed the clock from the first ready PDF for an approval made on that day.
-- A pending PDF gets a monitor row with no clock; the existing ready trigger starts it.
INSERT INTO sourcing_contract_return_monitors (
  sourcing_case_id, contract_return_monitor_enabled,
  contract_generated_at, contract_return_due_at
)
SELECT source_case.sourcing_case_id, true,
  first_ready.generated_at,
  sourcing_contract_return_add_hours(first_ready.generated_at, 48)
FROM sourcing_cases source_case
LEFT JOIN LATERAL (
  SELECT document.generated_at
  FROM sourcing_contract_documents document
  JOIN sourcing_approval_snapshots approval
    ON approval.sourcing_approval_snapshot_id = document.sourcing_approval_snapshot_id
  WHERE document.sourcing_case_id = source_case.sourcing_case_id
    AND approval.approved_at >= TIMESTAMPTZ '2026-09-23 00:00:00+08'
    AND approval.approved_at < TIMESTAMPTZ '2026-09-24 00:00:00+08'
    AND document.status = 'ready'
    AND document.generated_at IS NOT NULL
  ORDER BY document.generated_at, document.sourcing_contract_document_id
  LIMIT 1
) first_ready ON true
WHERE source_case.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM sourcing_approval_snapshots approval
    WHERE approval.sourcing_case_id = source_case.sourcing_case_id
      AND approval.approved_at >= TIMESTAMPTZ '2026-09-23 00:00:00+08'
      AND approval.approved_at < TIMESTAMPTZ '2026-09-24 00:00:00+08'
  )
ON CONFLICT (sourcing_case_id) DO NOTHING;
