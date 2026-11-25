import {appendSelectedTodoAsync,type TodoSelectionKey,type TodoProjection} from '../todos/selection.js';
import {todoSlaTiming} from "../todos/sla-presentation.js";
import {ContextBusinessClock} from "../acceptance-clock/business-time.js";
import type {BusinessClock} from "@dx-rework/domain/business-clock";
import {calculateSlaPlan,slaAnchorTime} from "@dx-rework/domain/digital-sla-plan";
import {SlaPlanRepository} from "./sla-plan-repository.js";
import type {Pool,PoolClient} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,isDigitalLeader} from './access-policy.js';
import {factoryProductionFactsForOrders} from './factory-production-facts.js';
import {todoContentToken} from '../todos/content-reads.js';
/** A changed factory allocation creates current work, not a mutation of completed history. */
export async function factoryProductionQcTodos(db:Pick<Pool|PoolClient,'query'>,actor:TrustedActorContext,clock:BusinessClock=new ContextBusinessClock(db as Pool),projection?:TodoProjection):Promise<TodoResponse[]>{
 const policy=new DigitalProductionAccessPolicy(db),result:TodoResponse[]=[];
 const rows=(await db.query(`SELECT t.task_id,t.created_at,a.assignee_id,o.production_order_id,o.design_style_no FROM digital_production_tasks t
 JOIN digital_production_task_access a USING(task_id) JOIN digital_production_orders o USING(production_order_id)
 LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind='order' AND l.resource_id=o.production_order_id
 LEFT JOIN digital_production_resource_lifecycle sl ON sl.resource_kind='source' AND sl.resource_id=o.source_id
 WHERE ($1::uuid IS NULL OR t.task_id=$1) AND a.task_kind='factory_production_qc' AND t.state='completed' AND coalesce(l.state,'active')='active' AND coalesce(sl.state,'active')='active'
 AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id)`,[projection?.todoId??null])).rows;
 const allowed=[];
 for(const row of rows){
  const missing=!row.assignee_id||!await policy.activeRole(row.assignee_id,'quality_control');
  if(missing ? !isDigitalLeader(actor)||!await policy.allowed(actor,'task',row.task_id,'technical') : row.assignee_id!==actor.actorId||!await policy.allowed(actor,'task',row.task_id,'execute'))continue;
  allowed.push({row,missing});
 }
 const facts=await factoryProductionFactsForOrders(db,allowed.map(({row})=>row.production_order_id));
 const actionable=allowed.flatMap(entry=>{const current=facts.get(entry.row.production_order_id);return current&&!current.complete&&current.checks.length?[{...entry,pending:current.checks.filter(c=>!c.inspected)}]:[];});
 const orderIds=[...new Set<string>(actionable.map(({row})=>row.production_order_id))];
 const plans=await new SlaPlanRepository(db).latestPlans(orderIds);
 const targetsByOrder=new Map([...plans].map(([id,plan])=>[id,new Map(calculateSlaPlan(plan.plan).map(node=>[node.id,node.end]))]));
 for(const {row,missing,pending} of actionable){
  const at=new Date(row.created_at).toISOString(),plan=plans.get(row.production_order_id),planned=targetsByOrder.get(row.production_order_id);
  const targets=pending.map(c=>planned?planned.get(`factory_production:${c.lineId}`)??{at:null,exclusive:true,reasons:[]}:slaAnchorTime(c.targetDate?{precision:'date',value:c.targetDate,source:'native-factory-scope'}:undefined,'factory_delivery_date'));
  const earliest=targets.filter(t=>t.at).sort((a,b)=>a.at!.localeCompare(b.at!))[0],dueAt=earliest?.at??null;
  const selectionKey:TodoSelectionKey={todoId:row.task_id,contentToken:todoContentToken(['factory-qc-scope',...pending.map(c=>`${c.factoryDecisionId??'original'}:${c.lineId}:${c.quantity}`)]),taskTitle:'工厂范围变更后补做QC检查',todoType:missing?'recipient_routing_exception':'business_action',category:missing?'digital_assignment':'digital_task',sourceAction:'factory_scope_changed',recipientUserId:actor.actorId,route:{routeName:'digital_production_task',entityId:row.task_id,todoId:row.task_id},dueAt,status:missing?'blocked_recipient':'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:row.design_style_no,supplierName:null,status:`${pending.length}项当前工厂范围尚未检查`,updatedAt:at},unread:true,createdAt:at};
  await appendSelectedTodoAsync(result,projection,selectionKey,async()=>{
   const time=await clock.read({kind:'order',id:row.production_order_id});
   if(plan&&plan.time.scenarioId!==time.scenarioId)throw new Error('SLA clock scope mismatch');
   const timing=todoSlaTiming({dueAt,warningAt:null,enteredAt:null,exclusive:earliest?.exclusive??true,asOf:time.now});
   if(targets.some(t=>!t.at))timing.reason='部分PO没有可信工厂目标，已知日期仍监督；进入原工厂记录核对';
   return {...selectionKey,sourceEventId:row.task_id,entityType:'digital_task',entityId:row.task_id,requiredRole:'quality_control',requiredCapability:null,policyKey:null,timing,reminderCount:0,blockedReason:missing?'QC主办缺失或已失效，请重新分配':null,version:1,updatedAt:at};},{sourceId:null,orderId:row.production_order_id});
 }
 return result;
}
