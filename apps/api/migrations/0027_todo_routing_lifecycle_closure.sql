-- PR-13 closure: an original blocked todo may be re-routed after its first
-- routing manager becomes ineligible. Historical exceptions remain immutable;
-- only one pending exception is allowed for a given original todo.

ALTER TABLE todo_recipient_routing_exceptions
  DROP CONSTRAINT todo_recipient_routing_exceptions_todo_id_key;

ALTER TABLE todo_recipient_routing_exceptions
  ADD COLUMN cancelled_operation_event_id uuid REFERENCES operation_events(event_id);

CREATE UNIQUE INDEX todo_routing_exceptions_one_pending_per_todo_idx
  ON todo_recipient_routing_exceptions(todo_id)
  WHERE status='pending';

ALTER TABLE todo_recipient_routing_exceptions
  ADD CONSTRAINT todo_routing_exceptions_cancel_audit_check CHECK(
    (status='cancelled')=(cancelled_operation_event_id IS NOT NULL)
  );

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
  IF OLD.status='pending' AND NEW.status='resolved' THEN
    current_event := todo_context_event(ARRAY['todo.transfer']);
    IF NEW.resolved_operation_event_id<>current_event.event_id OR NEW.resolved_by<>current_event.actor_id
       OR NEW.cancelled_operation_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'todo routing exception resolution audit context mismatch' USING ERRCODE='55000';
    END IF;
  ELSIF OLD.status='pending' AND NEW.status='cancelled' THEN
    current_event := todo_context_event(ARRAY['todo.cancel']);
    IF current_event.entity_type<>'rework_todo'
       OR current_event.entity_id<>NEW.routing_todo_id::text
       OR NEW.cancelled_operation_event_id<>current_event.event_id
       OR NOT EXISTS (
         SELECT 1 FROM rework_todos routing_todo
         WHERE routing_todo.todo_id=NEW.routing_todo_id
           AND routing_todo.status='cancelled'
           AND routing_todo.cancelled_operation_event_id=current_event.event_id
       ) THEN
      RAISE EXCEPTION 'todo routing exception cancellation must close its exact routing todo' USING ERRCODE='55000';
    END IF;
  ELSIF OLD.status<>NEW.status THEN
    RAISE EXCEPTION 'invalid todo routing exception transition' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;
