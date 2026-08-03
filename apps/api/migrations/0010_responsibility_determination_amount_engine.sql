ALTER TABLE rework_orders DROP CONSTRAINT rework_orders_status_check;
ALTER TABLE rework_orders ADD CONSTRAINT rework_orders_status_check CHECK (status IN (
  'draft','pending_process_configuration','pending_ie_review','pending_task_assignment','in_progress',
  'pending_order_review','pending_quantity_adjustment_ie_review','pending_responsibility_determination',
  'pending_responsibility_action','cancelled'
));

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('responsibility:determine','判定返工责任','保存及正式判定整单责任'),
 ('responsibility:takeover','接管责任判定','老板接管责任处理'),
 ('responsibility:confirm_high_multiplier','确认高倍率','独立确认超过二倍的责任倍率') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('production_management','responsibility:determine'),('owner_group','responsibility:determine'),
 ('owner_group','responsibility:takeover'),('owner_group','responsibility:confirm_high_multiplier') ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE rework_responsibility_determinations (
 determination_id uuid PRIMARY KEY, rework_order_id uuid NOT NULL REFERENCES rework_orders,
 determination_version integer NOT NULL CHECK(determination_version>0), replaces_determination_id uuid REFERENCES rework_responsibility_determinations,
 source_order_review_id uuid NOT NULL REFERENCES rework_order_reviews, stage text NOT NULL CHECK(stage IN ('draft','finalized')),
 handler_user_id uuid NOT NULL REFERENCES app_users, created_by uuid NOT NULL REFERENCES app_users, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text, source_high_multiplier_confirmation_id uuid, input_snapshot jsonb NOT NULL, calculation_total numeric(18,2) NOT NULL CHECK(calculation_total>=0),
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 UNIQUE(rework_order_id,determination_version), UNIQUE(replaces_determination_id),
 CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500)
);
CREATE TABLE rework_responsibility_processes (
 determination_id uuid NOT NULL REFERENCES rework_responsibility_determinations, configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items,
 process_name_snapshot text NOT NULL, pricing_unit_snapshot text NOT NULL CHECK(pricing_unit_snapshot IN ('piece','hour')),
 multiplier numeric(8,3) NOT NULL CHECK(multiplier>=1), high_multiplier_reason text, base_amount numeric(18,8) NOT NULL CHECK(base_amount>=0),
 responsibility_amount numeric(18,2) NOT NULL CHECK(responsibility_amount>=0), operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 PRIMARY KEY(determination_id,configuration_item_id), CHECK(multiplier<=2 OR length(btrim(high_multiplier_reason))>0)
);
CREATE TABLE rework_responsibility_allocations (
 determination_id uuid NOT NULL, configuration_item_id uuid NOT NULL, responsibility_type text NOT NULL CHECK(responsibility_type IN ('own_factory','processing_factory','embroidery_factory','washing_factory','fabric_supplier')),
 share_bps integer NOT NULL CHECK(share_bps BETWEEN 1 AND 10000), rounded_amount numeric(18,2) NOT NULL CHECK(rounded_amount>=0),
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 PRIMARY KEY(determination_id,configuration_item_id,responsibility_type), FOREIGN KEY(determination_id,configuration_item_id) REFERENCES rework_responsibility_processes
);
CREATE TABLE rework_responsibility_amount_lines (
 determination_id uuid NOT NULL, configuration_item_id uuid NOT NULL, work_report_id uuid NOT NULL REFERENCES rework_work_reports,
 person_id uuid NOT NULL REFERENCES business_people, responsibility_type text NOT NULL CHECK(responsibility_type IN ('own_factory','processing_factory','embroidery_factory','washing_factory','fabric_supplier')),
 base_member_share_amount numeric(18,8) NOT NULL, multiplier numeric(8,3) NOT NULL, share_bps integer NOT NULL,
 unrounded_amount numeric(30,15) NOT NULL, rounded_amount numeric(18,2) NOT NULL, rounding_rule text NOT NULL CHECK(rounding_rule='half_up_2'),
 worker_display_name_snapshot text NOT NULL, task_mode_snapshot text NOT NULL CHECK(task_mode_snapshot IN ('individual','collective')),
 member_snapshot jsonb NOT NULL, report_snapshot jsonb NOT NULL, operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 PRIMARY KEY(determination_id,configuration_item_id,work_report_id,person_id,responsibility_type),
 FOREIGN KEY(determination_id,configuration_item_id,responsibility_type) REFERENCES rework_responsibility_allocations
);
CREATE TABLE rework_responsibility_high_multiplier_confirmations (
 confirmation_id uuid PRIMARY KEY, determination_id uuid NOT NULL UNIQUE REFERENCES rework_responsibility_determinations,
 confirmed_by uuid NOT NULL REFERENCES app_users, confirmed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500), confirmation_snapshot jsonb NOT NULL,
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);
ALTER TABLE rework_responsibility_determinations ADD CONSTRAINT responsibility_source_confirmation_fk FOREIGN KEY(source_high_multiplier_confirmation_id) REFERENCES rework_responsibility_high_multiplier_confirmations(confirmation_id);

CREATE TABLE rework_responsibility_handler_events (
 handler_event_id uuid PRIMARY KEY, rework_order_id uuid NOT NULL REFERENCES rework_orders, determination_id uuid REFERENCES rework_responsibility_determinations,
 event_type text NOT NULL CHECK(event_type IN ('assigned','transferred','taken_over')), from_user_id uuid REFERENCES app_users,
 to_user_id uuid NOT NULL REFERENCES app_users, acted_by uuid NOT NULL REFERENCES app_users, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);

CREATE FUNCTION require_responsibility_event(event_id uuid, req text, order_id uuid, persisted_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e operation_events%ROWTYPE;
BEGIN
 SELECT * INTO e FROM operation_events WHERE operation_events.event_id=$1 AND request_id=req;
 IF e.event_id IS NULL OR e.actor_id<>persisted_actor OR e.entity_type<>'rework_order' OR e.entity_id<>order_id::text
    OR e.authorization_capability NOT IN ('responsibility:determine','responsibility:takeover','responsibility:confirm_high_multiplier')
 THEN RAISE EXCEPTION 'responsibility write requires matching operation event actor' USING ERRCODE='55000'; END IF;
END $$;
CREATE FUNCTION guard_responsibility_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_id uuid; persisted_actor uuid;
BEGIN
 IF TG_TABLE_NAME='rework_responsibility_determinations' THEN order_id:=NEW.rework_order_id; persisted_actor:=NEW.created_by;
 ELSIF TG_TABLE_NAME='rework_responsibility_handler_events' THEN order_id:=NEW.rework_order_id; persisted_actor:=NEW.acted_by;
 ELSE SELECT rework_order_id INTO order_id FROM rework_responsibility_determinations WHERE determination_id=NEW.determination_id;
   IF TG_TABLE_NAME='rework_responsibility_high_multiplier_confirmations' THEN persisted_actor:=NEW.confirmed_by; ELSE SELECT actor_id INTO persisted_actor FROM operation_events WHERE event_id=NEW.operation_event_id; END IF;
 END IF;
 PERFORM require_responsibility_event(NEW.operation_event_id,NEW.request_id,order_id,persisted_actor); RETURN NEW;
END $$;
CREATE FUNCTION guard_determination_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('responsibility:'||NEW.rework_order_id::text));
 IF NOT EXISTS(SELECT 1 FROM rework_order_reviews r WHERE r.order_review_id=NEW.source_order_review_id AND r.rework_order_id=NEW.rework_order_id)
 THEN RAISE EXCEPTION 'source review must belong to order' USING ERRCODE='23514'; END IF;
 IF NEW.replaces_determination_id IS NULL AND NEW.determination_version<>1 OR NEW.replaces_determination_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM rework_responsibility_determinations d WHERE d.determination_id=NEW.replaces_determination_id AND d.rework_order_id=NEW.rework_order_id AND d.determination_version+1=NEW.determination_version)
 THEN RAISE EXCEPTION 'invalid determination version chain' USING ERRCODE='23514'; END IF;
 IF NEW.stage='draft' AND EXISTS(SELECT 1 FROM rework_responsibility_determinations d WHERE d.rework_order_id=NEW.rework_order_id AND d.stage='draft' AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations n WHERE n.replaces_determination_id=d.determination_id) AND d.determination_id IS DISTINCT FROM NEW.replaces_determination_id)
 THEN RAISE EXCEPTION 'order already has a current draft' USING ERRCODE='23505'; END IF;
 PERFORM require_responsibility_event(NEW.operation_event_id,NEW.request_id,NEW.rework_order_id,NEW.created_by); RETURN NEW;
END $$;
CREATE FUNCTION guard_responsibility_process() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations d JOIN rework_process_configurations c ON c.rework_order_id=d.rework_order_id AND c.status='approved' JOIN rework_process_configuration_items i ON i.configuration_id=c.configuration_id WHERE d.determination_id=NEW.determination_id AND i.configuration_item_id=NEW.configuration_item_id)
 THEN RAISE EXCEPTION 'process is not in approved configuration' USING ERRCODE='23514'; END IF; PERFORM require_responsibility_event(NEW.operation_event_id,NEW.request_id,(SELECT rework_order_id FROM rework_responsibility_determinations WHERE determination_id=NEW.determination_id),(SELECT actor_id FROM operation_events WHERE event_id=NEW.operation_event_id)); RETURN NEW; END $$;
CREATE FUNCTION guard_responsibility_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rework_work_reports r JOIN rework_work_report_member_shares s ON s.work_report_id=r.work_report_id AND s.person_id=NEW.person_id JOIN rework_responsibility_determinations d ON d.determination_id=NEW.determination_id LEFT JOIN rework_work_report_rejections x ON x.work_report_id=r.work_report_id WHERE r.work_report_id=NEW.work_report_id AND r.status='submitted' AND x.work_report_id IS NULL AND r.rework_order_id=d.rework_order_id AND r.configuration_item_id=NEW.configuration_item_id AND s.amount=NEW.base_member_share_amount)
 THEN RAISE EXCEPTION 'amount line does not match submitted member share snapshot' USING ERRCODE='23514'; END IF; PERFORM require_responsibility_event(NEW.operation_event_id,NEW.request_id,(SELECT rework_order_id FROM rework_responsibility_determinations WHERE determination_id=NEW.determination_id),(SELECT actor_id FROM operation_events WHERE event_id=NEW.operation_event_id)); RETURN NEW; END $$;
CREATE FUNCTION reject_responsibility_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'responsibility history is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER determination_insert BEFORE INSERT ON rework_responsibility_determinations FOR EACH ROW EXECUTE FUNCTION guard_determination_insert();
CREATE TRIGGER process_insert BEFORE INSERT ON rework_responsibility_processes FOR EACH ROW EXECUTE FUNCTION guard_responsibility_process();
CREATE TRIGGER line_insert BEFORE INSERT ON rework_responsibility_amount_lines FOR EACH ROW EXECUTE FUNCTION guard_responsibility_line();
CREATE TRIGGER allocation_insert BEFORE INSERT ON rework_responsibility_allocations FOR EACH ROW EXECUTE FUNCTION guard_responsibility_insert();
CREATE TRIGGER confirmation_insert BEFORE INSERT ON rework_responsibility_high_multiplier_confirmations FOR EACH ROW EXECUTE FUNCTION guard_responsibility_insert();
CREATE TRIGGER handler_insert BEFORE INSERT ON rework_responsibility_handler_events FOR EACH ROW EXECUTE FUNCTION guard_responsibility_insert();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['rework_responsibility_determinations','rework_responsibility_processes','rework_responsibility_allocations','rework_responsibility_amount_lines','rework_responsibility_high_multiplier_confirmations','rework_responsibility_handler_events'] LOOP EXECUTE format('CREATE TRIGGER %I_no_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation()',t,t); EXECUTE format('CREATE TRIGGER %I_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation()',t,t); EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_mutation()',t,t); END LOOP; END $$;

-- PR-09 closure: trusted transaction context and exact event semantics.
CREATE OR REPLACE FUNCTION responsibility_expected_capability(action_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action_name
    WHEN 'rework.responsibility.draft' THEN 'responsibility:determine'
    WHEN 'rework.responsibility.reopen' THEN 'responsibility:determine'
    WHEN 'rework.responsibility.finalize' THEN 'responsibility:determine'
    WHEN 'rework.responsibility.transfer' THEN 'responsibility:determine'
    WHEN 'rework.responsibility.takeover' THEN 'responsibility:takeover'
    WHEN 'rework.responsibility.high_multiplier.confirm' THEN 'responsibility:confirm_high_multiplier'
  END
$$;

CREATE OR REPLACE FUNCTION responsibility_actor_is_active(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_users u JOIN identity_mappings m ON m.user_id=u.id
    WHERE u.id=candidate AND u.enabled AND m.provider='dingtalk' AND m.active AND m.employed
      AND EXISTS (SELECT 1 FROM access_security_policy policy WHERE policy.policy_key='primary' AND policy.dingtalk_corp_id=m.corp_id)
  )
$$;

CREATE OR REPLACE FUNCTION responsibility_actor_has_direct_role(candidate uuid, required_capability text, allowed_roles text[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT responsibility_actor_is_active(candidate) AND EXISTS (
    SELECT 1 FROM user_role_assignments a
    JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
    JOIN role_capabilities rc ON rc.role_code=a.role_code AND rc.capability=required_capability
    WHERE a.user_id=candidate AND a.role_code=ANY(allowed_roles) AND a.revoked_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION responsibility_can_determine(candidate uuid, order_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT responsibility_actor_has_direct_role(candidate,'responsibility:determine',ARRAY['production_management','owner_group'])
  OR (responsibility_actor_is_active(candidate) AND EXISTS (
    SELECT 1 FROM delegated_authorizations d
    WHERE d.grantee_user_id=candidate AND d.capability='responsibility:determine'
      AND d.scope_type='rework_order' AND d.scope_id=order_id::text
      AND d.revoked_at IS NULL AND CURRENT_TIMESTAMP BETWEEN d.valid_from AND d.valid_until
      AND responsibility_actor_has_direct_role(d.grantor_user_id,'responsibility:determine',ARRAY['production_management','owner_group'])
  ))
$$;

CREATE FUNCTION guard_responsibility_delegation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capability='responsibility:determine' AND (NEW.scope_type<>'rework_order' OR NEW.scope_id IS NULL) THEN
    RAISE EXCEPTION 'responsibility determine delegation requires rework_order scope' USING ERRCODE='23514';
  ELSIF NEW.capability IN ('responsibility:takeover','responsibility:confirm_high_multiplier') THEN
    RAISE EXCEPTION 'owner responsibility capabilities cannot be delegated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER responsibility_delegation_scope BEFORE INSERT ON delegated_authorizations
FOR EACH ROW EXECUTE FUNCTION guard_responsibility_delegation_scope();

CREATE OR REPLACE FUNCTION require_responsibility_event(event_id uuid, req text, order_id uuid, persisted_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e operation_events%ROWTYPE; context_event text; context_request text; expected text;
BEGIN
 context_event:=nullif(current_setting('dx_rework.responsibility_event_id',true),'');
 context_request:=nullif(current_setting('dx_rework.responsibility_request_id',true),'');
 IF context_event IS NULL OR context_request IS NULL OR context_event::uuid<>event_id OR context_request<>req
    OR req !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
   RAISE EXCEPTION 'responsibility write requires trusted transaction context' USING ERRCODE='55000';
 END IF;
 SELECT * INTO e FROM operation_events WHERE operation_events.event_id=$1 AND request_id=req;
 expected:=responsibility_expected_capability(e.action);
 IF e.event_id IS NULL OR expected IS NULL OR e.authorization_capability<>expected
    OR e.actor_id<>persisted_actor OR e.entity_type<>'rework_order' OR e.entity_id<>order_id::text THEN
   RAISE EXCEPTION 'responsibility operation event does not match write' USING ERRCODE='55000';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_responsibility_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_id uuid; persisted_actor uuid; parent_actor uuid; leaf_id uuid;
BEGIN
 IF TG_TABLE_NAME='rework_responsibility_determinations' THEN order_id:=NEW.rework_order_id; persisted_actor:=NEW.created_by;
 ELSIF TG_TABLE_NAME='rework_responsibility_handler_events' THEN
   order_id:=NEW.rework_order_id; persisted_actor:=NEW.acted_by;
   SELECT d.determination_id INTO leaf_id FROM rework_responsibility_determinations d WHERE d.rework_order_id=order_id
    AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations n WHERE n.replaces_determination_id=d.determination_id);
   IF NEW.determination_id IS NOT NULL AND NEW.determination_id IS DISTINCT FROM leaf_id THEN RAISE EXCEPTION 'handler event must reference current leaf' USING ERRCODE='23514'; END IF;
   IF NOT responsibility_can_determine(NEW.to_user_id,order_id) THEN RAISE EXCEPTION 'handler is not eligible' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='rework_responsibility_high_multiplier_confirmations' THEN
   SELECT rework_order_id INTO order_id FROM rework_responsibility_determinations WHERE determination_id=NEW.determination_id;
   persisted_actor:=NEW.confirmed_by;
 ELSE
   SELECT rework_order_id,created_by INTO order_id,parent_actor FROM rework_responsibility_determinations WHERE determination_id=NEW.determination_id;
   persisted_actor:=parent_actor;
 END IF;
 PERFORM require_responsibility_event(NEW.operation_event_id,NEW.request_id,order_id,persisted_actor);
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_responsibility_process() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_id uuid; parent_actor uuid;
BEGIN
 SELECT d.rework_order_id,d.created_by INTO order_id,parent_actor FROM rework_responsibility_determinations d WHERE d.determination_id=NEW.determination_id;
 IF NOT EXISTS(SELECT 1 FROM rework_process_configurations c JOIN rework_process_configuration_items i USING(configuration_id)
   WHERE c.rework_order_id=order_id AND c.status='approved' AND i.configuration_item_id=NEW.configuration_item_id
     AND i.process_name=NEW.process_name_snapshot AND i.pricing_unit=NEW.pricing_unit_snapshot)
 THEN RAISE EXCEPTION 'process snapshot is not approved' USING ERRCODE='23514'; END IF;
 PERFORM require_responsibility_event(NEW.operation_event_id,NEW.request_id,order_id,parent_actor); RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_responsibility_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_id uuid; parent_actor uuid;
BEGIN
 SELECT rework_order_id,created_by INTO order_id,parent_actor FROM rework_responsibility_determinations WHERE determination_id=NEW.determination_id;
 IF NOT EXISTS(SELECT 1 FROM rework_work_reports r JOIN rework_work_report_member_shares s ON s.work_report_id=r.work_report_id AND s.person_id=NEW.person_id
   LEFT JOIN rework_work_report_rejections x ON x.work_report_id=r.work_report_id
   WHERE r.work_report_id=NEW.work_report_id AND r.status='submitted' AND x.work_report_id IS NULL
     AND r.rework_order_id=order_id AND r.configuration_item_id=NEW.configuration_item_id AND s.amount=NEW.base_member_share_amount)
 THEN RAISE EXCEPTION 'amount line does not match submitted member share snapshot' USING ERRCODE='23514'; END IF;
 IF NEW.unrounded_amount<>round(NEW.base_member_share_amount*NEW.multiplier*NEW.share_bps/10000,15)
    OR NEW.rounded_amount<>round(NEW.unrounded_amount,2) OR NEW.rounded_amount<=0 THEN
   RAISE EXCEPTION 'amount line calculation is invalid' USING ERRCODE='23514'; END IF;
 PERFORM require_responsibility_event(NEW.operation_event_id,NEW.request_id,order_id,parent_actor); RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_responsibility_version(version_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d rework_responsibility_determinations%ROWTYPE; approved_count int; process_count int; high_count int; confirmation_record rework_responsibility_high_multiplier_confirmations%ROWTYPE;
BEGIN
 SELECT * INTO d FROM rework_responsibility_determinations WHERE determination_id=version_id;
 IF d.determination_id IS NULL THEN RETURN; END IF;
 SELECT count(*) INTO approved_count FROM rework_process_configurations c JOIN rework_process_configuration_items i USING(configuration_id) WHERE c.rework_order_id=d.rework_order_id AND c.status='approved';
 SELECT count(*) INTO process_count FROM rework_responsibility_processes WHERE determination_id=version_id;
 IF process_count<>approved_count THEN RAISE EXCEPTION 'responsibility processes must exactly cover approved configuration' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM rework_responsibility_processes p WHERE p.determination_id=version_id AND
   (NOT EXISTS(SELECT 1 FROM rework_responsibility_allocations a WHERE a.determination_id=p.determination_id AND a.configuration_item_id=p.configuration_item_id)
    OR (SELECT sum(a.share_bps) FROM rework_responsibility_allocations a WHERE a.determination_id=p.determination_id AND a.configuration_item_id=p.configuration_item_id)<>10000))
 THEN RAISE EXCEPTION 'responsibility allocations must total 10000 bps' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM rework_responsibility_allocations a WHERE a.determination_id=version_id AND a.rounded_amount<>(SELECT sum(l.rounded_amount) FROM rework_responsibility_amount_lines l WHERE l.determination_id=a.determination_id AND l.configuration_item_id=a.configuration_item_id AND l.responsibility_type=a.responsibility_type))
 THEN RAISE EXCEPTION 'allocation total differs from amount lines' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM rework_responsibility_processes p WHERE p.determination_id=version_id AND (p.responsibility_amount<>(SELECT sum(l.rounded_amount) FROM rework_responsibility_amount_lines l WHERE l.determination_id=p.determination_id AND l.configuration_item_id=p.configuration_item_id) OR p.base_amount<>(SELECT sum(DISTINCT s.amount) FROM rework_responsibility_amount_lines l JOIN rework_work_report_member_shares s ON s.work_report_id=l.work_report_id AND s.person_id=l.person_id WHERE l.determination_id=p.determination_id AND l.configuration_item_id=p.configuration_item_id)))
 THEN RAISE EXCEPTION 'process totals differ from source lines' USING ERRCODE='23514'; END IF;
 IF d.calculation_total<>(SELECT coalesce(sum(responsibility_amount),0) FROM rework_responsibility_processes WHERE determination_id=version_id) THEN RAISE EXCEPTION 'determination total differs from processes' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO high_count FROM rework_responsibility_processes WHERE determination_id=version_id AND multiplier>2;
 IF d.stage='finalized' AND ((high_count=0 AND d.source_high_multiplier_confirmation_id IS NOT NULL) OR (high_count>0 AND d.source_high_multiplier_confirmation_id IS NULL)) THEN RAISE EXCEPTION 'finalized high multiplier confirmation is invalid' USING ERRCODE='23514'; END IF;
 IF d.stage='finalized' AND d.replaces_determination_id IS NOT NULL AND EXISTS(
   (SELECT configuration_item_id,process_name_snapshot,pricing_unit_snapshot,multiplier,high_multiplier_reason,base_amount,responsibility_amount FROM rework_responsibility_processes WHERE determination_id=d.determination_id EXCEPT SELECT configuration_item_id,process_name_snapshot,pricing_unit_snapshot,multiplier,high_multiplier_reason,base_amount,responsibility_amount FROM rework_responsibility_processes WHERE determination_id=d.replaces_determination_id)
   UNION ALL
   (SELECT configuration_item_id,process_name_snapshot,pricing_unit_snapshot,multiplier,high_multiplier_reason,base_amount,responsibility_amount FROM rework_responsibility_processes WHERE determination_id=d.replaces_determination_id EXCEPT SELECT configuration_item_id,process_name_snapshot,pricing_unit_snapshot,multiplier,high_multiplier_reason,base_amount,responsibility_amount FROM rework_responsibility_processes WHERE determination_id=d.determination_id))
 THEN RAISE EXCEPTION 'finalized version must copy draft processes' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION run_responsibility_version_validation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM validate_responsibility_version(CASE WHEN TG_OP='DELETE' THEN OLD.determination_id ELSE NEW.determination_id END); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER determination_complete AFTER INSERT ON rework_responsibility_determinations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION run_responsibility_version_validation();
CREATE CONSTRAINT TRIGGER process_complete AFTER INSERT ON rework_responsibility_processes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION run_responsibility_version_validation();
CREATE CONSTRAINT TRIGGER allocation_complete AFTER INSERT ON rework_responsibility_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION run_responsibility_version_validation();
CREATE CONSTRAINT TRIGGER amount_line_complete AFTER INSERT ON rework_responsibility_amount_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION run_responsibility_version_validation();


-- S1 extends the complete 0009 order guard without weakening existing transitions.
CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  expected_action text;
  expected_capability text;
  alternative_action text := NULL;
  alternative_capability text := NULL;
  alternative_action_two text := NULL;
  alternative_capability_two text := NULL;
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
    ELSIF OLD.status='in_progress' AND NEW.status='in_progress' THEN expected_action := 'rework.quantity.decrease'; expected_capability := 'quantity:adjust';
    ELSIF OLD.status='in_progress' AND NEW.status='pending_order_review' THEN
      expected_action := 'rework.work_report.submit'; expected_capability := 'work:report';
      alternative_action := 'rework.quantity.decrease'; alternative_capability := 'quantity:adjust';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_order_review' THEN
      expected_action := 'rework.quantity.decrease'; expected_capability := 'quantity:adjust';
      alternative_action := 'rework.quantity.increase.request'; alternative_capability := 'quantity:adjust';
      alternative_action_two := 'rework.quantity.increase.confirm'; alternative_capability_two := 'quantity:confirm';
    ELSIF OLD.status='pending_order_review' AND NEW.status='in_progress' THEN
      expected_action := 'rework.work_report.reject'; expected_capability := 'submission:audit';
      alternative_action := 'rework.quantity.increase.confirm'; alternative_capability := 'quantity:confirm';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_quantity_adjustment_ie_review' THEN expected_action := 'rework.quantity.increase.confirm'; expected_capability := 'quantity:confirm';
    ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status='in_progress' THEN expected_action := 'rework.quantity.increase.ie_review'; expected_capability := 'process:review';
    ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status='pending_order_review' THEN expected_action := 'rework.quantity.increase.ie_review'; expected_capability := 'process:review';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_responsibility_determination' THEN expected_action := 'rework.whole_order.approve'; expected_capability := 'submission:audit';
    ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_determination' THEN expected_action := 'rework.responsibility.draft'; expected_capability := 'responsibility:determine';
    ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_action' THEN expected_action := 'rework.responsibility.finalize'; expected_capability := 'responsibility:determine';
    ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action := 'rework.cancel'; expected_capability := 'rework:initiate';
    ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %', OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    audit_actor_id := NEW.updated_by;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id
      AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text
      AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker'))))
        OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability)
        OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two))
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
