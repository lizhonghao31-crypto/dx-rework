-- PR-14: management/site dashboards and reporting access.
-- Adds read capabilities and query indexes only; business facts stay in their
-- originating immutable ledgers.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('report:view','查看管理报表','按授权查询工资、责任、承担、扣款和异常明细'),
  ('report:export','导出管理报表','导出与管理查询相同口径的 Excel 工作簿')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('owner_group','report:view'),
  ('owner_group','report:export'),
  ('production_management','report:view'),
  ('production_management','report:export'),
  ('tail_supervisor','report:view'),
  ('tail_supervisor','report:export'),
  ('finance_read','report:view'),
  ('finance_read','report:export')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE INDEX IF NOT EXISTS rework_orders_reporting_status_updated_idx
  ON rework_orders(status,updated_at DESC,rework_order_id);
CREATE INDEX IF NOT EXISTS rework_orders_reporting_created_idx
  ON rework_orders(created_at DESC,rework_order_id);
CREATE INDEX IF NOT EXISTS operation_events_reporting_rework_idx
  ON operation_events(entity_type,entity_id,created_at DESC,event_id)
  WHERE action LIKE 'rework.%';
CREATE INDEX IF NOT EXISTS responsibility_reporting_leaf_idx
  ON rework_responsibility_determinations(rework_order_id,determination_version DESC,stage,determination_id);
CREATE INDEX IF NOT EXISTS own_factory_reporting_order_idx
  ON rework_own_factory_approvals(rework_order_id,status,created_at DESC,approval_id);
CREATE INDEX IF NOT EXISTS external_case_reporting_order_idx
  ON rework_external_responsibility_cases(rework_order_id,status,created_at DESC,case_id);
CREATE INDEX IF NOT EXISTS external_deduction_reporting_case_idx
  ON rework_external_deduction_entries(case_id,created_at,deduction_entry_id);
CREATE INDEX IF NOT EXISTS external_follow_up_reporting_due_idx
  ON rework_external_deduction_follow_ups(next_follow_up_at,case_id)
  WHERE next_follow_up_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS wage_period_reporting_month_idx
  ON rework_wage_periods(period_month DESC,status,period_id);
CREATE INDEX IF NOT EXISTS wage_item_reporting_order_idx
  ON rework_wage_items(rework_order_id,period_id,wage_item_id);
CREATE INDEX IF NOT EXISTS todo_reporting_status_due_idx
  ON rework_todos(status,due_at,updated_at DESC,todo_id);
CREATE INDEX IF NOT EXISTS todo_delivery_reporting_outcome_idx
  ON todo_delivery_attempts(outcome,attempted_at DESC,todo_id)
  WHERE outcome IN ('failed','unknown_response');
CREATE INDEX IF NOT EXISTS dingtalk_binding_reporting_failure_idx
  ON dingtalk_todo_external_bindings(provider_state,updated_at DESC,todo_id)
  WHERE provider_state='permanent_failed';
