-- Include confirmed own-factory tail inspection in responsibility totals.
-- Append missing child facts, retain original inputs/signatures/wages, and
-- record the only changed root amount in an immutable correction ledger.
CREATE TABLE rework_own_tail_responsibility_corrections (
  correction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  determination_id uuid NOT NULL UNIQUE REFERENCES rework_responsibility_determinations,
  rework_order_id uuid NOT NULL REFERENCES rework_orders,
  original_calculation_total numeric(18,2) NOT NULL,
  added_responsibility_amount numeric(18,2) NOT NULL CHECK (added_responsibility_amount >= 0),
  corrected_calculation_total numeric(18,2) NOT NULL,
  source_snapshot jsonb NOT NULL,
  authorization_basis text NOT NULL,
  reason text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (corrected_calculation_total = original_calculation_total + added_responsibility_amount)
);
CREATE TRIGGER own_tail_correction_no_update BEFORE UPDATE ON rework_own_tail_responsibility_corrections
FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation();
CREATE TRIGGER own_tail_correction_no_delete BEFORE DELETE ON rework_own_tail_responsibility_corrections
FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation();
CREATE TRIGGER own_tail_correction_no_truncate BEFORE TRUNCATE ON rework_own_tail_responsibility_corrections
FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_mutation();

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
  SELECT * INTO determination
  FROM rework_responsibility_determinations
  WHERE determination_id = version_id;

  IF determination.determination_id IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO approved_count
  FROM rework_process_configurations configuration
  JOIN rework_process_configuration_items item USING(configuration_id)
  JOIN rework_orders target_order
    ON target_order.rework_order_id = configuration.rework_order_id
  WHERE configuration.rework_order_id = determination.rework_order_id
    AND configuration.status = 'approved'
    AND (
      item.execution_kind = 'worker'
      OR (
        item.execution_kind = 'tail_inspection'
        AND (
          target_order.tail_inspection_cost_bearer = 'processing_factory'
          OR (determination.settlement_schema_version = 2
            AND target_order.tail_inspection_cost_bearer = 'own_factory'
            AND target_order.tail_inspection_cost_bearer_source IN ('quality_inspection','production_override'))
        )
      )
    );

  SELECT count(*) INTO process_count
  FROM rework_responsibility_processes
  WHERE determination_id = version_id;

  IF process_count <> approved_count THEN
    RAISE EXCEPTION 'responsibility processes must exactly cover chargeable approved configuration'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rework_responsibility_processes process
    WHERE process.determination_id = version_id
      AND (
        NOT EXISTS (
          SELECT 1 FROM rework_responsibility_allocations allocation
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
            SELECT DISTINCT line.work_report_id,line.person_id,
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

  SELECT count(*) INTO high_count
  FROM rework_responsibility_processes
  WHERE determination_id = version_id AND multiplier > 2;

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


-- Exclude concurrent edits during the one-time repair. Normal child guards,
-- amount/source coverage and allocation constraints remain enabled throughout.
LOCK TABLE rework_orders, rework_responsibility_determinations,
  rework_process_configurations, rework_process_configuration_items,
  rework_wage_items, rework_work_reports, rework_work_report_rejections
IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE rework_responsibility_determinations
  DISABLE TRIGGER rework_responsibility_determinations_no_update;

DO $repair$
DECLARE
  target record;
  tail record;
  source record;
  added numeric(18,2);
  snapshots jsonb;
BEGIN
  FOR target IN
    SELECT d.*
    FROM rework_responsibility_determinations d
    JOIN rework_orders o USING (rework_order_id)
    WHERE o.status NOT IN ('deleted','cancelled')
      AND o.tail_inspection_required
      AND o.tail_inspection_cost_bearer = 'own_factory'
      AND o.tail_inspection_cost_bearer_source IN ('quality_inspection','production_override')
      AND d.settlement_schema_version = 2
      AND NOT EXISTS (SELECT 1 FROM rework_responsibility_determinations n
        WHERE n.replaces_determination_id = d.determination_id)
      AND NOT EXISTS (SELECT 1 FROM rework_own_tail_responsibility_corrections c
        WHERE c.determination_id = d.determination_id)
    ORDER BY d.rework_order_id
  LOOP
    added := 0;
    snapshots := '[]'::jsonb;
    PERFORM set_config('dx_rework.responsibility_event_id',target.operation_event_id::text,true);
    PERFORM set_config('dx_rework.responsibility_request_id',target.request_id,true);
    FOR tail IN
      SELECT i.* FROM rework_process_configurations c
      JOIN rework_process_configuration_items i USING (configuration_id)
      WHERE c.rework_order_id = target.rework_order_id AND c.status = 'approved'
        AND i.execution_kind = 'tail_inspection'
        AND NOT EXISTS (SELECT 1 FROM rework_responsibility_processes p
          WHERE p.determination_id = target.determination_id
            AND p.configuration_item_id = i.configuration_item_id)
      ORDER BY i.configuration_item_id
    LOOP
      -- Same unadjusted base and per-person rounding as the live V2 engine;
      -- temporary-worker uplifts are deliberately not responsibility amounts.
      SELECT count(*) count, sum(base) base_amount, sum(round(base,2)) amount,
        jsonb_agg(jsonb_build_object('wageItemId',wage_item_id,
          'workReportId',work_report_id,'personId',person_id,
          'baseAmount',base,'responsibilityAmount',round(base,2))
          ORDER BY work_report_id,person_id) facts
      INTO source
      FROM (
        SELECT w.*, round(w.actual_quantity_snapshot * w.unit_price_snapshot *
          CASE WHEN w.assignment_mode='collective'
            THEN 1::numeric/NULLIF(w.member_count,0) ELSE 1 END,8) base
        FROM rework_wage_items w
        JOIN rework_work_reports r ON r.work_report_id=w.work_report_id
          AND r.rework_order_id=w.rework_order_id
          AND r.configuration_item_id=w.configuration_item_id
        WHERE w.rework_order_id=target.rework_order_id
          AND w.configuration_item_id=tail.configuration_item_id
          AND w.invalidated_at IS NULL AND r.status='submitted'
          AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection
            WHERE rejection.work_report_id=r.work_report_id)
      ) wages;
      IF source.count=0 OR source.base_amount IS NULL OR source.amount IS NULL THEN
        RAISE EXCEPTION '0165 missing reviewed tail wage sources for determination %, process %',
          target.determination_id,tail.configuration_item_id;
      END IF;
      INSERT INTO rework_responsibility_processes (
        determination_id,configuration_item_id,process_name_snapshot,pricing_unit_snapshot,
        multiplier,high_multiplier_reason,base_amount,responsibility_amount,operation_event_id,request_id
      ) VALUES (target.determination_id,tail.configuration_item_id,tail.process_name,tail.pricing_unit,
        1,NULL,source.base_amount,source.amount,target.operation_event_id,target.request_id);
      INSERT INTO rework_responsibility_allocations (
        determination_id,configuration_item_id,responsibility_type,share_bps,rounded_amount,
        operation_event_id,request_id,multiplier
      ) VALUES (target.determination_id,tail.configuration_item_id,'own_factory',10000,
        source.amount,target.operation_event_id,target.request_id,1);
      INSERT INTO rework_responsibility_amount_lines (
        determination_id,configuration_item_id,work_report_id,person_id,responsibility_type,
        base_member_share_amount,multiplier,share_bps,unrounded_amount,rounded_amount,
        rounding_rule,worker_display_name_snapshot,task_mode_snapshot,member_snapshot,
        report_snapshot,operation_event_id,request_id
      )
      SELECT target.determination_id,tail.configuration_item_id,w.work_report_id,w.person_id,
        'own_factory',w.base,1,10000,w.base,round(w.base,2),'half_up_2',
        w.person_name_snapshot,w.assignment_mode,w.member_snapshot,w.source_report_snapshot,
        target.operation_event_id,target.request_id
      FROM (
        SELECT wage.*, round(wage.actual_quantity_snapshot * wage.unit_price_snapshot *
          CASE WHEN wage.assignment_mode='collective'
            THEN 1::numeric/NULLIF(wage.member_count,0) ELSE 1 END,8) base
        FROM rework_wage_items wage
        JOIN rework_work_reports r ON r.work_report_id=wage.work_report_id
          AND r.rework_order_id=wage.rework_order_id
          AND r.configuration_item_id=wage.configuration_item_id
        WHERE wage.rework_order_id=target.rework_order_id
          AND wage.configuration_item_id=tail.configuration_item_id
          AND wage.invalidated_at IS NULL AND r.status='submitted'
          AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection
            WHERE rejection.work_report_id=r.work_report_id)
      ) w;
      added := added + source.amount;
      snapshots := snapshots || jsonb_build_array(jsonb_build_object(
        'configurationItemId',tail.configuration_item_id,'processName',tail.process_name,
        'wageSources',source.facts,'originalProcess',NULL));
    END LOOP;
    IF jsonb_array_length(snapshots)>0 THEN
      INSERT INTO rework_own_tail_responsibility_corrections (
        determination_id,rework_order_id,original_calculation_total,added_responsibility_amount,
        corrected_calculation_total,source_snapshot,authorization_basis,reason
      ) VALUES (target.determination_id,target.rework_order_id,target.calculation_total,added,
        target.calculation_total+added,snapshots,
        '2026-09-09 业务负责人批准：修复本厂整查责任遗漏，覆盖历史订单',
        '0165：补齐已明确由本厂承担的整查责任，100% × 1；保留原工资、判责输入、审批和外部扣款');
      UPDATE rework_responsibility_determinations
        SET calculation_total=target.calculation_total+added
        WHERE determination_id=target.determination_id;
      PERFORM validate_responsibility_version(target.determination_id);
      PERFORM validate_responsibility_amount_line_coverage(target.determination_id);
    END IF;
  END LOOP;
END
$repair$;
ALTER TABLE rework_responsibility_determinations
  ENABLE TRIGGER rework_responsibility_determinations_no_update;
