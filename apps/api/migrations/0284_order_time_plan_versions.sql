-- New per-order planning core only. No adoption/backfill or existing-clock rewrite.
CREATE TABLE digital_order_time_plan_versions (
 plan_version_id uuid PRIMARY KEY,
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),
 source_id uuid REFERENCES digital_production_sources(source_id),
 production_order_id uuid REFERENCES digital_production_orders(production_order_id),
 revision integer NOT NULL CHECK(revision>0),
 input_snapshot jsonb NOT NULL CHECK(jsonb_typeof(input_snapshot)='object'),
 fixed_targets jsonb NOT NULL CHECK(jsonb_typeof(fixed_targets)='object'),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[0-9a-f]{64}$'),
 change_kind text NOT NULL CHECK(change_kind IN ('initial','arrangement','customer_date_change')),
 source_event_ref text NOT NULL CHECK(length(btrim(source_event_ref))>0),
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time)='object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 request_key text NOT NULL UNIQUE CHECK(length(request_key) BETWEEN 1 AND 200),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((resource_kind='source' AND source_id IS NOT NULL AND production_order_id IS NULL)
    OR (resource_kind='order' AND production_order_id IS NOT NULL AND source_id IS NULL)),
 CHECK(input_snapshot->>'version' IS NOT DISTINCT FROM 'order-time-input-v1')
);
CREATE UNIQUE INDEX digital_order_time_source_revision ON digital_order_time_plan_versions(source_id,revision) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX digital_order_time_order_revision ON digital_order_time_plan_versions(production_order_id,revision) WHERE production_order_id IS NOT NULL;
CREATE TRIGGER digital_order_time_plan_immutable BEFORE UPDATE OR DELETE ON digital_order_time_plan_versions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_order_time_plan_no_truncate BEFORE TRUNCATE ON digital_order_time_plan_versions
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_order_time_plan_versions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ($1->>''resource_kind'')::text kind,coalesce(($1->>''production_order_id'')::uuid,($1->>''source_id'')::uuid) id');
REVOKE ALL ON digital_order_time_plan_versions FROM PUBLIC;
GRANT SELECT,INSERT ON digital_order_time_plan_versions TO CURRENT_USER;
COMMENT ON TABLE digital_order_time_plan_versions IS 'Explicit confirmed order-time policy and applicable graph. Original B is retained except approved H change; original task clocks and actual events are not written here. No GET adoption or current-standard fallback.';
