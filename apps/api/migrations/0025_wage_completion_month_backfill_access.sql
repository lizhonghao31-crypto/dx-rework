-- PR-12 Codex closure: completion-month wage attribution, historical backfill,
-- and wage-adjustment evidence access.

DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('administrative_clerk','tools:user')
ON CONFLICT DO NOTHING;
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION materialize_rework_wages_from_order_review_event(
  p_order_review_id uuid,
  p_event_id uuid,
  p_request_id text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_review rework_order_reviews%ROWTYPE;
  v_source_event operation_events%ROWTYPE;
  v_report record;
  v_period_id uuid;
  v_period_status text;
  v_affected integer;
  v_allocated_total numeric(18,2);
BEGIN
  SELECT * INTO STRICT v_review
  FROM rework_order_reviews
  WHERE order_review_id=p_order_review_id;

  SELECT * INTO v_source_event
  FROM operation_events event
  WHERE event.event_id=p_event_id
    AND event.request_id=p_request_id
    AND event.actor_id=v_review.reviewed_by
    AND event.action='rework.whole_order.approve'
    AND event.authorization_capability='submission:audit'
    AND event.entity_type='rework_order'
    AND event.entity_id=v_review.rework_order_id::text;

  IF v_source_event.event_id IS NULL THEN
    RAISE EXCEPTION 'wage materialization source event does not match order review'
      USING ERRCODE='55000';
  END IF;

  PERFORM set_config('dx_rework.wage_system_action','materialize',true);

  FOR v_report IN
    SELECT
      report.work_report_id,
      date_trunc(
        'month',
        report.completed_at AT TIME ZONE 'Asia/Singapore'
      )::date AS period_month
    FROM rework_work_reports report
    WHERE report.rework_order_id=v_review.rework_order_id
      AND report.status='submitted'
      AND NOT EXISTS(
        SELECT 1
        FROM rework_work_report_rejections rejection
        WHERE rejection.work_report_id=report.work_report_id
      )
    ORDER BY report.completed_at,report.work_report_id
  LOOP
    INSERT INTO rework_wage_periods(
      period_id,period_month,status,created_operation_event_id,created_request_id
    ) VALUES(
      gen_random_uuid(),v_report.period_month,'pending_tail_review',
      v_source_event.event_id,v_source_event.request_id
    )
    ON CONFLICT(period_month) DO NOTHING;

    SELECT period.period_id,period.status
    INTO STRICT v_period_id,v_period_status
    FROM rework_wage_periods period
    WHERE period.period_month=v_report.period_month
    FOR UPDATE;

    IF v_period_status='locked' THEN
      RAISE EXCEPTION 'cannot add wage source to locked period'
        USING ERRCODE='23514';
    END IF;

    WITH shares AS (
      SELECT
        share.person_id,
        share.amount,
        member.display_name_snapshot,
        member.person_type_snapshot,
        row_number() OVER(
          ORDER BY (share.amount-trunc(share.amount,2)) DESC,share.person_id
        )::integer AS remainder_rank,
        count(*) OVER()::integer AS member_count,
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'personId',member_snapshot.person_id,
              'displayName',member_snapshot.display_name_snapshot,
              'personType',member_snapshot.person_type_snapshot
            )
            ORDER BY member_snapshot.person_id
          )
          FROM rework_work_report_member_shares share_snapshot
          JOIN rework_work_task_members member_snapshot
            ON member_snapshot.work_task_id=report.work_task_id
           AND member_snapshot.person_id=share_snapshot.person_id
          WHERE share_snapshot.work_report_id=report.work_report_id
        ) AS member_snapshot,
        round(report.group_amount,2)-sum(trunc(share.amount,2)) OVER()
          AS cents_left,
        report.work_report_id,
        report.rework_order_id,
        report.configuration_item_id,
        report.work_task_id,
        report.actual_quantity,
        report.completed_at,
        report.submitted_by,
        report.group_amount,
        task.assignment_mode,
        item.process_name,
        item.pricing_unit,
        item.unit_price,
        target_order.rework_no,
        target_order.style_no
      FROM rework_work_report_member_shares share
      JOIN rework_work_reports report
        ON report.work_report_id=share.work_report_id
      JOIN rework_work_tasks task
        ON task.work_task_id=report.work_task_id
      JOIN rework_work_task_members member
        ON member.work_task_id=task.work_task_id
       AND member.person_id=share.person_id
      JOIN rework_process_configuration_items item
        ON item.configuration_item_id=report.configuration_item_id
      JOIN rework_orders target_order
        ON target_order.rework_order_id=report.rework_order_id
      WHERE share.work_report_id=v_report.work_report_id
    )
    INSERT INTO rework_wage_items(
      wage_item_id,period_id,order_review_id,rework_order_id,
      configuration_item_id,work_task_id,work_report_id,person_id,
      person_name_snapshot,person_type_snapshot,rework_no_snapshot,
      style_no_snapshot,process_name_snapshot,pricing_unit_snapshot,
      unit_price_snapshot,actual_quantity_snapshot,assignment_mode,
      group_amount,exact_person_share,payable_amount,fractional_remainder,
      remainder_rank,member_count,member_snapshot,source_report_snapshot,
      operation_event_id,operation_request_id
    )
    SELECT
      gen_random_uuid(),v_period_id,p_order_review_id,rework_order_id,
      configuration_item_id,work_task_id,work_report_id,person_id,
      display_name_snapshot,person_type_snapshot,rework_no,style_no,
      process_name,pricing_unit,unit_price,actual_quantity,assignment_mode,
      group_amount,amount,
      trunc(amount,2)+CASE
        WHEN remainder_rank<=round(cents_left*100)::integer THEN 0.01
        ELSE 0
      END,
      amount-trunc(amount,2),remainder_rank,member_count,member_snapshot,
      jsonb_build_object(
        'workReportId',work_report_id,
        'workTaskId',work_task_id,
        'configurationItemId',configuration_item_id,
        'actualQuantity',actual_quantity,
        'completedAt',completed_at,
        'submittedBy',submitted_by,
        'groupAmount',group_amount
      ),
      v_source_event.event_id,v_source_event.request_id
    FROM shares
    ON CONFLICT(work_report_id,person_id) DO NOTHING;

    GET DIAGNOSTICS v_affected=ROW_COUNT;

    SELECT sum(item.payable_amount)
    INTO v_allocated_total
    FROM rework_wage_items item
    WHERE item.work_report_id=v_report.work_report_id;

    IF v_allocated_total IS DISTINCT FROM (
      SELECT round(report.group_amount,2)
      FROM rework_work_reports report
      WHERE report.work_report_id=v_report.work_report_id
    ) THEN
      RAISE EXCEPTION 'wage allocation does not equal rounded group amount'
        USING ERRCODE='23514';
    END IF;

    IF v_affected>0 THEN
      UPDATE rework_wage_periods period SET
        source_item_count=(
          SELECT count(*)
          FROM rework_wage_items item
          WHERE item.period_id=v_period_id
        ),
        person_count=(
          SELECT count(DISTINCT item.person_id)
          FROM rework_wage_items item
          WHERE item.period_id=v_period_id
        ),
        original_total=(
          SELECT COALESCE(sum(item.payable_amount),0)
          FROM rework_wage_items item
          WHERE item.period_id=v_period_id
        ),
        adjustment_total=(
          SELECT COALESCE(sum(adjustment.adjustment_amount),0)
          FROM rework_wage_adjustments adjustment
          WHERE adjustment.target_period_id=v_period_id
            AND adjustment.status='approved'
        ),
        final_total=(
          SELECT COALESCE(sum(item.payable_amount),0)
          FROM rework_wage_items item
          WHERE item.period_id=v_period_id
        )+(
          SELECT COALESCE(sum(adjustment.adjustment_amount),0)
          FROM rework_wage_adjustments adjustment
          WHERE adjustment.target_period_id=v_period_id
            AND adjustment.status='approved'
        ),
        status='pending_tail_review',
        period_version=period.period_version+1,
        updated_at=CURRENT_TIMESTAMP
      WHERE period.period_id=v_period_id;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION materialize_rework_wages_from_order_review(
  p_order_review_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_source_event operation_events%ROWTYPE;
BEGIN
  v_source_event:=require_wage_materialization_event(p_order_review_id);
  PERFORM materialize_rework_wages_from_order_review_event(
    p_order_review_id,
    v_source_event.event_id,
    v_source_event.request_id
  );
END;
$$;

DO $$
DECLARE
  v_review record;
  v_source_event operation_events%ROWTYPE;
BEGIN
  FOR v_review IN
    SELECT review.order_review_id,review.rework_order_id,review.reviewed_by
    FROM rework_order_reviews review
    WHERE NOT EXISTS(
      SELECT 1
      FROM rework_wage_items item
      WHERE item.order_review_id=review.order_review_id
    )
    ORDER BY review.reviewed_at,review.order_review_id
  LOOP
    SELECT * INTO v_source_event
    FROM operation_events event
    WHERE event.action='rework.whole_order.approve'
      AND event.authorization_capability='submission:audit'
      AND event.entity_type='rework_order'
      AND event.entity_id=v_review.rework_order_id::text
      AND event.actor_id=v_review.reviewed_by
    ORDER BY event.created_at DESC,event.event_id DESC
    LIMIT 1;

    IF v_source_event.event_id IS NULL THEN
      RAISE EXCEPTION 'existing whole-order review lacks materialization event'
        USING ERRCODE='55000';
    END IF;

    PERFORM materialize_rework_wages_from_order_review_event(
      v_review.order_review_id,
      v_source_event.event_id,
      v_source_event.request_id
    );
  END LOOP;
END;
$$;
