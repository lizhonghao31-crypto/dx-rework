-- Misc tasks use the existing order/round/segment workflow and stored hourly quote.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('pattern_room:misc:create','创建板房杂事','设计师和跟单发起本人杂事'),
 ('pattern_room:misc:edit','维护杂事资料','发起人维护本人未完工杂事'),
 ('pattern_room:misc:confirm','确认杂事完成','发起人关闭杂事，不作为工资放行条件'),
 ('pattern_room:orders:hours','填写板房实际工时','板房主管以0.1小时核定实际劳动') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('order_merchandiser','pattern_room:orders:view'),
 ('sample_designer','pattern_room:misc:create'),('order_merchandiser','pattern_room:misc:create'),
 ('sample_designer','pattern_room:misc:edit'),('order_merchandiser','pattern_room:misc:edit'),
 ('sample_designer','pattern_room:misc:confirm'),('order_merchandiser','pattern_room:misc:confirm'),
 ('pattern_room_supervisor','pattern_room:orders:hours') ON CONFLICT DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

CREATE OR REPLACE FUNCTION pattern_room_authorized_order_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:orders:view' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser','pattern_room_supervisor','worker','owner_group','production_management']::text[];
 WHEN 'pattern_room:orders:create' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:assign' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:complete' THEN allowed_roles:=ARRAY['worker']::text[];
 WHEN 'pattern_room:orders:handoff' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:edit' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:misc:create' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:misc:edit' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:misc:confirm' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:orders:hours' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 ELSE RAISE EXCEPTION 'unknown pattern order capability' USING ERRCODE='42501';
 END CASE;
 IF NOT actual_roles && allowed_roles THEN RAISE EXCEPTION 'pattern order access denied' USING ERRCODE='42501'; END IF;
 RETURN actual_roles;
END $$;

ALTER TABLE pattern_room_orders ADD COLUMN task_name text;
ALTER TABLE pattern_room_orders ADD COLUMN creator_role text NOT NULL DEFAULT 'sample_designer'
 CHECK(creator_role IN ('sample_designer','order_merchandiser'));
ALTER TABLE pattern_room_orders DROP CONSTRAINT pattern_room_orders_kind_check;
ALTER TABLE pattern_room_orders DROP CONSTRAINT pattern_room_orders_style_no_check;
ALTER TABLE pattern_room_orders ADD CONSTRAINT pattern_room_orders_kind_check CHECK(kind IN ('pattern','misc'));
ALTER TABLE pattern_room_orders ADD CONSTRAINT pattern_room_order_materials_check CHECK(
 (kind='pattern' AND length(btrim(style_no)) BETWEEN 1 AND 100 AND task_name IS NULL AND creator_role='sample_designer')
 OR (kind='misc' AND length(style_no)<=100 AND task_name IS NOT NULL AND length(btrim(task_name)) BETWEEN 1 AND 200));

ALTER TABLE pattern_room_rounds DROP CONSTRAINT pattern_room_rounds_unit_check;
ALTER TABLE pattern_room_rounds ALTER COLUMN quantity DROP NOT NULL;
ALTER TABLE pattern_room_rounds ALTER COLUMN agreed_amount DROP NOT NULL;
-- Preserve exact intermediate products, matching the existing wage engine's eight-place source precision.
-- A three-place hourly price times a tenth-hour can have four places. Do not silently round it to three.
-- Final wage allocation remains the existing round(group,2)/largest-remainder rule, integrated in PR06.
ALTER TABLE pattern_room_rounds ALTER COLUMN agreed_amount TYPE numeric(26,8);
ALTER TABLE pattern_room_segments ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE pattern_room_segments ALTER COLUMN amount TYPE numeric(26,8);
ALTER TABLE pattern_room_rounds ADD COLUMN actual_hours numeric CHECK(actual_hours>0 AND actual_hours<=999999.9 AND actual_hours=trunc(actual_hours,1));
ALTER TABLE pattern_room_rounds ADD COLUMN hours_confirmed_by uuid REFERENCES app_users(id);
ALTER TABLE pattern_room_rounds ADD COLUMN hours_confirmed_at timestamptz;
ALTER TABLE pattern_room_segments ADD COLUMN actual_hours numeric CHECK(actual_hours>=0 AND actual_hours<=999999.9 AND actual_hours=trunc(actual_hours,1));
ALTER TABLE pattern_room_rounds ADD CONSTRAINT pattern_room_round_pricing_basis_check CHECK(
 (unit IN ('件','套') AND quantity IS NOT NULL AND agreed_amount IS NOT NULL AND actual_hours IS NULL)
 OR (unit='小时' AND quantity IS NULL));
ALTER TABLE pattern_room_rounds ADD CONSTRAINT pattern_room_hours_confirmation_check CHECK(
 (actual_hours IS NULL AND hours_confirmed_by IS NULL AND hours_confirmed_at IS NULL)
 OR (actual_hours IS NOT NULL AND hours_confirmed_by IS NOT NULL AND hours_confirmed_at IS NOT NULL));
