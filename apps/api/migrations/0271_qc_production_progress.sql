-- The retired factory receipt/count is not an employee completion or a factory signature.
-- Keep original facts, deadlines and prior state; remove only the current requirement.
CREATE TABLE digital_factory_task_retirements(
 task_id uuid PRIMARY KEY REFERENCES digital_production_tasks(task_id),
 rule_version text NOT NULL CHECK(rule_version='20261101.factory-receipt-retired'),
 previous_state text NOT NULL,
 retired_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO digital_factory_task_retirements(task_id,rule_version,previous_state)
 SELECT task_id,'20261101.factory-receipt-retired',state
 FROM digital_production_tasks WHERE node_key='factory_material_count';
UPDATE digital_production_tasks SET state='cancelled',
 blocked_reason='节点已退役：不再要求工厂到料确认或到料清点，原记录保留',terminal_recorded_at=CURRENT_TIMESTAMP
 WHERE node_key='factory_material_count' AND state NOT IN ('completed','cancelled');
CREATE TRIGGER digital_factory_task_retirement_history BEFORE UPDATE OR DELETE ON digital_factory_task_retirements
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE FUNCTION reject_retired_factory_receipt_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.task_kind='factory_material_count' THEN
  RAISE EXCEPTION 'factory receipt/count requirement retired; original records are read-only' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER digital_factory_receipt_task_retired BEFORE INSERT OR UPDATE ON digital_production_task_access
 FOR EACH ROW EXECUTE FUNCTION reject_retired_factory_receipt_task();
CREATE FUNCTION reject_retired_factory_receipt_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IN ('工厂到料','到料清点') THEN
  RAISE EXCEPTION 'factory receipt/count recording retired; warehouse dispatch is not factory receipt' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER digital_factory_receipt_fact_retired BEFORE INSERT ON digital_factory_facts
 FOR EACH ROW EXECUTE FUNCTION reject_retired_factory_receipt_fact();

-- Separate from production-reporting: no production completion, shipment or warehouse authority.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO capability_catalog(capability,display_name,description)
 VALUES('qc-production-progress','QC生产进度记录','在当前QC任务和工厂PO范围内记录现场进度、适用新增成品量及照片');
INSERT INTO role_capabilities(role_code,capability) VALUES('quality_control','qc-production-progress');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

CREATE TABLE digital_qc_tracking_starts(
 tracking_id uuid PRIMARY KEY,production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 native_production_id uuid NOT NULL REFERENCES sourcing_production_orders(production_order_id),
 factory_decision_id uuid REFERENCES sourcing_decisions(sourcing_decision_id),
 factory_key text GENERATED ALWAYS AS(COALESCE(factory_decision_id::text,'original')) STORED,
 started_at timestamptz NOT NULL,basis text NOT NULL CHECK(basis IN ('warehouse_dispatch','explicit_supervision','first_progress')),
 warehouse_fact_id uuid REFERENCES digital_factory_facts(fact_id),
 created_by uuid NOT NULL REFERENCES app_users(id),recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text NOT NULL,UNIQUE(native_production_id,factory_key),
 CHECK((basis='warehouse_dispatch')=(warehouse_fact_id IS NOT NULL))
);
CREATE TABLE digital_qc_progress_records(
 record_id uuid PRIMARY KEY,tracking_id uuid NOT NULL REFERENCES digital_qc_tracking_starts(tracking_id),
 revision integer NOT NULL CHECK(revision>0),related_progress_id uuid REFERENCES digital_qc_progress_records(record_id),kind text NOT NULL CHECK(kind IN ('progress','photos')),
 collected_at timestamptz,recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 actor_id uuid NOT NULL REFERENCES app_users(id),actor_name text NOT NULL,
 scope_revision text NOT NULL CHECK(scope_revision~'^[0-9a-f]{64}$'),
 observations jsonb NOT NULL CHECK(jsonb_typeof(observations)='array'),
 critical_events text[] NOT NULL DEFAULT '{}',attachment_ids uuid[] NOT NULL DEFAULT '{}',report_ids uuid[] NOT NULL DEFAULT '{}',
 note text NOT NULL DEFAULT '',UNIQUE(tracking_id,revision),
 CHECK((kind='progress' AND related_progress_id IS NULL AND collected_at IS NOT NULL AND jsonb_array_length(observations)>0)
  OR (kind='photos' AND related_progress_id IS NOT NULL AND collected_at IS NULL AND observations='[]'::jsonb AND cardinality(attachment_ids)>0 AND cardinality(report_ids)=0 AND cardinality(critical_events)=0)),
 CHECK(cardinality(critical_events)=0 OR cardinality(attachment_ids)>0)
);
CREATE INDEX digital_qc_progress_observation ON digital_qc_progress_records(tracking_id,collected_at DESC,revision DESC) WHERE kind='progress';
CREATE TABLE digital_qc_supervision_settings(
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),version integer NOT NULL CHECK(version>0),
 quality_lead_id uuid REFERENCES app_users(id),changed_by uuid NOT NULL REFERENCES app_users(id),
 changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,audit_id uuid NOT NULL REFERENCES audit_events(id),
 PRIMARY KEY(production_order_id,version)
);
CREATE TRIGGER digital_qc_tracking_history BEFORE UPDATE OR DELETE ON digital_qc_tracking_starts FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_qc_progress_history BEFORE UPDATE OR DELETE ON digital_qc_progress_records FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_qc_supervision_history BEFORE UPDATE OR DELETE ON digital_qc_supervision_settings FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE FUNCTION digital_qc_report_allowed(person uuid,native_order uuid,factory uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM digital_production_child_links link
  JOIN digital_production_orders mother USING(production_order_id)
  JOIN digital_production_task_access task USING(production_order_id)
  JOIN digital_production_tasks state USING(task_id)
  JOIN sourcing_production_factory_orders execution ON execution.production_order_id=link.child_id AND execution.factory_decision_id IS NOT DISTINCT FROM factory
  JOIN app_users u ON u.id=task.assignee_id
  JOIN user_role_assignments assignment ON assignment.user_id=u.id AND assignment.role_code='quality_control' AND assignment.revoked_at IS NULL
  JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled
  JOIN role_capabilities cap ON cap.role_code=role.role_code AND cap.capability='qc-production-progress'
  WHERE link.module='production' AND link.child_id=native_order AND task.task_kind='factory_production_qc' AND task.required_role='quality_control'
   AND state.state<>'cancelled' AND task.assignee_id=person AND u.enabled AND NOT u.manual_access_disabled
   AND EXISTS(SELECT 1 FROM identity_mappings identity WHERE identity.user_id=person AND identity.active AND identity.employed)
   AND member_module_can_write(person,'sourcing')
   AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle lifecycle WHERE
    (lifecycle.resource_kind='order' AND lifecycle.resource_id=mother.production_order_id OR lifecycle.resource_kind='source' AND lifecycle.resource_id=mother.source_id) AND lifecycle.state<>'active')
   AND NOT EXISTS(SELECT 1 FROM digital_order_closures closure WHERE closure.production_order_id=mother.production_order_id)
 );
$$;
CREATE FUNCTION digital_qc_order_report_allowed(person uuid,native_order uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM sourcing_production_factory_orders execution WHERE execution.production_order_id=native_order
  AND digital_qc_report_allowed(person,native_order,execution.factory_decision_id));
$$;

CREATE TABLE digital_qc_progress_uploads(
 attachment_id uuid PRIMARY KEY REFERENCES attachments(attachment_id),production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 factory_decision_id uuid REFERENCES sourcing_decisions(sourcing_decision_id),scope_revision text NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_qc_progress_upload_history BEFORE UPDATE OR DELETE ON digital_qc_progress_uploads FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE FUNCTION guard_digital_qc_progress_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tracking digital_qc_tracking_starts%ROWTYPE; item jsonb; allocated record;
BEGIN
 SELECT * INTO STRICT tracking FROM digital_qc_tracking_starts WHERE tracking_id=NEW.tracking_id;
 IF NOT access_is_root_actor(NEW.actor_id) AND NOT digital_qc_report_allowed(NEW.actor_id,tracking.native_production_id,tracking.factory_decision_id)
 THEN RAISE EXCEPTION 'QC progress requires current assigned QC scope' USING ERRCODE='55000'; END IF;
 IF NEW.actor_name IS DISTINCT FROM (SELECT display_name FROM app_users WHERE id=NEW.actor_id)
 OR NEW.revision<>COALESCE((SELECT max(revision) FROM digital_qc_progress_records WHERE tracking_id=NEW.tracking_id),0)+1
 OR cardinality(NEW.attachment_ids)<> (SELECT count(DISTINCT attachment_id) FROM unnest(NEW.attachment_ids) attachment_id)
 OR cardinality(NEW.attachment_ids)<>(SELECT count(*) FROM attachments image JOIN digital_qc_progress_uploads claim USING(attachment_id) WHERE attachment_id=ANY(NEW.attachment_ids)
    AND claim.production_order_id=tracking.production_order_id AND claim.factory_decision_id IS NOT DISTINCT FROM tracking.factory_decision_id AND claim.actor_id=NEW.actor_id
    AND uploaded_by=NEW.actor_id AND status='ready' AND entity_type IS NULL AND entity_id IS NULL
    AND mime_type IN ('image/jpeg','image/png','image/webp'))
 THEN RAISE EXCEPTION 'QC progress revision, actor or attachments invalid' USING ERRCODE='55000'; END IF;
 IF NEW.kind='photos' AND NOT EXISTS(SELECT 1 FROM digital_qc_progress_records original WHERE original.record_id=NEW.related_progress_id AND original.tracking_id=NEW.tracking_id AND original.kind='progress')
 THEN RAISE EXCEPTION 'photo supplement requires its original QC progress' USING ERRCODE='55000'; END IF;
 IF cardinality(NEW.report_ids)>0
  AND NOT EXISTS(SELECT 1 FROM effective_sourcing_production_reports report WHERE report.production_order_id=tracking.native_production_id AND report.factory_decision_id IS NOT DISTINCT FROM tracking.factory_decision_id AND quantity>0)
  AND NOT EXISTS(SELECT 1 FROM digital_qc_progress_records prior JOIN attachments photo ON photo.attachment_id=ANY(prior.attachment_ids) AND photo.status='ready' WHERE prior.tracking_id=NEW.tracking_id AND prior.critical_events @> ARRAY['first_piece']::text[])
  AND (NOT NEW.critical_events @> ARRAY['first_piece']::text[] OR cardinality(NEW.attachment_ids)=0)
 THEN RAISE EXCEPTION 'first finished production requires its first-piece photo' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(NEW.observations)<>(SELECT count(DISTINCT observation->>'lineId') FROM jsonb_array_elements(NEW.observations) observation)
 THEN RAISE EXCEPTION 'duplicate QC progress lines' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.observations) LOOP
  SELECT line.position,line.quantity INTO allocated
   FROM sourcing_production_factory_orders execution
   CROSS JOIN LATERAL sourcing_factory_execution_lines(execution.production_order_id,execution.sourcing_decision_id) line
   JOIN digital_production_child_lines mapping ON mapping.module='production' AND mapping.child_id=execution.production_order_id AND mapping.child_line_key=line.position::text
   WHERE execution.production_order_id=tracking.native_production_id AND execution.factory_decision_id IS NOT DISTINCT FROM tracking.factory_decision_id
    AND mapping.production_order_id=tracking.production_order_id AND mapping.line_id=(item->>'lineId')::uuid;
  IF allocated.position IS NULL OR allocated.quantity<=0 OR allocated.quantity IS DISTINCT FROM (item->>'allocationQuantity')::integer
   OR allocated.position IS DISTINCT FROM (item->>'position')::integer
  THEN RAISE EXCEPTION 'QC progress outside current allocated PO scope' USING ERRCODE='55000'; END IF;
 END LOOP;
 RETURN NEW;
END; $$;
CREATE TRIGGER digital_qc_progress_guard BEFORE INSERT ON digital_qc_progress_records FOR EACH ROW EXECUTE FUNCTION guard_digital_qc_progress_record();

-- Keep the original quantity/date/state/correction guards; only the exact QC new-report path is added.
CREATE OR REPLACE FUNCTION guard_sourcing_production_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior sourcing_production_reports%ROWTYPE; current_status text; finished_on date; total bigint; limit_quantity integer;
 audit operation_events%ROWTYPE; is_root boolean;
BEGIN
 -- Use the same case, user, production lock order as factory approvals and API writes.
 PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=(SELECT sourcing_case_id FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id) FOR UPDATE;
 PERFORM 1 FROM app_users WHERE id=NEW.actor_id FOR SHARE;
 PERFORM 1 FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
 is_root := COALESCE(audit.actor_roles @> ARRAY['root_superuser']::text[],false);
 SELECT status,business_date INTO current_status,finished_on FROM sourcing_production_transitions
 WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.business_date>sourcing_production_business_date(NEW.production_order_id,NEW.operation_event_id)
 OR NOT EXISTS(SELECT 1 FROM sourcing_production_transitions dispatch WHERE dispatch.production_order_id=NEW.production_order_id
   AND dispatch.factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id AND dispatch.sequence=1 AND dispatch.business_date<=NEW.business_date)
 OR audit.after_state->>'factoryDecisionId' IS DISTINCT FROM NEW.factory_decision_id::text
 OR audit.actor_id IS DISTINCT FROM NEW.actor_id OR audit.entity_id IS DISTINCT FROM NEW.report_id::text
 OR audit.entity_type IS DISTINCT FROM 'sourcing_production_report'
 OR audit.after_state->>'productionOrderId' IS DISTINCT FROM NEW.production_order_id::text
 OR audit.after_state->>'rootReportId' IS DISTINCT FROM NEW.root_report_id::text
 OR (audit.after_state->>'revision')::integer IS DISTINCT FROM NEW.revision
 OR (audit.after_state->>'position')::integer IS DISTINCT FROM NEW.position
 OR (audit.after_state->>'businessDate')::date IS DISTINCT FROM NEW.business_date
 OR (audit.after_state->>'quantity')::integer IS DISTINCT FROM NEW.quantity
 OR NEW.actor_name IS DISTINCT FROM (SELECT display_name FROM app_users WHERE id=NEW.actor_id)
 OR (NEW.revision=1 AND (audit.action IS DISTINCT FROM 'sourcing.production.report' OR current_status<>'in_production'))
 OR (NEW.revision>1 AND (NOT is_root OR audit.action IS DISTINCT FROM 'sourcing.production.correct' OR audit.reason IS DISTINCT FROM NEW.reason))
 OR (NOT is_root AND NOT (
  (audit.authorization_capability='production-reporting' AND audit.actor_roles @> ARRAY['production_reporter']::text[]
   AND sourcing_production_factory_reporter_allowed(NEW.actor_id,NEW.production_order_id,NEW.factory_decision_id))
  OR (NEW.revision=1 AND audit.authorization_capability='qc-production-progress' AND audit.actor_roles @> ARRAY['quality_control']::text[]
   AND digital_qc_report_allowed(NEW.actor_id,NEW.production_order_id,NEW.factory_decision_id)
   AND EXISTS(SELECT 1 FROM digital_qc_progress_records progress JOIN digital_qc_tracking_starts tracking USING(tracking_id)
    WHERE progress.record_id::text=audit.after_state->>'qcProgressRecordId' AND progress.actor_id=NEW.actor_id
     AND progress.kind='progress' AND NEW.report_id=ANY(progress.report_ids)
     AND tracking.native_production_id=NEW.production_order_id AND tracking.factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id))
 ))
 THEN RAISE EXCEPTION 'invalid production report authorization or date/state' USING ERRCODE='55000'; END IF;
 IF NEW.revision>1 THEN
   SELECT * INTO prior FROM effective_sourcing_production_reports WHERE root_report_id=NEW.root_report_id;
   IF prior.report_id IS NULL OR prior.revision+1<>NEW.revision OR prior.production_order_id<>NEW.production_order_id
     OR prior.factory_decision_id IS DISTINCT FROM NEW.factory_decision_id OR prior.position<>NEW.position OR (current_status<>'in_production' AND NEW.business_date>
       (SELECT business_date FROM sourcing_production_transitions WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id AND status='production_completed'))
   THEN RAISE EXCEPTION 'correction must reference latest original report within completion date' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT COALESCE(sum(quantity),0) INTO total FROM effective_sourcing_production_reports
 WHERE production_order_id=NEW.production_order_id AND position=NEW.position AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id;
 SELECT line.quantity INTO limit_quantity FROM sourcing_production_orders production
 CROSS JOIN LATERAL sourcing_factory_execution_lines(production.production_order_id,COALESCE(NEW.factory_decision_id,production.sourcing_decision_id)) line
 WHERE production.production_order_id=NEW.production_order_id AND line.position=NEW.position;
 IF limit_quantity IS NULL THEN RAISE EXCEPTION 'unknown factory execution line' USING ERRCODE='23514'; END IF;
 IF total-COALESCE(prior.quantity,0)+NEW.quantity>limit_quantity THEN
   RAISE EXCEPTION 'reported quantity exceeds approved line quantity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
