-- New first-effective subjects are explicit. Historical orders are not recast
-- as new drafts and neither their clocks nor their actual records are changed.
ALTER TABLE digital_production_sources ADD COLUMN order_time_managed boolean NOT NULL DEFAULT false;
ALTER TABLE digital_production_orders ADD COLUMN order_time_managed boolean NOT NULL DEFAULT false;
CREATE TABLE digital_order_time_subjects (
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),
 source_id uuid REFERENCES digital_production_sources(source_id),
 production_order_id uuid REFERENCES digital_production_orders(production_order_id),
 effective boolean NOT NULL DEFAULT false,
 created_business_time jsonb NOT NULL CHECK(jsonb_typeof(created_business_time)='object'),
 creation_event_ref text NOT NULL,
 production_route jsonb CHECK(production_route IS NULL OR jsonb_typeof(production_route)='object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((resource_kind='source' AND source_id IS NOT NULL AND production_order_id IS NULL)
     OR (resource_kind='order' AND production_order_id IS NOT NULL AND source_id IS NULL)),
 UNIQUE(source_id),UNIQUE(production_order_id)
);
CREATE TABLE digital_order_time_requests (
 request_id uuid PRIMARY KEY,
 source_id uuid REFERENCES digital_production_sources(source_id),
 production_order_id uuid REFERENCES digital_production_orders(production_order_id),
 state text NOT NULL CHECK(state IN ('needs_designer','pending','returned','withdrawn','applied')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 requested_by uuid NOT NULL REFERENCES app_users(id),
 designer_id uuid NOT NULL REFERENCES app_users(id),
 operation_json jsonb NOT NULL CHECK(jsonb_typeof(operation_json)='object'),
 company_snapshot jsonb NOT NULL CHECK(jsonb_typeof(company_snapshot)='object'),
 submitted_versions jsonb NOT NULL CHECK(jsonb_typeof(submitted_versions)='object'),
 submitted_fingerprint char(64) NOT NULL,
 reason text NOT NULL,
 return_reason text,
 applied_by uuid REFERENCES app_users(id),
 applied_plan_id uuid REFERENCES digital_order_time_plan_versions(plan_version_id),
 result_order_id uuid REFERENCES digital_production_orders(production_order_id),
 result_late_minutes numeric,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(num_nonnulls(source_id,production_order_id)<=1),
 CHECK((state='applied')=(applied_by IS NOT NULL))
);
CREATE INDEX digital_order_time_pending_source ON digital_order_time_requests(source_id,state,created_at DESC);
CREATE INDEX digital_order_time_pending_order ON digital_order_time_requests(production_order_id,state,created_at DESC);
CREATE INDEX digital_order_time_requester ON digital_order_time_requests(designer_id,state,updated_at DESC);
CREATE UNIQUE INDEX digital_order_time_one_open_source ON digital_order_time_requests(source_id) WHERE source_id IS NOT NULL AND state IN ('needs_designer','pending');
CREATE UNIQUE INDEX digital_order_time_one_open_order ON digital_order_time_requests(production_order_id) WHERE production_order_id IS NOT NULL AND state IN ('needs_designer','pending');
CREATE TABLE digital_order_time_request_events (
 event_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES digital_order_time_requests(request_id),
 request_version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_users(id),
 action text NOT NULL CHECK(action IN ('submitted','handed_to_designer','returned','withdrawn','applied')),
 payload jsonb NOT NULL,
 business_time jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(request_id,request_version)
);
CREATE TRIGGER digital_order_time_request_history BEFORE UPDATE OR DELETE ON digital_order_time_request_events
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
REVOKE ALL ON digital_order_time_subjects,digital_order_time_requests,digital_order_time_request_events FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON digital_order_time_subjects,digital_order_time_requests TO CURRENT_USER;
GRANT SELECT,INSERT ON digital_order_time_request_events TO CURRENT_USER;
