-- Treat whole inspection as the physical upper bound for every rework process.
-- A process may report fewer pieces than whole inspection, but never more.
-- Keep internal tail_inspection identifiers unchanged for compatibility.

CREATE OR REPLACE FUNCTION guard_rework_tail_completion_quantity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order_id uuid;
  tail_required boolean;
  worker_quantity numeric(18,2);
  tail_quantity numeric(18,2);
BEGIN
  SELECT confirmation.rework_order_id,target.tail_inspection_required
    INTO target_order_id,tail_required
  FROM rework_tail_completion_confirmations confirmation
  JOIN rework_orders target ON target.rework_order_id=confirmation.rework_order_id
  WHERE confirmation.confirmation_id=NEW.confirmation_id
    AND confirmation.workflow_stage='pending_ie_review'
    AND confirmation.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND confirmation.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  FOR SHARE OF confirmation,target;
  IF target_order_id IS NULL THEN RAISE EXCEPTION 'quantity line lacks active final confirmation' USING ERRCODE='55000'; END IF;

  SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) INTO worker_quantity
  FROM rework_work_reports report
  JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
  JOIN rework_process_configurations configuration ON configuration.configuration_id=item.configuration_id
  WHERE report.rework_order_id=target_order_id
    AND report.configuration_item_id=NEW.configuration_item_id
    AND item.execution_kind='worker' AND configuration.status='approved'
    AND report.status='submitted'
    AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id);

  SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) INTO tail_quantity
  FROM rework_work_reports report
  JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
  WHERE report.rework_order_id=target_order_id
    AND item.execution_kind='tail_inspection'
    AND report.status='submitted'
    AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id);

  IF worker_quantity<=0 OR NEW.worker_reported_quantity<>worker_quantity THEN
    RAISE EXCEPTION 'final quantity line does not match immutable worker facts' USING ERRCODE='23514';
  END IF;

  IF tail_required THEN
    IF worker_quantity>tail_quantity
       OR NEW.tail_reported_quantity<>tail_quantity
       OR NEW.final_confirmed_quantity<>worker_quantity
    THEN
      RAISE EXCEPTION 'final quantity requires positive worker facts not exceeding whole-inspection facts' USING ERRCODE='23514';
    END IF;
  ELSIF tail_quantity<>0 OR NEW.tail_reported_quantity<>0 OR NEW.final_confirmed_quantity<>worker_quantity THEN
    RAISE EXCEPTION 'no-tail final quantity must equal immutable worker facts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_order_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unified_execution boolean;
  tail_required boolean;
  tail_process_count bigint;
BEGIN
  SELECT target.tail_inspection_required
  INTO tail_required
  FROM rework_orders target
  WHERE target.rework_order_id=NEW.rework_order_id
    AND target.status='pending_final_quantity_ie_review';
  IF tail_required IS NULL
  THEN RAISE EXCEPTION 'order is not pending IE final-quantity review' USING ERRCODE='23514'; END IF;

  SELECT configuration.unified_execution_required INTO unified_execution
  FROM rework_process_configurations configuration
  WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' LIMIT 1;

  IF unified_execution IS NULL OR EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item USING(configuration_id)
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND item.unit_price IS NULL
  ) THEN RAISE EXCEPTION 'every IE-approved process requires a price' USING ERRCODE='23514'; END IF;

  SELECT count(*) INTO tail_process_count
  FROM rework_process_configurations configuration
  JOIN rework_process_configuration_items item USING(configuration_id)
  WHERE configuration.rework_order_id=NEW.rework_order_id
    AND configuration.status='approved'
    AND item.execution_kind='tail_inspection';

  IF unified_execution AND (
    (tail_required AND tail_process_count<>1)
    OR (NOT tail_required AND tail_process_count>1)
  ) THEN RAISE EXCEPTION 'unified execution tail-inspection process does not match the order decision' USING ERRCODE='23514'; END IF;

  IF NOT EXISTS(
    SELECT 1 FROM rework_tail_completion_confirmations confirmation
    JOIN rework_tail_completion_reviews review ON review.confirmation_id=confirmation.confirmation_id AND review.decision='approved'
    WHERE confirmation.rework_order_id=NEW.rework_order_id AND confirmation.workflow_stage='pending_ie_review'
      AND review.reviewed_by=NEW.reviewed_by
      AND review.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND review.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  ) THEN RAISE EXCEPTION 'approved IE final-quantity review is required' USING ERRCODE='23514'; END IF;

  IF EXISTS(
    SELECT 1 FROM rework_work_tasks task
    WHERE task.rework_order_id=NEW.rework_order_id AND task.status='active'
      AND NOT EXISTS(SELECT 1 FROM rework_work_reports report WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id))
  ) THEN RAISE EXCEPTION 'every active execution task requires a valid report' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND tail_required AND EXISTS(
    SELECT 1 FROM rework_tail_inspection_assignments assignment
    WHERE assignment.rework_order_id=NEW.rework_order_id AND assignment.revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM rework_tail_inspection_reports report
        WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id AND report.status='submitted')
  ) THEN RAISE EXCEPTION 'every active legacy tail inspector requires a submitted count' USING ERRCODE='23514'; END IF;

  IF unified_execution AND tail_required AND EXISTS(
    WITH tail_total AS (
      SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) AS quantity
      FROM rework_work_reports report
      JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
      WHERE report.rework_order_id=NEW.rework_order_id AND item.execution_kind='tail_inspection' AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    )
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    CROSS JOIN tail_total
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) AS quantity
      FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    ) worker ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND item.execution_kind='worker'
      AND worker.quantity>tail_total.quantity
  ) THEN RAISE EXCEPTION 'worker count cannot exceed unified whole-inspection count' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND tail_required AND EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    ) worker ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report_item.inspected_quantity),0) AS quantity
      FROM rework_tail_inspection_report_items report_item
      JOIN rework_tail_inspection_reports report ON report.tail_inspection_report_id=report_item.tail_inspection_report_id AND report.status='submitted'
      JOIN rework_tail_inspection_assignments assignment ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id AND assignment.revoked_at IS NULL
      WHERE report.rework_order_id=NEW.rework_order_id AND report_item.configuration_item_id=item.configuration_item_id
    ) tail_checked ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND worker.quantity>tail_checked.quantity
  ) THEN RAISE EXCEPTION 'worker count cannot exceed legacy tail inspection count' USING ERRCODE='23514'; END IF;

  IF EXISTS(
    SELECT 1 FROM rework_work_reports report
    WHERE report.rework_order_id=NEW.rework_order_id AND report.status='submitted'
      AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
      AND report.group_amount<=0
  ) THEN RAISE EXCEPTION 'every valid report requires generated wages' USING ERRCODE='23514'; END IF;

  PERFORM require_whole_order_review_event('rework.final_quantity.ie_review','process:review',NEW.rework_order_id,NEW.reviewed_by);
  RETURN NEW;
END;
$$;
