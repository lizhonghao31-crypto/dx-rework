-- Financial source checking grants order reads only; write whitelists are unchanged.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('wage_month_close_accountant','pattern_room:orders:view'),
 ('finance_director','pattern_room:orders:view'),('finance_read','pattern_room:orders:view');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE OR REPLACE FUNCTION pattern_room_authorized_order_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:orders:view' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser','pattern_room_supervisor','worker','owner_group','production_management','wage_month_close_accountant','finance_director','finance_read']::text[];
 WHEN 'pattern_room:orders:create' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:assign' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:complete' THEN allowed_roles:=ARRAY['worker']::text[];
 WHEN 'pattern_room:orders:handoff' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:edit' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:misc:create' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:misc:edit' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:misc:confirm' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:orders:hours' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:rework' THEN allowed_roles:=ARRAY['sample_designer','pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:transfer' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:cancel' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser','pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:cancel_fees' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 ELSE RAISE EXCEPTION 'unknown pattern order capability' USING ERRCODE='42501';
 END CASE;
 IF NOT actual_roles && allowed_roles THEN RAISE EXCEPTION 'pattern order access denied' USING ERRCODE='42501'; END IF;
 RETURN actual_roles;
END $$;
