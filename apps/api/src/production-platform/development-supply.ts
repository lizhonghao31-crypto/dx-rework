import {createHash,randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import type {DevelopmentDocument} from "@dx-rework/contracts/digital-development";
import type {DevelopmentCheck} from "@dx-rework/contracts/digital-development-execution";
import {developmentReturnNeed,type DevelopmentReturnIssue} from "@dx-rework/contracts/digital-development-amendments";
import type {TrustedActorContext} from "../tools/repositories.js";
import {ApplicationError} from "../platform/errors.js";
import {DigitalProductionAccessPolicy} from "./access-policy.js";
import {DigitalProductionTaskService} from "./task-service.js";
import {developmentDocumentRow} from "./development-round-repository.js";
import {materialReadiness} from "./development-material-readiness.js";
import {developmentAmendmentsAvailable} from "./development-amendment-repository.js";
const fail=(message:string):never=>{throw new ApplicationError("DEVELOPMENT_SUPPLY_CONFLICT",message,409);};
export function validateDevelopmentReturn(document:DevelopmentDocument,input:DevelopmentCheck){
 const issues=input.returnIssues??[];
 if(input.result==="通过"){if(issues.length)fail("仍有退回问题，请先核实并清除已解决的问题后提交通过");return;}
 if(!issues.length)fail("请指出具体材料 / 资料区域、问题字段和原因，再退回设计师补正 / 补料");
 for(const issue of issues){
  if(!issue.materialId)continue;
  if(!document.materials.some(m=>m.materialId===issue.materialId))fail("退回的问题材料不属于本轮资料，请重新读取核料页");
  const check=input.items.find(m=>m.materialId===issue.materialId);
  if(developmentReturnNeed(issue)==="supply"&&!check)fail("本轮不使用或尚未确认使用的材料无需直接补实物，请核对本轮使用情况；资料错误请选择资料补正");
  if(["physical","quantity","color","specification"].includes(issue.field)&&check?.[issue.field as "physical"|"quantity"|"color"|"specification"]===true)fail("退回问题与同一项“已到 / 相符”勾选矛盾，请核实该项，或选择实际存在的其他资料问题");
 }
}
export async function recordDevelopmentReturn(db:PoolClient,actor:TrustedActorContext,sourceId:string,supplyTaskId:string,checkTaskId:string,documentVersion:number,input:DevelopmentCheck){
 await db.query("INSERT INTO digital_development_execution_facts(fact_id,source_id,task_id,kind,payload,actor_id) VALUES($1,$2,$3,'补料复核',$4,$5)",[randomUUID(),sourceId,supplyTaskId,JSON.stringify({returnRequirements:{checkTaskId,documentVersion,issues:input.returnIssues??[],note:input.note||(input.returnIssues??[]).map(issue=>issue.reason).join("；")}}),actor.actorId]);
}
export async function developmentSupplyRequirements(db:Pick<Pool|PoolClient,"query">,sourceId:string,taskId:string):Promise<{checkTaskId:string;documentVersion:number;issues:DevelopmentReturnIssue[];note:string;returnedAt?:string}|null>{
 const row=(await db.query("SELECT recorded_at::text AS returned_at,payload->'returnRequirements' AS requirements FROM digital_development_execution_facts WHERE source_id=$1 AND task_id=$2 AND kind='补料复核' AND payload ? 'returnRequirements' ORDER BY sequence DESC LIMIT 1",[sourceId,taskId])).rows[0];
 return row?{...row.requirements,returnedAt:row.returned_at}:null;
}
/** Caller holds the existing lifecycle lock and command transaction. */
export async function submitDevelopmentSupply(db:PoolClient,pool:Pool,actor:TrustedActorContext,sourceId:string,taskId:string,key:string){
 const policy=new DigitalProductionAccessPolicy(db);await policy.assert(actor,"task",taskId,"execute");
 const task=(await db.query("SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.task_id=$2",[sourceId,taskId])).rows[0];
 const sheet=await developmentDocumentRow(db,sourceId);
 if(!task||task.task_kind!=="development_material_supply"||task.state!=="ready"||task.route_version!==(sheet?.round_number??1))fail("请从我的待办打开当前轮有效的补正 / 补料事项，旧任务不能重复提交");
 const requirements=await developmentSupplyRequirements(db,sourceId,taskId),readiness=await materialReadiness(db,sourceId,task.route_version);
 if(await developmentAmendmentsAvailable(db)){
  const amendment=(await db.query("SELECT 1 FROM digital_development_amendments WHERE source_id=$1 AND task_id=$2",[sourceId,taskId])).rowCount;
  const draft=(await db.query("SELECT 1 FROM digital_development_amendment_drafts WHERE source_id=$1 AND task_id=$2",[sourceId,taskId])).rowCount;
  if(draft||requirements?.issues.some(issue=>developmentReturnNeed(issue)==="document")&&!amendment)fail("本次包含资料补正，请打开本任务“补改资料”，保存并提交补正草稿；仅登记到货不能完成资料补正");
 }
 const missing=requirements?readiness.materials.filter(m=>requirements.issues.some(issue=>issue.materialId===m.materialId&&developmentReturnNeed(issue)==="supply"&&issue.field==="physical")&&!m.supplyAvailable):[...readiness.supplyMissing];
 if(requirements)for(const issue of requirements.issues.filter(issue=>developmentReturnNeed(issue)==="supply"&&issue.field!=="physical")){
  const replacement=(await db.query("SELECT 1 FROM digital_development_material_events WHERE source_id=$1 AND material_id=$2 AND route_version=$3 AND action IN ('到货','确认代用') AND created_at>$4::timestamptz",[sourceId,issue.materialId,task.route_version,requirements.returnedAt])).rowCount;
  const material=readiness.materials.find(m=>m.materialId===issue.materialId);if(!replacement&&material&&!missing.includes(material))missing.push(material);
 }
 if(missing.length)fail(`实物尚未补齐：${missing.map(m=>m.name).join("、")}。请原设计师在本单“物料记录”登记到货，再提交文员复核`);
 const clerk=(await db.query(`SELECT a.assignee_id FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
  WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind IN ('development_materials','development_material_recheck')
  ORDER BY (t.task_id=$3::uuid) DESC,t.created_at DESC LIMIT 1`,[sourceId,task.route_version,requirements?.checkTaskId??null])).rows[0]?.assignee_id;
 const occurrence=Number((await db.query("SELECT GREATEST(COALESCE(max(t.occurrence),0)+1,$2::integer) AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_material_recheck'",[sourceId,task.occurrence+1])).rows[0].n);
 const tasks=new DigitalProductionTaskService(pool),next=await tasks.createWithClient(db,actor,{resource:{kind:"source",id:sourceId},authorizingTaskId:taskId,kind:"development_material_recheck",routeId:task.route_instance_id,routeVersion:task.route_version,occurrence,assigneeId:clerk&&await policy.activeRole(clerk,"development_clerk")?clerk:null});
 if((await db.query("SELECT 1 FROM digital_development_execution_facts WHERE source_id=$1 AND task_id=$2 AND kind='补料复核' AND payload->>'supplemental'='true'",[sourceId,taskId])).rowCount)await db.query("INSERT INTO digital_development_execution_facts(fact_id,source_id,task_id,kind,payload,actor_id) VALUES($1,$2,$3,'补料复核',$4,$5)",[randomUUID(),sourceId,next.taskId,JSON.stringify({supplemental:true,note:"补充核验本轮材料",priorTaskId:taskId}),actor.actorId]);
 await db.query("INSERT INTO digital_development_execution_facts(fact_id,source_id,task_id,kind,payload,actor_id) VALUES($1,$2,$3,'补料复核',$4,$5)",[randomUUID(),sourceId,taskId,JSON.stringify({nextTaskId:next.taskId,documentVersion:sheet?.version}),actor.actorId]);
 await tasks.setConditionWithClient(db,actor,taskId,"business_recorded",true,undefined);await tasks.completeWithClient(db,actor,taskId,{note:"补正 / 补料后提交文员复核"},`resubmit:${createHash("sha256").update(JSON.stringify([sourceId,taskId,key])).digest("hex")}`);return next;
}
