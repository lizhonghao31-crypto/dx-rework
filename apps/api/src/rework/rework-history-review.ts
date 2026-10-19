import { WholeOrderReviewResponseSchema, type WholeOrderReviewResponse, TailInspectionResponseSchema, type TailInspectionResponse } from '@dx-rework/contracts';
import type { PoolClient } from 'pg';

type Item = {configurationItemId:string;processName:string;pricingUnit:'piece'|'hour';plannedQuantity:number;unitPrice:number|null;executionKind:'worker'|'tail_inspection'};
/** Read the same review model as the live page, with every mutable fact bounded by the selected submission. */
export async function readHistoricalReview(client:PoolClient, orderId:string, at:string, configuration:{items:Item[];unifiedExecutionRequired:boolean}, tailRequired:boolean, orderVersion:number, special?:Pick<WholeOrderReviewResponse,'specialProcessType'|'otherCraftDescription'>):Promise<WholeOrderReviewResponse> {
 const reports=(await client.query(`SELECT report.work_report_id AS "workReportId",report.work_task_id AS "workTaskId",report.configuration_item_id AS "configurationItemId",
 report.actual_quantity::float8 AS "actualQuantity",COALESCE(correction.effective_quantity,report.actual_quantity)::float8 AS "effectiveQuantity",
 correction.revision_version IS NOT NULL AS corrected,correction.revision_version AS "correctionVersion",correction.corrected_by AS "correctedBy",correction.corrected_at AS "correctedAt",
 report.completed_at AS "completedAt",report.submitted_by AS "submittedBy",task.assignment_mode AS "assignmentMode",item.execution_kind AS "executionKind",
 rejection.report_rejection_id IS NOT NULL AS rejected,rejection.rejected_person_id AS "rejectedPersonId",rejection.reason AS "rejectionReason",report.resubmits_work_report_id AS "resubmitsWorkReportId",
 COALESCE((SELECT json_agg(json_build_object('personId',member.person_id,'displayName',member.display_name_snapshot) ORDER BY member.person_id)
 FROM rework_work_report_member_shares share JOIN rework_work_task_members member ON member.work_task_id=report.work_task_id AND member.person_id=share.person_id WHERE share.work_report_id=report.work_report_id),'[]') members
 FROM rework_work_reports report JOIN rework_work_tasks task USING(work_task_id) JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
 LEFT JOIN rework_work_report_rejections rejection ON rejection.work_report_id=report.work_report_id AND rejection.rejected_at <= $2::timestamptz
 LEFT JOIN LATERAL (SELECT * FROM rework_work_report_quantity_revisions revision WHERE revision.work_report_id=report.work_report_id AND revision.corrected_at <= $2::timestamptz ORDER BY revision.revision_version DESC LIMIT 1) correction ON true
 WHERE report.rework_order_id=$1 AND report.created_at <= $2::timestamptz ORDER BY report.completed_at,report.work_report_id`,[orderId,at])).rows.map(row=>({...row,completedAt:row.completedAt.toISOString(),correctedAt:row.correctedAt?.toISOString()??null})) as WholeOrderReviewResponse['reports'];
 const confirmation=(await client.query(`SELECT confirmation.*,review.decision,review.reviewed_by,review.reviewed_at,review.reason AS review_reason FROM rework_tail_completion_confirmations confirmation
 LEFT JOIN rework_tail_completion_reviews review ON review.confirmation_id=confirmation.confirmation_id AND review.reviewed_at <= $2::timestamptz
 WHERE confirmation.rework_order_id=$1 AND confirmation.confirmed_at <= $2::timestamptz ORDER BY confirmation.confirmation_version DESC LIMIT 1`,[orderId,at])).rows[0];
 let finalConfirmation:WholeOrderReviewResponse['finalConfirmation']=null;
 let temporaryWorkers:WholeOrderReviewResponse['temporaryWorkers']=[];
 if(confirmation){
  const id=confirmation.confirmation_id;
  const prices=(await client.query(`SELECT configuration_item_id AS "configurationItemId",original_unit_price::float8 AS "originalUnitPrice",proposed_unit_price::float8 AS "proposedUnitPrice",original_unit_price<>proposed_unit_price AS changed FROM rework_tail_completion_prices WHERE confirmation_id=$1`,[id])).rows;
  const quantities=(await client.query(`SELECT configuration_item_id AS "configurationItemId",worker_reported_quantity::float8 AS "workerReportedQuantity",tail_reported_quantity::float8 AS "tailReportedQuantity",final_confirmed_quantity::float8 AS "finalConfirmedQuantity",worker_reported_quantity<>final_confirmed_quantity AS changed FROM rework_tail_completion_quantities WHERE confirmation_id=$1`,[id])).rows;
  finalConfirmation={confirmationId:id,confirmationVersion:confirmation.confirmation_version,status:confirmation.decision??confirmation.workflow_stage,confirmedBy:confirmation.confirmed_by,confirmedAt:confirmation.confirmed_at.toISOString(),reviewedBy:confirmation.reviewed_by??null,reviewedAt:confirmation.reviewed_at?.toISOString()??null,reviewReason:confirmation.review_reason??null,prices,quantities} as WholeOrderReviewResponse['finalConfirmation'];
  temporaryWorkers=(await client.query(`SELECT coefficient.configuration_item_id AS "configurationItemId",item.process_name AS "processName",coefficient.person_id AS "personId",
 COALESCE((SELECT member.display_name_snapshot FROM rework_work_task_members member JOIN rework_work_tasks task USING(work_task_id) WHERE member.person_id=coefficient.person_id AND task.configuration_item_id=coefficient.configuration_item_id AND task.created_at <= $2::timestamptz ORDER BY task.created_at DESC LIMIT 1),'历史姓名未记录') AS "displayName",coefficient.multiplier::float8 multiplier,coefficient.reason
 FROM rework_tail_completion_coefficients coefficient JOIN rework_process_configuration_items item USING(configuration_item_id) WHERE coefficient.confirmation_id=$1`,[id,at])).rows;
 }
 const tail=configuration.unifiedExecutionRequired?null:await readHistoricalTailInspection(client,orderId,at,configuration.items);
 const snapshot=(await client.query(`SELECT review_snapshot FROM rework_order_reviews WHERE rework_order_id=$1 AND reviewed_at <= $2::timestamptz ORDER BY reviewed_at DESC LIMIT 1`,[orderId,at])).rows[0]?.review_snapshot;
 const sum=(kind:'worker'|'tail_inspection',field:'actualQuantity'|'effectiveQuantity',id?:string)=>reports.filter(r=>!r.rejected&&r.executionKind===kind&&(!id||r.configurationItemId===id)).reduce((total,r)=>total+r[field],0);
 const processes=configuration.items.filter(item=>item.executionKind==='worker').map(item=>{
  const frozen=snapshot?.processes?.find((p:{configurationItemId:string})=>p.configurationItemId===item.configurationItemId);
  const quantity=finalConfirmation?.quantities.find(q=>q.configurationItemId===item.configurationItemId);
  const completedQuantity=frozen?.workerEffectiveQuantity??sum('worker','effectiveQuantity',item.configurationItemId);
  const tailCheckedQuantity=frozen?.tailEffectiveQuantity??quantity?.tailReportedQuantity??tail?.processes.find(p=>p.configurationItemId===item.configurationItemId)?.inspectedQuantity??sum('tail_inspection','effectiveQuantity');
  return {configurationItemId:item.configurationItemId,processName:item.processName,pricingUnit:item.pricingUnit,plannedQuantity:item.plannedQuantity,
   originalCompletedQuantity:frozen?.workerOriginalQuantity??sum('worker','actualQuantity',item.configurationItemId),completedQuantity,
   originalTailCheckedQuantity:frozen?.tailOriginalQuantity??tail?.processes.find(p=>p.configurationItemId===item.configurationItemId)?.inspectedQuantity??sum('tail_inspection','actualQuantity'),tailCheckedQuantity,
   countGap:tailRequired?completedQuantity-tailCheckedQuantity:0,complete:completedQuantity>0&&(!tailRequired||tailCheckedQuantity>=completedQuantity),finalUnitPrice:item.unitPrice};
 });
 return WholeOrderReviewResponseSchema.parse({reworkOrderId:orderId,reworkStatus:'pending_order_review',orderVersion,canReview:false,canIeReview:false,canAdjustQuantity:false,canConfirmQuantity:false,canReviewQuantityIncrease:false,unifiedExecutionRequired:configuration.unifiedExecutionRequired,tailInspectionRequired:tailRequired,specialProcessType:special?.specialProcessType??null,otherCraftDescription:special?.otherCraftDescription??null,processes,reports,adjustments:[],temporaryWorkers,reviewId:null,finalConfirmation});
}

export async function readHistoricalTailInspection(client:PoolClient,orderId:string,at:string,items:Item[]):Promise<TailInspectionResponse> {
 const assignments=(await client.query(`SELECT assignment.tail_inspection_assignment_id AS "assignmentId",assignment.tail_inspector_user_id AS "tailInspectorUserId",person.display_name AS "tailInspectorName",assignment.box_scope AS "boxScope",CASE WHEN assignment.revoked_at <= $2::timestamptz THEN 'revoked' ELSE 'active' END status,report.returned_quantity::float8 AS "returnedQuantity",report.submitted_at AS "submittedAt",false AS "canSubmit"
 FROM rework_tail_inspection_assignments assignment JOIN app_users person ON person.id=assignment.tail_inspector_user_id
 LEFT JOIN LATERAL(SELECT returned_quantity,submitted_at FROM rework_tail_inspection_reports report WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id AND report.submitted_at <= $2::timestamptz AND (report.rejected_at IS NULL OR report.rejected_at > $2::timestamptz) ORDER BY submitted_at DESC LIMIT 1) report ON true
 WHERE assignment.rework_order_id=$1 AND assignment.assigned_at <= $2::timestamptz`,[orderId,at])).rows.map(row=>({...row,submittedAt:row.submittedAt?.toISOString()??null}));
 const quantities=(await client.query(`SELECT item.configuration_item_id,sum(item.inspected_quantity)::float8 quantity FROM rework_tail_inspection_report_items item JOIN rework_tail_inspection_reports report USING(tail_inspection_report_id) JOIN rework_tail_inspection_assignments assignment USING(tail_inspection_assignment_id)
 WHERE report.rework_order_id=$1 AND report.submitted_at <= $2::timestamptz AND (report.rejected_at IS NULL OR report.rejected_at > $2::timestamptz) AND (assignment.revoked_at IS NULL OR assignment.revoked_at > $2::timestamptz) GROUP BY item.configuration_item_id`,[orderId,at])).rows;
 return TailInspectionResponseSchema.parse({reworkOrderId:orderId,reworkStatus:'pending_order_review',assignments,processes:items.filter(item=>item.executionKind==='worker').map(item=>({configurationItemId:item.configurationItemId,processName:item.processName,inspectedQuantity:quantities.find(q=>q.configuration_item_id===item.configurationItemId)?.quantity??0}))});
}
