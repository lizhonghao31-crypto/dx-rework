-- PDF generation/return monitoring retain their real audit columns. No historical backfill.
CREATE TABLE sourcing_contract_business_ready_facts (
 sourcing_contract_document_id uuid PRIMARY KEY REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
 sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
 pdf_attachment_id uuid NOT NULL REFERENCES attachments(attachment_id),
 pdf_sha256 char(64) NOT NULL CHECK(pdf_sha256 ~ '^[0-9a-f]{64}$'),
 business_ready_at timestamptz NOT NULL CHECK(isfinite(business_ready_at)),
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time)='object'),
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 is_first_for_case boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX sourcing_contract_first_business_ready ON sourcing_contract_business_ready_facts(sourcing_case_id) WHERE is_first_for_case;
CREATE FUNCTION guard_sourcing_contract_business_ready() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 document sourcing_contract_documents%ROWTYPE; file attachments%ROWTYPE; audit operation_events%ROWTYPE;
 document_xid text; audit_xid text; bound_scene uuid; scene acceptance_sla_clock_scenarios%ROWTYPE;
BEGIN
 SELECT * INTO document FROM sourcing_contract_documents WHERE sourcing_contract_document_id=NEW.sourcing_contract_document_id;
 SELECT xmin::text INTO document_xid FROM sourcing_contract_documents WHERE sourcing_contract_document_id=NEW.sourcing_contract_document_id;
 SELECT * INTO file FROM attachments WHERE attachment_id=NEW.pdf_attachment_id;
 SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
 SELECT xmin::text INTO audit_xid FROM operation_events WHERE event_id=NEW.operation_event_id;
 IF document.sourcing_contract_document_id IS NULL OR document.sourcing_case_id<>NEW.sourcing_case_id
  OR document.status<>'ready' OR document.generated_at IS DISTINCT FROM CURRENT_TIMESTAMP
  OR document_xid<>(txid_current()%4294967296)::text OR audit_xid<>(txid_current()%4294967296)::text
  OR document.pdf_attachment_id IS DISTINCT FROM NEW.pdf_attachment_id OR document.pdf_sha256 IS DISTINCT FROM NEW.pdf_sha256
  OR file.attachment_id IS NULL OR file.status IS DISTINCT FROM 'ready' OR file.entity_type IS DISTINCT FROM 'sourcing_contract_document'
  OR file.mime_type IS DISTINCT FROM 'application/pdf'
  OR file.entity_id IS DISTINCT FROM NEW.sourcing_contract_document_id::text OR file.sha256 IS DISTINCT FROM NEW.pdf_sha256
  OR audit.event_id IS NULL OR audit.action<>'sourcing.contract.business_ready'
  OR audit.entity_type<>'sourcing_contract_document' OR audit.entity_id<>NEW.sourcing_contract_document_id::text
  OR audit.after_state->>'sourcingCaseId' IS DISTINCT FROM NEW.sourcing_case_id::text
  OR audit.after_state->>'pdfAttachmentId' IS DISTINCT FROM NEW.pdf_attachment_id::text
  OR audit.after_state->>'pdfSha256' IS DISTINCT FROM NEW.pdf_sha256
  OR audit.after_state->'firstForCase' IS DISTINCT FROM to_jsonb(NEW.is_first_for_case)
  OR NEW.is_first_for_case IS DISTINCT FROM (NOT EXISTS(SELECT 1 FROM sourcing_contract_documents d
    WHERE d.sourcing_case_id=NEW.sourcing_case_id AND d.sourcing_contract_document_id<>NEW.sourcing_contract_document_id AND d.generated_at IS NOT NULL))
  OR audit.after_state->'businessTime' IS DISTINCT FROM NEW.business_time
  OR (audit.after_state->>'businessReadyAt')::timestamptz IS DISTINCT FROM NEW.business_ready_at
  OR (NEW.business_time->>'now')::timestamptz IS DISTINCT FROM NEW.business_ready_at
  OR jsonb_typeof(NEW.business_time->'revision') IS DISTINCT FROM 'number'
  OR NOT (NEW.business_time->>'revision' ~ '^[0-9]+$')
  OR NOT (NEW.business_time ?& ARRAY['now','scenarioId','revision'])
  OR NEW.business_time-ARRAY['now','scenarioId','revision']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'Contract business ready requires this first successful PDF transaction and matching audit'; END IF;
 SELECT m.scenario_id INTO bound_scene FROM digital_production_child_links l
  JOIN acceptance_sla_clock_resources m ON m.resource_kind='order' AND m.resource_id=l.production_order_id
  WHERE l.module='sourcing' AND l.child_id=NEW.sourcing_case_id;
 IF bound_scene IS NULL THEN
  IF NEW.business_time->>'scenarioId' IS NOT NULL OR (NEW.business_time->>'revision')::bigint<>0
  THEN RAISE EXCEPTION 'Ordinary contract cannot claim an Acceptance clock'; END IF;
 ELSE
  SELECT * INTO STRICT scene FROM acceptance_sla_clock_scenarios WHERE scenario_id=bound_scene;
  IF NEW.business_time->>'scenarioId' IS DISTINCT FROM bound_scene::text
   OR (NEW.business_time->>'revision')::bigint<>scene.version OR NEW.business_ready_at<>scene.business_now
   OR NOT EXISTS(SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id
     WHERE i.user_id=audit.actor_id AND u.enabled AND NOT u.manual_access_disabled
      AND i.provider='dingtalk' AND i.corp_id=scene.corporation_id AND i.provider_user_id LIKE 'uat-%'
      AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed)
  THEN RAISE EXCEPTION 'Contract business ready clock must match the original scenario and active UAT actor'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sourcing_contract_business_ready_guard BEFORE INSERT ON sourcing_contract_business_ready_facts
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_business_ready();
CREATE TRIGGER sourcing_contract_business_ready_immutable BEFORE UPDATE OR DELETE ON sourcing_contract_business_ready_facts
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
