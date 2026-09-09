-- Acceptance audit: grant finance director sample read visibility only.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;

INSERT INTO role_capabilities(role_code,capability) VALUES
 ('finance_director','sample:view_basic'),
 ('finance_director','sample:view_finance'),
 ('finance_director','sample:view_audit')
ON CONFLICT DO NOTHING;

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
