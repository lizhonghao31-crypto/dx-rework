-- Only future explicit PO requests use this lane; both legacy queues remain immutable history.
CREATE TABLE digital_po_customer_requests (
 request_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 order_version integer NOT NULL CHECK(order_version>0),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 requested_by uuid NOT NULL REFERENCES app_users(id),
 audit_event_id uuid NOT NULL REFERENCES audit_events(id),
 requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(request_id,production_order_id)
);
CREATE TABLE digital_po_customer_request_lines (
 request_id uuid NOT NULL,
 production_order_id uuid NOT NULL,
 line_id uuid NOT NULL,
 old_date date,
 old_effective_date date,
 new_date date NOT NULL,
 expected_version integer NOT NULL CHECK(expected_version>=0),
 PRIMARY KEY(request_id,line_id),
 FOREIGN KEY(request_id,production_order_id) REFERENCES digital_po_customer_requests(request_id,production_order_id),
 FOREIGN KEY(production_order_id,line_id) REFERENCES digital_production_po_lines(production_order_id,line_id),
 CHECK(old_date IS DISTINCT FROM new_date)
);
CREATE TABLE digital_po_customer_decisions (
 request_id uuid PRIMARY KEY REFERENCES digital_po_customer_requests(request_id),
 approved boolean NOT NULL,
 decided_by uuid NOT NULL REFERENCES app_users(id),
 audit_event_id uuid NOT NULL REFERENCES audit_events(id),
 decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_po_customer_requests_immutable BEFORE UPDATE OR DELETE ON digital_po_customer_requests
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_po_customer_requests_no_truncate BEFORE TRUNCATE ON digital_po_customer_requests
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_po_customer_request_lines_immutable BEFORE UPDATE OR DELETE ON digital_po_customer_request_lines
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_po_customer_request_lines_no_truncate BEFORE TRUNCATE ON digital_po_customer_request_lines
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_po_customer_decisions_immutable BEFORE UPDATE OR DELETE ON digital_po_customer_decisions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_po_customer_decisions_no_truncate BEFORE TRUNCATE ON digital_po_customer_decisions
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE FUNCTION guard_digital_po_customer_request_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence audit_events%ROWTYPE; item_count integer;
BEGIN
 SELECT * INTO evidence FROM audit_events WHERE id=NEW.audit_event_id;
 SELECT count(*) INTO item_count FROM digital_po_customer_request_lines WHERE request_id=NEW.request_id;
 IF evidence.id IS NULL OR evidence.actor_id IS DISTINCT FROM NEW.requested_by
   OR evidence.action<>'digital_po_customer_dates_requested'
   OR evidence.entity_type<>'digital_production' OR evidence.entity_id<>NEW.production_order_id::text
   OR evidence.after_state->>'requestId' IS DISTINCT FROM NEW.request_id::text
   OR evidence.after_state->>'orderVersion' IS DISTINCT FROM NEW.order_version::text
   OR evidence.after_state->>'reason' IS DISTINCT FROM NEW.reason
   OR jsonb_typeof(evidence.after_state->'changes') IS DISTINCT FROM 'array'
   OR item_count NOT BETWEEN 1 AND 50
   OR item_count IS DISTINCT FROM jsonb_array_length(evidence.after_state->'changes')
   OR EXISTS(SELECT 1 FROM digital_po_customer_request_lines line WHERE line.request_id=NEW.request_id
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(evidence.after_state->'changes') AS x(change)
       WHERE x.change->>'lineId'=line.line_id::text AND x.change->>'oldDate' IS NOT DISTINCT FROM line.old_date::text
         AND x.change->>'oldEffectiveDate' IS NOT DISTINCT FROM line.old_effective_date::text
         AND x.change->>'date'=line.new_date::text AND x.change->>'expectedVersion'=line.expected_version::text)) THEN
   RAISE EXCEPTION 'PO customer request must match its exact immutable audit and selected lines' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER digital_po_customer_request_commit AFTER INSERT ON digital_po_customer_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_digital_po_customer_request_commit();

CREATE FUNCTION guard_digital_po_customer_line_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request digital_po_customer_requests%ROWTYPE; evidence audit_events%ROWTYPE;
BEGIN
 SELECT * INTO request FROM digital_po_customer_requests WHERE request_id=NEW.request_id;
 SELECT * INTO evidence FROM audit_events WHERE id=request.audit_event_id;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(evidence.after_state->'changes') x(change)
   WHERE x.change->>'lineId'=NEW.line_id::text AND x.change->>'oldDate' IS NOT DISTINCT FROM NEW.old_date::text
     AND x.change->>'oldEffectiveDate' IS NOT DISTINCT FROM NEW.old_effective_date::text
     AND x.change->>'date'=NEW.new_date::text AND x.change->>'expectedVersion'=NEW.expected_version::text) THEN
   RAISE EXCEPTION 'cannot append an unrequested PO to an immutable request' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER digital_po_customer_line_insert BEFORE INSERT ON digital_po_customer_request_lines
 FOR EACH ROW EXECUTE FUNCTION guard_digital_po_customer_line_insert();

CREATE FUNCTION guard_digital_po_customer_decision_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request digital_po_customer_requests%ROWTYPE; evidence audit_events%ROWTYPE;
BEGIN
 SELECT * INTO request FROM digital_po_customer_requests WHERE request_id=NEW.request_id;
 SELECT * INTO evidence FROM audit_events WHERE id=NEW.audit_event_id;
 IF evidence.id IS NULL OR evidence.actor_id IS DISTINCT FROM NEW.decided_by
   OR evidence.entity_type<>'digital_production' OR evidence.entity_id<>request.production_order_id::text
   OR evidence.after_state->>'requestId' IS DISTINCT FROM NEW.request_id::text
   OR evidence.action IS DISTINCT FROM (CASE WHEN NEW.approved THEN 'digital_po_customer_dates_approved' ELSE 'digital_po_customer_dates_rejected' END)
   OR (NEW.approved AND EXISTS(SELECT 1 FROM digital_po_customer_request_lines line WHERE line.request_id=NEW.request_id
     AND NOT EXISTS(SELECT 1 FROM digital_po_date_changes fact WHERE fact.line_id=line.line_id AND fact.date_kind='customer'
       AND fact.old_date IS NOT DISTINCT FROM line.old_date AND fact.new_date=line.new_date
       AND fact.version=line.expected_version+1 AND fact.approval_event_id=NEW.audit_event_id))) THEN
   RAISE EXCEPTION 'PO customer decision requires the matching decision audit and effective PO facts' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER digital_po_customer_decision_commit AFTER INSERT ON digital_po_customer_decisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_digital_po_customer_decision_commit();
