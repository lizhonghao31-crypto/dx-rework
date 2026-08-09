-- PR-37 practical precision contract.
-- Keep the existing piece/hour business units, but stop carrying precision that
-- has no practical meaning for the rework shop floor.
--
-- New business facts:
--   planned / reported / adjusted quantity: at most 1 decimal place
--   unit price: at most 2 decimal places and at least 0.01 yuan
--   group amount / member share: at most 3 decimal places
--
-- Historical rows remain immutable. NOT VALID constraints enforce the new rule
-- for new rows without rewriting previously accepted history.

DO $$
DECLARE
  piece_integer_constraint text;
BEGIN
  SELECT conname
  INTO piece_integer_constraint
  FROM pg_constraint
  WHERE conrelid='rework_process_configuration_items'::regclass
    AND contype='c'
    AND pg_get_constraintdef(oid) ILIKE '%pricing_unit%piece%planned_quantity%trunc%'
  ORDER BY conname
  LIMIT 1;

  IF piece_integer_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE rework_process_configuration_items DROP CONSTRAINT %I',
      piece_integer_constraint
    );
  END IF;
END;
$$;

ALTER TABLE rework_process_configuration_items
  ADD CONSTRAINT rework_process_item_planned_quantity_practical_precision
    CHECK (planned_quantity = trunc(planned_quantity, 1)) NOT VALID,
  ADD CONSTRAINT rework_process_item_unit_price_practical_precision
    CHECK (unit_price >= 0.01 AND unit_price = trunc(unit_price, 2)) NOT VALID;

ALTER TABLE rework_work_reports
  ADD CONSTRAINT rework_work_report_quantity_practical_precision
    CHECK (actual_quantity = trunc(actual_quantity, 1)) NOT VALID,
  ADD CONSTRAINT rework_work_report_group_amount_practical_precision
    CHECK (group_amount = trunc(group_amount, 3)) NOT VALID;

ALTER TABLE rework_work_report_member_shares
  ADD CONSTRAINT rework_work_report_share_practical_precision
    CHECK (amount = trunc(amount, 3)) NOT VALID;

ALTER TABLE rework_process_quantity_adjustments
  ADD CONSTRAINT rework_quantity_adjustment_previous_practical_precision
    CHECK (previous_planned_quantity = trunc(previous_planned_quantity, 1)) NOT VALID,
  ADD CONSTRAINT rework_quantity_adjustment_requested_practical_precision
    CHECK (requested_planned_quantity = trunc(requested_planned_quantity, 1)) NOT VALID,
  ADD CONSTRAINT rework_quantity_adjustment_cut_practical_precision
    CHECK (actual_cut_quantity IS NULL OR actual_cut_quantity = trunc(actual_cut_quantity, 1)) NOT VALID,
  ADD CONSTRAINT rework_quantity_adjustment_return_practical_precision
    CHECK (actual_return_quantity IS NULL OR actual_return_quantity = trunc(actual_return_quantity, 1)) NOT VALID,
  ADD CONSTRAINT rework_quantity_adjustment_max_practical_precision
    CHECK (allowed_maximum_quantity IS NULL OR allowed_maximum_quantity = trunc(allowed_maximum_quantity, 1)) NOT VALID;
