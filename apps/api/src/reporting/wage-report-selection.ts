import type { ReportQuery } from "@dx-rework/contracts/reporting";
import { TIMEZONE, type Range } from "./management-reporting-shared.js";

// Historical paths retain their IDs and completion dates; pattern sources share this selection.
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
) , legacy_lines AS (
 SELECT * FROM unlocked_lines UNION ALL SELECT * FROM locked_lines
), lines AS (
 SELECT legacy_lines.*,NULL::uuid pattern_wage_item_id,'order_rework'::text wage_source,'order_rework'::text wage_kind,
   rework_order_id source_order_id,NULL::uuid round_id,NULL::integer round_index,NULL::uuid segment_id,NULL::integer segment_index,
   NULL::text task_name,NULL::numeric source_amount,NULL::numeric round_amount,NULL::numeric actual_hours,
   NULL::timestamptz released_at,NULL::text release_basis,false cancellation
 FROM legacy_lines
 UNION ALL
 SELECT w.wage_item_id,NULL::uuid,NULL::uuid,w.period_month,w.person_id,w.person_name_snapshot,w.person_type_snapshot,
   NULL::uuid,w.order_no,w.style_no,w.category_name,w.quantity,w.unit,w.unit_price,'pattern_segment',w.payable_amount,
   (w.completed_at AT TIME ZONE '${TIMEZONE}')::date,
   w.wage_item_id,'pattern_room',w.wage_type,w.order_id,w.round_id,w.round_index,w.segment_id,w.segment_index,
   w.task_name,w.segment_amount,w.round_amount,w.actual_hours,w.released_at,w.release_basis,w.cancellation
 FROM pattern_room_wage_items w
), filtered AS (
 SELECT lines.*,mark.marked_by,mark.marked_at,(SELECT display_name FROM app_users WHERE id=mark.marked_by) marked_by_name
 FROM lines LEFT JOIN rework_wage_settlement_marks mark USING(line_id)
 WHERE completed_date BETWEEN $1::date AND $2::date
   AND ($3::text IS NULL OR person_name_snapshot ILIKE $3 OR rework_no_snapshot ILIKE $3 OR style_no_snapshot ILIKE $3 OR task_name ILIKE $3)
   AND ($4::text IS NULL OR person_type_snapshot=$4)
   AND ($6::text IS NULL OR wage_source=$6)
   AND ($7::text IS NULL OR wage_kind=$7)
   AND ($5::text IS NULL OR ($5='settled' AND marked_at IS NOT NULL) OR ($5='unsettled' AND marked_at IS NULL))
)`;

export const wageSelectionValues = (query: ReportQuery, range: Range): unknown[] =>
 [range.from,range.to,query.q ? `%${query.q}%` : null,query.personType ?? null,query.status ?? null,query.wageSource ?? null,query.patternKind ?? null];
