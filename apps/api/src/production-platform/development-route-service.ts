import {businessNow} from '../acceptance-clock/business-time.js';
import {technicalEnrollment,publishedTechnicalArtifact,technicalMeasurementDocument} from './development-technical-repository.js';
import {developmentRevisionSource} from './development-revision-source.js';
import type {DevelopmentMakingUpgrade} from '@dx-rework/contracts/digital-development';
import {plannedRecipient,arrangementsAvailable} from "./development-arrangement.js";
import {DEVELOPMENT_ARRANGEABLE_KINDS} from "@dx-rework/contracts/development-arrangement";
import type {DevelopmentRevision} from "@dx-rework/contracts/digital-development-rounds";
import type {PatternRoomOrderService} from "../pattern-room/order-service.js";
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {DigitalDevelopmentService} from './development-service.js';
import {DigitalProductionTaskService} from './task-service.js';
import {DigitalProductionAccessPolicy,digitalNotFound} from './access-policy.js';
import {DIGITAL_TASK_ROLES,type DigitalTaskKind} from './task-access-repository.js';
import {materialReadiness} from './development-material-readiness.js';
import type {DevelopmentActualMeasurements} from '@dx-rework/contracts/digital-development-execution';
import {validateDevelopmentMeasurements} from './development-inspection-evidence.js';
import {developmentSlaPlan} from './development-sla-enrollment.js';
import {fixedDevelopmentCutter} from './development-fixed-cutting.js';
import {savedDevelopmentRoute} from "./development-sla-enrollment.js";
const fail=(message:string):never=>{throw new ApplicationError('DEVELOPMENT_ROUTE_CONFLICT',message,409);};
export type DevelopmentRouteAction={measurements?:DevelopmentActualMeasurements|undefined;making?:DevelopmentMakingUpgrade|undefined;attachmentIds?:string[]|undefined;returnNodes?:DevelopmentRevision["affectedNodes"]|undefined;problemCategories?:DevelopmentRevision["categories"]|undefined;craftExecution:'内部'|'外发'|null;taskId:string;note:string;result:'通过'|'退回';nextAssigneeId:string|null;sentDate:string|null;trackingNo:string|null};
export class DevelopmentRouteService {
 constructor(private readonly database:Pool,private readonly patternOrders?:PatternRoomOrderService){}
 private async task(db:PoolClient,sourceId:string,taskId:string){return (await db.query('SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.task_id=$2',[sourceId,taskId])).rows[0]??digitalNotFound();}
 private async recipient(db:PoolClient,sourceId:string,kind:DigitalTaskKind,explicit:string|null,round:number){
   const role=DIGITAL_TASK_ROLES[kind],policy=new DigitalProductionAccessPolicy(db);
   if(kind==='development_cutting'&&await developmentSlaPlan(db,sourceId)){
     const fixed=await fixedDevelopmentCutter(db);
     if(explicit&&explicit!==fixed?.assigneeId)fail('开发裁板使用固定人员，不逐单分派');
     return fixed?.valid?fixed.assigneeId:null;
   }
   if((DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(kind)){
     const saved=await plannedRecipient(db,sourceId,round,kind);
     if(saved.planned){if(explicit&&explicit!==saved.id)fail("本轮已保存人员安排，请在总委派页明确改派。");return saved.id&&await policy.activeRole(saved.id,role)?saved.id:null;}
     if(await arrangementsAvailable(db)&&(round>1||!["development_pattern","development_cutting","development_sewing"].includes(kind)))return null;
   }
   if(explicit){if(!await policy.activeRole(explicit,role))fail('下一办理人不具备该节点的有效岗位');return explicit;}
   if(role==='sample_designer'){
     const id=(await db.query('SELECT created_by FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0].created_by;
     return await policy.activeRole(id,role)?id:null;
   }
   if(['development_pattern','development_cutting','development_sewing'].includes(kind)){
     const column=kind==='development_pattern'?'pattern_worker_id':kind==='development_cutting'?'cutting_worker_id':'sewing_worker_id';
     const id=(await db.query(`SELECT ${column} AS worker_id FROM digital_development_dispatch WHERE source_id=$1`,[sourceId])).rows[0]?.worker_id;
     return id&&await policy.activeRole(id,role)?id:null;
   }
   const people=(await db.query('SELECT DISTINCT user_id FROM user_role_assignments WHERE role_code=$1 AND revoked_at IS NULL',[role])).rows;
   const active=[];for(const person of people)if(await policy.activeRole(person.user_id,role))active.push(person.user_id);
   return active.length===1?active[0]:null;
 }
 async startRound(db:PoolClient,actor:TrustedActorContext,sourceId:string,kind:DigitalTaskKind,routeId:string,roundNumber:number,authorizingTaskId?:string,predecessorId?:string,nextAssigneeId:string|null=null,requireActualReceipt=false){
   const sheet=await new DigitalDevelopmentService(this.database,true).read(actor,sourceId,db,roundNumber),service=new DigitalProductionTaskService(this.database);
   const positioning=kind==='development_craft_dispatch'&&await technicalEnrollment(db,sourceId)?(await db.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_positioning' AND t.state<>'cancelled' ORDER BY t.created_at DESC LIMIT 1`,[sourceId,roundNumber])).rows[0]:null;
   const next=await service.createWithClient(db,actor,{resource:{kind:'source',id:sourceId},...(authorizingTaskId?{authorizingTaskId}:{}),kind,routeId,routeVersion:roundNumber,occurrence:roundNumber,assigneeId:await this.recipient(db,sourceId,kind,nextAssigneeId,roundNumber),predecessors:[...(predecessorId?[predecessorId]:[]),...(positioning?[positioning.task_id]:[])],conditions:kind==='development_sewing'?['pattern_assignment_ready']:kind==='development_cutting'?['materials_ready']:[]});
   if(!requireActualReceipt&&['development_pattern','development_cutting','development_sewing','development_washing'].includes(kind))await service.setConditionWithClient(db,actor,next.taskId,'handover_received',true,undefined,'本轮已交出');
   if(['development_pattern','development_cutting','development_sewing'].includes(kind)){
     const materialState=await materialReadiness(db,sourceId,roundNumber);
     await service.setConditionWithClient(db,actor,next.taskId,'materials_ready',kind==='development_sewing'?materialState.sewingReady:materialState.earlyReady,undefined,'依据本轮逐项核验、到料和问题决定');
   }
   if(kind==='development_sewing'){
     const native=(await db.query(`SELECT to_jsonb(o)->>'status' AS status FROM digital_development_pattern_links l
       JOIN pattern_room_orders o USING(order_id) WHERE l.source_id=$1 AND to_jsonb(o)->>'deleted_at' IS NULL`,[sourceId])).rows[0];
     if(native&&['in_progress','pending_confirmation','completed'].includes(native.status))await service.setConditionWithClient(db,actor,next.taskId,'pattern_assignment_ready',true,undefined,'原打板执行归属已确认');
   }
   if(kind==='development_tail_check'){
     const inherited=sheet.document!.washing!=='免洗'&&roundNumber>1?(await db.query('SELECT inherited FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,roundNumber])).rows[0]?.inherited?.development_washing:null;
     if(inherited)await service.inheritWashingConditionWithClient(db,actor,next.taskId,inherited.taskId,'本轮引用前轮洗水完成证据');
     else await service.setConditionWithClient(db,actor,next.taskId,'washing_finished',true,undefined,sheet.document!.washing==='免洗'?'本轮免洗':'本轮洗水已完成');
   }
   return next;
 }
 async advance(db:PoolClient,actor:TrustedActorContext,sourceId:string,taskId:string,nextAssigneeId:string|null=null){
   const task=await this.task(db,sourceId,taskId);
   const sheet=await new DigitalDevelopmentService(this.database,true).read(actor,sourceId,db,task.route_version);
   const route:DigitalTaskKind[]=task.route_version===1?await savedDevelopmentRoute(db,sourceId,sheet.document!):(await db.query('SELECT route_nodes FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,task.route_version])).rows[0].route_nodes;
   const index=route.indexOf(task.task_kind==='development_material_recheck'?'development_materials':task.task_kind);
   if(index<0||index===route.length-1)return null;
   let nextKind=route[index+1]!,requireActualReceipt=false;
   // Only bypass the transfer when sewing is the saved successor. Revisions may inherit sewing.
   if(task.task_kind==='development_craft_confirmation'&&nextKind==='development_sewing_transfer'&&route[index+2]==='development_sewing'){
     const existing=(await db.query("SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_sewing_transfer'",[sourceId,task.route_version])).rowCount;
     if(!existing){
       nextKind='development_sewing';requireActualReceipt=true;
     }
   }
   if(task.task_kind==='development_craft_confirmation'&&nextKind==='development_sewing')requireActualReceipt=true;
   if(requireActualReceipt){
       await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'development_system_route','digital_development',$4,$5)",[randomUUID(),actor.requestId,actor.actorId,sourceId,JSON.stringify({mode:'system_route',fromTaskId:taskId,round:task.route_version,nextKind,reason:'设计师已确认工艺，沿用本单车板安排；不记录人工转交或实物接收'})]);
   }
   const next=await this.startRound(db,actor,sourceId,nextKind,task.route_instance_id,task.route_version,taskId,taskId,nextAssigneeId,requireActualReceipt);
   if(requireActualReceipt)await new DigitalProductionTaskService(this.database).recordSystemRouteWithClient(db,actor,next.taskId,taskId);
   return next;
 }
 async releaseSewing(db:PoolClient,actor:TrustedActorContext,sourceId:string){
   const sheet=await new DigitalDevelopmentService(this.database,true).read(actor,sourceId,db);
   const roundNumber=sheet.roundNumber??1;
   const tasks=(await db.query("SELECT t.task_id,t.state,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind IN ('development_pattern','development_cutting','development_sewing') AND t.state IN ('pending','ready','blocked') AND t.route_version=$2",[sourceId,roundNumber])).rows;
   if(!tasks.length)return;
   const readiness=await materialReadiness(db,sourceId,roundNumber),service=new DigitalProductionTaskService(this.database);
   for(const task of tasks){
     // Older unfinished cutting tasks did not contain this gate. Add a condition
     // only to the affected current task; completed history is never rewritten.
     await db.query("INSERT INTO digital_production_task_conditions(task_id,condition_key,stage) VALUES($1,'materials_ready','activation') ON CONFLICT DO NOTHING",[task.task_id]);
     const ready=task.task_kind==='development_sewing'?readiness.sewingReady:readiness.earlyReady;
     const prior=(await db.query("SELECT satisfied FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='materials_ready'",[task.task_id])).rows[0];
     if(prior.satisfied!==ready||(!ready&&task.state==='ready'))await service.setConditionWithClient(db,actor,task.task_id,'materials_ready',ready,undefined,'本轮材料有效事实重新核实');
     if(ready)await service.refreshBusinessConditionsWithClient(db,actor,task.task_id);
   }
 }
 async complete(db:PoolClient,actor:TrustedActorContext,sourceId:string,input:DevelopmentRouteAction,key:string){
   await new DigitalProductionAccessPolicy(db).assert(actor,'task',input.taskId,'execute');
   const task=await this.task(db,sourceId,input.taskId);
   const currentPlan=await developmentSlaPlan(db,sourceId);
   let inspection: {phase:string;unit:string;sizes:string[];measurements:DevelopmentActualMeasurements;artifactRef?:{id:string;version:number}}|undefined;
   if(currentPlan&&['development_pre_wash_check','development_tail_check'].includes(task.task_kind)){
     const sheet=await new DigitalDevelopmentService(this.database,true).read(actor,sourceId,db,task.route_version);
     if(task.task_kind==='development_pre_wash_check'&&sheet.document!.washing==='免洗')fail('免洗开发单没有洗前检查');
     const enrolled=!!await technicalEnrollment(db,sourceId),basis=await technicalMeasurementDocument(db,sourceId,task.route_version,sheet.document!);
     if(enrolled&&!basis)fail('请先形成本轮有效技术基码尺寸表，再记录实际尺寸');
     const document=basis?.document??sheet.document!;
     if(enrolled||document.washing!=='免洗')validateDevelopmentMeasurements(document,input.measurements,enrolled);
     else if(input.measurements?.length)validateDevelopmentMeasurements(document,input.measurements);
     if(input.measurements?.length)inspection={phase:task.task_kind==='development_pre_wash_check'?'洗前':document.washing==='免洗'?'尾查':'洗后',unit:document.unit,sizes:document.sizes,measurements:input.measurements,...(basis?.artifactRef?{artifactRef:basis.artifactRef}:{})};
   }
   const kinds:Partial<Record<DigitalTaskKind,string>>={development_craft_dispatch:'发工艺',development_printing:'工艺完成',development_embroidery:'工艺完成',development_print_embroidery:'工艺完成',development_craft_confirmation:'工艺确认',development_sewing_transfer:'转交车板',development_sewing:'车板完成',development_washing:'洗水完成',development_pre_wash_check:'洗前检查',development_tail_check:input.result==='退回'?'尾查退回':'尾查通过',development_confirmation:'最终设计确认',development_shipping:'寄出'};
   const kind=kinds[task.task_kind as DigitalTaskKind];if(!kind||task.state!=='ready')fail('当前节点尚不可办理');
   if(input.result==='退回'&&task.task_kind!=='development_tail_check')fail('实际修改请使用复版入口，不能直接覆盖本轮');
   if(input.result==='退回'&&!input.note.trim())fail('请填写内部尾查问题');
   if(input.nextAssigneeId&&task.task_kind!=='development_craft_dispatch')fail('本操作不能改派下一节点，请使用任务改派');
   if(task.task_kind==='development_craft_dispatch'&&!input.craftExecution)fail('请记录工艺内部制作或外发');
   if(task.task_kind==='development_craft_dispatch'){
     if(await technicalEnrollment(db,sourceId)){
       const artifact=await publishedTechnicalArtifact(db,sourceId,task.route_version);
       const position=(await db.query(`SELECT f.payload FROM digital_development_route_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id
         WHERE f.source_id=$1 AND f.route_version=$2 AND f.kind='定位图确认' AND t.state='completed' ORDER BY f.sequence DESC LIMIT 1`,[sourceId,task.route_version])).rows[0];
       if(!artifact||!position||position.payload.artifactSetId!==artifact.artifact.artifactSetId||position.payload.artifactVersion!==artifact.artifact.version)fail('相应裁片和当前纸样的定位图尚未形成；设计定位可与裁板并行，但发工艺前须具备有效定位');
     }
     const sheet=await new DigitalDevelopmentService(this.database,true).read(actor,sourceId,db,task.route_version);
     const route:DigitalTaskKind[]=task.route_version===1?await savedDevelopmentRoute(db,sourceId,sheet.document!):(await db.query('SELECT route_nodes FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,task.route_version])).rows[0].route_nodes;
     const nextKind=route[route.indexOf(task.task_kind)+1];
     const recipient=nextKind?await this.recipient(db,sourceId,nextKind,input.nextAssigneeId,task.route_version):null;
     if(!recipient)fail('本轮工艺尚无有效办理人，请开发文员在总委派页安排后再发出。');
     input={...input,nextAssigneeId:recipient};
   }
   if(task.task_kind==='development_shipping'&&(!input.sentDate||!input.trackingNo?.trim()))fail('请填写实际寄出日期和快递号');
   if(task.task_kind==='development_shipping'&&input.sentDate&&input.sentDate>businessNow().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}))fail('实际寄出日期不能晚于今天');
   if(task.task_kind==='development_sewing'){
     const readiness=await materialReadiness(db,sourceId,task.route_version);
     if(!readiness.sewingReady)fail(readiness.sewingMissing.map(item=>`${item.name}：${item.missing.join('、')}`).join('；')||'问题面料须供应链总监确认允许使用');
   }
   const revision=task.route_version>1?(await db.query('SELECT output_kind FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,task.route_version])).rows[0]:{output_kind:(await developmentRevisionSource(db,sourceId))?.outputKind};
   const nativeRoundId=task.task_kind==='development_confirmation'&&revision?.output_kind!=='工艺布片'?(await db.query("SELECT o.current_round_id FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id) WHERE l.source_id=$1 AND o.deleted_at IS NULL FOR UPDATE OF o",[sourceId])).rows[0]?.current_round_id??null:null;
   await db.query('INSERT INTO digital_development_route_facts(fact_id,source_id,task_id,route_version,kind,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),sourceId,input.taskId,task.route_version,kind,JSON.stringify({...input,...(task.task_kind==='development_confirmation'?{nativeRoundId}:{}),...(inspection?{inspection}:{})}),actor.actorId]);
   if((task.task_kind==='development_sewing'||task.task_kind==='development_confirmation')&&revision?.output_kind!=='工艺布片'){
     const native=(await db.query("SELECT o.order_id,o.current_round_id,o.version,o.status FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id) WHERE l.source_id=$1 AND o.deleted_at IS NULL FOR UPDATE OF o",[sourceId])).rows[0];
     if(!native||!this.patternOrders)fail('请先由设计师提交原打板执行单，并由技术主管确认派工');
     const original=this.patternOrders!.inTransaction(db);
     if(task.task_kind==='development_shipping'&&input.sentDate&&input.sentDate>businessNow().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}))fail('实际寄出日期不能晚于今天');
   if(task.task_kind==='development_sewing'){
       if(native.status==='in_progress')await original.completeDevelopment(actor,sourceId,input.taskId,native.order_id,{roundId:native.current_round_id,version:native.version});
       else if(native.status!=='pending_confirmation'&&!(task.route_version>1&&native.status==='completed'))fail('原打板执行状态不允许报车板完成');
     }else{
       if(native.status==='pending_confirmation')await original.handoff(actor,native.order_id,{roundId:native.current_round_id,version:native.version},`development-final:${key}`);
       else if(native.status!=='completed')fail('请先完成原打板执行再最终确认');
     }
   }
   const service=new DigitalProductionTaskService(this.database);
   await service.setConditionWithClient(db,actor,input.taskId,'business_recorded',true,undefined,input.note);
   await service.completeWithClient(db,actor,input.taskId,{note:input.note},`route:${key}`);
   if(input.result!=='退回')await this.advance(db,actor,sourceId,input.taskId,input.nextAssigneeId);
   return {taskId:input.taskId,result:input.result};
 }
}
