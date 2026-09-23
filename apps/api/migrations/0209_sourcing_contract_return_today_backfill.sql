-- Enroll only owner/root approvals made on the Shanghai business day 2026-09-23.
-- Migrations run in a transaction. Block concurrent ready transitions until the
-- monitor rows have committed, so the existing ready trigger cannot miss them.
LOCK TABLE sourcing_approval_snapshots, sourcing_contract_documents IN SHARE MODE;

WITH qualifying AS MATERIALIZED (
  SELECT approval.sourcing_case_id, approval.sourcing_approval_snapshot_id
  FROM sourcing_approval_snapshots approval
  WHERE approval.approved_at >= TIMESTAMPTZ '2026-09-23 00:00:00+08'
    AND approval.approved_at < TIMESTAMPTZ '2026-09-24 00:00:00+08'
    AND (
      EXISTS (
        SELECT 1 FROM sourcing_owner_decisions owner_decision
        WHERE owner_decision.operation_event_id = approval.operation_event_id
          AND owner_decision.decision = 'approved'
          AND owner_decision.sourcing_decision_id = approval.sourcing_decision_id
      )
      OR EXISTS (
        SELECT 1
        FROM sourcing_decisions decision
        JOIN sourcing_factory_change_decisions owner_change
          ON owner_change.factory_change_request_id = decision.source_change_request_id
        WHERE decision.sourcing_decision_id = approval.sourcing_decision_id
          AND owner_change.operation_event_id = approval.operation_event_id
          AND owner_change.decision = 'approved'
          AND owner_change.decision_role = 'owner_group'
      )
    )
)
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
  JOIN qualifying approval
    ON approval.sourcing_approval_snapshot_id = document.sourcing_approval_snapshot_id
  WHERE document.sourcing_case_id = source_case.sourcing_case_id
    AND document.status = 'ready'
    AND document.generated_at IS NOT NULL
  ORDER BY document.generated_at, document.sourcing_contract_document_id
  LIMIT 1
) first_ready ON true
WHERE source_case.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM qualifying approval
    WHERE approval.sourcing_case_id = source_case.sourcing_case_id
  )
ON CONFLICT (sourcing_case_id) DO NOTHING;
