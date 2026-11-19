-- A reserved identity retains its original owner and uniqueness. Only a
-- successful native publication appends evidence of first effective creation.
ALTER TABLE digital_production_sources
 ADD COLUMN draft_reserved boolean;
ALTER TABLE digital_production_sources ALTER COLUMN draft_reserved SET DEFAULT false;

CREATE TABLE digital_development_first_publications (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 event_id uuid NOT NULL UNIQUE REFERENCES audit_events(id),
 business_time jsonb NOT NULL CHECK (jsonb_typeof(business_time)='object')
);

CREATE TRIGGER digital_development_first_publication_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON digital_development_first_publications
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE VIEW digital_development_source_lifecycle AS
 SELECT s.source_id, p.event_id AS first_event_id, p.business_time AS first_business_time,
  p.source_id IS NULL AND o.source_id IS NULL AND (
   s.draft_reserved IS TRUE OR
   (s.draft_reserved IS NULL AND coalesce(d.status='draft',false) AND r.source_id IS NULL)
  ) AS is_draft
 FROM digital_production_sources s
 LEFT JOIN digital_development_documents d USING(source_id)
 LEFT JOIN digital_development_revision_sources r USING(source_id)
 LEFT JOIN digital_production_orders o USING(source_id)
 LEFT JOIN digital_development_first_publications p USING(source_id);

DO $$ BEGIN
 IF to_regrole('dx_rework_acceptance_app') IS NOT NULL THEN
  GRANT SELECT ON digital_development_source_lifecycle TO dx_rework_acceptance_app;
  GRANT SELECT,INSERT ON digital_development_first_publications TO dx_rework_acceptance_app;
 END IF;
END $$;

-- Bind a new UAT reservation to its scenario without treating it as an effective
-- SLA event. Same-transaction provenance and the identities are still required.
CREATE OR REPLACE FUNCTION acceptance_sla_clock_guard_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reserved boolean; root_created timestamptz; root_actor uuid; root_xid text; source uuid; audit_actor uuid; audit_action text; audit_entity text; audit_xid text; scene acceptance_sla_clock_scenarios%ROWTYPE;
BEGIN
 SELECT * INTO STRICT scene FROM acceptance_sla_clock_scenarios WHERE scenario_id=NEW.scenario_id;
 IF NEW.resource_kind='source' THEN
  SELECT created_at,created_by,xmin::text,draft_reserved INTO root_created,root_actor,root_xid,reserved FROM digital_production_sources WHERE source_id=NEW.resource_id;
 ELSE
  SELECT created_at,created_by,xmin::text,source_id INTO root_created,root_actor,root_xid,source FROM digital_production_orders WHERE production_order_id=NEW.resource_id;
  IF source IS NOT NULL AND NOT EXISTS(SELECT 1 FROM acceptance_sla_clock_resources WHERE resource_kind='source' AND resource_id=source AND scenario_id=NEW.scenario_id)
   THEN RAISE EXCEPTION 'Acceptance order source must belong to the same scenario'; END IF;
 END IF;
 SELECT actor_id,action,entity_id,xmin::text INTO audit_actor,audit_action,audit_entity,audit_xid FROM audit_events WHERE id=NEW.audit_event_id;
 IF root_created IS NULL OR root_created<scene.created_at OR root_xid<>(txid_current()%4294967296)::text
  OR audit_xid<>(txid_current()%4294967296)::text OR audit_entity<>NEW.resource_id::text
  OR audit_action IS DISTINCT FROM (CASE WHEN NEW.resource_kind='source' AND reserved IS TRUE THEN 'digital_source_draft_reserved'
     WHEN NEW.resource_kind='source' THEN 'digital_source_created' ELSE 'digital_order_created' END)
  OR (reserved IS TRUE AND root_actor IS DISTINCT FROM audit_actor)
  OR NOT EXISTS(SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id WHERE i.user_id=root_actor AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND i.provider='dingtalk' AND i.corp_id=scene.corporation_id AND i.provider_user_id LIKE 'uat-%' AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed)
  OR NOT EXISTS(SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id WHERE i.user_id=audit_actor AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND i.provider='dingtalk' AND i.corp_id=scene.corporation_id AND i.provider_user_id LIKE 'uat-%' AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed)
 THEN RAISE EXCEPTION 'Only newly created UAT business resources may join an Acceptance clock'; END IF;
 RETURN NEW;
END;
$$;

-- The existing enrollment trigger also covers the new publication evidence.
CREATE OR REPLACE FUNCTION guard_preparation_evidence_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous digital_preparation_material_versions; origin audit_events;
BEGIN
 IF NEW.resource_kind='order' THEN
  IF NOT EXISTS(SELECT 1 FROM digital_production_orders WHERE production_order_id=NEW.resource_id) THEN RAISE EXCEPTION 'preparation order missing' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM digital_production_sources WHERE source_id=NEW.resource_id) THEN RAISE EXCEPTION 'preparation source missing' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM digital_development_source_lifecycle WHERE source_id=NEW.resource_id AND is_draft) THEN
   RAISE EXCEPTION 'preparation source not published' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_TABLE_NAME='digital_preparation_material_versions' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('preparation-material:'||NEW.resource_kind||':'||NEW.resource_id::text||':'||NEW.kind||':'||NEW.scope_ref,0));
  SELECT * INTO previous FROM digital_preparation_material_versions WHERE resource_kind=NEW.resource_kind AND resource_id=NEW.resource_id AND kind=NEW.kind AND scope_ref=NEW.scope_ref ORDER BY version DESC LIMIT 1;
  IF previous.record_id IS NULL THEN
   IF NEW.version<>1 THEN RAISE EXCEPTION 'preparation first version must be one' USING ERRCODE='23514';END IF;
  ELSIF NEW.record_id<>previous.record_id OR NEW.version<>previous.version+1 THEN
   RAISE EXCEPTION 'preparation correction must append current same-scope record' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='digital_preparation_rule_adoptions' THEN
 IF NEW.creation_event_id IS NOT NULL THEN
  SELECT * INTO origin FROM audit_events WHERE id=NEW.creation_event_id;
  IF origin IS NULL OR origin.entity_id<>NEW.resource_id::text OR NOT (
   (origin.actor_id=NEW.adopted_by AND origin.action=(CASE WHEN NEW.resource_kind='order' THEN 'digital_order_created' ELSE 'digital_source_created' END))
   OR (NEW.resource_kind='source' AND origin.action='digital_development_first_published'
    AND origin.after_state->>'createdBy'=NEW.adopted_by::text
    AND EXISTS(SELECT 1 FROM digital_development_first_publications WHERE source_id=NEW.resource_id AND event_id=origin.id))
  ) THEN
   RAISE EXCEPTION 'preparation enrollment needs its original creation event' USING ERRCODE='23514';
  END IF;
 END IF;
 END IF;
 RETURN NEW;
END $$;
