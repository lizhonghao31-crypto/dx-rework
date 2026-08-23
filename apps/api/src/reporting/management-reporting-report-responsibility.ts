import type { ReportQuery } from "@dx-rework/contracts/reporting";
import type { QueryResultRow } from "pg";

import { type Queryable, type Range, type ReportData, TIMEZONE, money } from "./management-reporting-shared.js";
import { totals } from "./management-reporting-report-exceptions.js";

export async function responsibilityReport(source: Queryable, query: ReportQuery, range: Range, limit: number): Promise<ReportData> {
  const result = await source.query<QueryResultRow>(
    `WITH leaf AS (
       SELECT determination.* FROM rework_responsibility_determinations determination
       WHERE determination.stage='finalized' AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations successor WHERE successor.replaces_determination_id=determination.determination_id)
     )
     SELECT order_record.rework_order_id,order_record.rework_no,order_record.style_no,leaf.determination_version,
       process.process_name_snapshot,COALESCE(responsibility_allocation.multiplier,process.multiplier)::text multiplier,allocation.responsibility_type,allocation.share_bps,
       allocation.effective_rounded_amount::text rounded_amount
     FROM leaf JOIN rework_orders order_record USING(rework_order_id)
     JOIN rework_effective_responsibility_allocations allocation USING(determination_id)
     JOIN rework_responsibility_allocations responsibility_allocation
       USING(determination_id,configuration_item_id,responsibility_type)
     JOIN rework_responsibility_processes process USING(determination_id,configuration_item_id)
     WHERE order_record.status<>'deleted'
       AND (leaf.created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
       AND ($4::text IS NULL OR order_record.rework_no ILIKE $4 OR order_record.style_no ILIKE $4 OR process.process_name_snapshot ILIKE $4)
       AND ($5::text IS NULL OR allocation.responsibility_type=$5)
     ORDER BY leaf.created_at DESC,order_record.rework_order_id,process.configuration_item_id,allocation.responsibility_type LIMIT $6`,
    [range.from,range.to,TIMEZONE,query.q ? `%${query.q}%` : null,query.status ?? null,limit]);
  const rows=result.rows.map((row)=>({reworkOrderId:String(row.rework_order_id),reworkNo:row.rework_no===null?null:String(row.rework_no),styleNo:row.style_no===null?null:String(row.style_no),determinationVersion:Number(row.determination_version),processName:String(row.process_name_snapshot),multiplier:String(row.multiplier),responsibilityType:String(row.responsibility_type),shareBps:Number(row.share_bps),amount:money(String(row.rounded_amount))}));
  return {columns:[{key:"reworkNo",label:"返工单号"},{key:"styleNo",label:"款号"},{key:"determinationVersion",label:"责任版本"},{key:"processName",label:"工序"},{key:"multiplier",label:"倍率"},{key:"responsibilityType",label:"责任类型"},{key:"shareBps",label:"责任比例(bps)"},{key:"amount",label:"责任金额"}],rows,totals:totals(rows,["amount"])};
}

export async function ownFactoryReport(source: Queryable, query: ReportQuery, range: Range, limit: number): Promise<ReportData> {
  const result=await source.query<QueryResultRow>(
    `WITH leaf AS (SELECT determination.* FROM rework_responsibility_determinations determination WHERE determination.stage='finalized' AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations successor WHERE successor.replaces_determination_id=determination.determination_id))
     SELECT order_record.rework_order_id,order_record.rework_no,order_record.style_no,approval.approval_id,
       approval.finalized_determination_version,approval.status,
       COALESCE((
         SELECT sum(allocation.effective_rounded_amount)
         FROM rework_effective_responsibility_allocations allocation
         WHERE allocation.determination_id=approval.finalized_determination_id
           AND allocation.responsibility_type='own_factory'
       ),0)::text own_factory_total_amount,
       decision.decision,decision.acted_by,decision.decided_at
     FROM leaf JOIN rework_own_factory_approvals approval ON approval.finalized_determination_id=leaf.determination_id
     JOIN rework_orders order_record ON order_record.rework_order_id=approval.rework_order_id
     LEFT JOIN rework_own_factory_approval_decisions decision USING(approval_id)
     WHERE order_record.status<>'deleted'
       AND (approval.created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
       AND ($4::text IS NULL OR order_record.rework_no ILIKE $4 OR order_record.style_no ILIKE $4)
       AND ($5::text IS NULL OR approval.status=$5)
     ORDER BY approval.created_at DESC,approval.approval_id LIMIT $6`,[range.from,range.to,TIMEZONE,query.q?`%${query.q}%`:null,query.status??null,limit]);
  const rows=result.rows.map((row)=>({reworkOrderId:String(row.rework_order_id),reworkNo:row.rework_no===null?null:String(row.rework_no),styleNo:row.style_no===null?null:String(row.style_no),approvalId:String(row.approval_id),determinationVersion:Number(row.finalized_determination_version),status:String(row.status),amount:money(String(row.own_factory_total_amount)),decision:row.decision===null?null:String(row.decision),actedBy:row.acted_by===null?null:String(row.acted_by),decidedAt:row.decided_at instanceof Date?row.decided_at.toISOString():null}));
  return {columns:[{key:"reworkNo",label:"返工单号"},{key:"styleNo",label:"款号"},{key:"determinationVersion",label:"责任版本"},{key:"status",label:"审批状态"},{key:"amount",label:"本厂承担金额"},{key:"decision",label:"决定"},{key:"actedBy",label:"处理人ID"},{key:"decidedAt",label:"处理时间"}],rows,totals:totals(rows,["amount"])};
}

export async function externalReport(source: Queryable, query: ReportQuery, range: Range, limit: number): Promise<ReportData> {
  const result=await source.query<QueryResultRow>(
    `WITH leaf AS (SELECT determination.* FROM rework_responsibility_determinations determination WHERE determination.stage='finalized' AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations successor WHERE successor.replaces_determination_id=determination.determination_id)),
     entries AS (SELECT case_id,COALESCE(sum(amount),0) actual FROM rework_external_deduction_entries GROUP BY case_id)
     SELECT order_record.rework_order_id,order_record.rework_no,order_record.style_no,case_record.case_id,
       case_record.responsibility_type,case_record.supplier_id,case_record.supplier_name_snapshot,case_record.status,
       case_record.proposed_deduction_amount::text,COALESCE(closure.actual_deducted_amount,entries.actual,0)::text actual_amount,
       COALESCE(closure.remaining_amount,case_record.proposed_deduction_amount-COALESCE(entries.actual,0))::text remaining_amount,
       closure.result,closure.closed_at
     FROM leaf JOIN rework_external_responsibility_batches batch ON batch.finalized_determination_id=leaf.determination_id AND batch.status='active'
     JOIN rework_external_responsibility_cases case_record USING(batch_id)
     JOIN rework_orders order_record ON order_record.rework_order_id=case_record.rework_order_id
     LEFT JOIN entries USING(case_id) LEFT JOIN rework_external_deduction_closures closure USING(case_id)
     WHERE order_record.status<>'deleted' AND case_record.status<>'superseded' AND (case_record.created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
       AND ($4::text IS NULL OR order_record.rework_no ILIKE $4 OR order_record.style_no ILIKE $4 OR case_record.supplier_name_snapshot ILIKE $4)
       AND ($5::text IS NULL OR case_record.status=$5 OR closure.result=$5)
     ORDER BY case_record.created_at DESC,case_record.case_id LIMIT $6`,[range.from,range.to,TIMEZONE,query.q?`%${query.q}%`:null,query.status??null,limit]);
  const rows=result.rows.map((row)=>({reworkOrderId:String(row.rework_order_id),reworkNo:row.rework_no===null?null:String(row.rework_no),styleNo:row.style_no===null?null:String(row.style_no),caseId:String(row.case_id),responsibilityType:String(row.responsibility_type),supplierId:String(row.supplier_id),supplierName:String(row.supplier_name_snapshot),status:String(row.status),proposedAmount:money(String(row.proposed_deduction_amount)),actualAmount:money(String(row.actual_amount)),remainingAmount:money(String(row.remaining_amount)),result:row.result===null?null:String(row.result),closedAt:row.closed_at instanceof Date?row.closed_at.toISOString():null}));
  return {columns:[{key:"reworkNo",label:"返工单号"},{key:"styleNo",label:"款号"},{key:"responsibilityType",label:"责任类型"},{key:"supplierName",label:"供应商"},{key:"status",label:"台账状态"},{key:"proposedAmount",label:"拟扣金额"},{key:"actualAmount",label:"累计实扣"},{key:"remainingAmount",label:"未扣差额"},{key:"result",label:"最终结果"},{key:"closedAt",label:"关闭时间"}],rows,totals:totals(rows,["proposedAmount","actualAmount","remainingAmount"])};
}
