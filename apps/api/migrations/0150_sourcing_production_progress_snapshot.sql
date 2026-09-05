-- Freeze completion facts without adding a user step or modifying production history.
-- Prevent a completion from slipping between backfill and trigger installation.
LOCK TABLE sourcing_production_transitions IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE sourcing_production_progress_snapshots (
 production_order_id uuid PRIMARY KEY REFERENCES sourcing_production_orders(production_order_id),
 production_transition_id uuid NOT NULL UNIQUE REFERENCES sourcing_production_transitions(production_transition_id),
 completed_quantity integer NOT NULL CHECK(completed_quantity>=0),
 first_reported_on date,
 last_updated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Older completed orders use the completion audit quantity and revisions recorded by that time.
INSERT INTO sourcing_production_progress_snapshots(production_order_id,production_transition_id,completed_quantity,first_reported_on,last_updated_at)
 SELECT transition.production_order_id,transition.production_transition_id,
 COALESCE((event.after_state->>'recordedQuantity')::integer,facts.quantity,0),facts.first_on,facts.last_at
 FROM sourcing_production_transitions transition JOIN operation_events event ON event.event_id=transition.operation_event_id
 LEFT JOIN LATERAL (
   SELECT sum(quantity)::integer AS quantity,min(business_date) FILTER(WHERE quantity>0) AS first_on,max(created_at) AS last_at
   FROM (SELECT DISTINCT ON(root_report_id) quantity,business_date,created_at FROM sourcing_production_reports report
     WHERE report.production_order_id=transition.production_order_id AND report.created_at<=transition.created_at
     ORDER BY root_report_id,revision DESC) effective
 ) facts ON true WHERE transition.status='production_completed';
CREATE FUNCTION capture_sourcing_production_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='production_completed' THEN
   INSERT INTO sourcing_production_progress_snapshots(production_order_id,production_transition_id,completed_quantity,first_reported_on,last_updated_at)
   SELECT NEW.production_order_id,NEW.production_transition_id,COALESCE(sum(quantity),0)::integer,
     min(business_date) FILTER(WHERE quantity>0),max(created_at)
   FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_production_progress_capture AFTER INSERT ON sourcing_production_transitions
 FOR EACH ROW EXECUTE FUNCTION capture_sourcing_production_progress();
CREATE FUNCTION guard_sourcing_production_progress_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sourcing_production_transitions transition WHERE transition.production_transition_id=NEW.production_transition_id
   AND transition.production_order_id=NEW.production_order_id AND transition.status='production_completed')
 OR NEW.completed_quantity IS DISTINCT FROM (SELECT COALESCE(sum(quantity),0)::integer FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id)
 OR NEW.first_reported_on IS DISTINCT FROM (SELECT min(business_date) FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id AND quantity>0)
 OR NEW.last_updated_at IS DISTINCT FROM (SELECT max(created_at) FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id)
 THEN RAISE EXCEPTION 'production progress snapshot must match completion facts' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_production_progress_snapshot_guard BEFORE INSERT ON sourcing_production_progress_snapshots
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_progress_snapshot();
CREATE TRIGGER sourcing_production_progress_snapshot_immutable BEFORE UPDATE OR DELETE ON sourcing_production_progress_snapshots
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_production_progress_snapshot_no_truncate BEFORE TRUNCATE ON sourcing_production_progress_snapshots
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
