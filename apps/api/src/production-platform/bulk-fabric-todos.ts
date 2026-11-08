import {appendSelectedTodo,type TodoSelectionKey,type TodoProjection} from '../todos/selection.js';
import type {Pool,PoolClient} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {todoContentToken} from '../todos/content-reads.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {bulkFabricFacts} from './bulk-fabric-facts.js';
/** One current report -> one derived todo. Reads do not create persistent duplicates. */
export async function bulkFabricDecisionTodos(db:Pick<Pool|PoolClient,'query'>,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 const policy=new DigitalProductionAccessPolicy(db);
 const role=isRootActor(actor)?'root_superuser':actor.actorRoles.includes('owner_group')&&await policy.activeRole(actor.actorId,'owner_group')?'owner_group':actor.actorRoles.includes('production_management')&&await policy.activeRole(actor.actorId,'production_management')?'production_management':null;
 if(!role||!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return [];
 const orders=(await db.query(`SELECT o.production_order_id,o.design_style_no FROM digital_production_orders o
   LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind='order' AND l.resource_id=o.production_order_id
   LEFT JOIN digital_production_resource_lifecycle sl ON sl.resource_kind='source' AND sl.resource_id=o.source_id
   WHERE coalesce(l.state,'active')='active' AND coalesce(sl.state,'active')='active'
   AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id)
   AND EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.resource_kind='order' AND e.resource_id=o.production_order_id AND e.event_kind='bulk_fabric_report' AND ($1::uuid IS NULL OR e.event_id=$1))`,[projection?.todoId??null])).rows;
 const result:TodoResponse[]=[];
 for(const order of orders){
  if(!await policy.allowed(actor,'order',order.production_order_id,'technical'))continue;
  const state=await bulkFabricFacts(db,order.production_order_id);
  if(state.report?.result!=='不合格'||state.decision)continue;
  const id=state.report.reportId,at=(await db.query('SELECT recorded_at FROM digital_production_task_events WHERE event_id=$1',[id])).rows[0].recorded_at.toISOString();
  const selectionKey:TodoSelectionKey={todoId:id,contentToken:todoContentToken(['bulk-fabric',id]),taskTitle:'决定验布不合格面料是否使用',todoType:'business_action',category:'digital_bulk_fabric_decision',sourceAction:'bulk_fabric_report',recipientUserId:actor.actorId,route:{routeName:'digital_bulk_preparation',entityId:order.production_order_id,todoId:id},dueAt:null,status:'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:order.design_style_no,supplierName:null,status:'验布不合格，等待质量决定',updatedAt:at},unread:true,createdAt:at};
  appendSelectedTodo(result,projection,selectionKey,()=>({...selectionKey,sourceEventId:id,entityType:'digital_production',entityId:order.production_order_id,requiredRole:role,requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:null,version:1,updatedAt:at}));
 }
 return result;
}
