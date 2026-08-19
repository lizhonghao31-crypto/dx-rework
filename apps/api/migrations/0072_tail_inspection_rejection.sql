-- Allow N07 to reject an incorrect N06 tail-inspection count without deleting audit history.

DROP TRIGGER IF EXISTS rework_tail_inspection_reports_no_update
  ON rework_tail_inspection_reports;

CREATE OR REPLACE FUNCTION guard_rework_tail_inspection_report_rejection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_record operation_events%ROWTYPE;
BEGIN
  IF OLD.status<>'submitted'
     OR NEW.status<>'rejected'
     OR NEW.tail_inspection_report_id IS DISTINCT FROM OLD.tail_inspection_report_id
     OR NEW.tail_inspection_assignment_id IS DISTINCT FROM OLD.tail_inspection_assignment_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.returned_quantity IS DISTINCT FROM OLD.returned_quantity
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.supersedes_report_id IS DISTINCT FROM OLD.supersedes_report_id
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.rejected_at IS NULL
     OR NEW.rejected_by IS NULL
     OR length(btrim(NEW.rejection_reason)) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'tail inspection report may only be rejected once with an audited reason'
      USING ERRCODE='55000';
  END IF;

  SELECT * INTO event_record
  FROM operation_events event
  WHERE event.event_id=NULLIF(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND event.request_id=NULLIF(current_setting('dx_rework.rework_request_id',true),'')
    AND event.actor_id=NEW.rejected_by
    AND event.authorization_capability='submission:audit'
    AND event.action='rework.tail_inspection.reject'
    AND event.entity_type='rework_tail_inspection_assignment'
    AND event.entity_id=NEW.tail_inspection_assignment_id::text;

  IF event_record.event_id IS NULL THEN
    RAISE EXCEPTION 'tail inspection rejection requires the matching supervisor audit event'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER rework_tail_inspection_reports_guard_rejection
  BEFORE UPDATE ON rework_tail_inspection_reports
  FOR EACH ROW
  EXECUTE FUNCTION guard_rework_tail_inspection_report_rejection();
