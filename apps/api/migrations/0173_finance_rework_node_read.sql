-- Read-only financial inspection is independent of each node's operation capabilities.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
INSERT INTO capability_catalog(capability,display_name,description)
VALUES('rework:finance_nodes:read','财务查看返工节点','读取当前与历史节点实际业务记录，不授予节点写入能力');
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO role_capabilities(role_code,capability) VALUES('finance_director','rework:finance_nodes:read');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
