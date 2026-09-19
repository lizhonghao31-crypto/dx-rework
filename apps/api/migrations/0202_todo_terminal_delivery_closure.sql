-- Close terminal DingTalk todo completion deliveries that cannot produce any further
-- provider action. This backfill only touches outbox transport state; immutable
-- todo, binding and audit facts remain unchanged.

WITH terminal_complete_delivery AS (
  SELECT outbox.event_id
  FROM message_outbox outbox
  WHERE outbox.topic='todo.delivery'
    AND outbox.status IN ('pending','failed')
    AND outbox.payload->>'deliveryKind'='complete'
    AND outbox.aggregate_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND COALESCE(outbox.payload->>'recipientUserId','')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND NOT EXISTS (
      SELECT 1
      FROM dingtalk_todo_external_bindings binding
      WHERE binding.todo_id=outbox.aggregate_id::uuid
        AND binding.recipient_user_id=(outbox.payload->>'recipientUserId')::uuid
        AND binding.provider_state IN ('creating','active','unknown_response')
    )
    AND (
      EXISTS (
        SELECT 1
        FROM dingtalk_todo_external_bindings binding
        WHERE binding.todo_id=outbox.aggregate_id::uuid
          AND binding.recipient_user_id=(outbox.payload->>'recipientUserId')::uuid
          AND binding.provider_state IN ('completed','cancelled','permanent_failed')
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM dingtalk_todo_external_bindings binding
          WHERE binding.todo_id=outbox.aggregate_id::uuid
            AND binding.recipient_user_id=(outbox.payload->>'recipientUserId')::uuid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM message_outbox creation
          WHERE creation.topic='todo.delivery'
            AND creation.aggregate_type='rework_todo'
            AND creation.aggregate_id=outbox.aggregate_id
            AND creation.payload->>'recipientUserId'=outbox.payload->>'recipientUserId'
            AND creation.payload->>'deliveryKind' IN ('create','information')
            AND creation.status IN ('pending','processing','failed')
        )
      )
    )
)
UPDATE message_outbox outbox
SET status='sent',
    sent_at=COALESCE(outbox.sent_at,CURRENT_TIMESTAMP),
    claimed_at=NULL,
    claim_token=NULL,
    last_error=NULL,
    updated_at=CURRENT_TIMESTAMP
FROM terminal_complete_delivery terminal
WHERE outbox.event_id=terminal.event_id;
