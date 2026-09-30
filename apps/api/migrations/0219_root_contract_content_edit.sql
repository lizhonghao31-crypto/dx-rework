-- Root edits are separate immutable contract snapshots; approved business facts stay frozen.
CREATE TABLE sourcing_contract_content_overrides (
  sourcing_contract_document_id uuid PRIMARY KEY REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
  content jsonb NOT NULL CHECK (jsonb_typeof(content)='object'),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Existing style revisions update only the labels explicitly changed by that operation.
CREATE FUNCTION sourcing_contract_content_for_style_revision(document_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT old_content.content || jsonb_build_object('lines',(
    SELECT jsonb_agg(CASE WHEN current_line.value->'styleNo' IS DISTINCT FROM previous_line.value->'styleNo'
      OR current_line.value->'alternateStyleNo' IS DISTINCT FROM previous_line.value->'alternateStyleNo'
      THEN manual.value || jsonb_build_object('styleNo',COALESCE(current_line.value->>'styleNo',''),
        'alternateStyleNo',current_line.value->'alternateStyleNo') ELSE manual.value END ORDER BY manual.ordinality)
    FROM jsonb_array_elements(old_content.content->'lines') WITH ORDINALITY manual(value,ordinality)
    LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(document.approval_snapshot->'lines')
      WHERE value->'position'=manual.value->'position') current_line ON true
    LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(previous.approval_snapshot->'lines')
      WHERE value->'position'=manual.value->'position') previous_line ON true
  ))
  FROM sourcing_contract_documents document JOIN sourcing_contract_documents previous ON previous.sourcing_contract_document_id=document.revision_of
  JOIN sourcing_contract_content_overrides old_content ON old_content.sourcing_contract_document_id=document.revision_of
  WHERE document.sourcing_contract_document_id=document_id;
$$;
CREATE FUNCTION guard_sourcing_contract_content_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document sourcing_contract_documents%ROWTYPE; previous sourcing_contract_documents%ROWTYPE;
  event operation_events%ROWTYPE; old_content jsonb; expected jsonb; template sourcing_contract_template_versions%ROWTYPE;
BEGIN
  SELECT * INTO document FROM sourcing_contract_documents WHERE sourcing_contract_document_id=NEW.sourcing_contract_document_id;
  -- Serialize with finance reconciliation and all other order writes.
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=document.sourcing_case_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract order does not exist' USING ERRCODE='23514'; END IF;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF event.action='sourcing.styles.revise' THEN
    SELECT * INTO previous FROM sourcing_contract_documents WHERE sourcing_contract_document_id=document.revision_of;
    IF NOT EXISTS(SELECT 1 FROM sourcing_style_revisions r WHERE r.sourcing_case_id=document.sourcing_case_id
        AND r.revision=document.identity_version AND r.operation_event_id=event.event_id AND r.changed_by=document.prepared_by)
      OR document.identity_version<=previous.identity_version
      OR document.sourcing_approval_snapshot_id IS DISTINCT FROM previous.sourcing_approval_snapshot_id
      OR document.sourcing_decision_id IS DISTINCT FROM previous.sourcing_decision_id
      OR document.status<>'generation_pending'
      OR NEW.content IS DISTINCT FROM sourcing_contract_content_for_style_revision(document.sourcing_contract_document_id)
    THEN RAISE EXCEPTION 'style revision may only carry unchanged contract content' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF event.event_id IS NULL OR event.action<>'sourcing.contract.information.refresh'
    OR event.entity_type<>'sourcing_contract_document' OR event.entity_id<>document.sourcing_contract_document_id::text
    OR event.actor_id<>document.prepared_by OR document.information_refresh_event_id IS DISTINCT FROM event.event_id
    OR event.after_state->'content' IS DISTINCT FROM NEW.content OR document.status<>'generation_pending'
  THEN RAISE EXCEPTION 'contract content requires matching creation audit' USING ERRCODE='42501'; END IF;
  IF event.after_state->>'mode'='manual_content' THEN
    IF NOT event.actor_roles @> ARRAY['root_superuser']::text[] OR EXISTS(
      SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_case_id=document.sourcing_case_id
    ) THEN RAISE EXCEPTION 'only root before finance reconciliation may edit contract content' USING ERRCODE='42501'; END IF;
  ELSIF event.after_state->>'mode'='inherit_content' THEN
    SELECT * INTO previous FROM sourcing_contract_documents WHERE sourcing_contract_document_id=document.revision_of;
    SELECT content INTO old_content FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=document.revision_of;
    expected:=old_content || jsonb_build_object(
      'partyBName',document.approval_snapshot->>'contractEntityName','partyBAddress',document.approval_snapshot->>'address',
      'partyBRepresentative',document.approval_snapshot->>'partyBRepresentative','payeeName',document.approval_snapshot->>'payeeName',
      'bankAccount',document.approval_snapshot->>'bankAccount','bankName',document.approval_snapshot->>'bankName');
    IF document.template_version<>previous.template_version THEN
      SELECT * INTO template FROM sourcing_contract_template_versions WHERE template_version=document.template_version;
      expected:=expected || jsonb_build_object('partyAName',template.party_a_name,'partyAAddress',template.party_a_address,
        'signingPlace',template.signing_place,'terms',template.terms);
    END IF;
    IF old_content IS NULL OR NEW.content IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'supplier refresh may only carry forward existing contract content' USING ERRCODE='42501'; END IF;
  ELSE RAISE EXCEPTION 'unknown contract content operation' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_contract_content_creation BEFORE INSERT ON sourcing_contract_content_overrides
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_content_creation();
CREATE TRIGGER sourcing_contract_content_no_update BEFORE UPDATE ON sourcing_contract_content_overrides
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_content_no_delete BEFORE DELETE ON sourcing_contract_content_overrides
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_content_no_truncate BEFORE TRUNCATE ON sourcing_contract_content_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
