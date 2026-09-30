-- Pattern room PR02: catalog and hourly prices have separate write authority.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO business_roles(role_code,display_name,description) VALUES
 ('pattern_room_supervisor','板房主管','板房派工与现场工时；无标准价修改权') ON CONFLICT DO NOTHING;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('pattern_room:prices:read','读取板房价格管控','读取标准价和历史'),
 ('pattern_room:prices:write','维护打板品类价','维护品类执行价和启停'),
 ('pattern_room:hourly:write','维护杂事小时价','独立小时价格维护'),
 ('pattern_room:catalog:read','选择打板品类','只读启用品类及选中价格'),
 ('pattern_room:misc:quote','读取本单杂事小时价','只读当前小时单价') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('owner_group','pattern_room:prices:read'),
 ('production_management','pattern_room:prices:read'),
 ('finance_director','pattern_room:prices:read'),
 ('pattern_room_supervisor','pattern_room:prices:read'),
 ('owner_group','pattern_room:prices:write'),
 ('production_management','pattern_room:prices:write'),
 ('owner_group','pattern_room:hourly:write'),
 ('owner_group','pattern_room:catalog:read'),
 ('production_management','pattern_room:catalog:read'),
 ('finance_director','pattern_room:catalog:read'),
 ('pattern_room_supervisor','pattern_room:catalog:read'),
 ('sample_designer','pattern_room:catalog:read'),
 ('owner_group','pattern_room:misc:quote'),
 ('production_management','pattern_room:misc:quote'),
 ('finance_director','pattern_room:misc:quote'),
 ('pattern_room_supervisor','pattern_room:misc:quote'),
 ('sample_designer','pattern_room:misc:quote'),
 ('order_merchandiser','pattern_room:misc:quote'),
 ('pattern_room_supervisor','tools:user') ON CONFLICT DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
-- No account is assigned or duplicated by this migration.
CREATE UNIQUE INDEX pattern_room_one_supervisor ON user_role_assignments(role_code)
 WHERE role_code='pattern_room_supervisor' AND revoked_at IS NULL;

CREATE FUNCTION pattern_room_authorized_price_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles := access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:prices:read' THEN allowed_roles:=ARRAY['owner_group','production_management','finance_director','pattern_room_supervisor']::text[];
 WHEN 'pattern_room:prices:write' THEN allowed_roles:=ARRAY['owner_group','production_management']::text[];
 WHEN 'pattern_room:hourly:write' THEN allowed_roles:=ARRAY['owner_group']::text[];
 WHEN 'pattern_room:catalog:read' THEN allowed_roles:=ARRAY['owner_group','production_management','finance_director','pattern_room_supervisor','sample_designer']::text[];
 WHEN 'pattern_room:misc:quote' THEN allowed_roles:=ARRAY['owner_group','production_management','finance_director','pattern_room_supervisor','sample_designer','order_merchandiser']::text[];
 ELSE RAISE EXCEPTION 'unknown pattern price capability' USING ERRCODE='42501';
 END CASE;
 IF NOT actual_roles && allowed_roles THEN RAISE EXCEPTION 'pattern price access denied' USING ERRCODE='42501'; END IF;
 RETURN actual_roles;
END $$;

CREATE TABLE pattern_room_prices (
 price_id uuid PRIMARY KEY, code text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('category','hourly')),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100), unit text NOT NULL CHECK(unit IN ('件','套','小时')),
 amount numeric(14,3) CHECK(amount>=0), enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), sort_order integer NOT NULL,
 updated_by uuid REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((kind='category' AND unit IN ('件','套') AND amount IS NOT NULL) OR (kind='hourly' AND unit='小时')),
 CHECK(kind<>'hourly' OR enabled)
);
CREATE UNIQUE INDEX pattern_room_one_hourly_price ON pattern_room_prices(kind) WHERE kind='hourly';
CREATE TABLE pattern_room_price_history (
 price_id uuid NOT NULL REFERENCES pattern_room_prices(price_id), version integer NOT NULL CHECK(version>0),
 old_amount numeric(14,3), amount numeric(14,3), old_enabled boolean, enabled boolean NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500), changed_by uuid REFERENCES app_users(id),
 changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(price_id,version), CHECK(amount IS NULL OR amount>=0)
);
CREATE TRIGGER pattern_room_prices_no_delete BEFORE DELETE ON pattern_room_prices
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER pattern_room_prices_no_truncate BEFORE TRUNCATE ON pattern_room_prices
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER pattern_room_price_history_no_update BEFORE UPDATE ON pattern_room_price_history
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER pattern_room_price_history_no_delete BEFORE DELETE ON pattern_room_price_history
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER pattern_room_price_history_no_truncate BEFORE TRUNCATE ON pattern_room_price_history
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

-- BEGIN REPEATABLE PRICE SEED: verified against the original 19-row price photograph.
INSERT INTO pattern_room_prices(price_id,code,kind,name,unit,amount,sort_order) VALUES
 ('92000000-0000-4000-8000-000000000001','CATEGORY_01','category','基础T恤/背心','件',15,1),
 ('92000000-0000-4000-8000-000000000002','CATEGORY_02','category','工艺车缝T恤','件',40,2),
 ('92000000-0000-4000-8000-000000000003','CATEGORY_03','category','短袖上衣','件',40,3),
 ('92000000-0000-4000-8000-000000000004','CATEGORY_04','category','POLO衫','件',40,4),
 ('92000000-0000-4000-8000-000000000005','CATEGORY_05','category','卫衣','件',40,5),
 ('92000000-0000-4000-8000-000000000006','CATEGORY_06','category','休闲衬衫','件',40,6),
 ('92000000-0000-4000-8000-000000000007','CATEGORY_07','category','单层马甲','件',40,7),
 ('92000000-0000-4000-8000-000000000008','CATEGORY_08','category','马甲（拉链/有里）','件',80,8),
 ('92000000-0000-4000-8000-000000000009','CATEGORY_09','category','裤子/裙子','件',60,9),
 ('92000000-0000-4000-8000-000000000010','CATEGORY_10','category','正装长袖衬衫','件',60,10),
 ('92000000-0000-4000-8000-000000000011','CATEGORY_11','category','外套（单层）','件',80,11),
 ('92000000-0000-4000-8000-000000000012','CATEGORY_12','category','外套（有里）','件',100,12),
 ('92000000-0000-4000-8000-000000000013','CATEGORY_13','category','连衣裙（半里）','件',60,13),
 ('92000000-0000-4000-8000-000000000014','CATEGORY_14','category','连衣裙（全里）','件',80,14),
 ('92000000-0000-4000-8000-000000000015','CATEGORY_15','category','女装套装两件套','套',100,15),
 ('92000000-0000-4000-8000-000000000016','CATEGORY_16','category','男装套装两件套','套',100,16),
 ('92000000-0000-4000-8000-000000000017','CATEGORY_17','category','裤子（全里）','件',80,17),
 ('92000000-0000-4000-8000-000000000018','CATEGORY_18','category','内单/定制裤子','件',80,18),
 ('92000000-0000-4000-8000-000000000019','CATEGORY_19','category','内单/定制裤子（全里）','件',100,19),
 ('92000000-0000-4000-8000-000000000100','MISC_HOUR','hourly','杂事小时单价','小时',NULL,100)
ON CONFLICT DO NOTHING;
INSERT INTO pattern_room_price_history(price_id,version,amount,enabled,reason)
 SELECT price_id,version,amount,enabled,'初始化执行价' FROM pattern_room_prices WHERE version=1
 ON CONFLICT DO NOTHING;
-- END REPEATABLE PRICE SEED
