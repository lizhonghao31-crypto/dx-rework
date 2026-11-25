import {appendSelectedTodo,type TodoSelectionKey,type TodoProjection} from '../todos/selection.js';
import {todoContentToken} from '../todos/content-reads.js';
import type {Pool,PoolClient} from "pg";
import type {TodoResponse} from "@dx-rework/contracts";
import type {TrustedActorContext} from "../tools/repositories.js";
import {isRootActor} from "../access/business-authority.js";
import {DigitalProductionAccessPolicy} from "./access-policy.js";
type DB=Pick<Pool|PoolClient,"query">;
export async function fabricCases(db:DB,sourceId:string){
 const rows=(await db.query(`SELECT f.fact_id AS "reportId",f.payload,f.recorded_at AS "reportedAt",u.display_name AS "reportedBy",
  d.fact_id AS "decisionId",d.payload AS decision,d.recorded_at AS "decidedAt",du.display_name AS "decidedBy"
  FROM digital_development_execution_facts f JOIN app_users u ON u.id=f.actor_id
  LEFT JOIN LATERAL(SELECT * FROM digital_development_execution_facts x WHERE x.source_id=f.source_id AND x.kind='面料决定'
  AND x.payload->>'reportId'=f.fact_id::text ORDER BY x.sequence DESC LIMIT 1)d ON true
  LEFT JOIN app_users du ON du.id=d.actor_id
  WHERE f.source_id=$1 AND f.kind='面料报告' AND f.payload->>'recommendation'='建议停用' ORDER BY f.sequence`,[sourceId])).rows;
 const people=(await db.query(`SELECT DISTINCT u.id,u.display_name AS name FROM app_users u JOIN user_role_assignments r ON r.user_id=u.id
 WHERE u.enabled AND r.role_code IN ('production_management','owner_group') AND r.revoked_at IS NULL ORDER BY u.id`)).rows;
 const responsible:Array<{id:string;name:string}>=[];
 for(const person of people)if(await new DigitalProductionAccessPolicy(db).activeRole(person.id,"production_management")||await new DigitalProductionAccessPolicy(db).activeRole(person.id,"owner_group"))responsible.push(person);
 return rows.map(row=>({...row,responsible,status:row.decision?.decision??"等待决定",scope:row.payload.scope??null}));
}
export async function fabricDecisionTodos(db:DB,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 let allowed=isRootActor(actor);for(const role of ["production_management","owner_group"])if(actor.actorRoles.includes(role)&&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,role))allowed=true;
 if(!allowed)return [];
 if(!(await db.query("SELECT to_regclass('digital_development_material_verifications') AS relation")).rows[0]?.relation)return [];
 const sources=(await db.query(`SELECT s.source_id,s.design_style_no,coalesce((SELECT max(r.round_number) FROM digital_development_rounds r WHERE r.source_id=s.source_id),1) AS round_number FROM digital_production_sources s JOIN digital_development_documents d USING(source_id)
 LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind='source' AND l.resource_id=s.source_id
 WHERE d.status='published' AND coalesce(l.state,'active')='active'
 AND EXISTS(SELECT 1 FROM digital_development_execution_facts f WHERE f.source_id=s.source_id AND f.kind='面料报告' AND ($1::uuid IS NULL OR f.fact_id=$1))`,[projection?.todoId??null])).rows;
 const result:TodoResponse[]=[];
 for(const source of sources){
  if(!await new DigitalProductionAccessPolicy(db).allowed(actor,"source",source.source_id,"technical"))continue;
  const task=(await db.query(`SELECT t.task_id,t.route_version FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   WHERE a.source_id=$1 AND t.state IN ('ready','pending','blocked')
   ORDER BY t.route_version DESC,(a.task_kind IN ('development_materials','development_material_recheck')) DESC,t.created_at DESC LIMIT 1`,[source.source_id])).rows[0];
  for(const report of await fabricCases(db,source.source_id)){
   if(report.decisionId)continue;
   const at=new Date(report.reportedAt).toISOString(),id=report.reportId;
   const selectionKey:TodoSelectionKey={contentToken:todoContentToken(['fabric',id,source.round_number]),todoId:id,taskTitle:"决定问题面料是否使用",todoType:"business_action",category:"digital_fabric_decision",sourceAction:"development_fabric_report",recipientUserId:actor.actorId,route:{routeName:task?"digital_production_task":"digital_development",entityId:task?.task_id??source.source_id,todoId:id,developmentRound:source.round_number},dueAt:null,status:"pending",orderContext:{reworkNo:null,orderNo:null,styleNo:source.design_style_no,supplierName:null,status:"问题面料等待明确决定",updatedAt:at},unread:true,createdAt:at};
  appendSelectedTodo(result,projection,selectionKey,()=>({...selectionKey,sourceEventId:id,entityType:task?"digital_task":"digital_development",entityId:task?.task_id??source.source_id,requiredRole:actor.actorRoles.includes("owner_group")?"owner_group":"production_management",requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:null,version:1,updatedAt:at}),{sourceId:source.source_id,orderId:null});
  }
 }
 return result;
}
