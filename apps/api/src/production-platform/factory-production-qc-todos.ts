import type {Pool,PoolClient} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,isDigitalLeader} from './access-policy.js';
import {factoryProductionFacts} from './factory-production-facts.js';
import {todoContentToken} from '../todos/content-reads.js';
/** A changed factory allocation creates current work, not a mutation of completed history. */
export async function factoryProductionQcTodos(db:Pick<Pool|PoolClient,'query'>,actor:TrustedActorContext):Promise<TodoResponse[]>{
 const policy=new DigitalProductionAccessPolicy(db),result:TodoResponse[]=[];
 const rows=(await db.query(`SELECT t.task_id,t.created_at,a.assignee_id,o.production_order_id,o.design_style_no FROM digital_production_tasks t
 JOIN digital_production_task_access a USING(task_id) JOIN digital_production_orders o USING(production_order_id)
 LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind='order' AND l.resource_id=o.production_order_id
 LEFT JOIN digital_production_resource_lifecycle sl ON sl.resource_kind='source' AND sl.resource_id=o.source_id
 WHERE a.task_kind='factory_production_qc' AND t.state='completed' AND coalesce(l.state,'active')='active' AND coalesce(sl.state,'active')='active'
 AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id)`)).rows;
 for(const row of rows){
  const missing=!row.assignee_id||!await policy.activeRole(row.assignee_id,'quality_control');
  if(missing ? !isDigitalLeader(actor)||!await policy.allowed(actor,'task',row.task_id,'technical') : row.assignee_id!==actor.actorId||!await policy.allowed(actor,'task',row.task_id,'execute'))continue;
  const current=await factoryProductionFacts(db,row.production_order_id);if(current.complete||!current.checks.length)continue;
  const pending=current.checks.filter(c=>!c.inspected),at=new Date(row.created_at).toISOString();
  result.push({todoId:row.task_id,contentToken:todoContentToken(['factory-qc-scope',...pending.map(c=>`${c.factoryDecisionId??'original'}:${c.lineId}:${c.quantity}`)]),taskTitle:'工厂范围变更后补做QC检查',todoType:missing?'recipient_routing_exception':'business_action',category:missing?'digital_assignment':'digital_task',sourceEventId:row.task_id,sourceAction:'factory_scope_changed',entityType:'digital_task',entityId:row.task_id,recipientUserId:actor.actorId,requiredRole:'quality_control',requiredCapability:null,route:{routeName:'digital_production_task',entityId:row.task_id,todoId:row.task_id},policyKey:null,dueAt:null,reminderCount:0,status:missing?'blocked_recipient':'pending',blockedReason:missing?'QC主办缺失或已失效，请重新分配':null,orderContext:{reworkNo:null,orderNo:null,styleNo:row.design_style_no,supplierName:null,status:`${pending.length}项当前工厂范围尚未检查`,updatedAt:at},unread:true,version:1,createdAt:at,updatedAt:at});
 }
 return result;
}
