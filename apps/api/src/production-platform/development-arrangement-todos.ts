import {appendSelectedTodo,type TodoSelectionKey,type TodoProjection} from '../todos/selection.js';
import {createHash} from "node:crypto";
import {todoContentToken} from '../todos/content-reads.js';
import type {Pool,PoolClient} from "pg";
import type {TodoResponse,TodoRouteDescriptor} from "@dx-rework/contracts";
import type {TrustedActorContext} from "../tools/repositories.js";
import {arrangementsAvailable,canArrange,readArrangement} from "./development-arrangement.js";
type DB=Pick<Pool|PoolClient,"query">;
export function arrangementTodoId(sourceId:string,round:number){
 const h=createHash("sha256").update(`development-arrangement:${sourceId}:${round}`).digest("hex");
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export async function arrangementTodos(db:DB,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 if(!await arrangementsAvailable(db)||!await canArrange(db,actor))return [];
 const sources=(await db.query(`SELECT s.source_id,s.design_style_no,s.created_at,coalesce((SELECT max(r.round_number) FROM digital_development_rounds r WHERE r.source_id=s.source_id),1) AS round_number FROM digital_production_sources s
 JOIN digital_development_documents d USING(source_id) WHERE d.status='published'
 AND EXISTS(SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
 WHERE a.source_id=s.source_id AND t.state IN ('pending','ready','blocked'))`)).rows;
 const result:TodoResponse[]=[];
 for(const source of sources){
  if(projection?.todoId&&arrangementTodoId(source.source_id,Number(source.round_number))!==projection.todoId)continue;
  const plan=await readArrangement(db,actor,source.source_id);
  if(!plan?.readyToArrange||!plan.rows.some(row=>row.editable&&!row.valid))continue;
  if(plan.managerId&&plan.managerId!==actor.actorId&&!plan.canTakeOver)continue;
  const id=arrangementTodoId(source.source_id,plan.roundNumber),at=new Date(source.created_at).toISOString();
  const check=(await db.query("SELECT f.fact_id FROM digital_development_execution_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id WHERE f.source_id=$1 AND t.route_version=$2 AND f.kind='核配通过' ORDER BY f.sequence DESC LIMIT 1",[source.source_id,plan.roundNumber])).rows[0]?.fact_id??null;
  const contentToken=todoContentToken(['arrangement',id,plan.documentVersion,check,plan.managerId,plan.rows.filter(row=>row.editable&&!row.valid).map(row=>[row.kind,row.assigneeId])]);
  const selectionKey:TodoSelectionKey={contentToken,todoId:id,taskTitle:"安排本轮师傅",todoType:"business_action",category:"digital_assignment",sourceAction:"development_arrangement",recipientUserId:actor.actorId,route:{routeName:"digital_development_arrangement",entityId:source.source_id,todoId:id,developmentRound:plan.roundNumber},dueAt:null,status:"pending",orderContext:{reworkNo:null,orderNo:null,styleNo:source.design_style_no,supplierName:null,status:"尚未安排完整",updatedAt:at},unread:true,createdAt:at};
  appendSelectedTodo(result,projection,selectionKey,()=>({...selectionKey,sourceEventId:id,entityType:"digital_development",entityId:source.source_id,requiredRole:null,requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:null,version:plan.version+1,updatedAt:at}));
 }
 return result;
}
/** Initial linked execution has one digital work stream. Rework remains native. */
export async function hiddenNativeDevelopmentTodo(db:DB,route:TodoRouteDescriptor){
 if(route.routeName!=="pattern_room_order"||!await arrangementsAvailable(db))return false;
 return Boolean((await db.query(`SELECT 1 FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id)
 JOIN pattern_room_rounds r ON r.round_id=o.current_round_id WHERE l.order_id=$1 AND r.round_type='initial'
 AND EXISTS(SELECT 1 FROM digital_production_task_access a WHERE a.source_id=l.source_id)`,[route.entityId])).rowCount);
}
export const nativeDevelopmentTodoExclusion=`NOT EXISTS(SELECT 1 FROM digital_development_pattern_links l
 JOIN pattern_room_orders o USING(order_id) JOIN pattern_room_rounds r ON r.round_id=o.current_round_id
 WHERE todos.entity_type='pattern_room_order' AND todos.entity_id=l.order_id::text AND r.round_type='initial'
 AND EXISTS(SELECT 1 FROM digital_production_task_access a WHERE a.source_id=l.source_id))`;
