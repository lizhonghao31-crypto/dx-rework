import type { ReportQuery } from "@dx-rework/contracts/reporting";
import { type Queryable, type Range, type ReportData, money } from "./management-reporting-shared.js";
import { wageSelection, wageSelectionValues } from "./wage-report-selection.js";

export async function wageReport(source: Queryable, query: ReportQuery, range: Range, limit: number): Promise<ReportData> {
 const result = await source.query(`${wageSelection}, preview AS (
   SELECT period_month::text,person_id,person_name_snapshot,person_type_snapshot,rework_order_id,
    rework_no_snapshot,style_no_snapshot,process_name_snapshot,actual_quantity_snapshot::text,
    pricing_unit_snapshot,unit_price_snapshot::text,assignment_mode,wage_amount::text,
    line_id,completed_date::text,marked_at::text
   FROM filtered ORDER BY period_month DESC,person_name_snapshot,line_id LIMIT $6
 ), people AS (
   SELECT person_id "personId",max(person_name_snapshot) name,
     count(DISTINCT rework_no_snapshot)::int "orderCount",sum(wage_amount)::text amount
   FROM filtered GROUP BY person_id ORDER BY sum(wage_amount) DESC,person_id
 ) SELECT
   COALESCE((SELECT jsonb_agg(to_jsonb(preview)) FROM preview),'[]'::jsonb) rows,
   COALESCE((SELECT jsonb_agg(to_jsonb(people)) FROM people),'[]'::jsonb) people,
   count(*)::int row_count,COALESCE(sum(wage_amount),0)::text wage_total,
   count(*) FILTER(WHERE marked_at IS NULL)::int pending_lines,
   count(DISTINCT person_id) FILTER(WHERE marked_at IS NULL)::int pending_people FROM filtered`,
   [...wageSelectionValues(query,range),limit]);
 const summary = result.rows[0]!;
 const rows = (summary.rows as Record<string, unknown>[]).map(row => ({
   periodMonth:String(row.period_month).slice(0,7),personId:String(row.person_id),
   personName:String(row.person_name_snapshot),personType:String(row.person_type_snapshot),
   reworkOrderId:row.rework_order_id === null ? null : String(row.rework_order_id),
   reworkNo:String(row.rework_no_snapshot),styleNo:String(row.style_no_snapshot),
   processName:String(row.process_name_snapshot),quantity:String(row.actual_quantity_snapshot),
   unit:String(row.pricing_unit_snapshot),unitPrice:String(row.unit_price_snapshot),
   assignmentMode:String(row.assignment_mode),wageAmount:money(String(row.wage_amount)),
   lineId:String(row.line_id),completedDate:String(row.completed_date),
   settlementStatus:row.marked_at === null ? "unsettled" : "settled",
 }));
 return { columns:[
   {key:"periodMonth",label:"工资月份"},{key:"personName",label:"人员"},{key:"personType",label:"人员类型"},
   {key:"reworkNo",label:"返工单号"},{key:"styleNo",label:"款号"},{key:"processName",label:"工序"},
   {key:"quantity",label:"数量/工时"},{key:"unit",label:"单位"},{key:"unitPrice",label:"单价"},
   {key:"assignmentMode",label:"计件模式"},{key:"wageAmount",label:"工资金额"},{key:"settlementStatus",label:"工资结算"},
 ], rows,totals:{wageAmount:money(summary.wage_total)},wageSummary:{
   rowCount:summary.row_count,pendingLineCount:summary.pending_lines,pendingPersonCount:summary.pending_people,
   people:summary.people.map((p: {personId:string;name:string;orderCount:number;amount:string})=>({...p,amount:money(p.amount)})),
 }};
}
