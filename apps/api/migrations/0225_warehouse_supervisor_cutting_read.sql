-- Warehouse supervisor inherits only the warehouse receiver's current grants.
-- No employee assignments, historical grants or business facts are changed.
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO business_roles(role_code,display_name,description) VALUES
 ('warehouse_supervisor','仓库主管','继承仓管人员现有业务操作，增加订单开裁及详情只读')
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability)
 SELECT 'warehouse_supervisor',capability FROM role_capabilities WHERE role_code='warehouse_receiver'
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES('warehouse_supervisor','cutting:orders:view')
ON CONFLICT DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_insert;

CREATE OR REPLACE FUNCTION receiving_authorized_board_operator(actor_id uuid,requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; required_role text;
BEGIN
 actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 required_role:=CASE requested_capability WHEN 'receiving:resolve_difference' THEN 'order_merchandiser'
   WHEN 'receiving:packing_manage' THEN 'warehouse_receiver' ELSE NULL END;
 IF required_role IS NULL OR NOT (required_role=ANY(actual_roles) OR required_role='warehouse_receiver' AND 'warehouse_supervisor'=ANY(actual_roles)) THEN
   RAISE EXCEPTION 'receiving board operation forbidden' USING ERRCODE='42501';
 END IF;
 RETURN actual_roles;
END $$;


CREATE OR REPLACE FUNCTION cutting_authorized_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
  actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
  IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
  CASE requested_capability
    WHEN 'cutting:orders:view' THEN
      allowed_roles:=ARRAY['cutting_supervisor','cutting_worker','owner_group','production_management','order_merchandiser','warehouse_supervisor']::text[];
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
$$;

