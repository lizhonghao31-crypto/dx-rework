-- A discarded draft is only hidden; the original identity, document, file links
-- and number registry remain. This is not whole-order or native child deletion.
CREATE TABLE digital_development_draft_discards (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 actor_id uuid NOT NULL REFERENCES app_users(id),
 draft_version integer NOT NULL CHECK(draft_version>=0),
 audit_event_id uuid NOT NULL UNIQUE REFERENCES audit_events(id),
 discarded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER development_draft_discard_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON digital_development_draft_discards
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE OR REPLACE FUNCTION digital_whole_order_active(kind text,id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM digital_whole_order_deleted_objects d WHERE d.object_kind=kind AND d.object_id=id)
  AND (kind<>'source' OR NOT EXISTS(SELECT 1 FROM digital_development_draft_discards d WHERE d.source_id=id))
$$;

CREATE FUNCTION digital_development_draft_discardable(target uuid, owner_id uuid, expected_version integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM digital_production_sources s JOIN digital_development_source_lifecycle l USING(source_id)
  LEFT JOIN digital_development_documents d USING(source_id)
  WHERE s.source_id=target AND s.created_by=owner_id AND l.is_draft AND digital_whole_order_active('source',target)
   AND (d.source_id IS NULL OR d.status='draft' AND d.published_at IS NULL AND d.task_id IS NULL)
   AND COALESCE(d.version,0)=expected_version
 ) AND NOT EXISTS(SELECT 1 FROM digital_development_revision_sources WHERE source_id=target OR parent_source_id=target OR root_source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_rounds WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_pattern_links WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_route_facts WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_execution_facts WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_material_events WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_technical_enrollments WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_production_task_access WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_preparation_material_versions WHERE resource_kind='source' AND resource_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_preparation_rule_adoptions WHERE resource_kind='source' AND resource_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_quotation_documents WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_order_time_subjects WHERE source_id=target AND effective)
 AND NOT EXISTS(SELECT 1 FROM digital_order_time_requests WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_short_lead_requests WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_order_time_plan_versions WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_timeline_adoptions WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_sla_plans WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=target)
 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE entity_type='digital_development_handover' AND entity_id=target::text
  AND action IN ('design_sample_handed_over','design_electronic_documents_shared'))
$$;

CREATE FUNCTION guard_development_draft_discard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM source_id FROM digital_production_sources WHERE source_id=NEW.source_id FOR UPDATE;
 IF NOT digital_development_draft_discardable(NEW.source_id,NEW.actor_id,NEW.draft_version)
  OR NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.id=NEW.audit_event_id
   AND e.actor_id=NEW.actor_id AND e.entity_id=NEW.source_id::text AND e.entity_type='digital_production'
   AND e.action='digital_development_draft_discarded' AND e.before_state->>'version'=NEW.draft_version::text
   AND e.xmin::text=(txid_current()%4294967296)::text)
 THEN RAISE EXCEPTION 'draft discard requires a current owned draft and its exact audit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER development_draft_discard_evidence BEFORE INSERT ON digital_development_draft_discards
 FOR EACH ROW EXECUTE FUNCTION guard_development_draft_discard();

DO $$ BEGIN
 IF to_regrole('dx_rework_acceptance_app') IS NOT NULL THEN
  GRANT SELECT,INSERT ON digital_development_draft_discards TO dx_rework_acceptance_app;
 END IF;
END $$;
