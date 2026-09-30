-- PR-13 originally created IE-review todos but the business review transition
-- did not close them. Repair only open todos whose exact configuration version
-- already has an approved/rejected review fact. The existing terminal
-- projection then queues the DingTalk executor-status update for active
-- external bindings.

DO $$
DECLARE
  stale record;
  completion_event_id uuid;
  completion_request_id text;
BEGIN
  FOR stale IN
    SELECT
      todo.todo_id,
      todo.status AS todo_status,
      review.actor_id,
      review.actor_roles,
      review.authorization_capability,
      configuration.reviewed_at
    FROM rework_todos todo
    JOIN rework_process_configurations configuration
      ON configuration.rework_order_id::text=todo.entity_id
     AND todo.dedupe_key=(
       'ie-review:'||configuration.rework_order_id::text||':'||configuration.configuration_version::text
     )
    JOIN LATERAL (
      SELECT
        event.actor_id,
        event.actor_roles,
        event.authorization_capability
      FROM operation_events event
      WHERE event.action='rework.process_configuration.review'
        AND event.entity_type='rework_order'
        AND event.entity_id=configuration.rework_order_id::text
        AND event.after_state->'configuration'->>'configurationId'=configuration.configuration_id::text
        AND event.after_state->'configuration'->>'status'=configuration.status
      ORDER BY event.created_at DESC,event.event_id DESC
      LIMIT 1
    ) review ON true
    WHERE todo.todo_type='business_action'
      AND todo.category='ie_review'
      AND todo.entity_type='rework_order'
      AND todo.status IN ('pending','blocked_recipient')
      AND configuration.status IN ('approved','rejected')
    ORDER BY todo.todo_id
    FOR UPDATE OF todo
  LOOP
    completion_event_id := todo_stable_uuid(
      'migration-0052:ie-review-complete:'||stale.todo_id::text
    );
    completion_request_id := 'migration-0052:ie-review-complete:'||stale.todo_id::text;

    INSERT INTO operation_events(
      event_id,request_id,actor_id,actor_roles,authorization_capability,
      action,entity_type,entity_id,before_state,after_state,reason
    ) VALUES(
      completion_event_id,
      completion_request_id,
      stale.actor_id,
      stale.actor_roles,
      stale.authorization_capability,
      'todo.complete',
      'rework_todo',
      stale.todo_id::text,
      jsonb_build_object('status',stale.todo_status,'repair','0052_ie_review_todo_completion_repair'),
      jsonb_build_object('status','completed','repair','0052_ie_review_todo_completion_repair'),
      'IE process review was already completed before todo completion projection was connected'
    );

    PERFORM set_config('dx_rework.todo_event_id',completion_event_id::text,true);
    PERFORM set_config('dx_rework.todo_request_id',completion_request_id,true);

    UPDATE rework_todos
    SET status='completed',
        completed_at=COALESCE(stale.reviewed_at,CURRENT_TIMESTAMP),
        completed_by=stale.actor_id,
        completed_operation_event_id=completion_event_id
    WHERE todo_id=stale.todo_id
      AND status IN ('pending','blocked_recipient');
  END LOOP;
END
$$;
