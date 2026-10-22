-- Merge immutable main contract/price migrations with digital production guards.
-- No historical order, return, clock, execution, task or notification is rewritten.
DO $$ BEGIN
  IF to_regclass('sourcing_contract_return_cycles') IS NULL
    OR to_regclass('sourcing_price_reapplications') IS NULL
    OR to_regprocedure('sourcing_validate_price_effect(sourcing_decisions)') IS NULL THEN
    RAISE EXCEPTION 'contract price bridge requires both original main migrations';
  END IF;
END $$;

CREATE FUNCTION sourcing_factory_execution_basis(case_id_in uuid,decision_id_in uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH RECURSIVE execution AS (
    SELECT sourcing_decision_id FROM sourcing_production_orders WHERE sourcing_case_id=case_id_in
    UNION
    SELECT transfer.factory_decision_id FROM sourcing_production_factory_transfers transfer
      JOIN sourcing_production_orders production USING(production_order_id) WHERE production.sourcing_case_id=case_id_in
  ), basis AS (
    SELECT sourcing_decision_id,sourcing_case_id,supplier_id,decision_version,source_type,supersedes_decision_id
    FROM sourcing_decisions WHERE sourcing_case_id=case_id_in AND sourcing_decision_id=decision_id_in
    UNION ALL
    SELECT parent.sourcing_decision_id,parent.sourcing_case_id,parent.supplier_id,parent.decision_version,parent.source_type,parent.supersedes_decision_id
    FROM basis child JOIN sourcing_decisions parent ON parent.sourcing_decision_id=child.supersedes_decision_id
    WHERE child.source_type='price_reapplication'
      AND NOT EXISTS(SELECT 1 FROM execution WHERE execution.sourcing_decision_id=child.sourcing_decision_id)
      AND parent.sourcing_case_id=child.sourcing_case_id
      AND parent.supplier_id=child.supplier_id AND parent.decision_version<child.decision_version
  )
  SELECT sourcing_decision_id FROM basis WHERE source_type IN ('initial','management_revision','factory_change')
    OR EXISTS(SELECT 1 FROM execution WHERE execution.sourcing_decision_id=basis.sourcing_decision_id);
$$;

CREATE OR REPLACE FUNCTION sourcing_factory_remaining_lines(case_id uuid,decision_id uuid)
RETURNS TABLE("position" integer,planned_quantity integer,completed_quantity integer,quantity integer) LANGUAGE sql STABLE AS $$
 SELECT line.position,line.quantity,line.completed_quantity,GREATEST(line.quantity-line.completed_quantity,0)::integer
 FROM sourcing_production_orders production
 CROSS JOIN LATERAL sourcing_factory_execution_lines(production.production_order_id,sourcing_factory_execution_basis(case_id,decision_id)) line
 WHERE production.sourcing_case_id=case_id
 UNION ALL
 SELECT line.position,line.quantity,0,line.quantity FROM current_sourcing_case_lines line
 WHERE line.sourcing_case_id=case_id AND NOT EXISTS(SELECT 1 FROM sourcing_production_orders WHERE sourcing_case_id=case_id);
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_factory_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE production sourcing_production_orders%ROWTYPE; decision sourcing_decisions%ROWTYPE; audit operation_events%ROWTYPE;
BEGIN
 SELECT * INTO production FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 SELECT * INTO decision FROM sourcing_decisions WHERE sourcing_decision_id=NEW.factory_decision_id;
 SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
 IF decision.sourcing_case_id IS DISTINCT FROM production.sourcing_case_id OR decision.source_type IS DISTINCT FROM 'factory_change'
 OR sourcing_factory_execution_basis(production.sourcing_case_id,decision.supersedes_decision_id) IS DISTINCT FROM NEW.from_decision_id OR decision.operation_event_id IS DISTINCT FROM NEW.operation_event_id
 OR audit.action IS DISTINCT FROM 'sourcing.factory_change.effective' OR audit.entity_type IS DISTINCT FROM 'sourcing_case'
 OR audit.entity_id IS DISTINCT FROM production.sourcing_case_id::text
 OR NEW.effective_at IS DISTINCT FROM statement_timestamp()
 OR NEW.from_decision_id IS DISTINCT FROM COALESCE((SELECT factory_decision_id FROM sourcing_production_factory_transfers
   WHERE production_order_id=NEW.production_order_id ORDER BY effective_at DESC LIMIT 1),production.sourcing_decision_id)
 OR NOT EXISTS(SELECT 1 FROM sourcing_approval_snapshots WHERE sourcing_decision_id=NEW.factory_decision_id)
 THEN RAISE EXCEPTION 'factory execution requires its actual approved transfer and active production source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_sourcing_decision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  current_quote sourcing_ie_quotes%ROWTYPE;
  previous_decision sourcing_decisions%ROWTYPE;
  previous_owner_decision sourcing_owner_decisions%ROWTYPE;
  source_change sourcing_factory_change_requests%ROWTYPE;
  source_verification sourcing_factory_change_decisions%ROWTYPE;
BEGIN
  IF NEW.source_type='price_reapplication' THEN
    PERFORM sourcing_validate_price_effect(NEW);
    RETURN NEW;
  END IF;
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_case FROM sourcing_case_facts_at(NEW.sourcing_case_id);
  IF source_case.sourcing_case_id IS NULL OR NEW.quantity IS DISTINCT FROM (CASE WHEN NEW.source_type='factory_change' THEN (SELECT sum(quantity) FROM sourcing_factory_remaining_lines(NEW.sourcing_case_id,NEW.supersedes_decision_id)) ELSE source_case.order_quantity END) THEN
    RAISE EXCEPTION 'sourcing decision quantity must match the immutable order quantity'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_active_factory(
    NEW.supplier_id,NEW.supplier_code_snapshot,NEW.supplier_name_snapshot
  );
  SELECT * INTO previous_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;

  IF NEW.source_type IN ('initial','management_revision') THEN
    SELECT * INTO current_quote
    FROM sourcing_ie_quotes
    WHERE sourcing_case_id=NEW.sourcing_case_id
    ORDER BY quote_version DESC
    LIMIT 1;
    IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_management_decision'
      OR current_quote.sourcing_ie_quote_id IS NULL
      OR NEW.source_ie_quote_id<>current_quote.sourcing_ie_quote_id THEN
      RAISE EXCEPTION 'management decision must reference the current IE quote'
        USING ERRCODE='23514';
    END IF;
    IF NEW.source_type='initial' THEN
      IF previous_decision.sourcing_decision_id IS NOT NULL
        OR NEW.decision_version<>1
        OR NEW.supersedes_decision_id IS NOT NULL THEN
        RAISE EXCEPTION 'first management decision must be version 1'
          USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO previous_owner_decision
      FROM sourcing_owner_decisions
      WHERE sourcing_decision_id=previous_decision.sourcing_decision_id
        AND decision='rejected';
      IF previous_decision.sourcing_decision_id IS NULL
        OR (previous_owner_decision.sourcing_owner_decision_id IS NULL AND NOT EXISTS(
          SELECT 1 FROM sourcing_case_corrections correction JOIN sourcing_case_transitions transition
            ON transition.operation_event_id=correction.operation_event_id
          WHERE correction.sourcing_case_id=NEW.sourcing_case_id
            AND correction.corrected_at>=previous_decision.decided_at
            AND correction.corrected_at<=current_quote.quoted_at))
        OR NEW.decision_version<>previous_decision.decision_version+1
        OR NEW.supersedes_decision_id<>previous_decision.sourcing_decision_id THEN
        RAISE EXCEPTION 'management revision must supersede the owner-rejected decision'
          USING ERRCODE='23514';
      END IF;
    END IF;
    PERFORM sourcing_require_operation_event(
      NEW.operation_event_id,NEW.request_id,NEW.decided_by,
      'sourcing.management_decision.record','sourcing:decision:record',
      NEW.sourcing_case_id,NEW.decision_reason
    );
  ELSE
    IF previous_decision.sourcing_decision_id IS NULL
      OR NEW.decision_version<>previous_decision.decision_version+1
      OR NEW.supersedes_decision_id<>previous_decision.sourcing_decision_id THEN
      RAISE EXCEPTION 'factory change decision must supersede the current decision'
        USING ERRCODE='23514';
    END IF;
    SELECT * INTO source_change
    FROM sourcing_factory_change_requests
    WHERE factory_change_request_id=NEW.source_change_request_id
      AND sourcing_case_id=NEW.sourcing_case_id
      AND from_decision_id=previous_decision.sourcing_decision_id;
    SELECT * INTO source_verification
    FROM sourcing_factory_change_decisions
    WHERE factory_change_request_id=NEW.source_change_request_id
      AND decision='approved'
      AND operation_event_id=NEW.operation_event_id;
    IF source_change.factory_change_request_id IS NULL
      OR source_verification.factory_change_decision_id IS NULL
      OR (
        (source_change.requires_owner_approval OR source_change.initiator_role='owner_group')
        AND source_verification.decision_role<>'owner_group'
      )
      OR (
        NOT source_change.requires_owner_approval
        AND source_change.initiator_role<>'owner_group'
        AND source_verification.decision_role<>'production_management'
      )
      OR (NEW.supplier_id,NEW.supplier_code_snapshot,NEW.supplier_name_snapshot,
          NEW.unit_price,NEW.quantity,NEW.total_amount)
        IS DISTINCT FROM
         (source_change.proposed_supplier_id,source_change.proposed_supplier_code_snapshot,
          source_change.proposed_supplier_name_snapshot,source_change.proposed_unit_price,
          (SELECT sum(quantity) FROM sourcing_factory_remaining_lines(NEW.sourcing_case_id,NEW.supersedes_decision_id)),
          (SELECT sum(round(NEW.unit_price*quantity,2)) FROM sourcing_factory_remaining_lines(NEW.sourcing_case_id,NEW.supersedes_decision_id))) THEN
      RAISE EXCEPTION 'effective factory change must match its approved immutable request'
        USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM operation_events event_row
      WHERE event_row.event_id=NEW.operation_event_id
        AND event_row.request_id=NEW.request_id
        AND event_row.actor_id=NEW.decided_by
        AND event_row.action='sourcing.factory_change.effective'
        AND event_row.authorization_capability IN (
          'sourcing:decision:record','sourcing:factory_change:verify','sourcing:owner:approve'
        )
        AND event_row.entity_type='sourcing_case'
        AND event_row.entity_id=NEW.sourcing_case_id::text
        AND event_row.reason IS NOT DISTINCT FROM NEW.decision_reason
    ) THEN
      RAISE EXCEPTION 'factory change effect requires its authorized operation event'
        USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
  IF NEW.business_action='price_reapplication_effective' THEN
    PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
    SELECT * INTO previous_transition FROM sourcing_case_transitions WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY sequence DESC LIMIT 1;
    IF NEW.sequence<>previous_transition.sequence+1 OR NEW.from_status IS DISTINCT FROM previous_transition.to_status
      OR NEW.to_status<>'pending_finance_reconciliation' OR NOT EXISTS(
        SELECT 1 FROM sourcing_decisions decision JOIN operation_events event ON event.event_id=decision.operation_event_id
        WHERE decision.sourcing_case_id=NEW.sourcing_case_id AND decision.source_type='price_reapplication'
          AND decision.operation_event_id=NEW.operation_event_id AND event.actor_id=NEW.actor_id AND event.request_id=NEW.request_id
      ) THEN RAISE EXCEPTION 'price effect transition requires its approved version and current order state' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
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

-- Same audited mother handover, now including current-version contract tasks.
CREATE OR REPLACE FUNCTION digital_merchandiser_todo_transfer(old_row rework_todos,new_row rework_todos)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE event operation_events%ROWTYPE; assignment audit_events%ROWTYPE; mother digital_production_orders%ROWTYPE;
BEGIN
  IF old_row.status NOT IN ('pending','blocked_recipient') OR new_row.status<>'pending'
     OR old_row.recipient_user_id=new_row.recipient_user_id OR old_row.todo_type<>'business_action'
     OR old_row.entity_type<>'sourcing_case' OR old_row.required_role<>'order_merchandiser'
     OR old_row.route_descriptor->>'routeName'<>'sourcing_detail'
     OR old_row.route_descriptor->>'entityId' IS DISTINCT FROM old_row.entity_id
     OR NOT ((old_row.category IN ('sourcing_contract_return','sourcing_transfer_contract_return','sourcing_price_contract_return') AND old_row.required_capability='sourcing:contract:record')
         OR (old_row.category='sourcing_merchandiser_correction' AND old_row.required_capability='sourcing:inquiry:create'))
     OR NOT (old_row.dedupe_key ~ ('^sourcing:'||old_row.entity_id||':(return|correction):[0-9]+$')
       OR old_row.dedupe_key ~ ('^sourcing:'||old_row.entity_id||':(transfer-return|price-return):[0-9a-f-]{36}:[0-9a-f-]{36}$'))
     OR new_row.delegation_id IS NOT NULL OR new_row.blocked_at IS NOT NULL OR new_row.blocked_reason IS NOT NULL
     OR (to_jsonb(new_row)-ARRAY['recipient_user_id','delegation_id','status','blocked_at','blocked_reason','version','updated_at'])
        IS DISTINCT FROM (to_jsonb(old_row)-ARRAY['recipient_user_id','delegation_id','status','blocked_at','blocked_reason','version','updated_at'])
  THEN RETURN false; END IF;
  SELECT * INTO event FROM operation_events WHERE event_id=nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.todo_request_id',true),'') AND action='todo.transfer'
    AND entity_type='rework_todo' AND entity_id=old_row.todo_id::text;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO assignment FROM audit_events WHERE id=(event.after_state->>'handoverAuditId')::uuid
    AND action='digital_primary_merchandiser_assigned' AND entity_type='digital_access'
    AND entity_id=event.after_state->>'digitalOrderId' AND actor_id=event.actor_id AND request_id=event.request_id
    AND xmin::text=(txid_current()%4294967296)::text;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT o.* INTO mother FROM digital_production_orders o
    JOIN digital_production_child_links l USING(production_order_id)
    JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id
    WHERE o.production_order_id::text=assignment.entity_id AND l.module='sourcing' AND l.child_id::text=old_row.entity_id
      AND to_jsonb(s)->>'workflow_generation'='digital_production_v1';
  IF NOT FOUND OR mother.primary_merchandiser_id IS DISTINCT FROM new_row.recipient_user_id
     OR assignment.before_state->>'primary_merchandiser_id' IS DISTINCT FROM old_row.recipient_user_id::text
     OR assignment.after_state->>'merchandiserId' IS DISTINCT FROM new_row.recipient_user_id::text
     OR (assignment.after_state->>'version')::integer IS DISTINCT FROM mother.version
     OR (assignment.before_state->>'version')::integer+1 IS DISTINCT FROM mother.version
     OR event.before_state->>'recipientUserId' IS DISTINCT FROM old_row.recipient_user_id::text
     OR event.before_state->>'status' IS DISTINCT FROM old_row.status
     OR event.after_state->>'recipientUserId' IS DISTINCT FROM new_row.recipient_user_id::text
     OR event.after_state->>'status' IS DISTINCT FROM new_row.status
     OR NOT todo_user_has_direct_role(new_row.recipient_user_id,old_row.required_role,old_row.required_capability)
     OR NOT ('root_superuser'=ANY(event.actor_roles)
        OR EXISTS(SELECT 1 FROM user_role_assignments a
          JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
          JOIN app_users u ON u.id=a.user_id AND u.enabled AND NOT u.manual_access_disabled
          JOIN identity_mappings i ON i.user_id=u.id AND i.active AND i.employed
          WHERE a.user_id=event.actor_id AND a.revoked_at IS NULL
            AND a.role_code IN ('owner_group','production_management') AND a.role_code=ANY(event.actor_roles)))
  THEN RETURN false; END IF;
  RETURN true;
END;
$$;

