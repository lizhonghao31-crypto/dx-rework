-- PR-06 Responsibility 2.0 permits a finalized external-only determination
-- to skip owner confirmation.  Its immutable source event is the canonical
-- responsibility finalization event; mixed or own-factory determinations keep
-- the owner-signature event.
CREATE OR REPLACE FUNCTION require_external_responsibility_event(
  expected_action text,
  expected_capability text,
  order_id uuid,
  persisted_actor uuid
) RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  compatible_action text;
BEGIN
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=nullif(
      current_setting('dx_rework.external_responsibility_event_id',true),''
    )::uuid
    AND request_id=nullif(
      current_setting('dx_rework.external_responsibility_request_id',true),''
    );
  compatible_action:=CASE expected_action
    WHEN 'rework.external_responsibility.revision.approve'
      THEN 'rework.external_responsibility.revision.approved'
    WHEN 'rework.external_responsibility.revision.reject'
      THEN 'rework.external_responsibility.revision.rejected'
    WHEN 'rework.responsibility.submit_owner_signature'
      THEN 'rework.responsibility.finalize'
    ELSE NULL
  END;
  IF event_record.event_id IS NULL
     OR event_record.actor_id<>persisted_actor
     OR (
       event_record.action<>expected_action
       AND (
         compatible_action IS NULL
         OR event_record.action<>compatible_action
       )
     )
     OR event_record.authorization_capability<>expected_capability
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>order_id::text THEN
    RAISE EXCEPTION 'external responsibility write requires matching trusted event'
      USING ERRCODE='55000';
  END IF;
  RETURN event_record;
END $$;

