-- Sourcing business todos belong to explicit role assignments. Root keeps
-- emergency action authority, but superuser status alone is not a recipient
-- rule. Cancel previously projected Root todos when Root has no matching role.

DO $$
DECLARE
  root_user_id uuid;
  open_todo record;
  cancellation_event_id uuid;
  cancellation_request_id text;
  cancellation_reason constant text :=
    '报价选厂待办改为仅投递明确业务角色，Root 超级权限不再自动收件';
BEGIN
  IF to_regclass('rework_todos') IS NULL THEN
    RETURN;
  END IF;

  SELECT root.user_id INTO root_user_id
  FROM owner_bootstrap_consumptions root
  WHERE root.singleton=true;

  IF root_user_id IS NULL THEN
    RETURN;
  END IF;

  FOR open_todo IN
    SELECT todo.todo_id,todo.status,todo.required_role,todo.required_capability
    FROM rework_todos todo
    WHERE todo.entity_type='sourcing_case'
      AND todo.todo_type='business_action'
      AND todo.recipient_user_id=root_user_id
      AND todo.status IN ('pending','blocked_recipient')
      AND todo.required_role IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM user_role_assignments assignment
        WHERE assignment.user_id=root_user_id
          AND assignment.role_code=todo.required_role
          AND assignment.revoked_at IS NULL
      )
    ORDER BY todo.todo_id
    FOR UPDATE
  LOOP
    cancellation_event_id := gen_random_uuid();
    cancellation_request_id :=
      'migration-0123-cancel-implicit-root-todo-'||open_todo.todo_id;

    INSERT INTO operation_events(
      event_id,request_id,actor_id,actor_roles,authorization_capability,
      action,entity_type,entity_id,before_state,after_state,reason
    ) VALUES(
      cancellation_event_id,cancellation_request_id,root_user_id,
      ARRAY['root_superuser']::text[],'todo:backfill',
      'todo.cancel','rework_todo',open_todo.todo_id::text,
      jsonb_build_object(
        'status',open_todo.status,
        'requiredRole',open_todo.required_role,
        'requiredCapability',open_todo.required_capability
      ),
      jsonb_build_object('status','cancelled','implicitRootRecipient',false),
      cancellation_reason
    );

    PERFORM set_config(
      'dx_rework.todo_event_id',cancellation_event_id::text,true
    );
    PERFORM set_config(
      'dx_rework.todo_request_id',cancellation_request_id,true
    );

    UPDATE rework_todos
    SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,
        cancelled_reason=cancellation_reason,
        cancelled_operation_event_id=cancellation_event_id,
        blocked_at=NULL,blocked_reason=NULL
    WHERE todo_id=open_todo.todo_id;
  END LOOP;
END;
$$;
