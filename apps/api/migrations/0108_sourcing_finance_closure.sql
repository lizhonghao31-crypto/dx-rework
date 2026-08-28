-- Sourcing PR5: independent four-field finance reconciliation and shared-todo closure.

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT constraint_row.conname INTO constraint_name
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid='sourcing_finance_reconciliations'::regclass
    AND constraint_row.contype='c'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%actual_total_amount%'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%actual_unit_price%actual_quantity%'
  ORDER BY constraint_row.conname
  LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'finance reconciliation calculated-total constraint was not found';
  END IF;
  EXECUTE format(
    'ALTER TABLE sourcing_finance_reconciliations DROP CONSTRAINT %I',
    constraint_name
  );
END;
$$;

ALTER TABLE sourcing_finance_reconciliations
  ADD COLUMN actual_supplier_code_snapshot text,
  ADD COLUMN actual_supplier_name_snapshot text;

UPDATE sourcing_finance_reconciliations reconciliation
SET actual_supplier_code_snapshot=supplier.supplier_code,
    actual_supplier_name_snapshot=supplier.supplier_name
FROM current_supplier_catalog supplier
WHERE supplier.supplier_id=reconciliation.actual_supplier_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sourcing_finance_reconciliations
    WHERE actual_supplier_code_snapshot IS NULL
       OR actual_supplier_name_snapshot IS NULL
  ) THEN
    RAISE EXCEPTION 'existing finance reconciliation supplier snapshot cannot be resolved';
  END IF;
END;
$$;

ALTER TABLE sourcing_finance_reconciliations
  ALTER COLUMN actual_supplier_code_snapshot SET NOT NULL,
  ALTER COLUMN actual_supplier_name_snapshot SET NOT NULL,
  ADD CONSTRAINT sourcing_reconciliation_supplier_code_snapshot_check
    CHECK(length(btrim(actual_supplier_code_snapshot)) BETWEEN 1 AND 32),
  ADD CONSTRAINT sourcing_reconciliation_supplier_name_snapshot_check
    CHECK(length(btrim(actual_supplier_name_snapshot)) BETWEEN 1 AND 200);

CREATE OR REPLACE FUNCTION guard_sourcing_reconciliation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_decision sourcing_decisions%ROWTYPE;
  source_contract sourcing_contract_executions%ROWTYPE;
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
  SELECT * INTO source_contract
  FROM sourcing_contract_executions
  WHERE sourcing_contract_id=NEW.sourcing_contract_id
    AND sourcing_case_id=NEW.sourcing_case_id
    AND sourcing_decision_id=NEW.sourcing_decision_id;
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
    OR source_contract.sourcing_contract_id IS NULL
    OR NEW.reconciliation_version<>previous_version+1 THEN
    RAISE EXCEPTION 'finance reconciliation must bind the current contracted decision'
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
  recipient record;
  todo_id_value uuid;
  creation_event_id uuid;
  request_id_value text;
  dedupe_key_value text;
BEGIN
  IF to_regclass('rework_todos') IS NULL THEN
    RETURN;
  END IF;
  FOR candidate IN
    SELECT
      case_view.sourcing_case_id,
      source.event_id AS source_event_id,
      source.action AS source_action,
      source.actor_id AS source_actor_id,
      source.actor_roles AS source_actor_roles,
      CASE case_view.status
        WHEN 'pending_finance_reconciliation' THEN 'sourcing_finance_reconcile'
        ELSE 'sourcing_exception_verify'
      END AS category,
      CASE case_view.status
        WHEN 'pending_finance_reconciliation' THEN 'factory_payables'
        ELSE 'production_management'
      END AS required_role,
      CASE case_view.status
        WHEN 'pending_finance_reconciliation' THEN 'sourcing:finance:reconcile'
        ELSE 'sourcing:exception:verify'
      END AS required_capability,
      CASE case_view.status
        WHEN 'pending_finance_reconciliation' THEN
          'sourcing:'||case_view.sourcing_case_id||':finance:'||
          COALESCE((
            SELECT max(choice.decision_version)
            FROM sourcing_decisions choice
            WHERE choice.sourcing_case_id=case_view.sourcing_case_id
          ),0)||':'||
          (COALESCE((
            SELECT max(reconciliation.reconciliation_version)
            FROM sourcing_finance_reconciliations reconciliation
            WHERE reconciliation.sourcing_case_id=case_view.sourcing_case_id
          ),0)+1)
        ELSE
          'sourcing:'||case_view.sourcing_case_id||':exception:'||
          COALESCE((
            SELECT max(reconciliation.reconciliation_version)
            FROM sourcing_finance_reconciliations reconciliation
            WHERE reconciliation.sourcing_case_id=case_view.sourcing_case_id
              AND reconciliation.result='difference'
          ),0)
      END AS dedupe_prefix
    FROM current_sourcing_cases case_view
    LEFT JOIN LATERAL (
      SELECT event.event_id,event.action,event.actor_id,event.actor_roles
      FROM operation_events event
      WHERE event.entity_type='sourcing_case'
        AND event.entity_id=case_view.sourcing_case_id::text
        AND event.after_state->>'status'=case_view.status
      ORDER BY event.created_at DESC,event.event_id DESC
      LIMIT 1
    ) source ON true
    WHERE case_view.status IN (
      'pending_finance_reconciliation','pending_exception_verification'
    )
  LOOP
    IF candidate.source_event_id IS NULL
       OR candidate.dedupe_prefix LIKE '%:finance:0:%'
       OR candidate.dedupe_prefix LIKE '%:exception:0' THEN
      CONTINUE;
    END IF;
    FOR recipient IN
      SELECT DISTINCT recipient_source.user_id
      FROM (
        SELECT assignment.user_id
        FROM user_role_assignments assignment
        WHERE assignment.role_code=candidate.required_role
          AND assignment.revoked_at IS NULL
        UNION
        SELECT root.user_id
        FROM owner_bootstrap_consumptions root
        WHERE root.singleton=true
      ) recipient_source
      WHERE todo_user_has_direct_role(
        recipient_source.user_id,candidate.required_role,candidate.required_capability
      )
      ORDER BY recipient_source.user_id
    LOOP
      dedupe_key_value := candidate.dedupe_prefix||':'||recipient.user_id;
      IF EXISTS (SELECT 1 FROM rework_todos WHERE dedupe_key=dedupe_key_value) THEN
        CONTINUE;
      END IF;
      todo_id_value := gen_random_uuid();
      creation_event_id := gen_random_uuid();
      request_id_value :=
        'migration-0108-sourcing-todo-'||candidate.sourcing_case_id||'-'||recipient.user_id;

      INSERT INTO operation_events(
        event_id,request_id,actor_id,actor_roles,authorization_capability,
        action,entity_type,entity_id,after_state,reason
      ) VALUES(
        creation_event_id,request_id_value,candidate.source_actor_id,
        candidate.source_actor_roles,'todo:backfill','todo.create',
        'rework_todo',todo_id_value::text,
        jsonb_build_object(
          'sourceEventId',candidate.source_event_id,
          'sourceAction',candidate.source_action,
          'backfilled',true
        ),
        '报价选厂财务与差异待办升级回填'
      );
      PERFORM set_config('dx_rework.todo_event_id',creation_event_id::text,true);
      PERFORM set_config('dx_rework.todo_request_id',request_id_value,true);
      INSERT INTO rework_todos(
        todo_id,todo_type,category,source_event_id,source_action,
        entity_type,entity_id,recipient_user_id,required_role,
        required_capability,route_descriptor,policy_key,due_at,status,
        dedupe_key,created_operation_event_id,created_request_id
      ) VALUES(
        todo_id_value,'business_action',candidate.category,
        candidate.source_event_id,candidate.source_action,
        'sourcing_case',candidate.sourcing_case_id::text,recipient.user_id,
        candidate.required_role,candidate.required_capability,
        jsonb_build_object(
          'routeName','sourcing_detail','entityId',candidate.sourcing_case_id::text,
          'todoId',todo_id_value::text
        ),
        'general',CURRENT_TIMESTAMP+INTERVAL '1 day','pending',
        dedupe_key_value,creation_event_id,request_id_value
      );
    END LOOP;
  END LOOP;
END;
$$;
