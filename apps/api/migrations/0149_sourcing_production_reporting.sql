-- SSP-07: internal reporting only; no supplier accounts or finance prerequisite.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('production-reporting','驻厂生产填报','在明确负责范围内上报生产、完成和发货');
INSERT INTO business_roles(role_code,display_name,description) VALUES
 ('production_reporter','驻厂生产填报','维护被授权供应商或订单的生产事实，不含价格查看权');
INSERT INTO role_capabilities(role_code,capability) VALUES ('production_reporter','production-reporting');
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

CREATE TABLE sourcing_production_reporting_scopes (
 scope_event_id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES app_users(id),
 scope_type text NOT NULL CHECK(scope_type IN ('supplier','order')),
 scope_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 active boolean NOT NULL,
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id,scope_type,scope_id,version)
);
CREATE VIEW current_sourcing_production_reporting_scopes AS
 SELECT DISTINCT ON(user_id,scope_type,scope_id) * FROM sourcing_production_reporting_scopes
 ORDER BY user_id,scope_type,scope_id,version DESC;
CREATE FUNCTION sourcing_production_reporter_allowed(user_id_in uuid,order_id_in uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM current_sourcing_production_reporting_scopes scope
 JOIN sourcing_production_orders production ON production.production_order_id=order_id_in
 WHERE scope.user_id=user_id_in AND scope.active AND
 ((scope.scope_type='supplier' AND scope.scope_id=production.supplier_id) OR
  (scope.scope_type='order' AND scope.scope_id=production.production_order_id)))
$$;
CREATE FUNCTION guard_sourcing_reporting_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM app_users WHERE id=NEW.user_id FOR UPDATE;
 IF NEW.version<>(SELECT COALESCE(max(version),0)+1 FROM sourcing_production_reporting_scopes
    WHERE user_id=NEW.user_id AND scope_type=NEW.scope_type AND scope_id=NEW.scope_id)
 OR (NEW.scope_type='supplier' AND NOT EXISTS(SELECT 1 FROM supplier_catalog_items WHERE supplier_id=NEW.scope_id))
 OR (NEW.scope_type='order' AND NOT EXISTS(SELECT 1 FROM sourcing_production_orders WHERE production_order_id=NEW.scope_id))
 OR NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=NEW.operation_event_id
   AND event.actor_roles @> ARRAY['root_superuser']::text[] AND event.action='sourcing.production.scope'
   AND event.entity_id=NEW.scope_event_id::text AND event.after_state->>'userId'=NEW.user_id::text
   AND event.after_state->>'scopeType'=NEW.scope_type AND event.after_state->>'scopeId'=NEW.scope_id::text
   AND (event.after_state->>'active')::boolean=NEW.active)
 THEN RAISE EXCEPTION 'reporting scope requires ordered Root audit' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_reporting_scope_guard BEFORE INSERT ON sourcing_production_reporting_scopes
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_reporting_scope();

CREATE TABLE sourcing_production_reports (
 report_id uuid PRIMARY KEY,
 root_report_id uuid NOT NULL REFERENCES sourcing_production_reports(report_id) DEFERRABLE INITIALLY DEFERRED,
 revision integer NOT NULL CHECK(revision>0),
 production_order_id uuid NOT NULL REFERENCES sourcing_production_orders(production_order_id),
 position integer NOT NULL,
 business_date date NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 0 AND 10000000),
 actor_id uuid NOT NULL REFERENCES app_users(id),
 actor_name text NOT NULL,
 reason text,
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(production_order_id,position) REFERENCES sourcing_production_lines(production_order_id,position),
 UNIQUE(root_report_id,revision),
 CHECK((revision=1 AND root_report_id=report_id AND quantity>0 AND reason IS NULL)
   OR (revision>1 AND root_report_id<>report_id AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500))
);
CREATE INDEX sourcing_production_reports_order_idx ON sourcing_production_reports(production_order_id,root_report_id,revision DESC);
CREATE VIEW effective_sourcing_production_reports AS
 SELECT DISTINCT ON(root_report_id) * FROM sourcing_production_reports ORDER BY root_report_id,revision DESC;
CREATE FUNCTION guard_sourcing_production_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior sourcing_production_reports%ROWTYPE; current_status text; finished_on date; total bigint; limit_quantity integer;
 audit operation_events%ROWTYPE; is_root boolean;
BEGIN
 -- The service also holds the user lock, serializing scope revocation with writes.
 PERFORM 1 FROM app_users WHERE id=NEW.actor_id FOR SHARE;
 PERFORM 1 FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
 is_root := COALESCE(audit.actor_roles @> ARRAY['root_superuser']::text[],false);
 SELECT status,business_date INTO current_status,finished_on FROM sourcing_production_transitions
 WHERE production_order_id=NEW.production_order_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.business_date>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
 OR NOT EXISTS(SELECT 1 FROM sourcing_production_transitions dispatch WHERE dispatch.production_order_id=NEW.production_order_id
   AND dispatch.sequence=1 AND dispatch.business_date<=NEW.business_date)
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
 OR (NOT is_root AND (audit.authorization_capability IS DISTINCT FROM 'production-reporting'
   OR NOT (audit.actor_roles @> ARRAY['production_reporter']::text[])
   OR NOT sourcing_production_reporter_allowed(NEW.actor_id,NEW.production_order_id)))
 THEN RAISE EXCEPTION 'invalid production report authorization or date/state' USING ERRCODE='55000'; END IF;
 IF NEW.revision>1 THEN
   SELECT * INTO prior FROM effective_sourcing_production_reports WHERE root_report_id=NEW.root_report_id;
   IF prior.report_id IS NULL OR prior.revision+1<>NEW.revision OR prior.production_order_id<>NEW.production_order_id
     OR prior.position<>NEW.position OR (current_status<>'in_production' AND NEW.business_date>
       (SELECT business_date FROM sourcing_production_transitions WHERE production_order_id=NEW.production_order_id AND status='production_completed'))
   THEN RAISE EXCEPTION 'correction must reference latest original report within completion date' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT COALESCE(sum(quantity),0) INTO total FROM effective_sourcing_production_reports
 WHERE production_order_id=NEW.production_order_id AND position=NEW.position;
 SELECT quantity INTO limit_quantity FROM sourcing_production_lines WHERE production_order_id=NEW.production_order_id AND position=NEW.position;
 IF total-COALESCE(prior.quantity,0)+NEW.quantity>limit_quantity THEN
   RAISE EXCEPTION 'reported quantity exceeds approved line quantity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_production_report_guard BEFORE INSERT ON sourcing_production_reports
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_report();

CREATE TABLE sourcing_production_shipments (
 production_order_id uuid PRIMARY KEY REFERENCES sourcing_production_orders(production_order_id),
 first_style_no text NOT NULL,
 shipped_on date NOT NULL,
 recorded_quantity integer NOT NULL CHECK(recorded_quantity>=0),
 actor_id uuid NOT NULL REFERENCES app_users(id),
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION guard_sourcing_production_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit operation_events%ROWTYPE;
BEGIN
 IF NEW.sequence=1 THEN RETURN NEW; END IF;
 PERFORM 1 FROM app_users WHERE id=NEW.actor_id FOR SHARE;
 PERFORM 1 FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
 IF NEW.business_date>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
 OR (NEW.status='production_completed' AND NEW.business_date<(SELECT max(business_date) FROM effective_sourcing_production_reports
   WHERE production_order_id=NEW.production_order_id AND quantity>0))
 OR NOT (COALESCE(audit.actor_roles @> ARRAY['root_superuser']::text[],false) OR
  (audit.authorization_capability='production-reporting' AND audit.actor_roles @> ARRAY['production_reporter']::text[]
   AND sourcing_production_reporter_allowed(NEW.actor_id,NEW.production_order_id)))
 THEN RAISE EXCEPTION 'production execution requires reporter scope and valid business date' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_production_execution_guard BEFORE INSERT ON sourcing_production_transitions
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_execution();
CREATE FUNCTION guard_sourcing_production_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sourcing_production_orders production JOIN sourcing_production_transitions transition USING(production_order_id)
 WHERE production.production_order_id=NEW.production_order_id AND production.first_style_no=NEW.first_style_no
   AND transition.status='shipped' AND transition.business_date=NEW.shipped_on AND transition.actor_id=NEW.actor_id
   AND transition.operation_event_id=NEW.operation_event_id)
 OR NEW.recorded_quantity<>(SELECT COALESCE(sum(quantity),0) FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id)
 THEN RAISE EXCEPTION 'shipment must match production shipping transition' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_production_shipment_guard BEFORE INSERT ON sourcing_production_shipments
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_shipment();
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['sourcing_production_reporting_scopes','sourcing_production_reports','sourcing_production_shipments'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',table_name||'_immutable',table_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation()',table_name||'_no_truncate',table_name);
 END LOOP;
END; $$;
