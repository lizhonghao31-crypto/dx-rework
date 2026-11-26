-- The sourcing worksheet keeps using its original immutable IE projection.
-- An adopted row points to a published budget, whose existing reference points
-- to the original confirmed quotation and its precise processing-price row.
ALTER TABLE sourcing_ie_quotes
  ADD COLUMN adopted_budget_order_id uuid,
  ADD COLUMN adopted_budget_version integer,
  ADD COLUMN adopted_quotation_row_id uuid,
  ADD CONSTRAINT sourcing_ie_quote_adopted_budget_fk FOREIGN KEY (adopted_budget_order_id,adopted_budget_version)
    REFERENCES digital_budget_versions(production_order_id,version) MATCH FULL,
  ADD CONSTRAINT sourcing_ie_quote_adoption_complete CHECK (
    (adopted_budget_order_id IS NULL) = (adopted_quotation_row_id IS NULL)
  );

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname,pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint
    WHERE conrelid='sourcing_case_transitions'::regclass AND contype='c'
      AND pg_get_expr(conbin,conrelid) LIKE '%business_action%'
  LOOP
    EXECUTE format('ALTER TABLE sourcing_case_transitions DROP CONSTRAINT %I',item.conname);
    EXECUTE format('ALTER TABLE sourcing_case_transitions ADD CONSTRAINT %I CHECK ((%s) OR business_action IN (''created_with_ie_basis'',''correction_retained_ie_basis''))',
      item.conname,item.expression);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_ie_quote_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  previous_version integer;
  adoption_actor uuid;
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_case FROM sourcing_case_facts_at(NEW.sourcing_case_id);
  SELECT COALESCE(max(quote_version),0) INTO previous_version
  FROM sourcing_ie_quotes WHERE sourcing_case_id=NEW.sourcing_case_id;
  IF source_case.sourcing_case_id IS NULL
    OR NEW.quote_version<>previous_version+1
    OR NEW.quantity<>source_case.order_quantity THEN
    RAISE EXCEPTION 'IE quote must price the immutable order quantity in pending IE quote state'
      USING ERRCODE='23514';
  END IF;
  IF NEW.adopted_budget_order_id IS NOT NULL THEN
    IF NOT (
      previous_version=0 AND sourcing_current_status(NEW.sourcing_case_id) IS NULL OR
      previous_version>0 AND sourcing_current_status(NEW.sourcing_case_id)='pending_merchandiser_correction'
       AND EXISTS(SELECT 1 FROM sourcing_ie_quotes earlier
         WHERE earlier.sourcing_case_id=NEW.sourcing_case_id AND earlier.quote_version=previous_version
           AND earlier.adopted_budget_order_id=NEW.adopted_budget_order_id
           AND earlier.adopted_budget_version<NEW.adopted_budget_version)
       AND NOT EXISTS(SELECT 1 FROM sourcing_approval_snapshots approval WHERE approval.sourcing_case_id=NEW.sourcing_case_id)
    ) OR NOT EXISTS(
      SELECT 1
      FROM digital_production_child_links link
      JOIN digital_production_orders mother ON mother.production_order_id=link.production_order_id
      JOIN digital_budget_documents budget ON budget.production_order_id=link.production_order_id AND budget.status='published'
      JOIN digital_budget_versions snapshot ON snapshot.production_order_id=budget.production_order_id AND snapshot.version=budget.version
      JOIN digital_quotation_versions version ON version.quote_id=snapshot.quote_id AND version.version=snapshot.quote_version
      JOIN digital_quotation_documents quotation ON quotation.quote_id=version.quote_id
      CROSS JOIN LATERAL jsonb_array_elements(version.document->'rows') AS part(row)
      CROSS JOIN LATERAL (SELECT version.price_sources->(NEW.adopted_quotation_row_id::text) AS field) AS price
      WHERE link.module='sourcing' AND link.child_id=NEW.sourcing_case_id
        AND link.production_order_id=NEW.adopted_budget_order_id
        AND snapshot.version=NEW.adopted_budget_version
        AND quotation.production_order_id=link.production_order_id
        AND quotation.source_id IS NOT DISTINCT FROM mother.source_id AND version.customer_code=mother.customer_code
        AND quotation.confirmed_version=version.version AND quotation.version=version.version
        AND version.assembly->'rows'->(NEW.adopted_quotation_row_id::text)->>'kind'='ie'
        AND version.assembly->'rows'->(NEW.adopted_quotation_row_id::text)->>'sourceRef'='ie:processing'
        AND part.row->>'rowId'=NEW.adopted_quotation_row_id::text AND part.row->>'unit'='件'
        AND part.row->>'consumption'='1' AND (part.row->>'unitPrice')::numeric=NEW.unit_price
        AND (snapshot.document->>'outsourcingUnitPrice')::numeric=NEW.unit_price
        AND price.field->>'actorId'=NEW.quoted_by::text AND (price.field->>'recordedAt')::timestamptz=NEW.quoted_at
        AND price.field->>'role' IN ('ie_reviewer','root_superuser')
    ) THEN
      RAISE EXCEPTION 'sourcing IE adoption requires its original published budget and confirmed processing price' USING ERRCODE='23514';
    END IF;
    IF previous_version=0 THEN adoption_actor := source_case.created_by;
    ELSE
      SELECT event.actor_id INTO adoption_actor FROM operation_events event
      JOIN digital_production_orders mother ON mother.production_order_id=NEW.adopted_budget_order_id
      WHERE event.event_id=NEW.operation_event_id
        AND (event.actor_id=mother.primary_merchandiser_id OR event.actor_roles @> ARRAY['root_superuser']::text[]);
      IF adoption_actor IS NULL THEN RAISE EXCEPTION 'IE re-adoption needs the current order authority' USING ERRCODE='42501'; END IF;
    END IF;
    PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,adoption_actor,
      'sourcing.ie_basis.adopt','sourcing:inquiry:create',NEW.sourcing_case_id,NEW.quote_reason);
    RETURN NEW;
  END IF;
  IF sourcing_current_status(NEW.sourcing_case_id) IS DISTINCT FROM 'pending_ie_quote' OR EXISTS(
    SELECT 1 FROM sourcing_ie_quotes WHERE sourcing_case_id=NEW.sourcing_case_id AND adopted_budget_order_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'this sourcing case cannot receive a new manual IE quotation' USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.quoted_by,
    'sourcing.ie_price.quote','sourcing:price:quote',
    NEW.sourcing_case_id,NEW.quote_reason
  );
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

  IF NEW.business_action='created_with_ie_basis' THEN
    IF previous_transition.sourcing_transition_id IS NOT NULL OR NEW.sequence<>1 OR NEW.from_status IS NOT NULL
      OR NEW.to_status<>'pending_management_decision' OR NOT EXISTS(
       SELECT 1 FROM sourcing_cases source JOIN sourcing_ie_quotes quote USING(sourcing_case_id)
       WHERE source.sourcing_case_id=NEW.sourcing_case_id AND source.operation_event_id=NEW.operation_event_id
         AND quote.quote_version=1 AND quote.adopted_budget_order_id IS NOT NULL
         AND quote.quantity=(SELECT COALESCE(sum(line.quantity),0) FROM sourcing_ie_quote_lines line
           WHERE line.sourcing_ie_quote_id=quote.sourcing_ie_quote_id AND line.unit_price=quote.unit_price)
      ) THEN RAISE EXCEPTION 'sourcing creation requires its exact adopted IE quotation and lines' USING ERRCODE='23514'; END IF;
    PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.actor_id,
      'sourcing.case.create','sourcing:inquiry:create',NEW.sourcing_case_id,NEW.transition_reason);
    RETURN NEW;
  END IF;

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

  IF NEW.business_action IN ('returned_to_merchandiser','correction_submitted','correction_retained_ie_basis') THEN
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
      IF NEW.from_status<>'pending_merchandiser_correction'
        OR NEW.to_status IS DISTINCT FROM (CASE WHEN NEW.business_action='correction_retained_ie_basis'
          THEN 'pending_management_decision' ELSE 'pending_ie_quote' END)
        OR (NEW.business_action='correction_retained_ie_basis') IS DISTINCT FROM EXISTS(
          SELECT 1 FROM sourcing_ie_quotes quote WHERE quote.sourcing_case_id=NEW.sourcing_case_id
            AND quote.adopted_budget_order_id IS NOT NULL
        )
        OR NEW.business_action='correction_retained_ie_basis' AND NOT EXISTS(
          SELECT 1 FROM sourcing_ie_quotes quote
          JOIN digital_budget_documents budget ON budget.production_order_id=quote.adopted_budget_order_id
            AND budget.version=quote.adopted_budget_version AND budget.status='published'
          JOIN digital_quotation_documents quotation ON quotation.quote_id=budget.quote_id
            AND quotation.confirmed_version=budget.quote_version AND quotation.version=budget.quote_version
          WHERE quote.sourcing_case_id=NEW.sourcing_case_id
            AND NOT EXISTS(
              SELECT 1
              FROM (SELECT position,quantity FROM sourcing_ie_quote_lines
                WHERE sourcing_ie_quote_id=quote.sourcing_ie_quote_id) original
              FULL JOIN (SELECT position,quantity FROM current_sourcing_case_lines
                WHERE sourcing_case_id=NEW.sourcing_case_id) current USING(position)
              WHERE original.quantity IS DISTINCT FROM current.quantity
            )
        )
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
            AND (correction.corrected_at<=current_quote.quoted_at
              OR current_quote.adopted_budget_order_id IS NOT NULL AND transition.business_action='correction_retained_ie_basis')))
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

CREATE OR REPLACE FUNCTION require_sourcing_case_initial_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sourcing_case_transitions transition_row
    WHERE transition_row.sourcing_case_id=NEW.sourcing_case_id
      AND transition_row.sequence=1
      AND ((transition_row.business_action='created' AND transition_row.to_status='pending_ie_quote')
        OR (transition_row.business_action='created_with_ie_basis' AND transition_row.to_status='pending_management_decision'))
      AND transition_row.operation_event_id=NEW.operation_event_id
  ) THEN
    RAISE EXCEPTION 'sourcing case requires its audited initial transition'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION guard_sourcing_budget_price_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  audit_event operation_events%ROWTYPE;
  current_price numeric(14,4);
  expected_version integer;
  current_status text;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;

  IF source_case.sourcing_case_id IS NULL OR source_case.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'budget correction requires an active sourcing case' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM sourcing_approval_snapshots approval WHERE approval.sourcing_case_id=NEW.sourcing_case_id) THEN
    RAISE EXCEPTION 'approved sourcing numbers are locked' USING ERRCODE='55000';
  END IF;

  current_status := sourcing_current_status(NEW.sourcing_case_id);
  SELECT * INTO audit_event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF current_status NOT IN ('pending_ie_quote','pending_management_decision','pending_owner_approval') AND NOT (
    current_status='pending_merchandiser_correction' AND audit_event.action='sourcing.ie_basis.budget_price.adopt'
  ) THEN
    RAISE EXCEPTION 'budget correction is only allowed before owner approval' USING ERRCODE='55000';
  END IF;

  SELECT correction.new_unit_price, correction.correction_version + 1
    INTO current_price, expected_version
  FROM sourcing_budget_price_corrections correction
  WHERE correction.sourcing_case_id=NEW.sourcing_case_id
  ORDER BY correction.correction_version DESC LIMIT 1;

  IF current_price IS NULL THEN current_price := source_case.daxing_unit_price; expected_version := 1; END IF;

  IF current_price IS NULL
    OR NEW.old_unit_price IS DISTINCT FROM current_price
    OR NEW.correction_version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'budget correction does not continue the current price history' USING ERRCODE='55000';
  END IF;

  IF audit_event.action='sourcing.ie_basis.budget_price.adopt' THEN
    IF current_status<>'pending_merchandiser_correction' OR NOT EXISTS(
      SELECT 1 FROM sourcing_ie_quotes quote JOIN operation_events adoption ON adoption.event_id=quote.operation_event_id
      WHERE quote.sourcing_case_id=NEW.sourcing_case_id AND quote.adopted_budget_order_id IS NOT NULL AND quote.quote_version>1
        AND quote.quote_version=(SELECT max(latest.quote_version) FROM sourcing_ie_quotes latest WHERE latest.sourcing_case_id=NEW.sourcing_case_id)
        AND quote.unit_price=NEW.new_unit_price AND quote.adopted_budget_version::text=audit_event.after_state->>'budgetVersion'
        AND adoption.request_id=NEW.request_id AND adoption.actor_id=NEW.corrected_by AND adoption.action='sourcing.ie_basis.adopt'
    ) THEN RAISE EXCEPTION 'new budget price requires the exact current IE adoption' USING ERRCODE='55000'; END IF;
    PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.corrected_by,
      'sourcing.ie_basis.budget_price.adopt','sourcing:inquiry:create',NEW.sourcing_case_id,NEW.reason);
    IF audit_event.after_state->>'correctionVersion' IS DISTINCT FROM NEW.correction_version::text THEN
      RAISE EXCEPTION 'new budget price requires the exact correction version' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;

  IF audit_event.event_id IS NULL
    OR audit_event.action<>'sourcing.budget_price.correct'
    OR audit_event.entity_type<>'sourcing_case'
    OR audit_event.entity_id<>NEW.sourcing_case_id::text
    OR audit_event.authorization_capability<>'sourcing:inquiry:create'
    OR NOT (audit_event.actor_roles @> ARRAY['root_superuser']::text[])
    OR audit_event.actor_id<>NEW.corrected_by
    OR audit_event.request_id<>NEW.request_id
    OR audit_event.reason IS DISTINCT FROM NEW.reason
    OR audit_event.after_state->>'budgetPriceCorrected' IS DISTINCT FROM 'true'
    OR (audit_event.after_state->>'correctionVersion')::integer IS DISTINCT FROM NEW.correction_version THEN
    RAISE EXCEPTION 'budget correction requires its immutable operation event' USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;
