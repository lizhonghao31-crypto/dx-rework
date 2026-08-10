-- UAT 1.6: responsibility deductions use the settled piecework wage amount.
--
-- Work-report shares are retained at up to three decimals for operational
-- measurement, while rework_wage_items holds the immutable two-decimal payable
-- allocation generated when the whole order is approved.  Responsibility uses
-- that settled amount as its base before applying allocation and multiplier.

CREATE OR REPLACE FUNCTION guard_responsibility_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_id uuid;
  parent_actor uuid;
  parent_multiplier numeric(8,3);
  parent_share_bps integer;
BEGIN
  SELECT determination.rework_order_id,
         determination.created_by,
         process.multiplier,
         allocation.share_bps
  INTO order_id, parent_actor, parent_multiplier, parent_share_bps
  FROM rework_responsibility_determinations determination
  JOIN rework_responsibility_processes process
    ON process.determination_id = determination.determination_id
   AND process.configuration_item_id = NEW.configuration_item_id
  JOIN rework_responsibility_allocations allocation
    ON allocation.determination_id = process.determination_id
   AND allocation.configuration_item_id = process.configuration_item_id
   AND allocation.responsibility_type = NEW.responsibility_type
  WHERE determination.determination_id = NEW.determination_id;

  IF order_id IS NULL
     OR NEW.multiplier IS DISTINCT FROM parent_multiplier
     OR NEW.share_bps IS DISTINCT FROM parent_share_bps THEN
    RAISE EXCEPTION 'amount line inputs must match parent responsibility snapshots'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM rework_wage_items wage
    WHERE wage.rework_order_id = order_id
      AND wage.configuration_item_id = NEW.configuration_item_id
      AND wage.work_report_id = NEW.work_report_id
      AND wage.person_id = NEW.person_id
      AND wage.payable_amount = NEW.base_member_share_amount
  ) THEN
    RAISE EXCEPTION 'amount line does not match settled piecework wage'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.unrounded_amount IS DISTINCT FROM
       round(
         NEW.base_member_share_amount * parent_multiplier *
         parent_share_bps / 10000,
         15
       )
     OR NEW.rounded_amount IS DISTINCT FROM round(NEW.unrounded_amount, 2)
     OR NEW.rounded_amount < 0 THEN
    RAISE EXCEPTION 'amount line calculation is invalid'
      USING ERRCODE = '23514';
  END IF;

  PERFORM require_responsibility_event(
    NEW.operation_event_id,
    NEW.request_id,
    order_id,
    parent_actor
  );
  RETURN NEW;
END
$$;
