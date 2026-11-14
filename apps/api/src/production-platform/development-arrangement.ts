import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {type CraftStepChoice,craftStepLabel} from '@dx-rework/contracts/digital-craft';
import {assembleQuotation} from './quotation-assembly.js';
import {isNativeRootSewingRecipient} from './development-native-recipient.js';
import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {DEVELOPMENT_ARRANGEABLE_KINDS,arrangementEntryKey,type DevelopmentArrangement,type DevelopmentArrangementInput} from "@dx-rework/contracts/development-arrangement";
import type {TrustedActorContext} from "../tools/repositories.js";
import {isRootActor} from "../access/business-authority.js";
import {ApplicationError} from "../platform/errors.js";
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from "./access-policy.js";
import {developmentDocumentRow} from "./development-round-repository.js";
import {savedDevelopmentRoute} from "./development-sla-enrollment.js";
import {developmentSlaPlan} from "./development-sla-enrollment.js";
import {fixedDevelopmentCutter} from "./development-fixed-cutting.js";
import {DIGITAL_TASK_ROLES,type DigitalTaskKind} from "./task-access-repository.js";
import {DigitalProductionTaskService} from "./task-service.js";

type DB=Pick<Pool|PoolClient,"query">;
const conflict=(message:string):never=>{throw new ApplicationError("DEVELOPMENT_ARRANGEMENT_CONFLICT",message,409);};
export const arrangementsAvailable=async(db:DB)=>Boolean((await db.query("SELECT to_regclass('digital_development_round_arrangements') AS relation")).rows[0]?.relation);
export async function canArrange(db:DB,actor:TrustedActorContext){
  if(isRootActor(actor))return true;
  const policy=new DigitalProductionAccessPolicy(db);
  for(const role of ["development_clerk","pattern_room_supervisor","owner_group","production_management"])
    if(actor.actorRoles.includes(role)&&await policy.activeRole(actor.actorId,role))return true;
  return false;
}
export async function plannedRecipient(db:DB,sourceId:string,round:number,kind:string,stepRef?:string):Promise<{planned:boolean;id:string|null}>{
  if(!await arrangementsAvailable(db))return {planned:false,id:null};
  const key=arrangementEntryKey({kind,...(stepRef?{stepRef}:{})});
  const row=(await db.query("SELECT entries FROM digital_development_round_arrangements WHERE source_id=$1 AND round_number=$2",[sourceId,round])).rows[0];
  return {planned:Boolean(row&&Object.hasOwn(row.entries,key)),id:row?.entries[key]??null};
}
export async function readArrangement(db:DB,actor:TrustedActorContext,sourceId:string):Promise<DevelopmentArrangement|null>{
  if(!await arrangementsAvailable(db)||!await canArrange(db,actor))return null;
  const document=await developmentDocumentRow(db,sourceId)??digitalNotFound();
  const round=document.round_number??1;
  const route:string[]=round===1?(document.document?await savedDevelopmentRoute(db,sourceId,document.document):[]):document.revision.route_nodes;
  const plan=(await db.query("SELECT * FROM digital_development_round_arrangements WHERE source_id=$1 AND round_number=$2",[sourceId,round])).rows[0];
  const tasks=(await db.query(`SELECT t.task_id,t.state,a.task_kind,a.assignee_id FROM digital_production_tasks t
    JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 ORDER BY t.created_at,t.task_id`,[sourceId,round])).rows;
  const legacy=(await db.query("SELECT * FROM digital_development_dispatch WHERE source_id=$1",[sourceId])).rows[0];
  const oldFields:Record<string,string>={development_pattern:"pattern_worker_id",development_cutting:"cutting_worker_id",development_sewing:"sewing_worker_id"};
  const managerId=plan?.manager_id??null,policy=new DigitalProductionAccessPolicy(db);
  const managerName=managerId?(await db.query("SELECT display_name FROM app_users WHERE id=$1",[managerId])).rows[0]?.display_name??null:null;
  const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0]?.state??"active";
  const hasCurrentWork=tasks.some(task=>["pending","ready","blocked"].includes(task.state));
  const checked=round>1&&!route.includes("development_materials")||tasks.some(t=>["development_materials","development_material_recheck"].includes(t.task_kind)&&t.state==="completed")&&Boolean((await db.query(`SELECT 1 FROM digital_development_execution_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id WHERE f.source_id=$1 AND t.route_version=$2 AND f.kind='核配通过'`,[sourceId,round])).rowCount);
  const unavailableReason=document.status!=="published"?"本单开发资料尚未发布，请设计师先完成发布。":lifecycle!=="active"?`本单已${lifecycle==="paused"?"暂停，请有权管理人恢复后再安排":"取消，人员历史保留只读"}。`:!hasCurrentWork?"本轮已结束，人员历史保留只读。":!checked?"本轮核料尚未通过，请核料文员先完成本轮材料核验。":null;
  const readyToArrange=unavailableReason===null;
  const rows:DevelopmentArrangement["rows"]=[];
  const fixed=await developmentSlaPlan(db,sourceId)?await fixedDevelopmentCutter(db):null;
  const applicable=route.filter((kind,index)=>kind!=="development_sewing_transfer"||route[index-1]!=="development_craft_confirmation"||route[index+1]!=="development_sewing"||tasks.some(task=>task.task_kind===kind));
  const adopted=document.document?.craftSteps?.some((step:CraftStepChoice)=>step.craftKind==='special')?await new FixedTimelineAdoptionRepository(db).existing({kind:'source',id:sourceId},round):null;
  const specialSteps=adopted?.input.craftSteps?.filter(step=>step.craftKind==='special')??[];
  const specialPositions=specialSteps.length?(await db.query("SELECT task_id,step_id FROM digital_timeline_task_positions WHERE route_ref=$1 AND phase='work'",[adopted!.input.sourceVersions.routeRef])).rows:[];
  const specialTaskIds=new Set(specialPositions.filter(p=>specialSteps.some(s=>s.stepId===p.step_id)).map(p=>p.task_id));
  const kinds=[...new Set([...applicable,...tasks.filter(t=>t.task_kind==="development_sewing_transfer"&&!["completed","cancelled"].includes(t.state)).map(t=>t.task_kind)])];
  const entries:Array<{kind:string;stepRef?:string;label?:string}>=kinds.filter(kind=>DEVELOPMENT_ARRANGEABLE_KINDS.includes(kind as typeof DEVELOPMENT_ARRANGEABLE_KINDS[number])&&(kind!=='development_printing'||!specialSteps.length||adopted?.input.craftSteps?.some(step=>step.craftKind==='printing'))).map(kind=>({kind}));
  entries.push(...specialSteps.map(step=>({kind:'development_printing',stepRef:step.stepId,label:craftStepLabel(step)})));
  for(const entry of entries){
    const {kind,stepRef}=entry,key=arrangementEntryKey(entry);
    const task=tasks.filter(t=>t.task_kind===kind&&(stepRef?specialPositions.some(p=>p.task_id===t.task_id&&p.step_id===stepRef):!specialTaskIds.has(t.task_id))).at(-1);
    const assigneeId=task?task.assignee_id:kind==='development_cutting'&&fixed?fixed.assigneeId:(plan?plan.entries[key]??null:round===1?legacy?.[oldFields[kind]!]??null:null);
    const requiredRole=DIGITAL_TASK_ROLES[kind as DigitalTaskKind];
    const label=entry.label??(await db.query("SELECT label FROM digital_production_deadline_policies WHERE node_key=$1 ORDER BY version DESC LIMIT 1",[kind])).rows[0]?.label??kind;
    const assigneeName=assigneeId?(await db.query("SELECT display_name FROM app_users WHERE id=$1",[assigneeId])).rows[0]?.display_name??null:null;
    rows.push({kind,...(stepRef?{stepRef}:{}),label,requiredRole,assigneeId,assigneeName,valid:Boolean(assigneeId&&(await policy.activeRole(assigneeId,requiredRole)||kind==='development_sewing'&&await isNativeRootSewingRecipient(db,sourceId,assigneeId))),taskId:task?.task_id??null,state:task?.state??null,fixed:Boolean(kind==='development_cutting'&&fixed),editable:!(kind==='development_cutting'&&fixed)&&(!task||!["completed","cancelled"].includes(task.state))});
  }
  return {roundNumber:round,documentVersion:document.version,version:plan?.version??0,managerId,managerName,canEdit:Boolean(readyToArrange&&(!managerId||managerId===actor.actorId||isRootActor(actor))),canTakeOver:isRootActor(actor)||actor.actorRoles.includes("pattern_room_supervisor")&&await policy.activeRole(actor.actorId,"pattern_room_supervisor"),readyToArrange:Boolean(readyToArrange),unavailableReason,rows};
}

/** Called only inside the existing execution command's lifecycle lock and transaction. */
export async function saveArrangement(db:PoolClient,database:Pool,actor:TrustedActorContext,sourceId:string,input:DevelopmentArrangementInput){
  const before=await readArrangement(db,actor,sourceId)??digitalForbidden();
  if(before.roundNumber!==input.roundNumber)conflict("已有新轮次。本次未保存，请打开当前轮的人员安排。");
  if(before.documentVersion!==input.expectedDocumentVersion)conflict("本轮资料已更新。本次未保存，请核对当前资料版本后再安排。");
  if(before.version!==input.expectedVersion)conflict("人员安排已被更新。本次未保存，请重新读取并核对变更。");
  if(!before.readyToArrange)conflict(before.unavailableReason??"本轮安排条件暂未读取完整，请重新读取。");
  if(input.management!=="keep"&&!before.canTakeOver)digitalForbidden();
  if(input.management==="keep"&&!before.canEdit)conflict(`本轮安排已由${before.managerName??"技术主管"}接管，请由接管人处理或交回文员。`);
  if(input.management==="release"&&before.managerId!==actor.actorId&&!isRootActor(actor))digitalForbidden();
  if(input.entries.length!==before.rows.length||input.entries.some(entry=>!before.rows.some(row=>arrangementEntryKey(row)===arrangementEntryKey(entry))))
    conflict("本轮流程已变化。本次未保存，请重新读取本轮安排。");
  const policy=new DigitalProductionAccessPolicy(db);
  if(!isRootActor(actor)){
    const roles=input.management==="keep"?["development_clerk","pattern_room_supervisor","owner_group","production_management"]:["pattern_room_supervisor"];
    let allowed=false;for(const role of roles)if(actor.actorRoles.includes(role)&&await policy.lockActiveRole(actor.actorId,role)){allowed=true;break;}
    if(!allowed)digitalForbidden();
  }
  const entries:Record<string,string|null>={};
  for(const row of before.rows){
    const inputRow=input.entries.find(entry=>arrangementEntryKey(entry)===arrangementEntryKey(row))!;
    const expected=inputRow.expectedTask;
    if((row.taskId===null)!==(expected===null)||expected&&(expected.taskId!==row.taskId||expected.state!==row.state||expected.assigneeId!==row.assigneeId))
      conflict(`${row.label}已被办理或改派。本次未保存，请核对当前记录。`);
    if(!row.editable&&inputRow.assigneeId!==row.assigneeId)conflict(row.fixed?'开发裁板使用固定人员，不逐单分派':`${row.label}已结束，不能改写历史人员。`);
    if(input.management!=="keep"&&inputRow.assigneeId!==row.assigneeId)conflict("接管或交回不能同时改派人员，请先单独保存安排。");
    if(input.management==="keep"&&row.editable&&inputRow.assigneeId&&!await policy.lockActiveRole(inputRow.assigneeId,row.requiredRole)&&!(row.kind==='development_sewing'&&row.assigneeId===inputRow.assigneeId&&await isNativeRootSewingRecipient(db,sourceId,inputRow.assigneeId)))
      conflict(`${row.label}所选人员已不可安排。请重新选择有效岗位人员。`);
    if(row.taskId&&row.assigneeId!==inputRow.assigneeId&&row.assigneeId&&!inputRow.reason)
      conflict(`${row.label}已安排人员，请明确填写本次改派原因。`);
    if(row.taskId&&row.state!=="pending"&&inputRow.assigneeId===null&&row.assigneeId)
      conflict(`${row.label}已进入办理，不能清空负责人，请明确改派。`);
    if(row.kind==="development_sewing"&&row.editable&&inputRow.assigneeId!==row.assigneeId){
      const worker=(await db.query(`SELECT s.worker_user_id FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id)
        JOIN pattern_room_segments s ON s.round_id=o.current_round_id WHERE l.source_id=$1 AND s.ended_at IS NULL FOR UPDATE OF o,s`,[sourceId])).rows[0];
      if(worker&&worker.worker_user_id!==inputRow.assigneeId)conflict("车板已建立实际执行归属。请技术主管先在原执行单办理换人分段，再更新安排。");
    }
    entries[arrangementEntryKey(row)]=inputRow.assigneeId;
  }
  const manager=input.management==="takeover"?actor.actorId:input.management==="release"?null:before.managerId;
  await db.query(`INSERT INTO digital_development_round_arrangements(source_id,round_number,version,entries,manager_id,changed_by,document_version)
    VALUES($1,$2,1,$3,$4,$5,$6) ON CONFLICT(source_id,round_number) DO UPDATE SET version=digital_development_round_arrangements.version+1,
    document_version=excluded.document_version,entries=excluded.entries,manager_id=excluded.manager_id,changed_by=excluded.changed_by,changed_at=CURRENT_TIMESTAMP`,[sourceId,input.roundNumber,JSON.stringify(entries),manager,actor.actorId,input.expectedDocumentVersion]);
  const service=new DigitalProductionTaskService(database);
  for(const row of before.rows){
    const next=entries[arrangementEntryKey(row)]!;
    if(!row.editable||!row.taskId)continue;
    if(next===row.assigneeId){if(next)await service.refreshBusinessConditionsWithClient(db,actor,row.taskId);continue;}
    if(next)await service.reassignWithClient(db,actor,row.taskId,next);
    else await db.query("UPDATE digital_production_task_access SET assignee_id=NULL WHERE task_id=$1",[row.taskId]);
  }
  await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
    VALUES($1,$2,$3,'development_round_arranged','digital_development',$4,$5,$6)`,[randomUUID(),actor.requestId,actor.actorId,sourceId,JSON.stringify(before),JSON.stringify({...input,version:before.version+1,managerId:manager})]);
  await assembleQuotation(db,sourceId,actor.actorId);
  return {roundNumber:input.roundNumber,version:before.version+1};
}
