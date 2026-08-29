-- Grant merchandisers a dedicated related-order view without exposing global reports.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('rework:related_orders:view','查看本人相关返工单','订单跟单和印绣花跟单只查看业务资料中直接关联本人的返工单')
ON CONFLICT (capability) DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('order_merchandiser','rework:related_orders:view'),
  ('embroidery_washing_merchandiser','rework:related_orders:view')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
