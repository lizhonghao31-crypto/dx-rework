-- Additive planning/approval evidence. Never rewrite customer promises, native facts or old SLA snapshots.
CREATE TABLE digital_series_profiles (
 config_key text NOT NULL, customer_code text REFERENCES digital_production_customers(code), version integer NOT NULL CHECK(version>0),
 month_offset integer NOT NULL CHECK(month_offset BETWEEN -12 AND 0), shipping_day integer CHECK(shipping_day BETWEEN 1 AND 31),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000), created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(config_key,version), CHECK(config_key=coalesce(customer_code,'*'))
);
CREATE TABLE digital_series_context_changes (
 change_id uuid PRIMARY KEY, production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id), order_version integer NOT NULL CHECK(order_version>0),
 before_json jsonb NOT NULL, after_json jsonb NOT NULL, reason text NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id),
 business_time jsonb NOT NULL, audit_event_id uuid NOT NULL REFERENCES audit_events(id), recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(production_order_id,order_version)
);
CREATE TABLE digital_series_plans (
 plan_id uuid PRIMARY KEY, production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id), revision integer NOT NULL CHECK(revision>0),
 planned_shipping_date date NOT NULL, route text NOT NULL CHECK(route IN ('A','B')), snapshot_json jsonb NOT NULL, source_revisions jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), business_time jsonb NOT NULL, audit_event_id uuid NOT NULL REFERENCES audit_events(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(production_order_id,revision),
 CHECK(jsonb_typeof(snapshot_json)='object' AND snapshot_json ? 'revision' AND snapshot_json->>'revision'=revision::text),
 CHECK(jsonb_typeof(source_revisions)='object')
);
CREATE TABLE digital_series_requests (
 request_id uuid PRIMARY KEY, production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
 expected_plan_revision integer NOT NULL CHECK(expected_plan_revision>=0), order_version integer NOT NULL CHECK(order_version>0),
 input_json jsonb NOT NULL, candidate_date date, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 requested_by uuid NOT NULL REFERENCES app_users(id), business_time jsonb NOT NULL, audit_event_id uuid NOT NULL REFERENCES audit_events(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_series_request_decisions (
 request_id uuid PRIMARY KEY REFERENCES digital_series_requests(request_id), approved boolean NOT NULL, plan_id uuid REFERENCES digital_series_plans(plan_id),
 reason text NOT NULL, decided_by uuid NOT NULL REFERENCES app_users(id), audit_event_id uuid NOT NULL REFERENCES audit_events(id),
 business_time jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(approved=(plan_id IS NOT NULL))
);
CREATE TABLE digital_series_source_events (
 event_id uuid PRIMARY KEY, production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
 node_key text NOT NULL CHECK(node_key IN ('design_handover','material_investment','fabric_receipt','color_confirmation','client_sample_approval','accessories_ready','style_label_ready','processing_dispatch','planned_shipment')),
 scope_ref text NOT NULL CHECK(length(scope_ref) BETWEEN 1 AND 150), source_domain text NOT NULL CHECK(source_domain IN ('development','bulk-preparation','production-instruction','cutting','factory-flow','receiving')),
 source_record_id uuid NOT NULL, source_version integer NOT NULL CHECK(source_version>0), occurred_at timestamptz, occurred_date date,
 precision text NOT NULL CHECK(precision IN ('instant','date','unknown')), supersedes_event_id uuid REFERENCES digital_series_source_events(event_id),
 voided boolean NOT NULL, reason text NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), business_time jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(production_order_id,node_key,scope_ref,source_version),
 CHECK(CASE precision WHEN 'instant' THEN occurred_at IS NOT NULL AND occurred_date IS NULL WHEN 'date' THEN occurred_date IS NOT NULL AND occurred_at IS NULL ELSE occurred_at IS NULL AND occurred_date IS NULL END)
);
CREATE TABLE digital_short_lead_requests (
 request_id uuid PRIMARY KEY, source_id uuid REFERENCES digital_production_sources(source_id), customer_code text NOT NULL REFERENCES digital_production_customers(code),
 design_style_no text NOT NULL, facts_hash char(64) NOT NULL, order_facts jsonb NOT NULL, commitment_day date NOT NULL, minimum_normal_date date NOT NULL,
 source_document_version integer, source_document_fingerprint char(64), source_document_status text CHECK(source_document_status IN ('draft','published')), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000), requested_by uuid NOT NULL REFERENCES app_users(id),
 business_time jsonb NOT NULL, audit_event_id uuid NOT NULL REFERENCES audit_events(id), recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(minimum_normal_date=commitment_day+30), CHECK(jsonb_typeof(order_facts)='object'),
 CHECK((source_document_version IS NULL AND source_document_fingerprint IS NULL AND source_document_status IS NULL) OR (source_id IS NOT NULL AND source_document_version IS NOT NULL AND source_document_fingerprint IS NOT NULL AND source_document_status IS NOT NULL))
);
CREATE TABLE digital_short_lead_decisions (
 request_id uuid PRIMARY KEY REFERENCES digital_short_lead_requests(request_id), approved boolean NOT NULL, reason text NOT NULL,
 decided_by uuid NOT NULL REFERENCES app_users(id), authority text NOT NULL CHECK(authority IN ('owner_group','root_superuser')),
 business_time jsonb NOT NULL, audit_event_id uuid NOT NULL REFERENCES audit_events(id), recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_short_lead_consumptions (
 production_order_id uuid PRIMARY KEY REFERENCES production_order_roots(production_order_id), request_id uuid NOT NULL REFERENCES digital_short_lead_decisions(request_id),
 facts_hash char(64) NOT NULL, commitment_day date NOT NULL, consumed_by uuid NOT NULL REFERENCES app_users(id), business_time jsonb NOT NULL,
 creation_event_id uuid NOT NULL REFERENCES audit_events(id), recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(request_id)
);
CREATE INDEX series_requests_order ON digital_series_requests(production_order_id,recorded_at);
CREATE INDEX series_events_order_scope ON digital_series_source_events(production_order_id,node_key,scope_ref,recorded_at);
CREATE INDEX short_lead_source ON digital_short_lead_requests(source_id,requested_by,recorded_at);

CREATE FUNCTION guard_series_evidence_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p digital_series_source_events; r digital_short_lead_requests; o digital_production_orders;
BEGIN
 IF TG_TABLE_NAME='digital_series_source_events' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('series-event:'||NEW.production_order_id::text||':'||NEW.node_key||':'||NEW.scope_ref,0));
  SELECT * INTO p FROM digital_series_source_events WHERE production_order_id=NEW.production_order_id AND node_key=NEW.node_key AND scope_ref=NEW.scope_ref ORDER BY source_version DESC LIMIT 1;
  IF p.event_id IS NOT NULL THEN
   IF NEW.supersedes_event_id IS DISTINCT FROM p.event_id OR ROW(p.source_domain,p.source_record_id) IS DISTINCT FROM ROW(NEW.source_domain,NEW.source_record_id) OR NEW.source_version<=p.source_version THEN RAISE EXCEPTION 'plan source correction must append to current same-scope head' USING ERRCODE='23514'; END IF;
  ELSIF NEW.supersedes_event_id IS NOT NULL THEN RAISE EXCEPTION 'plan source correction scope mismatch' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='digital_series_request_decisions' THEN
  IF NEW.approved THEN
  IF NOT EXISTS(SELECT 1 FROM digital_series_requests rq JOIN digital_series_plans sp ON sp.plan_id=NEW.plan_id WHERE rq.request_id=NEW.request_id AND sp.production_order_id=rq.production_order_id) THEN RAISE EXCEPTION 'plan decision order mismatch' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='digital_short_lead_consumptions' THEN
  SELECT * INTO r FROM digital_short_lead_requests WHERE request_id=NEW.request_id;
  SELECT * INTO o FROM digital_production_orders WHERE production_order_id=NEW.production_order_id;
  IF r IS NULL OR o IS NULL OR NOT EXISTS(SELECT 1 FROM digital_short_lead_decisions d WHERE d.request_id=r.request_id AND d.approved)
   OR coalesce(r.business_time->>'scenarioId','')<>coalesce(NEW.business_time->>'scenarioId','')
   OR ROW(r.source_id,r.customer_code,r.design_style_no,r.facts_hash,r.commitment_day) IS DISTINCT FROM ROW(o.source_id,o.customer_code,o.design_style_no,NEW.facts_hash,NEW.commitment_day)
  THEN RAISE EXCEPTION 'short commitment approval mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER series_event_scope BEFORE INSERT ON digital_series_source_events FOR EACH ROW EXECUTE FUNCTION guard_series_evidence_scope();
CREATE TRIGGER series_decision_scope BEFORE INSERT ON digital_series_request_decisions FOR EACH ROW EXECUTE FUNCTION guard_series_evidence_scope();
CREATE TRIGGER short_lead_consumption_scope BEFORE INSERT ON digital_short_lead_consumptions FOR EACH ROW EXECUTE FUNCTION guard_series_evidence_scope();
CREATE FUNCTION forbid_series_history_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'series and commitment evidence is append only' USING ERRCODE='55000'; END $$;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['digital_series_profiles','digital_series_context_changes','digital_series_plans','digital_series_requests','digital_series_request_decisions','digital_series_source_events','digital_short_lead_requests','digital_short_lead_decisions','digital_short_lead_consumptions'] LOOP
  EXECUTE format('CREATE TRIGGER series_history_no_edit BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_series_history_change()',n);
  EXECUTE format('CREATE TRIGGER series_history_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_series_history_change()',n);
 END LOOP;
END $$;
