import {captureTechnicalRound} from './development-cycle-evidence.js';
import {technicalEnrollment,inheritTechnicalArtifact,publishedTechnicalArtifact} from './development-technical-repository.js';
import {DevelopmentTechnicalService} from './development-technical-service.js';
import {createIndependentDevelopmentRevision} from './development-revision-source.js';
import {businessNow,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {captureDevelopmentTimeline} from './fixed-development-adoption.js';
import {developmentSlaPlan,developmentSlaRoute} from "./development-sla-enrollment.js";
import {validateAuxiliaryReferences} from '../access/auxiliary-catalog-service.js';
import {verificationAvailable} from "./development-material-verification.js";
import {developmentRevisionForSave} from "./development-document-format.js";
import {isDevelopmentMaterialPlaceholder} from "@dx-rework/contracts/digital-development";
import {authorizePatternOrder} from "../pattern-room/order-authority.js";
import { BulkPreparationService } from "./bulk-preparation-service.js";
import {isDeepStrictEqual} from "node:util";
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {DevelopmentRevisionSchema,type DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
import {developmentPublishErrors} from '@dx-rework/contracts/digital-development';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {digitalForbidden} from './access-policy.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {DigitalDevelopmentService} from './development-service.js';
import {DigitalProductionTaskService} from './task-service.js';
import {DevelopmentRouteService} from './development-route-service.js';
import {developmentRevisionPlan} from './development-round-plan.js';
const fail=(message:string):never=>{throw new ApplicationError('DEVELOPMENT_REVISION_CONFLICT',message,409);};
export class DevelopmentRoundService {
 constructor(private readonly database:Pool,private readonly enabled:boolean){}
 private forms(){return new DigitalDevelopmentService(this.database,this.enabled);}
 async read(actor:TrustedActorContext,sourceId:string){
  const sheet=await this.forms().read(actor,sourceId);
  const rounds=(await this.database.query('SELECT round_number AS "roundNumber",based_on_round AS "basedOnRound",origin,customer_comment AS "customerComment",internal_problem AS "internalProblem",explanation,categories,affected_nodes AS "affectedNodes",output_kind AS "outputKind",route_nodes AS "routeNodes",inherited,published_at AS "publishedAt" FROM digital_development_rounds WHERE source_id=$1 ORDER BY round_number',[sourceId])).rows;
  const draft=sheet.canEdit?(await this.database.query('SELECT version,payload FROM digital_development_round_drafts WHERE source_id=$1',[sourceId])).rows[0]??null:null;
  return {rounds,draft};
 }
 private async command<T>(actor:TrustedActorContext,sourceId:string,action:string,key:string,input:unknown,work:(db:PoolClient)=>Promise<T>){
  if(!this.enabled)digitalForbidden();if(!/^[A-Za-z0-9._:-]{1,100}$/.test(key))fail('缺少有效操作标识');
  const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const sheet=await this.forms().read(actor,sourceId,db);if(!sheet.canEdit||sheet.status!=='published')digitalForbidden();
   const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0];if(lifecycle&&lifecycle.state!=='active')fail('开发单已暂停或取消');
   const command=`development-round:${sourceId}:${action}`,hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior&&prior.payload_hash!==hash)fail('同一操作标识不能用于不同内容');
   const result=prior?prior.response as T:await work(db);
   if(!prior)await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);
   await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async save(actor:TrustedActorContext,sourceId:string,input:{expectedDraftVersion:number;revision:DevelopmentRevision},key:string){
  return this.command(actor,sourceId,'save',key,input,async db=>{
   const sheet=await this.forms().read(actor,sourceId,db);if((sheet.roundNumber??1)!==input.revision.basedOnRound)fail('已有新轮次，请重新读取当前资料');
   const before=(await db.query('SELECT version,payload FROM digital_development_round_drafts WHERE source_id=$1 FOR UPDATE',[sourceId])).rows[0];if((before?.version??0)!==input.expectedDraftVersion)fail('复版草稿已更新，请刷新');
   const revision={...input.revision,document:developmentRevisionForSave(input.revision.document,sheet.document!)};
   await validateAuxiliaryReferences(db,revision.document,before?.payload?.document??sheet.document!);
   await this.forms().bindFiles(db,actor,sourceId,revision.document);
   await db.query('INSERT INTO digital_development_round_drafts(source_id,version,based_on_round,payload,updated_by) VALUES($1,1,$2,$3,$4) ON CONFLICT(source_id) DO UPDATE SET version=digital_development_round_drafts.version+1,based_on_round=$2,payload=$3,updated_by=$4,updated_at=CURRENT_TIMESTAMP',[sourceId,input.revision.basedOnRound,JSON.stringify(revision),actor.actorId]);
   return {draftVersion:input.expectedDraftVersion+1};
  });
 }
 async publish(actor:TrustedActorContext,sourceId:string,input:{expectedDraftVersion:number;basedOnRound:number},key:string){
  return this.command(actor,sourceId,'publish',key,input,async db=>{
   const draft=(await db.query('SELECT * FROM digital_development_round_drafts WHERE source_id=$1 FOR UPDATE',[sourceId])).rows[0]??fail('请先保存复版草稿');
   if(draft.version!==input.expectedDraftVersion||draft.based_on_round!==input.basedOnRound)fail('复版草稿已变化，请刷新后发布');
   const result=await this.publishWithClient(db,actor,sourceId,DevelopmentRevisionSchema.parse(draft.payload));
   await db.query('DELETE FROM digital_development_round_drafts WHERE source_id=$1',[sourceId]);return result;
  });
 }
 async publishWithClient(db:PoolClient,actor:TrustedActorContext,sourceId:string,input:DevelopmentRevision,returnTaskId?:string,patternReworkRoundId?:string){
  if(!this.enabled)digitalForbidden();
  const parsed=DevelopmentRevisionSchema.safeParse(input);if(!parsed.success)fail(parsed.error.issues[0]?.message??"复版资料无效");input=parsed.data!;
  const sheet=await this.forms().read(actor,sourceId,db);
  if(input.document.orderDate!==sheet.document!.orderDate)fail('实际复版不能改写首次开发下单日期');
  if(patternReworkRoundId){
   const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0];
   if(lifecycle&&lifecycle.state!=='active')fail('开发单已暂停或取消');
   const original=(await db.query(`SELECT r.requested_by FROM digital_development_pattern_links l
     JOIN pattern_room_orders o USING(order_id) JOIN pattern_room_rounds r ON r.round_id=o.current_round_id
     WHERE l.source_id=$1 AND r.round_id=$2 AND r.round_type='rework' AND r.status='pending_assignment'
       AND o.status='pending_assignment' AND o.deleted_at IS NULL`,[sourceId,patternReworkRoundId])).rows[0];
   if(!original||original.requested_by!==actor.actorId)digitalForbidden();
   await authorizePatternOrder(db,actor,"pattern_room:orders:rework",true);
  }
  if(!returnTaskId&&!patternReworkRoundId&&!sheet.canEdit)digitalForbidden();
  if(input.basedOnRound!==(sheet.roundNumber??1))fail('已有新轮次，不能从旧版重复发布');
  if(returnTaskId){const task=(await db.query("SELECT t.route_version,a.task_kind,a.source_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.task_id=$1",[returnTaskId])).rows[0];if(!task||task.source_id!==sourceId||task.task_kind!=='development_tail_check'||task.route_version!==input.basedOnRound||input.origin!=='内部发现')digitalForbidden();}
  await validateAuxiliaryReferences(db,input.document,sheet.document!);
  const errors=developmentPublishErrors(input.document,{allowMissingOrderDate:sheet.document!.orderDate===null});if(errors.length)fail(errors.join('；'));
  if(input.affectedNodes.includes('工艺')&&input.document.craft==='无')fail('本轮没有印绣花工艺');
  if(input.affectedNodes.includes('洗水')&&input.document.washing==='免洗')fail('本轮为免洗，请核对受影响节点');
  if(input.origin!=='内部发现'&&!returnTaskId&&!patternReworkRoundId&&await developmentSlaPlan(db,sourceId)){
    await this.forms().bindFiles(db,actor,sourceId,input.document);
    return createIndependentDevelopmentRevision(db,actor,sourceId,input);
  }
  const document=structuredClone(input.document),affectedNodes=[...input.affectedNodes];
  const clerkVerification=await verificationAvailable(db);
  // A changed material gets its own identity; old arrivals never certify a replacement.
  for(const material of document.materials){const old=sheet.document!.materials.find(item=>item.materialId===material.materialId);if(!old||!isDeepStrictEqual(old,material)){if(old)material.materialId=randomUUID();if((clerkVerification?!isDevelopmentMaterialPlaceholder(material):material.requiredThisRound)&&!affectedNodes.includes('核配'))affectedNodes.push('核配');}}
  if(clerkVerification&&sheet.document!.materials.some(old=>!isDevelopmentMaterialPlaceholder(old)&&!input.document.materials.some(m=>m.materialId===old.materialId))&&!affectedNodes.includes('核配'))affectedNodes.push('核配');
  const completed:Record<string,{taskId:string;roundNumber:number}>={};
  const tasks=(await db.query("SELECT t.task_id,t.route_version,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.state='completed' AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') ORDER BY t.route_version DESC,t.completed_at DESC,t.task_id",[sourceId])).rows;
  for(const task of tasks){const kind=task.task_kind==='development_material_recheck'?'development_materials':task.task_kind;if(!completed[kind])completed[kind]={taskId:task.task_id,roundNumber:task.route_version};}
  const savedPlan=await developmentSlaPlan(db,sourceId);
  let {route,inherited}=developmentRevisionPlan({...input,document,affectedNodes},completed,savedPlan?developmentSlaRoute(document,input.outputKind,savedPlan.route_schema_version===2?2:1):undefined);
  if(savedPlan?.route_schema_version===2){
   // A repeated generic handoff is not proof for its sibling craft. If an
   // unfinished craft is carried forward, include that step's own dispatch and
   // confirmation, while retaining genuinely completed other work as history.
   const full=['development_materials' as const,...developmentSlaRoute(document,input.outputKind,2)],selected=new Set(route);
   const craftKinds=['development_printing','development_embroidery'] as const;
   const selectedCraft=new Set(craftKinds.filter(kind=>selected.has(kind)));
   route=full.filter((kind,index)=>kind==='development_craft_dispatch'?selectedCraft.has(full[index+1] as typeof craftKinds[number])
    :kind==='development_craft_confirmation'?selectedCraft.has(full[index-1] as typeof craftKinds[number]):selected.has(kind));
   if(selectedCraft.size){inherited={...inherited};delete inherited.development_craft_dispatch;delete inherited.development_craft_confirmation;}
  }
  const roundNumber=input.basedOnRound+1,routeId=randomUUID();
  await this.forms().bindFiles(db,actor,sourceId,document);
  await db.query(`INSERT INTO digital_development_rounds(source_id,round_number,based_on_round,document_version,document,origin,customer_comment,internal_problem,explanation,categories,affected_nodes,output_kind,route_nodes,inherited,return_task_id,route_id,created_by,published_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[sourceId,roundNumber,input.basedOnRound,sheet.version+1,JSON.stringify(document),input.origin,input.customerComment,input.internalProblem,input.explanation,input.categories,affectedNodes,input.outputKind,route,JSON.stringify(inherited),returnTaskId??null,routeId,actor.actorId,businessNow().toISOString()]);
  const priorCycle=await technicalEnrollment(db,sourceId)?(await db.query('SELECT * FROM digital_development_cycle_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,input.basedOnRound])).rows[0]:null;
  if(priorCycle)await captureTechnicalRound(db,actor.actorId,sourceId,roundNumber,businessNow().toISOString(),priorCycle.internal_wash_minutes,Number(priorCycle.warning_ratio));
  if(!affectedNodes.includes('纸样'))await inheritTechnicalArtifact(db,actor.actorId,sourceId,roundNumber,sourceId,input.basedOnRound,businessNow().toISOString());
  if(await technicalEnrollment(db,sourceId)&&!route.includes('development_pattern')&&!await publishedTechnicalArtifact(db,sourceId,roundNumber))fail('本次技术依据已改变，原成果不能沿用；请将纸样加入受影响节点后再发布，当前草稿与原轮次保持');
  if(savedPlan?.timeline_schema_version===2)await captureDevelopmentTimeline(db,actor.actorId,sourceId,roundNumber,routeId,route,document,sheet.version+1,
    `development-round:${sourceId}:${roundNumber}`,await new ContextBusinessClock(this.database,db).read({kind:'source',id:sourceId}));
  await new DigitalProductionTaskService(this.database).supersedeSourceTasksWithClient(db,actor,sourceId,input.basedOnRound,returnTaskId);
  await new DevelopmentRouteService(this.database).startRound(db,actor,sourceId,route[0]!,routeId,roundNumber,returnTaskId);
  await new DevelopmentTechnicalService(this.database,this.enabled).ensurePositionForRound(db,actor,sourceId,roundNumber,routeId,returnTaskId);
  if(await developmentSlaPlan(db,sourceId)){
    const designer=(await db.query('SELECT created_by FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0].created_by;
    await new DigitalProductionTaskService(this.database).createWithClient(db,actor,{resource:{kind:'source',id:sourceId},...(returnTaskId?{authorizingTaskId:returnTaskId}:{}),kind:'development_shipping',routeId,routeVersion:roundNumber,occurrence:roundNumber,
      assigneeId:await new DigitalProductionAccessPolicy(db).activeRole(designer,'sample_designer')?designer:null});
  }
  await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'development_round_published','digital_development',$4,$5)",[randomUUID(),actor.requestId,actor.actorId,sourceId,JSON.stringify({roundNumber,origin:input.origin,affectedNodes,route,inherited,...(patternReworkRoundId?{nativeRoundId:patternReworkRoundId}:{})})]);
  await new BulkPreparationService(this.database).syncSource(db,actor,sourceId);
  return {sourceId,roundNumber};
 }
}
