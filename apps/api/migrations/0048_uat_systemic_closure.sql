-- Close recurrent UAT gaps with one canonical responsibility amount source and
-- retire legacy payroll roles that were superseded by the PR-12 wage workflow.

CREATE VIEW rework_effective_responsibility_allocations AS
SELECT
  allocation.determination_id,
  allocation.configuration_item_id,
  allocation.responsibility_type,
  allocation.share_bps,
  allocation.unrounded_amount,
  allocation.rounded_amount original_rounded_amount,
  (
    allocation.rounded_amount
    + COALESCE(adjustment.adjustment_amount, 0)
  )::numeric(18,2) effective_rounded_amount
FROM rework_responsibility_allocations allocation
LEFT JOIN rework_responsibility_rounding_adjustments adjustment
  USING (determination_id, configuration_item_id, responsibility_type);

DROP TRIGGER business_roles_no_update ON business_roles;

UPDATE business_roles
SET enabled = false,
    description = description || '（已由新版工资流程角色替代）'
WHERE role_code IN ('payroll_review', 'payroll_close')
  AND enabled = true;

CREATE TRIGGER business_roles_no_update
  BEFORE UPDATE ON business_roles FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
