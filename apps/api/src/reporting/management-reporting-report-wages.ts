import type { ReportQuery } from "@dx-rework/contracts/reporting";
import { type Queryable, type Range, type ReportData, money } from "./management-reporting-shared.js";
import { wageSelection, wageSelectionValues } from "./wage-report-selection.js";

export async function wageReport(source: Queryable, query: ReportQuery, range: Range, limit: number, page?:number): Promise<ReportData> {
 const result = await source.query(`${wageSelection}, paging AS (
   SELECT LEAST(COALESCE($9::int,1),GREATEST(1,ceil(count(*)::numeric/$8::int)::int)) page,
     GREATEST(1,ceil(count(*)::numeric/$8::int)::int) total_pages FROM filtered
 ), preview AS (
   SELECT period_month::text,person_id,person_name_snapshot,person_type_snapshot,rework_order_id,
    rework_no_snapshot,style_no_snapshot,process_name_snapshot,actual_quantity_snapshot::text,
    pricing_unit_snapshot,unit_price_snapshot::text,assignment_mode,wage_amount::text,
    group_amount,exact_person_share,member_count,temporary_wage_multiplier,
    line_id,completed_date::text,marked_at::text,marked_by,marked_by_name,wage_source,wage_kind,source_order_id,
    round_id,round_index,segment_id,segment_index,task_name,source_amount::text,round_amount::text,actual_hours::text,
    released_at::text,release_basis,cancellation,
    CASE WHEN wage_source='order_rework' THEN COALESCE((
      SELECT source_order.rework_kind FROM rework_orders source_order
      WHERE source_order.rework_order_id=filtered.source_order_id AND source_order.status<>'deleted'
    ),wage_kind) ELSE wage_kind END display_wage_kind,
    CASE WHEN source_order_id IS NULL THEN 'missing'
      WHEN wage_source='order_rework' AND EXISTS(SELECT 1 FROM rework_orders source_order WHERE source_order.rework_order_id=filtered.source_order_id AND source_order.status<>'deleted') THEN 'available'
      WHEN wage_source='pattern_room' AND EXISTS(SELECT 1 FROM pattern_room_orders source_order
        JOIN pattern_room_rounds source_round ON source_round.order_id=source_order.order_id
        JOIN pattern_room_segments source_segment ON source_segment.round_id=source_round.round_id
        WHERE source_order.order_id=filtered.source_order_id AND source_order.deleted_at IS NULL AND source_round.round_id=filtered.round_id AND source_segment.segment_id=filtered.segment_id) THEN 'available'
      ELSE 'unavailable' END source_status
   FROM filtered ORDER BY completed_date DESC,person_name_snapshot,line_id LIMIT $8 OFFSET ((SELECT page FROM paging)-1)*$8
 ), person_sources AS (
   SELECT person_id,wage_source source,wage_kind kind,sum(wage_amount)::text amount,count(*)::int "lineCount"
   FROM filtered GROUP BY person_id,wage_source,wage_kind
 ), people AS (
   SELECT person_id "personId",max(person_name_snapshot) AS "name",
     count(DISTINCT (wage_source,source_order_id))::int "orderCount",sum(wage_amount)::text amount,
     count(*)::int "lineCount",count(DISTINCT round_id)::int "roundCount",
     (SELECT jsonb_agg(jsonb_build_object('source',p.source,'kind',p.kind,'amount',p.amount,'lineCount',p."lineCount") ORDER BY p.source,p.kind)
       FROM person_sources p WHERE p.person_id=filtered.person_id) sources
   FROM filtered GROUP BY person_id ORDER BY sum(wage_amount) DESC,person_id
 ) SELECT
   COALESCE((SELECT jsonb_agg(to_jsonb(preview) ORDER BY completed_date DESC,person_name_snapshot,line_id) FROM preview),'[]'::jsonb) AS "rows",
   (SELECT page FROM paging) page,(SELECT total_pages FROM paging) total_pages,
   COALESCE((SELECT jsonb_agg(to_jsonb(people)) FROM people),'[]'::jsonb) people,
   count(*)::int row_count,COALESCE(sum(wage_amount),0)::text wage_total,
   COALESCE(sum(wage_amount) FILTER(WHERE marked_at IS NULL),0)::text unsettled_total,
   COALESCE(sum(wage_amount) FILTER(WHERE marked_at IS NOT NULL),0)::text settled_total,
   count(DISTINCT person_id)::int person_count,count(DISTINCT (wage_source,source_order_id))::int order_count,
   count(DISTINCT round_id)::int round_count,
   count(*) FILTER(WHERE marked_at IS NULL)::int pending_lines,
   count(DISTINCT person_id) FILTER(WHERE marked_at IS NULL)::int pending_people FROM filtered`,
   [...wageSelectionValues(query,range),limit,page??null]);
 const summary = result.rows[0]!;
 const nullable = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
 const rows = (summary.rows as Record<string, unknown>[]).map(row => ({
   periodMonth:String(row.period_month).slice(0,7),personId:String(row.person_id),
   personName:String(row.person_name_snapshot),personType:String(row.person_type_snapshot),
   sourceStatus:String(row.source_status),reworkOrderId:nullable(row.rework_order_id),sourceOrderId:nullable(row.source_order_id),
   reworkNo:String(row.rework_no_snapshot),orderNo:String(row.rework_no_snapshot),styleNo:String(row.style_no_snapshot),
   processName:String(row.process_name_snapshot),quantity:nullable(row.actual_quantity_snapshot),
   unit:String(row.pricing_unit_snapshot),unitPrice:nullable(row.unit_price_snapshot),
   groupAmount:nullable(row.group_amount),exactPersonShare:nullable(row.exact_person_share),memberCount:row.member_count as number|null,temporaryWageMultiplier:nullable(row.temporary_wage_multiplier),
   assignmentMode:String(row.assignment_mode),wageAmount:money(String(row.wage_amount)),
   lineId:String(row.line_id),completedDate:String(row.completed_date),
   settlementStatus:row.marked_at === null ? "unsettled" : "settled",
   wageSource:String(row.wage_source),wageKind:String(row.display_wage_kind ?? row.wage_kind),taskName:nullable(row.task_name),
   roundId:nullable(row.round_id),roundIndex:row.round_index as number|null,
   segmentId:nullable(row.segment_id),segmentIndex:row.segment_index as number|null,
   sourceAmount:nullable(row.source_amount),roundAmount:nullable(row.round_amount),actualHours:nullable(row.actual_hours),
   releasedAt:nullable(row.released_at),releaseBasis:nullable(row.release_basis),cancellation:Boolean(row.cancellation),
   markedBy:nullable(row.marked_by),markedByName:nullable(row.marked_by_name),markedAt:nullable(row.marked_at),
 }));
 type Person = {personId:string;name:string;orderCount:number;amount:string;lineCount:number;roundCount:number;sources:{source:string;kind:string;amount:string;lineCount:number}[]};
 return { ...(page===undefined?{}:{pagination:{page:summary.page,pageSize:limit,totalPages:summary.total_pages,totalCount:summary.row_count}}),columns:[
   {key:"periodMonth",label:"工资月份"},{key:"personName",label:"人员"},{key:"personType",label:"人员类型"},
   {key:"wageSource",label:"工资来源"},{key:"wageKind",label:"业务类型"},
   {key:"orderNo",label:"订单号"},{key:"styleNo",label:"款号"},{key:"taskName",label:"杂事名称"},{key:"processName",label:"工序/品类"},
   {key:"roundIndex",label:"打板轮次（0为首次）"},{key:"segmentIndex",label:"执行段"},
   {key:"quantity",label:"数量（板房为整轮数量）"},{key:"actualHours",label:"本人工时"},{key:"unit",label:"单位"},{key:"unitPrice",label:"单价快照"},
   {key:"sourceAmount",label:"执行段计薪原值"},{key:"roundAmount",label:"整轮计薪原值"},
   {key:"assignmentMode",label:"计薪方式"},{key:"temporaryWageMultiplier",label:"临时工系数"},{key:"groupAmount",label:"组总额原值"},{key:"memberCount",label:"组内人数"},{key:"exactPersonShare",label:"个人份额原值"},
   {key:"wageAmount",label:"工资金额"},{key:"completedDate",label:"劳动完成日期"},
   {key:"releasedAt",label:"工资放行时间"},{key:"releaseBasis",label:"放行依据"},{key:"cancellation",label:"取消费用"},
   {key:"settlementStatus",label:"工资结算"},{key:"markedByName",label:"结算标记人"},{key:"markedAt",label:"结算标记时间"},
 ], rows,totals:{wageAmount:money(summary.wage_total),unsettledWageAmount:money(summary.unsettled_total),settledWageAmount:money(summary.settled_total)},wageSummary:{
   rowCount:summary.row_count,pendingLineCount:summary.pending_lines,pendingPersonCount:summary.pending_people,
   personCount:summary.person_count,orderCount:summary.order_count,roundCount:summary.round_count,
   people:(summary.people as Person[]).map(p=>({...p,amount:money(p.amount),sources:p.sources.map(item=>({...item,amount:money(item.amount)}))})),
 }};
}
