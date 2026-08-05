-- PR-13 additive external DingTalk todo binding lifecycle.

ALTER TABLE todo_delivery_attempts
  DROP CONSTRAINT todo_delivery_attempts_delivery_kind_check;
ALTER TABLE todo_delivery_attempts
  ADD CONSTRAINT todo_delivery_attempts_delivery_kind_check CHECK(delivery_kind IN (
    'create','complete','update','transfer','reminder','escalation','information'
  ));

CREATE TABLE dingtalk_todo_external_bindings (
  binding_id uuid PRIMARY KEY,
  todo_id uuid NOT NULL REFERENCES rework_todos(todo_id),
  external_generation integer NOT NULL CHECK(external_generation>0),
  recipient_user_id uuid NOT NULL REFERENCES app_users(id),
  recipient_union_id text NOT NULL CHECK(length(btrim(recipient_union_id)) BETWEEN 1 AND 200),
  provider text NOT NULL DEFAULT 'dingtalk' CHECK(provider='dingtalk'),
  provider_todo_id text NOT NULL CHECK(length(btrim(provider_todo_id)) BETWEEN 1 AND 200),
  source_key text NOT NULL CHECK(length(btrim(source_key)) BETWEEN 1 AND 240),
  provider_state text NOT NULL CHECK(provider_state IN ('active','completed','cancelled','unknown_response')),
  create_outbox_event_id uuid NOT NULL REFERENCES message_outbox(event_id),
  create_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  complete_outbox_event_id uuid REFERENCES message_outbox(event_id),
  complete_operation_event_id uuid REFERENCES operation_events(event_id),
  update_outbox_event_id uuid REFERENCES message_outbox(event_id),
  update_operation_event_id uuid REFERENCES operation_events(event_id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider,source_key),
  UNIQUE(todo_id,external_generation),
  CHECK((provider_state IN ('completed','cancelled'))=(complete_outbox_event_id IS NOT NULL AND complete_operation_event_id IS NOT NULL))
);

CREATE UNIQUE INDEX dingtalk_todo_external_bindings_one_active_idx
  ON dingtalk_todo_external_bindings(todo_id,external_generation)
  WHERE provider_state IN ('active','unknown_response');

CREATE TABLE dingtalk_todo_external_binding_events (
  binding_event_id uuid PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES dingtalk_todo_external_bindings(binding_id),
  message_outbox_event_id uuid NOT NULL REFERENCES message_outbox(event_id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(length(btrim(request_id)) BETWEEN 1 AND 200),
  action text NOT NULL CHECK(action IN ('create','complete','update','transfer','reminder','escalation','information')),
  provider_state text NOT NULL CHECK(provider_state IN ('active','completed','cancelled','unknown_response','retryable_failed','permanent_failed')),
  provider_request_id text CHECK(provider_request_id IS NULL OR length(provider_request_id)<=200),
  provider_todo_id text CHECK(provider_todo_id IS NULL OR length(provider_todo_id)<=200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(binding_id,message_outbox_event_id,action)
);

CREATE TRIGGER dingtalk_todo_external_bindings_no_delete
  BEFORE DELETE ON dingtalk_todo_external_bindings FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER dingtalk_todo_external_binding_events_no_update
  BEFORE UPDATE OR DELETE ON dingtalk_todo_external_binding_events FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
