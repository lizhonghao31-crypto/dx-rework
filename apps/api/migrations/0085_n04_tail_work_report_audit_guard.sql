-- Unified N04 stores both worker and tail-inspection completion facts in
-- rework_work_reports. Keep the original event/request/order binding while
-- admitting the reviewed tail-inspection reporting capability.

CREATE OR REPLACE FUNCTION guard_rework_work_report_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=current_setting('dx_rework.work_event_id',true)::uuid
      AND event.request_id=current_setting('dx_rework.work_request_id',true)
      AND event.action='rework.work_report.submit'
      AND event.authorization_capability IN (
        'work:report',
        'work:report_for_worker',
        'tail_inspection:report'
      )
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
  ) THEN
    RAISE EXCEPTION 'work report requires authorized audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_share_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_work_reports report
    JOIN operation_events event ON event.entity_id=report.rework_order_id::text
    WHERE report.work_report_id=NEW.work_report_id
      AND event.event_id=current_setting('dx_rework.work_event_id',true)::uuid
      AND event.request_id=current_setting('dx_rework.work_request_id',true)
      AND event.action='rework.work_report.submit'
      AND event.authorization_capability IN (
        'work:report',
        'work:report_for_worker',
        'tail_inspection:report'
      )
  ) THEN
    RAISE EXCEPTION 'work report share requires authorized audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
