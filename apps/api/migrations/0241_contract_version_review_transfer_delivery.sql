-- Contract content edits respect the reviewed document version, preserving historical records.
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
      SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_contract_document_id=document.revision_of
    ) THEN RAISE EXCEPTION 'only root before current contract reconciliation may edit contract content' USING ERRCODE='42501'; END IF;
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

-- Date proposals are immutable request facts; they become effective only with approval.
CREATE OR REPLACE FUNCTION guard_sourcing_transfer_delivery_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event operation_events%ROWTYPE; source record; current_date_value date; proposed date;
BEGIN
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF NOT (event.after_state ? 'deliveryDate') THEN RETURN NEW; END IF;
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source FROM sourcing_case_facts_at(NEW.sourcing_case_id);
  current_date_value:=sourcing_effective_delivery_date(NEW.sourcing_case_id,source.delivery_date);
  proposed:=(event.after_state->>'deliveryDate')::date;
  IF event.after_state->>'baseDeliveryDate' IS DISTINCT FROM current_date_value::text
    OR proposed<source.estimated_cut_piece_send_date THEN
    RAISE EXCEPTION 'transfer delivery date requires the current basis and valid send date' USING ERRCODE='23514';
  END IF;
  IF proposed IS DISTINCT FROM current_date_value AND NOT (
    event.actor_roles @> ARRAY['root_superuser']::text[] OR event.actor_roles @> ARRAY['production_management']::text[]
  ) THEN RAISE EXCEPTION 'only root or production management may change transfer delivery date' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sourcing_transfer_delivery_request ON sourcing_factory_change_requests;
CREATE TRIGGER sourcing_transfer_delivery_request BEFORE INSERT ON sourcing_factory_change_requests
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_transfer_delivery_request();

CREATE OR REPLACE FUNCTION guard_sourcing_transfer_delivery_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proposal jsonb;
BEGIN
  SELECT e.after_state INTO proposal FROM sourcing_decisions d
  JOIN sourcing_factory_change_requests r ON r.factory_change_request_id=d.source_change_request_id
  JOIN operation_events e ON e.event_id=r.operation_event_id
  WHERE d.sourcing_decision_id=NEW.sourcing_decision_id AND d.source_type='factory_change';
  IF proposal ? 'deliveryDate' AND (
    NEW.delivery_date IS DISTINCT FROM (proposal->>'deliveryDate')::date
    OR NEW.delivery_date<NEW.estimated_cut_piece_send_date
  ) THEN RAISE EXCEPTION 'approved transfer delivery must match the authorized request' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sourcing_transfer_delivery_approval ON sourcing_approval_snapshots;
CREATE TRIGGER sourcing_transfer_delivery_approval BEFORE INSERT ON sourcing_approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_transfer_delivery_approval();

-- Current and historical reads follow the associated approved contract version.
CREATE OR REPLACE FUNCTION sourcing_effective_delivery_date(case_id uuid, fallback_date date, at_time timestamptz DEFAULT NULL)
RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE edited text; earliest date;
BEGIN
  SELECT min(CASE WHEN at_time IS NULL THEN po.factory_delivery_date ELSE (
    SELECT fact.new_date FROM digital_po_date_changes fact WHERE fact.line_id=po.line_id AND fact.date_kind='factory'
      AND fact.created_at<=at_time ORDER BY fact.version DESC LIMIT 1) END) INTO earliest
  FROM digital_production_child_lines child JOIN digital_production_po_lines po USING(production_order_id,line_id)
  WHERE child.module='sourcing' AND child.child_id=case_id;
  IF earliest IS NOT NULL THEN RETURN earliest; END IF;
  SELECT COALESCE(content.content->>'deliveryDate',document.approval_snapshot->>'deliveryDate') INTO edited
  FROM sourcing_contract_documents document LEFT JOIN sourcing_contract_content_overrides content USING(sourcing_contract_document_id)
  WHERE document.sourcing_case_id=case_id AND (at_time IS NULL OR document.prepared_at<=at_time)
  ORDER BY document.contract_version DESC LIMIT 1;
  IF edited IS NULL OR edited !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN fallback_date; END IF;
  RETURN edited::date;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN fallback_date;
END $$;


-- Reopen review only for an authorized new Root revision; all existing transitions stay unchanged.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
 WHERE conrelid='sourcing_case_transitions'::regclass AND contype='c' LOOP
  IF c.definition LIKE '%business_action%' AND c.definition NOT LIKE '%contract_content_revised%' THEN
   EXECUTE format('ALTER TABLE sourcing_case_transitions DROP CONSTRAINT %I',c.conname);
   c.definition:=replace(c.definition,'''created''::text','''created''::text, ''contract_content_revised''::text');
   EXECUTE format('ALTER TABLE sourcing_case_transitions ADD CONSTRAINT %I %s',c.conname,c.definition);
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION guard_sourcing_transition_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_transition sourcing_case_transitions%ROWTYPE;
  expected_from text;
  expected_to text;
  expected_event_action text;
  expected_capability text;
  supporting_fact_exists boolean := true;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO previous_transition
  FROM sourcing_case_transitions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF previous_transition.sourcing_transition_id IS NULL THEN
    IF NEW.sequence<>1 OR NEW.from_status IS NOT NULL
      OR NEW.to_status<>'pending_ie_quote' OR NEW.business_action<>'created' THEN
      RAISE EXCEPTION 'first sourcing transition must create a pending IE quote case'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.sequence<>previous_transition.sequence+1
    OR NEW.from_status IS DISTINCT FROM previous_transition.to_status THEN
    RAISE EXCEPTION 'sourcing transitions must be sequential from current state'
      USING ERRCODE='23514';
  END IF;

  IF NEW.business_action='contract_content_revised' THEN
    IF NEW.from_status NOT IN ('closed','pending_exception_verification') OR NEW.to_status<>'pending_finance_reconciliation' THEN
      RAISE EXCEPTION 'contract revision must reopen the financial review stage' USING ERRCODE='23514';
    END IF;
    PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.actor_id,
      'sourcing.contract.content.revise','sourcing:contract:record',NEW.sourcing_case_id,NEW.transition_reason);
    IF NOT EXISTS(SELECT 1 FROM operation_events e
      JOIN sourcing_contract_documents d ON d.sourcing_contract_document_id=(e.after_state->>'documentId')::uuid
      JOIN sourcing_contract_content_overrides c USING(sourcing_contract_document_id)
      JOIN operation_events edit ON edit.event_id=c.operation_event_id
      WHERE e.event_id=NEW.operation_event_id AND e.actor_roles @> ARRAY['root_superuser']::text[]
        AND d.sourcing_case_id=NEW.sourcing_case_id AND d.prepared_by=NEW.actor_id
        AND d.revision_of::text=e.before_state->>'documentId' AND edit.after_state->>'mode'='manual_content'
        AND d.status='generation_pending' AND d.sourcing_contract_document_id=(SELECT sourcing_contract_document_id
          FROM sourcing_contract_documents WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY contract_version DESC LIMIT 1)
    ) THEN RAISE EXCEPTION 'financial review reopen requires the new root contract revision' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;

  IF NEW.business_action IN ('returned_to_merchandiser','correction_submitted') THEN
    IF EXISTS(SELECT 1 FROM sourcing_approval_snapshots WHERE sourcing_case_id=NEW.sourcing_case_id) THEN
      RAISE EXCEPTION 'approved facts cannot be returned' USING ERRCODE='55000';
    END IF;
    IF NEW.business_action='returned_to_merchandiser' THEN
      IF NEW.from_status NOT IN ('pending_ie_quote','pending_management_decision','pending_owner_approval')
        OR NEW.to_status<>'pending_merchandiser_correction' THEN
        RAISE EXCEPTION 'invalid correction return' USING ERRCODE='23514'; END IF;
      PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.actor_id,
        'sourcing.case.return','sourcing:owner:approve',NEW.sourcing_case_id,NEW.transition_reason);
      IF NOT EXISTS(SELECT 1 FROM operation_events WHERE event_id=NEW.operation_event_id
        AND (actor_roles && ARRAY['root_superuser','owner_group']::text[])) THEN
        RAISE EXCEPTION 'return requires owner authority' USING ERRCODE='55000'; END IF;
    ELSE
      IF NEW.from_status<>'pending_merchandiser_correction' OR NEW.to_status<>'pending_ie_quote'
        OR NOT EXISTS(SELECT 1 FROM sourcing_case_corrections WHERE operation_event_id=NEW.operation_event_id
          AND sourcing_case_id=NEW.sourcing_case_id) THEN
        RAISE EXCEPTION 'resubmission requires correction fact' USING ERRCODE='23514'; END IF;
      PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.actor_id,
        'sourcing.case.correct','sourcing:inquiry:create',NEW.sourcing_case_id,NEW.transition_reason);
    END IF;
    IF NEW.transition_reason IS NULL OR length(btrim(NEW.transition_reason)) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'correction reason required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;

  IF NEW.business_action='factory_change_effective' THEN
    IF NOT (
      (NEW.from_status='pending_management_decision'
        AND NEW.to_status IN ('pending_owner_approval','pending_finance_reconciliation'))
      OR (NEW.from_status IN (
        'pending_owner_approval','pending_factory_change_verification',
        'pending_exception_verification','closed'
      ) AND NEW.to_status='pending_finance_reconciliation')
    )
      OR NOT EXISTS (
        SELECT 1
        FROM sourcing_decisions decision_row
        JOIN sourcing_factory_change_requests request_row
          ON request_row.factory_change_request_id=decision_row.source_change_request_id
        WHERE decision_row.sourcing_case_id=NEW.sourcing_case_id
          AND decision_row.operation_event_id=NEW.operation_event_id
          AND decision_row.source_type='factory_change'
      )
      OR NOT EXISTS (
        SELECT 1 FROM operation_events event_row
        WHERE event_row.event_id=NEW.operation_event_id
          AND event_row.request_id=NEW.request_id
          AND event_row.actor_id=NEW.actor_id
          AND event_row.action='sourcing.factory_change.effective'
          AND event_row.authorization_capability IN (
            'sourcing:decision:record','sourcing:factory_change:verify','sourcing:owner:approve'
          )
          AND event_row.entity_type='sourcing_case'
          AND event_row.entity_id=NEW.sourcing_case_id::text
          AND event_row.reason IS NOT DISTINCT FROM NEW.transition_reason
          AND (
            NEW.from_status<>'pending_management_decision'
            OR (
              event_row.authorization_capability='sourcing:owner:approve'
              AND NEW.to_status='pending_finance_reconciliation'
            )
            OR (
              event_row.authorization_capability<>'sourcing:owner:approve'
              AND NEW.to_status='pending_owner_approval'
            )
          )
      ) THEN
      RAISE EXCEPTION 'effective factory change must refresh the approved decision'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT rule.from_status,rule.to_status,rule.event_action,rule.capability
  INTO expected_from,expected_to,expected_event_action,expected_capability
  FROM (VALUES
    ('created',NULL::text,'pending_ie_quote','sourcing.case.create','sourcing:inquiry:create'),
    ('ie_price_quoted','pending_ie_quote','pending_management_decision','sourcing.ie_price.quote','sourcing:price:quote'),
    ('management_decision_recorded','pending_management_decision','pending_owner_approval','sourcing.management_decision.record','sourcing:decision:record'),
    ('owner_approved','pending_owner_approval','pending_finance_reconciliation','sourcing.owner.approve','sourcing:owner:approve'),
    ('owner_rejected','pending_owner_approval','pending_management_decision','sourcing.owner.reject','sourcing:owner:approve'),
    ('contract_recorded','pending_contract','pending_finance_reconciliation','sourcing.contract.record','sourcing:contract:record'),
    ('contract_stage_retired','pending_contract','pending_finance_reconciliation','sourcing.contract_stage.retire','system:migration'),
    ('factory_change_requested','pending_finance_reconciliation','pending_factory_change_verification','sourcing.factory_change.request','sourcing:factory_change:request'),
    ('factory_change_approved','pending_factory_change_verification','pending_finance_reconciliation','sourcing.factory_change.approved','sourcing:factory_change:verify'),
    ('factory_change_rejected','pending_factory_change_verification','pending_finance_reconciliation','sourcing.factory_change.rejected','sourcing:factory_change:verify'),
    ('finance_matched','pending_finance_reconciliation','closed','sourcing.finance.matched','sourcing:finance:reconcile'),
    ('finance_difference','pending_finance_reconciliation','pending_exception_verification','sourcing.finance.difference','sourcing:finance:reconcile'),
    ('exception_reopened_for_contract','pending_exception_verification','pending_contract','sourcing.exception.reopen_contract','sourcing:exception:verify'),
    ('exception_reopened_for_reconciliation','pending_exception_verification','pending_finance_reconciliation','sourcing.exception.reopen_reconciliation','sourcing:exception:verify'),
    ('exception_closed','pending_exception_verification','closed','sourcing.exception.close','sourcing:exception:verify')
  ) AS rule(action,from_status,to_status,event_action,capability)
  WHERE rule.action=NEW.business_action;

  IF expected_event_action IS NULL
    OR NEW.from_status IS DISTINCT FROM expected_from
    OR NEW.to_status<>expected_to THEN
    RAISE EXCEPTION 'sourcing state transition is not allowed'
      USING ERRCODE='23514';
  END IF;

  supporting_fact_exists := CASE NEW.business_action
    WHEN 'created' THEN EXISTS(
      SELECT 1 FROM sourcing_cases source_case
      WHERE source_case.sourcing_case_id=NEW.sourcing_case_id
        AND source_case.operation_event_id=NEW.operation_event_id
    )
    WHEN 'ie_price_quoted' THEN EXISTS(
      SELECT 1 FROM sourcing_ie_quotes quote_row
      WHERE quote_row.sourcing_case_id=NEW.sourcing_case_id
        AND quote_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'management_decision_recorded' THEN EXISTS(
      SELECT 1 FROM sourcing_decisions decision_row
      WHERE decision_row.sourcing_case_id=NEW.sourcing_case_id
        AND decision_row.operation_event_id=NEW.operation_event_id
        AND decision_row.source_type IN ('initial','management_revision')
    )
    WHEN 'owner_approved' THEN EXISTS(
      SELECT 1 FROM sourcing_owner_decisions owner_decision
      WHERE owner_decision.sourcing_case_id=NEW.sourcing_case_id
        AND owner_decision.operation_event_id=NEW.operation_event_id
        AND owner_decision.decision='approved'
    )
    WHEN 'owner_rejected' THEN EXISTS(
      SELECT 1 FROM sourcing_owner_decisions owner_decision
      WHERE owner_decision.sourcing_case_id=NEW.sourcing_case_id
        AND owner_decision.operation_event_id=NEW.operation_event_id
        AND owner_decision.decision='rejected'
    )
    WHEN 'contract_stage_retired' THEN true
    WHEN 'contract_recorded' THEN EXISTS(
      SELECT 1 FROM sourcing_contract_executions contract_row
      WHERE contract_row.sourcing_case_id=NEW.sourcing_case_id
        AND contract_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'factory_change_requested' THEN EXISTS(
      SELECT 1 FROM sourcing_factory_change_requests request_row
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND request_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'factory_change_approved' THEN EXISTS(
      SELECT 1
      FROM sourcing_factory_change_decisions verification
      JOIN sourcing_factory_change_requests request_row
        ON request_row.factory_change_request_id=verification.factory_change_request_id
      JOIN sourcing_decisions decision_row
        ON decision_row.source_change_request_id=request_row.factory_change_request_id
       AND decision_row.operation_event_id=verification.operation_event_id
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND verification.operation_event_id=NEW.operation_event_id
        AND verification.decision='approved'
    )
    WHEN 'factory_change_rejected' THEN EXISTS(
      SELECT 1
      FROM sourcing_factory_change_decisions verification
      JOIN sourcing_factory_change_requests request_row
        ON request_row.factory_change_request_id=verification.factory_change_request_id
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND verification.operation_event_id=NEW.operation_event_id
        AND verification.decision='rejected'
    )
    WHEN 'finance_matched' THEN EXISTS(
      SELECT 1 FROM sourcing_finance_reconciliations reconciliation
      WHERE reconciliation.sourcing_case_id=NEW.sourcing_case_id
        AND reconciliation.operation_event_id=NEW.operation_event_id
        AND reconciliation.result='match'
    )
    WHEN 'finance_difference' THEN EXISTS(
      SELECT 1 FROM sourcing_finance_reconciliations reconciliation
      WHERE reconciliation.sourcing_case_id=NEW.sourcing_case_id
        AND reconciliation.operation_event_id=NEW.operation_event_id
        AND reconciliation.result='difference'
    )
    ELSE true
  END;

  IF supporting_fact_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sourcing transition requires its matching immutable business fact'
      USING ERRCODE='55000';
  END IF;

  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.actor_id,
    expected_event_action,expected_capability,
    NEW.sourcing_case_id,NEW.transition_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sourcing_contract_content_for_factory_change(document_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT old_content.content || jsonb_build_object(
    'partyBName',effective_content.snapshot->>'contractEntityName','partyBAddress',effective_content.snapshot->>'address',
    'partyBRepresentative',effective_content.snapshot->>'partyBRepresentative','payeeName',effective_content.snapshot->>'payeeName',
    'bankAccount',effective_content.snapshot->>'bankAccount','bankName',effective_content.snapshot->>'bankName',
    'deliveryDate',effective_content.snapshot->>'deliveryDate',
    'totalQuantity',(effective_content.snapshot->>'quantity')::integer,'totalAmount',effective_content.snapshot->'totalAmount',
    'lines',(SELECT jsonb_agg(COALESCE(manual.value,line.value) || jsonb_build_object(
        'quantity',line.value->'quantity','unitPrice',line.value->'unitPrice','totalAmount',line.value->'totalAmount')
        || CASE WHEN line.value ? 'lineId' AND line.value ? 'deliveryDate'
          THEN jsonb_build_object('lineId',line.value->'lineId','deliveryDate',line.value->'deliveryDate') ELSE '{}'::jsonb END
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


-- A financial review locks its current document. A new approved transfer can
-- activate the explicitly frozen promise before its new contract is prepared.
CREATE FUNCTION sourcing_authorized_transfer_po_snapshot(audit_id uuid,po_line_id uuid,new_date date) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE audit audit_events%ROWTYPE; approved uuid;
BEGIN
 SELECT * INTO audit FROM audit_events WHERE id=audit_id;
 IF audit.action IS DISTINCT FROM 'digital_po_factory_dates_approved' OR NOT (audit.after_state ? 'sourceOperationEventId') THEN RETURN NULL; END IF;
 SELECT snapshot.sourcing_approval_snapshot_id INTO approved
 FROM operation_events source JOIN sourcing_approval_snapshots snapshot ON snapshot.operation_event_id=source.event_id
 JOIN sourcing_decisions decision ON decision.sourcing_decision_id=snapshot.sourcing_decision_id
 JOIN sourcing_factory_change_requests request ON request.factory_change_request_id=decision.source_change_request_id
 JOIN operation_events proposal ON proposal.event_id=request.operation_event_id
 JOIN digital_production_child_lines child ON child.module='sourcing' AND child.child_id=snapshot.sourcing_case_id AND child.line_id=po_line_id
 JOIN sourcing_decision_lines transferred ON transferred.sourcing_decision_id=decision.sourcing_decision_id AND transferred.position=child.child_line_key::integer
 WHERE source.event_id=(audit.after_state->>'sourceOperationEventId')::uuid
   AND source.action IN ('sourcing.factory_change.effective','sourcing.owner.approve')
   AND source.actor_id=audit.actor_id AND source.request_id=audit.request_id
   AND source.entity_type='sourcing_case' AND source.entity_id=snapshot.sourcing_case_id::text
   AND audit.after_state->>'sourcingCaseId'=snapshot.sourcing_case_id::text
   AND audit.entity_id=child.production_order_id::text
   AND decision.source_type='factory_change'
   AND decision.decision_version=(SELECT max(d.decision_version) FROM sourcing_decisions d WHERE d.sourcing_case_id=decision.sourcing_case_id)
   AND (proposal.actor_roles @> ARRAY['root_superuser']::text[] OR proposal.actor_roles @> ARRAY['production_management']::text[])
   AND proposal.after_state->>'deliveryDate'=new_date::text
   AND snapshot.delivery_date=new_date
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(proposal.after_state->'transferPoDates') frozen(value)
     WHERE value->>'lineId'=po_line_id::text AND value->>'date'=new_date::text);
 RETURN approved;
END $$;
CREATE FUNCTION sourcing_po_factory_date_locked(order_id uuid,po_line_id uuid,audit_id uuid,new_date date) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE transfer_snapshot uuid;
BEGIN
 transfer_snapshot:=sourcing_authorized_transfer_po_snapshot(audit_id,po_line_id,new_date);
 RETURN EXISTS(SELECT 1 FROM digital_production_child_lines child
   JOIN LATERAL (SELECT d.sourcing_contract_document_id,d.sourcing_approval_snapshot_id FROM sourcing_contract_documents d
     WHERE d.sourcing_case_id=child.child_id ORDER BY d.contract_version DESC LIMIT 1) current_document ON true
   JOIN sourcing_finance_reconciliations finance ON finance.sourcing_contract_document_id=current_document.sourcing_contract_document_id
   WHERE child.module='sourcing' AND child.production_order_id=order_id AND child.line_id=po_line_id
     AND (transfer_snapshot IS NULL OR current_document.sourcing_approval_snapshot_id=transfer_snapshot
       OR child.child_id IS DISTINCT FROM (SELECT sourcing_case_id FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=transfer_snapshot)));
END $$;

CREATE OR REPLACE FUNCTION guard_digital_po_date_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line digital_production_po_lines%ROWTYPE; approval audit_events%ROWTYPE;
 current_date_value date; current_version integer; expected_action text;
BEGIN
 IF NEW.date_kind='factory' THEN
   PERFORM s.sourcing_case_id FROM sourcing_cases s JOIN digital_production_child_links link
     ON link.module='sourcing' AND link.child_id=s.sourcing_case_id
     WHERE link.production_order_id=NEW.production_order_id ORDER BY s.sourcing_case_id FOR UPDATE OF s;
   IF sourcing_po_factory_date_locked(NEW.production_order_id,NEW.line_id,NEW.approval_event_id,NEW.new_date) THEN
     RAISE EXCEPTION 'current contract finance reconciliation locks the factory promise' USING ERRCODE='55000';
   END IF;
 END IF;
 SELECT * INTO line FROM digital_production_po_lines WHERE line_id=NEW.line_id FOR UPDATE;
 SELECT * INTO approval FROM audit_events WHERE id=NEW.approval_event_id;
 current_date_value:=CASE NEW.date_kind WHEN 'customer' THEN line.customer_warehouse_arrival_date ELSE line.factory_delivery_date END;
 current_version:=CASE NEW.date_kind WHEN 'customer' THEN line.customer_date_version ELSE line.factory_date_version END;
 expected_action:=CASE NEW.source WHEN 'initial_po' THEN 'digital_order_created'
   WHEN 'approved_customer_change' THEN 'digital_po_customer_dates_approved' ELSE 'digital_po_factory_dates_approved' END;
 IF line.production_order_id IS DISTINCT FROM NEW.production_order_id
   OR current_date_value IS DISTINCT FROM NEW.old_date OR NEW.version<>current_version+1
   OR approval.id IS NULL OR approval.actor_id IS DISTINCT FROM NEW.changed_by
   OR approval.request_id IS DISTINCT FROM NEW.request_id OR approval.action IS DISTINCT FROM expected_action
   OR approval.entity_type IS DISTINCT FROM 'digital_production'
   OR approval.entity_id IS DISTINCT FROM NEW.production_order_id::text
   OR (NEW.date_kind='customer' AND NEW.source='approved_factory_change')
   OR (NEW.date_kind='factory' AND NEW.source<>'approved_factory_change') THEN
   RAISE EXCEPTION 'PO date changes require the current version and matching approval audit' USING ERRCODE='55000';
 END IF;
 IF NEW.source='initial_po' THEN
   IF NEW.version<>1 OR NEW.old_date IS NOT NULL OR NEW.date_kind<>'customer'
     OR NEW.new_date::text IS DISTINCT FROM COALESCE(
       approval.after_state->'lines'->(line.position-1)->>'customerWarehouseArrivalDate',
       approval.after_state->'lines'->(line.position-1)->>'deliveryDate') THEN
     RAISE EXCEPTION 'initial PO date must be explicitly recorded on this creation' USING ERRCODE='55000';
   END IF;
 ELSE
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(approval.after_state->'dateChanges') evidence(change)
     WHERE evidence.change->>'lineId'=NEW.line_id::text
       AND evidence.change->>'dateKind'=NEW.date_kind
       AND evidence.change->>'oldDate' IS NOT DISTINCT FROM NEW.old_date::text
       AND evidence.change->>'date'=NEW.new_date::text
       AND evidence.change->>'expectedVersion'=current_version::text) THEN
     RAISE EXCEPTION 'PO date must match the exact approved line and date' USING ERRCODE='55000';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;

-- Manual edits preserve the template actually applied; only explicit refresh advances it.
CREATE OR REPLACE FUNCTION guard_sourcing_contract_information_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous sourcing_contract_documents%ROWTYPE; event operation_events%ROWTYPE;
  creator uuid; returned boolean; fields text[]:=ARRAY['supplierName','supplierCode','address','contractEntityName','partyBRepresentative','payeeName','bankAccount','bankName'];
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.information_revision<>OLD.information_revision OR NEW.information_refresh_event_id IS DISTINCT FROM OLD.information_refresh_event_id THEN
      RAISE EXCEPTION 'contract supplier revision is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.information_revision=0 AND NEW.information_refresh_event_id IS NULL THEN RETURN NEW; END IF;
  SELECT created_by INTO creator FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id AND deleted_at IS NULL FOR UPDATE;
  PERFORM 1 FROM sourcing_contract_return_monitors WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  returned:=EXISTS(SELECT 1 FROM sourcing_contract_return_submissions WHERE sourcing_case_id=NEW.sourcing_case_id);
  SELECT * INTO previous FROM sourcing_contract_documents WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY contract_version DESC LIMIT 1;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.information_refresh_event_id;
  IF creator IS NULL OR previous.sourcing_contract_document_id IS NULL OR event.event_id IS NULL
    OR event.action<>'sourcing.contract.information.refresh' OR event.entity_type<>'sourcing_contract_document'
    OR event.entity_id<>NEW.sourcing_contract_document_id::text OR event.actor_id<>NEW.prepared_by
    OR event.before_state->>'documentId' IS DISTINCT FROM previous.sourcing_contract_document_id::text
    OR event.after_state->'supplierValues' IS DISTINCT FROM (
      SELECT jsonb_object_agg(key,value) FROM jsonb_each(NEW.approval_snapshot) WHERE key=ANY(fields))
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[] OR (NOT returned AND (
      event.actor_roles @> ARRAY['production_management']::text[] AND event.authorization_capability='sourcing:decision:record'
      OR event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=creator AND event.authorization_capability='sourcing:contract:record')))
    OR NEW.revision_of IS DISTINCT FROM previous.sourcing_contract_document_id
    OR NEW.information_revision<>previous.information_revision+1 OR NEW.contract_version<>previous.contract_version+1
    OR NEW.sourcing_approval_snapshot_id<>previous.sourcing_approval_snapshot_id
    OR NEW.sourcing_decision_id<>previous.sourcing_decision_id OR NEW.identity_version<>previous.identity_version
    OR (event.after_state->>'mode'='manual_content' AND (
      NOT event.actor_roles @> ARRAY['root_superuser']::text[]
      OR EXISTS(SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_contract_document_id=previous.sourcing_contract_document_id)))
    OR NEW.template_version IS DISTINCT FROM (CASE WHEN event.after_state->>'mode'='manual_content'
      THEN previous.template_version
      ELSE (SELECT max(template_version) FROM sourcing_contract_template_versions WHERE effective_from<=CURRENT_TIMESTAMP) END)
    OR (event.after_state->>'templateVersion')::integer IS DISTINCT FROM NEW.template_version
    OR (NEW.approval_snapshot-fields) IS DISTINCT FROM (previous.approval_snapshot-fields)
  THEN RAISE EXCEPTION 'supplier refresh requires authorized unchanged contract and audit' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
