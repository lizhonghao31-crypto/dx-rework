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
 reason text, input_snapshot jsonb NOT NULL, calculation_total numeric(18,2) NOT NULL CHECK(calculation_total>=0),
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL,
 UNIQUE(rework_order_id,determination_version), UNIQUE(replaces_determination_id),
 CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500)
);
CREATE TABLE rework_responsibility_processes (
 determination_id uuid NOT NULL REFERENCES rework_responsibility_determinations, configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items,
 process_name_snapshot text NOT NULL, pricing_unit_snapshot text NOT NULL CHECK(pricing_unit_snapshot IN ('piece','hour')),
 multiplier numeric(8,3) NOT NULL CHECK(multiplier>=1), high_multiplier_reason text, base_amount numeric(18,8) NOT NULL CHECK(base_amount>=0),
 responsibility_amount numeric(18,2) NOT NULL CHECK(responsibility_amount>=0), operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL,
 PRIMARY KEY(determination_id,configuration_item_id), CHECK(multiplier<=2 OR length(btrim(high_multiplier_reason))>0)
);
CREATE TABLE rework_responsibility_allocations (
 determination_id uuid NOT NULL, configuration_item_id uuid NOT NULL, responsibility_type text NOT NULL CHECK(responsibility_type IN ('own_factory','processing_factory','embroidery_factory','washing_factory','fabric_supplier')),
 share_bps integer NOT NULL CHECK(share_bps BETWEEN 1 AND 10000), rounded_amount numeric(18,2) NOT NULL CHECK(rounded_amount>=0),
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL,
 PRIMARY KEY(determination_id,configuration_item_id,responsibility_type), FOREIGN KEY(determination_id,configuration_item_id) REFERENCES rework_responsibility_processes
);
CREATE TABLE rework_responsibility_amount_lines (
 determination_id uuid NOT NULL, configuration_item_id uuid NOT NULL, work_report_id uuid NOT NULL REFERENCES rework_work_reports,
 person_id uuid NOT NULL REFERENCES business_people, responsibility_type text NOT NULL CHECK(responsibility_type IN ('own_factory','processing_factory','embroidery_factory','washing_factory','fabric_supplier')),
 base_member_share_amount numeric(18,8) NOT NULL, multiplier numeric(8,3) NOT NULL, share_bps integer NOT NULL,
 unrounded_amount numeric(30,12) NOT NULL, rounded_amount numeric(18,2) NOT NULL, rounding_rule text NOT NULL CHECK(rounding_rule='half_up_2'),
 worker_display_name_snapshot text NOT NULL, task_mode_snapshot text NOT NULL CHECK(task_mode_snapshot IN ('individual','collective')),
 member_snapshot jsonb NOT NULL, report_snapshot jsonb NOT NULL, operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL,
 PRIMARY KEY(determination_id,configuration_item_id,work_report_id,person_id,responsibility_type),
 FOREIGN KEY(determination_id,configuration_item_id,responsibility_type) REFERENCES rework_responsibility_allocations
);
CREATE TABLE rework_responsibility_high_multiplier_confirmations (
 confirmation_id uuid PRIMARY KEY, determination_id uuid NOT NULL UNIQUE REFERENCES rework_responsibility_determinations,
 confirmed_by uuid NOT NULL REFERENCES app_users, confirmed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500), confirmation_snapshot jsonb NOT NULL,
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL
);
CREATE TABLE rework_responsibility_handler_events (
 handler_event_id uuid PRIMARY KEY, rework_order_id uuid NOT NULL REFERENCES rework_orders, determination_id uuid REFERENCES rework_responsibility_determinations,
 event_type text NOT NULL CHECK(event_type IN ('assigned','transferred','taken_over')), from_user_id uuid REFERENCES app_users,
 to_user_id uuid NOT NULL REFERENCES app_users, acted_by uuid NOT NULL REFERENCES app_users, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_id text NOT NULL
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
