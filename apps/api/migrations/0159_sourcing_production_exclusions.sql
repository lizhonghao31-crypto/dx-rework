-- Exact-object exclusion is separate from immutable production and normal archival.
CREATE TABLE sourcing_production_exclusions (
 production_order_id uuid PRIMARY KEY REFERENCES sourcing_production_orders(production_order_id),
 preview_version text NOT NULL CHECK(preview_version ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 excluded_by uuid NOT NULL REFERENCES app_users(id),
 excluded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id)
);
CREATE FUNCTION guard_sourcing_production_exclusion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=NEW.operation_event_id
  AND event.action='sourcing.production.exclude' AND event.entity_type='sourcing_production_order'
  AND event.entity_id=NEW.production_order_id::text AND event.actor_id=NEW.excluded_by
  AND event.actor_roles @> ARRAY['root_superuser']::text[]
  AND event.after_state->>'productionOrderId'=NEW.production_order_id::text
  AND event.after_state->>'previewVersion'=NEW.preview_version
  AND event.after_state->>'reason'=NEW.reason
  AND event.after_state->>'excluded'='true')
 THEN RAISE EXCEPTION 'production exclusion requires matching Root audit' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_production_exclusion_guard BEFORE INSERT ON sourcing_production_exclusions
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_exclusion();
CREATE TRIGGER sourcing_production_exclusion_immutable BEFORE UPDATE OR DELETE ON sourcing_production_exclusions
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_production_exclusion_no_truncate BEFORE TRUNCATE ON sourcing_production_exclusions
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

-- Serialize with reports, transitions and receipt links; no writes after exclusion.
CREATE FUNCTION guard_excluded_production_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM sourcing_production_exclusions WHERE production_order_id=NEW.production_order_id)
 THEN RAISE EXCEPTION 'excluded production cannot receive new execution facts' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['sourcing_production_reports','sourcing_production_transitions','sourcing_production_receipt_links'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_excluded_production_write()',target||'_exclusion_guard',target);
 END LOOP;
END; $$;
