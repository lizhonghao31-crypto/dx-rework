-- Basic module visibility is independent of a deduction case or current todo.
-- Existing financial detail scopes and every write capability remain separate.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
INSERT INTO capability_catalog(capability,display_name,description)
VALUES('rework:finance_orders:read','财务返工订单查询','读取全部返工基础订单；财务明细继续按现有岗位责任范围读取');
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO role_capabilities(role_code,capability)
SELECT role,'rework:finance_orders:read' FROM unnest(ARRAY[
  'factory_payables','embroidery_washing_payables','fabric_payables',
  'wage_month_close_accountant','finance_director','finance_read'
]) role;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE FUNCTION rework_finance_can_read_orders(candidate uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_direct_role(candidate,'rework:finance_orders:read',ARRAY[
    'factory_payables','embroidery_washing_payables','fabric_payables',
    'wage_month_close_accountant','finance_director','finance_read'
  ])
$$;
