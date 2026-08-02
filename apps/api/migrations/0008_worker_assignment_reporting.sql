ALTER TABLE rework_orders DROP CONSTRAINT rework_orders_status_check;
ALTER TABLE rework_orders ADD CONSTRAINT rework_orders_status_check CHECK (status IN (
  'draft','pending_process_configuration','pending_ie_review','pending_task_assignment',
  'in_progress','pending_order_review','cancelled'
));

CREATE TABLE rework_work_tasks (
  work_task_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  task_version integer NOT NULL CHECK (task_version>0),
  assignment_mode text NOT NULL CHECK (assignment_mode IN ('individual','collective')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  source_system text NOT NULL DEFAULT 'manual' CHECK (length(btrim(source_system)) BETWEEN 1 AND 100),
  external_id text,
  external_idempotency_key text,
  erp_node_id text,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at timestamptz,
  UNIQUE(rework_order_id,configuration_item_id,task_version),
  CHECK ((status='active' AND superseded_at IS NULL) OR (status='superseded' AND superseded_at IS NOT NULL)),
  CHECK (external_id IS NULL OR length(btrim(external_id)) BETWEEN 1 AND 200),
  CHECK (external_idempotency_key IS NULL OR length(btrim(external_idempotency_key)) BETWEEN 1 AND 200),
  CHECK (erp_node_id IS NULL OR length(btrim(erp_node_id)) BETWEEN 1 AND 200),
  CHECK (source_system='manual' OR external_id IS NOT NULL)
);
CREATE UNIQUE INDEX rework_work_tasks_one_active_collective_idx ON rework_work_tasks(rework_order_id,configuration_item_id) WHERE status='active' AND assignment_mode='collective';
CREATE UNIQUE INDEX rework_work_tasks_external_source_idx ON rework_work_tasks(source_system,external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX rework_work_tasks_external_idempotency_idx ON rework_work_tasks(source_system,external_idempotency_key) WHERE external_idempotency_key IS NOT NULL;
CREATE TABLE rework_work_task_members (
  work_task_id uuid NOT NULL REFERENCES rework_work_tasks(work_task_id),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  display_name_snapshot text NOT NULL CHECK (length(btrim(display_name_snapshot)) BETWEEN 1 AND 100),
  person_type_snapshot text NOT NULL CHECK (person_type_snapshot IN ('internal','temporary')),
  PRIMARY KEY(work_task_id,person_id)
);
CREATE TABLE rework_work_reports (
  work_report_id uuid PRIMARY KEY,
  work_task_id uuid NOT NULL REFERENCES rework_work_tasks(work_task_id),
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  actual_quantity numeric(14,2) NOT NULL CHECK (actual_quantity>0),
  completed_at timestamptz NOT NULL,
  remark text CHECK (remark IS NULL OR length(btrim(remark)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'submitted' CHECK (status='submitted'),
  group_amount numeric(18,8) NOT NULL CHECK (group_amount>0),
  source_system text NOT NULL DEFAULT 'manual' CHECK (length(btrim(source_system)) BETWEEN 1 AND 100),
  external_id text,
  external_idempotency_key text,
  erp_node_id text,
  submitted_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (external_id IS NULL OR length(btrim(external_id)) BETWEEN 1 AND 200),
  CHECK (external_idempotency_key IS NULL OR length(btrim(external_idempotency_key)) BETWEEN 1 AND 200),
  CHECK (erp_node_id IS NULL OR length(btrim(erp_node_id)) BETWEEN 1 AND 200),
  CHECK (source_system='manual' OR external_id IS NOT NULL)
);
CREATE INDEX rework_work_reports_item_idx ON rework_work_reports(rework_order_id,configuration_item_id,status);
CREATE UNIQUE INDEX rework_work_reports_external_source_idx ON rework_work_reports(source_system,external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX rework_work_reports_external_idempotency_idx ON rework_work_reports(source_system,external_idempotency_key) WHERE external_idempotency_key IS NOT NULL;
CREATE TABLE rework_work_report_member_shares (
  work_report_id uuid NOT NULL REFERENCES rework_work_reports(work_report_id),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  amount numeric(18,8) NOT NULL CHECK (amount>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_report_id,person_id)
);

-- Capability grants are deliberately append-only in the base schema. This reviewed
-- forward migration temporarily replaces only those two guard triggers so its new
-- capabilities remain explicit and the original protection is restored immediately.
DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('work:assign','分配返工任务','创建工人个人或集体计件任务'),
  ('work:report','工人上数','提交本人个人或集体计件上数'),
  ('work:report_for_worker','代录工人上数','为临时工或授权对象提交上数')
ON CONFLICT (capability) DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('tail_supervisor','work:assign'),('tail_supervisor','work:report_for_worker'),('worker','work:report')
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_work_task_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM operation_events e WHERE e.event_id=current_setting('dx_rework.work_event_id',true)::uuid
    AND e.request_id=current_setting('dx_rework.work_request_id',true) AND e.action='rework.work_task.assign'
    AND e.authorization_capability='work:assign' AND e.entity_type='rework_order' AND e.entity_id=NEW.rework_order_id::text) THEN
    RAISE EXCEPTION 'work task requires authorized audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rework_work_tasks_guard_insert BEFORE INSERT ON rework_work_tasks FOR EACH ROW EXECUTE FUNCTION guard_rework_work_task_insert();
CREATE OR REPLACE FUNCTION guard_rework_work_task_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_task_id IS DISTINCT FROM OLD.work_task_id OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.configuration_item_id IS DISTINCT FROM OLD.configuration_item_id OR NEW.task_version IS DISTINCT FROM OLD.task_version
     OR NEW.assignment_mode IS DISTINCT FROM OLD.assignment_mode OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status<>'active' OR NEW.status<>'superseded'
     OR NEW.superseded_at IS NULL OR NOT EXISTS (SELECT 1 FROM operation_events e
       WHERE e.event_id=current_setting('dx_rework.work_event_id',true)::uuid AND e.request_id=current_setting('dx_rework.work_request_id',true)
       AND e.action='rework.work_task.assign' AND e.authorization_capability='work:assign' AND e.entity_type='rework_order' AND e.entity_id=OLD.rework_order_id::text)
  THEN RAISE EXCEPTION 'work task versions may only be superseded through assignment' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rework_work_tasks_guard_update BEFORE UPDATE ON rework_work_tasks FOR EACH ROW EXECUTE FUNCTION guard_rework_work_task_update();
CREATE TRIGGER rework_work_tasks_no_delete BEFORE DELETE ON rework_work_tasks FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE OR REPLACE FUNCTION guard_rework_work_task_member_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rework_work_tasks task JOIN operation_events e ON e.entity_id=task.rework_order_id::text
    WHERE task.work_task_id=NEW.work_task_id AND e.event_id=current_setting('dx_rework.work_event_id',true)::uuid
    AND e.request_id=current_setting('dx_rework.work_request_id',true) AND e.action='rework.work_task.assign'
    AND e.authorization_capability='work:assign') THEN
    RAISE EXCEPTION 'work task member requires authorized audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rework_work_task_members_guard_insert BEFORE INSERT ON rework_work_task_members FOR EACH ROW EXECUTE FUNCTION guard_rework_work_task_member_insert();
CREATE TRIGGER rework_work_task_members_no_update BEFORE UPDATE ON rework_work_task_members FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_work_task_members_no_delete BEFORE DELETE ON rework_work_task_members FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE OR REPLACE FUNCTION guard_rework_work_report_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM operation_events e WHERE e.event_id=current_setting('dx_rework.work_event_id',true)::uuid
    AND e.request_id=current_setting('dx_rework.work_request_id',true) AND e.action='rework.work_report.submit'
    AND e.authorization_capability IN ('work:report','work:report_for_worker') AND e.entity_type='rework_order' AND e.entity_id=NEW.rework_order_id::text) THEN
    RAISE EXCEPTION 'work report requires authorized audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rework_work_reports_guard_insert BEFORE INSERT ON rework_work_reports FOR EACH ROW EXECUTE FUNCTION guard_rework_work_report_insert();
CREATE TRIGGER rework_work_reports_no_update BEFORE UPDATE ON rework_work_reports FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_work_reports_no_delete BEFORE DELETE ON rework_work_reports FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE OR REPLACE FUNCTION guard_rework_work_report_share_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rework_work_reports report JOIN operation_events e ON e.entity_id=report.rework_order_id::text
    WHERE report.work_report_id=NEW.work_report_id AND e.event_id=current_setting('dx_rework.work_event_id',true)::uuid
    AND e.request_id=current_setting('dx_rework.work_request_id',true) AND e.action='rework.work_report.submit'
    AND e.authorization_capability IN ('work:report','work:report_for_worker')) THEN
    RAISE EXCEPTION 'work report share requires authorized audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rework_work_report_member_shares_guard_insert BEFORE INSERT ON rework_work_report_member_shares FOR EACH ROW EXECUTE FUNCTION guard_rework_work_report_share_insert();
CREATE TRIGGER rework_work_report_member_shares_no_update BEFORE UPDATE ON rework_work_report_member_shares FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_work_report_member_shares_no_delete BEFORE DELETE ON rework_work_report_member_shares FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

-- Collective tasks may contain up to forty people. Eight decimals preserve every
-- positive share for the smallest allowed hourly report (0.01 × 0.001 ÷ 40).

CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  expected_action text;
  expected_capability text;
  audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN RAISE EXCEPTION 'rework order write requires trusted audit context' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' OR NEW.version<>1 OR NEW.rework_no IS NOT NULL OR NEW.submitted_at IS NOT NULL
       OR NEW.created_by<>NEW.updated_by OR NEW.source_system<>'manual' OR NEW.external_id IS NOT NULL
       OR NEW.external_idempotency_key IS NOT NULL OR NEW.erp_node_id IS NOT NULL
    THEN RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft' USING ERRCODE='23514'; END IF;
    expected_action := 'rework.draft.create'; expected_capability := 'rework:initiate'; audit_actor_id := NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.source_system IS DISTINCT FROM OLD.source_system
       OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key
       OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id OR NEW.version<>OLD.version+1
    THEN RAISE EXCEPTION 'stable rework order identity and origin fields are immutable' USING ERRCODE='55000'; END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN RAISE EXCEPTION 'allocated rework number is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN RAISE EXCEPTION 'first submission timestamp is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.status='draft' AND NEW.status='draft' THEN expected_action := 'rework.draft.update'; expected_capability := 'rework:initiate';
    ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action := 'rework.submit'; expected_capability := 'rework:initiate';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN expected_action := 'rework.withdraw'; expected_capability := 'rework:initiate';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='pending_ie_review' THEN expected_action := 'rework.process_configuration.submit'; expected_capability := 'process:configure';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='pending_process_configuration' THEN expected_action := 'rework.process_configuration.save'; expected_capability := 'process:configure';
    ELSIF OLD.status='pending_ie_review' AND NEW.status='pending_process_configuration' THEN expected_action := 'rework.process_configuration.review'; expected_capability := 'process:review';
    ELSIF OLD.status='pending_ie_review' AND NEW.status='pending_task_assignment' THEN expected_action := 'rework.process_configuration.review'; expected_capability := 'process:review';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='pending_ie_review' THEN expected_action := 'rework.process_configuration.submit'; expected_capability := 'process:configure';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='pending_task_assignment' THEN expected_action := 'rework.process_configuration.save'; expected_capability := 'process:configure';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='in_progress' THEN expected_action := 'rework.work_task.assign'; expected_capability := 'work:assign';
    ELSIF OLD.status='in_progress' AND NEW.status='pending_order_review' THEN expected_action := 'rework.work_report.submit'; expected_capability := 'work:report';
    ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action := 'rework.cancel'; expected_capability := 'rework:initiate';
    ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %', OLD.status, NEW.status USING ERRCODE='23514'; END IF;
    audit_actor_id := NEW.updated_by;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id
      AND event.action=expected_action AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text
      AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker')))
      AND event.after_state @> jsonb_build_object(
        'reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,
        'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,
        'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,
        'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version
      )
      AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id))
  ) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
