-- Add only basic rework visibility; existing business roles and actions are unchanged.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
INSERT INTO capability_catalog(capability,display_name,description)
VALUES('rework:basic:view','查看返工基础信息','质检查看返工基础资料、照片和当前进度，不含节点内容或财务信息');
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO role_capabilities(role_code,capability) VALUES('quality_control','rework:basic:view');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
