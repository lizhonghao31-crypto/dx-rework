-- PR-02 permission closure: normalize every persisted business export grant to the approved allowlists.
-- Generic exports: Root is enforced by the trusted actor bypass; role grants are limited to
-- owner_group, production_management and finance_director.
-- Wage detail is more sensitive: production_management is intentionally excluded and the
-- wage_month_close_accountant exception is limited to wage:export.

ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;

DELETE FROM role_capabilities
WHERE capability='receiving:export'
  AND role_code NOT IN ('owner_group','production_management','finance_director');

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('owner_group','receiving:export'),
  ('production_management','receiving:export'),
  ('finance_director','receiving:export')
ON CONFLICT DO NOTHING;

DELETE FROM role_capabilities
WHERE capability='report:export'
  AND role_code NOT IN ('owner_group','production_management','finance_director');

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('owner_group','report:export'),
  ('production_management','report:export'),
  ('finance_director','report:export')
ON CONFLICT DO NOTHING;

DELETE FROM role_capabilities
WHERE capability='wage:export'
  AND role_code NOT IN ('owner_group','finance_director','wage_month_close_accountant');

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('owner_group','wage:export'),
  ('finance_director','wage:export'),
  ('wage_month_close_accountant','wage:export')
ON CONFLICT DO NOTHING;

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
