import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {DigitalNotification} from '@dx-rework/contracts/digital-production-notifications';
import type {TrustedActorContext} from '../tools/repositories.js';
import {appendSelectedTodo,type TodoProjection,type TodoSelectionKey} from '../todos/selection.js';
import {todoContentToken} from '../todos/content-reads.js';
import {acceptanceIncludesNative,businessNow} from '../acceptance-clock/business-time.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import type {AssembledQuotation} from './quotation-assembly.js';
type DB=Pick<Pool|PoolClient,'query'>;
const key=(q:AssembledQuotation,id:string)=>`special-craft-quote:${q.quote_id}:${id}:${q.assembly!.rows[id]!.assignmentVersion??q.version}`;
/** Original quotation assignment is the actual bulk craft owner. No synthetic
 * processing completion, financial approval, or external message is created. */
export async function notifySpecialCraftQuotes(db:DB,q:AssembledQuotation){
 if(!q.production_order_id||!q.assembly)return;
 for(const row of q.document.rows){
  const ref=q.assembly.rows[row.rowId],assignment=q.assignments.find(a=>a.rowId===row.rowId);
  if(ref?.stage!=='bulk'||!ref.craftRef||row.unitPrice!==''||!assignment?.priceAssigneeId)continue;
  if(!await new DigitalProductionAccessPolicy(db).activeRole(assignment.priceAssigneeId,'pattern_room_worker'))continue;
  const sourceKey=key(q,row.rowId),eventId=randomUUID();
  const event=(await db.query(`INSERT INTO digital_production_notification_events(event_id,source_key,todo_id,event_kind,created_at) VALUES($1,$2,$3,'special_craft_quotation',$4) ON CONFLICT(source_key) DO NOTHING RETURNING event_id`,[eventId,sourceKey,row.rowId,businessNow().toISOString()])).rows[0];
  if(event)await db.query('INSERT INTO digital_production_notification_receipts(event_id,recipient_id,source_event_id) VALUES($1,$2,$1)',[event.event_id,assignment.priceAssigneeId]);
 }
}
export async function specialCraftQuotationTodos(db:DB,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 if(!actor.actorRoles.includes('pattern_room_worker')||!await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'pattern_room_worker'))return [];
 if(!(await db.query("SELECT to_regclass('digital_quotation_documents') AS relation")).rows[0]?.relation)return [];
 const quotes=(await db.query(`SELECT q.*,o.design_style_no FROM digital_quotation_documents q JOIN digital_production_orders o USING(production_order_id)
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(q.assignments) a WHERE a->>'priceAssigneeId'=$1 AND a->>'priceRole'='pattern_room_worker')
  AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle l WHERE l.state<>'active' AND (l.resource_kind='order' AND l.resource_id=q.production_order_id OR l.resource_kind='source' AND l.resource_id=q.source_id))
  AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=q.production_order_id)`,[actor.actorId])).rows as Array<AssembledQuotation&{design_style_no:string;updated_at:Date}>;
 const result:TodoResponse[]=[];
 for(const q of quotes){
  if(!q.assembly||!await acceptanceIncludesNative(db,q.production_order_id!))continue;
  for(const row of q.document.rows){
   const ref=q.assembly.rows[row.rowId],assignment=q.assignments.find(a=>a.rowId===row.rowId);
   if(ref?.stage!=='bulk'||!ref.craftRef||row.unitPrice!==''||assignment?.priceAssigneeId!==actor.actorId||assignment.priceRole!=='pattern_room_worker'||projection?.todoId&&projection.todoId!==row.rowId)continue;
   const at=new Date(q.updated_at).toISOString(),selection:TodoSelectionKey={todoId:row.rowId,contentToken:todoContentToken([key(q,row.rowId)]),taskTitle:`大货${row.name}报价`,todoType:'business_action',category:'digital_special_craft_quotation',sourceAction:'special_craft_quotation',recipientUserId:actor.actorId,route:{routeName:'digital_order_quotation',entityId:q.production_order_id!,todoId:row.rowId},dueAt:null,status:'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:q.design_style_no,supplierName:null,status:'待填写本工艺单价',updatedAt:at},unread:true,createdAt:at};
   appendSelectedTodo(result,projection,selection,()=>({...selection,sourceEventId:row.rowId,entityType:'customer_quotation',entityId:q.quote_id,requiredRole:'pattern_room_worker',requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:null,version:q.version,updatedAt:at}));
  }
 }
 return result;
}
export async function specialCraftQuotationNotification(db:DB,actor:TrustedActorContext,event:{event_id:string;todo_id:string|null;source_key?:string;created_at:Date|string}):Promise<DigitalNotification|null>{
 if(!event.todo_id)return null;
 const todo=(await specialCraftQuotationTodos(db,actor,{todoId:event.todo_id}))[0];
 if(!todo||todo.contentToken!==todoContentToken([event.source_key]))return null;
 return {eventId:event.event_id,title:todo.taskTitle!,actionable:true,route:todo.route,createdAt:new Date(event.created_at).toISOString()};
}
