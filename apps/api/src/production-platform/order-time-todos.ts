import type {Pool,PoolClient} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {DigitalNotification} from '@dx-rework/contracts/digital-production-notifications';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {appendSelectedTodo,type TodoProjection,type TodoSelectionKey} from '../todos/selection.js';
import {todoContentToken} from '../todos/content-reads.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {acceptanceIncludesNative,acceptanceBusinessContext} from '../acceptance-clock/business-time.js';

type DB=Pick<Pool|PoolClient,'query'>;
async function available(db:DB){return Boolean((await db.query("SELECT to_regclass('digital_order_time_requests') AS relation")).rows[0]?.relation);}
async function manager(db:DB,actor:TrustedActorContext){
 const policy=new DigitalProductionAccessPolicy(db);return isRootActor(actor)||actor.actorRoles.includes('owner_group')&&await policy.activeRole(actor.actorId,'owner_group')||actor.actorRoles.includes('production_management')&&await policy.activeRole(actor.actorId,'production_management');
}
async function inScope(db:DB,actor:TrustedActorContext,row:{source_id:string|null;production_order_id:string|null;designer_id:string;requested_by:string;scenario_id?:string|null}){
 const scope=row.production_order_id?{kind:'order' as const,id:row.production_order_id}:row.source_id?{kind:'source' as const,id:row.source_id}:null;
 if(scope&&(!await acceptanceIncludesNative(db,scope.id)||!await new DigitalProductionAccessPolicy(db).allowed(actor,scope.kind,scope.id,'technical')))return false;
 const context=acceptanceBusinessContext();if(!scope&&context&&row.scenario_id!==context.scenarioId)return false;return true;
}
/** Lightweight complete keys/counts, then only selected-page presentation.
 * No request preflight, task clock or complete Journey is built for a badge. */
export async function orderTimeTodos(database:Pool,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 if(!await available(database))return [];
 const manages=await manager(database,actor),designer=actor.actorRoles.includes('sample_designer')&&await new DigitalProductionAccessPolicy(database).activeRole(actor.actorId,'sample_designer');
 if(!manages&&!designer)return [];
 const rows=(await database.query(`SELECT r.*,coalesce(o.design_style_no,s.design_style_no,r.operation_json#>>'{input,designStyleNo}') AS style,
  e.business_time->>'now' AS business_at,e.business_time->>'scenarioId' AS scenario_id
  FROM digital_order_time_requests r LEFT JOIN digital_production_orders o USING(production_order_id) LEFT JOIN digital_production_sources s ON s.source_id=r.source_id
  JOIN digital_order_time_request_events e ON e.request_id=r.request_id AND e.request_version=r.version
  WHERE (($1::boolean AND r.state='pending') OR ($2::boolean AND r.designer_id=$3 AND r.state IN ('needs_designer','returned')))
   AND ($4::uuid IS NULL OR r.request_id=$4) ORDER BY r.created_at,r.request_id`,[manages,designer,actor.actorId,projection?.todoId??null])).rows;
 const result:TodoResponse[]=[];
 for(const row of rows){
  if(!await inScope(database,actor,row))continue;
  const approval=row.state==='pending',title=approval?'调整本单时效':row.state==='returned'?'核对本单时效申请':'接续本单时效申请',at=row.business_at??new Date(row.created_at).toISOString();
  const key:TodoSelectionKey={todoId:row.request_id,contentToken:todoContentToken(['order-time-request',row.request_id,row.version,row.state]),taskTitle:title,todoType:'business_action',category:approval?'digital_order_time_apply':'digital_order_time_request',sourceAction:'order_time',recipientUserId:actor.actorId,
   route:{routeName:'digital_order_time',entityId:row.request_id,todoId:row.request_id},dueAt:null,status:'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:row.style??null,supplierName:null,status:title,updatedAt:at},unread:true,createdAt:at};
  appendSelectedTodo(result,projection,key,()=>({...key,sourceEventId:row.request_id,entityType:'digital_order_time_request',entityId:row.request_id,requiredRole:null,requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:null,version:row.version,updatedAt:at}));
 }
 return result;
}
export async function orderTimeNotification(db:DB,actor:TrustedActorContext,event:{event_id:string;todo_id:string|null;source_key?:string;created_at:Date|string}):Promise<DigitalNotification|null>{
 if(!event.todo_id)return null;
 const row=(await db.query(`SELECT r.*,coalesce(o.design_style_no,s.design_style_no,r.operation_json#>>'{input,designStyleNo}') AS style,
  e.business_time->>'scenarioId' AS scenario_id FROM digital_order_time_requests r LEFT JOIN digital_production_orders o USING(production_order_id)
  LEFT JOIN digital_production_sources s ON s.source_id=r.source_id JOIN digital_order_time_request_events e ON e.request_id=r.request_id AND e.request_version=r.version WHERE r.request_id=$1`,[event.todo_id])).rows[0];
 if(!row||event.source_key!==`order-time-request:${row.request_id}:${row.version}:${row.state}`||!await inScope(db,actor,row))return null;
 const actionable=row.state==='pending'||row.state==='needs_designer'||row.state==='returned';
 if(row.state==='pending'){if(!await manager(db,actor))return null;}
 else if(actor.actorId!==row.designer_id)return null;
 const title=row.state==='pending'?'有一张订单需要调整时效':row.state==='needs_designer'?'本单工艺有变，请接续时效申请':row.state==='returned'?'本单时效申请已退回':row.state==='withdrawn'?'本单时效申请已撤回':Number(row.result_late_minutes)>0?'本单时效已生效，仍有晚交风险':'本单时效已生效';
 return {eventId:event.event_id,title,actionable,route:{routeName:'digital_order_time',entityId:row.request_id,todoId:row.request_id},createdAt:new Date(event.created_at).toISOString(),
  ...(!actionable?{autoDismissAfterMs:6000 as const}:{}),context:{styleNo:row.style??null,orderId:row.result_order_id??row.production_order_id,colors:[],poNumbers:[]}};
}
