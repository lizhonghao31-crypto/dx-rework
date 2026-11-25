-- Procurement can take effect before formal SLA admission. Do not put that
-- event in the first development publication table used by the SLA clock.
CREATE TABLE digital_development_preorder_publications (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 event_id uuid NOT NULL UNIQUE REFERENCES audit_events(id),
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time)='object'),
 document_version integer NOT NULL CHECK(document_version>0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 recipient_id uuid NOT NULL REFERENCES app_users(id)
);

CREATE TRIGGER digital_development_preorder_publication_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON digital_development_preorder_publications
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE OR REPLACE VIEW digital_development_source_lifecycle AS
 SELECT s.source_id, p.event_id AS first_event_id, p.business_time AS first_business_time,
  p.source_id IS NULL AND pre.source_id IS NULL AND o.source_id IS NULL AND (
   s.draft_reserved IS TRUE OR
   (s.draft_reserved IS NULL AND coalesce(d.status='draft',false) AND r.source_id IS NULL)
  ) AS is_draft
 FROM digital_production_sources s
 LEFT JOIN digital_development_documents d USING(source_id)
 LEFT JOIN digital_development_revision_sources r USING(source_id)
 LEFT JOIN digital_production_orders o USING(source_id)
 LEFT JOIN digital_development_first_publications p USING(source_id)
 LEFT JOIN digital_development_preorder_publications pre USING(source_id);

CREATE FUNCTION guard_workbench_preorder_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM digital_production_sources s
  JOIN digital_development_documents d USING(source_id)
  JOIN digital_development_source_lifecycle lifecycle USING(source_id)
  JOIN audit_events a ON a.id=NEW.event_id
  WHERE s.source_id=NEW.source_id AND s.workbench_generated_number AND s.design_style_no IS NOT NULL
   AND lifecycle.is_draft AND d.status='draft' AND d.version=NEW.document_version AND d.document=NEW.document
   AND d.document->'customerOrderDraft'->>'withOrder'='true' AND d.document->'customerOrderDraft'->>'stage'='preorder'
   AND d.document#>>'{customerOrderDraft,order,primaryMerchandiserId}'=NEW.recipient_id::text
   AND a.action='digital_development_preorder_published' AND a.entity_type='digital_production'
   AND a.entity_id=NEW.source_id::text AND a.after_state->'businessTime'=NEW.business_time
   AND a.xmin::text=(txid_current()%4294967296)::text
 ) THEN
  RAISE EXCEPTION 'preorder publication needs its current native document and event' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER workbench_preorder_publication_evidence
 BEFORE INSERT ON digital_development_preorder_publications
 FOR EACH ROW EXECUTE FUNCTION guard_workbench_preorder_publication();

CREATE FUNCTION guard_workbench_preorder_publication_handover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM digital_preparation_material_versions h
  WHERE h.resource_kind='source' AND h.resource_id=NEW.source_id AND h.kind='design_handover'
   AND h.scope_ref='whole' AND h.version=1 AND h.state='ready'
   AND h.body->>'sourceDocumentVersion'=NEW.document_version::text AND h.body->>'recipientId'=NEW.recipient_id::text
   AND h.body->'investmentScopeBasis'->>'preorder'='true'
   AND h.xmin::text=(txid_current()%4294967296)::text
 ) THEN
  RAISE EXCEPTION 'preorder publication requires its first native material handover' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER workbench_preorder_publication_handover
 AFTER INSERT ON digital_development_preorder_publications DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION guard_workbench_preorder_publication_handover();

DO $$ BEGIN
 IF to_regrole('dx_rework_acceptance_app') IS NOT NULL THEN
  GRANT SELECT,INSERT ON digital_development_preorder_publications TO dx_rework_acceptance_app;
 END IF;
END $$;

-- Existing #1077 source records retain their path.
CREATE FUNCTION workbench_source_is_numbered_draft(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM digital_production_sources s
  JOIN digital_development_source_lifecycle lifecycle USING(source_id)
  WHERE s.source_id=target AND s.workbench_generated_number AND lifecycle.is_draft);
$$;

CREATE FUNCTION guard_workbench_preorder_draft_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.resource_kind='source' AND workbench_source_is_numbered_draft(NEW.resource_id) THEN
  RAISE EXCEPTION 'numbered workbench source must be published before preparation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER workbench_preorder_draft_evidence
 BEFORE INSERT ON digital_preparation_material_versions
 FOR EACH ROW EXECUTE FUNCTION guard_workbench_preorder_draft_evidence();

CREATE FUNCTION guard_workbench_draft_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_id IS NOT NULL AND workbench_source_is_numbered_draft(NEW.source_id) THEN
  RAISE EXCEPTION 'numbered workbench source must be published before task creation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER workbench_draft_task
 BEFORE INSERT ON digital_production_task_access FOR EACH ROW EXECUTE FUNCTION guard_workbench_draft_task();
