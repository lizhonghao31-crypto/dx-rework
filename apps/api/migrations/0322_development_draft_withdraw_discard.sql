-- Only extend the original exact approval match to withdrawn requests.
CREATE OR REPLACE FUNCTION digital_development_draft_discardable(target uuid, owner_id uuid, expected_version integer, approval_id uuid, approval_version integer) RETURNS boolean
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
    AND r.version=approval_version AND r.designer_id=owner_id AND r.state IN ('returned','withdrawn')
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
