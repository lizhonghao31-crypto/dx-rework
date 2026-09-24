-- A contract return is an actionable notice immediately after approval. The
-- 48-hour deadline belongs to the contract monitor and starts only when the
-- PDF is ready; an immutable todo must not invent a separate 24-hour deadline.
-- Approval transactions lock sourcing_cases before snapshots, monitor and todo.
-- Take this lock before touching any of those objects to avoid lock inversion.
LOCK TABLE sourcing_cases IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE todo_policies DROP CONSTRAINT todo_policies_policy_key_check;
ALTER TABLE todo_policies ADD CONSTRAINT todo_policies_policy_key_check
  CHECK (policy_key IN ('general','finance_return_or_wage_review',
    'deduction_follow_up','sourcing_contract_return'));
ALTER TABLE todo_policies DROP CONSTRAINT todo_policies_check;
ALTER TABLE todo_policies ADD CONSTRAINT todo_policies_check CHECK(
  (policy_key IN ('deduction_follow_up','sourcing_contract_return')
    AND due_after_seconds IS NULL AND first_reminder_after_due_seconds IS NULL
    AND second_reminder_after_due_seconds IS NULL
    AND escalate_after_due_seconds IS NULL AND max_reminders=0)
  OR (policy_key NOT IN ('deduction_follow_up','sourcing_contract_return')
    AND due_after_seconds IS NOT NULL
    AND first_reminder_after_due_seconds IS NOT NULL
    AND escalate_after_due_seconds IS NOT NULL)
);
INSERT INTO todo_policies(policy_key,due_after_seconds,first_reminder_after_due_seconds,
  second_reminder_after_due_seconds,escalate_after_due_seconds,max_reminders)
VALUES('sourcing_contract_return',NULL,NULL,NULL,NULL,0);

-- Stop approvals while scanning the historical facts. Lock each monitor row
-- against the first file upload before deciding whether a todo is still open.
LOCK TABLE sourcing_approval_snapshots IN SHARE MODE;

DO $$
DECLARE
  candidate record;
  run_id_value uuid := gen_random_uuid();
  todo_id_value uuid;
  creation_event_id uuid;
  creation_request_id text;
  outbox_id uuid;
  route_value jsonb;
  dedupe_value text;
  created_count integer := 0;
  skipped_count integer := 0;
BEGIN
  INSERT INTO todo_backfill_runs(run_id,mode,status,backfill_started_at,event_high_watermark,counters)
  VALUES(run_id_value,'apply','running',CURRENT_TIMESTAMP,
    jsonb_build_object('scope','sourcing_contract_return','migration','0211'),
    '{}'::jsonb);

  FOR candidate IN
    WITH qualifying AS MATERIALIZED (
      SELECT approval.sourcing_case_id,approval.sourcing_approval_snapshot_id,
        approval.decision_version,approval.operation_event_id,approval.approved_at,
        event.action AS source_action,event.actor_id,event.actor_roles,
        row_number() OVER (PARTITION BY approval.sourcing_case_id
          ORDER BY approval.approved_at DESC,approval.sourcing_approval_snapshot_id DESC) AS approval_rank
      FROM sourcing_approval_snapshots approval
      JOIN operation_events event ON event.event_id=approval.operation_event_id
      WHERE EXISTS (
        SELECT 1 FROM sourcing_owner_decisions owner_decision
        WHERE owner_decision.operation_event_id=approval.operation_event_id
          AND owner_decision.sourcing_decision_id=approval.sourcing_decision_id
          AND owner_decision.decision='approved'
      ) OR EXISTS (
        SELECT 1 FROM sourcing_decisions decision
        JOIN sourcing_factory_change_decisions owner_change
          ON owner_change.factory_change_request_id=decision.source_change_request_id
        WHERE decision.sourcing_decision_id=approval.sourcing_decision_id
          AND owner_change.operation_event_id=approval.operation_event_id
          AND owner_change.decision='approved'
          AND owner_change.decision_role='owner_group'
      )
    )
    SELECT approval.*,source_case.created_by
    FROM qualifying approval
    JOIN sourcing_cases source_case ON source_case.sourcing_case_id=approval.sourcing_case_id
    JOIN sourcing_contract_return_monitors monitor
      ON monitor.sourcing_case_id=source_case.sourcing_case_id
    WHERE approval.approval_rank=1
      AND source_case.deleted_at IS NULL
      AND monitor.contract_return_monitor_enabled
      AND monitor.contract_returned_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM rework_todos todo
        WHERE todo.entity_type='sourcing_case'
          AND todo.entity_id=source_case.sourcing_case_id::text
          AND todo.category='sourcing_contract_return'
      )
    ORDER BY approval.sourcing_case_id
    FOR UPDATE OF monitor
  LOOP
    IF NOT todo_user_has_direct_role(candidate.created_by,'order_merchandiser','sourcing:contract:record')
      OR NOT COALESCE(member_module_can_notify(
        candidate.created_by,
        member_module_for_todo_fact(candidate.source_action,'sourcing_case',
          candidate.sourcing_case_id::text)),true)
    THEN
      INSERT INTO todo_backfill_exceptions(
        exception_id,run_id,entity_type,entity_id,source_event_id,result,detail
      ) VALUES(gen_random_uuid(),run_id_value,'sourcing_case',candidate.sourcing_case_id::text,
        candidate.operation_event_id,'skipped_recipient_inactive',
        jsonb_build_object('createdBy',candidate.created_by,'category','sourcing_contract_return'));
      skipped_count := skipped_count + 1;
      CONTINUE;
    END IF;

    todo_id_value := gen_random_uuid();
    creation_event_id := gen_random_uuid();
    creation_request_id := 'migration-0211-return-'||candidate.sourcing_case_id;
    dedupe_value := 'sourcing:'||candidate.sourcing_case_id||
      ':return:'||candidate.decision_version;
    route_value := jsonb_build_object('routeName','sourcing_detail',
      'entityId',candidate.sourcing_case_id::text,'todoId',todo_id_value::text);

    INSERT INTO operation_events(
      event_id,request_id,actor_id,actor_roles,authorization_capability,
      action,entity_type,entity_id,after_state,reason
    ) VALUES(creation_event_id,creation_request_id,candidate.actor_id,
      candidate.actor_roles,'todo:backfill','todo.create','rework_todo',
      todo_id_value::text,jsonb_build_object('sourceEventId',candidate.operation_event_id,
        'sourceAction',candidate.source_action,'backfilled',true),
      '历史已批准订单待回传合同');
    PERFORM set_config('dx_rework.todo_event_id',creation_event_id::text,true);
    PERFORM set_config('dx_rework.todo_request_id',creation_request_id,true);

    INSERT INTO rework_todos(
      todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
      recipient_user_id,required_role,required_capability,delegation_scope_id,
      route_descriptor,policy_key,due_at,dedupe_key,created_operation_event_id,created_request_id
    ) VALUES(todo_id_value,'business_action','sourcing_contract_return',
      candidate.operation_event_id,candidate.source_action,'sourcing_case',
      candidate.sourcing_case_id::text,candidate.created_by,'order_merchandiser',
      'sourcing:contract:record',candidate.sourcing_case_id::text,
      route_value,'sourcing_contract_return',NULL,dedupe_value,
      creation_event_id,creation_request_id);

    outbox_id := gen_random_uuid();
    INSERT INTO message_outbox(event_id,topic,aggregate_type,aggregate_id,
      payload,recipient_key,idempotency_key)
    VALUES(outbox_id,'todo.delivery','rework_todo',todo_id_value::text,
      jsonb_build_object('todoId',todo_id_value,'recipientUserId',candidate.created_by,
        'category','sourcing_contract_return','deliveryKind','create',
        'route',route_value,'operationEventId',creation_event_id,
        'operationRequestId',creation_request_id),
      'user:'||candidate.created_by,
      'todo:'||todo_id_value||':delivery:'||creation_event_id);

    INSERT INTO todo_delivery_attempts(
      delivery_attempt_id,todo_id,message_outbox_event_id,attempt_no,delivery_kind,
      provider,outcome,operation_event_id,operation_request_id
    ) VALUES(gen_random_uuid(),todo_id_value,outbox_id,0,'create','dingtalk',
      'queued',creation_event_id,creation_request_id);
    created_count := created_count + 1;
  END LOOP;

  UPDATE todo_backfill_runs
  SET status='completed',completed_at=CURRENT_TIMESTAMP,
    counters=jsonb_build_object('created',created_count,'recipientBlocked',skipped_count)
  WHERE run_id=run_id_value;
END;
$$;
