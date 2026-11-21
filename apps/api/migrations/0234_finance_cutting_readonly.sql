-- Finance cutting is a read grant only. Leave all existing role assignments in place.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('finance_director','cutting:orders:view'),
  ('finance_read','cutting:orders:view'),
  ('factory_payables','cutting:orders:view'),
  ('embroidery_washing_payables','cutting:orders:view'),
  ('fabric_payables','cutting:orders:view'),
  ('wage_month_close_accountant','cutting:orders:view')
ON CONFLICT (role_code,capability) DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE OR REPLACE FUNCTION cutting_authorized_roles(actor_id uuid, requested_capability text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
  actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
  IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
  CASE requested_capability
    WHEN 'cutting:orders:view' THEN
      allowed_roles:=ARRAY['cutting_supervisor','cutting_worker','owner_group','production_management','pmc','order_merchandiser','warehouse_supervisor','finance_director','finance_read','factory_payables','embroidery_washing_payables','fabric_payables','wage_month_close_accountant']::text[];
    WHEN 'cutting:records:create' THEN
      allowed_roles:=ARRAY['cutting_supervisor','cutting_worker']::text[];
    ELSE
      RAISE EXCEPTION 'unknown cutting capability' USING ERRCODE='42501';
  END CASE;
  IF NOT actual_roles && allowed_roles THEN
    RAISE EXCEPTION 'cutting access denied' USING ERRCODE='42501';
  END IF;
  RETURN actual_roles;
END;
$function$;
