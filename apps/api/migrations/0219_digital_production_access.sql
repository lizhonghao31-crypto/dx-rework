-- Display-only rename: preserve role key, grants and all historical snapshots.
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_update;
UPDATE business_roles SET display_name='供应链总监',description=replace(description,'生产管理','供应链总监'),updated_at=CURRENT_TIMESTAMP WHERE role_code='production_management';
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_update;
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_update;
UPDATE capability_catalog SET display_name=replace(display_name,'生产管理','供应链总监'),description=replace(description,'生产管理','供应链总监')
 WHERE display_name LIKE '%生产管理%' OR description LIKE '%生产管理%';
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_update;
-- Missing execution roles only; no employee assignments or old-role capability changes.
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO business_roles(role_code,display_name,description) VALUES
 ('development_clerk','开发文员','数字生产核配、日常任务改派、交接及洗水登记；不授予预算、工资或大货QC权限'),
 ('pattern_room_tail_inspector','板房尾查','指定样板尾查任务；不授予大货QC或旧返工整查权限');
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('development_clerk','todo:view'),('development_clerk','tools:user'),
 ('pattern_room_tail_inspector','todo:view'),('pattern_room_tail_inspector','tools:user');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_insert;
ALTER TABLE digital_production_customers ADD COLUMN default_merchandiser_id uuid REFERENCES app_users(id);
-- Task identity/assignment anchor. P03 adds lifecycle facts to this exact identity.
CREATE TABLE digital_production_task_access (
 task_id uuid PRIMARY KEY,
 production_order_id uuid REFERENCES digital_production_orders(production_order_id),
 source_id uuid REFERENCES digital_production_sources(source_id),
 task_kind text NOT NULL,
 required_role text NOT NULL REFERENCES business_roles(role_code),
 assignee_id uuid REFERENCES app_users(id),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (num_nonnulls(production_order_id,source_id)=1)
);
CREATE INDEX digital_task_order_access_idx ON digital_production_task_access(production_order_id,assignee_id);
CREATE INDEX digital_task_source_access_idx ON digital_production_task_access(source_id,assignee_id);
CREATE FUNCTION digital_task_access_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'task identity is immutable' USING ERRCODE='55000'; END IF;
 IF ROW(NEW.task_id,NEW.production_order_id,NEW.source_id,NEW.task_kind,NEW.required_role,NEW.created_by,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.task_id,OLD.production_order_id,OLD.source_id,OLD.task_kind,OLD.required_role,OLD.created_by,OLD.created_at)
 THEN RAISE EXCEPTION 'task identity is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER digital_task_access_identity BEFORE UPDATE OR DELETE ON digital_production_task_access FOR EACH ROW EXECUTE FUNCTION digital_task_access_identity_guard();
CREATE TABLE digital_production_delegations (
 delegation_id uuid PRIMARY KEY,
 production_order_id uuid REFERENCES digital_production_orders(production_order_id),
 source_id uuid REFERENCES digital_production_sources(source_id),
 task_id uuid REFERENCES digital_production_task_access(task_id),
 delegate_id uuid NOT NULL REFERENCES app_users(id),
 purpose text NOT NULL CHECK(purpose IN ('technical','budget','execute')),
 granted_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
 revoked_at timestamptz, revoked_by uuid REFERENCES app_users(id),
 CHECK(num_nonnulls(production_order_id,source_id,task_id)=1),
 CHECK((task_id IS NOT NULL AND purpose<>'budget') OR (task_id IS NULL AND purpose<>'execute')),
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE INDEX digital_delegations_actor_idx ON digital_production_delegations(delegate_id,expires_at) WHERE revoked_at IS NULL;
CREATE FUNCTION digital_delegation_revoke_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'delegation history is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL
 OR (to_jsonb(NEW)-'revoked_at'-'revoked_by') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_by')
 THEN RAISE EXCEPTION 'delegations may only be revoked' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER digital_delegation_history BEFORE UPDATE OR DELETE ON digital_production_delegations FOR EACH ROW EXECUTE FUNCTION digital_delegation_revoke_only();
CREATE TABLE digital_production_delivery_requests (
 request_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 expected_version integer NOT NULL CHECK(expected_version>0),
 previous_date date, requested_date date NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 requested_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_production_delivery_decisions (
 request_id uuid PRIMARY KEY REFERENCES digital_production_delivery_requests(request_id),
 decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 decided_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_delivery_request_immutable BEFORE UPDATE OR DELETE ON digital_production_delivery_requests FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_delivery_decision_immutable BEFORE UPDATE OR DELETE ON digital_production_delivery_decisions FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
