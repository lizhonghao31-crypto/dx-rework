-- Acceptance-only tool state. Ordinary production business tables and clocks are unchanged.
CREATE TABLE acceptance_sla_clock_scenarios (
 scenario_id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
 corporation_id text NOT NULL,
 initial_time timestamptz NOT NULL CHECK(isfinite(initial_time)),
 business_now timestamptz NOT NULL CHECK(isfinite(business_now)),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 business_revision bigint NOT NULL DEFAULT 0 CHECK(business_revision>=0),
 configuration_id uuid NOT NULL REFERENCES digital_sla_configurations(configuration_id),
 created_by uuid NOT NULL REFERENCES app_users(id),
 request_key uuid NOT NULL UNIQUE,
 copied_from uuid REFERENCES acceptance_sla_clock_scenarios(scenario_id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE acceptance_sla_clock_resources (
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),
 resource_id uuid NOT NULL,
 scenario_id uuid NOT NULL REFERENCES acceptance_sla_clock_scenarios(scenario_id),
 audit_event_id uuid NOT NULL REFERENCES audit_events(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(resource_kind,resource_id)
);
CREATE INDEX acceptance_sla_clock_resource_scenario ON acceptance_sla_clock_resources(scenario_id);
CREATE TABLE acceptance_sla_clock_events (
 event_id uuid PRIMARY KEY,
 scenario_id uuid NOT NULL REFERENCES acceptance_sla_clock_scenarios(scenario_id),
 request_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('advance','configuration')),
 payload_hash char(64) NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_users(id),
 before_time timestamptz NOT NULL,
 after_time timestamptz NOT NULL CHECK(after_time>=before_time),
 version integer NOT NULL CHECK(version>0),
 response_json jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(scenario_id,request_key), UNIQUE(scenario_id,version)
);
CREATE TABLE acceptance_sla_clock_scans (
 scan_id uuid PRIMARY KEY,
 scenario_id uuid NOT NULL REFERENCES acceptance_sla_clock_scenarios(scenario_id),
 request_key uuid NOT NULL,
 clock_version integer NOT NULL,
 business_time timestamptz NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_users(id),
 status text NOT NULL CHECK(status IN ('pending','completed','failed')),
 result_json jsonb NOT NULL DEFAULT '{}',
 error_message text NOT NULL DEFAULT '',
 started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 finished_at timestamptz,
 UNIQUE(scenario_id,request_key),
 CHECK((status='pending')=(finished_at IS NULL))
);
CREATE TABLE acceptance_sla_clock_receipts (
 receipt_id uuid PRIMARY KEY,
 scenario_id uuid NOT NULL REFERENCES acceptance_sla_clock_scenarios(scenario_id),
 native_kind text NOT NULL CHECK(native_kind IN ('digital','todo')),
 native_event_id uuid NOT NULL,
 recipient_id uuid NOT NULL REFERENCES app_users(id),
 business_time timestamptz NOT NULL,
 details_json jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(scenario_id,native_kind,native_event_id,recipient_id)
);
CREATE FUNCTION acceptance_sla_clock_guard_scenario() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Acceptance scenario history cannot be deleted'; END IF;
 IF NEW.scenario_id<>OLD.scenario_id OR NEW.name<>OLD.name OR NEW.initial_time<>OLD.initial_time OR NEW.corporation_id<>OLD.corporation_id OR NEW.created_by<>OLD.created_by
  OR NEW.created_at<>OLD.created_at OR NEW.request_key<>OLD.request_key OR NEW.copied_from IS DISTINCT FROM OLD.copied_from
  OR NEW.business_now<OLD.business_now OR NEW.version<OLD.version OR NEW.version>OLD.version+1
  OR NEW.business_revision<OLD.business_revision
  OR ((NEW.business_now<>OLD.business_now OR NEW.configuration_id<>OLD.configuration_id) AND NEW.version<>OLD.version+1)
 THEN RAISE EXCEPTION 'Invalid Acceptance clock transition'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER acceptance_sla_clock_scenario_guard BEFORE UPDATE OR DELETE ON acceptance_sla_clock_scenarios
 FOR EACH ROW EXECUTE FUNCTION acceptance_sla_clock_guard_scenario();
CREATE FUNCTION acceptance_sla_clock_guard_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_created timestamptz; root_actor uuid; root_xid text; source uuid; audit_actor uuid; audit_action text; audit_entity text; audit_xid text; scene acceptance_sla_clock_scenarios%ROWTYPE;
BEGIN
 SELECT * INTO STRICT scene FROM acceptance_sla_clock_scenarios WHERE scenario_id=NEW.scenario_id;
 IF NEW.resource_kind='source' THEN
  SELECT created_at,created_by,xmin::text INTO root_created,root_actor,root_xid FROM digital_production_sources WHERE source_id=NEW.resource_id;
 ELSE
  SELECT created_at,created_by,xmin::text,source_id INTO root_created,root_actor,root_xid,source FROM digital_production_orders WHERE production_order_id=NEW.resource_id;
  IF source IS NOT NULL AND NOT EXISTS(SELECT 1 FROM acceptance_sla_clock_resources WHERE resource_kind='source' AND resource_id=source AND scenario_id=NEW.scenario_id)
   THEN RAISE EXCEPTION 'Acceptance order source must belong to the same scenario'; END IF;
 END IF;
 SELECT actor_id,action,entity_id,xmin::text INTO audit_actor,audit_action,audit_entity,audit_xid FROM audit_events WHERE id=NEW.audit_event_id;
 IF root_created IS NULL OR root_created<scene.created_at OR root_xid<>(txid_current()%4294967296)::text
  OR audit_xid<>(txid_current()%4294967296)::text OR audit_entity<>NEW.resource_id::text
  OR audit_action<>(CASE WHEN NEW.resource_kind='source' THEN 'digital_source_created' ELSE 'digital_order_created' END)
  OR NOT EXISTS(SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id WHERE i.user_id=root_actor AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND i.provider='dingtalk' AND i.corp_id=scene.corporation_id AND i.provider_user_id LIKE 'uat-%' AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed)
  OR NOT EXISTS(SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id WHERE i.user_id=audit_actor AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND i.provider='dingtalk' AND i.corp_id=scene.corporation_id AND i.provider_user_id LIKE 'uat-%' AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed)
 THEN RAISE EXCEPTION 'Only newly created UAT business resources may join an Acceptance clock'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER acceptance_sla_clock_resource_guard BEFORE INSERT ON acceptance_sla_clock_resources
 FOR EACH ROW EXECUTE FUNCTION acceptance_sla_clock_guard_resource();
CREATE TRIGGER acceptance_sla_clock_resource_immutable BEFORE UPDATE OR DELETE ON acceptance_sla_clock_resources
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER acceptance_sla_clock_event_immutable BEFORE UPDATE OR DELETE ON acceptance_sla_clock_events
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER acceptance_sla_clock_receipt_immutable BEFORE UPDATE OR DELETE ON acceptance_sla_clock_receipts
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
