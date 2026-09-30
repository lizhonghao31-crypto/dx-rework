-- PR-09 repair-review closure: require complete amount-line coverage for every reviewed source share.

CREATE OR REPLACE FUNCTION validate_responsibility_amount_line_coverage(version_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_responsibility_determinations determination
    WHERE determination.determination_id = version_id
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    (
      SELECT report.work_report_id,
             share.person_id,
             allocation.configuration_item_id,
             allocation.responsibility_type
      FROM rework_responsibility_determinations determination
      JOIN rework_responsibility_allocations allocation
        ON allocation.determination_id = determination.determination_id
      JOIN rework_work_reports report
        ON report.rework_order_id = determination.rework_order_id
       AND report.configuration_item_id = allocation.configuration_item_id
       AND report.status = 'submitted'
      JOIN rework_work_report_member_shares share
        ON share.work_report_id = report.work_report_id
      LEFT JOIN rework_work_report_rejections rejection
        ON rejection.work_report_id = report.work_report_id
      WHERE determination.determination_id = version_id
        AND rejection.work_report_id IS NULL
      EXCEPT
      SELECT line.work_report_id,
             line.person_id,
             line.configuration_item_id,
             line.responsibility_type
      FROM rework_responsibility_amount_lines line
      WHERE line.determination_id = version_id
    )
    UNION ALL
    (
      SELECT line.work_report_id,
             line.person_id,
             line.configuration_item_id,
             line.responsibility_type
      FROM rework_responsibility_amount_lines line
      WHERE line.determination_id = version_id
      EXCEPT
      SELECT report.work_report_id,
             share.person_id,
             allocation.configuration_item_id,
             allocation.responsibility_type
      FROM rework_responsibility_determinations determination
      JOIN rework_responsibility_allocations allocation
        ON allocation.determination_id = determination.determination_id
      JOIN rework_work_reports report
        ON report.rework_order_id = determination.rework_order_id
       AND report.configuration_item_id = allocation.configuration_item_id
       AND report.status = 'submitted'
      JOIN rework_work_report_member_shares share
        ON share.work_report_id = report.work_report_id
      LEFT JOIN rework_work_report_rejections rejection
        ON rejection.work_report_id = report.work_report_id
      WHERE determination.determination_id = version_id
        AND rejection.work_report_id IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'responsibility amount lines must exactly cover reviewed source shares'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION run_responsibility_amount_line_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM validate_responsibility_amount_line_coverage(NEW.determination_id);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER determination_source_share_coverage
AFTER INSERT ON rework_responsibility_determinations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION run_responsibility_amount_line_coverage();

CREATE CONSTRAINT TRIGGER process_source_share_coverage
AFTER INSERT ON rework_responsibility_processes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION run_responsibility_amount_line_coverage();

CREATE CONSTRAINT TRIGGER allocation_source_share_coverage
AFTER INSERT ON rework_responsibility_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION run_responsibility_amount_line_coverage();

CREATE CONSTRAINT TRIGGER amount_line_source_share_coverage
AFTER INSERT ON rework_responsibility_amount_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION run_responsibility_amount_line_coverage();
