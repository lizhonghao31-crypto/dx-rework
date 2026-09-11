-- Lightweight wage payment marker: records only whether a wage item has been paid.
-- It intentionally does not reuse or mutate the retired month-close workflow.

ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('wage:settlement_mark','工资结算标记','将筛选命中的工资明细标记为已结算，不改变工资金额或业务状态')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('wage_month_close_accountant','wage:settlement_mark'),
  ('finance_director','wage:settlement_mark')
ON CONFLICT DO NOTHING;

ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE TABLE rework_wage_settlement_marks (
  wage_item_id uuid PRIMARY KEY REFERENCES rework_wage_items(wage_item_id),
  settled_by uuid NOT NULL REFERENCES app_users(id),
  settled_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  operation_request_id text NOT NULL
);

CREATE INDEX rework_wage_settlement_marks_actor_time_idx
  ON rework_wage_settlement_marks(settled_by,settled_at DESC);
