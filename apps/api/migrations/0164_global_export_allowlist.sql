-- PR-02 permission closure: normalize every persisted business export grant to the approved allowlists.
-- Generic exports: Root is enforced by the trusted actor bypass; role grants are limited to
-- owner_group, production_management and finance_director.
-- Wage detail is more sensitive: production_management is intentionally excluded and the
-- wage_month_close_accountant exception is limited to wage:export.

ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;

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

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

-- Export capabilities are also available through global delegated authorization.
-- Revoke every historical export delegation so stale grants cannot survive the role reset.
ALTER TABLE delegated_authorizations DISABLE TRIGGER delegated_authorizations_revoke_only;
UPDATE delegated_authorizations
SET revoked_at=CURRENT_TIMESTAMP,
    revoked_by=grantor_user_id,
    revoke_reason='2026-09-09 数据导出权限统一收口'
WHERE capability IN ('receiving:export','report:export','wage:export')
  AND revoked_at IS NULL;
ALTER TABLE delegated_authorizations ENABLE TRIGGER delegated_authorizations_revoke_only;

-- Generic delegation must not become an escape hatch around the fixed export allowlist.
CREATE OR REPLACE FUNCTION reject_unapproved_data_export_delegation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.capability IN ('receiving:export','report:export','wage:export') THEN
    RAISE EXCEPTION 'data export capabilities cannot be delegated without an approved permission change'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS delegated_authorizations_export_default_deny ON delegated_authorizations;
CREATE TRIGGER delegated_authorizations_export_default_deny
  BEFORE INSERT ON delegated_authorizations
  FOR EACH ROW EXECUTE FUNCTION reject_unapproved_data_export_delegation();
