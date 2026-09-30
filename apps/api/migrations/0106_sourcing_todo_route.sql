-- Sourcing PR3: allow unified todo deep links into the sourcing order detail.
-- Business todos remain in the existing neutral todo table; no parallel task store is introduced.

DO $$
DECLARE
  route_constraint text;
BEGIN
  SELECT constraint_row.conname
    INTO route_constraint
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid='rework_todos'::regclass
    AND constraint_row.contype='c'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%routeName%'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%route_descriptor%'
  ORDER BY constraint_row.conname
  LIMIT 1;

  IF route_constraint IS NULL THEN
    RAISE EXCEPTION 'rework_todos route descriptor constraint was not found';
  END IF;

  EXECUTE format('ALTER TABLE rework_todos DROP CONSTRAINT %I', route_constraint);
END;
$$;

ALTER TABLE rework_todos
  ADD CONSTRAINT rework_todos_route_descriptor_check CHECK(
    jsonb_typeof(route_descriptor)='object'
    AND route_descriptor ? 'routeName'
    AND route_descriptor ? 'entityId'
    AND route_descriptor->>'routeName' IN (
      'rework_detail','process_configuration','whole_order_review',
      'responsibility_detail','own_factory_approval',
      'external_responsibility_detail','wage_period_detail',
      'sourcing_detail'
    )
    AND length(btrim(route_descriptor->>'entityId'))>0
  );


-- Cases created before this release have no transition-time projection. Backfill
-- only the three actionable states into the existing neutral todo table. The
-- source business event, recipient eligibility and dedupe key remain explicit.
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
      case_view.status,
      source.event_id AS source_event_id,
      source.action AS source_action,
      source.actor_id AS source_actor_id,
      source.actor_roles AS source_actor_roles,
      CASE case_view.status
        WHEN 'pending_ie_quote' THEN 'sourcing_ie_quote'
        WHEN 'pending_management_decision' THEN 'sourcing_management_decision'
        WHEN 'pending_owner_approval' THEN 'sourcing_owner_approval'
      END AS category,
      CASE case_view.status
        WHEN 'pending_ie_quote' THEN 'ie_reviewer'
        WHEN 'pending_management_decision' THEN 'production_management'
        WHEN 'pending_owner_approval' THEN 'owner_group'
      END AS required_role,
      CASE case_view.status
        WHEN 'pending_ie_quote' THEN 'sourcing:price:quote'
        WHEN 'pending_management_decision' THEN 'sourcing:decision:record'
        WHEN 'pending_owner_approval' THEN 'sourcing:owner:approve'
      END AS required_capability,
      CASE case_view.status
        WHEN 'pending_ie_quote' THEN
          'sourcing:'||case_view.sourcing_case_id||':ie_quote:'||
          (COALESCE((
            SELECT max(quote.quote_version)
            FROM sourcing_ie_quotes quote
            WHERE quote.sourcing_case_id=case_view.sourcing_case_id
          ),0)+1)
        WHEN 'pending_management_decision' THEN
          'sourcing:'||case_view.sourcing_case_id||':management:'||
          (COALESCE((
            SELECT max(choice.decision_version)
            FROM sourcing_decisions choice
            WHERE choice.sourcing_case_id=case_view.sourcing_case_id
          ),0)+1)
        WHEN 'pending_owner_approval' THEN
          'sourcing:'||case_view.sourcing_case_id||':owner:'||
          COALESCE((
            SELECT max(choice.decision_version)
            FROM sourcing_decisions choice
            WHERE choice.sourcing_case_id=case_view.sourcing_case_id
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
      'pending_ie_quote',
      'pending_management_decision',
      'pending_owner_approval'
    )
  LOOP
    IF candidate.source_event_id IS NULL
       OR candidate.dedupe_prefix IS NULL
       OR candidate.dedupe_prefix LIKE '%:owner:0' THEN
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
        'migration-0106-sourcing-todo-'||candidate.sourcing_case_id||'-'||recipient.user_id;

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
        '报价选厂统一待办升级回填'
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
