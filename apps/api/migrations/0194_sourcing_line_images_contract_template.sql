-- Bind optional style pictures to stable line positions. Never guess historical matches.
ALTER TABLE sourcing_case_lines ADD COLUMN image_attachment_id uuid REFERENCES attachments(attachment_id);
CREATE FUNCTION guard_sourcing_line_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.image_attachment_id IS NOT NULL AND (
    NOT EXISTS(SELECT 1 FROM attachments image WHERE image.attachment_id=NEW.image_attachment_id
      AND image.status='ready' AND image.uploaded_by=NEW.created_by
      AND image.entity_type='sourcing_case' AND image.entity_id=NEW.sourcing_case_id::text
      AND image.mime_type IN ('image/jpeg','image/png','image/webp'))
    OR NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=NEW.operation_event_id
      AND event.after_state #>> ARRAY['lineItems',(NEW.position-1)::text,'imageAttachmentId']=NEW.image_attachment_id::text)
  ) THEN RAISE EXCEPTION 'style picture must match bound order evidence and creation audit' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER sourcing_case_line_image_guard AFTER INSERT ON sourcing_case_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_sourcing_line_image();

CREATE OR REPLACE VIEW current_sourcing_case_lines AS
SELECT line.sourcing_case_id,line.position,
  COALESCE(identity.style_no,identity.alternate_style_no) AS style_no,
  identity.style_no AS formal_style_no,identity.alternate_style_no,
  line.color,line.quantity,line.external_unit_price,line.legacy_source,line.image_attachment_id
FROM sourcing_case_lines line
LEFT JOIN LATERAL (SELECT revision,lines FROM sourcing_style_revisions
  WHERE sourcing_case_id=line.sourcing_case_id ORDER BY revision DESC LIMIT 1) latest ON true
LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(latest.lines)
  WHERE (value->>'position')::integer=line.position) revised ON true
CROSS JOIN LATERAL (SELECT
  CASE WHEN latest.revision IS NULL THEN line.style_no ELSE revised.value->>'styleNo' END AS style_no,
  CASE WHEN latest.revision IS NULL THEN line.alternate_style_no ELSE revised.value->>'alternateStyleNo' END AS alternate_style_no
) identity;

INSERT INTO sourcing_contract_template_versions(template_version,template_name,party_a_name,party_a_address,signing_place,terms,effective_from)
SELECT 3,'服装加工合同 V3（逐款图片与日期相邻）',party_a_name,party_a_address,signing_place,
  jsonb_set(terms,'{qualityRequirements}',to_jsonb(replace(terms->>'qualityRequirements','费用有乙方承担','费用由乙方承担'))),CURRENT_TIMESTAMP
FROM sourcing_contract_template_versions WHERE template_version=2;

-- Append corrected current contracts for startup's existing PDF generation queue.
-- The original documents, attachments, approvals and recorded reconciliations remain unchanged.
INSERT INTO sourcing_contract_documents(
  sourcing_contract_document_id,sourcing_case_id,sourcing_approval_snapshot_id,sourcing_decision_id,
  contract_version,contract_number,template_version,approval_snapshot,missing_fields,status,prepared_by,
  identity_version,revision_of)
SELECT gen_random_uuid(),document.sourcing_case_id,document.sourcing_approval_snapshot_id,document.sourcing_decision_id,
  document.contract_version+1,
  'DX-WF-'||to_char(snapshot.approved_at AT TIME ZONE 'Asia/Shanghai','YYYYMMDD')||'-'||lpad(nextval('sourcing_contract_number_seq')::text,6,'0'),
  3,document.approval_snapshot || COALESCE(supplements.values,'{}'::jsonb),document.missing_fields,
  CASE WHEN cardinality(document.missing_fields)>0 THEN 'pending_supplement' ELSE 'generation_pending' END,
  document.prepared_by,document.identity_version,document.sourcing_contract_document_id
FROM sourcing_contract_documents document
JOIN sourcing_cases source USING(sourcing_case_id)
JOIN sourcing_approval_snapshots snapshot USING(sourcing_approval_snapshot_id)
LEFT JOIN LATERAL(SELECT jsonb_object_agg(field_name,field_value) AS values FROM sourcing_contract_supplements
  WHERE sourcing_contract_document_id=document.sourcing_contract_document_id) supplements ON true
WHERE source.deleted_at IS NULL AND document.template_version<3
  AND document.contract_version=(SELECT max(current.contract_version) FROM sourcing_contract_documents current WHERE current.sourcing_case_id=document.sourcing_case_id);
