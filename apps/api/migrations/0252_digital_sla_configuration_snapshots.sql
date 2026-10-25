-- Additive foundation only: no existing policy/task/clock is rewritten or enabled.
CREATE TABLE digital_sla_configurations (
 configuration_id uuid PRIMARY KEY,
 version integer NOT NULL UNIQUE CHECK(version > 0),
 rule_version text NOT NULL CHECK(rule_version = '20261023.1'),
 values_json jsonb NOT NULL CHECK(jsonb_typeof(values_json) = 'object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text NOT NULL CHECK(length(btrim(reason)) > 0),
 request_key uuid NOT NULL UNIQUE
);
CREATE TABLE digital_sla_order_snapshots (
 snapshot_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
 revision integer NOT NULL CHECK(revision > 0),
 configuration_id uuid NOT NULL REFERENCES digital_sla_configurations(configuration_id),
 rule_version text NOT NULL CHECK(rule_version = '20261023.1'),
 parameters_json jsonb NOT NULL CHECK(jsonb_typeof(parameters_json) = 'object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text NOT NULL CHECK(length(btrim(reason)) > 0),
 request_key uuid NOT NULL UNIQUE,
 UNIQUE(production_order_id, revision)
);
CREATE TRIGGER digital_sla_configuration_history
BEFORE UPDATE OR DELETE ON digital_sla_configurations
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_sla_order_snapshot_history
BEFORE UPDATE OR DELETE ON digital_sla_order_snapshots
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
COMMENT ON TABLE digital_sla_configurations IS
 'Immutable numeric standards; never activates a route or changes business permissions.';
COMMENT ON TABLE digital_sla_order_snapshots IS
 'Resolved values and source versions per order. New revision cannot erase original plan or historical lateness.';
