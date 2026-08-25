-- 1.0 role-entry closure: one finance authority baseline and actionable todo entry.
-- Existing finance-director special-approval authority remains unchanged.

DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO role_capabilities(role_code,capability)
SELECT 'finance_director',capability
FROM role_capabilities
WHERE role_code='finance_read'
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('embroidery_washing_merchandiser','todo:view')
ON CONFLICT DO NOTHING;

CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
