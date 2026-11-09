import {BulkPreparationService} from './bulk-preparation-service.js';
import type {PatternRoomOrderService} from '../pattern-room/order-service.js';
import {DevelopmentPatchDecisionSchema,CompleteDevelopmentPatchSchema} from '@dx-rework/contracts/digital-development-technical';
import {technicalMeasurementDocument} from './development-technical-repository.js';
import {validateDevelopmentMeasurements} from './development-inspection-evidence.js';
import {externalPatternRecords} from './development-external-pattern-facts.js';
import {ExternalPaperIntervalSchema} from '@dx-rework/contracts/digital-development-technical';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {
 CompletePositionSchema,CompleteSizeReviewSchema,RecordFinalCommentSchema,SaveTechnicalArtifactSchema,DevelopmentUrgentRequestSchema,SaveTechnicalMaterialDecisionSchema,SavePreparationBasisSchema,
 type CompleteSizeReview,type DevelopmentTechnicalState,type RecordFinalComment,type SaveTechnicalArtifact,
} from '@dx-rework/contracts/digital-development-technical';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';
import {DigitalDevelopmentService} from './development-service.js';
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from './access-policy.js';
import {DigitalProductionTaskService} from './task-service.js';
import {effectiveTechnicalEvidence,publishedTechnicalArtifact,technicalArtifactDto,technicalDocumentFingerprint,technicalEnrollment,type TechnicalDB} from './development-technical-repository.js';
import {developmentCycleEvidence} from './development-cycle-evidence.js';
import {DevelopmentTechnicalSettingsService} from './development-technical-settings.js';
const conflict:(message:string)=>never=message=>{throw new ApplicationError('DEVELOPMENT_TECHNICAL_CONFLICT',message,409);};
const iso=(value:string|Date)=>new Date(value).toISOString();

export class DevelopmentTechnicalService {
 constructor(private readonly database:Pool,private readonly enabled:boolean,private readonly previewSecret?:string,private readonly patternOrders?:PatternRoomOrderService){}
 settingsService(){return new DevelopmentTechnicalSettingsService(this.database,this.enabled,this.previewSecret);}
 private forms(){return new DigitalDevelopmentService(this.database,this.enabled);}
 private tasks(){return new DigitalProductionTaskService(this.database);}
 private async technicalRole(db:TechnicalDB,actor:TrustedActorContext,roles=['pattern_room_worker','pattern_room_supervisor'],write=false){
  if(isRootActor(actor))return true;
  const policy=new DigitalProductionAccessPolicy(db);
  for(const role of roles)if(actor.actorRoles.includes(role)&&await(write?policy.lockActiveRole(actor.actorId,role):policy.activeRole(actor.actorId,role)))return true;
  return false;
 }
 private async designer(db:PoolClient,actor:TrustedActorContext,sourceId:string){
  const sheet=await this.forms().read(actor,sourceId,db);
  if(!sheet.canEdit||!await this.technicalRole(db,actor,['sample_designer'],true))digitalForbidden();
 }
 private async task(db:PoolClient,actor:TrustedActorContext,sourceId:string,taskId:string,kinds:string[],ready=false){
  await new DigitalProductionAccessPolicy(db).assert(actor,'task',taskId,'execute');
  const row=(await db.query('SELECT t.*,a.task_kind,a.required_role,a.source_id,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.task_id=$1',[taskId])).rows[0];
  if(!row||row.source_id!==sourceId||!kinds.includes(row.task_kind))digitalForbidden();
  if(!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,row.required_role))digitalForbidden();
  if(ready&&row.state!=='ready')conflict('当前任务尚不可办理，或已有新版本/轮次');
  return row;
 }
 private async command<T>(actor:TrustedActorContext,sourceId:string,kind:string,key:string,input:unknown,authorize:(db:PoolClient)=>Promise<unknown>,work:(db:PoolClient)=>Promise<T>):Promise<T>{
  if(!this.enabled)digitalForbidden();if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))conflict('缺少有效操作标识');
  const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   await this.forms().read(actor,sourceId,db);
   if(!await technicalEnrollment(db,sourceId))conflict('此历史开发单保留原流程，尚未明确采用新技术资料规则');
   const state=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0]?.state;
   if(state&&state!=='active')conflict('开发单已暂停或取消');
   await authorize(db); // Repeat authorization even for a committed retry.
   const command=`development-technical:${sourceId}:${kind}`,hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior&&prior.payload_hash!==hash)conflict('原操作标识不能用于不同内容');
   const result=prior?prior.response as T:await work(db);
   if(!prior&&['artifact','comment','review','preparation-basis'].includes(kind))await new BulkPreparationService(this.database).syncSource(db,actor,sourceId);
   if(!prior&&kind==='material-decision')await new BulkPreparationService(this.database).refreshSourceCuttingReadiness(db,actor,sourceId);
   if(!prior)await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);
   await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private async scope(db:TechnicalDB,sourceId:string,scope:string){
  if(scope==='整款')return;
  const match=scope.match(/^po:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(!match||!(await db.query('SELECT 1 FROM digital_production_po_lines p JOIN digital_production_orders o USING(production_order_id) WHERE p.line_id=$1 AND o.source_id=$2',[match[1],sourceId])).rowCount)conflict('适用范围不属于本开发来源，请重新选择本单PO');
 }
 /** Source/task scope plus native private-file binding; no duplicate upload for an adopted original. */
 async bindTechnicalFiles(db:PoolClient,actor:TrustedActorContext,sourceId:string,attachmentIds:string[],purpose:string,taskId?:string,previousIds:string[]=[]){
  for(const id of [...attachmentIds].sort()){
   const file=(await db.query(`SELECT a.*,p.purpose,p.task_id,p.source_id AS purpose_source FROM attachments a
    LEFT JOIN digital_development_upload_purposes p USING(attachment_id) WHERE a.attachment_id=$1 FOR UPDATE OF a`,[id])).rows[0];
   if(!file||file.status!=='ready')conflict('附件仍在上传或已失效，请等待就绪回执');
   const reused=previousIds.includes(id),inherited=Boolean((await db.query('SELECT 1 FROM digital_development_inherited_files WHERE source_id=$1 AND attachment_id=$2',[sourceId,id])).rowCount);
   if(file.entity_type?file.entity_type!=='digital_development'||file.entity_id!==sourceId&&!inherited:file.uploaded_by!==actor.actorId)digitalForbidden();
   const sharedEvidence=!taskId&&file.entity_type==='digital_development'&&file.entity_id===sourceId;
   if(!reused&&!inherited&&!sharedEvidence&&(file.purpose_source!==sourceId||file.purpose!==purpose||(taskId?file.task_id!==taskId:!!file.task_id)))conflict('附件用途或任务/轮次不符');
   if(purpose==='纸样成果'?(file.mime_type!=='application/octet-stream'||!/\.plt$/i.test(file.original_filename)):!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.mime_type))conflict(purpose==='纸样成果'?'PLT原件尚不可用；图片不能代替纸样原件':'请使用真实图片或PDF依据');
   if(!inherited){await db.query("UPDATE attachments SET entity_type='digital_development',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1",[id,sourceId]);
    await db.query('INSERT INTO digital_development_attachment_bindings(attachment_id,source_id,bound_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,sourceId,actor.actorId]);}
  }
 }
 async saveArtifact(actor:TrustedActorContext,sourceId:string,raw:SaveTechnicalArtifact,key:string){
  const input=SaveTechnicalArtifactSchema.parse(raw);
  return this.command(actor,sourceId,'artifact',key,input,db=>this.task(db,actor,sourceId,input.taskId,['development_pattern','development_size_review']),async db=>{
   const task=await this.task(db,actor,sourceId,input.taskId,['development_pattern','development_size_review'],true);
   await this.scope(db,sourceId,input.scopeRef);
   const sheet=await this.forms().read(actor,sourceId,db,task.route_version);
   if(sheet.version!==input.expectedDocumentVersion||sheet.latestRoundNumber!==undefined&&sheet.latestRoundNumber!==task.route_version)conflict('开发资料或轮次已更新，请先核对当前制作依据');
   const head=(await db.query('SELECT * FROM digital_development_artifact_heads WHERE source_id=$1 AND round_number=$2 AND scope_ref=$3 FOR UPDATE',[sourceId,task.route_version,input.scopeRef])).rows[0];
   if((head?.current_version??0)!==input.expectedVersion)conflict('技术成果已有新版本，请核对后再提交');
   for(const row of input.body.consumptionRows)if(!sheet.document!.materials.some(m=>m.materialId===row.materialId))conflict('结构用量引用了其它来源或已替换的物料');
   if(input.body.baseSizeTable.templateRef){
    const ref=input.body.baseSizeTable.templateRef,template=(await db.query('SELECT customer_code FROM digital_development_technical_templates WHERE template_id=$1 AND version=$2',[ref.id,ref.version])).rows[0];
    const customer=(await db.query('SELECT customer_code FROM digital_production_orders WHERE source_id=$1',[sourceId])).rows[0]?.customer_code??sheet.customerCode;
    if(!template||!customer||template.customer_code!==customer)conflict('客户尺寸模板不存在或不属于本单客户');
   }
   if(task.task_kind==='development_size_review'){
    const review=(await db.query('SELECT * FROM digital_development_size_review_requests WHERE task_id=$1',[input.taskId])).rows[0]??digitalNotFound();
    const basis=input.body.basedOnFinalComment;
    if(!basis||basis.id!==review.final_comment_id||basis.version!==review.final_comment_version)conflict('改版成果必须引用本次最终评语');
   }else if(input.body.basedOnFinalComment)conflict('纸样原任务不能冒用尺寸复核的评语依据');
   const previous=await publishedTechnicalArtifact(db,sourceId,task.route_version,input.scopeRef);
   await this.bindTechnicalFiles(db,actor,sourceId,input.body.pltAttachmentIds,'纸样成果',input.taskId,previous?.artifact.body.pltAttachmentIds);
   const artifactSetId=head?.artifact_set_id??randomUUID(),version=input.expectedVersion+1;
   if(head)await db.query('UPDATE digital_development_artifact_heads SET current_version=$2,published_version=$3 WHERE artifact_set_id=$1',[artifactSetId,version,input.action==='publish'?version:head.published_version]);
   else await db.query('INSERT INTO digital_development_artifact_heads(artifact_set_id,source_id,round_number,scope_ref,current_version,published_version) VALUES($1,$2,$3,$4,$5,$6)',[artifactSetId,sourceId,task.route_version,input.scopeRef,version,input.action==='publish'?version:null]);
   await db.query(`INSERT INTO digital_development_artifact_versions(artifact_set_id,version,source_id,round_number,scope_ref,task_id,status,document_version,document_fingerprint,body,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[artifactSetId,version,sourceId,task.route_version,input.scopeRef,input.taskId,input.action==='publish'?'published':'draft',sheet.version,technicalDocumentFingerprint(sheet.document!),JSON.stringify(input.body),actor.actorId,businessNow().toISOString()]);
   if(input.action==='publish')await this.ensurePositionForRound(db,actor,sourceId,task.route_version,task.route_instance_id,input.taskId);
   return {artifactSetId,version,status:input.action==='publish'?'published':'draft'};
  });
 }
 async recordComment(actor:TrustedActorContext,sourceId:string,raw:RecordFinalComment,key:string){
  const input=RecordFinalCommentSchema.parse(raw);
  return this.command(actor,sourceId,'comment',key,input,db=>this.designer(db,actor,sourceId),async db=>{
   const sheet=await this.forms().read(actor,sourceId,db,input.roundNumber);
   if(sheet.status!=='published'||(sheet.latestRoundNumber??1)!==input.roundNumber)conflict('请在当前已发布轮次登记实际客户评语，历史轮次保持原记录');
   await this.scope(db,sourceId,input.scopeRef);
   const version=(await db.query('SELECT coalesce(max(version),0)::int AS n FROM digital_development_final_comments WHERE source_id=$1 AND round_number=$2 AND scope_ref=$3',[sourceId,input.roundNumber,input.scopeRef])).rows[0].n;
   if(version!==input.expectedVersion)conflict('客户评语已有更新，请核对后登记');
   const at=businessNow().toISOString();if(input.occurredAt&&Date.parse(input.occurredAt)>Date.parse(at))conflict('客户评语发生时间不能在未来');
   await this.bindTechnicalFiles(db,actor,sourceId,input.evidenceRefs,'客户评语依据');
   const customer=(await db.query('SELECT customer_code FROM digital_production_orders WHERE source_id=$1',[sourceId])).rows[0]?.customer_code??sheet.customerCode;
   const id=randomUUID(),next=version+1;
   await db.query(`INSERT INTO digital_development_final_comments(comment_id,source_id,round_number,scope_ref,version,is_final,decision,customer_code,text_value,evidence_refs,evidence_note,occurred_at,recorded_at,recorded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,sourceId,input.roundNumber,input.scopeRef,next,input.isFinal,input.decision,customer,input.text,input.evidenceRefs,input.evidenceNote,input.occurredAt,at,actor.actorId]);
   let reviewTaskId:string|null=null;
   if(input.isFinal){
    const old=(await db.query(`SELECT q.task_id FROM digital_development_size_review_requests q JOIN digital_production_tasks t USING(task_id)
     WHERE q.source_id=$1 AND q.round_number=$2 AND q.scope_ref=$3 AND t.state NOT IN ('completed','cancelled')`,[sourceId,input.roundNumber,input.scopeRef])).rows;
    for(const row of old)await this.cancelReview(db,actor,sourceId,row.task_id,at);
    const origin=(await db.query(`SELECT t.route_instance_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
     WHERE a.source_id=$1 AND t.route_version=$2 ORDER BY t.created_at,t.task_id LIMIT 1`,[sourceId,input.roundNumber])).rows[0]??conflict('本轮发布任务尚未建立');
    const candidates=(await db.query(`SELECT a.assignee_id FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
     WHERE a.source_id=$1 AND a.task_kind='development_pattern' AND a.assignee_id IS NOT NULL AND t.route_version<=$2 ORDER BY t.route_version DESC,t.created_at DESC`,[sourceId,input.roundNumber])).rows;
    let assigneeId:string|null=null;for(const candidate of candidates)if(await new DigitalProductionAccessPolicy(db).activeRole(candidate.assignee_id,'pattern_room_worker')){assigneeId=candidate.assignee_id;break;}
    const occurrence=(await db.query("SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_size_review'",[sourceId])).rows[0].n;
    reviewTaskId=(await this.tasks().createWithClient(db,actor,{resource:{kind:'source',id:sourceId},kind:'development_size_review',routeId:origin.route_instance_id,routeVersion:input.roundNumber,occurrence,assigneeId,occurredAt:at})).taskId;
    const artifact=await publishedTechnicalArtifact(db,sourceId,input.roundNumber,input.scopeRef);
    await db.query(`INSERT INTO digital_development_size_review_requests(review_id,task_id,source_id,round_number,scope_ref,final_comment_id,final_comment_version,requested_artifact_set_id,requested_artifact_version,requested_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),reviewTaskId,sourceId,input.roundNumber,input.scopeRef,id,next,artifact?.artifact.artifactSetId??null,artifact?.artifact.version??null,at]);
    await this.tasks().refreshDevelopmentDeadlineWithClient(db,actor,reviewTaskId);
   }
   return {commentId:id,version:next,reviewTaskId};
  });
 }
 private async cancelReview(db:PoolClient,actor:TrustedActorContext,sourceId:string,taskId:string,at:string){
  await db.query("UPDATE digital_production_tasks SET state='cancelled',blocked_reason='新最终评语已建立独立复核，原记录保留' WHERE task_id=$1 AND state NOT IN ('completed','cancelled')",[taskId]);
  const eventId=randomUUID();await db.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
   VALUES($1,$2,'source',$3,'cancelled',$4,$5,'现场登记','{"reason":"superseded_final_comment"}')`,[eventId,taskId,sourceId,actor.actorId,at]);
  await db.query("INSERT INTO digital_production_event_intents(event_id,task_id,event_kind) VALUES($1,$2,'cancelled')",[eventId,taskId]);
 }
 async completeReview(actor:TrustedActorContext,sourceId:string,raw:CompleteSizeReview,key:string){
  const input=CompleteSizeReviewSchema.parse(raw);
  return this.command(actor,sourceId,'review',key,input,db=>this.task(db,actor,sourceId,input.taskId,['development_size_review']),async db=>{
   const task=await this.task(db,actor,sourceId,input.taskId,['development_size_review'],true);
   const review=(await db.query('SELECT q.*,r.version AS result_version FROM digital_development_size_review_requests q LEFT JOIN digital_development_size_review_results r USING(review_id) WHERE q.task_id=$1',[input.taskId])).rows[0]??digitalNotFound();
   if((review.result_version??1)!==input.expectedReviewVersion||review.result_version)conflict('本次复核已提交，请读取采用版本');
   const latest=(await db.query('SELECT comment_id,version FROM digital_development_final_comments WHERE source_id=$1 AND round_number=$2 AND scope_ref=$3 AND is_final ORDER BY version DESC LIMIT 1',[sourceId,task.route_version,review.scope_ref])).rows[0];
   if(!latest||latest.comment_id!==input.finalCommentId||latest.version!==input.finalCommentVersion||review.final_comment_id!==input.finalCommentId||review.final_comment_version!==input.finalCommentVersion)conflict('已有新的最终评语，请办理对应复核任务');
   const artifact=await publishedTechnicalArtifact(db,sourceId,task.route_version,review.scope_ref)??conflict('当前尚无有效发布的技术成果');
   if(artifact.artifact.artifactSetId!==input.artifactSetId||artifact.artifact.version!==input.artifactVersion)conflict('技术成果已变版，请核对当前有效发布组');
   const sheet=await this.forms().read(actor,sourceId,db,task.route_version);
   if(artifact.row.document_fingerprint!==technicalDocumentFingerprint(sheet.document!))conflict('成果不符合本轮当前技术依据，请先改版');
   if(input.decision==='revise'){
    if(artifact.artifact.taskId!==input.taskId||artifact.artifact.body.basedOnFinalComment?.id!==input.finalCommentId||artifact.artifact.body.basedOnFinalComment.version!==input.finalCommentVersion)conflict('请选择由本次复核发布、引用当前最终评语的改版成果');
   }else if(artifact.artifact.taskId===input.taskId)conflict('本次已发布改版成果，请按改版采用，不能冒称沿用旧版');
   await db.query(`INSERT INTO digital_development_size_review_results(review_id,decision,artifact_set_id,artifact_version,note,reviewed_by,reviewed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[review.review_id,input.decision,input.artifactSetId,input.artifactVersion,input.note,actor.actorId,businessNow().toISOString()]);
   await this.tasks().setConditionWithClient(db,actor,input.taskId,'business_recorded',true,undefined,input.note);
   await this.tasks().completeWithClient(db,actor,input.taskId,{note:input.note},`technical-review:${createHash('sha256').update(JSON.stringify([sourceId,key])).digest('hex')}`);
   return {reviewId:review.review_id,version:2,adoptedArtifactVersion:input.artifactVersion,evidenceRevision:(await effectiveTechnicalEvidence(db,sourceId,task.route_version,review.scope_ref)).revision};
  });
 }
 /** A parallel design task; the linear cutting route does not wait for positioning. */
 async ensurePositionWithClient(db:PoolClient,actor:TrustedActorContext,sourceId:string,paperTaskId:string){
  if(!await technicalEnrollment(db,sourceId))return null;
  const paper=(await db.query(`SELECT t.*,a.source_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   WHERE t.task_id=$1 AND a.source_id=$2 AND a.task_kind='development_pattern' AND t.state='completed'`,[paperTaskId,sourceId])).rows[0];
  if(!paper)return null;
  return this.ensurePositionForRound(db,actor,sourceId,paper.route_version,paper.route_instance_id,paperTaskId,paperTaskId);
 }
 async ensurePositionForRound(db:PoolClient,actor:TrustedActorContext,sourceId:string,round:number,routeId:string,authorizingTaskId?:string,paperTaskId?:string){
  if(!await technicalEnrollment(db,sourceId))return null;
  const sheet=await this.forms().read(actor,sourceId,db,round);if(sheet.document?.craft==='无')return null;
  const artifact=await publishedTechnicalArtifact(db,sourceId,round);if(!artifact)return null;
  const paper=paperTaskId??(await db.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_pattern' AND t.state='completed' ORDER BY t.created_at DESC LIMIT 1`,[sourceId,round])).rows[0]?.task_id;
  if(!paper&&!artifact.artifact.inheritedFrom)return null;
  const existing=(await db.query(`SELECT t.task_id,t.state,f.payload FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   LEFT JOIN digital_development_route_facts f ON f.task_id=t.task_id AND f.kind='定位图确认'
   WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_positioning' AND t.state<>'cancelled' ORDER BY t.created_at DESC,t.task_id LIMIT 1`,[sourceId,round])).rows[0];
  if(existing&&(existing.state!=='completed'||existing.payload?.artifactSetId===artifact.artifact.artifactSetId&&existing.payload?.artifactVersion===artifact.artifact.version))return existing.task_id as string;
  const owner=(await db.query('SELECT created_by FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0].created_by;
  const assigneeId=await new DigitalProductionAccessPolicy(db).activeRole(owner,'sample_designer')?owner:null;
  const occurrence=(await db.query("SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_positioning'",[sourceId])).rows[0].n;
  const result=await this.tasks().createWithClient(db,actor,{resource:{kind:'source',id:sourceId},...(authorizingTaskId?{authorizingTaskId}:{}),kind:'development_positioning',routeId,routeVersion:round,occurrence,assigneeId,predecessors:paper?[paper]:[]});
  // An already-created craft dispatch must also observe a changed positioning basis.
  for(const dispatch of (await db.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_craft_dispatch' AND t.state IN ('ready','pending','blocked')`,[sourceId,round])).rows){
   await db.query('INSERT INTO digital_production_task_dependencies(task_id,predecessor_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[dispatch.task_id,result.taskId]);
   await db.query("UPDATE digital_production_tasks SET state='pending',blocked_reason='待本轮有效定位图确认' WHERE task_id=$1",[dispatch.task_id]);
  }
  return result.taskId;
 }
 async completePosition(actor:TrustedActorContext,sourceId:string,raw:unknown,key:string){
  const input=CompletePositionSchema.parse(raw);
  return this.command(actor,sourceId,'position',key,input,db=>this.task(db,actor,sourceId,input.taskId,['development_positioning']),async db=>{
   const task=await this.task(db,actor,sourceId,input.taskId,['development_positioning'],true),artifact=await publishedTechnicalArtifact(db,sourceId,task.route_version);
   if(!artifact||artifact.artifact.artifactSetId!==input.artifactSetId||artifact.artifact.version!==input.artifactVersion)conflict('定位依据已变版，请核对当前PLT成果');
   const sheet=await this.forms().read(actor,sourceId,db,task.route_version);
   await this.bindTechnicalFiles(db,actor,sourceId,input.attachmentIds,'定位图',input.taskId,sheet.document!.files.filter(f=>['菲林','工艺开发板','局部图'].includes(f.kind)).map(f=>f.attachmentId));
   await db.query(`INSERT INTO digital_development_route_facts(fact_id,source_id,task_id,route_version,kind,payload,actor_id)
    VALUES($1,$2,$3,$4,'定位图确认',$5,$6)`,[randomUUID(),sourceId,input.taskId,task.route_version,JSON.stringify(input),actor.actorId]);
   await this.tasks().setConditionWithClient(db,actor,input.taskId,'business_recorded',true,undefined,input.note);
   await this.tasks().completeWithClient(db,actor,input.taskId,{note:input.note},`position:${createHash('sha256').update(JSON.stringify([sourceId,key])).digest('hex')}`);
   return {taskId:input.taskId,state:'completed'};
  });
 }
 private async canRequestUrgent(db:PoolClient,actor:TrustedActorContext,sourceId:string,write=false){
  if(await this.technicalRole(db,actor,['pattern_room_supervisor'],write))return true;
  const sheet=await this.forms().read(actor,sourceId,db);
  if(sheet.canEdit&&await this.technicalRole(db,actor,['sample_designer'],write))return true;
  return await this.technicalRole(db,actor,['order_merchandiser'],write)&&Boolean((await db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1 AND primary_merchandiser_id=$2',[sourceId,actor.actorId])).rowCount);
 }
 async urgent(actor:TrustedActorContext,sourceId:string,raw:unknown,key:string){
  const input=DevelopmentUrgentRequestSchema.parse(raw);
  return this.command(actor,sourceId,'urgent',key,input,async db=>{
   if(input.action==='request'?!await this.canRequestUrgent(db,actor,sourceId,true):!await this.technicalRole(db,actor,['production_management','owner_group'],true))digitalForbidden();
  },async db=>{
   const sheet=await this.forms().read(actor,sourceId,db),cycle=await developmentCycleEvidence(db,sourceId,input.roundNumber,businessNow().toISOString());
   if(!cycle||(sheet.roundNumber??1)!==input.roundNumber||cycle.internalCompleted||cycle.completedAt)conflict('只能调整当前未完成开发轮次的加急状态，历史周期保持');
   if(cycle.urgentRevision!==input.expectedRevision)conflict('加急申请已更新，请重新读取');
   if(cycle.mode==='urgent')conflict('该轮已批准加急，不能通过新申请抹掉原计时');
   if(input.action==='request'&&cycle.urgentState==='requested'||input.action!=='request'&&cycle.urgentState!=='requested')conflict('请按当前实际加急申请状态办理');
   const revision=input.expectedRevision+1;
   await db.query(`INSERT INTO digital_development_urgent_events(source_id,round_number,revision,action,reason,actor_id,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[sourceId,input.roundNumber,revision,input.action,input.reason,actor.actorId,businessNow().toISOString()]);
   return {revision,action:input.action};
  });
 }
 async saveMaterialDecision(actor:TrustedActorContext,sourceId:string,raw:unknown,key:string){
  const input=SaveTechnicalMaterialDecisionSchema.parse(raw);
  return this.command(actor,sourceId,'material-decision',key,input,async db=>{if(!await this.technicalRole(db,actor,undefined,true))digitalForbidden();},async db=>{
   const sheet=await this.forms().read(actor,sourceId,db,input.roundNumber);
   if((sheet.latestRoundNumber??1)!==input.roundNumber||!sheet.document?.materials.some(m=>m.materialId===input.materialId&&m.name.trim()))conflict('请选择当前开发轮次的真实物料');
   const old=(await db.query('SELECT * FROM digital_development_technical_material_decisions WHERE source_id=$1 AND round_number=$2 AND material_id=$3 ORDER BY version DESC LIMIT 1',[sourceId,input.roundNumber,input.materialId])).rows[0];
   if((old?.version??0)!==input.expectedVersion)conflict('该物料技术依据已有新版本');
   await this.bindTechnicalFiles(db,actor,sourceId,input.supplierEvidenceIds,'面料报告',undefined,old?.supplier_evidence_ids??[]);
   const version=input.expectedVersion+1;
   await db.query(`INSERT INTO digital_development_technical_material_decisions(source_id,round_number,material_id,version,high_temperature_required,basis,supplier_evidence_ids,warp_shrink_percent,weft_shrink_percent,created_by,created_at,preshrink_method)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[sourceId,input.roundNumber,input.materialId,version,input.highTemperatureRequired,input.basis,input.supplierEvidenceIds,input.warpShrinkPercent,input.weftShrinkPercent,actor.actorId,businessNow().toISOString(),input.preshrinkMethod??null]);
   return {materialId:input.materialId,version};
  });
 }
 async savePreparationBasis(actor:TrustedActorContext,sourceId:string,raw:unknown,key:string){
  const input=SavePreparationBasisSchema.parse(raw);
  return this.command(actor,sourceId,'preparation-basis',key,input,db=>this.designer(db,actor,sourceId),async db=>{
   const sheet=await this.forms().read(actor,sourceId,db,input.roundNumber);
   if((sheet.latestRoundNumber??1)!==input.roundNumber)conflict('历史准备依据保持，请在当前轮次登记');
   const old=(await db.query('SELECT * FROM digital_development_preparation_basis WHERE source_id=$1 AND round_number=$2 ORDER BY version DESC LIMIT 1',[sourceId,input.roundNumber])).rows[0];
   if((old?.version??0)!==input.expectedVersion)conflict('准备依据已有更新');
   if(input.basis==='first_development'&&(input.finalFabric||input.finalCraft)&&!(await db.query(`SELECT 1 FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_sewing' AND t.state='completed'`,[sourceId,input.roundNumber])).rowCount)conflict('全新开发须首版实际出来后才能确定最终面料和工艺；当前仍可按临时方案开发');
   const oldIds=[...(old?.sample_evidence_ids??[]),...(old?.customer_fabric_evidence_ids??[])];
   await this.bindTechnicalFiles(db,actor,sourceId,[...new Set([...input.sampleEvidenceIds,...input.customerFabricEvidenceIds])],'客户评语依据',undefined,oldIds);
   const version=input.expectedVersion+1;
   await db.query(`INSERT INTO digital_development_preparation_basis(source_id,round_number,version,basis,final_fabric,final_craft,sample_evidence_ids,customer_fabric_evidence_ids,note,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[sourceId,input.roundNumber,version,input.basis,input.finalFabric,input.finalCraft,input.sampleEvidenceIds,input.customerFabricEvidenceIds,input.note,actor.actorId,businessNow().toISOString()]);
   return {version};
  });
 }
 async decidePatch(actor:TrustedActorContext,sourceId:string,raw:unknown,key:string){
  const input=DevelopmentPatchDecisionSchema.parse(raw);
  return this.command(actor,sourceId,'patch-decision',key,input,async db=>{if(!await this.technicalRole(db,actor,['pattern_room_supervisor'],true))digitalForbidden();},async db=>{
   const issue=(await db.query('SELECT * FROM digital_development_patch_issues WHERE issue_id=$1 AND source_id=$2',[input.issueId,sourceId])).rows[0]??digitalNotFound();
   const sheet=await this.forms().read(actor,sourceId,db);
   if(issue.round_number!==sheet.roundNumber||input.expectedVersion!==1||(await db.query('SELECT 1 FROM digital_development_patch_decisions WHERE issue_id=$1',[input.issueId])).rowCount)conflict('补做判定已更新或已进入新轮次，请核对原记录');
   const artifact=await publishedTechnicalArtifact(db,sourceId,issue.round_number);
   if(input.decision==='patch'&&(!artifact||artifact.row.document_fingerprint!==technicalDocumentFingerprint(sheet.document!)))conflict('没有可沿用的本轮有效技术成果，应按关键成果重做处理');
   const native=(await db.query(`SELECT o.* FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id) WHERE l.source_id=$1 AND o.deleted_at IS NULL FOR UPDATE OF o`,[sourceId])).rows[0];
   if(!native||!this.patternOrders)conflict('本单原计件执行尚未配置，不能建立无工资依据的补做');
   await db.query(`INSERT INTO digital_development_patch_decisions(issue_id,decision,reusable_artifacts,reason,decided_by,decided_at) VALUES($1,$2,$3,$4,$5,$6)`,[input.issueId,input.decision,input.reusableArtifacts,input.reason,actor.actorId,businessNow().toISOString()]);
   const payload=issue.payload,request={roundId:native.current_round_id,version:native.version,reason:input.reason,reasonCategory:'workmanship',attachmentIds:[],developmentNodes:payload.returnNodes,developmentProblems:payload.problemCategories?.length?payload.problemCategories:['其他'],...((input.making??payload.making)?{developmentMaking:input.making??payload.making}:{})};
   const original=this.patternOrders!.inTransaction(db),nativeKey=`development-patch:${createHash('sha256').update(JSON.stringify([sourceId,key])).digest('hex')}`;
   if(input.decision==='new_round')await original.requestRework(actor,native.order_id,request,nativeKey);
   else {
    await original.requestDevelopmentPatch(actor,native.order_id,request,nativeKey,input.issueId);
    const tail=(await db.query('SELECT * FROM digital_production_tasks WHERE task_id=$1',[issue.tail_task_id])).rows[0];
    const occurrence=(await db.query("SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_patch'",[sourceId])).rows[0].n;
    const task=await this.tasks().createWithClient(db,actor,{resource:{kind:'source',id:sourceId},kind:'development_patch',routeId:tail.route_instance_id,routeVersion:issue.round_number,occurrence,assigneeId:null,predecessors:[issue.tail_task_id],conditions:['pattern_assignment_ready']});
    await db.query("INSERT INTO digital_development_patch_tasks(issue_id,purpose,task_id) VALUES($1,'work',$2)",[input.issueId,task.taskId]);
   }
   return {issueId:input.issueId,version:2,decision:input.decision,nativeOrderId:native.order_id};
  });
 }
 async completePatch(actor:TrustedActorContext,sourceId:string,raw:unknown,key:string){
  const input=CompleteDevelopmentPatchSchema.parse(raw);
  return this.command(actor,sourceId,'patch-complete',key,input,db=>this.task(db,actor,sourceId,input.taskId,['development_patch','development_patch_tail_check','development_patch_confirmation']),async db=>{
   const task=await this.task(db,actor,sourceId,input.taskId,['development_patch','development_patch_tail_check','development_patch_confirmation'],true);
   const linked=(await db.query(`SELECT i.*,n.native_round_id FROM digital_development_patch_tasks p JOIN digital_development_patch_issues i USING(issue_id)
    JOIN digital_development_patch_native_rounds n USING(issue_id) WHERE p.task_id=$1 AND i.source_id=$2`,[input.taskId,sourceId])).rows[0]??digitalNotFound();
   const native=(await db.query(`SELECT o.* FROM pattern_room_orders o WHERE o.current_round_id=$1 AND o.deleted_at IS NULL FOR UPDATE`,[linked.native_round_id])).rows[0];
   if(!native||!this.patternOrders)conflict('本次补做原执行段已变化，请核对当前单');
   let kind='补做完成',inspection:unknown;
   if(task.task_kind!=='development_patch_confirmation'){
    if(!input.attachmentIds.length)conflict('请上传本任务实际补做或尾查照片');
    const photos=(await db.query("SELECT count(*)::int AS n FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready' AND mime_type IN ('image/jpeg','image/png','image/webp')",[input.attachmentIds])).rows[0].n;
    if(photos!==input.attachmentIds.length)conflict('补做与尾查须用真实就绪照片');
    await this.bindTechnicalFiles(db,actor,sourceId,input.attachmentIds,task.task_kind==='development_patch'?'补做成果':'尾查照片',input.taskId);
   }else if(input.attachmentIds.length)conflict('确认沿原补做与尾查记录，无需重复上传');
   if(task.task_kind==='development_patch_tail_check'){
    kind='尾查通过';const sheet=await this.forms().read(actor,sourceId,db,task.route_version),basis=await technicalMeasurementDocument(db,sourceId,task.route_version,sheet.document!);
    if(!basis)conflict('本轮尺寸依据尚不可用');validateDevelopmentMeasurements(basis!.document,input.measurements,true);
    inspection={phase:'补做尾查',unit:basis!.document.unit,sizes:basis!.document.sizes,measurements:input.measurements,artifactRef:basis!.artifactRef};
   }else if(task.task_kind==='development_patch_confirmation')kind='最终设计确认';
   await db.query(`INSERT INTO digital_development_route_facts(fact_id,source_id,task_id,route_version,kind,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),sourceId,input.taskId,task.route_version,kind,JSON.stringify({...input,issueId:linked.issue_id,nativeRoundId:linked.native_round_id,...(inspection?{inspection}:{})}),actor.actorId]);
   const original=this.patternOrders!.inTransaction(db);
   if(task.task_kind==='development_patch'){
    if(native.status==='in_progress')await original.completeDevelopment(actor,sourceId,input.taskId,native.order_id,{roundId:linked.native_round_id,version:native.version});
    else if(native.status!=='pending_confirmation')conflict('请先在原执行单核定本次实际新增金额及执行人员');
   }else if(task.task_kind==='development_patch_confirmation'){
    if(native.status!=='pending_confirmation')conflict('本次补做尚未实际完工，不可确认计件');
    await original.handoff(actor,native.order_id,{roundId:linked.native_round_id,version:native.version},`patch-handoff:${createHash('sha256').update(key).digest('hex')}`);
   }
   await this.tasks().setConditionWithClient(db,actor,input.taskId,'business_recorded',true,undefined,input.note);
   await this.tasks().completeWithClient(db,actor,input.taskId,{note:input.note},`patch-complete:${createHash('sha256').update(key).digest('hex')}`);
   if(task.task_kind!=='development_patch_confirmation'){
    const tailNext=task.task_kind==='development_patch',nextKind=tailNext?'development_patch_tail_check':'development_patch_confirmation',purpose=tailNext?'tail':'confirmation';
    const person=tailNext?(await db.query('SELECT assignee_id FROM digital_production_task_access WHERE task_id=$1',[linked.tail_task_id])).rows[0]?.assignee_id:(await db.query('SELECT created_by FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0]?.created_by;
    const assigneeId=person&&await new DigitalProductionAccessPolicy(db).activeRole(person,tailNext?'pattern_room_tail_inspector':'sample_designer')?person:null;
    const occurrence=(await db.query('SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind=$2',[sourceId,nextKind])).rows[0].n;
    const next=await this.tasks().createWithClient(db,actor,{resource:{kind:'source',id:sourceId},authorizingTaskId:input.taskId,kind:nextKind,routeId:task.route_instance_id,routeVersion:task.route_version,occurrence,assigneeId,predecessors:[input.taskId]});
    await db.query('INSERT INTO digital_development_patch_tasks(issue_id,purpose,task_id) VALUES($1,$2,$3)',[linked.issue_id,purpose,next.taskId]);
   }
   return {taskId:input.taskId,state:'completed'};
  });
 }
 async externalPaperInterval(actor:TrustedActorContext,sourceId:string,raw:unknown,key:string){
  const input=ExternalPaperIntervalSchema.parse(raw);
  return this.command(actor,sourceId,'external-paper-interval',key,input,async db=>{if(!await this.technicalRole(db,actor,['pattern_room_supervisor'],true))digitalForbidden();},async db=>{
   const request=(await externalPatternRecords(db,sourceId)).find(r=>r.requestId===input.requestId)??digitalNotFound();
   const prior=(await db.query('SELECT * FROM digital_development_external_intervals WHERE interval_id=$1 ORDER BY version DESC LIMIT 1',[input.requestId])).rows[0];
   if((prior?.version??0)!==input.expectedVersion)conflict('实际外部纸样时间已更新，请核对原记录');
   const sheet=await this.forms().read(actor,sourceId,db);
   if(!prior&&request.roundNumber!==sheet.roundNumber)conflict('历史轮次不可补造首次交出事实；已有记录可追加有权订正');
   const receipt=request.taskId?(await db.query('SELECT state,completed_at FROM digital_production_tasks WHERE task_id=$1',[request.taskId])).rows[0]:null;
   const receivedAt=receipt?.state==='completed'?receipt.completed_at:request.receivedAt;
   const cycle=await developmentCycleEvidence(db,sourceId,request.roundNumber,businessNow().toISOString());
   if(!cycle||input.departedAt!==null&&(Date.parse(input.departedAt)<Date.parse(cycle.publishedAt)||Date.parse(input.departedAt)>businessNow().getTime()||receivedAt&&Date.parse(input.departedAt)>new Date(receivedAt).getTime()))conflict('实际交出时间须在发布后，且不得晚于现在或实际收到');
   const version=input.expectedVersion+1,quality=input.departedAt===null?'缺失':prior?'已核实':'现场登记';
   // Append verified corrections or an explicit unknown; the original receipt remains on its native task.
   await db.query(`INSERT INTO digital_development_external_intervals(interval_id,version,source_id,round_number,kind,source_task_id,external_pattern_request_id,departed_at,returned_at,time_quality,actor_id,recorded_at,evidence_note)
    VALUES($1,$2,$3,$4,'外部纸样',$5,$1,$6,$7,$8,$9,$10,$11)`,[input.requestId,version,sourceId,request.roundNumber,request.taskId,input.departedAt,input.departedAt===null?null:receivedAt,quality,actor.actorId,businessNow().toISOString(),input.note]);
   return {requestId:input.requestId,version};
  });
 }
 async history(actor:TrustedActorContext,sourceId:string,input:{roundNumber:number;scopeRef:string;kind:'artifacts'|'comments';beforeVersion?:number|undefined;version?:number|undefined;view?:'directory'|undefined;adoptedArtifactId?:string|undefined}){
  const db=await this.database.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.forms().read(actor,sourceId,db,input.roundNumber);await this.scope(db,sourceId,input.scopeRef);
   if(!await technicalEnrollment(db,sourceId))digitalNotFound();
   if(input.adoptedArtifactId){
    if(input.kind!=='artifacts'||input.version===undefined||input.beforeVersion!==undefined)conflict('沿用成果只读取明确的已关联版本');
    const selection=input.view==='directory'?'a.artifact_set_id,a.version,a.source_id,a.round_number,a.scope_ref,a.task_id,a.document_version,a.status,a.created_at,u.display_name AS author_name':'a.*';
    const inherited=(await db.query(`SELECT ${selection},i.created_at AS inherited_at FROM digital_development_artifact_inheritances i JOIN digital_development_artifact_versions a ON a.artifact_set_id=i.artifact_set_id AND a.version=i.artifact_version
      LEFT JOIN app_users u ON u.id=a.created_by
      WHERE i.source_id=$1 AND i.round_number=$2 AND i.scope_ref=$3 AND i.artifact_set_id=$4 AND i.artifact_version=$5`,[sourceId,input.roundNumber,input.scopeRef,input.adoptedArtifactId,input.version])).rows[0];
    if(!inherited)digitalNotFound();await db.query('COMMIT');return {sourceId,roundNumber:input.roundNumber,scopeRef:input.scopeRef,items:[input.view==='directory'?{artifactSetId:inherited.artifact_set_id,version:inherited.version,sourceId:inherited.source_id,roundNumber:inherited.round_number,scopeRef:inherited.scope_ref,taskId:inherited.task_id,documentVersion:inherited.document_version,status:inherited.status,createdByName:inherited.author_name??null,createdAt:iso(inherited.created_at),viaSourceId:sourceId,viaRoundNumber:input.roundNumber,inheritedAt:iso(inherited.inherited_at)}:technicalArtifactDto(inherited)],nextBeforeVersion:null};
   }
   const values=[sourceId,input.roundNumber,input.scopeRef,input.beforeVersion??null,input.version??null];
   const directory=input.view==='directory';
   const selection=input.kind==='artifacts'?(directory?'v.artifact_set_id,v.version,v.source_id,v.round_number,v.scope_ref,v.task_id,v.document_version,v.status,v.created_by,v.created_at,u.display_name AS author_name':'v.*'):(directory?'v.comment_id,v.version,v.is_final,v.decision,v.occurred_at,v.recorded_at,q.task_id AS review_task_id,q.review_id,r.version AS review_result_version,r.decision AS review_decision,r.artifact_version AS review_artifact_version,r.note AS review_note':'v.*');
   const table=input.kind==='artifacts'?'digital_development_artifact_versions':'digital_development_final_comments';
   // Only fixed internal table/selection strings are interpolated; all resource/cursor inputs remain bound.
   const joins=input.kind==='artifacts'?' LEFT JOIN app_users u ON u.id=v.created_by':' LEFT JOIN digital_development_size_review_requests q ON q.final_comment_id=v.comment_id LEFT JOIN digital_development_size_review_results r ON r.review_id=q.review_id';
   const found=(await db.query(`SELECT ${selection} FROM ${table} v ${joins} WHERE v.source_id=$1 AND v.round_number=$2 AND v.scope_ref=$3 AND ($4::integer IS NULL OR v.version<$4) AND ($5::integer IS NULL OR v.version=$5) ORDER BY v.version DESC LIMIT 21`,values)).rows;
   if(input.version!==undefined&&!found.length)digitalNotFound();
   const page=found.slice(0,20),items=input.kind==='artifacts'?page.map(a=>directory?{artifactSetId:a.artifact_set_id,version:a.version,sourceId:a.source_id,roundNumber:a.round_number,scopeRef:a.scope_ref,taskId:a.task_id,documentVersion:a.document_version,status:a.status,createdByName:a.author_name??null,createdAt:iso(a.created_at)}:technicalArtifactDto(a)):page.map(c=>({commentId:c.comment_id,version:c.version,isFinal:c.is_final,decision:c.decision,...(directory?{reviewTaskId:c.review_task_id??null,review:c.review_task_id?{taskId:c.review_task_id,reviewId:c.review_id,completed:Boolean(c.review_result_version),decision:c.review_decision??null,artifactVersion:c.review_artifact_version??null,note:c.review_note??''}:null}:{text:c.text_value,evidenceRefs:c.evidence_refs,evidenceNote:c.evidence_note}),occurredAt:c.occurred_at?iso(c.occurred_at):null,recordedAt:iso(c.recorded_at)}));
   const effective=directory?await effectiveTechnicalEvidence(db,sourceId,input.roundNumber,input.scopeRef):undefined;
   const contextAvailable=directory?Boolean((await db.query('SELECT 1 FROM digital_development_preparation_basis WHERE source_id=$1 AND round_number=$2 UNION ALL SELECT 1 FROM digital_development_technical_material_decisions WHERE source_id=$1 AND round_number=$2 LIMIT 1',[sourceId,input.roundNumber])).rowCount):undefined;
   const adoptedRow=directory&&effective?.artifactRef?(await db.query('SELECT a.artifact_set_id,a.version,a.source_id,a.round_number,a.scope_ref,a.task_id,a.document_version,a.status,a.created_at,u.display_name AS author_name,i.created_at AS inherited_at FROM digital_development_artifact_versions a LEFT JOIN app_users u ON u.id=a.created_by LEFT JOIN digital_development_artifact_inheritances i ON i.artifact_set_id=a.artifact_set_id AND i.artifact_version=a.version AND i.source_id=$3 AND i.round_number=$4 AND i.scope_ref=$5 WHERE a.artifact_set_id=$1 AND a.version=$2',[effective.artifactRef.id,effective.artifactRef.version,sourceId,input.roundNumber,input.scopeRef])).rows[0]:null;
   const adoptedArtifact=adoptedRow?{artifactSetId:adoptedRow.artifact_set_id,version:adoptedRow.version,sourceId:adoptedRow.source_id,roundNumber:adoptedRow.round_number,scopeRef:adoptedRow.scope_ref,taskId:adoptedRow.task_id,documentVersion:adoptedRow.document_version,status:adoptedRow.status,createdByName:adoptedRow.author_name??null,createdAt:iso(adoptedRow.created_at),viaSourceId:sourceId,viaRoundNumber:input.roundNumber,inheritedAt:adoptedRow.inherited_at?iso(adoptedRow.inherited_at):null}:null;
   await db.query('COMMIT');return {sourceId,roundNumber:input.roundNumber,scopeRef:input.scopeRef,items,nextBeforeVersion:found.length>20?page.at(-1)!.version:null,...(directory?{effective,contextAvailable,adoptedArtifact}:{})};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async read(actor:TrustedActorContext,sourceId:string,round?:number,scope='整款',client?:PoolClient):Promise<DevelopmentTechnicalState>{
  if(client)return this.readWithClient(client,actor,sourceId,round,scope);
  const db=await this.database.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await this.readWithClient(db,actor,sourceId,round,scope);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 private async readWithClient(db:PoolClient,actor:TrustedActorContext,sourceId:string,round:number|undefined,scope:string):Promise<DevelopmentTechnicalState>{
  const sheet=await this.forms().read(actor,sourceId,db,round),selected=round??sheet.roundNumber??1,enrolled=await technicalEnrollment(db,sourceId);
  const empty:DevelopmentTechnicalState={enrolled:!!enrolled,ruleVersion:enrolled?.rule_version??null,roundNumber:selected,scopeRef:scope,artifacts:[],comments:[],reviews:[],effective:null,cycle:null,canRecordComment:false,canMaintainTemplates:false,canRequestUrgent:false,canApproveUrgent:false,canTriagePatch:false,patches:[],preparationBasis:null,materialDecisions:[]};
  if(!enrolled)return empty;
  await this.scope(db,sourceId,scope);
  const rows=(await db.query('SELECT * FROM digital_development_artifact_versions WHERE source_id=$1 AND round_number=$2 AND scope_ref=$3 ORDER BY version DESC LIMIT 100',[sourceId,selected,scope])).rows;
  empty.artifacts=rows.map(technicalArtifactDto);
  const inherited=await publishedTechnicalArtifact(db,sourceId,selected,scope);if(inherited&&!empty.artifacts.some(a=>a.artifactSetId===inherited.artifact.artifactSetId&&a.version===inherited.artifact.version))empty.artifacts.push(inherited.artifact);
  const comments=(await db.query(`SELECT c.*,q.task_id AS review_task_id FROM digital_development_final_comments c LEFT JOIN digital_development_size_review_requests q ON q.final_comment_id=c.comment_id
   WHERE c.source_id=$1 AND c.round_number=$2 AND c.scope_ref=$3 ORDER BY c.version DESC LIMIT 100`,[sourceId,selected,scope])).rows;
  const finalRow=(await db.query(`SELECT c.*,q.task_id AS review_task_id FROM digital_development_final_comments c LEFT JOIN digital_development_size_review_requests q ON q.final_comment_id=c.comment_id
   WHERE c.source_id=$1 AND c.round_number=$2 AND c.scope_ref=$3 AND c.is_final ORDER BY c.version DESC LIMIT 1`,[sourceId,selected,scope])).rows[0];
  // An active final basis must remain visible even after a long intermediate discussion.
  if(finalRow&&!comments.some(c=>c.comment_id===finalRow.comment_id))comments.push(finalRow);
  empty.comments=comments.map(c=>({commentId:c.comment_id,version:c.version,roundNumber:c.round_number,scopeRef:c.scope_ref,isFinal:c.is_final,decision:c.decision,text:c.text_value,evidenceRefs:c.evidence_refs,evidenceNote:c.evidence_note,customerCode:c.customer_code,occurredAt:c.occurred_at?iso(c.occurred_at):null,recordedAt:iso(c.recorded_at),reviewTaskId:c.review_task_id??null}));
  const latestFinal=finalRow?.comment_id;
  empty.reviews=(await db.query(`SELECT q.*,r.version AS result_version,r.decision,r.artifact_set_id,r.artifact_version,r.note,a.assignee_id,d.due_at
   FROM digital_development_size_review_requests q LEFT JOIN digital_development_size_review_results r USING(review_id)
   JOIN digital_production_task_access a USING(task_id) LEFT JOIN LATERAL(SELECT due_at FROM digital_production_deadline_revisions WHERE task_id=q.task_id ORDER BY revision_id DESC LIMIT 1)d ON true
   WHERE q.source_id=$1 AND q.round_number=$2 AND q.scope_ref=$3 ORDER BY q.requested_at DESC LIMIT 100`,[sourceId,selected,scope])).rows.map(r=>({reviewId:r.review_id,version:r.result_version??1,taskId:r.task_id,roundNumber:r.round_number,scopeRef:r.scope_ref,finalCommentId:r.final_comment_id,finalCommentVersion:r.final_comment_version,state:r.result_version?'completed':r.final_comment_id!==latestFinal?'superseded':'pending',decision:r.decision??null,artifactSetId:r.artifact_set_id??null,artifactVersion:r.artifact_version??null,note:r.note??'',assigneeId:r.assignee_id,dueAt:r.due_at?iso(r.due_at):null}));
  empty.effective=await effectiveTechnicalEvidence(db,sourceId,selected,scope);
  empty.cycle=await developmentCycleEvidence(db,sourceId,selected,businessNow().toISOString());
  empty.canRecordComment=sheet.canEdit&&await this.technicalRole(db,actor,['sample_designer']);empty.canMaintainTemplates=await this.technicalRole(db,actor);
  empty.canApproveUrgent=await this.technicalRole(db,actor,['production_management','owner_group']);
  empty.canRequestUrgent=await this.canRequestUrgent(db,actor,sourceId);
  empty.canTriagePatch=await this.technicalRole(db,actor,['pattern_room_supervisor']);
  empty.patches=(await db.query(`SELECT i.*,d.decision,p.task_id,l.order_id FROM digital_development_patch_issues i LEFT JOIN digital_development_patch_decisions d USING(issue_id)
   LEFT JOIN digital_development_patch_tasks p ON p.issue_id=i.issue_id AND p.purpose='work' LEFT JOIN digital_development_pattern_links l USING(source_id)
   WHERE i.source_id=$1 AND i.round_number=$2 ORDER BY i.created_at`,[sourceId,selected])).rows.map(r=>({issueId:r.issue_id,roundNumber:r.round_number,tailTaskId:r.tail_task_id,note:r.payload.note??'',decision:r.decision??null,workTaskId:r.task_id??null,nativeOrderId:r.order_id??null}));
  const basis=(await db.query('SELECT * FROM digital_development_preparation_basis WHERE source_id=$1 AND round_number=$2 ORDER BY version DESC LIMIT 1',[sourceId,selected])).rows[0];
  empty.preparationBasis=basis?{version:basis.version,basis:basis.basis,finalFabric:basis.final_fabric,finalCraft:basis.final_craft,sampleEvidenceIds:basis.sample_evidence_ids,customerFabricEvidenceIds:basis.customer_fabric_evidence_ids,note:basis.note}:null;
  empty.materialDecisions=(await db.query(`SELECT DISTINCT ON(material_id) * FROM digital_development_technical_material_decisions WHERE source_id=$1 AND round_number=$2 ORDER BY material_id,version DESC`,[sourceId,selected])).rows.map(r=>({materialId:r.material_id,version:r.version,preshrinkMethod:r.preshrink_method??null,highTemperatureRequired:r.high_temperature_required,basis:r.basis,supplierEvidenceIds:r.supplier_evidence_ids,warpShrinkPercent:r.warp_shrink_percent,weftShrinkPercent:r.weft_shrink_percent}));
  return empty;
 }
}
