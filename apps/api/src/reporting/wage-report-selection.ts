import type { ReportQuery } from "@dx-rework/contracts/reporting";
import { TIMEZONE, type Range } from "./management-reporting-shared.js";

// Both historical read paths use the existing work-report completion date.
// A historical closure reuses its wage ID when present; an orphan closure has its own ID.
export const wageSelection = `WITH unlocked_lines AS (
 SELECT wage.wage_item_id line_id,wage.wage_item_id,NULL::uuid closure_line_id,
   period.period_month,wage.person_id,wage.person_name_snapshot,wage.person_type_snapshot,
   wage.rework_order_id,wage.rework_no_snapshot,wage.style_no_snapshot,wage.process_name_snapshot,
   wage.actual_quantity_snapshot,wage.pricing_unit_snapshot,wage.unit_price_snapshot,
   wage.assignment_mode,wage.payable_amount wage_amount,
   (report.completed_at AT TIME ZONE '${TIMEZONE}')::date completed_date
 FROM rework_wage_items wage
 JOIN rework_wage_periods period USING(period_id)
 JOIN rework_orders order_record ON order_record.rework_order_id=wage.rework_order_id
 JOIN rework_work_reports report ON report.work_report_id=wage.work_report_id
 WHERE period.status<>'locked' AND order_record.status<>'deleted'
), locked_lines AS (
 SELECT COALESCE(source_item.wage_item_id,line.closure_line_id) line_id,
   source_item.wage_item_id,CASE WHEN source_item.wage_item_id IS NULL THEN line.closure_line_id END,
   period.period_month,line.person_id,line.person_name_snapshot,line.person_type_snapshot,
   source_item.rework_order_id,line.rework_no_snapshot,line.style_no_snapshot,line.process_name_snapshot,
   line.quantity_snapshot,line.unit_snapshot,line.unit_price_snapshot,
   line.assignment_mode,line.final_amount,
   (report.completed_at AT TIME ZONE '${TIMEZONE}')::date
 FROM rework_wage_month_closures closure
 JOIN rework_wage_periods period USING(period_id)
 JOIN rework_wage_month_close_lines line USING(closure_id)
 LEFT JOIN rework_wage_items source_item ON source_item.wage_item_id=line.wage_item_id
 LEFT JOIN rework_orders order_record ON order_record.rework_order_id=source_item.rework_order_id
 LEFT JOIN rework_work_reports report ON report.work_report_id=source_item.work_report_id
 WHERE period.status='locked' AND line.line_type='wage_item'
   AND (source_item.rework_order_id IS NULL OR order_record.status<>'deleted')
), lines AS (
 SELECT * FROM unlocked_lines UNION ALL SELECT * FROM locked_lines
), filtered AS (
 SELECT lines.*,mark.marked_by,mark.marked_at
 FROM lines LEFT JOIN rework_wage_settlement_marks mark USING(line_id)
 WHERE completed_date BETWEEN $1::date AND $2::date
   AND ($3::text IS NULL OR person_name_snapshot ILIKE $3 OR rework_no_snapshot ILIKE $3 OR style_no_snapshot ILIKE $3)
   AND ($4::text IS NULL OR person_type_snapshot=$4)
   AND ($5::text IS NULL OR ($5='settled' AND marked_at IS NOT NULL) OR ($5='unsettled' AND marked_at IS NULL))
)`;

export const wageSelectionValues = (query: ReportQuery, range: Range): unknown[] =>
 [range.from,range.to,query.q ? `%${query.q}%` : null,query.personType ?? null,query.status ?? null];
