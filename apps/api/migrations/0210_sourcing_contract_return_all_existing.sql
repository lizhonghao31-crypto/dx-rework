-- Backfill every existing non-deleted case with a genuine owner approval.
-- Historic ready PDFs keep their original timestamps. Only orders without a
-- previously usable return clock receive a catch-up exemption from old lateness.
-- A pending PDF does not prevent a signed attachment from being returned.
-- Approvals lock their sourcing_cases row before inserting a snapshot/monitor.
-- Acquire this table lock first so this backfill cannot hold a snapshot or
-- monitor lock while waiting for an in-flight approval's case row.
LOCK TABLE sourcing_cases IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE sourcing_contract_return_monitors
  ADD COLUMN contract_return_catchup boolean NOT NULL DEFAULT false;

ALTER TABLE sourcing_contract_return_monitors
  DROP CONSTRAINT sourcing_contract_return_monitors_check;
ALTER TABLE sourcing_contract_return_monitors
  ADD CONSTRAINT sourcing_contract_return_monitors_check CHECK (
    (contract_generated_at IS NULL AND contract_return_due_at IS NULL
      AND (contract_returned_at IS NULL OR contract_return_monitor_enabled))
    OR (contract_return_monitor_enabled AND contract_generated_at IS NOT NULL
      AND contract_return_due_at = sourcing_contract_return_add_hours(contract_generated_at,48))
  );

-- Serialize against the ready trigger while the initial PDF timestamp is found.
LOCK TABLE sourcing_approval_snapshots, sourcing_contract_documents IN SHARE MODE;

WITH qualifying AS MATERIALIZED (
  SELECT approval.sourcing_case_id,approval.sourcing_approval_snapshot_id
  FROM sourcing_approval_snapshots approval
  WHERE EXISTS (
    SELECT 1 FROM sourcing_owner_decisions owner_decision
    WHERE owner_decision.operation_event_id=approval.operation_event_id
      AND owner_decision.sourcing_decision_id=approval.sourcing_decision_id
      AND owner_decision.decision='approved'
  ) OR EXISTS (
    SELECT 1 FROM sourcing_decisions decision
    JOIN sourcing_factory_change_decisions owner_change
      ON owner_change.factory_change_request_id=decision.source_change_request_id
    WHERE decision.sourcing_decision_id=approval.sourcing_decision_id
      AND owner_change.operation_event_id=approval.operation_event_id
      AND owner_change.decision='approved'
      AND owner_change.decision_role='owner_group'
  )
)
INSERT INTO sourcing_contract_return_monitors (
  sourcing_case_id,contract_return_monitor_enabled,contract_return_catchup,
  contract_generated_at,contract_return_due_at
)
SELECT source_case.sourcing_case_id,true,first_ready.generated_at IS NOT NULL,
  first_ready.generated_at,sourcing_contract_return_add_hours(first_ready.generated_at,48)
FROM sourcing_cases source_case
LEFT JOIN LATERAL (
  SELECT document.generated_at
  FROM sourcing_contract_documents document
  JOIN qualifying approval
    ON approval.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id
  WHERE document.sourcing_case_id=source_case.sourcing_case_id
    AND document.status='ready' AND document.generated_at IS NOT NULL
  ORDER BY document.generated_at,document.sourcing_contract_document_id
  LIMIT 1
) first_ready ON true
WHERE source_case.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM qualifying approval
    WHERE approval.sourcing_case_id=source_case.sourcing_case_id)
ON CONFLICT (sourcing_case_id) DO UPDATE SET
  contract_return_monitor_enabled=true,
  contract_generated_at=COALESCE(
    sourcing_contract_return_monitors.contract_generated_at,EXCLUDED.contract_generated_at),
  contract_return_due_at=COALESCE(
    sourcing_contract_return_monitors.contract_return_due_at,EXCLUDED.contract_return_due_at),
  contract_return_catchup=sourcing_contract_return_monitors.contract_return_catchup
    OR (sourcing_contract_return_monitors.contract_generated_at IS NULL
      AND EXCLUDED.contract_generated_at IS NOT NULL)
WHERE NOT sourcing_contract_return_monitors.contract_return_monitor_enabled
  OR (sourcing_contract_return_monitors.contract_generated_at IS NULL
    AND EXCLUDED.contract_generated_at IS NOT NULL);
