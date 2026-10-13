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
CREATE FUNCTION guard_sourcing_transfer_delivery_request() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER sourcing_transfer_delivery_request BEFORE INSERT ON sourcing_factory_change_requests
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_transfer_delivery_request();

CREATE FUNCTION guard_sourcing_transfer_delivery_approval() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER sourcing_transfer_delivery_approval BEFORE INSERT ON sourcing_approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_transfer_delivery_approval();

-- Current and historical reads follow the associated approved contract version.
CREATE OR REPLACE FUNCTION sourcing_effective_delivery_date(case_id uuid, fallback_date date, at_time timestamptz DEFAULT NULL)
RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE edited text;
BEGIN
  SELECT COALESCE(content.content->>'deliveryDate',document.approval_snapshot->>'deliveryDate') INTO edited
  FROM sourcing_contract_documents document
  LEFT JOIN sourcing_contract_content_overrides content USING(sourcing_contract_document_id)
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
  IF c.definition LIKE '%business_action%' THEN
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
