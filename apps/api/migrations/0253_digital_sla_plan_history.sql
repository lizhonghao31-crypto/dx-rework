-- Append-only plans and event observations; no legacy backfill and no workflow gate.
CREATE TABLE digital_sla_plans (
 plan_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
 revision integer NOT NULL CHECK(revision > 0),
 snapshot_id uuid NOT NULL REFERENCES digital_sla_order_snapshots(snapshot_id),
 plan_json jsonb NOT NULL CHECK(jsonb_typeof(plan_json) = 'object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time) = 'object'),
 reason text NOT NULL CHECK(length(btrim(reason)) > 0),
 request_key uuid NOT NULL UNIQUE,
 UNIQUE(production_order_id, revision)
);
CREATE TABLE digital_sla_node_facts (
 fact_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
 node_id text NOT NULL CHECK(length(btrim(node_id)) > 0),
 revision integer NOT NULL CHECK(revision > 0),
 plan_id uuid NOT NULL REFERENCES digital_sla_plans(plan_id),
 fact_json jsonb NOT NULL CHECK(jsonb_typeof(fact_json) = 'object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time) = 'object'),
 reason text NOT NULL CHECK(length(btrim(reason)) > 0),
 request_key uuid NOT NULL UNIQUE,
 UNIQUE(production_order_id, node_id, revision)
);
CREATE TRIGGER digital_sla_plan_history BEFORE UPDATE OR DELETE ON digital_sla_plans
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_sla_fact_history BEFORE UPDATE OR DELETE ON digital_sla_node_facts
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
COMMENT ON COLUMN digital_sla_plans.recorded_at IS 'Real audit clock; never scenario time.';
COMMENT ON COLUMN digital_sla_node_facts.business_time IS 'Scoped business clock observation, separate from the real audit recording time.';
