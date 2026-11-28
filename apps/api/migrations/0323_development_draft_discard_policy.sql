-- Draft-box membership, blocking approval and the displayed approval token are
-- separate facts. Use caller privileges and keep all original business rows.
CREATE FUNCTION digital_development_draft_box_snapshot(target uuid)
RETURNS TABLE(owner_id uuid,draft_version integer,updated_at timestamptz,in_followup boolean,
 approval_state text,approval_id uuid,approval_version integer,return_reason text,can_discard boolean)
LANGUAGE sql STABLE AS $$
 SELECT s.created_by,coalesce(d.version,0),
  CASE WHEN bucket.followup THEN coalesce(busy.updated_at,latest.updated_at) ELSE coalesce(d.updated_at,s.created_at) END,
  bucket.followup,coalesce(busy.state,CASE WHEN bucket.followup THEN latest.state END),
  CASE WHEN bucket.followup THEN latest.request_id END,
  CASE WHEN bucket.followup THEN latest.version END,
  CASE WHEN bucket.followup AND busy.request_id IS NULL THEN latest.return_reason END,
  busy.request_id IS NULL
 FROM digital_production_sources s JOIN digital_development_source_lifecycle l USING(source_id)
 LEFT JOIN digital_development_documents d USING(source_id)
 LEFT JOIN LATERAL (
  SELECT r.request_id,r.state,r.updated_at FROM digital_order_time_requests r
  WHERE r.source_id=s.source_id AND r.state IN ('pending','needs_designer') LIMIT 1
 ) busy ON true
 LEFT JOIN LATERAL (
  SELECT r.request_id,r.state,r.version,r.updated_at,r.return_reason FROM digital_order_time_requests r
  WHERE r.source_id=s.source_id AND r.operation_json->>'kind'='development_publish'
  ORDER BY r.created_at DESC,r.request_id DESC LIMIT 1
 ) latest ON true
 CROSS JOIN LATERAL (SELECT coalesce(d.status='draft'
  AND d.document#>>'{customerOrderDraft,stage}' IS DISTINCT FROM 'preorder'
  AND latest.state IN ('pending','returned','withdrawn','needs_designer'),false) AS followup) bucket
 WHERE s.source_id=target AND l.is_draft AND digital_whole_order_active('source',target)
  AND (d.source_id IS NULL OR d.status='draft' AND d.published_at IS NULL AND d.task_id IS NULL)
  AND (coalesce(s.workbench_generated_number,false) OR d.document#>>'{customerOrderDraft,stage}' IS DISTINCT FROM 'preorder')
$$;

CREATE OR REPLACE FUNCTION digital_development_draft_discardable(target uuid, owner_id uuid, expected_version integer, approval_id uuid, approval_version integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM digital_development_draft_box_snapshot(target) box
  WHERE box.owner_id=$2 AND box.draft_version=expected_version AND box.can_discard
   AND box.approval_id IS NOT DISTINCT FROM $4 AND box.approval_version IS NOT DISTINCT FROM $5
 )
$$;
