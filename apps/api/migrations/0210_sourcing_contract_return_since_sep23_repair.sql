-- Repair eligible owner/root approvals from 2026-09-23 00:00 in Shanghai,
-- including approvals after the one-time 0209 migration and before this release.
-- Lock against concurrent approvals and ready transitions until the rows commit.
LOCK TABLE sourcing_approval_snapshots, sourcing_contract_documents IN SHARE MODE;

WITH qualifying AS MATERIALIZED (
  SELECT approval.sourcing_case_id, approval.sourcing_approval_snapshot_id
  FROM sourcing_approval_snapshots approval
  WHERE approval.approved_at >= TIMESTAMPTZ '2026-09-23 00:00:00+08'
    AND (
      EXISTS (
        SELECT 1 FROM sourcing_owner_decisions owner_decision
        WHERE owner_decision.operation_event_id = approval.operation_event_id
          AND owner_decision.sourcing_decision_id = approval.sourcing_decision_id
          AND owner_decision.decision = 'approved'
      )
      OR EXISTS (
        SELECT 1 FROM sourcing_decisions decision
        JOIN sourcing_factory_change_decisions owner_change
          ON owner_change.factory_change_request_id = decision.source_change_request_id
        WHERE decision.sourcing_decision_id = approval.sourcing_decision_id
          AND owner_change.operation_event_id = approval.operation_event_id
          AND owner_change.decision = 'approved'
          AND owner_change.decision_role = 'owner_group'
      )
    )
), first_ready AS (
  SELECT DISTINCT ON (document.sourcing_case_id)
    document.sourcing_case_id, document.generated_at
  FROM sourcing_contract_documents document
  JOIN qualifying approval
    ON approval.sourcing_approval_snapshot_id = document.sourcing_approval_snapshot_id
  WHERE document.status = 'ready'
    AND document.generated_at IS NOT NULL
  ORDER BY document.sourcing_case_id, document.generated_at, document.sourcing_contract_document_id
)
INSERT INTO sourcing_contract_return_monitors (
  sourcing_case_id, contract_return_monitor_enabled,
  contract_generated_at, contract_return_due_at
)
SELECT source_case.sourcing_case_id, true, first_ready.generated_at,
  sourcing_contract_return_add_hours(first_ready.generated_at, 48)
FROM sourcing_cases source_case
JOIN (SELECT DISTINCT sourcing_case_id FROM qualifying) eligible
  ON eligible.sourcing_case_id = source_case.sourcing_case_id
LEFT JOIN first_ready ON first_ready.sourcing_case_id = source_case.sourcing_case_id
WHERE source_case.deleted_at IS NULL
ON CONFLICT (sourcing_case_id) DO UPDATE
SET contract_generated_at = EXCLUDED.contract_generated_at,
    contract_return_due_at = EXCLUDED.contract_return_due_at
WHERE sourcing_contract_return_monitors.contract_return_monitor_enabled
  AND sourcing_contract_return_monitors.contract_generated_at IS NULL
  AND EXCLUDED.contract_generated_at IS NOT NULL;
