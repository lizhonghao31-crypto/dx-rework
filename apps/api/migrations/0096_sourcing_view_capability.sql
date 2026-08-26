-- Register the platform-level sourcing entry without introducing sourcing data.
DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('sourcing:view','报价选厂查看','进入报价与选厂业务模块')
ON CONFLICT (capability) DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('production_management','sourcing:view'),
  ('order_merchandiser','sourcing:view'),
  ('factory_payables','sourcing:view'),
  ('finance_director','sourcing:view'),
  ('owner_group','sourcing:view')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
