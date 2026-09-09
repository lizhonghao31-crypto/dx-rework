-- Permission baseline: ensure wage month-close accountant can export current wage details.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;

INSERT INTO role_capabilities(role_code,capability) VALUES
 ('wage_month_close_accountant','wage:export')
ON CONFLICT DO NOTHING;

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
