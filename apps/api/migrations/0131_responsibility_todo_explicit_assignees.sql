-- N07 responsibility-entry todos belong to explicit production-management
-- assignees. Root keeps emergency action authority but is not an implicit
-- recipient. Cancel only the historical open todos manufactured by Root's
-- superuser fallback when Root has no matching active assignment.

DO $$
DECLARE
  root_user_id uuid;
  open_todo record;
  cancellation_event_id uuid;
  cancellation_request_id text;
  cancellation_reason constant text :=
    '判责待办改为仅投递明确生产管理角色，Root 超级权限不再自动收件';
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
    WHERE todo.entity_type='rework_order'
      AND todo.todo_type='business_action'
      AND todo.category='responsibility_determination'
      AND todo.dedupe_key LIKE 'responsibility-entry:%'
      AND todo.recipient_user_id=root_user_id
      AND todo.status IN ('pending','blocked_recipient')
      AND todo.required_role='production_management'
      AND todo.required_capability='responsibility:determine'
      AND NOT EXISTS (
        SELECT 1
        FROM user_role_assignments assignment
        WHERE assignment.user_id=root_user_id
          AND assignment.role_code='production_management'
          AND assignment.revoked_at IS NULL
      )
    ORDER BY todo.todo_id
    FOR UPDATE
  LOOP
    cancellation_event_id:=gen_random_uuid();
    cancellation_request_id:=
      'migration-0131-cancel-implicit-root-todo-'||open_todo.todo_id;

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
