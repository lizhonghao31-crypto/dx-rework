-- Opt-in only. No historical adoption, target backfill or automatic activation.
CREATE TABLE digital_timeline_standard_versions (
 standard_id uuid PRIMARY KEY,
 version integer NOT NULL UNIQUE CHECK(version>0),
 unified_configuration_id uuid NOT NULL REFERENCES digital_sla_configurations(configuration_id),
 development_version integer NOT NULL REFERENCES digital_development_cycle_standards(version),
 planning_json jsonb NOT NULL CHECK(jsonb_typeof(planning_json)='object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 request_key uuid NOT NULL UNIQUE,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_timeline_standard_immutable BEFORE UPDATE OR DELETE ON digital_timeline_standard_versions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
REVOKE ALL ON digital_timeline_standard_versions FROM PUBLIC;
GRANT SELECT,INSERT ON digital_timeline_standard_versions TO CURRENT_USER;
ALTER TABLE digital_development_sla_plans ADD COLUMN timeline_schema_version smallint NOT NULL DEFAULT 1 CHECK(timeline_schema_version IN(1,2));
ALTER TABLE digital_development_sla_plans ADD COLUMN route_schema_version smallint NOT NULL DEFAULT 1 CHECK(route_schema_version IN(1,2));
ALTER TABLE digital_development_sla_plans ADD COLUMN initial_adoption_input jsonb;
ALTER TABLE digital_development_sla_plans ADD CONSTRAINT development_timeline_initial_input CHECK((timeline_schema_version=1 AND route_schema_version=1 AND initial_adoption_input IS NULL) OR (timeline_schema_version=2 AND route_schema_version=2 AND initial_adoption_input IS NOT NULL AND jsonb_typeof(initial_adoption_input)='object'));
ALTER TABLE digital_sla_plans ADD COLUMN timeline_schema_version smallint NOT NULL DEFAULT 1 CHECK(timeline_schema_version IN(1,2));
ALTER TABLE digital_sla_plans ADD COLUMN route_schema_version smallint NOT NULL DEFAULT 1 CHECK(route_schema_version IN(1,2));
ALTER TABLE digital_sla_plans ADD COLUMN initial_adoption_input jsonb;
ALTER TABLE digital_sla_plans ADD CONSTRAINT order_timeline_initial_input CHECK((timeline_schema_version=1 AND route_schema_version=1 AND initial_adoption_input IS NULL) OR (timeline_schema_version=2 AND route_schema_version=2 AND initial_adoption_input IS NOT NULL AND jsonb_typeof(initial_adoption_input)='object'));
CREATE TABLE digital_timeline_adoptions (
 adoption_id uuid PRIMARY KEY,
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),
 source_id uuid REFERENCES digital_production_sources(source_id),
 production_order_id uuid REFERENCES digital_production_orders(production_order_id),
 round_number integer NOT NULL CHECK(round_number>0),
 timeline_schema_version integer NOT NULL DEFAULT 2 CHECK(timeline_schema_version=2),
 route_schema_version integer NOT NULL DEFAULT 2 CHECK(route_schema_version=2),
 input_snapshot jsonb NOT NULL CHECK(jsonb_typeof(input_snapshot)='object'),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[0-9a-f]{64}$'),
 creation_event_ref text NOT NULL CHECK(length(btrim(creation_event_ref))>0),
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time)='object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((resource_kind='source' AND source_id IS NOT NULL AND production_order_id IS NULL)
    OR (resource_kind='order' AND production_order_id IS NOT NULL AND source_id IS NULL)),
 CHECK(input_snapshot->>'timelineSchemaVersion' IS NOT DISTINCT FROM '2'
   AND input_snapshot->>'routeSchemaVersion' IS NOT DISTINCT FROM '2'),
 UNIQUE(adoption_id,identity_hash)
);
CREATE UNIQUE INDEX digital_timeline_source_adoption ON digital_timeline_adoptions(source_id,round_number) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX digital_timeline_order_adoption ON digital_timeline_adoptions(production_order_id) WHERE production_order_id IS NOT NULL;
CREATE TRIGGER digital_timeline_adoption_immutable BEFORE UPDATE OR DELETE ON digital_timeline_adoptions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TABLE digital_timeline_target_revisions (
 target_revision_id uuid PRIMARY KEY,
 adoption_id uuid NOT NULL,
 identity_hash text NOT NULL,
 scope_ref text NOT NULL CHECK(length(btrim(scope_ref))>0),
 line_id uuid REFERENCES digital_production_po_lines(line_id),
 revision integer NOT NULL CHECK(revision>0),
 change_kind text NOT NULL CHECK(change_kind IN ('initial','customer_date_change','scope_addition')),
 goal_anchor jsonb NOT NULL CHECK(jsonb_typeof(goal_anchor)='object'),
 targets_json jsonb NOT NULL CHECK(jsonb_typeof(targets_json)='array' AND jsonb_array_length(targets_json)>0),
 source_event_ref text NOT NULL CHECK(length(btrim(source_event_ref))>0),
 created_by uuid NOT NULL REFERENCES app_users(id),
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time)='object'),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 request_key uuid NOT NULL UNIQUE,
 FOREIGN KEY(adoption_id,identity_hash) REFERENCES digital_timeline_adoptions(adoption_id,identity_hash),
 UNIQUE(adoption_id,scope_ref,revision)
);
CREATE TRIGGER digital_timeline_target_immutable BEFORE UPDATE OR DELETE ON digital_timeline_target_revisions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
REVOKE ALL ON digital_timeline_adoptions,digital_timeline_target_revisions FROM PUBLIC;
GRANT SELECT,INSERT ON digital_timeline_adoptions,digital_timeline_target_revisions TO CURRENT_USER;
COMMENT ON TABLE digital_timeline_adoptions IS 'Immutable opt-in v2 inputs. Retry reads this snapshot, never current settings; disabling new adoption does not downgrade existing v2.';
COMMENT ON TABLE digital_timeline_target_revisions IS 'Fixed per-consumer targets. Only original adoption, genuine new scope or approved customer-H change appends; no forecast/progress/standard refresh.';
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_timeline_adoptions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ($1->>''resource_kind'')::text kind,coalesce(($1->>''production_order_id'')::uuid,($1->>''source_id'')::uuid) id');
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_timeline_target_revisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT a.resource_kind AS kind,coalesce(a.production_order_id,a.source_id) AS id FROM digital_timeline_adoptions a WHERE a.adoption_id=($1->>''adoption_id'')::uuid');

-- Independent native operations. No combined third step, inferred split SLA,
-- copied completion or historical task migration is installed here.
CREATE TABLE digital_timeline_craft_steps (
 step_id uuid PRIMARY KEY,
 adoption_id uuid NOT NULL REFERENCES digital_timeline_adoptions(adoption_id),
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),
 source_id uuid REFERENCES digital_production_sources(source_id),
 production_order_id uuid REFERENCES digital_production_orders(production_order_id),
 route_ref uuid NOT NULL,
 round_number integer NOT NULL CHECK(round_number>0),
 craft_kind text NOT NULL CHECK(craft_kind IN ('embroidery','printing')),
 sequence integer NOT NULL CHECK(sequence IN (1,2)),
 scope_ref text NOT NULL CHECK(length(btrim(scope_ref))>0),
 canonical_work_ref text NOT NULL CHECK(length(btrim(canonical_work_ref))>0),
 planning_parameter_ref text,
 planning_minutes numeric CHECK(planning_minutes>=0),
 calendar_ref text CHECK(calendar_ref IN ('continuous','natural_days','beijing_sunday_excluded')),
 responsibility_sla_ref text,
 responsibility_minutes numeric CHECK(responsibility_minutes>=0),
 responsibility_calendar text CHECK(responsibility_calendar IN ('continuous','natural_days','beijing_sunday_excluded')),
 adopted_version text NOT NULL CHECK(adopted_version ~ '^[0-9a-f]{64}$'),
 source_event_ref text NOT NULL CHECK(length(btrim(source_event_ref))>0),
 created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((resource_kind='source' AND source_id IS NOT NULL AND production_order_id IS NULL)
    OR (resource_kind='order' AND production_order_id IS NOT NULL AND source_id IS NULL)),
 UNIQUE(route_ref,craft_kind),UNIQUE(route_ref,sequence),
 FOREIGN KEY(adoption_id,adopted_version) REFERENCES digital_timeline_adoptions(adoption_id,identity_hash)
);
CREATE TABLE digital_timeline_task_positions (
 task_id uuid PRIMARY KEY REFERENCES digital_production_tasks(task_id),
 adoption_id uuid NOT NULL REFERENCES digital_timeline_adoptions(adoption_id),
 route_ref uuid NOT NULL,
 route_version integer NOT NULL CHECK(route_version>0),
 route_position integer NOT NULL CHECK(route_position>=0),
 step_id uuid REFERENCES digital_timeline_craft_steps(step_id),
 phase text CHECK(phase IN ('dispatch','work','confirmation','logistics','qc')),
 CHECK((step_id IS NULL)=(phase IS NULL)),
 UNIQUE(route_ref,route_version,route_position)
);
ALTER TABLE digital_factory_routes ADD COLUMN route_schema_version smallint NOT NULL DEFAULT 1 CHECK(route_schema_version IN(1,2));
ALTER TABLE digital_factory_routes ADD COLUMN timeline_adoption_id uuid REFERENCES digital_timeline_adoptions(adoption_id);
ALTER TABLE digital_factory_routes ADD CONSTRAINT factory_route_adoption_version CHECK((route_schema_version=1 AND timeline_adoption_id IS NULL) OR (route_schema_version=2 AND timeline_adoption_id IS NOT NULL));
CREATE TRIGGER digital_timeline_craft_immutable BEFORE UPDATE OR DELETE ON digital_timeline_craft_steps
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_timeline_task_position_immutable BEFORE UPDATE OR DELETE ON digital_timeline_task_positions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_timeline_craft_steps
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ($1->>''resource_kind'')::text kind,coalesce(($1->>''production_order_id'')::uuid,($1->>''source_id'')::uuid) id');
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_timeline_task_positions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,($1->>''task_id'')::uuid id');
REVOKE ALL ON digital_timeline_craft_steps,digital_timeline_task_positions FROM PUBLIC;
GRANT SELECT,INSERT ON digital_timeline_craft_steps,digital_timeline_task_positions TO CURRENT_USER;

-- A genuine later native preparation is a new physical scope. Its frozen
-- additions constrain only that scope; the original order's B is not rewritten.
CREATE TABLE digital_timeline_order_routes (
 route_ref uuid PRIMARY KEY REFERENCES digital_bulk_preparations(preparation_id),
 adoption_id uuid NOT NULL,
 adoption_identity text NOT NULL,
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 canonical_route_ref uuid NOT NULL,
 input_snapshot jsonb NOT NULL CHECK(jsonb_typeof(input_snapshot)='object'),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[0-9a-f]{64}$'),
 source_event_ref text NOT NULL,
 business_time jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(adoption_id,adoption_identity) REFERENCES digital_timeline_adoptions(adoption_id,identity_hash)
);
CREATE TRIGGER digital_timeline_order_route_immutable BEFORE UPDATE OR DELETE ON digital_timeline_order_routes
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_timeline_order_routes
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');
REVOKE ALL ON digital_timeline_order_routes FROM PUBLIC;
GRANT SELECT,INSERT ON digital_timeline_order_routes TO CURRENT_USER;

CREATE TRIGGER digital_timeline_standard_versions_no_truncate BEFORE TRUNCATE ON digital_timeline_standard_versions
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TRIGGER digital_timeline_adoptions_no_truncate BEFORE TRUNCATE ON digital_timeline_adoptions
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TRIGGER digital_timeline_target_revisions_no_truncate BEFORE TRUNCATE ON digital_timeline_target_revisions
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TRIGGER digital_timeline_craft_steps_no_truncate BEFORE TRUNCATE ON digital_timeline_craft_steps
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TRIGGER digital_timeline_task_positions_no_truncate BEFORE TRUNCATE ON digital_timeline_task_positions
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TRIGGER digital_timeline_order_routes_no_truncate BEFORE TRUNCATE ON digital_timeline_order_routes
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
