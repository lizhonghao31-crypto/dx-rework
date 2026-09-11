import { FinanceNodeReadSchema, type FinanceNodeKey, type FinanceNodeRead } from "@dx-rework/contracts/reporting";
import type { Pool } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { capabilities, fail } from "./management-reporting-shared.js";
import { wageSelection } from "./wage-report-selection.js";

type SectionQuery={title:string;columns:string[];sql:string;values?:unknown[]};
const assignments:SectionQuery={title:"分工记录",columns:["工序","版本","状态","方式","工人","分工人","时间"],sql:`
 SELECT item.process_name,task.task_version,task.status,task.assignment_mode,
   (SELECT string_agg(member.display_name_snapshot,'、' ORDER BY member.person_id) FROM rework_work_task_members member WHERE member.work_task_id=task.work_task_id) workers,
   actor.display_name,task.created_at
 FROM rework_work_tasks task JOIN rework_process_configuration_items item USING(configuration_item_id)
 LEFT JOIN app_users actor ON actor.id=task.created_by WHERE task.rework_order_id=$1 ORDER BY task.created_at,task.work_task_id`};
const preassignment:SectionQuery={title:"工人预分配",columns:["配置版本","工序","工人","类型","分配人","时间"],sql:`
 SELECT plan.configuration_version,item.process_name,member.display_name_snapshot,member.person_type_snapshot,actor.display_name,plan.created_at
 FROM rework_process_worker_plans plan JOIN rework_process_worker_plan_members member USING(plan_id)
 JOIN rework_process_configuration_items item USING(configuration_item_id) LEFT JOIN app_users actor ON actor.id=plan.planned_by
 WHERE plan.rework_order_id=$1 ORDER BY plan.configuration_version DESC,item.position,member.person_id`};
const processes:SectionQuery={title:"工序与核价记录",columns:["配置版本","配置状态","工序","计划数量","计价单位","单价","配置人","配置时间","IE 审核人","审核时间","审核意见","变更原因"],sql:`
 SELECT configuration.configuration_version,configuration.status,item.process_name,item.planned_quantity,item.pricing_unit,item.unit_price,
   creator.display_name,configuration.created_at,reviewer.display_name,configuration.reviewed_at,configuration.review_reason,configuration.change_reason
 FROM rework_process_configurations configuration LEFT JOIN rework_process_configuration_items item USING(configuration_id)
 LEFT JOIN app_users creator ON creator.id=configuration.created_by LEFT JOIN app_users reviewer ON reviewer.id=configuration.reviewed_by
 WHERE configuration.rework_order_id=$1 ORDER BY configuration.configuration_version DESC,item.position`};
const reports:SectionQuery={title:"报工记录",columns:["工序","报工人","原报数量","有效数量","结算数量","完工时间","报工时间","金额","备注","记录状态"],sql:`
 SELECT item.process_name,actor.display_name,report.actual_quantity,rework_work_report_effective_quantity(report.work_report_id),report.settlement_quantity,report.completed_at,report.created_at,report.group_amount,report.remark,
   CASE WHEN EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id) THEN '已驳回' ELSE '已提交' END
 FROM rework_work_reports report JOIN rework_process_configuration_items item USING(configuration_item_id)
 LEFT JOIN app_users actor ON actor.id=report.submitted_by WHERE report.rework_order_id=$1 ORDER BY report.created_at,report.work_report_id`};
const quantities:SectionQuery={title:"最终数量与 IE 复核",columns:["确认版本","工序","工人报数","尾部报数","最终确认数量","尾部确认人","确认时间","IE 决定","IE 审核人","审核时间","审核意见"],sql:`
 SELECT confirmation.confirmation_version,item.process_name,quantity.worker_reported_quantity,quantity.tail_reported_quantity,quantity.final_confirmed_quantity,
   tail.display_name,confirmation.confirmed_at,review.decision,ie.display_name,review.reviewed_at,review.reason
 FROM rework_tail_completion_confirmations confirmation LEFT JOIN rework_tail_completion_quantities quantity USING(confirmation_id)
 LEFT JOIN rework_process_configuration_items item USING(configuration_item_id)
 LEFT JOIN rework_tail_completion_reviews review USING(confirmation_id)
 LEFT JOIN app_users tail ON tail.id=confirmation.confirmed_by LEFT JOIN app_users ie ON ie.id=review.reviewed_by
 WHERE confirmation.rework_order_id=$1 ORDER BY confirmation.confirmation_version DESC,item.position`};
const adjustments:SectionQuery={title:"数量调整记录",columns:["工序","版本","状态","原数量","申请数量","原因","申请人","申请时间","确认人","实裁数量","实际回货","确认意见","IE 审核人","审核意见"],sql:`
 SELECT item.process_name,adjustment.adjustment_version,adjustment.status,adjustment.previous_planned_quantity,adjustment.requested_planned_quantity,
   adjustment.reason,requester.display_name,adjustment.requested_at,confirmer.display_name,adjustment.actual_cut_quantity,adjustment.actual_return_quantity,
   adjustment.confirmation_reason,reviewer.display_name,adjustment.review_reason
 FROM rework_process_quantity_adjustments adjustment JOIN rework_process_configuration_items item USING(configuration_item_id)
 LEFT JOIN app_users requester ON requester.id=adjustment.requested_by LEFT JOIN app_users confirmer ON confirmer.id=adjustment.confirmed_by
 LEFT JOIN app_users reviewer ON reviewer.id=adjustment.reviewed_by WHERE adjustment.rework_order_id=$1 ORDER BY adjustment.requested_at DESC`};
const precounts:SectionQuery={title:"IE 预点数",columns:["工序","数量","备注","记录人","记录时间"],sql:`
 SELECT item.process_name,entry.quantity,entry.note,actor.display_name,entry.recorded_at FROM rework_ie_precount_entries entry
 JOIN rework_process_configuration_items item USING(configuration_item_id) LEFT JOIN app_users actor ON actor.id=entry.recorded_by
 WHERE entry.rework_order_id=$1 ORDER BY entry.recorded_at DESC`};
const coefficients:SectionQuery={title:"最终数量确认系数",columns:["确认版本","工序","工人","系数","原因"],sql:`
 SELECT confirmation.confirmation_version,item.process_name,person.display_name,coefficient.multiplier,coefficient.reason
 FROM rework_tail_completion_confirmations confirmation JOIN rework_tail_completion_coefficients coefficient USING(confirmation_id)
 JOIN rework_process_configuration_items item USING(configuration_item_id) JOIN business_people person USING(person_id)
 WHERE confirmation.rework_order_id=$1 ORDER BY confirmation.confirmation_version DESC,item.position,person.person_id`};
const finalPrices:SectionQuery={title:"最终数量核价快照",columns:["确认版本","工序","原单价","复核单价"],sql:`
 SELECT confirmation.confirmation_version,item.process_name,price.original_unit_price,price.proposed_unit_price
 FROM rework_tail_completion_confirmations confirmation JOIN rework_tail_completion_prices price USING(confirmation_id)
 JOIN rework_process_configuration_items item USING(configuration_item_id) WHERE confirmation.rework_order_id=$1
 ORDER BY confirmation.confirmation_version DESC,item.position`};
const reviewSnapshot:SectionQuery={title:"整单审核快照",columns:["工序","工人原报数","工人有效数","尾部原报数","尾部有效数","审核人","审核时间"],sql:`
 SELECT process->>'processName',process->>'workerOriginalQuantity',process->>'workerEffectiveQuantity',process->>'tailOriginalQuantity',process->>'tailEffectiveQuantity',
   actor.display_name,review.reviewed_at FROM rework_order_reviews review
 LEFT JOIN LATERAL jsonb_array_elements(COALESCE(review.review_snapshot->'processes','[]'::jsonb)) process ON true
 LEFT JOIN app_users actor ON actor.id=review.reviewed_by WHERE review.rework_order_id=$1 ORDER BY review.reviewed_at DESC`};
const quantityCorrections:SectionQuery={title:"报数修正记录",columns:["工序","工人","修正版本","原数量","有效数量","修正人","修正时间"],sql:`
 SELECT item.process_name,person.display_name,revision.revision_version,revision.original_quantity,revision.effective_quantity,actor.display_name,revision.corrected_at
 FROM rework_work_report_quantity_revisions revision JOIN rework_process_configuration_items item USING(configuration_item_id)
 JOIN business_people person USING(person_id) LEFT JOIN app_users actor ON actor.id=revision.corrected_by
 WHERE revision.rework_order_id=$1 ORDER BY revision.corrected_at DESC`};
const ownerMultipliers:SectionQuery={title:"老板签字倍率调整",columns:["判定版本","工序","责任方","倍率","调整原因","签字人","时间"],sql:`
 SELECT determination.determination_version,item.process_name,adjustment.responsibility_type,adjustment.multiplier,adjustment.reason,actor.display_name,signature.signed_at
 FROM rework_responsibility_owner_multiplier_adjustments adjustment
 JOIN rework_responsibility_owner_signatures signature USING(owner_signature_id)
 JOIN rework_responsibility_determinations determination ON determination.determination_id=adjustment.determination_id
 JOIN rework_process_configuration_items item USING(configuration_item_id) LEFT JOIN app_users actor ON actor.id=signature.signed_by
 WHERE signature.rework_order_id=$1 ORDER BY signature.signed_at DESC,item.position`};
const highMultipliers:SectionQuery={title:"高倍率确认记录",columns:["判定版本","确认人","时间","原因"],sql:`
 SELECT determination.determination_version,actor.display_name,confirmation.confirmed_at,confirmation.reason
 FROM rework_responsibility_high_multiplier_confirmations confirmation JOIN rework_responsibility_determinations determination USING(determination_id)
 LEFT JOIN app_users actor ON actor.id=confirmation.confirmed_by WHERE determination.rework_order_id=$1 ORDER BY confirmation.confirmed_at DESC`};
const responsibility:SectionQuery={title:"责任判定与分摊",columns:["判定版本","状态","工序","基础金额","倍率","倍率原因","责任方","供应商","占比（%）","责任金额","判定人","时间","判定原因"],sql:`
 SELECT determination.determination_version,determination.stage,process.process_name_snapshot,process.base_amount,COALESCE(allocation.multiplier,process.multiplier),process.high_multiplier_reason,
   allocation.responsibility_type,allocation.supplier_name_snapshot,allocation.share_bps/100.0,allocation.rounded_amount,actor.display_name,determination.created_at,determination.reason
 FROM rework_responsibility_determinations determination LEFT JOIN rework_responsibility_processes process USING(determination_id)
 LEFT JOIN rework_responsibility_allocations allocation USING(determination_id,configuration_item_id)
 LEFT JOIN app_users actor ON actor.id=determination.created_by WHERE determination.rework_order_id=$1
 ORDER BY determination.determination_version DESC,process.process_name_snapshot,allocation.responsibility_type`};
const responsibilityLines:SectionQuery={title:"责任计算明细",columns:["判定版本","工序","工人","责任方","工资基础","倍率","占比（%）","责任金额"],sql:`
 SELECT determination.determination_version,item.process_name,line.worker_display_name_snapshot,line.responsibility_type,line.base_member_share_amount,
   line.multiplier,line.share_bps/100.0,line.rounded_amount FROM rework_responsibility_determinations determination
 JOIN rework_responsibility_amount_lines line USING(determination_id) JOIN rework_process_configuration_items item USING(configuration_item_id)
 WHERE determination.rework_order_id=$1 ORDER BY determination.determination_version DESC,item.position,line.worker_display_name_snapshot`};
const signatures:SectionQuery={title:"老板签字记录",columns:["判定版本","决定","签字人","签字时间"],sql:`
 SELECT determination.determination_version,signature.decision,actor.display_name,signature.signed_at
 FROM rework_responsibility_owner_signatures signature JOIN rework_responsibility_determinations determination USING(determination_id)
 LEFT JOIN app_users actor ON actor.id=signature.signed_by WHERE signature.rework_order_id=$1 ORDER BY signature.signed_at DESC`};
const approvals:SectionQuery={title:"本厂责任审批记录",columns:["判定版本","状态","本厂金额","决定","处理人","时间","意见"],sql:`
 SELECT approval.finalized_determination_version,approval.status,approval.own_factory_total_amount,decision.decision,actor.display_name,decision.decided_at,decision.opinion
 FROM rework_own_factory_approvals approval LEFT JOIN rework_own_factory_approval_decisions decision USING(approval_id)
 LEFT JOIN app_users actor ON actor.id=decision.acted_by WHERE approval.rework_order_id=$1 ORDER BY approval.created_at DESC`};
const cases:SectionQuery={title:"外部扣款责任与结案",columns:["供应商","责任方","状态","拟扣金额","结案结果","已扣金额","剩余金额","结案原因","差额处置","结案人","时间"],sql:`
 SELECT external.supplier_name_snapshot,external.responsibility_type,external.status,external.proposed_deduction_amount,closure.result,
   closure.actual_deducted_amount,closure.remaining_amount,closure.reason,closure.remaining_difference_disposition,actor.display_name,closure.closed_at
 FROM rework_external_responsibility_cases external LEFT JOIN rework_external_deduction_closures closure USING(case_id)
 LEFT JOIN app_users actor ON actor.id=closure.closed_by WHERE external.rework_order_id=$1 ORDER BY external.created_at DESC`};
const deductions:SectionQuery={title:"实际扣款明细",columns:["供应商","记录类型","金额","扣款日期","凭证号","记录人","时间"],sql:`
 SELECT external.supplier_name_snapshot,entry.entry_type,entry.amount,entry.deducted_on,entry.reference_no,actor.display_name,entry.created_at
 FROM rework_external_responsibility_cases external JOIN rework_external_deduction_entries entry USING(case_id)
 LEFT JOIN app_users actor ON actor.id=entry.recorded_by WHERE external.rework_order_id=$1 ORDER BY entry.created_at DESC`};
const special:SectionQuery={title:"财务异常特批记录",columns:["供应商","拟扣金额","实际扣款","剩余金额","申请原因","申请人","决定","审批人","审批时间","审批意见"],sql:`
 SELECT external.supplier_name_snapshot,request.proposed_amount_snapshot,request.actual_deducted_amount_snapshot,request.remaining_amount_snapshot,
   request.reason,requester.display_name,decision.decision,decider.display_name,decision.decided_at,decision.reason
 FROM rework_external_responsibility_cases external JOIN rework_external_deduction_special_requests request USING(case_id)
 LEFT JOIN rework_external_deduction_special_decisions decision USING(special_request_id)
 LEFT JOIN app_users requester ON requester.id=request.requested_by LEFT JOIN app_users decider ON decider.id=decision.decided_by
 WHERE external.rework_order_id=$1 ORDER BY request.requested_at DESC`};

export async function readFinanceNode(db:Pool,actor:TrustedActorContext,orderId:string,node:FinanceNodeKey):Promise<FinanceNodeRead>{
 if(!capabilities(actor).includes("rework:finance_nodes:read"))fail("缺少财务节点查看权限");
 const client=await db.connect();
 try{
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SELECT access_authorized_actor_roles($1,$2)",[actor.actorId,"rework:finance_nodes:read"]);
  const order=await client.query("SELECT 1 FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted'",[orderId]);
  if(!order.rowCount)fail("返工单不存在",404,"NOT_FOUND");
  const wages:SectionQuery={title:"工资明细",columns:["工人","类型","工序","数量","单价","工资金额","完工日期","结算状态","结算标记人","标记时间"],sql:`${wageSelection}
    SELECT person_name_snapshot,person_type_snapshot,process_name_snapshot,actual_quantity_snapshot,unit_price_snapshot,wage_amount,completed_date,
      CASE WHEN marked_at IS NULL THEN '未结算' ELSE '已结算' END,(SELECT display_name FROM app_users WHERE id=marked_by),marked_at
    FROM filtered WHERE rework_order_id=$6 ORDER BY person_name_snapshot,completed_date,line_id`,values:['0001-01-01','9999-12-31',null,null,null,orderId]};
  const initiation:SectionQuery={title:"发起资料",columns:["返工号","款号","数量","原因","问题部位","问题描述","发起人","发起时间"],sql:`
    SELECT orders.rework_no,orders.style_no,orders.rework_quantity,to_jsonb(orders)->>'rework_reason',orders.problem_part,orders.problem_description,actor.display_name,orders.created_at
    FROM rework_orders orders LEFT JOIN app_users actor ON actor.id=orders.created_by WHERE orders.rework_order_id=$1`};
  const byNode:Record<FinanceNodeKey,SectionQuery[]>={
    initiation:[initiation],process_configuration:[processes,preassignment,assignments],ie_review:[processes],task_assignment:[preassignment,assignments],
    work_reporting:[assignments,reports,quantityCorrections],whole_order_review:[quantities,finalPrices,coefficients,reports,quantityCorrections,reviewSnapshot],final_quantity_ie_review:[quantities,finalPrices,coefficients,precounts,reviewSnapshot],
    quantity_adjustment:[adjustments,quantities],responsibility:[responsibility,responsibilityLines,highMultipliers],owner_signature:[responsibility,signatures,ownerMultipliers,approvals],
    settlement_ledger:[cases,deductions,special,wages],settlement_followup:[cases,deductions,special,wages],
  };
  const sections:FinanceNodeRead['sections']=[];
  for(const section of byNode[node]){
    const result=await client.query({text:section.sql,values:section.values??[orderId],rowMode:'array'});
    sections.push({title:section.title,columns:section.columns,rows:result.rows.map((row:unknown[])=>row.map(value=>value==null?null:value instanceof Date?value.toISOString():String(value)))});
  }
  await client.query("COMMIT");return FinanceNodeReadSchema.parse({node,sections});
 }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}
