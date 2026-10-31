import { readHistoricalResponsibility } from './rework-history-responsibility.js';
import { ProcessWorkerPlanResponseSchema } from '@dx-rework/contracts/process-worker-plan';
import { readHistoricalReview, readHistoricalTailInspection } from './rework-history-review.js';
import { InspectionReportDraftSchema, ReworkWorkTasksResponseSchema, ProcessConfigurationResponseSchema } from '@dx-rework/contracts';
import { ReworkNodeHistorySchema, type FinanceNodeKey, type ReworkNodeHistory } from '@dx-rework/contracts/reporting';
import type { Pool } from 'pg';
import { ApplicationError } from '../platform/errors.js';
import type { TrustedActorContext } from '../tools/repositories.js';
import type { ReworkBusinessDetail } from './rework-business-detail-service.js';

type Snapshot = Record<string, unknown>;
type HistoryEvent = { id: string; action: string; at: string; actor: string; reason: string | null; before: Snapshot; after: Snapshot };
const object = (value: unknown): Snapshot => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Snapshot : {};
const array = (value: unknown): Snapshot[] => Array.isArray(value) ? value.map(object) : [];
const value = (v: unknown): string | null => v == null ? null : v instanceof Date ? v.toISOString() : typeof v === 'boolean' ? v ? '是' : '否' : typeof v === 'string' || typeof v === 'number' ? String(v) : null;
export function reworkHistoryNode(action: string): FinanceNodeKey | null {
 if (action === 'rework.submit') return 'initiation';
 if (action === 'rework.process_configuration.submit') return 'process_configuration';
 if (action === 'rework.process_configuration.review') return 'ie_review';
 if (action === 'rework.work_task.assign') return 'task_assignment';
 if (action.startsWith('rework.work_report.') || action.startsWith('rework.tail_inspection.') || action.startsWith('rework.ie_precount.')) return 'work_reporting';
 if (action === 'rework.tail_completion.confirm' || action.startsWith('rework.whole_order.')) return 'whole_order_review';
 if (action.startsWith('rework.final_quantity.')) return 'final_quantity_ie_review';
 if (action.startsWith('rework.quantity.')) return 'quantity_adjustment';
 if (action.includes('owner_approve') || action.includes('owner_reject')) return 'owner_signature';
 if (action.startsWith('rework.responsibility.')) return 'responsibility';
 if (action.startsWith('rework.external') || action.startsWith('rework.own_factory') || action === 'rework.complete') return 'settlement_followup';
 return null;
}
// Node audit payloads contain styleNo too, but are not complete initiation forms.
export function selectReworkInitiationSnapshot(events: readonly Pick<HistoryEvent, 'action' | 'after'>[]): Snapshot {
 const completeActions = new Set(['rework.draft.create', 'rework.draft.update', 'rework.submit']);
 return [...events].reverse().find(event => completeActions.has(event.action))?.after ?? {};
}
const labels: Record<FinanceNodeKey,string> = {initiation:'发起返工',process_configuration:'分配工序与工人',ie_review:'IE 核价',task_assignment:'工人分配',work_reporting:'返工执行',whole_order_review:'尾部确认最终数量',final_quantity_ie_review:'IE 复核最终数量',quantity_adjustment:'数量调整',responsibility:'责任判定',owner_signature:'老板签字',settlement_ledger:'责任台账',settlement_followup:'扣款跟进'};
export function canReadReworkHistoryNode(actor: TrustedActorContext, node: FinanceNodeKey): boolean {
 const caps = actor.authorizationCapabilities ?? [actor.authorizationCapability];
 const has = (...keys: string[]) => keys.some(key => caps.includes(key));
 const role = (...keys: string[]) => keys.some(key => actor.actorRoles.includes(key));
 if (role('root_superuser','owner_group') || has('rework:finance_nodes:read')) return true;
 if (node === 'initiation') return true; // Order-level authorization is mandatory before this function.
 if (['process_configuration','ie_review','task_assignment'].includes(node)) return role('tail_supervisor') && has('process:configure') || role('ie_reviewer') && has('process:review');
 if (node === 'work_reporting') return role('tail_supervisor') && has('work:assign','work:assignment_adjust') || role('worker') && has('work:report','tail_inspection:report') || role('tail_inspector') && has('tail_inspection:report') || has('work:report_for_worker');
 if (['whole_order_review','final_quantity_ie_review','quantity_adjustment'].includes(node)) return has('submission:audit','quantity:adjust','quantity:confirm','process:review');
 if (['responsibility','owner_signature'].includes(node)) return (role('pmc') && has('external_responsibility:view')) || has('responsibility:determine','responsibility:takeover','responsibility:confirm_high_multiplier','responsibility:owner_sign','rework:related_orders:view');
 return false; // Scoped supplier ledgers retain their existing dedicated reader.
}
export async function readReworkNodeHistory(db: Pool, actor: TrustedActorContext, detail: ReworkBusinessDetail, node: FinanceNodeKey, entryId?: string): Promise<ReworkNodeHistory> {
 if ((!detail.canReadBusinessDetails && !(actor.authorizationCapabilities ?? []).includes('rework:finance_nodes:read')) || !canReadReworkHistoryNode(actor,node)) throw new ApplicationError('FORBIDDEN','无权查看该节点的完整历史资料',403);
 const client = await db.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const events = (await client.query<HistoryEvent>(`SELECT event.event_id AS id,event.action,event.created_at::text AS "at",COALESCE(person.display_name,'历史未记录') AS actor,event.reason,event.before_state AS "before",event.after_state AS "after"
    FROM operation_events event LEFT JOIN app_users person ON person.id=event.actor_id
    WHERE (event.entity_type='rework_order' AND event.entity_id=$1) OR event.after_state->>'reworkOrderId'=$1
    ORDER BY event.created_at,COALESCE((event.after_state->>'version')::int,(event.after_state->>'orderVersion')::int,0),event.event_id`,[detail.reworkOrderId])).rows;
  const versions = events.filter(event=>reworkHistoryNode(event.action)===node);
  const selected = entryId ? versions.find(event=>event.id===entryId) : versions.at(-1);
  if (!selected) throw new ApplicationError('NOT_FOUND','该节点没有可回看的提交记录',404);
  // Compare timestamps inside PostgreSQL, retaining microsecond precision.
  const earlierIds = new Set((await client.query<{id:string}>(`SELECT event_id id FROM operation_events WHERE created_at <= $2::timestamptz AND ((entity_type='rework_order' AND entity_id=$1) OR after_state->>'reworkOrderId'=$1)`,[detail.reworkOrderId,selected.at])).rows.map(row=>row.id));
  const past = events.filter(event=>earlierIds.has(event.id));
  const latest = (key:string) => [...past].reverse().find(event=>Object.hasOwn(event.after,key))?.after[key];
  const source = {...selectReworkInitiationSnapshot(past)};
  for(const key of ['tailInspectionRequired','tailInspectionCostBearer','tailInspectionCostBearerSource','specialProcessType','otherCraftDescription']) {
   const recorded=latest(key);if(recorded!==undefined) source[key]=recorded;
  }
  // The live decision is still "none" after waiver. Its historical display
  // must retain the actual pre-waiver work, without restoring it to settlement.
  const waivedCraft=selected.action==='rework.tail_inspection.waive'
    && object(selected.before).specialProcessType==='other_craft' ? object(selected.before) : null;
  if(waivedCraft) {
    source.specialProcessType=waivedCraft.specialProcessType;
    source.otherCraftDescription=waivedCraft.otherCraftDescription;
  }
  const factory = object(source.processingFactory);
  let factoryName: string | null = factory.type==='own_factory' ? '本厂' : null;
  if (factory.supplierId && factory.supplierVersion) factoryName=(await client.query<{name:string}>('SELECT supplier_name AS "name" FROM supplier_catalog_versions WHERE supplier_id=$1 AND version=$2',[factory.supplierId,factory.supplierVersion])).rows[0]?.name ?? null;
  const fields: ReworkNodeHistory['fields'] = [{label:'加工厂',value:factoryName},...Object.entries({styleNo:'款号',customerSupplyCode:'客供款号',factoryStyleNo:'工厂款号',orderNo:'订单号',orderQuantity:'订单数量',reworkQuantity:'返工数量',reworkProcess:'返工工序',reworkReason:'返工原因',problemPart:'问题部位',problemDescription:'问题描述',specialProcessType:'工艺类型',otherCraftDescription:'其他工艺内容',tailInspectionRequired:'需要整查',tailInspectionCostBearer:'整查费用承担方'}).map(([key,label])=>({label,value:key==='specialProcessType' ? ({none:'否',inspection:'整查',other_craft:'其他工艺'}[String(source[key]) as 'none'|'inspection'|'other_craft']??null) : value(source[key])}))];
  const created=past.find(event=>event.action==='rework.draft.create');
  if(created) fields.push({label:'发起时间',value:created.at},{label:'发起人',value:created.actor});
  const supply = [...past].reverse().find(event=>event.action==='rework.supply_context.save')?.after ?? {};
  for (const [key,label] of [['washingSupplier','洗水厂'],['embroiderySupplier','印绣花厂'],['fabricSupplier','面辅料供应商']] as const) {
    const supplier=object(supply[key]);
    const name=supplier.supplierId && supplier.supplierVersion ? (await client.query<{name:string}>('SELECT supplier_name AS "name" FROM supplier_catalog_versions WHERE supplier_id=$1 AND version=$2',[supplier.supplierId,supplier.supplierVersion])).rows[0]?.name : null;
    fields.push({label,value:name??null});
  }
  for (const [id,label] of [[source.merchandiserUserId,'订单跟单'],[supply.embroideryMerchandiserUserId,'印绣花跟单']] as const) {
    const name=id?(await client.query<{name:string}>('SELECT display_name AS "name" FROM app_users WHERE id=$1',[id])).rows[0]?.name:null;
    fields.push({label,value:name??null});
  }
  const page: NonNullable<ReworkNodeHistory['page']>={iePrecounts:{entries:[]},tailInspection:null,workTasks:null,configuration:null,workerPlan:null,wholeOrderReview:null,responsibility:null};
  const sections: ReworkNodeHistory['sections']=[];
  const notices: string[]=[];
  if(waivedCraft) notices.push(`已撤销其他工艺：${String(waivedCraft.otherCraftDescription)}；原工艺报数保留为历史，不计入最终数量、工资和责任。`);
  if (!Object.keys(source).length) notices.push('早期发起资料未保存完整历史快照，缺失字段显示“历史未记录”。');
  const configuration = object(selected.after.configuration ?? latest('configuration'));
  const configItems = array(configuration.items);
  if(configuration.configurationId) {
   const created=(await client.query('SELECT created_at FROM rework_process_configurations WHERE configuration_id=$1 AND rework_order_id=$2',[configuration.configurationId,detail.reworkOrderId])).rows[0];
   configuration.createdAt=created?.created_at.toISOString();
   configuration.submittedAt=[...past].reverse().find(e=>e.action==='rework.process_configuration.submit' && object(e.after.configuration).configurationId===configuration.configurationId)?.at;
   configuration.reviewedAt=[...past].reverse().find(e=>e.action==='rework.process_configuration.review' && object(e.after.configuration).configurationId===configuration.configurationId)?.at;
   for(const key of ['submittedAt','reviewedAt']) configuration[key]=configuration[key]?new Date(String(configuration[key])).toISOString():null;
  }
  const historicalStatus=selected.after.status ?? selected.after.reworkStatus;
  const configurationResult=ProcessConfigurationResponseSchema.safeParse({reworkOrderId:detail.reworkOrderId,reworkNo:source.reworkNo??detail.reworkNo,reworkStatus:historicalStatus,orderVersion:selected.after.version??selected.after.orderVersion,tailInspectionRequired:source.tailInspectionRequired,specialProcessType:source.specialProcessType,otherCraftDescription:source.otherCraftDescription,configuration});
  if(configurationResult.success && ['process_configuration','ie_review','task_assignment','whole_order_review','final_quantity_ie_review'].includes(node)) {
   page.configuration=configurationResult.data;
   if(['process_configuration','ie_review','task_assignment'].includes(node)) {
    const members=(await client.query(`SELECT member.configuration_item_id,member.person_id,member.display_name_snapshot,member.person_type_snapshot FROM rework_process_worker_plans plan JOIN rework_process_worker_plan_members member USING(plan_id) WHERE plan.rework_order_id=$1 AND plan.configuration_id=$2 AND plan.created_at <= $3::timestamptz ORDER BY member.created_at,member.person_id`,[detail.reworkOrderId,configuration.configurationId,selected.at])).rows;
    page.workerPlan=ProcessWorkerPlanResponseSchema.parse({reworkOrderId:detail.reworkOrderId,reworkStatus:configurationResult.data.reworkStatus,orderVersion:configurationResult.data.orderVersion,required:Boolean(configuration.workerPreassignmentRequired),configurationId:configuration.configurationId,configurationVersion:configuration.configurationVersion,configurationStatus:configuration.status,complete:configItems.every(item=>members.some(m=>m.configuration_item_id===item.configurationItemId)),assignments:configItems.map(item=>({configurationItemId:item.configurationItemId,processName:item.processName,executionKind:item.executionKind??'worker',members:members.filter(m=>m.configuration_item_id===item.configurationItemId).map(m=>({personId:m.person_id,displayName:m.display_name_snapshot,personType:m.person_type_snapshot}))}))});
   }
   if(['whole_order_review','final_quantity_ie_review'].includes(node) && configurationResult.data.configuration) page.wholeOrderReview=await readHistoricalReview(client,detail.reworkOrderId,selected.at,configurationResult.data.configuration,configurationResult.data.tailInspectionRequired,configurationResult.data.orderVersion,configurationResult.data);
   if(page.wholeOrderReview) page.iePrecounts.entries=(await client.query(`SELECT entry.configuration_item_id AS "configurationItemId",entry.quantity::float8 quantity,entry.note,person.display_name AS "recordedBy",entry.recorded_at AS "recordedAt" FROM rework_ie_precount_entries entry JOIN app_users person ON person.id=entry.recorded_by WHERE entry.rework_order_id=$1 AND entry.recorded_at <= $2::timestamptz ORDER BY entry.recorded_at DESC`,[detail.reworkOrderId,selected.at])).rows.map(row=>({...row,recordedAt:row.recordedAt.toISOString()}));
   if(page.wholeOrderReview && configurationResult.data.configuration && !configurationResult.data.configuration.unifiedExecutionRequired) page.tailInspection=await readHistoricalTailInspection(client,detail.reworkOrderId,selected.at,configurationResult.data.configuration.items);
  }
  const processName = (id:unknown) => value(configItems.find(item=>item.configurationItemId===id)?.processName) ?? '历史工序名称未记录';
  const add = (title:string,columns:string[],rows:unknown[][]) => sections.push({title,columns,rows:rows.map(row=>row.map(value))});
  const querySection = async (title:string,columns:string[],sql:string,params:unknown[]) => {
   const result=await client.query({text:sql,values:params,rowMode:'array'});add(title,columns,result.rows);
  };
  if (['process_configuration','ie_review','task_assignment'].includes(node)) {
   add('工序与单价',['工序','计划数量','计价单位','单价'],configItems.map(item=>[item.processName,item.plannedQuantity,item.pricingUnit,item.unitPrice]));
   fields.push({label:'配置版本',value:value(configuration.configurationVersion)},{label:'核价结果',value:value(configuration.status)},{label:'变更说明',value:value(configuration.changeReason)},{label:'审核意见',value:value(configuration.reviewReason) ?? selected.reason});
   await querySection('本次工人分配',['工序','工人','人员类型'],`SELECT item.process_name,COALESCE(person.display_name,member.display_name_snapshot),member.person_type_snapshot FROM rework_process_worker_plans plan JOIN rework_process_worker_plan_members member USING(plan_id) JOIN rework_process_configuration_items item USING(configuration_item_id) LEFT JOIN business_people person ON person.person_id=member.person_id WHERE plan.rework_order_id=$1 AND plan.configuration_id=$2 AND plan.created_at <= $3::timestamptz ORDER BY item.position,member.display_name_snapshot`,[detail.reworkOrderId,configuration.configurationId ?? null,selected.at]);
  }
  if (node==='work_reporting'||node==='task_assignment') {
   const caps=actor.authorizationCapabilities??[actor.authorizationCapability];
   const ownOnly=!actor.actorRoles.some(role=>['root_superuser','owner_group'].includes(role))&&!caps.includes('rework:finance_nodes:read')&&!(actor.actorRoles.includes('tail_supervisor')&&caps.some(cap=>['work:assign','work:assignment_adjust'].includes(cap)));
   await querySection('工人报数',['工序','工人','提交数量','有效数量','完工时间','备注','报数状态'],`SELECT item.process_name,COALESCE(person.display_name,member.display_name_snapshot),report.actual_quantity,COALESCE((SELECT revision.effective_quantity FROM rework_work_report_quantity_revisions revision WHERE revision.work_report_id=report.work_report_id AND revision.corrected_at <= $2::timestamptz ORDER BY revision.revision_version DESC LIMIT 1),report.actual_quantity),report.completed_at,report.remark,CASE WHEN EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id AND rejection.rejected_at <= $2::timestamptz) THEN '已驳回' ELSE '已提交' END
    FROM rework_work_reports report JOIN rework_process_configuration_items item USING(configuration_item_id) JOIN rework_work_task_members member USING(work_task_id) JOIN business_people person ON person.person_id=member.person_id
    WHERE report.rework_order_id=$1 AND report.created_at <= $2::timestamptz AND (NOT $3::boolean OR (person.app_user_id=$4 AND ((item.execution_kind='worker' AND $5::boolean) OR (item.execution_kind='tail_inspection' AND $6::boolean))) OR ($7::boolean AND member.person_type_snapshot='temporary')) ORDER BY item.position,report.created_at`,[detail.reworkOrderId,selected.at,ownOnly,actor.actorId,actor.actorRoles.includes('worker')&&caps.includes('work:report'),actor.actorRoles.some(role=>['worker','tail_inspector'].includes(role))&&caps.includes('tail_inspection:report'),caps.includes('work:report_for_worker')]);
   const tasks=(await client.query(`SELECT task.work_task_id AS "workTaskId",task.rework_order_id AS "reworkOrderId",task.configuration_item_id AS "configurationItemId",item.process_name AS "processName",item.execution_kind AS "executionKind",item.pricing_unit AS "pricingUnit",item.planned_quantity::float8 AS "plannedQuantity",NULL::float8 AS "unitPrice",task.assignment_mode AS "mode",task.task_version AS "version",'active' AS "status",false AS "canSubmitReport",
    (SELECT json_agg(json_build_object('personId',member.person_id,'displayName',member.display_name_snapshot,'personType',member.person_type_snapshot) ORDER BY member.person_id) FROM rework_work_task_members member WHERE member.work_task_id=task.work_task_id) members,
    COALESCE((SELECT sum(report.actual_quantity)::float8 FROM rework_work_reports report WHERE report.work_task_id=task.work_task_id AND report.created_at <= $2::timestamptz AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id AND rejection.rejected_at <= $2::timestamptz)),0) AS "submittedQuantity"
    FROM rework_work_tasks task JOIN rework_process_configuration_items item USING(configuration_item_id)
    WHERE task.rework_order_id=$1 AND task.created_at <= $2::timestamptz AND (task.superseded_at IS NULL OR task.superseded_at > $2::timestamptz)
    AND (NOT $3::boolean OR EXISTS(SELECT 1 FROM rework_work_task_members member JOIN business_people person USING(person_id) WHERE member.work_task_id=task.work_task_id AND ((person.app_user_id=$4 AND ((item.execution_kind='worker' AND $5::boolean) OR (item.execution_kind='tail_inspection' AND $6::boolean))) OR ($7::boolean AND member.person_type_snapshot='temporary')))) ORDER BY item.position,task.created_at`,[detail.reworkOrderId,selected.at,ownOnly,actor.actorId,actor.actorRoles.includes('worker')&&caps.includes('work:report'),actor.actorRoles.some(role=>['worker','tail_inspector'].includes(role))&&caps.includes('tail_inspection:report'),caps.includes('work:report_for_worker')])).rows;
   page.workTasks=ReworkWorkTasksResponseSchema.parse({reworkOrderId:detail.reworkOrderId,reworkStatus:'in_progress',specialProcessType:source.specialProcessType,otherCraftDescription:source.otherCraftDescription,orderVersion:Number(selected.after.version??selected.after.orderVersion??latest('version')),tasks:tasks.map(task=>({...task,remainingQuantity:task.submittedQuantity>0?0:task.plannedQuantity}))});
   // Reporting rows retain the viewer's own/authorized temporary-worker scope.
   if (ownOnly) notices.push('按原有权限显示本人及获授权代报的临时工明细。');
  }
  if (['whole_order_review','final_quantity_ie_review','quantity_adjustment'].includes(node)) {
   const confirmationId=selected.after.confirmationId ?? selected.after.completionConfirmationId ?? latest('confirmationId') ?? latest('completionConfirmationId');
   await querySection('最终数量与价格',['工序','工人报数','整查报数','确认数量','原单价','复核单价'],`SELECT item.process_name,quantity.worker_reported_quantity,quantity.tail_reported_quantity,quantity.final_confirmed_quantity,price.original_unit_price,price.proposed_unit_price FROM rework_tail_completion_quantities quantity JOIN rework_tail_completion_confirmations confirmation USING(confirmation_id) JOIN rework_process_configuration_items item USING(configuration_item_id) LEFT JOIN rework_tail_completion_prices price USING(confirmation_id,configuration_item_id) WHERE confirmation.rework_order_id=$1 AND confirmation.confirmation_id=$2 ORDER BY item.position`,[detail.reworkOrderId,confirmationId??null]);
   await querySection('临时工实发系数',['工序','工人','系数','原因'],`SELECT item.process_name,person.display_name,coefficient.multiplier,coefficient.reason FROM rework_tail_completion_coefficients coefficient JOIN rework_tail_completion_confirmations confirmation USING(confirmation_id) JOIN rework_process_configuration_items item USING(configuration_item_id) JOIN business_people person USING(person_id) WHERE confirmation.rework_order_id=$1 AND confirmation.confirmation_id=$2 ORDER BY item.position,person.display_name`,[detail.reworkOrderId,confirmationId??null]);
   if (!sections[0]?.rows.length && selected.after.orderReviewId) await querySection('整单确认快照',['工序','工人原报数','工人有效数','整查原报数','整查有效数'],`SELECT process->>'processName',process->>'workerOriginalQuantity',process->>'workerEffectiveQuantity',process->>'tailOriginalQuantity',process->>'tailEffectiveQuantity' FROM rework_order_reviews review CROSS JOIN LATERAL jsonb_array_elements(COALESCE(review.review_snapshot->'processes','[]'::jsonb)) process WHERE review.rework_order_id=$1 AND review.order_review_id=$2`,[detail.reworkOrderId,selected.after.orderReviewId]);
   fields.push({label:'审核决定',value:value(selected.after.decision)},{label:'审核意见',value:selected.reason});
   if(node==='quantity_adjustment') add('数量调整',['工序','原计划数量','申请数量','实裁数量','实际回货','确认上限'],[[processName(selected.after.configurationItemId),selected.after.plannedQuantity,selected.after.requestedPlannedQuantity,selected.after.actualCutQuantity,selected.after.actualReturnQuantity,selected.after.confirmedMaximumQuantity]]);
  }
  if (['responsibility','owner_signature'].includes(node)) {
   const determination = (await client.query<{id:string;version:number;reason:string|null}>(node==='owner_signature'
    ? `SELECT determination.determination_id id,determination.determination_version version,determination.reason FROM rework_responsibility_owner_signatures signature JOIN rework_responsibility_determinations determination USING(determination_id) WHERE signature.rework_order_id=$1 AND signature.operation_event_id=$2`
    : `SELECT determination_id id,determination_version version,reason FROM rework_responsibility_determinations WHERE rework_order_id=$1 AND created_at <= $2::timestamptz ORDER BY determination_version DESC LIMIT 1`,[detail.reworkOrderId,node==='owner_signature'?selected.id:selected.at])).rows[0];
   if(determination) page.responsibility=await readHistoricalResponsibility(client,detail.reworkOrderId,selected.at,determination.id,Number(selected.after.version??selected.after.orderVersion),source);
   fields.push({label:'责任版本',value:value(determination?.version)},{label:'判定说明',value:determination?.reason??null});
   await querySection('逐工序责任分摊',['工序','责任方','供应商','基础金额','倍率','分摊比例（万分比）','责任金额'],`SELECT process.process_name_snapshot,allocation.responsibility_type,allocation.supplier_name_snapshot,process.base_amount,COALESCE(allocation.multiplier,process.multiplier),allocation.share_bps,allocation.rounded_amount FROM rework_responsibility_processes process JOIN rework_responsibility_allocations allocation USING(determination_id,configuration_item_id) WHERE process.determination_id=$1 ORDER BY process.process_name_snapshot,allocation.responsibility_type`,[determination?.id??null]);
   await querySection('工人责任明细',['工序','工人','责任方','工资基础','倍率','责任金额'],`SELECT process.process_name_snapshot,COALESCE(person.display_name,line.worker_display_name_snapshot),line.responsibility_type,line.base_member_share_amount,line.multiplier,line.rounded_amount FROM rework_responsibility_amount_lines line JOIN rework_responsibility_processes process USING(determination_id,configuration_item_id) LEFT JOIN business_people person ON person.person_id=line.person_id WHERE line.determination_id=$1 ORDER BY process.process_name_snapshot,line.worker_display_name_snapshot`,[determination?.id??null]);
   if(node==='owner_signature') fields.push({label:'签字结果',value:selected.action.endsWith('owner_approve')?'同意':'驳回'},{label:'签字意见',value:selected.reason});
  }
  if (sections.some(section=>section.rows.length===0)) notices.push('部分早期节点未留存对应明细快照；空白处未使用当前数据补齐。');
  const ids=latest('attachmentIds');
  const permitted=new Set(detail.attachments.map(item=>item.attachmentId));
  const attachments=Array.isArray(ids)?detail.attachments.filter(item=>ids.includes(item.attachmentId)&&permitted.has(item.attachmentId)).map(({attachmentId,filename,mimeType})=>({attachmentId,filename,mimeType})):[];
  if(!Array.isArray(ids)) notices.push('该历史版本未记录图片清单，当前图片不会混入。');
  const report=InspectionReportDraftSchema.safeParse(source.inspectionReport);
  await client.query('COMMIT');
  const entry=(event:HistoryEvent)=>({id:event.id,label:labels[node],at:event.at,actor:event.actor});
  return ReworkNodeHistorySchema.parse({orderId:detail.reworkOrderId,navigation:(Object.keys(labels) as FinanceNodeKey[]).map(key=>({node:key,completed:events.some(event=>reworkHistoryNode(event.action)===key),available:canReadReworkHistoryNode(actor,key)&&events.some(event=>reworkHistoryNode(event.action)===key)})),page,node,entry:entry(selected),versions:versions.map(entry),fields,sections,attachments,notices,inspectionReport:report.success?report.data:null});
 } catch(error) {await client.query('ROLLBACK').catch(()=>undefined);throw error;} finally {client.release();}
}
