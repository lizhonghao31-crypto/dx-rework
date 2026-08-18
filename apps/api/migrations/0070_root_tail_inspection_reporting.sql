-- The HTTP and service layers deliberately allow Root to act as a tail
-- inspector, but the original report guard only accepted the assigned user.
-- Preserve the assigned-user rule for ordinary actors and admit only the
-- database-verified Root identity with its canonical audit-role snapshot.

CREATE OR REPLACE FUNCTION guard_rework_tail_inspection_report_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'submitted'
     OR NEW.rejected_at IS NOT NULL OR NEW.rejected_by IS NOT NULL
     OR NEW.rejection_reason IS NOT NULL OR NEW.supersedes_report_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'a new tail inspection report must start submitted' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1
    FROM rework_tail_inspection_assignments assignment
    JOIN rework_orders target ON target.rework_order_id=assignment.rework_order_id
    JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE assignment.tail_inspection_assignment_id=NEW.tail_inspection_assignment_id
      AND assignment.revoked_at IS NULL
      AND assignment.rework_order_id=NEW.rework_order_id
      AND (
        assignment.tail_inspector_user_id=NEW.submitted_by
        OR (
          event.actor_roles @> ARRAY['root_superuser']::text[]
          AND access_is_root_actor(event.actor_id)
        )
      )
      AND target.status NOT IN ('draft','cancelled','completed','deleted')
      AND event.request_id=NEW.request_id
      AND event.actor_id=NEW.submitted_by
      AND event.action='rework.tail_inspection.submit'
      AND event.authorization_capability='tail_inspection:report'
      AND event.entity_type='rework_tail_inspection_assignment'
      AND event.entity_id=NEW.tail_inspection_assignment_id::text
  ) THEN
    RAISE EXCEPTION 'tail inspection report requires the matching assigned-tail or Root audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
