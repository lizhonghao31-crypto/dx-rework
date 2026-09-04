-- Keep every quantity created from a receiving-linked rework order within the
-- actual quantity of that exact receiving batch. Legacy manually-created
-- rework orders have no source batch and retain their historical behaviour.

CREATE OR REPLACE FUNCTION rework_source_receiving_actual_quantity(target_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN orders.source_receiving_batch_id IS NULL THEN NULL
    ELSE COALESCE(receiving.actual_quantity, 0)
  END
  FROM rework_orders orders
  LEFT JOIN LATERAL (
    SELECT (COALESCE(sum(receipt.actual_quantity), 0) + batch.actual_quantity_adjustment)::numeric AS actual_quantity
    FROM receiving_batches batch
    LEFT JOIN receiving_receipts receipt
      ON receipt.receiving_batch_id = batch.receiving_batch_id
    WHERE batch.receiving_batch_id = orders.source_receiving_batch_id
    GROUP BY batch.receiving_batch_id
  ) receiving ON true
  WHERE orders.rework_order_id = target_order_id
    AND orders.status <> 'deleted'
$$;

CREATE OR REPLACE FUNCTION guard_rework_source_receiving_quantity_ceiling()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_order_id uuid;
  submitted_quantity numeric;
  receiving_ceiling numeric;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'rework_process_configuration_items' THEN
      SELECT configuration.rework_order_id INTO target_order_id
      FROM rework_process_configurations configuration
      WHERE configuration.configuration_id = NEW.configuration_id;
      submitted_quantity := NEW.planned_quantity;
    WHEN 'rework_process_quantity_adjustments' THEN
      target_order_id := NEW.rework_order_id;
      submitted_quantity := NEW.requested_planned_quantity;
    WHEN 'rework_work_reports' THEN
      target_order_id := NEW.rework_order_id;
      submitted_quantity := NEW.actual_quantity;
    WHEN 'rework_work_report_quantity_revisions' THEN
      target_order_id := NEW.rework_order_id;
      submitted_quantity := NEW.effective_quantity;
    WHEN 'rework_tail_inspection_reports' THEN
      target_order_id := NEW.rework_order_id;
      submitted_quantity := NEW.returned_quantity;
    WHEN 'rework_tail_completion_quantities' THEN
      SELECT confirmation.rework_order_id INTO target_order_id
      FROM rework_tail_completion_confirmations confirmation
      WHERE confirmation.confirmation_id = NEW.confirmation_id;
      submitted_quantity := greatest(
        NEW.worker_reported_quantity,
        NEW.tail_reported_quantity,
        NEW.final_confirmed_quantity
      );
    ELSE
      RAISE EXCEPTION 'unsupported receiving quantity ceiling table: %', TG_TABLE_NAME;
  END CASE;

  receiving_ceiling := rework_source_receiving_actual_quantity(target_order_id);
  IF receiving_ceiling IS NOT NULL AND submitted_quantity > receiving_ceiling THEN
    RAISE EXCEPTION 'rework quantity exceeds source receiving actual quantity ceiling %', receiving_ceiling
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_process_items_receiving_quantity_ceiling
  BEFORE INSERT OR UPDATE OF planned_quantity ON rework_process_configuration_items
  FOR EACH ROW EXECUTE FUNCTION guard_rework_source_receiving_quantity_ceiling();

CREATE TRIGGER rework_quantity_adjustments_receiving_quantity_ceiling
  BEFORE INSERT ON rework_process_quantity_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_rework_source_receiving_quantity_ceiling();

CREATE TRIGGER rework_work_reports_receiving_quantity_ceiling
  BEFORE INSERT ON rework_work_reports
  FOR EACH ROW EXECUTE FUNCTION guard_rework_source_receiving_quantity_ceiling();

CREATE TRIGGER rework_work_report_revisions_receiving_quantity_ceiling
  BEFORE INSERT ON rework_work_report_quantity_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_rework_source_receiving_quantity_ceiling();

CREATE TRIGGER rework_tail_reports_receiving_quantity_ceiling
  BEFORE INSERT ON rework_tail_inspection_reports
  FOR EACH ROW EXECUTE FUNCTION guard_rework_source_receiving_quantity_ceiling();

CREATE TRIGGER rework_tail_completion_receiving_quantity_ceiling
  BEFORE INSERT ON rework_tail_completion_quantities
  FOR EACH ROW EXECUTE FUNCTION guard_rework_source_receiving_quantity_ceiling();
