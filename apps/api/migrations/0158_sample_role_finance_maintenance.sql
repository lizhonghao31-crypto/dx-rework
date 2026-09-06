-- SAMPLE V1.1: role catalog only; no employee assignments or business-data changes.
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_insert;
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_update;
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_update;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;

UPDATE business_roles SET display_name='样衣管理员',description='样衣实物交接、基础资料及处置执行；不是平台系统管理员'
 WHERE role_code='sample_administrative';
UPDATE business_roles SET description='样衣建档、财务查看、留痕修改资料及追加小票；无审批和归档权限'
 WHERE role_code='sample_finance';
UPDATE capability_catalog SET description='样衣财务或Root留痕更正采购价和追加小票；仅Root可撤下有效小票'
 WHERE capability='sample:correct_finance';
UPDATE capability_catalog SET description='老板、样衣审批人或Root审批'
 WHERE capability='sample:dispose_approve';
INSERT INTO business_roles(role_code,display_name,description) VALUES
 ('sample_approver','样衣审批人','样衣资料及财务查看、处置审批；不授予老板或其他模块权限');
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('sample_finance','sample:update_basic'),('sample_finance','sample:correct_finance'),
 ('sample_approver','tools:user'),('sample_approver','todo:view'),
 ('sample_approver','sample:view_basic'),('sample_approver','sample:view_finance'),
 ('sample_approver','sample:view_audit'),('sample_approver','sample:dispose_approve');

ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_insert;
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_update;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_update;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
