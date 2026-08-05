import type { ReportQuery } from "@dx-rework/contracts/reporting";
import type { QueryResultRow } from "pg";

import { type Queryable, type Range, type ReportData, money } from "./management-reporting-shared.js";
import { totals } from "./management-reporting-report-exceptions.js";

export async function wageReport(source: Queryable, query: ReportQuery, range: Range, limit: number): Promise<ReportData> {
  const result = await source.query<QueryResultRow>(
    `WITH approved AS (
       SELECT original_wage_item_id,sum(adjustment_amount) adjustment
       FROM rework_wage_adjustments WHERE status='approved' GROUP BY original_wage_item_id
     ), unlocked_lines AS (
       SELECT period.period_month,wage.person_id,wage.person_name_snapshot,wage.person_type_snapshot,
         wage.rework_order_id,wage.rework_no_snapshot,wage.style_no_snapshot,wage.process_name_snapshot,
         wage.actual_quantity_snapshot,wage.pricing_unit_snapshot,wage.unit_price_snapshot,
         wage.assignment_mode,wage.payable_amount original_amount,COALESCE(approved.adjustment,0) adjustment_amount,
         wage.payable_amount+COALESCE(approved.adjustment,0) final_amount,period.status,
         wage.wage_item_id sort_id
       FROM rework_wage_items wage JOIN rework_wage_periods period USING(period_id)
       LEFT JOIN approved ON approved.original_wage_item_id=wage.wage_item_id
       WHERE period.status<>'locked'
     ), locked_lines AS (
       SELECT period.period_month,line.person_id,line.person_name_snapshot,line.person_type_snapshot,
         source_item.rework_order_id,line.rework_no_snapshot,line.style_no_snapshot,line.process_name_snapshot,
         line.quantity_snapshot actual_quantity_snapshot,line.unit_snapshot pricing_unit_snapshot,
         line.unit_price_snapshot,line.assignment_mode,line.original_amount,line.adjustment_amount,
         line.final_amount,period.status,line.closure_line_id sort_id
       FROM rework_wage_month_closures closure
       JOIN rework_wage_periods period USING(period_id)
       JOIN rework_wage_month_close_lines line USING(closure_id)
       LEFT JOIN rework_wage_items source_item ON source_item.wage_item_id=COALESCE(
         line.wage_item_id,(SELECT adjustment.original_wage_item_id
           FROM rework_wage_adjustments adjustment WHERE adjustment.adjustment_id=line.adjustment_id)
       )
       WHERE period.status='locked'
     ), lines AS (
       SELECT * FROM unlocked_lines UNION ALL SELECT * FROM locked_lines
     )
     SELECT period_month::text,person_id,person_name_snapshot,person_type_snapshot,rework_order_id,
       rework_no_snapshot,style_no_snapshot,process_name_snapshot,actual_quantity_snapshot::text,
       pricing_unit_snapshot,unit_price_snapshot::text,assignment_mode,original_amount::text,
       adjustment_amount::text,final_amount::text,status
     FROM lines
     WHERE period_month BETWEEN date_trunc('month',$1::date)::date AND date_trunc('month',$2::date)::date
       AND ($3::text IS NULL OR person_name_snapshot ILIKE $3 OR rework_no_snapshot ILIKE $3 OR style_no_snapshot ILIKE $3)
       AND ($4::text IS NULL OR status=$4)
     ORDER BY period_month DESC,person_name_snapshot,sort_id LIMIT $5`,
    [range.from,range.to,query.q ? `%${query.q}%` : null,query.status ?? null,limit],
  );
  const rows = result.rows.map((row) => ({
    periodMonth:String(row.period_month).slice(0,7),personId:String(row.person_id),personName:String(row.person_name_snapshot),personType:String(row.person_type_snapshot),
    reworkOrderId:row.rework_order_id===null?null:String(row.rework_order_id),reworkNo:String(row.rework_no_snapshot),styleNo:String(row.style_no_snapshot),processName:String(row.process_name_snapshot),
    quantity:String(row.actual_quantity_snapshot),unit:String(row.pricing_unit_snapshot),unitPrice:String(row.unit_price_snapshot),assignmentMode:String(row.assignment_mode),
    originalAmount:money(String(row.original_amount)),adjustmentAmount:money(String(row.adjustment_amount)),finalAmount:money(String(row.final_amount)),periodStatus:String(row.status),
  }));
  return { columns: [
    {key:"periodMonth",label:"工资月份"},{key:"personName",label:"人员"},{key:"personType",label:"人员类型"},
    {key:"reworkNo",label:"返工单号"},{key:"styleNo",label:"款号"},{key:"processName",label:"工序"},
    {key:"quantity",label:"数量/工时"},{key:"unit",label:"单位"},{key:"unitPrice",label:"单价"},
    {key:"assignmentMode",label:"计件模式"},{key:"originalAmount",label:"原始金额"},
    {key:"adjustmentAmount",label:"调整金额"},{key:"finalAmount",label:"最终金额"},{key:"periodStatus",label:"月结状态"},
  ], rows, totals:totals(rows,["originalAmount","adjustmentAmount","finalAmount"]) };
}

