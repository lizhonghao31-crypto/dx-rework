import {qcExecutionScopes,readQcExecutionEvidence} from './qc-progress-evidence.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {SubmitQcProgressSchema,QC_PROGRESS_CAPABILITY,type QcProductionProgressSheet,type QcProductionExecution,type SubmitQcProgress,type QcProgressRecord} from '@dx-rework/contracts/qc-production-progress';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {businessNow,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {isRootActor} from '../access/business-authority.js';
import {memberCanWriteModule} from '../access/member-module-policy.js';
import {ProductionReportingService} from '../sourcing/production-reporting-service.js';
import {DigitalProductionAccessPolicy,digitalForbidden,isDigitalLeader} from './access-policy.js';
type DB=Pick<Pool|PoolClient,'query'>;
export const isQcProgressActor=(actor:TrustedActorContext)=>actor.actorRoles.includes('quality_control')&&(actor.authorizationCapabilities??[actor.authorizationCapability]).includes(QC_PROGRESS_CAPABILITY);
function conflict(message:string):never{throw new ApplicationError('QC_PROGRESS_CONFLICT',message,409);}
const iso=(v:string|Date|null)=>v===null?null:new Date(v).toISOString();
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Called only by the original warehouse dispatch transaction, after its native order exists. */
export async function startQcTrackingFromDispatch(db:PoolClient,actor:TrustedActorContext,orderId:string,factId:string){
 const rows=(await db.query(`SELECT execution.production_order_id AS native_id,execution.factory_decision_id,f.occurred_at
  FROM digital_factory_facts f JOIN digital_factory_routes route USING(preparation_id)
  JOIN digital_production_child_links link ON link.production_order_id=route.production_order_id AND link.module='production'
  JOIN sourcing_production_factory_orders execution ON execution.production_order_id=link.child_id
   AND execution.dispatched_at=f.occurred_at AND execution.supplier_id::text=f.payload->>'supplierId'
  WHERE route.production_order_id=$1 AND f.fact_id=$2 AND f.kind='仓库实际发厂' AND f.occurred_at IS NOT NULL`,[orderId,factId])).rows;
 for(const row of rows)await db.query(`INSERT INTO digital_qc_tracking_starts(tracking_id,production_order_id,native_production_id,factory_decision_id,started_at,basis,warehouse_fact_id,created_by,reason)
  VALUES($1,$2,$3,$4,$5,'warehouse_dispatch',$6,$7,'原批准厂单与仓库真实发厂范围进入生产跟踪') ON CONFLICT(native_production_id,factory_key) DO NOTHING`,[randomUUID(),orderId,row.native_id,row.factory_decision_id,row.occurred_at,factId,actor.actorId]);
}

export class QcProductionProgressService{
 constructor(private readonly database:Pool){}
 private async task(db:DB,id:string){return (await db.query(`SELECT a.task_id,a.assignee_id,t.state,u.display_name AS assignee_name
  FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) LEFT JOIN app_users u ON u.id=a.assignee_id
  WHERE a.production_order_id=$1 AND a.task_kind='factory_production_qc' ORDER BY t.created_at DESC,t.task_id DESC LIMIT 1`,[id])).rows[0];}
 private async settings(db:DB,id:string){return (await db.query(`SELECT s.*,u.display_name AS lead_name FROM digital_qc_supervision_settings s LEFT JOIN app_users u ON u.id=s.quality_lead_id
  WHERE production_order_id=$1 ORDER BY version DESC LIMIT 1`,[id])).rows[0];}
 private async lifecycle(db:DB,id:string){return (await db.query(`SELECT
  EXISTS(SELECT 1 FROM digital_production_resource_lifecycle l JOIN digital_production_orders o ON o.production_order_id=$1
   WHERE (l.resource_kind='order' AND l.resource_id=o.production_order_id OR l.resource_kind='source' AND l.resource_id=o.source_id) AND l.state<>'active') AS paused,
  EXISTS(SELECT 1 FROM digital_order_closures WHERE production_order_id=$1) AS closed`,[id])).rows[0];}
 private executions(db:DB,id:string){return qcExecutionScopes(db,id);}
 private async tracking(db:DB,nativeId:string,factory:string|null){return (await db.query('SELECT * FROM digital_qc_tracking_starts WHERE native_production_id=$1 AND factory_decision_id IS NOT DISTINCT FROM $2::uuid',[nativeId,factory])).rows[0];}
 private async eligible(db:DB,actor:TrustedActorContext,nativeId:string,factory:string|null){
  if(isRootActor(actor))return true;
  if(!isQcProgressActor(actor))return false;
  return (await db.query('SELECT digital_qc_report_allowed($1,$2,$3) AS allowed',[actor.actorId,nativeId,factory])).rows[0]?.allowed===true;
 }
 private async leader(db:PoolClient,actor:TrustedActorContext){
  if(isRootActor(actor))return true;
  for(const role of ['owner_group','production_management'])if(actor.actorRoles.includes(role)&&await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,role))return true;
  return false;
 }
 private mapRecord(row:Record<string,unknown>):QcProgressRecord{return {recordId:row.record_id as string,relatedProgressRecordId:row.related_progress_id as string|null,revision:Number(row.revision),kind:row.kind as QcProgressRecord['kind'],collectedAt:iso(row.collected_at as Date|null),recordedAt:iso(row.recorded_at as Date)!,actorName:row.actor_name as string,
  observations:row.observations as QcProgressRecord['observations'],criticalEvents:row.critical_events as string[],attachmentIds:row.attachment_ids as string[],reportIds:row.report_ids as string[],note:row.note as string};}
 async read(actor:TrustedActorContext,id:string,db:DB=this.database):Promise<QcProductionProgressSheet>{
  if(db===this.database){const client=await this.database.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const value=await this.read(actor,id,client);await client.query('COMMIT');return value;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
  await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');
  const task=await this.task(db,id),settings=await this.settings(db,id),lifecycle=await this.lifecycle(db,id);
  const time=await new ContextBusinessClock(this.database,db===this.database?undefined:db as PoolClient).read({kind:'order',id});
  const executions:QcProductionExecution[]=[];
  for(const evidence of await readQcExecutionEvidence(db,id,time.now,lifecycle.closed)){
   const {group,tracking,records,finished}=evidence,first=group.rows[0];
   executions.push({productionId:first.production_order_id,factoryDecisionId:first.factory_decision_id,supplierName:first.supplier_name_snapshot,status:first.execution_status,
    scopeRevision:group.scopeRevision,progressRevision:Number(records[0]?.revision??0),trackingId:tracking?.tracking_id??null,trackingStartedAt:iso(tracking?.started_at??null),trackingBasis:tracking?.basis??null,
    clock:evidence.clock,lineClocks:evidence.lineClocks,windows:evidence.windows,
    canRecord:!lifecycle.paused&&!finished&&await this.eligible(db,actor,first.production_order_id,first.factory_decision_id),
    lines:group.rows.map(r=>({lineId:r.line_id,position:Number(r.position),poNumber:r.po_number??null,color:r.color,quantity:Number(r.quantity),completedQuantity:Number(r.completed_quantity??0)})),records:records.map(r=>this.mapRecord(r))});
  }
  const archivedExecutions=[];
  const archives=(await db.query(`SELECT track.tracking_id,track.factory_decision_id,execution.supplier_name_snapshot FROM digital_qc_tracking_starts track
   JOIN sourcing_production_factory_orders execution ON execution.production_order_id=track.native_production_id AND execution.factory_decision_id IS NOT DISTINCT FROM track.factory_decision_id WHERE track.production_order_id=$1`,[id])).rows;
  for(const archive of archives){if(executions.some(e=>e.trackingId===archive.tracking_id))continue;
   const records=(await db.query('SELECT * FROM digital_qc_progress_records WHERE tracking_id=$1 ORDER BY revision DESC',[archive.tracking_id])).rows;
   if(records.length)archivedExecutions.push({factoryDecisionId:archive.factory_decision_id,supplierName:archive.supplier_name_snapshot,records:records.map(r=>this.mapRecord(r))});
  }
  return {archivedExecutions,viewerId:actor.actorId,orderId:id,asOf:time.now,canManage:isDigitalLeader(actor),canRecord:executions.some(e=>e.canRecord),paused:lifecycle.paused||lifecycle.closed,
   qcUserId:task?.assignee_id??null,qcName:task?.assignee_name??null,qualityLeadId:settings?.quality_lead_id??null,qualityLeadName:settings?.lead_name??null,settingsVersion:Number(settings?.version??0),executions};
 }
 private async transaction<T>(actor:TrustedActorContext,id:string,action:string,input:unknown,key:string,before:(db:PoolClient)=>Promise<void>,work:(db:PoolClient)=>Promise<T>):Promise<T>{
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new ApplicationError('VALIDATION_ERROR','缺少有效提交标识',400);
  const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');
   await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[id]);
   await db.query(`SELECT c.sourcing_case_id FROM sourcing_cases c JOIN digital_production_child_links link ON link.module='sourcing' AND link.child_id=c.sourcing_case_id WHERE link.production_order_id=$1 FOR UPDATE OF c`,[id]);
   await before(db);
   const command=`qc-progress:${id}:${action}`,payloadHash=hash(input),prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==payloadHash)conflict('提交标识已用于另一份内容，请先恢复原请求');await db.query('COMMIT');return prior.response as T;}
   const response=await work(db);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,payloadHash,JSON.stringify(response)]);
   await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_qc_progress',$5,$6)",[randomUUID(),actor.requestId,actor.actorId,`digital.qc.${action}`,id,JSON.stringify({input,response})]);
   await db.query('COMMIT');return response;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 private async currentGroup(db:DB,id:string,factory:string|null,scopeRevision:string){
  const group=(await this.executions(db,id)).find(g=>g.rows[0].factory_decision_id===factory);
  if(!group)conflict('本单当前没有该工厂的有效生产范围');
  if(group.scopeRevision!==scopeRevision)conflict('QC指派或工厂PO范围已变化，本次未覆盖，请核对最新范围');
  return group;
 }
 async submit(actor:TrustedActorContext,id:string,input:SubmitQcProgress){
  const parsed=SubmitQcProgressSchema.safeParse(input);if(!parsed.success)throw new ApplicationError('VALIDATION_ERROR',parsed.error.issues[0]?.message??'请检查生产进度',400);input=parsed.data;
  return this.transaction(actor,id,'submit',input,input.submissionId,async db=>{
   const task=await this.task(db,id);
   if(!isRootActor(actor)&&(!isQcProgressActor(actor)||task?.assignee_id!==actor.actorId||task.state==='cancelled'||!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,'quality_control')))digitalForbidden();
   if(!await memberCanWriteModule(db,actor.actorId,'sourcing'))digitalForbidden();
  },async db=>{
   const group=await this.currentGroup(db,id,input.factoryDecisionId,input.expectedScopeRevision),first=group.rows[0];
   const lifecycle=await this.lifecycle(db,id);if(lifecycle.paused||lifecycle.closed)conflict('本单已暂停或结案，原进度保留');
   if(!await this.eligible(db,actor,first.production_order_id,input.factoryDecisionId))digitalForbidden();
   if(first.execution_status!=='in_production')conflict('本工厂生产已结束，日常进度不能继续新增；数量订正仍由Root在原记录处理');
   let tracking=await this.tracking(db,first.production_order_id,input.factoryDecisionId);
   if(!tracking){
    if(input.kind!=='progress')conflict('尚无真实进度，请先记录本次现场观察，照片不能替代首次进度');
    await db.query(`INSERT INTO digital_qc_tracking_starts(tracking_id,production_order_id,native_production_id,factory_decision_id,started_at,basis,created_by,reason)
     VALUES($1,$2,$3,$4,$5,'first_progress',$6,'历史监督起点未知；从本次真实QC观察开始监督，不倒造历史逾期')`,[randomUUID(),id,first.production_order_id,input.factoryDecisionId,input.collectedAt,actor.actorId]);
    tracking=await this.tracking(db,first.production_order_id,input.factoryDecisionId);
   }
   const current=Number((await db.query('SELECT coalesce(max(revision),0)::int AS revision FROM digital_qc_progress_records WHERE tracking_id=$1',[tracking.tracking_id])).rows[0].revision);
   if(current!==input.expectedProgressRevision)conflict('已有新进度或照片记录，本次未覆盖，请读取最新内容');
   if(input.kind==='photos'&&!(await db.query("SELECT 1 FROM digital_qc_progress_records WHERE tracking_id=$1 AND record_id=$2 AND kind='progress'",[tracking.tracking_id,input.relatedProgressRecordId])).rowCount)conflict('补传照片须有本工厂原进度记录');
   const now=businessNow();if(input.collectedAt&&(Date.parse(input.collectedAt)>now.getTime()||Date.parse(input.collectedAt)<new Date(first.dispatched_at).getTime()))conflict('采集时间不能晚于当前或早于原派单事实；补录须保留真实时间');
   const observations=input.observations.map(o=>{const line=group.rows.find(r=>r.line_id===o.lineId);if(!line)conflict('观察PO不属于当前工厂范围');return {...o,allocationQuantity:Number(line.quantity),position:Number(line.position)};});
   const images=await db.query("SELECT attachment_id FROM attachments JOIN digital_qc_progress_uploads claim USING(attachment_id) WHERE claim.production_order_id=$3 AND claim.factory_decision_id IS NOT DISTINCT FROM $4::uuid AND attachment_id=ANY($1::uuid[]) AND uploaded_by=$2 AND status='ready' AND entity_type IS NULL AND entity_id IS NULL AND mime_type IN ('image/jpeg','image/png','image/webp') FOR UPDATE",[input.attachmentIds,actor.actorId,id,input.factoryDecisionId]);
   if(images.rowCount!==input.attachmentIds.length)conflict('现场照片须由本人上传且已就绪，不能借用其它单据或未完成附件');
   const recordId=randomUUID(),reported=observations.filter(o=>o.additionalFinishedQuantity!==undefined).map(o=>({observation:o,reportId:randomUUID()})),reportIds=reported.map(r=>r.reportId);
   const criticalEvents=new Set(input.criticalEvents);
   if(reported.length&&group.rows.every(r=>Number(r.completed_quantity??0)===0)&&!(await db.query("SELECT 1 FROM digital_qc_progress_records prior JOIN attachments photo ON photo.attachment_id=ANY(prior.attachment_ids) AND photo.status='ready' WHERE prior.tracking_id=$1 AND prior.critical_events @> ARRAY['first_piece']::text[] LIMIT 1",[tracking.tracking_id])).rowCount)criticalEvents.add('first_piece');
   if(criticalEvents.size&&!input.attachmentIds.length)conflict('首次成品量及开裁/首件现场事件须关联照片；普通周期没有新关键事件时无需重复传图');
   await db.query(`INSERT INTO digital_qc_progress_records(record_id,tracking_id,revision,kind,collected_at,actor_id,actor_name,scope_revision,observations,critical_events,attachment_ids,report_ids,note,related_progress_id)
    SELECT $1,$2,$3,$4,$5,id,display_name,$7,$8,$9,$10,$11,$12,$13 FROM app_users WHERE id=$6`,[recordId,tracking.tracking_id,current+1,input.kind,input.collectedAt,actor.actorId,input.expectedScopeRevision,JSON.stringify(observations),[...criticalEvents],input.attachmentIds,reportIds,input.note,input.relatedProgressRecordId]);
   const reporting=new ProductionReportingService(this.database);
   for(const row of reported)await reporting.reportQcWithClient(db,actor,first.production_order_id,{factoryDecisionId:input.factoryDecisionId,position:row.observation.position,businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(input.collectedAt!)),quantity:row.observation.additionalFinishedQuantity!},recordId,row.reportId);
   await db.query("UPDATE attachments SET entity_type='digital_qc_progress',entity_id=$1,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($2::uuid[])",[recordId,input.attachmentIds]);
   return {submissionId:input.submissionId,recordId,progressRevision:current+1,reportIds,attachmentIds:input.attachmentIds,committed:true as const};
  });
 }
 async settingsCommand(actor:TrustedActorContext,id:string,input:{expectedVersion:number;qualityLeadId:string|null},key:string){
  return this.transaction(actor,id,'settings',input,key,async db=>{if(!await this.leader(db,actor))digitalForbidden();},async db=>{
   const current=await this.settings(db,id);if(Number(current?.version??0)!==input.expectedVersion)conflict('质检负责人配置已变化，请读取最新内容');
   if(input.qualityLeadId&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(input.qualityLeadId,'quality_control'))conflict('请指定在职且具有QC岗位的质检负责人；不新增岗位权限');
   const audit=randomUUID();await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'digital.qc.settings','digital_production_order',$4,$5)",[audit,actor.requestId,actor.actorId,id,JSON.stringify(input)]);
   await db.query('INSERT INTO digital_qc_supervision_settings(production_order_id,version,quality_lead_id,changed_by,audit_id) VALUES($1,$2,$3,$4,$5)',[id,input.expectedVersion+1,input.qualityLeadId,actor.actorId,audit]);return {version:input.expectedVersion+1,committed:true as const};
  });
 }
 async adopt(actor:TrustedActorContext,id:string,input:{factoryDecisionId:string|null;expectedScopeRevision:string;reason:string},key:string){
  return this.transaction(actor,id,'adopt',input,key,async db=>{if(!await this.leader(db,actor))digitalForbidden();await this.currentGroup(db,id,input.factoryDecisionId,input.expectedScopeRevision);},async db=>{
   const group=await this.currentGroup(db,id,input.factoryDecisionId,input.expectedScopeRevision),first=group.rows[0];
   const state=await this.lifecycle(db,id);if(state.paused||state.closed||first.execution_status!=='in_production')conflict('仅当前有效在途生产范围可开始监督');
   if(await this.tracking(db,first.production_order_id,input.factoryDecisionId))conflict('该工厂已有监督起点，不能重新开始以消除既有逾期');
   const trackingId=randomUUID(),startedAt=businessNow().toISOString();
   await db.query(`INSERT INTO digital_qc_tracking_starts(tracking_id,production_order_id,native_production_id,factory_decision_id,started_at,basis,created_by,reason)
    VALUES($1,$2,$3,$4,$5,'explicit_supervision',$6,$7)`,[trackingId,id,first.production_order_id,input.factoryDecisionId,startedAt,actor.actorId,input.reason]);return {trackingId,startedAt,committed:true as const};
  });
 }
 async authorizeUpload(actor:TrustedActorContext,id:string,factory:string|null,scopeRevision:string){
  const sheet=await this.read(actor,id),execution=sheet.executions.find(e=>e.factoryDecisionId===factory);
  if(!execution)conflict('当前工厂范围已不存在，请从订单重新进入');if(!execution.canRecord)digitalForbidden();if(execution.scopeRevision!==scopeRevision)conflict('工厂范围或QC指派已变化，请读取最新内容后上传');
 }
 async registerUpload(actor:TrustedActorContext,id:string,factory:string|null,scopeRevision:string,attachmentId:string){
  return this.transaction(actor,id,'upload',{factory,scopeRevision,attachmentId},attachmentId,async db=>{
   const group=await this.currentGroup(db,id,factory,scopeRevision);if(!await this.eligible(db,actor,group.rows[0].production_order_id,factory))digitalForbidden();
   if(!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,'quality_control'))digitalForbidden();
  },async db=>{
   const image=(await db.query("SELECT attachment_id FROM attachments WHERE attachment_id=$1 AND uploaded_by=$2 AND status IN ('pending','ready') AND entity_type IS NULL AND entity_id IS NULL AND mime_type IN ('image/jpeg','image/png','image/webp') FOR UPDATE",[attachmentId,actor.actorId])).rows[0];if(!image)conflict('该图片不是当前账号的可用待办附件');
   await db.query('INSERT INTO digital_qc_progress_uploads(attachment_id,production_order_id,factory_decision_id,scope_revision,actor_id) VALUES($1,$2,$3,$4,$5)',[attachmentId,id,factory,scopeRevision,actor.actorId]);return {attachmentId,registered:true as const};
  });
 }
 async authorizePendingUpload(actor:TrustedActorContext,id:string,attachmentId:string){
  const claim=(await this.database.query('SELECT * FROM digital_qc_progress_uploads WHERE production_order_id=$1 AND attachment_id=$2 AND actor_id=$3',[id,attachmentId,actor.actorId])).rows[0];if(!claim)digitalForbidden();
  await this.authorizeUpload(actor,id,claim.factory_decision_id,claim.scope_revision);
 }
 async canDownload(actor:TrustedActorContext,id:string,attachmentId:string){
  if(!await new DigitalProductionAccessPolicy(this.database).allowed(actor,'order',id,'technical'))return false;
  return Boolean((await this.database.query(`SELECT 1 FROM digital_qc_progress_records r JOIN digital_qc_tracking_starts t USING(tracking_id)
   JOIN attachments a ON a.attachment_id=ANY(r.attachment_ids) AND a.entity_type='digital_qc_progress' AND a.entity_id=r.record_id::text
   WHERE t.production_order_id=$1 AND a.attachment_id=$2 AND a.status='ready'`,[id,attachmentId])).rowCount);
 }
}
