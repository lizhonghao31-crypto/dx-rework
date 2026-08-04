-- PR-13 package 1: immutable todo facts, delivery attempts and routing exceptions.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('todo:view','查看本人待办','查看已按业务权限路由给本人的返工待办与知会'),
  ('todo:routing_exception_manage','处理待办路由异常','仅处理失效接收人的受控路由异常，不能完成原业务动作')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability)
  SELECT role_code,'todo:view' FROM business_roles
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('production_management','todo:routing_exception_manage')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE todo_policies (
  policy_key text PRIMARY KEY CHECK(policy_key IN (
    'general','finance_return_or_wage_review','deduction_follow_up'
  )),
  due_after_seconds integer CHECK(due_after_seconds IS NULL OR due_after_seconds>0),
  first_reminder_after_due_seconds integer CHECK(first_reminder_after_due_seconds IS NULL OR first_reminder_after_due_seconds>=0),
  second_reminder_after_due_seconds integer CHECK(second_reminder_after_due_seconds IS NULL OR second_reminder_after_due_seconds>0),
  escalate_after_due_seconds integer CHECK(escalate_after_due_seconds IS NULL OR escalate_after_due_seconds>0),
  max_reminders integer NOT NULL CHECK(max_reminders>=0 AND max_reminders<=2),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (policy_key='deduction_follow_up' AND due_after_seconds IS NULL
      AND first_reminder_after_due_seconds IS NULL
      AND second_reminder_after_due_seconds IS NULL
      AND escalate_after_due_seconds IS NULL AND max_reminders=0)
    OR
    (policy_key<>'deduction_follow_up' AND due_after_seconds IS NOT NULL
      AND first_reminder_after_due_seconds IS NOT NULL
      AND escalate_after_due_seconds IS NOT NULL)
  )
);

INSERT INTO todo_policies(
  policy_key,due_after_seconds,first_reminder_after_due_seconds,
  second_reminder_after_due_seconds,escalate_after_due_seconds,max_reminders
) VALUES
  ('general',86400,0,86400,172800,2),
  ('finance_return_or_wage_review',86400,0,NULL,86400,1),
  ('deduction_follow_up',NULL,NULL,NULL,NULL,0);

CREATE TABLE rework_todos (
  todo_id uuid PRIMARY KEY,
  todo_type text NOT NULL CHECK(todo_type IN (
    'business_action','information','recipient_routing_exception'
  )),
  category text NOT NULL CHECK(length(btrim(category)) BETWEEN 1 AND 120),
  source_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  source_action text NOT NULL CHECK(length(btrim(source_action)) BETWEEN 1 AND 128),
  entity_type text NOT NULL CHECK(length(btrim(entity_type)) BETWEEN 1 AND 100),
  entity_id text NOT NULL CHECK(length(btrim(entity_id)) BETWEEN 1 AND 200),
  recipient_user_id uuid NOT NULL REFERENCES app_users(id),
  required_role text REFERENCES business_roles(role_code),
  required_capability text REFERENCES capability_catalog(capability),
  delegation_id uuid REFERENCES delegated_authorizations(delegation_id),
  delegation_scope_id text CHECK(delegation_scope_id IS NULL OR length(btrim(delegation_scope_id)) BETWEEN 1 AND 200),
  route_descriptor jsonb NOT NULL,
  policy_key text REFERENCES todo_policies(policy_key),
  due_at timestamptz,
  reminder_count integer NOT NULL DEFAULT 0 CHECK(reminder_count BETWEEN 0 AND 2),
  last_reminded_at timestamptz,
  escalated_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','blocked_recipient','completed','cancelled'
  )),
  blocked_at timestamptz,
  blocked_reason text CHECK(blocked_reason IS NULL OR length(btrim(blocked_reason)) BETWEEN 1 AND 500),
  completed_at timestamptz,
  completed_by uuid REFERENCES app_users(id),
  cancelled_at timestamptz,
  cancelled_reason text CHECK(cancelled_reason IS NULL OR length(btrim(cancelled_reason)) BETWEEN 1 AND 500),
  dedupe_key text NOT NULL UNIQUE CHECK(length(btrim(dedupe_key)) BETWEEN 1 AND 240),
  created_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  created_request_id text NOT NULL CHECK(length(btrim(created_request_id)) BETWEEN 1 AND 200),
  completed_operation_event_id uuid REFERENCES operation_events(event_id),
  cancelled_operation_event_id uuid REFERENCES operation_events(event_id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    jsonb_typeof(route_descriptor)='object'
    AND route_descriptor ? 'routeName' AND route_descriptor ? 'entityId'
    AND route_descriptor->>'routeName' IN (
      'rework_detail','process_configuration','whole_order_review',
      'responsibility_detail','own_factory_approval',
      'external_responsibility_detail','wage_period_detail'
    )
    AND length(btrim(route_descriptor->>'entityId'))>0
  ),
  CHECK(
    (todo_type='information')=(policy_key IS NULL AND due_at IS NULL
      AND reminder_count=0 AND last_reminded_at IS NULL AND escalated_at IS NULL)
  ),
  CHECK(
    todo_type='information' OR (required_role IS NOT NULL AND required_capability IS NOT NULL)
  ),
  CHECK(delegation_id IS NULL OR delegation_scope_id IS NOT NULL),
  CHECK(
    (status='blocked_recipient')=(blocked_at IS NOT NULL AND blocked_reason IS NOT NULL)
  ),
  CHECK(
    (status='completed')=(completed_at IS NOT NULL AND completed_by IS NOT NULL
      AND completed_operation_event_id IS NOT NULL)
  ),
  CHECK(
    (status='cancelled')=(cancelled_at IS NOT NULL AND cancelled_reason IS NOT NULL
      AND cancelled_operation_event_id IS NOT NULL)
  )
);
CREATE INDEX rework_todos_recipient_status_idx
  ON rework_todos(recipient_user_id,status,due_at,created_at);
CREATE INDEX rework_todos_source_event_idx ON rework_todos(source_event_id);
CREATE INDEX rework_todos_open_due_idx ON rework_todos(due_at,reminder_count)
  WHERE status='pending' AND due_at IS NOT NULL;

CREATE TABLE todo_delivery_attempts (
  delivery_attempt_id uuid PRIMARY KEY,
  todo_id uuid NOT NULL REFERENCES rework_todos(todo_id),
  message_outbox_event_id uuid NOT NULL REFERENCES message_outbox(event_id),
  -- Attempt zero is the immutable enqueue intent. Provider calls begin at one.
  attempt_no integer NOT NULL CHECK(attempt_no>=0),
  delivery_kind text NOT NULL CHECK(delivery_kind IN (
    'create','reminder','escalation','information'
  )),
  provider text NOT NULL CHECK(provider='dingtalk'),
  outcome text NOT NULL CHECK(outcome IN ('queued','sent','failed','unknown_response')),
  provider_message_id text CHECK(provider_message_id IS NULL OR length(provider_message_id)<=200),
  provider_response jsonb,
  error_code text CHECK(error_code IS NULL OR length(error_code)<=100),
  error_message text CHECK(error_message IS NULL OR length(error_message)<=500),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  operation_request_id text NOT NULL CHECK(length(btrim(operation_request_id)) BETWEEN 1 AND 200),
  attempted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(todo_id,message_outbox_event_id,attempt_no),
  CHECK((outcome IN ('failed','unknown_response'))=(error_code IS NOT NULL OR error_message IS NOT NULL))
);
CREATE INDEX todo_delivery_attempts_todo_idx
  ON todo_delivery_attempts(todo_id,attempted_at,delivery_attempt_id);

CREATE TABLE todo_recipient_routing_exceptions (
  routing_exception_id uuid PRIMARY KEY,
  todo_id uuid NOT NULL UNIQUE REFERENCES rework_todos(todo_id),
  routing_todo_id uuid NOT NULL UNIQUE REFERENCES rework_todos(todo_id)
    DEFERRABLE INITIALLY DEFERRED,
  original_recipient_user_id uuid NOT NULL REFERENCES app_users(id),
  assigned_to_user_id uuid NOT NULL REFERENCES app_users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','cancelled')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  resolution_reason text CHECK(resolution_reason IS NULL OR length(btrim(resolution_reason)) BETWEEN 1 AND 500),
  resolved_by uuid REFERENCES app_users(id),
  resolved_at timestamptz,
  created_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  resolved_operation_event_id uuid REFERENCES operation_events(event_id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((status='resolved')=(resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolved_operation_event_id IS NOT NULL))
);
CREATE INDEX todo_routing_exceptions_assignee_idx
  ON todo_recipient_routing_exceptions(assigned_to_user_id,status,created_at);

CREATE TABLE todo_recipient_transfers (
  transfer_id uuid PRIMARY KEY,
  routing_exception_id uuid NOT NULL UNIQUE
    REFERENCES todo_recipient_routing_exceptions(routing_exception_id),
  todo_id uuid NOT NULL REFERENCES rework_todos(todo_id),
  from_recipient_user_id uuid NOT NULL REFERENCES app_users(id),
  to_recipient_user_id uuid NOT NULL REFERENCES app_users(id),
  required_role text NOT NULL REFERENCES business_roles(role_code),
  required_capability text NOT NULL REFERENCES capability_catalog(capability),
  delegation_id uuid REFERENCES delegated_authorizations(delegation_id),
  delegation_scope_id text NOT NULL CHECK(length(btrim(delegation_scope_id)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  transferred_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  operation_request_id text NOT NULL CHECK(length(btrim(operation_request_id)) BETWEEN 1 AND 200),
  transferred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(from_recipient_user_id IS DISTINCT FROM to_recipient_user_id)
);
CREATE INDEX todo_recipient_transfers_todo_idx
  ON todo_recipient_transfers(todo_id,transferred_at,transfer_id);

CREATE TABLE todo_backfill_runs (
  run_id uuid PRIMARY KEY,
  mode text NOT NULL CHECK(mode IN ('dry_run','apply')),
  status text NOT NULL CHECK(status IN ('running','completed','failed')),
  backfill_started_at timestamptz NOT NULL,
  event_high_watermark jsonb NOT NULL,
  cursor jsonb,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by uuid REFERENCES app_users(id),
  completed_at timestamptz,
  error_message text CHECK(error_message IS NULL OR length(error_message)<=500),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(jsonb_typeof(event_high_watermark)='object'),
  CHECK((status='running')=(completed_at IS NULL))
);

CREATE TABLE todo_backfill_exceptions (
  exception_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES todo_backfill_runs(run_id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  source_event_id uuid REFERENCES operation_events(event_id),
  result text NOT NULL CHECK(result IN (
    'skipped_missing_source_event','skipped_ambiguous_recipient',
    'skipped_recipient_inactive','skipped_inapplicable_state','skipped_missing_entity'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id,entity_type,entity_id,result)
);

CREATE OR REPLACE FUNCTION todo_context_event(required_actions text[])
RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE current_event operation_events%ROWTYPE;
BEGIN
  SELECT * INTO current_event FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.todo_request_id',true),'');
  IF current_event.event_id IS NULL OR NOT (current_event.action=ANY(required_actions)) THEN
    RAISE EXCEPTION 'todo write requires matching operation event context'
      USING ERRCODE='55000';
  END IF;
  RETURN current_event;
END;
$$;

CREATE OR REPLACE FUNCTION todo_user_has_direct_role(
  candidate uuid, required_role text, required_capability text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code=assignment.role_code AND role.enabled=true
    JOIN role_capabilities capability
      ON capability.role_code=assignment.role_code AND capability.capability=required_capability
    JOIN app_users user_record
      ON user_record.id=assignment.user_id AND user_record.enabled=true
    JOIN identity_mappings identity
      ON identity.user_id=user_record.id AND identity.provider='dingtalk'
     AND identity.active=true AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
    WHERE assignment.user_id=candidate AND assignment.role_code=required_role
      AND assignment.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION guard_rework_todos_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_action_value text;
BEGIN
  PERFORM todo_context_event(ARRAY['todo.create']);
  SELECT action INTO source_action_value FROM operation_events WHERE event_id=NEW.source_event_id;
  IF source_action_value IS NULL OR source_action_value<>NEW.source_action THEN
    RAISE EXCEPTION 'todo source event and source action must match'
      USING ERRCODE='23514';
  END IF;
  IF NEW.todo_type='recipient_routing_exception' AND (
    NEW.source_action<>'todo.recipient_blocked'
    OR NEW.required_role<>'production_management'
    OR NEW.required_capability<>'todo:routing_exception_manage'
    OR NOT todo_user_has_direct_role(
      NEW.recipient_user_id,'production_management','todo:routing_exception_manage'
    )
    OR NOT EXISTS (
      SELECT 1 FROM todo_recipient_routing_exceptions routing
      WHERE routing.routing_todo_id=NEW.todo_id
        AND routing.assigned_to_user_id=NEW.recipient_user_id
    )
  ) THEN
    RAISE EXCEPTION 'routing exception todo requires its direct production-management assignee'
      USING ERRCODE='23514';
  END IF;
  IF NEW.created_operation_event_id<>nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid
     OR NEW.created_request_id<>nullif(current_setting('dx_rework.todo_request_id',true),'') THEN
    RAISE EXCEPTION 'todo creation audit context mismatch' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_todos_insert_guard
  BEFORE INSERT ON rework_todos FOR EACH ROW EXECUTE FUNCTION guard_rework_todos_insert();

CREATE OR REPLACE FUNCTION guard_rework_todos_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed_actions text[]; current_event operation_events%ROWTYPE;
BEGIN
  IF NEW.todo_id<>OLD.todo_id OR NEW.todo_type<>OLD.todo_type OR NEW.category<>OLD.category
     OR NEW.source_event_id<>OLD.source_event_id OR NEW.source_action<>OLD.source_action
     OR NEW.entity_type<>OLD.entity_type OR NEW.entity_id<>OLD.entity_id
     OR NEW.dedupe_key<>OLD.dedupe_key OR NEW.created_operation_event_id<>OLD.created_operation_event_id
     OR NEW.created_request_id<>OLD.created_request_id THEN
    RAISE EXCEPTION 'todo source facts are immutable' USING ERRCODE='55000';
  END IF;
  IF (NEW.recipient_user_id<>OLD.recipient_user_id OR NEW.required_role IS DISTINCT FROM OLD.required_role
      OR NEW.required_capability IS DISTINCT FROM OLD.required_capability
      OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
      OR NEW.delegation_scope_id IS DISTINCT FROM OLD.delegation_scope_id)
     AND NOT (OLD.status='blocked_recipient' AND NEW.status='pending') THEN
    RAISE EXCEPTION 'todo recipient can only change through a blocked routing transfer'
      USING ERRCODE='55000';
  END IF;
  IF NEW.route_descriptor<>OLD.route_descriptor OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
     OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'todo route and deadline facts are immutable after creation'
      USING ERRCODE='55000';
  END IF;
  allowed_actions := CASE
    WHEN OLD.status='pending' AND NEW.status='blocked_recipient' THEN ARRAY['todo.recipient_blocked']
    WHEN OLD.status IN ('pending','blocked_recipient') AND NEW.status='completed' THEN ARRAY['todo.complete']
    WHEN OLD.status IN ('pending','blocked_recipient') AND NEW.status='cancelled' THEN ARRAY['todo.cancel']
    WHEN OLD.status='blocked_recipient' AND NEW.status='pending' THEN ARRAY['todo.transfer']
    WHEN OLD.status=NEW.status AND NEW.status='pending'
      AND (NEW.reminder_count>OLD.reminder_count OR (NEW.escalated_at IS NOT NULL AND OLD.escalated_at IS NULL)) THEN ARRAY['todo.remind','todo.escalate']
    ELSE ARRAY[]::text[]
  END;
  IF coalesce(array_length(allowed_actions,1),0)=0 THEN
    RAISE EXCEPTION 'invalid todo state transition' USING ERRCODE='23514';
  END IF;
  current_event := todo_context_event(allowed_actions);
  IF NEW.status='completed'
     AND (NEW.completed_operation_event_id<>current_event.event_id OR NEW.completed_by<>current_event.actor_id) THEN
    RAISE EXCEPTION 'todo completion audit context mismatch' USING ERRCODE='55000';
  END IF;
  IF NEW.status='cancelled' AND NEW.cancelled_operation_event_id<>current_event.event_id THEN
    RAISE EXCEPTION 'todo cancellation audit context mismatch' USING ERRCODE='55000';
  END IF;
  IF OLD.status=NEW.status AND NEW.status='pending' THEN
    IF NEW.reminder_count>OLD.reminder_count AND current_event.action<>'todo.remind' THEN
      RAISE EXCEPTION 'todo reminder count requires todo.remind action' USING ERRCODE='55000';
    END IF;
    IF NEW.escalated_at IS NOT NULL AND OLD.escalated_at IS NULL AND current_event.action<>'todo.escalate' THEN
      RAISE EXCEPTION 'todo escalation requires todo.escalate action' USING ERRCODE='55000';
    END IF;
  END IF;
  IF OLD.status='blocked_recipient' AND NEW.status='pending' AND NOT EXISTS (
    SELECT 1 FROM todo_recipient_transfers transfer
    WHERE transfer.todo_id=NEW.todo_id
      AND transfer.from_recipient_user_id=OLD.recipient_user_id
      AND transfer.to_recipient_user_id=NEW.recipient_user_id
      AND transfer.required_role=NEW.required_role
      AND transfer.required_capability=NEW.required_capability
      AND transfer.delegation_id IS NOT DISTINCT FROM NEW.delegation_id
      AND transfer.delegation_scope_id=NEW.delegation_scope_id
      AND transfer.operation_event_id=nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid
  ) THEN
    RAISE EXCEPTION 'blocked todo requires an audited routing transfer' USING ERRCODE='55000';
  END IF;
  NEW.version := OLD.version+1;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_todos_update_guard
  BEFORE UPDATE ON rework_todos FOR EACH ROW EXECUTE FUNCTION guard_rework_todos_update();
CREATE TRIGGER rework_todos_no_delete
  BEFORE DELETE ON rework_todos FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_todo_delivery_attempt_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_event operation_events%ROWTYPE;
BEGIN
  current_event := todo_context_event(ARRAY['todo.create','todo.transfer','todo.remind','todo.escalate','todo.delivery_failed']);
  IF NEW.operation_event_id<>current_event.event_id OR NEW.operation_request_id<>current_event.request_id THEN
    RAISE EXCEPTION 'todo delivery audit context mismatch' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER todo_delivery_attempts_insert_guard
  BEFORE INSERT ON todo_delivery_attempts FOR EACH ROW EXECUTE FUNCTION guard_todo_delivery_attempt_insert();
CREATE TRIGGER todo_delivery_attempts_no_update
  BEFORE UPDATE OR DELETE ON todo_delivery_attempts FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_todo_routing_exception_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_event operation_events%ROWTYPE; todo_record rework_todos%ROWTYPE;
BEGIN
  current_event := todo_context_event(ARRAY['todo.recipient_blocked']);
  IF NEW.created_operation_event_id<>current_event.event_id THEN
    RAISE EXCEPTION 'todo routing exception audit context mismatch' USING ERRCODE='55000';
  END IF;
  SELECT * INTO todo_record FROM rework_todos WHERE todo_id=NEW.todo_id;
  IF todo_record.todo_id IS NULL OR todo_record.status<>'blocked_recipient'
     OR todo_record.recipient_user_id<>NEW.original_recipient_user_id
     OR NEW.routing_todo_id=NEW.todo_id
     OR NOT todo_user_has_direct_role(
       NEW.assigned_to_user_id,'production_management','todo:routing_exception_manage'
     ) THEN
    RAISE EXCEPTION 'todo routing exception requires a blocked todo and active production-management assignee'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER todo_routing_exceptions_insert_guard
  BEFORE INSERT ON todo_recipient_routing_exceptions FOR EACH ROW EXECUTE FUNCTION guard_todo_routing_exception_insert();

CREATE OR REPLACE FUNCTION guard_todo_routing_exception_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_event operation_events%ROWTYPE;
BEGIN
  IF NEW.todo_id<>OLD.todo_id OR NEW.routing_todo_id<>OLD.routing_todo_id
     OR NEW.original_recipient_user_id<>OLD.original_recipient_user_id
     OR NEW.assigned_to_user_id<>OLD.assigned_to_user_id OR NEW.reason<>OLD.reason
     OR NEW.created_operation_event_id<>OLD.created_operation_event_id THEN
    RAISE EXCEPTION 'todo routing exception source facts are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='pending' AND NEW.status IN ('resolved','cancelled') THEN
    current_event := todo_context_event(ARRAY['todo.transfer','todo.cancel']);
    IF NEW.status='resolved'
       AND (NEW.resolved_operation_event_id<>current_event.event_id OR NEW.resolved_by<>current_event.actor_id) THEN
      RAISE EXCEPTION 'todo routing exception resolution audit context mismatch' USING ERRCODE='55000';
    END IF;
  ELSIF OLD.status<>NEW.status THEN
    RAISE EXCEPTION 'invalid todo routing exception transition' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER todo_routing_exceptions_update_guard
  BEFORE UPDATE ON todo_recipient_routing_exceptions FOR EACH ROW EXECUTE FUNCTION guard_todo_routing_exception_update();
CREATE TRIGGER todo_routing_exceptions_no_delete
  BEFORE DELETE ON todo_recipient_routing_exceptions FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_todo_recipient_transfer_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_event operation_events%ROWTYPE; todo_record rework_todos%ROWTYPE;
BEGIN
  current_event := todo_context_event(ARRAY['todo.transfer']);
  SELECT * INTO todo_record FROM rework_todos WHERE todo_id=NEW.todo_id;
  IF todo_record.todo_id IS NULL OR todo_record.status<>'blocked_recipient'
     OR todo_record.recipient_user_id<>NEW.from_recipient_user_id
     OR todo_record.required_role<>NEW.required_role
     OR todo_record.required_capability<>NEW.required_capability
     OR NEW.transferred_by<>current_event.actor_id
     OR NEW.operation_event_id<>current_event.event_id
     OR NEW.operation_request_id<>current_event.request_id THEN
    RAISE EXCEPTION 'todo transfer must match the blocked todo and audit context'
      USING ERRCODE='23514';
  END IF;
  IF NEW.delegation_scope_id<>todo_record.delegation_scope_id OR NOT EXISTS (
    SELECT 1
    FROM todo_recipient_routing_exceptions routing
    JOIN rework_todos routing_todo ON routing_todo.todo_id=routing.routing_todo_id
    WHERE routing.routing_exception_id=NEW.routing_exception_id
      AND routing.todo_id=NEW.todo_id
      AND routing.original_recipient_user_id=NEW.from_recipient_user_id
      AND routing.status='pending'
      AND routing_todo.status='pending'
      AND routing_todo.todo_type='recipient_routing_exception'
      AND routing_todo.category='recipient_routing_exception'
      AND routing_todo.source_event_id=routing.created_operation_event_id
      AND routing_todo.source_action='todo.recipient_blocked'
      AND routing_todo.recipient_user_id=routing.assigned_to_user_id
      AND routing_todo.entity_type=todo_record.entity_type
      AND routing_todo.entity_id=todo_record.entity_id
  ) THEN
    RAISE EXCEPTION 'todo transfer requires its intact pending routing exception'
      USING ERRCODE='23514';
  END IF;
  IF NEW.delegation_id IS NULL THEN
    IF NOT todo_user_has_direct_role(
      NEW.to_recipient_user_id,NEW.required_role,NEW.required_capability
    ) THEN
      RAISE EXCEPTION 'todo transfer target lacks the required direct role'
        USING ERRCODE='42501';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM delegated_authorizations delegation
    JOIN app_users grantee
      ON grantee.id=delegation.grantee_user_id AND grantee.enabled=true
    JOIN identity_mappings identity
      ON identity.user_id=grantee.id AND identity.provider='dingtalk'
     AND identity.active=true AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
    JOIN user_role_assignments grantor_assignment
      ON grantor_assignment.user_id=delegation.grantor_user_id
     AND grantor_assignment.role_code=NEW.required_role
     AND grantor_assignment.revoked_at IS NULL
    WHERE delegation.delegation_id=NEW.delegation_id
      AND delegation.grantee_user_id=NEW.to_recipient_user_id
      AND delegation.capability=NEW.required_capability
      AND delegation.revoked_at IS NULL
      AND CURRENT_TIMESTAMP BETWEEN delegation.valid_from AND delegation.valid_until
      AND delegation.scope_type='rework_order'
      AND delegation.scope_id=NEW.delegation_scope_id
      AND todo_user_has_direct_role(
        delegation.grantor_user_id,NEW.required_role,NEW.required_capability
      )
  ) THEN
    RAISE EXCEPTION 'todo transfer target lacks a valid full delegation chain'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER todo_recipient_transfers_insert_guard
  BEFORE INSERT ON todo_recipient_transfers FOR EACH ROW EXECUTE FUNCTION guard_todo_recipient_transfer_insert();
CREATE TRIGGER todo_recipient_transfers_no_update
  BEFORE UPDATE OR DELETE ON todo_recipient_transfers FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
