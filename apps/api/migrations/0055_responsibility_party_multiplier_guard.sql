-- N07 V2 stores the commercial multiplier on each responsible party.
-- Keep the immutable amount-line guard, but compare and calculate against the
-- allocation snapshot (falling back to the process snapshot for historical
-- V1 rows) instead of rejecting valid mixed 1.0/1.2 responsibility splits.

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
         COALESCE(allocation.multiplier, process.multiplier),
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
