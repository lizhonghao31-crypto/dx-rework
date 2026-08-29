-- Retire the contract stage while preserving historical contract facts.

ALTER TABLE sourcing_finance_reconciliations
  ALTER COLUMN sourcing_contract_id DROP NOT NULL;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT constraint_row.conname INTO constraint_name
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid='sourcing_case_transitions'::regclass
    AND constraint_row.contype='c'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%business_action%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'sourcing transition business-action constraint was not found';
  END IF;
  EXECUTE format(
    'ALTER TABLE sourcing_case_transitions DROP CONSTRAINT %I',
    constraint_name
  );
END;
$$;

ALTER TABLE sourcing_case_transitions
  ADD CONSTRAINT sourcing_case_transitions_business_action_check
  CHECK(business_action IN (
    'created',
    'ie_price_quoted',
    'management_decision_recorded',
    'owner_approved',
    'owner_rejected',
    'contract_recorded',
    'contract_stage_retired',
    'factory_change_requested',
    'factory_change_approved',
    'factory_change_rejected',
    'finance_matched',
    'finance_difference',
    'exception_reopened_for_contract',
    'exception_reopened_for_reconciliation',
    'exception_closed'
  ));

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

CREATE OR REPLACE FUNCTION guard_sourcing_factory_change_request_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  current_decision sourcing_decisions%ROWTYPE;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO current_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;
  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_finance_reconciliation'
    OR current_decision.sourcing_decision_id IS NULL
    OR NEW.from_decision_id<>current_decision.sourcing_decision_id
    OR NEW.proposed_supplier_id=current_decision.supplier_id
    OR NEW.proposed_quantity<>source_case.order_quantity THEN
    RAISE EXCEPTION 'factory change must replace the current approved factory'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_active_factory(
    NEW.proposed_supplier_id,
    NEW.proposed_supplier_code_snapshot,
    NEW.proposed_supplier_name_snapshot
  );
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.requested_by,
    'sourcing.factory_change.request','sourcing:factory_change:request',
    NEW.sourcing_case_id,NEW.change_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_reconciliation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_decision sourcing_decisions%ROWTYPE;
  source_supplier record;
  previous_version integer;
  expected_differences text[];
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
    OR NEW.actual_supplier_name_snapshot<>source_supplier.supplier_name THEN
    RAISE EXCEPTION 'finance reconciliation requires the current factory snapshot'
      USING ERRCODE='23514';
  END IF;

  expected_differences := ARRAY_REMOVE(ARRAY[
    CASE WHEN NEW.actual_supplier_id<>source_decision.supplier_id THEN 'supplier' END,
    CASE WHEN NEW.actual_unit_price<>source_decision.unit_price THEN 'unit_price' END,
    CASE WHEN NEW.actual_quantity<>source_decision.quantity THEN 'quantity' END,
    CASE WHEN NEW.actual_total_amount<>source_decision.total_amount THEN 'total_amount' END
  ]::text[],NULL);

  IF (cardinality(expected_differences)=0 AND (
      NEW.result<>'match' OR cardinality(NEW.difference_fields)<>0
    ))
    OR (cardinality(expected_differences)>0 AND (
      NEW.result<>'difference' OR NEW.difference_fields<>expected_differences
    )) THEN
    RAISE EXCEPTION 'finance reconciliation result must exactly match the four compared fields'
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
$$;

DO $$
DECLARE
  candidate record;
  open_todo record;
  routing_exception record;
  recipient record;
  transition_event_id uuid;
  transition_request_id text;
  todo_event_id uuid;
  todo_request_id text;
  todo_id_value uuid;
  todo_dedupe_key text;
  recipient_count integer;
  transition_reason text := '合同节点已按业务决定下线，订单直接进入财务核对';
BEGIN
  FOR candidate IN
    SELECT
      case_view.sourcing_case_id,
      case_view.version,
      transition_row.actor_id,
      source_event.actor_roles,
      decision_row.decision_version,
      COALESCE(reconciliation_row.reconciliation_version,0) AS reconciliation_version
    FROM current_sourcing_cases case_view
    JOIN LATERAL (
      SELECT transition.sequence,transition.actor_id,transition.operation_event_id
      FROM sourcing_case_transitions transition
      WHERE transition.sourcing_case_id=case_view.sourcing_case_id
      ORDER BY transition.sequence DESC
      LIMIT 1
    ) transition_row ON true
    JOIN operation_events source_event
      ON source_event.event_id=transition_row.operation_event_id
    JOIN LATERAL (
      SELECT decision.decision_version
      FROM sourcing_decisions decision
      WHERE decision.sourcing_case_id=case_view.sourcing_case_id
      ORDER BY decision.decision_version DESC
      LIMIT 1
    ) decision_row ON true
    LEFT JOIN LATERAL (
      SELECT reconciliation.reconciliation_version
      FROM sourcing_finance_reconciliations reconciliation
      WHERE reconciliation.sourcing_case_id=case_view.sourcing_case_id
      ORDER BY reconciliation.reconciliation_version DESC
      LIMIT 1
    ) reconciliation_row ON true
    WHERE case_view.status='pending_contract'
    ORDER BY case_view.sourcing_case_id
  LOOP
    SELECT count(DISTINCT recipient_source.user_id)
    INTO recipient_count
    FROM (
      SELECT assignment.user_id
      FROM user_role_assignments assignment
      WHERE assignment.role_code='factory_payables'
        AND assignment.revoked_at IS NULL
      UNION
      SELECT root.user_id
      FROM owner_bootstrap_consumptions root
      WHERE root.singleton=true
    ) recipient_source
    WHERE todo_user_has_direct_role(
      recipient_source.user_id,'factory_payables','sourcing:finance:reconcile'
    );

    IF recipient_count=0 THEN
      RAISE EXCEPTION
        'cannot retire sourcing contract stage without a routable finance recipient'
        USING ERRCODE='23514';
    END IF;

    transition_event_id := gen_random_uuid();
    transition_request_id :=
      'migration-0121-sourcing-five-stage-'||candidate.sourcing_case_id;

    INSERT INTO operation_events(
      event_id,request_id,actor_id,actor_roles,authorization_capability,
      action,entity_type,entity_id,before_state,after_state,reason
    ) VALUES(
      transition_event_id,transition_request_id,candidate.actor_id,
      candidate.actor_roles,'system:migration',
      'sourcing.contract_stage.retire','sourcing_case',
      candidate.sourcing_case_id::text,
      jsonb_build_object('status','pending_contract'),
      jsonb_build_object('status','pending_finance_reconciliation','contractStageRetired',true),
      transition_reason
    );

    INSERT INTO sourcing_case_transitions(
      sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
      business_action,transition_reason,actor_id,operation_event_id,request_id
    ) VALUES(
      gen_random_uuid(),candidate.sourcing_case_id,candidate.version+1,
      'pending_contract','pending_finance_reconciliation',
      'contract_stage_retired',transition_reason,candidate.actor_id,
      transition_event_id,transition_request_id
    );

    FOR open_todo IN
      SELECT todo.todo_id,todo.status
      FROM rework_todos todo
      WHERE todo.entity_type='sourcing_case'
        AND todo.entity_id=candidate.sourcing_case_id::text
        AND todo.category='sourcing_contract_record'
        AND todo.status IN ('pending','blocked_recipient')
      ORDER BY todo.todo_id
      FOR UPDATE
    LOOP
      FOR routing_exception IN
        SELECT routing.routing_exception_id,routing.routing_todo_id,
               routing_todo.status AS routing_todo_status
        FROM todo_recipient_routing_exceptions routing
        JOIN rework_todos routing_todo
          ON routing_todo.todo_id=routing.routing_todo_id
        WHERE routing.todo_id=open_todo.todo_id
          AND routing.status='pending'
        ORDER BY routing.routing_exception_id
        FOR UPDATE OF routing,routing_todo
      LOOP
        todo_event_id := gen_random_uuid();
        todo_request_id :=
          'migration-0121-cancel-contract-routing-'||routing_exception.routing_todo_id;
        INSERT INTO operation_events(
          event_id,request_id,actor_id,actor_roles,authorization_capability,
          action,entity_type,entity_id,before_state,after_state,reason
        ) VALUES(
          todo_event_id,todo_request_id,candidate.actor_id,candidate.actor_roles,
          'todo:backfill','todo.cancel','rework_todo',
          routing_exception.routing_todo_id::text,
          jsonb_build_object('status',routing_exception.routing_todo_status),
          jsonb_build_object('status','cancelled'),
          transition_reason
        );
        PERFORM set_config('dx_rework.todo_event_id',todo_event_id::text,true);
        PERFORM set_config('dx_rework.todo_request_id',todo_request_id,true);
        UPDATE rework_todos
        SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,
            cancelled_reason=transition_reason,
            cancelled_operation_event_id=todo_event_id,
            blocked_at=NULL,blocked_reason=NULL
        WHERE todo_id=routing_exception.routing_todo_id
          AND status IN ('pending','blocked_recipient');
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'pending sourcing contract routing exception has no open routing todo'
            USING ERRCODE='23514';
        END IF;
        UPDATE todo_recipient_routing_exceptions
        SET status='cancelled',cancelled_operation_event_id=todo_event_id
        WHERE routing_exception_id=routing_exception.routing_exception_id
          AND status='pending';
      END LOOP;

      todo_event_id := gen_random_uuid();
      todo_request_id :=
        'migration-0121-cancel-contract-todo-'||open_todo.todo_id;
      INSERT INTO operation_events(
        event_id,request_id,actor_id,actor_roles,authorization_capability,
        action,entity_type,entity_id,before_state,after_state,reason
      ) VALUES(
        todo_event_id,todo_request_id,candidate.actor_id,candidate.actor_roles,
        'todo:backfill','todo.cancel','rework_todo',open_todo.todo_id::text,
        jsonb_build_object('status',open_todo.status),
        jsonb_build_object('status','cancelled'),
        transition_reason
      );
      PERFORM set_config('dx_rework.todo_event_id',todo_event_id::text,true);
      PERFORM set_config('dx_rework.todo_request_id',todo_request_id,true);
      UPDATE rework_todos
      SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,
          cancelled_reason=transition_reason,
          cancelled_operation_event_id=todo_event_id,
          blocked_at=NULL,blocked_reason=NULL
      WHERE todo_id=open_todo.todo_id;
    END LOOP;

    FOR recipient IN
      SELECT DISTINCT recipient_source.user_id
      FROM (
        SELECT assignment.user_id
        FROM user_role_assignments assignment
        WHERE assignment.role_code='factory_payables'
          AND assignment.revoked_at IS NULL
        UNION
        SELECT root.user_id
        FROM owner_bootstrap_consumptions root
        WHERE root.singleton=true
      ) recipient_source
      WHERE todo_user_has_direct_role(
        recipient_source.user_id,'factory_payables','sourcing:finance:reconcile'
      )
      ORDER BY recipient_source.user_id
    LOOP
      todo_dedupe_key :=
        'sourcing:'||candidate.sourcing_case_id||':finance:'||
        candidate.decision_version||':'||(candidate.reconciliation_version+1)||
        ':'||recipient.user_id;
      IF EXISTS (
        SELECT 1 FROM rework_todos todo WHERE todo.dedupe_key=todo_dedupe_key
      ) THEN
        CONTINUE;
      END IF;
      todo_id_value := gen_random_uuid();
      todo_event_id := gen_random_uuid();
      todo_request_id :=
        'migration-0121-create-finance-todo-'||todo_id_value;
      INSERT INTO operation_events(
        event_id,request_id,actor_id,actor_roles,authorization_capability,
        action,entity_type,entity_id,after_state,reason
      ) VALUES(
        todo_event_id,todo_request_id,candidate.actor_id,candidate.actor_roles,
        'todo:backfill','todo.create','rework_todo',todo_id_value::text,
        jsonb_build_object(
          'sourceEventId',transition_event_id,
          'sourceAction','sourcing.contract_stage.retire',
          'backfilled',true
        ),
        transition_reason
      );
      PERFORM set_config('dx_rework.todo_event_id',todo_event_id::text,true);
      PERFORM set_config('dx_rework.todo_request_id',todo_request_id,true);
      INSERT INTO rework_todos(
        todo_id,todo_type,category,source_event_id,source_action,
        entity_type,entity_id,recipient_user_id,required_role,
        required_capability,route_descriptor,policy_key,due_at,status,
        dedupe_key,created_operation_event_id,created_request_id
      ) VALUES(
        todo_id_value,'business_action','sourcing_finance_reconcile',
        transition_event_id,'sourcing.contract_stage.retire',
        'sourcing_case',candidate.sourcing_case_id::text,recipient.user_id,
        'factory_payables','sourcing:finance:reconcile',
        jsonb_build_object(
          'routeName','sourcing_detail',
          'entityId',candidate.sourcing_case_id::text,
          'todoId',todo_id_value::text
        ),
        'general',CURRENT_TIMESTAMP+INTERVAL '1 day','pending',
        todo_dedupe_key,todo_event_id,todo_request_id
      );
    END LOOP;
  END LOOP;
END;
$$;
