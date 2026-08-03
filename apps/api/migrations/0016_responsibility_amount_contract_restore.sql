-- PR-10 review closure: restore the frozen PR-09 allocation contract and
-- retain legal zero-cent rounded amount lines without permitting zero-bps
-- responsibility allocations or child amount lines detached from their
-- parent process/allocation snapshots.

ALTER TABLE rework_responsibility_allocations
  DROP CONSTRAINT rework_responsibility_allocations_share_bps_check;
ALTER TABLE rework_responsibility_allocations
  ADD CONSTRAINT rework_responsibility_allocations_share_bps_check
  CHECK(share_bps BETWEEN 1 AND 10000);

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
    FROM rework_work_reports report
    JOIN rework_work_report_member_shares share
      ON share.work_report_id = report.work_report_id
     AND share.person_id = NEW.person_id
    LEFT JOIN rework_work_report_rejections rejection
      ON rejection.work_report_id = report.work_report_id
    WHERE report.work_report_id = NEW.work_report_id
      AND report.status = 'submitted'
      AND rejection.work_report_id IS NULL
      AND report.rework_order_id = order_id
      AND report.configuration_item_id = NEW.configuration_item_id
      AND share.amount = NEW.base_member_share_amount
  ) THEN
    RAISE EXCEPTION 'amount line does not match submitted member share snapshot'
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
