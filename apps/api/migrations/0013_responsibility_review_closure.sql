-- PR-09 post-review closure: exact source sums, parent-bound amount lines,
-- zero-cent line support, and finalized root snapshot integrity.

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
       round(NEW.base_member_share_amount * parent_multiplier * parent_share_bps / 10000, 15)
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

CREATE OR REPLACE FUNCTION validate_responsibility_version(version_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  determination rework_responsibility_determinations%ROWTYPE;
  approved_count integer;
  process_count integer;
  high_count integer;
BEGIN
  SELECT *
  INTO determination
  FROM rework_responsibility_determinations
  WHERE determination_id = version_id;

  IF determination.determination_id IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*)
  INTO approved_count
  FROM rework_process_configurations configuration
  JOIN rework_process_configuration_items item USING(configuration_id)
  WHERE configuration.rework_order_id = determination.rework_order_id
    AND configuration.status = 'approved';

  SELECT count(*)
  INTO process_count
  FROM rework_responsibility_processes
  WHERE determination_id = version_id;

  IF process_count <> approved_count THEN
    RAISE EXCEPTION 'responsibility processes must exactly cover approved configuration'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rework_responsibility_processes process
    WHERE process.determination_id = version_id
      AND (
        NOT EXISTS (
          SELECT 1
          FROM rework_responsibility_allocations allocation
          WHERE allocation.determination_id = process.determination_id
            AND allocation.configuration_item_id = process.configuration_item_id
        )
        OR (
          SELECT sum(allocation.share_bps)
          FROM rework_responsibility_allocations allocation
          WHERE allocation.determination_id = process.determination_id
            AND allocation.configuration_item_id = process.configuration_item_id
        ) <> 10000
      )
  ) THEN
    RAISE EXCEPTION 'responsibility allocations must total 10000 bps'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rework_responsibility_allocations allocation
    WHERE allocation.determination_id = version_id
      AND allocation.rounded_amount IS DISTINCT FROM (
        SELECT coalesce(sum(line.rounded_amount), 0)
        FROM rework_responsibility_amount_lines line
        WHERE line.determination_id = allocation.determination_id
          AND line.configuration_item_id = allocation.configuration_item_id
          AND line.responsibility_type = allocation.responsibility_type
      )
  ) THEN
    RAISE EXCEPTION 'allocation total differs from amount lines'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rework_responsibility_processes process
    WHERE process.determination_id = version_id
      AND (
        process.responsibility_amount IS DISTINCT FROM (
          SELECT coalesce(sum(line.rounded_amount), 0)
          FROM rework_responsibility_amount_lines line
          WHERE line.determination_id = process.determination_id
            AND line.configuration_item_id = process.configuration_item_id
        )
        OR process.base_amount IS DISTINCT FROM (
          SELECT coalesce(sum(source.base_member_share_amount), 0)
          FROM (
            SELECT DISTINCT
                   line.work_report_id,
                   line.person_id,
                   line.base_member_share_amount
            FROM rework_responsibility_amount_lines line
            WHERE line.determination_id = process.determination_id
              AND line.configuration_item_id = process.configuration_item_id
          ) source
        )
      )
  ) THEN
    RAISE EXCEPTION 'process totals differ from source lines'
      USING ERRCODE = '23514';
  END IF;

  IF determination.calculation_total IS DISTINCT FROM (
    SELECT coalesce(sum(process.responsibility_amount), 0)
    FROM rework_responsibility_processes process
    WHERE process.determination_id = version_id
  ) THEN
    RAISE EXCEPTION 'determination total differs from processes'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO high_count
  FROM rework_responsibility_processes
  WHERE determination_id = version_id
    AND multiplier > 2;

  IF determination.stage = 'finalized'
     AND (
       (high_count = 0 AND determination.source_high_multiplier_confirmation_id IS NOT NULL)
       OR (high_count > 0 AND determination.source_high_multiplier_confirmation_id IS NULL)
     ) THEN
    RAISE EXCEPTION 'finalized high multiplier confirmation is invalid'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION validate_finalized_responsibility_root_copy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor rework_responsibility_determinations%ROWTYPE;
BEGIN
  IF NEW.stage <> 'finalized' THEN
    RETURN NULL;
  END IF;

  SELECT *
  INTO predecessor
  FROM rework_responsibility_determinations
  WHERE determination_id = NEW.replaces_determination_id;

  IF predecessor.determination_id IS NULL
     OR predecessor.stage <> 'draft'
     OR NEW.rework_order_id IS DISTINCT FROM predecessor.rework_order_id
     OR NEW.source_order_review_id IS DISTINCT FROM predecessor.source_order_review_id
     OR NEW.reason IS DISTINCT FROM predecessor.reason
     OR NEW.input_snapshot IS DISTINCT FROM predecessor.input_snapshot
     OR NEW.calculation_total IS DISTINCT FROM predecessor.calculation_total THEN
    RAISE EXCEPTION 'finalized version must copy the predecessor draft root snapshot'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS finalized_root_copy_complete
  ON rework_responsibility_determinations;
CREATE CONSTRAINT TRIGGER finalized_root_copy_complete
AFTER INSERT ON rework_responsibility_determinations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_finalized_responsibility_root_copy();
