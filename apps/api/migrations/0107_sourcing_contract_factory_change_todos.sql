-- Sourcing PR4: backfill actionable contract and factory-change todos for pre-release cases.
DO $$
DECLARE
  candidate record;
  recipient record;
  todo_id_value uuid;
  creation_event_id uuid;
  request_id_value text;
  dedupe_key_value text;
BEGIN
  FOR candidate IN
    SELECT
      case_view.sourcing_case_id,
      source.event_id AS source_event_id,
      source.action AS source_action,
      source.actor_id AS source_actor_id,
      source.actor_roles AS source_actor_roles,
      CASE case_view.status
        WHEN 'pending_contract' THEN 'sourcing_contract_record'
        ELSE 'sourcing_factory_change_verify'
      END AS category,
      CASE case_view.status
        WHEN 'pending_contract' THEN 'order_merchandiser'
        ELSE 'production_management'
      END AS required_role,
      CASE case_view.status
        WHEN 'pending_contract' THEN 'sourcing:contract:record'
        ELSE 'sourcing:factory_change:verify'
      END AS required_capability,
      CASE case_view.status
        WHEN 'pending_contract' THEN
          'sourcing:'||case_view.sourcing_case_id||':contract:'||
          COALESCE((
            SELECT max(choice.decision_version)
            FROM sourcing_decisions choice
            WHERE choice.sourcing_case_id=case_view.sourcing_case_id
          ),0)
        ELSE
          'sourcing:'||case_view.sourcing_case_id||':factory_change:'||
          COALESCE((
            SELECT change.factory_change_request_id::text
            FROM sourcing_factory_change_requests change
            WHERE change.sourcing_case_id=case_view.sourcing_case_id
            ORDER BY change.requested_at DESC,change.factory_change_request_id DESC
            LIMIT 1
          ),'')
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
    WHERE case_view.status IN ('pending_contract','pending_factory_change_verification')
  LOOP
    IF candidate.source_event_id IS NULL
       OR candidate.dedupe_prefix IS NULL
       OR candidate.dedupe_prefix LIKE '%:contract:0'
       OR candidate.dedupe_prefix LIKE '%:factory_change:' THEN
      CONTINUE;
    END IF;

    FOR recipient IN
      SELECT DISTINCT assignment.user_id
      FROM user_role_assignments assignment
      WHERE assignment.role_code=candidate.required_role
        AND assignment.revoked_at IS NULL
        AND todo_user_has_direct_role(
          assignment.user_id,
          candidate.required_role,
          candidate.required_capability
        )
      ORDER BY assignment.user_id
    LOOP
      dedupe_key_value := candidate.dedupe_prefix||':'||recipient.user_id;
      IF EXISTS (
        SELECT 1 FROM rework_todos existing
        WHERE existing.dedupe_key=dedupe_key_value
      ) THEN
        CONTINUE;
      END IF;

      todo_id_value := gen_random_uuid();
      creation_event_id := gen_random_uuid();
      request_id_value :=
        'migration-0107-sourcing-todo-'||candidate.sourcing_case_id||'-'||recipient.user_id;

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
        '报价选厂合同与换厂待办升级回填'
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
          'routeName','sourcing_detail',
          'entityId',candidate.sourcing_case_id::text,
          'todoId',todo_id_value::text
        ),
        'general',CURRENT_TIMESTAMP+INTERVAL '1 day','pending',
        dedupe_key_value,creation_event_id,request_id_value
      );
    END LOOP;
  END LOOP;
END;
$$;
