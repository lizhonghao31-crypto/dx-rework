-- Optional-tail orders have no tail report fact. Keep the historical guard
-- unchanged for mandatory-tail orders while allowing N05 to persist the
-- worker-derived final quantity for explicitly no-tail orders.

ALTER TABLE rework_tail_completion_quantities
  DROP CONSTRAINT rework_tail_completion_quantities_check;

ALTER TABLE rework_tail_completion_quantities
  ADD CONSTRAINT rework_tail_completion_quantities_final_within_reported_check
  CHECK(
    (tail_reported_quantity>0 AND final_confirmed_quantity<=tail_reported_quantity)
    OR
    (tail_reported_quantity=0 AND final_confirmed_quantity<=worker_reported_quantity)
  );

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
    IF worker_quantity<>tail_quantity
       OR NEW.tail_reported_quantity<>tail_quantity
       OR NEW.final_confirmed_quantity<>worker_quantity
    THEN
      RAISE EXCEPTION 'final quantity must equal reconciled effective worker and tail facts' USING ERRCODE='23514';
    END IF;
  ELSIF tail_quantity<>0 OR NEW.tail_reported_quantity<>0 OR NEW.final_confirmed_quantity<>worker_quantity THEN
    RAISE EXCEPTION 'no-tail final quantity must equal immutable worker facts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
