-- Append-only company time definitions. Deleting from history only hides its
-- selectable entry; frozen order payloads and the original definition survive.
CREATE TABLE digital_order_time_standards (
 standard_id uuid PRIMARY KEY,
 version integer NOT NULL UNIQUE CHECK(version>0),
 standard_json jsonb NOT NULL CHECK(jsonb_typeof(standard_json)='object'),
 source_standard_id uuid REFERENCES digital_order_time_standards(standard_id),
 source_reference text,
 created_by uuid NOT NULL REFERENCES app_users(id),
 request_key text NOT NULL UNIQUE CHECK(length(request_key) BETWEEN 1 AND 200),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_order_time_history_events (
 event_id uuid PRIMARY KEY,
 entry_kind text NOT NULL CHECK(entry_kind IN ('order_time','legacy_set','legacy_unified','legacy_development')),
 entry_id text NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 200),
 created_by uuid NOT NULL REFERENCES app_users(id),
 request_key text NOT NULL UNIQUE CHECK(length(request_key) BETWEEN 1 AND 200),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(entry_kind,entry_id)
);
CREATE TRIGGER digital_order_time_standard_immutable BEFORE UPDATE OR DELETE ON digital_order_time_standards
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_order_time_history_immutable BEFORE UPDATE OR DELETE ON digital_order_time_history_events
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_order_time_standard_no_truncate BEFORE TRUNCATE ON digital_order_time_standards
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_order_time_history_no_truncate BEFORE TRUNCATE ON digital_order_time_history_events
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

-- Existing primary column and legacy one-secondary contract stay compatible.
-- No old order or sourcing assignment is copied or rewritten by this migration.
ALTER TABLE digital_production_customers ADD COLUMN default_merchandiser_version integer NOT NULL DEFAULT 0 CHECK(default_merchandiser_version>=0);
CREATE TABLE digital_customer_secondary_merchandisers (
 customer_code text NOT NULL REFERENCES digital_production_customers(code),
 user_id uuid NOT NULL REFERENCES app_users(id),
 position integer NOT NULL CHECK(position>0),
 PRIMARY KEY(customer_code,user_id),UNIQUE(customer_code,position)
);
CREATE TABLE digital_order_secondary_merchandisers (
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 user_id uuid NOT NULL REFERENCES app_users(id),
 position integer NOT NULL CHECK(position>0),
 PRIMARY KEY(production_order_id,user_id),UNIQUE(production_order_id,position)
);
CREATE TABLE sourcing_case_secondary_merchandisers (
 sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
 user_id uuid NOT NULL REFERENCES app_users(id),
 position integer NOT NULL CHECK(position>0),
 PRIMARY KEY(sourcing_case_id,user_id),UNIQUE(sourcing_case_id,position)
);
CREATE INDEX digital_order_secondary_user_idx ON digital_order_secondary_merchandisers(user_id,production_order_id);
CREATE INDEX sourcing_case_secondary_user_idx ON sourcing_case_secondary_merchandisers(user_id,sourcing_case_id);
CREATE FUNCTION sourcing_additional_merchandiser_ids(case_id uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
 SELECT coalesce(array_agg(user_id ORDER BY position,user_id),'{}'::uuid[]) FROM (
  SELECT user_id,min(position) AS position FROM (
   SELECT additional_merchandiser_user_id AS user_id,0 AS position FROM sourcing_cases WHERE sourcing_case_id=case_id
   UNION ALL SELECT user_id,position FROM sourcing_case_secondary_merchandisers WHERE sourcing_case_id=case_id
  ) all_assignees WHERE user_id IS NOT NULL GROUP BY user_id
 ) distinct_assignees
$$;
REVOKE ALL ON FUNCTION sourcing_additional_merchandiser_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sourcing_additional_merchandiser_ids(uuid) TO CURRENT_USER;
CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_order_secondary_merchandisers
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text AS kind,($1->>''production_order_id'')::uuid AS id');
CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_case_secondary_merchandisers
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text AS kind,l.production_order_id AS id FROM digital_production_child_links l WHERE l.module=''sourcing'' AND l.child_id=($1->>''sourcing_case_id'')::uuid');
REVOKE ALL ON digital_order_time_standards,digital_order_time_history_events,digital_customer_secondary_merchandisers,digital_order_secondary_merchandisers,sourcing_case_secondary_merchandisers FROM PUBLIC;
GRANT SELECT,INSERT ON digital_order_time_standards,digital_order_time_history_events TO CURRENT_USER;
GRANT SELECT,INSERT,UPDATE,DELETE ON digital_customer_secondary_merchandisers,digital_order_secondary_merchandisers,sourcing_case_secondary_merchandisers TO CURRENT_USER;
