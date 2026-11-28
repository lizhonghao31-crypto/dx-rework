-- Preserve all original draft-discard protections. Only one exact returned
-- development publication application may take the additional audited path.
CREATE FUNCTION digital_development_draft_discardable(target uuid, owner_id uuid, expected_version integer, approval_id uuid, approval_version integer) RETURNS boolean
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
 AND NOT EXISTS(SELECT 1 FROM digital_development_technical_enrollments e WHERE e.source_id=target
  AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.entity_id=target::text AND a.id::text=e.event_key
   AND digital_development_draft_creation_shell(target,a.id,e.created_by)))
 AND NOT EXISTS(SELECT 1 FROM digital_development_cycle_rounds WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_artifact_heads WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_final_comments WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_amendments WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_amendment_drafts WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_dispatch WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_preparation_responsibilities WHERE resource_kind='source' AND resource_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_production_task_access WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_preparation_material_versions WHERE resource_kind='source' AND resource_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_preparation_rule_adoptions a WHERE a.resource_kind='source' AND a.resource_id=target
  AND (a.revision<>1 OR a.basis_revision IS DISTINCT FROM 'creation:'||a.creation_event_id
   OR NOT digital_development_draft_creation_shell(target,a.creation_event_id,a.adopted_by)))
 AND NOT EXISTS(SELECT 1 FROM digital_quotation_documents WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_order_time_subjects WHERE source_id=target AND effective)
 AND (
  approval_id IS NULL AND approval_version IS NULL
   AND NOT EXISTS(SELECT 1 FROM digital_order_time_requests WHERE source_id=target)
  OR approval_id IS NOT NULL AND approval_version IS NOT NULL
   AND EXISTS(SELECT 1 FROM digital_order_time_requests r WHERE r.source_id=target AND r.request_id=approval_id
    AND r.version=approval_version AND r.designer_id=owner_id AND r.state='returned'
    AND r.operation_json->>'kind'='development_publish' AND r.operation_json->>'sourceId'=target::text)
   AND NOT EXISTS(SELECT 1 FROM digital_order_time_requests r WHERE r.source_id=target AND r.request_id<>approval_id)
   AND NOT EXISTS(SELECT 1 FROM digital_development_documents d WHERE d.source_id=target
    AND d.document#>>'{customerOrderDraft,stage}'='preorder')
 )
 AND NOT EXISTS(SELECT 1 FROM digital_short_lead_requests WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_order_time_plan_versions WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_timeline_adoptions WHERE source_id=target)
 AND NOT EXISTS(SELECT 1 FROM digital_development_sla_plans p WHERE p.source_id=target
  AND (p.revision<>1 OR cardinality(p.route_nodes)<>0 OR p.plan_json->'anchors' IS DISTINCT FROM '{}'::jsonb
   OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.entity_id=target::text AND a.id::text=p.event_key
    AND digital_development_draft_creation_shell(target,a.id,p.created_by))))
 AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=target)
 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE entity_type='digital_development_handover' AND entity_id=target::text
  AND action IN ('design_sample_handed_over','design_electronic_documents_shared'))
$$;

CREATE OR REPLACE FUNCTION digital_development_draft_discardable(target uuid, owner_id uuid, expected_version integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT digital_development_draft_discardable(target,owner_id,expected_version,NULL::uuid,NULL::integer)
$$;

CREATE OR REPLACE FUNCTION guard_development_draft_discard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_owner uuid; evidence jsonb; request_id uuid; request_version integer; has_approval boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0));
 SELECT created_by INTO original_owner FROM digital_production_sources WHERE source_id=NEW.source_id FOR UPDATE;
 SELECT e.before_state INTO evidence FROM audit_events e WHERE e.id=NEW.audit_event_id
  AND e.actor_id=NEW.actor_id AND e.entity_id=NEW.source_id::text AND e.entity_type='digital_production'
  AND e.action='digital_development_draft_discarded' AND e.before_state->>'version'=NEW.draft_version::text
  AND e.after_state->>'ownerId'=original_owner::text
  AND e.xmin::text=(txid_current()%4294967296)::text;
 has_approval:=evidence ? 'approvalRequestId' OR evidence ? 'approvalVersion';
 IF has_approval THEN
  SELECT r.request_id,r.version INTO request_id,request_version FROM digital_order_time_requests r
   WHERE r.source_id=NEW.source_id AND r.request_id::text=evidence->>'approvalRequestId'
    AND r.version::text=evidence->>'approvalVersion' FOR SHARE;
  PERFORM 1 FROM digital_development_documents WHERE source_id=NEW.source_id FOR SHARE;
 END IF;
 IF evidence IS NULL
  OR (NEW.actor_id IS DISTINCT FROM original_owner AND NOT access_is_root_actor(NEW.actor_id))
  OR (has_approval AND request_id IS NULL)
  OR NOT digital_development_draft_discardable(NEW.source_id,original_owner,NEW.draft_version,request_id,request_version)
 THEN RAISE EXCEPTION 'draft discard requires a current authorized draft and its exact audit' USING ERRCODE='23514'; END IF;
 IF has_approval AND NOT access_is_root_actor(NEW.actor_id) AND NOT (
  'sample_designer'=ANY(access_authorized_actor_roles(NEW.actor_id,'pattern_room:orders:create'))
 ) THEN RAISE EXCEPTION 'returned draft discard requires an active design owner' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
