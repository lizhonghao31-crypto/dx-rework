-- Approved finance-only wage scope. No wage facts or paid markers are changed.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;

DELETE FROM role_capabilities
WHERE capability IN ('wage:view','wage:export')
  AND role_code NOT IN ('owner_group','production_management','finance_director','wage_month_close_accountant','finance_read');

INSERT INTO role_capabilities(role_code,capability)
SELECT role_code,capability FROM
  (VALUES ('owner_group'),('production_management'),('finance_director'),('wage_month_close_accountant'),('finance_read')) roles(role_code)
  CROSS JOIN (VALUES ('wage:view'),('wage:export')) grants(capability)
ON CONFLICT DO NOTHING;

-- Viewing/exporting does not confer the right to mark wages paid.
DELETE FROM role_capabilities WHERE capability='wage:settlement_mark'
  AND role_code NOT IN ('finance_director','wage_month_close_accountant','finance_read');

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE FUNCTION finance_authorized_wage_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[];
BEGIN
  actual_roles := access_authorized_actor_roles(actor_id, requested_capability);
  IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
  IF requested_capability NOT IN ('wage:view','wage:export','wage:settlement_mark')
     OR NOT actual_roles && ARRAY['owner_group','production_management','finance_director','wage_month_close_accountant','finance_read']::text[]
     OR (requested_capability='wage:settlement_mark' AND NOT actual_roles && ARRAY['finance_director','wage_month_close_accountant','finance_read']::text[]) THEN
    RAISE EXCEPTION 'finance wage access denied' USING ERRCODE='42501';
  END IF;
  RETURN actual_roles;
END;
$$;
