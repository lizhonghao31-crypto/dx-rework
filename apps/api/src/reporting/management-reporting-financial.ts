import type { ManagementDashboardResponse } from "@dx-rework/contracts/reporting";
import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import { TIMEZONE, type Range, type FinancialRow, money, number } from "./management-reporting-shared.js";

export async function financial(db: Pool, range: Range): Promise<ManagementDashboardResponse["financial"]> {
  const result = await db.query<FinancialRow>(
    `WITH current_determinations AS (
       SELECT determination.* FROM rework_responsibility_determinations determination
       WHERE determination.stage='finalized' AND NOT EXISTS(
         SELECT 1 FROM rework_responsibility_determinations successor
         WHERE successor.replaces_determination_id=determination.determination_id)
     ), responsibility AS (
       SELECT COALESCE(sum(allocation.effective_rounded_amount),0)::text total
       FROM current_determinations determination
       JOIN rework_effective_responsibility_allocations allocation
         USING(determination_id)
       JOIN rework_orders order_record ON order_record.rework_order_id=determination.rework_order_id
       WHERE order_record.status<>'deleted'
         AND (determination.created_at AT TIME ZONE $3)::date
         BETWEEN $1::date AND $2::date
     ), own_factory AS (
       SELECT COALESCE(sum(allocation.effective_rounded_amount),0)::text total
       FROM current_determinations determination
       JOIN rework_effective_responsibility_allocations allocation
         USING(determination_id)
       JOIN rework_orders order_record ON order_record.rework_order_id=determination.rework_order_id
       WHERE order_record.status<>'deleted'
         AND allocation.responsibility_type='own_factory'
         AND (determination.created_at AT TIME ZONE $3)::date
           BETWEEN $1::date AND $2::date
     ), active_cases AS (
       SELECT case_record.* FROM current_determinations determination
       JOIN rework_external_responsibility_batches batch
         ON batch.finalized_determination_id=determination.determination_id AND batch.status='active'
       JOIN rework_external_responsibility_cases case_record USING(batch_id)
       JOIN rework_orders order_record ON order_record.rework_order_id=case_record.rework_order_id
       WHERE order_record.status<>'deleted' AND case_record.status<>'superseded'
         AND (case_record.created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
     ), entry_totals AS (
       SELECT case_id,COALESCE(sum(amount),0) actual FROM rework_external_deduction_entries GROUP BY case_id
     ), external AS (
       SELECT COALESCE(sum(case_record.proposed_deduction_amount),0)::text proposed,
         COALESCE(sum(COALESCE(closure.actual_deducted_amount,entry.actual,0)),0)::text deducted,
         COALESCE(sum(COALESCE(closure.remaining_amount,case_record.proposed_deduction_amount-COALESCE(entry.actual,0))),0)::text remaining
       FROM active_cases case_record
       LEFT JOIN entry_totals entry USING(case_id)
       LEFT JOIN rework_external_deduction_closures closure USING(case_id)
     ), approved_adjustments AS (
       SELECT original_wage_item_id,sum(adjustment_amount) adjustment
       FROM rework_wage_adjustments WHERE status='approved' GROUP BY original_wage_item_id
     ), wages AS (
       SELECT COALESCE(sum(wage.payable_amount+COALESCE(adjustment.adjustment,0)),0)::text total
       FROM rework_wage_items wage
       JOIN rework_wage_periods period USING(period_id)
       JOIN rework_orders order_record ON order_record.rework_order_id=wage.rework_order_id
       LEFT JOIN approved_adjustments adjustment ON adjustment.original_wage_item_id=wage.wage_item_id
       WHERE order_record.status<>'deleted'
         AND period.period_month BETWEEN date_trunc('month',$1::date)::date AND date_trunc('month',$2::date)::date
     )
     SELECT wages.total wage_total,responsibility.total responsibility_total,
       own_factory.total own_factory_total,external.proposed external_proposed,
       external.deducted external_deducted,external.remaining external_remaining
     FROM wages,responsibility,own_factory,external`,
    [range.from, range.to, TIMEZONE],
  );
  const row = result.rows[0];
  if (!row) throw new ApplicationError("INTERNAL_ERROR", "无法汇总管理金额", 500);
  return {
    wageTotal: money(row.wage_total),
    responsibilityTotal: money(row.responsibility_total),
    ownFactoryTotal: money(row.own_factory_total),
    externalProposed: money(row.external_proposed),
    externalDeducted: money(row.external_deducted),
    externalRemaining: money(row.external_remaining),
  };
}

export async function currentExceptionCount(db: Pool): Promise<number> {
  const result = await db.query<{ count: string }>(
    `WITH latest_follow_up AS (
       SELECT DISTINCT ON (follow_up.case_id) follow_up.case_id,follow_up.next_follow_up_at
       FROM rework_external_deduction_follow_ups follow_up
       ORDER BY follow_up.case_id,follow_up.created_at DESC,follow_up.follow_up_id DESC
     )
     SELECT (
       (SELECT count(*) FROM rework_todos todo
         WHERE todo.status='pending' AND todo.due_at<CURRENT_TIMESTAMP
           AND NOT EXISTS(SELECT 1 FROM rework_orders order_record WHERE order_record.status='deleted' AND order_record.rework_order_id::text=todo.route_descriptor->>'reworkOrderId'))
       + (SELECT count(*) FROM rework_todos todo WHERE todo.status='blocked_recipient'
           AND NOT EXISTS(SELECT 1 FROM rework_orders order_record WHERE order_record.status='deleted' AND order_record.rework_order_id::text=todo.route_descriptor->>'reworkOrderId'))
       + (SELECT count(*) FROM dingtalk_todo_external_bindings binding
         JOIN rework_todos todo USING(todo_id)
         WHERE binding.provider_state='permanent_failed'
           AND NOT EXISTS(SELECT 1 FROM rework_orders order_record WHERE order_record.status='deleted' AND order_record.rework_order_id::text=todo.route_descriptor->>'reworkOrderId'))
       + (SELECT count(*) FROM latest_follow_up follow_up
       JOIN rework_external_responsibility_cases case_record USING(case_id)
       JOIN rework_orders order_record ON order_record.rework_order_id=case_record.rework_order_id
       WHERE follow_up.next_follow_up_at<CURRENT_TIMESTAMP
           AND case_record.status='deduction_follow_up' AND order_record.status<>'deleted')
     )::text count`,
  );
  return number(result.rows[0]?.count ?? "0");
}
