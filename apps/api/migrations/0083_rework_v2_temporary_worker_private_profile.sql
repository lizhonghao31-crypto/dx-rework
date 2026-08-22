-- PR-09: temporary worker private profile.
-- Name remains on business_people; optional phone/identity fields are private
-- and are never copied into operation_events.

ALTER TABLE business_people
  ADD COLUMN temporary_phone_number text,
  ADD COLUMN temporary_identity_number text,
  ADD CONSTRAINT business_people_temporary_private_scope_check CHECK (
    person_type='temporary'
    OR (temporary_phone_number IS NULL AND temporary_identity_number IS NULL)
  ),
  ADD CONSTRAINT business_people_temporary_phone_check CHECK (
    temporary_phone_number IS NULL
    OR temporary_phone_number ~ '^\+?[0-9]{6,20}$'
  ),
  ADD CONSTRAINT business_people_temporary_identity_number_check CHECK (
    temporary_identity_number IS NULL
    OR temporary_identity_number ~ '^([0-9]{15}|[0-9]{17}[0-9X])$'
  );

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('temporary_worker_private:read','临时工隐私资料查看','查看临时工完整手机号和身份证号')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability)
SELECT role_code,'temporary_worker_private:read'
FROM business_roles
WHERE role_code IN (
  'owner_group','tail_supervisor','finance_read','finance_director',
  'factory_payables','fabric_payables','embroidery_washing_payables','payroll_close'
)
UNION ALL
SELECT role_code,'people:read'
FROM business_roles
WHERE role_code IN (
  'finance_read','finance_director','factory_payables','fabric_payables',
  'embroidery_washing_payables','payroll_close'
)
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
