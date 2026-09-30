-- Lightweight paid-wage markers. Existing wages, amounts and historical closures remain intact.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
INSERT INTO capability_catalog(capability,display_name,description)
VALUES('wage:settlement_mark','标记工资结算','按筛选明细标记已发工资，不修改工资或订单状态');
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('wage_month_close_accountant','wage:settlement_mark'),
 ('finance_read','wage:settlement_mark'),
 ('finance_director','wage:settlement_mark');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE TABLE rework_wage_settlement_marks (
 line_id uuid PRIMARY KEY,
 wage_item_id uuid REFERENCES rework_wage_items(wage_item_id) ON DELETE CASCADE,
 closure_line_id uuid REFERENCES rework_wage_month_close_lines(closure_line_id) ON DELETE CASCADE,
 marked_by uuid NOT NULL REFERENCES app_users(id),
 marked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((wage_item_id IS NOT NULL)::int + (closure_line_id IS NOT NULL)::int = 1),
 CHECK (line_id=COALESCE(wage_item_id,closure_line_id))
);
