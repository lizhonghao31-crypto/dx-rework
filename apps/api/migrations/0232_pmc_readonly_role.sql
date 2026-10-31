-- PMC is an independent read-only role. No employee assignments or business facts change.
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_insert;
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO business_roles(role_code,display_name,description) VALUES ('pmc','PMC','生产管理读取范围；无业务操作权限');
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('tools:read','读取公共附件和已有导出','沿用原附件归属与导出数据范围，不含上传'),
 ('supplier_onboarding:read','查看供应商申请','读取审批资料与历史，不含审批'),
 ('todo:routing_exception_read','查看本人路由异常','沿用本人范围，不含转派');
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('pmc','cutting:orders:view'),
 ('pmc','dashboard:management:read'),
 ('pmc','external_responsibility:view'),
 ('pmc','own_factory:view'),
 ('pmc','pattern_room:catalog:read'),
 ('pmc','pattern_room:misc:quote'),
 ('pmc','pattern_room:orders:view'),
 ('pmc','pattern_room:prices:read'),
 ('pmc','people:read'),
 ('pmc','process_catalog:read'),
 ('pmc','receiving:export'),
 ('pmc','report:export'),
 ('pmc','report:view'),
 ('pmc','sourcing:view'),
 ('pmc','supplier_catalog:read'),
 ('pmc','supplier_contract_data:read'),
 ('pmc','supplier_profile:read'),
 ('pmc','todo:view'),
 ('pmc','wage:export'),
 ('pmc','wage:view'),
 ('pmc','tools:read'),
 ('pmc','supplier_onboarding:read'),
 ('pmc','todo:routing_exception_read');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_insert;

CREATE OR REPLACE FUNCTION access_authorized_actor_roles(requested_actor_id uuid, required_capability text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  actor_roles text[];
  capability_allowed boolean;
BEGIN
  SELECT array_agg(DISTINCT ura.role_code ORDER BY ura.role_code)
  INTO actor_roles
  FROM user_role_assignments ura
  JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
  JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
  WHERE ura.user_id=requested_actor_id AND ura.revoked_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM identity_mappings i
      JOIN access_security_policy policy
        ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
      WHERE i.user_id=ura.user_id AND i.provider='dingtalk'
        AND i.active=true AND i.employed=true
    );

  IF access_is_root_actor(requested_actor_id) THEN
    SELECT array_agg(role_code ORDER BY role_code)
    INTO actor_roles
    FROM unnest(array_append(COALESCE(actor_roles,'{}'::text[]),'root_superuser'))
      AS snapshot(role_code);
    RETURN actor_roles;
  END IF;

  -- Delegations cannot turn a sole PMC identity into a business writer.
  -- Root and the existing union of multiple actual roles retain their authority.
  IF actor_roles=ARRAY['pmc']::text[] AND NOT required_capability=ANY(ARRAY['cutting:orders:view','dashboard:management:read','external_responsibility:view','own_factory:view','pattern_room:catalog:read','pattern_room:misc:quote','pattern_room:orders:view','pattern_room:prices:read','people:read','process_catalog:read','receiving:export','report:export','report:view','sourcing:view','supplier_catalog:read','supplier_contract_data:read','supplier_profile:read','todo:view','wage:export','wage:view','tools:read','supplier_onboarding:read','todo:routing_exception_read']::text[]) THEN
    RAISE EXCEPTION 'PMC is business read-only' USING ERRCODE='42501';
  END IF;

  SELECT
    EXISTS (
      SELECT 1
      FROM user_role_assignments ura
      JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
      JOIN role_capabilities rc ON rc.role_code=ura.role_code
      WHERE ura.user_id=requested_actor_id AND ura.revoked_at IS NULL
        AND rc.capability=required_capability
    )
    OR EXISTS (
      SELECT 1
      FROM delegated_authorizations da
      WHERE da.grantee_user_id=requested_actor_id
        AND da.capability=required_capability
        AND da.scope_type='global' AND da.scope_id IS NULL
        AND da.revoked_at IS NULL
        AND da.valid_from <= CURRENT_TIMESTAMP
        AND da.valid_until > CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1
          FROM app_users grantor
          JOIN identity_mappings i ON i.user_id=grantor.id
          JOIN access_security_policy policy
            ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
          WHERE grantor.id=da.grantor_user_id AND grantor.enabled=true
            AND i.provider='dingtalk' AND i.active=true AND i.employed=true
        )
        AND EXISTS (
          SELECT 1
          FROM user_role_assignments grantor_role
          JOIN business_roles grantor_business_role
            ON grantor_business_role.role_code=grantor_role.role_code
            AND grantor_business_role.enabled=true
          JOIN role_capabilities grantor_capability
            ON grantor_capability.role_code=grantor_role.role_code
          WHERE grantor_role.user_id=da.grantor_user_id
            AND grantor_role.revoked_at IS NULL
            AND grantor_capability.capability=da.capability
        )
    )
  INTO capability_allowed;

  IF actor_roles IS NULL OR capability_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'actor is not authorized for capability %', required_capability
      USING ERRCODE = '42501';
  END IF;
  RETURN actor_roles;
END;
$function$;

CREATE OR REPLACE FUNCTION pattern_room_authorized_order_roles(actor_id uuid, requested_capability text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:orders:delete' THEN allowed_roles:=ARRAY['root_superuser']::text[];
 WHEN 'pattern_room:orders:view' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser','pattern_room_supervisor','pattern_room_worker','owner_group','production_management','pmc','wage_month_close_accountant','finance_director','finance_read']::text[];
 WHEN 'pattern_room:orders:create' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:assign' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:complete' THEN allowed_roles:=ARRAY['pattern_room_worker']::text[];
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
END $function$;

CREATE OR REPLACE FUNCTION pattern_room_authorized_price_roles(actor_id uuid, requested_capability text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles := access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:prices:read' THEN allowed_roles:=ARRAY['owner_group','production_management','pmc','finance_director','finance_read','pattern_room_supervisor']::text[];
 WHEN 'pattern_room:prices:write' THEN allowed_roles:=ARRAY['owner_group','production_management']::text[];
 WHEN 'pattern_room:hourly:write' THEN allowed_roles:=ARRAY['owner_group']::text[];
 WHEN 'pattern_room:catalog:read' THEN allowed_roles:=ARRAY['owner_group','production_management','pmc','finance_director','finance_read','pattern_room_supervisor','sample_designer']::text[];
 WHEN 'pattern_room:misc:quote' THEN allowed_roles:=ARRAY['owner_group','production_management','pmc','finance_director','finance_read','pattern_room_supervisor','sample_designer','order_merchandiser']::text[];
 ELSE RAISE EXCEPTION 'unknown pattern price capability' USING ERRCODE='42501';
 END CASE;
 IF NOT actual_roles && allowed_roles THEN RAISE EXCEPTION 'pattern price access denied' USING ERRCODE='42501'; END IF;
 RETURN actual_roles;
END $function$;

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
      allowed_roles:=ARRAY['cutting_supervisor','cutting_worker','owner_group','production_management','pmc','order_merchandiser','warehouse_supervisor']::text[];
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

CREATE OR REPLACE FUNCTION finance_authorized_wage_roles(actor_id uuid, requested_capability text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE actual_roles text[];
BEGIN
  actual_roles := access_authorized_actor_roles(actor_id, requested_capability);
  IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
  IF requested_capability NOT IN ('wage:view','wage:export','wage:settlement_mark')
     OR NOT actual_roles && ARRAY['owner_group','production_management','pmc','finance_director','wage_month_close_accountant','finance_read']::text[]
     OR (requested_capability='wage:settlement_mark' AND NOT actual_roles && ARRAY['finance_director','wage_month_close_accountant','finance_read']::text[]) THEN
    RAISE EXCEPTION 'finance wage access denied' USING ERRCODE='42501';
  END IF;
  RETURN actual_roles;
END;
$function$;

CREATE OR REPLACE FUNCTION external_responsibility_can_view_all(candidate uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT external_responsibility_direct_role(
    candidate,'external_responsibility:view',
    ARRAY['production_management','pmc','owner_group','tail_supervisor','finance_read','finance_director']
  )
$function$;

CREATE OR REPLACE FUNCTION own_factory_approval_can_view(candidate uuid, order_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT responsibility_actor_has_direct_role(candidate,'own_factory:view',ARRAY['pmc'])
  OR own_factory_approval_can_decide(candidate, order_id)
  OR responsibility_actor_has_direct_role(
    candidate,
    'responsibility:determine',
    ARRAY['production_management', 'owner_group']
  )
$function$;

CREATE OR REPLACE FUNCTION supplier_onboarding_authorized_roles(actor_id uuid, mode text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE roles text[];
BEGIN
 IF mode NOT IN ('request','approve','read') THEN RAISE EXCEPTION 'unknown supplier application authority' USING ERRCODE='42501'; END IF;
 roles := access_authorized_actor_roles(actor_id,'supplier_onboarding:'||mode);
 IF mode='read' THEN
  IF NOT (roles && ARRAY['root_superuser','pmc']) THEN RAISE EXCEPTION 'supplier read requires PMC' USING ERRCODE='42501'; END IF;
 ELSIF mode='request' THEN
  IF roles && ARRAY['root_superuser','owner_group','production_management'] OR NOT (roles && ARRAY['order_merchandiser','embroidery_washing_merchandiser']) THEN
   RAISE EXCEPTION 'use direct maintenance or an authorized applicant role' USING ERRCODE='42501';
  END IF;
 ELSIF NOT (roles && ARRAY['root_superuser','owner_group','production_management']) THEN
  RAISE EXCEPTION 'supplier approval requires owner or production' USING ERRCODE='42501';
 END IF;
 RETURN roles;
END; $function$;

CREATE FUNCTION guard_pmc_attachment_upload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE roles text[];
BEGIN
  IF access_is_root_actor(NEW.uploaded_by) THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT a.role_code ORDER BY a.role_code) INTO roles
  FROM user_role_assignments a JOIN business_roles r USING(role_code)
  WHERE a.user_id=NEW.uploaded_by AND a.revoked_at IS NULL AND r.enabled;
  IF roles=ARRAY['pmc']::text[] AND NOT COALESCE((NEW.entity_type='export_job' AND NEW.status='ready'
    AND EXISTS(SELECT 1 FROM export_jobs j WHERE j.export_job_id::text=NEW.entity_id
      AND j.requested_by=NEW.uploaded_by AND j.status='running')),false) THEN
    RAISE EXCEPTION 'PMC cannot upload or finalize attachments' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_pmc_readonly_guard BEFORE INSERT OR UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION guard_pmc_attachment_upload();
