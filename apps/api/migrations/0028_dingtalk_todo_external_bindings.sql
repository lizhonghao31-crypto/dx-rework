-- PR-13 additive DingTalk external todo lifecycle and runtime authority.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('todo:runtime','运行待办后台任务','仅允许后台执行待办投递、催办和升级扫描，不授予业务处理权限')
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('system_admin','todo:runtime')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

ALTER TABLE todo_delivery_attempts
  DROP CONSTRAINT todo_delivery_attempts_delivery_kind_check;
ALTER TABLE todo_delivery_attempts
  ADD CONSTRAINT todo_delivery_attempts_delivery_kind_check CHECK(delivery_kind IN (
    'create','complete','update','reminder','escalation','information'
  ));

CREATE OR REPLACE FUNCTION guard_todo_delivery_attempt_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_event operation_events%ROWTYPE;
BEGIN
  current_event := todo_context_event(ARRAY[
    'todo.create','todo.transfer','todo.remind','todo.escalate',
    'todo.complete','todo.cancel','todo.delivery_failed'
  ]);
  IF NEW.operation_event_id<>current_event.event_id
     OR NEW.operation_request_id<>current_event.request_id THEN
    RAISE EXCEPTION 'todo delivery audit context mismatch' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE dingtalk_todo_external_bindings (
  binding_id uuid PRIMARY KEY,
  todo_id uuid NOT NULL REFERENCES rework_todos(todo_id),
  external_generation integer NOT NULL CHECK(external_generation>0),
  recipient_user_id uuid NOT NULL REFERENCES app_users(id),
  recipient_union_id text NOT NULL CHECK(length(btrim(recipient_union_id)) BETWEEN 1 AND 200),
  provider text NOT NULL DEFAULT 'dingtalk' CHECK(provider='dingtalk'),
  provider_todo_id text CHECK(provider_todo_id IS NULL OR length(btrim(provider_todo_id)) BETWEEN 1 AND 200),
  source_key text NOT NULL CHECK(length(btrim(source_key)) BETWEEN 1 AND 240),
  provider_state text NOT NULL CHECK(provider_state IN (
    'creating','active','unknown_response','completed','cancelled','permanent_failed'
  )),
  create_outbox_event_id uuid NOT NULL REFERENCES message_outbox(event_id),
  create_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  terminal_outbox_event_id uuid REFERENCES message_outbox(event_id),
  terminal_operation_event_id uuid REFERENCES operation_events(event_id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider,source_key),
  UNIQUE(todo_id,external_generation),
  CHECK(provider_state IN ('creating','unknown_response','permanent_failed') OR provider_todo_id IS NOT NULL),
  CHECK(
    (provider_state IN ('completed','cancelled'))
      = (terminal_outbox_event_id IS NOT NULL AND terminal_operation_event_id IS NOT NULL)
  )
);
CREATE INDEX dingtalk_todo_external_bindings_todo_state_idx
  ON dingtalk_todo_external_bindings(todo_id,provider_state,external_generation DESC);
CREATE INDEX dingtalk_todo_external_bindings_provider_id_idx
  ON dingtalk_todo_external_bindings(provider_todo_id)
  WHERE provider_todo_id IS NOT NULL;

CREATE TABLE dingtalk_todo_external_binding_events (
  binding_event_id uuid PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES dingtalk_todo_external_bindings(binding_id),
  message_outbox_event_id uuid NOT NULL REFERENCES message_outbox(event_id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(length(btrim(request_id)) BETWEEN 1 AND 200),
  action text NOT NULL CHECK(action IN (
    'create','complete','update','reminder','escalation','information'
  )),
  provider_state text NOT NULL CHECK(provider_state IN (
    'creating','active','unknown_response','completed','cancelled',
    'retryable_failed','permanent_failed'
  )),
  provider_request_id text CHECK(provider_request_id IS NULL OR length(provider_request_id)<=200),
  provider_todo_id text CHECK(provider_todo_id IS NULL OR length(provider_todo_id)<=200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(binding_id,message_outbox_event_id,action,provider_state)
);

CREATE TRIGGER dingtalk_todo_external_bindings_no_delete
  BEFORE DELETE ON dingtalk_todo_external_bindings FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER dingtalk_todo_external_bindings_no_truncate
  BEFORE TRUNCATE ON dingtalk_todo_external_bindings FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER dingtalk_todo_external_binding_events_no_update
  BEFORE UPDATE OR DELETE ON dingtalk_todo_external_binding_events FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER dingtalk_todo_external_binding_events_no_truncate
  BEFORE TRUNCATE ON dingtalk_todo_external_binding_events FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION todo_stable_uuid(seed text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    substr(md5(seed),1,8)||'-'||substr(md5(seed),9,4)||'-4'||substr(md5(seed),14,3)||
    '-8'||substr(md5(seed),18,3)||'-'||substr(md5(seed),21,12)
  )::uuid;
$$;

CREATE OR REPLACE FUNCTION enqueue_todo_external_delivery(
  todo_record rework_todos,
  delivery_kind text,
  recipient_user_id uuid,
  operation_event_id uuid,
  operation_request_id text,
  idempotency_suffix text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  outbox_event_id uuid := todo_stable_uuid(
    'todo-external-outbox:'||todo_record.todo_id::text||':'||idempotency_suffix
  );
  attempt_id uuid := todo_stable_uuid(
    'todo-external-attempt:'||todo_record.todo_id::text||':'||idempotency_suffix
  );
  stable_idempotency_key text :=
    'todo:'||todo_record.todo_id::text||':external:'||idempotency_suffix;
BEGIN
  IF delivery_kind NOT IN ('complete','update','escalation') THEN
    RAISE EXCEPTION 'unsupported database-enqueued todo delivery kind'
      USING ERRCODE='23514';
  END IF;
  INSERT INTO message_outbox(
    event_id,topic,aggregate_type,aggregate_id,payload,recipient_key,idempotency_key
  ) VALUES(
    outbox_event_id,'todo.delivery','rework_todo',todo_record.todo_id::text,
    jsonb_build_object(
      'todoId',todo_record.todo_id,
      'recipientUserId',recipient_user_id,
      'category',todo_record.category,
      'deliveryKind',delivery_kind,
      'route',todo_record.route_descriptor,
      'operationEventId',operation_event_id,
      'operationRequestId',operation_request_id
    ),
    'todo:'||todo_record.todo_id::text||':external',stable_idempotency_key
  )
  ON CONFLICT(topic,recipient_key,idempotency_key) DO NOTHING;

  SELECT event_id INTO outbox_event_id
  FROM message_outbox
  WHERE topic='todo.delivery'
    AND recipient_key='todo:'||todo_record.todo_id::text||':external'
    AND idempotency_key=stable_idempotency_key;

  INSERT INTO todo_delivery_attempts(
    delivery_attempt_id,todo_id,message_outbox_event_id,attempt_no,delivery_kind,
    provider,outcome,operation_event_id,operation_request_id
  ) VALUES(
    attempt_id,todo_record.todo_id,outbox_event_id,0,delivery_kind,
    'dingtalk','queued',operation_event_id,operation_request_id
  ) ON CONFLICT(todo_id,message_outbox_event_id,attempt_no) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION project_todo_external_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_id uuid;
  request_id text;
BEGIN
  IF OLD.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id
     AND OLD.status='blocked_recipient' AND NEW.status='pending' THEN
    event_id := nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid;
    request_id := nullif(current_setting('dx_rework.todo_request_id',true),'');
    IF event_id IS NULL OR request_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM operation_events event
      WHERE event.event_id=event_id AND event.request_id=request_id
        AND event.action='todo.transfer'
        AND event.entity_type='rework_todo'
        AND event.entity_id=NEW.todo_id::text
    ) THEN
      RAISE EXCEPTION 'todo external transfer projection requires trusted audit context'
        USING ERRCODE='55000';
    END IF;
    PERFORM enqueue_todo_external_delivery(
      OLD,'complete',OLD.recipient_user_id,event_id,request_id,
      'transfer-close:'||event_id::text
    );
  END IF;

  IF OLD.status IN ('pending','blocked_recipient')
     AND NEW.status IN ('completed','cancelled') THEN
    event_id := CASE NEW.status
      WHEN 'completed' THEN NEW.completed_operation_event_id
      ELSE NEW.cancelled_operation_event_id
    END;
    SELECT event.request_id INTO request_id
    FROM operation_events event
    WHERE event.event_id=event_id
      AND event.action=CASE NEW.status WHEN 'completed' THEN 'todo.complete' ELSE 'todo.cancel' END
      AND event.entity_type='rework_todo'
      AND event.entity_id=NEW.todo_id::text;
    IF request_id IS NULL THEN
      RAISE EXCEPTION 'todo external terminal projection requires matching audit event'
        USING ERRCODE='55000';
    END IF;
    PERFORM enqueue_todo_external_delivery(
      NEW,'complete',OLD.recipient_user_id,event_id,request_id,
      'terminal:'||NEW.status||':'||event_id::text
    );
  END IF;

  IF OLD.escalated_at IS NULL AND NEW.escalated_at IS NOT NULL
     AND NEW.status='pending' THEN
    event_id := nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid;
    request_id := nullif(current_setting('dx_rework.todo_request_id',true),'');
    IF event_id IS NULL OR request_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM operation_events event
      WHERE event.event_id=event_id AND event.request_id=request_id
        AND event.action='todo.escalate'
        AND event.entity_type='rework_todo'
        AND event.entity_id=NEW.todo_id::text
    ) THEN
      RAISE EXCEPTION 'todo external escalation projection requires trusted audit context'
        USING ERRCODE='55000';
    END IF;
    PERFORM enqueue_todo_external_delivery(
      NEW,'escalation',NEW.recipient_user_id,event_id,request_id,
      'escalation:'||event_id::text
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_todos_external_lifecycle_projection
  AFTER UPDATE ON rework_todos FOR EACH ROW
  EXECUTE FUNCTION project_todo_external_lifecycle();
