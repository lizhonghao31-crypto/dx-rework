import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {developmentReturnNeed,type DevelopmentReturnIssue} from '@dx-rework/contracts/digital-development-amendments';
import type {DevelopmentCheck,ReopenDevelopmentMaterials} from '@dx-rework/contracts/digital-development-execution';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {DigitalProductionTaskService} from './task-service.js';
import {developmentSupplyRequirements,developmentDirectSupplyMode} from './development-supply.js';
const fail=(message:string):never=>{throw new ApplicationError('DEVELOPMENT_EXECUTION_CONFLICT',message,409);};
/** Same lifecycle transaction as check / supply. This is not a general task cancellation permission. */
export async function reopenDevelopmentMaterials(db:PoolClient,pool:Pool,actor:TrustedActorContext,sourceId:string,input:ReopenDevelopmentMaterials,current:{roundNumber:number;version:number}){
 const policy=new DigitalProductionAccessPolicy(db);
 if(!isRootActor(actor)&&(!actor.actorRoles.includes('development_clerk')||!await policy.lockActiveRole(actor.actorId,'development_clerk')))digitalForbidden();
 await policy.assert(actor,'task',input.taskId,'execute');
 if(input.roundNumber!==current.roundNumber||input.expectedDocumentVersion!==current.version)fail('制作轮次或正式资料已更新，请重新打开本单当前核料页；没有重开旧轮次');
 const check=(await db.query(`SELECT t.*,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.task_id=$2 AND a.task_kind IN ('development_materials','development_material_recheck')`,[sourceId,input.taskId])).rows[0];
 if(!check||check.state!=='completed'||check.route_version!==current.roundNumber)fail('只能重开本单当前轮已退回的核料；已结束或其他轮次不能重开');
 if(!(await db.query(`SELECT 1 FROM digital_development_execution_facts WHERE source_id=$1 AND task_id=$2 AND kind='缺项退回'`,[sourceId,input.taskId])).rowCount)fail('该核料没有缺项退回记录，不能按用途重核重开');
 if((await db.query(`SELECT 1 FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_shipping' AND t.state IN ('completed','cancelled')`,[sourceId,current.roundNumber])).rowCount)fail('本轮已经结束，不能按退回补料重新核料');
 const prior=(await db.query(`SELECT f.task_id,f.payload FROM digital_development_execution_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id WHERE f.source_id=$1 AND t.route_version=$2 AND f.kind='补料复核' AND f.payload->>'reopenedFromSupplyTaskId'=$3 ORDER BY f.sequence DESC LIMIT 1`,[sourceId,current.roundNumber,input.supplyTaskId])).rows[0];
 if(prior){if(prior.payload.priorTaskId!==input.taskId)fail('重核关联已变化，请重新读取本单');return {taskId:prior.task_id,roundNumber:current.roundNumber};}
 const supply=(await db.query(`SELECT t.*,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.task_id=$2 FOR UPDATE OF t`,[sourceId,input.supplyTaskId])).rows[0];
 if(!supply||supply.task_kind!=='development_material_supply'||supply.state!=='ready'||supply.route_version!==current.roundNumber||supply.route_instance_id!==check.route_instance_id)fail('原补正／补料已提交、结束或不属于本轮；请重新读取当前待办，不会覆盖新确认');
 const requirements=await developmentSupplyRequirements(db,sourceId,input.supplyTaskId);
 if(requirements&&!requirements.issues.length)fail('原退回记录缺少具体问题，请管理员核对；没有重开或放行核料');
 if(requirements?requirements.checkTaskId!==input.taskId:!await developmentDirectSupplyMode(db,sourceId,input.supplyTaskId,requirements))fail('未取得该补料与原退回核料的有效关联，请管理员核对原记录');
 const verification=(await db.query('SELECT version,task_id FROM digital_development_material_verifications WHERE source_id=$1 AND round_number=$2 FOR UPDATE',[sourceId,current.roundNumber])).rows[0];
 if(!verification||verification.version!==input.expectedVerificationVersion||verification.task_id!==input.taskId)fail('文员确认已变化，请重新读取后重开；没有覆盖已有核料草稿');
 const active=(await db.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind IN ('development_materials','development_material_recheck','development_material_supply') AND t.state IN ('pending','ready','blocked') AND t.task_id<>$3`,[sourceId,current.roundNumber,input.supplyTaskId])).rows;
 if(active.length)fail('本轮已有其他补正或核料待办，请先重新读取并办理当前任务，未重复建立核料');
 const occurrence=Number((await db.query(`SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_material_recheck'`,[sourceId])).rows[0].n);
 const assignee=check.assignee_id&&await policy.activeRole(check.assignee_id,'development_clerk')?check.assignee_id:await policy.activeRole(actor.actorId,'development_clerk')?actor.actorId:null;
 const next=await new DigitalProductionTaskService(pool).createWithClient(db,actor,{resource:{kind:'source',id:sourceId},authorizingTaskId:input.taskId,kind:'development_material_recheck',routeId:check.route_instance_id,routeVersion:current.roundNumber,occurrence,assigneeId:assignee});
 const supplemental=Boolean((await db.query(`SELECT 1 FROM digital_development_execution_facts WHERE source_id=$1 AND task_id=$2 AND kind='补料复核' AND payload->>'supplemental'='true'`,[sourceId,input.taskId])).rowCount);
 await db.query(`UPDATE digital_production_tasks SET state='cancelled',blocked_reason='文员已主动接回用途重核，原补正／补料记录保留',terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1`,[input.supplyTaskId]);
 await db.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload) VALUES($1,$2,'source',$3,'cancelled',$4,CURRENT_TIMESTAMP,'现场登记',$5)`,[randomUUID(),input.supplyTaskId,sourceId,actor.actorId,JSON.stringify({reason:'clerk_material_recheck',nextTaskId:next.taskId,note:input.note})]);
 await db.query(`INSERT INTO digital_development_execution_facts(fact_id,source_id,task_id,kind,payload,actor_id) VALUES($1,$2,$3,'补料复核',$4,$5)`,[randomUUID(),sourceId,next.taskId,JSON.stringify({reopenedFromSupplyTaskId:input.supplyTaskId,priorTaskId:input.taskId,note:input.note,supplemental,returnRequirements:requirements??{checkTaskId:input.taskId,documentVersion:current.version,issues:[],note:'原退回说明保留，请重新核对本轮用途'}}),actor.actorId]);
 await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'development_material_reopen','digital_development',$4,$5)`,[randomUUID(),actor.requestId,actor.actorId,sourceId,JSON.stringify({...input,nextTaskId:next.taskId})]);
 return {...next,roundNumber:current.roundNumber};
}
/** A clerk may change use, but cannot erase an independent document correction when taking work back. */
export async function assertReopenedReturnIssues(db:PoolClient,sourceId:string,taskId:string,input:Pick<DevelopmentCheck,'result'|'returnIssues'>){
 const row=(await db.query(`SELECT payload->'returnRequirements'->'issues' AS issues FROM digital_development_execution_facts WHERE source_id=$1 AND task_id=$2 AND payload ? 'reopenedFromSupplyTaskId' ORDER BY sequence DESC LIMIT 1`,[sourceId,taskId])).rows[0];
 const pending:DevelopmentReturnIssue[]=(row?.issues??[]).filter((issue:DevelopmentReturnIssue)=>developmentReturnNeed(issue)==='document'||issue.field!=='physical');
 if(pending.length&&(input.result==='通过'||pending.some(issue=>!input.returnIssues?.some(item=>item.materialId===issue.materialId&&item.field===issue.field&&developmentReturnNeed(item)===developmentReturnNeed(issue)))))fail('原退回仍有资料缺错或材料不符，改为本轮不用不能代替补正。请在核料页保留这些问题退回设计师补正，提交后再由文员复核');
 return pending;
}
