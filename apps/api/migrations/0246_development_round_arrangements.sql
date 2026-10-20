-- Current-round plans are separate from immutable task/work/payroll history.
-- No historical plan, assignee, timestamp or wage is backfilled.
CREATE TABLE digital_development_round_arrangements (
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 round_number integer NOT NULL CHECK(round_number>0),
 document_version integer NOT NULL CHECK(document_version>0),
 version integer NOT NULL CHECK(version>0),
 entries jsonb NOT NULL CHECK(jsonb_typeof(entries)='object'),
 manager_id uuid REFERENCES app_users(id),
 changed_by uuid NOT NULL REFERENCES app_users(id),
 changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(source_id,round_number)
);
CREATE TRIGGER digital_development_round_arrangements_no_delete
 BEFORE DELETE ON digital_development_round_arrangements
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
