-- Repair the one completed HO20544223 responsibility snapshot that predates
-- explicit tail-inspection cost ownership. The correction is deliberately
-- narrow, fail-closed and auditable: any unexpected production fact aborts
-- the migration instead of guessing or rewriting another order.

CREATE TABLE rework_responsibility_business_corrections (
  correction_id uuid PRIMARY KEY,
  migration_version text NOT NULL,
  rework_order_id uuid NOT NULL REFERENCES rework_orders,
  determination_id uuid NOT NULL REFERENCES rework_responsibility_determinations,
  batch_id uuid NOT NULL REFERENCES rework_external_responsibility_batches,
  case_id uuid NOT NULL REFERENCES rework_external_responsibility_cases,
  tail_configuration_item_ids uuid[] NOT NULL
    CHECK (cardinality(tail_configuration_item_ids) > 0),
  original_responsibility_amount numeric(18,2) NOT NULL,
  original_external_amount numeric(18,2) NOT NULL,
  added_tail_wage_base numeric(18,2) NOT NULL CHECK (added_tail_wage_base > 0),
  added_responsibility_amount numeric(18,2) NOT NULL
    CHECK (added_responsibility_amount > 0),
  corrected_responsibility_amount numeric(18,2) NOT NULL,
  corrected_external_amount numeric(18,2) NOT NULL,
  authorized_by uuid NOT NULL REFERENCES app_users(id),
  authorized_role_snapshot text[] NOT NULL
    CHECK (cardinality(authorized_role_snapshot) > 0),
  authorization_basis text NOT NULL
    CHECK (length(btrim(authorization_basis)) BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (migration_version, rework_order_id)
);

CREATE TRIGGER responsibility_business_correction_no_update
BEFORE UPDATE ON rework_responsibility_business_corrections
FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation();

CREATE TRIGGER responsibility_business_correction_no_delete
BEFORE DELETE ON rework_responsibility_business_corrections
FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation();

CREATE TRIGGER responsibility_business_correction_no_truncate
BEFORE TRUNCATE ON rework_responsibility_business_corrections
FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_mutation();

-- PR #288 began creating tail responsibility rows when the processing factory
-- bears the cost. Keep the database completeness rule aligned with that service
-- rule while preserving the worker-only rule for own-factory tail costs.
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
        AND target_order.tail_inspection_cost_bearer = 'processing_factory'
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

-- Only two immutable roots require a numeric correction: the finalized
-- determination total and the active processing-factory case total. Their
-- detailed child facts are appended first, and this migration writes a
-- dedicated immutable before/after correction record.
ALTER TABLE rework_responsibility_determinations
  DISABLE TRIGGER rework_responsibility_determinations_no_update;
ALTER TABLE rework_external_responsibility_cases
  DISABLE TRIGGER external_cases_update;

DO $repair$
DECLARE
  target_order rework_orders%ROWTYPE;
  target_determination rework_responsibility_determinations%ROWTYPE;
  target_batch rework_external_responsibility_batches%ROWTYPE;
  target_case rework_external_responsibility_cases%ROWTYPE;
  supplier_allocation rework_responsibility_allocations%ROWTYPE;
  tail_item record;
  original_responsibility numeric(18,2);
  original_external numeric(18,2);
  total_wage numeric(18,2);
  added_tail_base numeric(18,2);
  added_responsibility numeric(18,2);
  corrected_responsibility numeric(18,2);
  corrected_external numeric(18,2);
  tail_item_count integer;
  tail_wage_item_count integer;
  tail_item_ids uuid[];
  correction_authorizer_ids uuid[];
  correction_authorizer_id uuid;
BEGIN
  SELECT * INTO target_order
  FROM rework_orders
  WHERE rework_no = 'RW-2026-0826-001'
    AND style_no = 'HO20544223'
    AND status <> 'deleted';

  IF target_order.rework_order_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM rework_responsibility_business_corrections
    WHERE migration_version = '0114_ho20544223_tail_responsibility_repair'
      AND rework_order_id = target_order.rework_order_id
  ) THEN
    RETURN;
  END IF;

  IF target_order.status <> 'completed'
     OR target_order.tail_inspection_required IS DISTINCT FROM true
     OR target_order.tail_inspection_cost_bearer IS DISTINCT FROM 'processing_factory'
     OR target_order.processing_factory_type IS DISTINCT FROM 'supplier'
     OR target_order.processing_factory_supplier_id IS NULL THEN
    RAISE EXCEPTION '0114 target order business facts do not match the approved 4223 correction';
  END IF;

  SELECT determination.* INTO target_determination
  FROM rework_responsibility_determinations determination
  WHERE determination.rework_order_id = target_order.rework_order_id
    AND determination.stage = 'finalized'
    AND NOT EXISTS (
      SELECT 1 FROM rework_responsibility_determinations successor
      WHERE successor.replaces_determination_id = determination.determination_id
    );

  IF target_determination.determination_id IS NULL
     OR target_determination.settlement_schema_version <> 2 THEN
    RAISE EXCEPTION '0114 target finalized responsibility version is missing or incompatible';
  END IF;

  SELECT batch.* INTO target_batch
  FROM rework_external_responsibility_batches batch
  WHERE batch.rework_order_id = target_order.rework_order_id
    AND batch.finalized_determination_id = target_determination.determination_id
    AND batch.status = 'active';

  SELECT case_record.* INTO target_case
  FROM rework_external_responsibility_cases case_record
  WHERE case_record.batch_id = target_batch.batch_id
    AND case_record.responsibility_type = 'processing_factory'
    AND case_record.supplier_id = target_order.processing_factory_supplier_id
    AND case_record.status NOT IN ('closed','superseded')
  FOR UPDATE OF case_record;

  IF target_batch.batch_id IS NULL OR target_case.case_id IS NULL
     OR target_case.status <> 'deduction_follow_up' THEN
    RAISE EXCEPTION '0114 target active processing-factory deduction case is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM rework_external_deduction_entries entry
    WHERE entry.case_id = target_case.case_id
  ) OR EXISTS (
    SELECT 1 FROM rework_external_deduction_closures closure
    WHERE closure.case_id = target_case.case_id
  ) THEN
    RAISE EXCEPTION '0114 refuses to alter a case with recorded deductions or closure';
  END IF;

  SELECT allocation.* INTO supplier_allocation
  FROM rework_responsibility_allocations allocation
  WHERE allocation.determination_id = target_determination.determination_id
    AND allocation.responsibility_type = 'processing_factory'
    AND allocation.supplier_id = target_order.processing_factory_supplier_id
  ORDER BY allocation.configuration_item_id
  LIMIT 1;

  IF supplier_allocation.determination_id IS NULL
     OR supplier_allocation.multiplier IS DISTINCT FROM 1.200 THEN
    RAISE EXCEPTION '0114 target processing-factory allocation snapshot is missing or not 1.2';
  END IF;

  SELECT array_agg(user_record.id ORDER BY user_record.id)
  INTO correction_authorizer_ids
  FROM app_users user_record
  WHERE access_is_root_actor(user_record.id)
    AND responsibility_actor_has_direct_role(
      user_record.id,'responsibility:owner_sign',ARRAY['owner_group']
    );

  IF cardinality(correction_authorizer_ids) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '0114 requires exactly one Root owner to authorize the correction';
  END IF;
  correction_authorizer_id := correction_authorizer_ids[1];

  SELECT coalesce(sum(allocation.effective_rounded_amount),0)
  INTO original_responsibility
  FROM rework_effective_responsibility_allocations allocation
  WHERE allocation.determination_id = target_determination.determination_id;

  SELECT target_case.proposed_deduction_amount INTO original_external;
  SELECT coalesce(sum(wage.payable_amount),0) INTO total_wage
  FROM rework_wage_items wage
  WHERE wage.rework_order_id = target_order.rework_order_id
    AND wage.invalidated_at IS NULL;

  SELECT count(*),array_agg(item.configuration_item_id ORDER BY item.configuration_item_id)
  INTO tail_item_count,tail_item_ids
  FROM rework_process_configurations configuration
  JOIN rework_process_configuration_items item USING(configuration_id)
  WHERE configuration.rework_order_id = target_order.rework_order_id
    AND configuration.status = 'approved'
    AND item.execution_kind = 'tail_inspection';

  SELECT count(DISTINCT wage.configuration_item_id),
         coalesce(sum(round(
           wage.actual_quantity_snapshot * wage.unit_price_snapshot *
           CASE WHEN wage.assignment_mode = 'collective'
             THEN 1::numeric / NULLIF(wage.member_count,0)
             ELSE 1 END,
           8
         )),0),
         coalesce(sum(round(
           round(
             wage.actual_quantity_snapshot * wage.unit_price_snapshot *
             CASE WHEN wage.assignment_mode = 'collective'
               THEN 1::numeric / NULLIF(wage.member_count,0)
               ELSE 1 END,
             8
           ) * 1.200,
           2
         )),0)
  INTO tail_wage_item_count,added_tail_base,added_responsibility
  FROM rework_wage_items wage
  JOIN rework_process_configuration_items item
    ON item.configuration_item_id = wage.configuration_item_id
  WHERE wage.rework_order_id = target_order.rework_order_id
    AND wage.invalidated_at IS NULL
    AND item.execution_kind = 'tail_inspection';

  IF original_responsibility IS DISTINCT FROM 1076.16
     OR target_determination.calculation_total IS DISTINCT FROM 1076.16
     OR original_external IS DISTINCT FROM 1076.16
     OR total_wage IS DISTINCT FROM 1287.20
     OR tail_item_count <> tail_wage_item_count
     OR tail_item_count < 1
     OR added_tail_base IS DISTINCT FROM 390.40
     OR added_responsibility IS DISTINCT FROM 468.48
     OR EXISTS (
       SELECT 1 FROM rework_responsibility_processes process
       WHERE process.determination_id = target_determination.determination_id
         AND process.configuration_item_id = ANY(tail_item_ids)
     ) THEN
    RAISE EXCEPTION '0114 target amounts or tail source facts differ from the verified 4223 snapshot';
  END IF;

  PERFORM set_config(
    'dx_rework.responsibility_event_id',
    target_determination.operation_event_id::text,
    true
  );
  PERFORM set_config(
    'dx_rework.responsibility_request_id',
    target_determination.request_id,
    true
  );
  PERFORM set_config(
    'dx_rework.external_responsibility_event_id',
    target_batch.operation_event_id::text,
    true
  );
  PERFORM set_config(
    'dx_rework.external_responsibility_request_id',
    target_batch.request_id,
    true
  );

  FOR tail_item IN
    SELECT item.configuration_item_id,item.process_name,item.pricing_unit,
      sum(round(
        wage.actual_quantity_snapshot * wage.unit_price_snapshot *
        CASE WHEN wage.assignment_mode = 'collective'
          THEN 1::numeric / NULLIF(wage.member_count,0)
          ELSE 1 END,
        8
      ))::numeric(18,8) base_amount,
      sum(round(
        round(
          wage.actual_quantity_snapshot * wage.unit_price_snapshot *
          CASE WHEN wage.assignment_mode = 'collective'
            THEN 1::numeric / NULLIF(wage.member_count,0)
            ELSE 1 END,
          8
        ) * 1.200,
        2
      ))::numeric(18,2) responsibility_amount
    FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item USING(configuration_id)
    JOIN rework_wage_items wage
      ON wage.configuration_item_id = item.configuration_item_id
     AND wage.rework_order_id = configuration.rework_order_id
     AND wage.invalidated_at IS NULL
    WHERE configuration.rework_order_id = target_order.rework_order_id
      AND configuration.status = 'approved'
      AND item.execution_kind = 'tail_inspection'
    GROUP BY item.configuration_item_id,item.process_name,item.pricing_unit
    ORDER BY item.configuration_item_id
  LOOP
    INSERT INTO rework_responsibility_processes(
      determination_id,configuration_item_id,process_name_snapshot,
      pricing_unit_snapshot,multiplier,high_multiplier_reason,base_amount,
      responsibility_amount,operation_event_id,request_id
    ) VALUES(
      target_determination.determination_id,tail_item.configuration_item_id,
      tail_item.process_name,tail_item.pricing_unit,1.000,NULL,
      tail_item.base_amount,tail_item.responsibility_amount,
      target_determination.operation_event_id,target_determination.request_id
    );

    INSERT INTO rework_responsibility_allocations(
      determination_id,configuration_item_id,responsibility_type,share_bps,
      rounded_amount,operation_event_id,request_id,multiplier,supplier_id,
      supplier_version,supplier_code_snapshot,supplier_name_snapshot,
      supplier_type_snapshot
    ) VALUES(
      target_determination.determination_id,tail_item.configuration_item_id,
      'processing_factory',10000,tail_item.responsibility_amount,
      target_determination.operation_event_id,target_determination.request_id,
      1.200,supplier_allocation.supplier_id,supplier_allocation.supplier_version,
      supplier_allocation.supplier_code_snapshot,
      supplier_allocation.supplier_name_snapshot,
      supplier_allocation.supplier_type_snapshot
    );

    INSERT INTO rework_responsibility_amount_lines(
      determination_id,configuration_item_id,work_report_id,person_id,
      responsibility_type,base_member_share_amount,multiplier,share_bps,
      unrounded_amount,rounded_amount,rounding_rule,
      worker_display_name_snapshot,task_mode_snapshot,member_snapshot,
      report_snapshot,operation_event_id,request_id
    )
    SELECT target_determination.determination_id,wage.configuration_item_id,
      wage.work_report_id,wage.person_id,'processing_factory',
      round(
        wage.actual_quantity_snapshot * wage.unit_price_snapshot *
        CASE WHEN wage.assignment_mode = 'collective'
          THEN 1::numeric / NULLIF(wage.member_count,0)
          ELSE 1 END,
        8
      ),
      1.200,10000,
      round(
        round(
          wage.actual_quantity_snapshot * wage.unit_price_snapshot *
          CASE WHEN wage.assignment_mode = 'collective'
            THEN 1::numeric / NULLIF(wage.member_count,0)
            ELSE 1 END,
          8
        ) * 1.200,
        15
      ),
      round(
        round(
          wage.actual_quantity_snapshot * wage.unit_price_snapshot *
          CASE WHEN wage.assignment_mode = 'collective'
            THEN 1::numeric / NULLIF(wage.member_count,0)
            ELSE 1 END,
          8
        ) * 1.200,
        2
      ),
      'half_up_2',wage.person_name_snapshot,wage.assignment_mode,
      wage.member_snapshot,wage.source_report_snapshot,
      target_determination.operation_event_id,target_determination.request_id
    FROM rework_wage_items wage
    WHERE wage.rework_order_id = target_order.rework_order_id
      AND wage.configuration_item_id = tail_item.configuration_item_id
      AND wage.invalidated_at IS NULL;

    INSERT INTO rework_external_responsibility_items(
      external_item_id,batch_id,determination_id,configuration_item_id,
      responsibility_type,process_snapshot,multiplier_snapshot,
      share_bps_snapshot,proposed_amount,amount_line_snapshot,
      operation_event_id,request_id
    )
    SELECT gen_random_uuid(),target_batch.batch_id,
      target_determination.determination_id,tail_item.configuration_item_id,
      'processing_factory',
      jsonb_build_object(
        'configurationItemId',tail_item.configuration_item_id,
        'processName',tail_item.process_name,
        'pricingUnit',tail_item.pricing_unit,
        'baseAmount',tail_item.base_amount,
        'responsibilityAmount',tail_item.responsibility_amount,
        'correction','0114_ho20544223_tail_responsibility_repair'
      ),
      1.200,10000,tail_item.responsibility_amount,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'workReportId',line.work_report_id,
          'personId',line.person_id,
          'baseMemberShareAmount',line.base_member_share_amount::text,
          'multiplier',line.multiplier::text,
          'shareBps',line.share_bps,
          'roundedAmount',line.rounded_amount::text,
          'memberSnapshot',line.member_snapshot,
          'reportSnapshot',line.report_snapshot
        ) ORDER BY line.work_report_id,line.person_id)
        FROM rework_responsibility_amount_lines line
        WHERE line.determination_id = target_determination.determination_id
          AND line.configuration_item_id = tail_item.configuration_item_id
          AND line.responsibility_type = 'processing_factory'
      ),'[]'::jsonb),target_batch.operation_event_id,target_batch.request_id;

    INSERT INTO rework_external_responsibility_case_items(
      case_id,external_item_id,operation_event_id,request_id
    )
    SELECT target_case.case_id,item.external_item_id,
      target_batch.operation_event_id,target_batch.request_id
    FROM rework_external_responsibility_items item
    WHERE item.batch_id = target_batch.batch_id
      AND item.configuration_item_id = tail_item.configuration_item_id
      AND item.responsibility_type = 'processing_factory';
  END LOOP;

  corrected_responsibility := original_responsibility + added_responsibility;
  corrected_external := original_external + added_responsibility;

  -- The case row was locked FOR UPDATE before the first absence check. Recheck
  -- immediately before changing its amount so deduction writers cannot race
  -- this correction between validation and persistence.
  IF EXISTS (
    SELECT 1 FROM rework_external_deduction_entries entry
    WHERE entry.case_id = target_case.case_id
  ) OR EXISTS (
    SELECT 1 FROM rework_external_deduction_closures closure
    WHERE closure.case_id = target_case.case_id
  ) THEN
    RAISE EXCEPTION '0114 refuses a concurrent deduction or closure';
  END IF;

  UPDATE rework_responsibility_determinations
  SET calculation_total = corrected_responsibility
  WHERE determination_id = target_determination.determination_id;

  UPDATE rework_external_responsibility_cases
  SET proposed_deduction_amount = corrected_external,
      case_version = case_version + 1
  WHERE case_id = target_case.case_id;

  PERFORM validate_responsibility_version(target_determination.determination_id);

  IF corrected_responsibility IS DISTINCT FROM 1544.64
     OR corrected_external IS DISTINCT FROM 1544.64
     OR (SELECT coalesce(sum(allocation.effective_rounded_amount),0)
         FROM rework_effective_responsibility_allocations allocation
         WHERE allocation.determination_id = target_determination.determination_id)
        IS DISTINCT FROM 1544.64
     OR (SELECT proposed_deduction_amount
         FROM rework_external_responsibility_cases
         WHERE case_id = target_case.case_id) IS DISTINCT FROM 1544.64
     OR (SELECT coalesce(sum(item.proposed_amount),0)
         FROM rework_external_responsibility_case_items mapping
         JOIN rework_external_responsibility_items item
           ON item.external_item_id = mapping.external_item_id
         WHERE mapping.case_id = target_case.case_id) IS DISTINCT FROM 1544.64 THEN
    RAISE EXCEPTION '0114 corrected totals did not reconcile to 1544.64';
  END IF;

  INSERT INTO rework_responsibility_business_corrections(
    correction_id,migration_version,rework_order_id,determination_id,batch_id,
    case_id,tail_configuration_item_ids,original_responsibility_amount,
    original_external_amount,added_tail_wage_base,added_responsibility_amount,
    corrected_responsibility_amount,corrected_external_amount,authorized_by,
    authorized_role_snapshot,authorization_basis,reason
  ) VALUES(
    gen_random_uuid(),'0114_ho20544223_tail_responsibility_repair',
    target_order.rework_order_id,target_determination.determination_id,
    target_batch.batch_id,target_case.case_id,tail_item_ids,
    original_responsibility,original_external,added_tail_base,
    added_responsibility,corrected_responsibility,corrected_external,
    correction_authorizer_id,ARRAY['root','owner_group'],
    '业务负责人以 Root/老板身份明确批准 HO20544223 整查由加工厂承担并修复历史责任与外扣金额',
    'HO20544223 回货返工，整查费用由加工厂承担；补入整查工资基数并按 100% × 1.2 修正责任与外扣'
  );
END
$repair$;

ALTER TABLE rework_responsibility_determinations
  ENABLE TRIGGER rework_responsibility_determinations_no_update;
ALTER TABLE rework_external_responsibility_cases
  ENABLE TRIGGER external_cases_update;
