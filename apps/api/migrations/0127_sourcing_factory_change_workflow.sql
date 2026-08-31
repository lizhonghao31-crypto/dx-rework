-- Sourcing PR4: role-aware auxiliary factory-change approval without adding a sixth main node.
ALTER TABLE sourcing_factory_change_requests
  ADD COLUMN initiator_role text NOT NULL DEFAULT 'order_merchandiser'
    CHECK(initiator_role IN ('order_merchandiser','production_management','owner_group')),
  ADD COLUMN resume_status text NOT NULL DEFAULT 'pending_finance_reconciliation'
    CHECK(resume_status IN (
      'pending_owner_approval','pending_finance_reconciliation',
      'pending_factory_change_verification','pending_exception_verification','closed'
    )),
  ADD COLUMN requires_owner_approval boolean NOT NULL DEFAULT false;

ALTER TABLE sourcing_factory_change_decisions
  ADD COLUMN decision_role text NOT NULL DEFAULT 'production_management'
    CHECK(decision_role IN ('production_management','owner_group'));

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='sourcing_factory_change_decisions'::regclass
    AND contype='u'
    AND conkey=ARRAY[
      (SELECT attnum FROM pg_attribute
       WHERE attrelid='sourcing_factory_change_decisions'::regclass
         AND attname='factory_change_request_id')
    ]::smallint[];
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE sourcing_factory_change_decisions DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;
END;
$$;

ALTER TABLE sourcing_factory_change_decisions
  ADD CONSTRAINT sourcing_factory_change_decisions_request_role_key
  UNIQUE(factory_change_request_id,decision_role);

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='sourcing_case_transitions'::regclass
    AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%business_action%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'sourcing transition business-action constraint was not found';
  END IF;
  EXECUTE format('ALTER TABLE sourcing_case_transitions DROP CONSTRAINT %I',constraint_name);
END;
$$;

ALTER TABLE sourcing_case_transitions
  ADD CONSTRAINT sourcing_case_transitions_business_action_check
  CHECK(business_action IN (
    'created','ie_price_quoted','management_decision_recorded',
    'owner_approved','owner_rejected','contract_recorded','contract_stage_retired',
    'factory_change_requested','factory_change_approved','factory_change_rejected',
    'factory_change_effective','finance_matched','finance_difference',
    'exception_reopened_for_contract','exception_reopened_for_reconciliation',
    'exception_closed'
  ));

CREATE OR REPLACE FUNCTION guard_sourcing_factory_change_request_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  current_decision sourcing_decisions%ROWTYPE;
  expected_action text;
  expected_capability text;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO current_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC LIMIT 1;
  expected_action := CASE
    WHEN NEW.initiator_role='owner_group'
      OR (NEW.initiator_role='production_management' AND NOT NEW.requires_owner_approval)
      THEN 'sourcing.factory_change.effective'
    ELSE 'sourcing.factory_change.request'
  END;
  expected_capability := CASE NEW.initiator_role
    WHEN 'order_merchandiser' THEN 'sourcing:factory_change:request'
    WHEN 'production_management' THEN 'sourcing:decision:record'
    ELSE 'sourcing:owner:approve'
  END;
  IF current_decision.sourcing_decision_id IS NULL
    OR NEW.from_decision_id<>current_decision.sourcing_decision_id
    OR NEW.proposed_supplier_id=current_decision.supplier_id
    OR NEW.proposed_quantity<>source_case.order_quantity
    OR NEW.resume_status<>sourcing_current_status(NEW.sourcing_case_id)
    OR NEW.requires_owner_approval<>(NEW.proposed_unit_price>current_decision.unit_price)
    OR EXISTS (
      SELECT 1
      FROM sourcing_factory_change_requests existing
      WHERE existing.sourcing_case_id=NEW.sourcing_case_id
        AND NOT EXISTS (
          SELECT 1 FROM sourcing_decisions effective
          WHERE effective.source_change_request_id=existing.factory_change_request_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sourcing_factory_change_decisions rejected
          WHERE rejected.factory_change_request_id=existing.factory_change_request_id
            AND rejected.decision='rejected'
        )
    ) THEN
    RAISE EXCEPTION 'factory change must replace the current effective decision'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_active_factory(
    NEW.proposed_supplier_id,
    NEW.proposed_supplier_code_snapshot,
    NEW.proposed_supplier_name_snapshot
  );
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.requested_by,
    expected_action,expected_capability,
    NEW.sourcing_case_id,NEW.change_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_factory_change_decision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_request sourcing_factory_change_requests%ROWTYPE;
  required_action text;
  required_capability text;
BEGIN
  SELECT * INTO source_request
  FROM sourcing_factory_change_requests
  WHERE factory_change_request_id=NEW.factory_change_request_id;
  IF source_request.factory_change_request_id IS NULL THEN
    RAISE EXCEPTION 'factory change request does not exist'
      USING ERRCODE='23503';
  END IF;
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=source_request.sourcing_case_id FOR UPDATE;
  IF EXISTS (
      SELECT 1 FROM sourcing_decisions effective
      WHERE effective.source_change_request_id=NEW.factory_change_request_id
    )
    OR EXISTS (
      SELECT 1 FROM sourcing_factory_change_decisions rejected
      WHERE rejected.factory_change_request_id=NEW.factory_change_request_id
        AND rejected.decision='rejected'
    )
    OR source_request.from_decision_id<>(
      SELECT current_decision.sourcing_decision_id
      FROM sourcing_decisions current_decision
      WHERE current_decision.sourcing_case_id=source_request.sourcing_case_id
      ORDER BY current_decision.decision_version DESC LIMIT 1
    ) THEN
    RAISE EXCEPTION 'factory change request is no longer actionable'
      USING ERRCODE='23514';
  END IF;
  IF NEW.decision_role='production_management' THEN
    IF source_request.initiator_role NOT IN ('order_merchandiser','production_management')
      OR (source_request.initiator_role='order_merchandiser' AND EXISTS (
        SELECT 1 FROM sourcing_factory_change_decisions prior
        WHERE prior.factory_change_request_id=NEW.factory_change_request_id
          AND prior.decision_role='production_management'
      )) THEN
      RAISE EXCEPTION 'production management cannot review this factory change'
        USING ERRCODE='23514';
    END IF;
    required_capability := CASE
      WHEN source_request.initiator_role='production_management'
        THEN 'sourcing:decision:record'
      ELSE 'sourcing:factory_change:verify'
    END;
    required_action := CASE
      WHEN NEW.operation_event_id=source_request.operation_event_id
        AND source_request.initiator_role='production_management'
        THEN CASE
          WHEN source_request.requires_owner_approval THEN 'sourcing.factory_change.request'
          ELSE 'sourcing.factory_change.effective'
        END
      WHEN NEW.decision='rejected' THEN 'sourcing.factory_change.rejected'
      WHEN source_request.requires_owner_approval
        THEN 'sourcing.factory_change.management_approved'
      ELSE 'sourcing.factory_change.effective'
    END;
  ELSE
    IF NOT (
      source_request.initiator_role='owner_group'
      OR (
        source_request.requires_owner_approval
        AND (
          source_request.initiator_role='production_management'
          OR EXISTS (
            SELECT 1 FROM sourcing_factory_change_decisions management_review
            WHERE management_review.factory_change_request_id=NEW.factory_change_request_id
              AND management_review.decision_role='production_management'
              AND management_review.decision='approved'
          )
        )
      )
    ) THEN
      RAISE EXCEPTION 'owner approval is not required for this factory change'
        USING ERRCODE='23514';
    END IF;
    required_capability := 'sourcing:owner:approve';
    required_action := CASE
      WHEN NEW.decision='approved' THEN 'sourcing.factory_change.effective'
      ELSE 'sourcing.factory_change.owner_rejected'
    END;
  END IF;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.verified_by,
    required_action,required_capability,
    source_request.sourcing_case_id,NEW.verification_reason
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
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF source_case.sourcing_case_id IS NULL OR NEW.quantity<>source_case.order_quantity THEN
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
        OR previous_owner_decision.sourcing_owner_decision_id IS NULL
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
          source_change.proposed_quantity,source_change.proposed_total_amount) THEN
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

CREATE OR REPLACE FUNCTION guard_sourcing_reconciliation_insert()
RETURNS trigger LANGUAGE plpgsql AS $
DECLARE
  source_decision sourcing_decisions%ROWTYPE;
  source_supplier record;
  previous_version integer;
  expected_action text;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;
  SELECT supplier_id,supplier_code,supplier_name INTO source_supplier
  FROM current_supplier_catalog
  WHERE supplier_id=NEW.actual_supplier_id
    AND supplier_type='factory' AND active=true;
  SELECT COALESCE(max(reconciliation_version),0) INTO previous_version
  FROM sourcing_finance_reconciliations
  WHERE sourcing_case_id=NEW.sourcing_case_id;

  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_finance_reconciliation'
    OR source_decision.sourcing_decision_id IS NULL
    OR NEW.sourcing_decision_id<>source_decision.sourcing_decision_id
    OR NEW.reconciliation_version<>previous_version+1 THEN
    RAISE EXCEPTION 'finance reconciliation must bind the current approved sourcing decision'
      USING ERRCODE='23514';
  END IF;
  IF source_supplier.supplier_id IS NULL
    OR NEW.actual_supplier_code_snapshot<>source_supplier.supplier_code
    OR NEW.actual_supplier_name_snapshot<>source_supplier.supplier_name
    OR NEW.actual_supplier_id<>source_decision.supplier_id
    OR NEW.actual_unit_price<>source_decision.unit_price
    OR NEW.actual_quantity<>source_decision.quantity
    OR NEW.actual_total_amount<>source_decision.total_amount THEN
    RAISE EXCEPTION 'finance reconciliation is read-only and must preserve current decision facts'
      USING ERRCODE='23514';
  END IF;

  IF (NEW.result='match' AND cardinality(NEW.difference_fields)<>0)
    OR (NEW.result='difference' AND cardinality(NEW.difference_fields)=0) THEN
    RAISE EXCEPTION 'finance reconciliation result must match the declared difference fields'
      USING ERRCODE='23514';
  END IF;

  expected_action := CASE NEW.result
    WHEN 'match' THEN 'sourcing.finance.matched'
    ELSE 'sourcing.finance.difference'
  END;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.reconciled_by,
    expected_action,'sourcing:finance:reconcile',
    NEW.sourcing_case_id,NEW.difference_reason
  );
  RETURN NEW;
END;
$;

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

  IF NEW.business_action='factory_change_effective' THEN
    IF NEW.from_status NOT IN (
      'pending_owner_approval','pending_finance_reconciliation',
      'pending_factory_change_verification','pending_exception_verification','closed'
    ) OR NEW.to_status NOT IN ('pending_owner_approval','pending_finance_reconciliation')
      OR (NEW.from_status<>'pending_owner_approval' AND NEW.to_status<>'pending_finance_reconciliation')
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

