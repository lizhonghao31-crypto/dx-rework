-- Carry the latest manual content across a real approved factory change.
CREATE FUNCTION sourcing_contract_content_for_factory_change(document_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT old_content.content || jsonb_build_object(
    'partyBName',effective_content.snapshot->>'contractEntityName','partyBAddress',effective_content.snapshot->>'address',
    'partyBRepresentative',effective_content.snapshot->>'partyBRepresentative','payeeName',effective_content.snapshot->>'payeeName',
    'bankAccount',effective_content.snapshot->>'bankAccount','bankName',effective_content.snapshot->>'bankName',
    'totalQuantity',(effective_content.snapshot->>'quantity')::integer,'totalAmount',effective_content.snapshot->'totalAmount',
    'lines',(SELECT jsonb_agg(COALESCE(manual.value,line.value) || jsonb_build_object(
        'quantity',line.value->'quantity','unitPrice',line.value->'unitPrice','totalAmount',line.value->'totalAmount')
        ORDER BY (line.value->>'position')::integer)
      FROM jsonb_array_elements(effective_content.snapshot->'lines') line(value)
      LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(old_content.content->'lines')
        WHERE value->'position'=line.value->'position') manual ON true))
  FROM sourcing_contract_documents document
  JOIN sourcing_contract_documents previous ON previous.sourcing_contract_document_id=document.revision_of
  JOIN sourcing_contract_content_overrides old_content ON old_content.sourcing_contract_document_id=previous.sourcing_contract_document_id
  CROSS JOIN LATERAL (SELECT document.approval_snapshot || COALESCE((SELECT jsonb_object_agg(field_name,field_value)
    FROM sourcing_contract_supplements WHERE sourcing_contract_document_id=document.sourcing_contract_document_id),'{}'::jsonb) AS snapshot) effective_content
  WHERE document.sourcing_contract_document_id=document_id;
$$;
CREATE OR REPLACE FUNCTION guard_sourcing_contract_content_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document sourcing_contract_documents%ROWTYPE; previous sourcing_contract_documents%ROWTYPE;
  event operation_events%ROWTYPE; old_content jsonb; expected jsonb; template sourcing_contract_template_versions%ROWTYPE;
BEGIN
  SELECT * INTO document FROM sourcing_contract_documents WHERE sourcing_contract_document_id=NEW.sourcing_contract_document_id;
  -- Serialize with finance reconciliation and all other order writes.
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=document.sourcing_case_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract order does not exist' USING ERRCODE='23514'; END IF;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF event.action IN ('sourcing.factory_change.effective','sourcing.owner.approve') THEN
    SELECT * INTO previous FROM sourcing_contract_documents WHERE sourcing_contract_document_id=document.revision_of;
    IF event.entity_type<>'sourcing_case' OR event.entity_id<>document.sourcing_case_id::text
      OR event.actor_id<>document.prepared_by OR document.status<>'generation_pending'
      OR document.template_version<>previous.template_version
      OR previous.sourcing_case_id IS DISTINCT FROM document.sourcing_case_id
      OR previous.sourcing_contract_document_id IS DISTINCT FROM (
        SELECT d.sourcing_contract_document_id FROM sourcing_contract_documents d
        WHERE d.sourcing_decision_id=previous.sourcing_decision_id ORDER BY d.contract_version DESC LIMIT 1)
      OR NOT EXISTS(SELECT 1 FROM sourcing_approval_snapshots snapshot
        JOIN sourcing_decisions decision ON decision.sourcing_decision_id=snapshot.sourcing_decision_id
        JOIN sourcing_factory_change_requests change ON change.factory_change_request_id=decision.source_change_request_id
        WHERE snapshot.sourcing_approval_snapshot_id=document.sourcing_approval_snapshot_id
          AND snapshot.operation_event_id=event.event_id AND snapshot.approved_by=document.prepared_by
          AND decision.sourcing_decision_id=document.sourcing_decision_id AND decision.source_type='factory_change'
          AND decision.supersedes_decision_id=previous.sourcing_decision_id AND change.from_decision_id=previous.sourcing_decision_id
          AND decision.sourcing_case_id=document.sourcing_case_id AND change.sourcing_case_id=document.sourcing_case_id)
      OR NEW.content IS DISTINCT FROM sourcing_contract_content_for_factory_change(document.sourcing_contract_document_id)
      OR NOT EXISTS(SELECT 1 FROM sourcing_contract_content_overrides WHERE sourcing_contract_document_id=document.revision_of)
    THEN RAISE EXCEPTION 'factory change may only inherit its latest approved source contract content' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
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
