import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import type {RootAuthority} from '../access/root-authority.js';
import {isRootActor} from '../access/business-authority.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {BulkPreparationService} from './bulk-preparation-service.js';
import {DigitalProductionTaskService} from './task-service.js';
import {productionReadiness} from './production-readiness-repository.js';

/** One approved legacy order. This is not a configurable business exemption. */
export const SCOPED_PRESHRINK_CORRECTION_ORDER='c05e324b-53b9-4fc0-ba0f-65c27eb0a245';
const conflict=(message:string):never=>{throw new ApplicationError('BULK_PRESHRINK_CORRECTION_CONFLICT',message,409);};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rangeRef=z.object({rangeId:z.string().uuid(),kind:z.enum(['纸样完成','唛架完成']),version:z.number().int().positive()}).strict();
export const PreshrinkCorrectionPreviewSchema=z.object({preparationId:z.string().uuid(),preshrinkTaskId:z.string().uuid()}).strict();
const targetSchema=PreshrinkCorrectionPreviewSchema.extend({
 instructionVersion:z.literal(3),sourceId:z.string().uuid(),sourceRound:z.number().int().positive(),slaSnapshotId:z.string().uuid(),
 patternTaskId:z.string().uuid(),patternFactId:z.string().uuid(),markerFactId:z.string().uuid(),ranges:z.array(rangeRef).min(3),
}).strict();
export const PreshrinkCorrectionApplySchema=z.object({target:targetSchema,expectedFingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(1).max(1000)}).strict();
type PreviewInput=z.infer<typeof PreshrinkCorrectionPreviewSchema>;
type CorrectionTarget=z.infer<typeof targetSchema>;

export class BulkPreshrinkCorrectionService {
 constructor(private readonly database:Pool,private readonly root:RootAuthority){}

 private async transaction<T>(actor:TrustedActorContext,id:string,action:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.database.connect();
  try{
   await client.query('BEGIN');
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   // Recheck the real enabled DingTalk Root identity before even returning an old receipt.
   if(!isRootActor(actor)||!await this.root.isRootUser(actor.actorId,client,true))throw new ApplicationError('FORBIDDEN','仅当前有效Root可办理本次受限纠正',403);
   if(id!==SCOPED_PRESHRINK_CORRECTION_ORDER)conflict('此纠正仅适用于已批准的指定旧单');
   if(!(await client.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[id])).rowCount)conflict('指定母单不存在');
   const result=await action(client);
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }

 private async basis(db:PoolClient,id:string,input:PreviewInput){
  const prep=(await db.query('SELECT * FROM digital_bulk_preparations WHERE preparation_id=$1 AND production_order_id=$2 FOR SHARE',[input.preparationId,id])).rows[0];
  if(!prep||prep.instruction_version!==3||prep.workflow_version!==2||prep.preshrink!=='需要预缩'||!prep.sla_snapshot_id)conflict('指定准备不符合原v3预缩错误形态');
  if((await db.query('SELECT 1 FROM digital_bulk_preshrink_corrections WHERE preparation_id=$1',[prep.preparation_id])).rowCount)conflict('该准备已完成受限纠正，请使用原操作标识恢复结果');
  const pointer=(await db.query('SELECT * FROM digital_instruction_documents WHERE production_order_id=$1 FOR SHARE',[id])).rows[0];
  const bulk=new BulkPreparationService(this.database),gates=await bulk.gates(db,id);
  if(pointer?.published_version!==3||!gates.instructionValid||gates.instruction?.version!==3||gates.instruction.document.preshrink!=='无需预缩'
   ||gates.order.source_id!==prep.source_id||gates.source?.round_number!==prep.source_round||gates.instruction.source_round!==prep.source_round)conflict('当前发布制单、原开发轮次或预缩要求已变化');
  if(gates.terminal)conflict('已暂停、取消或特殊结案的订单不能执行本次纠正');
  if(!gates.customerConfirmed)conflict('当前客户确认或技术依据已失效，请先按原流程核对');
  const tasks=(await db.query(`SELECT t.*,a.production_order_id,a.task_kind,a.assignee_id,a.required_role FROM digital_production_tasks t
   JOIN digital_production_task_access a USING(task_id) WHERE t.route_instance_id=$1 ORDER BY t.task_id FOR UPDATE OF t,a`,[prep.preparation_id])).rows;
  const pattern=tasks.find(row=>row.task_kind==='bulk_pattern'&&row.state==='completed');
  const shrink=tasks.find(row=>row.task_id===input.preshrinkTaskId);
  if(!pattern||pattern.production_order_id!==id||pattern.route_version!==3||tasks.filter(row=>row.task_kind==='bulk_pattern').length!==1)conflict('原纸样及唛架任务尚未完整完成或归属不一致');
  if(!shrink||shrink.production_order_id!==id||shrink.task_kind!=='warehouse_preshrink'||shrink.node_key!=='warehouse_preshrink'||shrink.route_version!==3
   ||!['pending','ready','blocked'].includes(shrink.state)||shrink.completed_at)conflict('指定预缩任务已结束、归属不符或版本已变化');
  const shrinks=tasks.filter(row=>row.task_kind==='warehouse_preshrink');
  if(shrinks.some(row=>row.state==='completed'||row.completed_at)||shrinks.filter(row=>['pending','ready','blocked'].includes(row.state)).length!==1)conflict('预缩存在实际完成或其它未完成任务，不能扩大纠正范围');
  const facts=(await db.query('SELECT * FROM digital_bulk_preparation_facts WHERE preparation_id=$1 ORDER BY kind,fact_id',[prep.preparation_id])).rows;
  const patternFact=facts.find(row=>row.kind==='纸样完成'),markerFact=facts.find(row=>row.kind==='唛架完成');
  if(!patternFact||!markerFact||patternFact.task_id!==pattern.task_id||markerFact.task_id!==pattern.task_id||facts.some(row=>['预缩完成','无需预缩'].includes(row.kind)))conflict('原纸样/唛架完成依据不符，或已有预缩/无需预缩事实');
  const lines=(await db.query('SELECT * FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY line_id',[id])).rows;
  const lineIds=lines.map(row=>row.line_id as string);
  const sizes=(await db.query('SELECT * FROM digital_production_po_sizes WHERE line_id=ANY($1::uuid[]) ORDER BY line_id,size',[lineIds])).rows;
  const ranges=(await db.query('SELECT * FROM digital_bulk_work_ranges WHERE preparation_id=$1 ORDER BY kind,version,range_id',[prep.preparation_id])).rows;
  if(lineIds.length<2||ranges.some(row=>row.task_id!==pattern.task_id||row.line_ids.some((line:string)=>!lineIds.includes(line))||new Set(row.line_ids).size!==row.line_ids.length))conflict('原局部至全色范围链不属于当前母单');
  for(const kind of ['纸样完成','唛架完成']){
   const history=ranges.filter(row=>row.kind===kind),last=history.at(-1);
   if(!last?.complete||last.pending_material_ids.length||last.line_ids.length!==lineIds.length||history.some((row,index)=>row.version!==index+1))conflict('纸样及唛架须已有连续、完整覆盖全色的原完成范围');
  }
  if(!ranges.some(row=>row.kind==='纸样完成'&&!row.complete&&row.line_ids.length>0&&row.line_ids.length<lineIds.length))conflict('缺少原纸样局部至全色的结构化记录');
  const taskIds=tasks.map(row=>row.task_id as string);
  const events=(await db.query('SELECT * FROM digital_production_task_events WHERE task_id=ANY($1::uuid[]) ORDER BY recorded_at,event_id',[taskIds])).rows;
  if(events.some(row=>shrinks.some(task=>task.task_id===row.task_id)&&row.event_kind==='completed'))conflict('原预缩已经留有完成事件，不得用纠正抹除实绩');
  const cutting=(await db.query(`SELECT r.* FROM digital_production_child_links l JOIN cutting_orders c ON c.sourcing_case_id=l.child_id
   JOIN cutting_records r ON r.cutting_order_id=c.cutting_order_id WHERE l.module='sourcing' AND l.production_order_id=$1 ORDER BY r.cutting_record_id`,[id])).rows;
  if(cutting.length)conflict('本单已有实际开裁记录，不能执行此纠正');
  const conditions=(await db.query('SELECT * FROM digital_production_task_conditions WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,condition_key',[taskIds])).rows;
  const dependencies=(await db.query('SELECT * FROM digital_production_task_dependencies WHERE task_id=ANY($1::uuid[]) OR predecessor_id=ANY($1::uuid[]) ORDER BY task_id,predecessor_id',[taskIds])).rows;
  const deadlines=(await db.query('SELECT * FROM digital_production_deadline_revisions WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,revision_id',[taskIds])).rows;
  const clocks=(await db.query('SELECT * FROM production_order_node_clocks WHERE node_instance_id=ANY($1::uuid[]) ORDER BY node_instance_id',[taskIds])).rows;
  if(clocks.some(clock=>clock.completed_at&&shrinks.some(task=>task.task_id===clock.node_instance_id)))conflict('原预缩时钟已有完成实绩，不能执行纠正');
  const lifecycle=(await db.query("SELECT * FROM digital_production_resource_lifecycle WHERE (resource_kind='order' AND resource_id=$1) OR (resource_kind='source' AND resource_id=$2) ORDER BY resource_kind,resource_id",[id,prep.source_id])).rows;
  const readiness=await productionReadiness(db,id);
  const dispatch=(await db.query('SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1 FOR SHARE',[id])).rows;
  const windows=(await db.query('SELECT * FROM digital_preparation_windows WHERE production_order_id=$1 ORDER BY kind,epoch,window_id',[id])).rows;
  const target:CorrectionTarget={preparationId:prep.preparation_id,preshrinkTaskId:shrink.task_id,instructionVersion:3,sourceId:prep.source_id,sourceRound:prep.source_round,slaSnapshotId:prep.sla_snapshot_id,
   patternTaskId:pattern.task_id,patternFactId:patternFact.fact_id,markerFactId:markerFact.fact_id,ranges:ranges.map(row=>({rangeId:row.range_id,kind:row.kind,version:row.version}))};
  const basis={rule:'scoped-v3-preshrink-correction-20261103',order:gates.order,pointer,instruction:gates.instruction,source:gates.source,prep,lines,sizes,facts,ranges,tasks,events,conditions,dependencies,deadlines,clocks,lifecycle,cutting,
   readinessRevision:readiness.revision,customerConfirmed:gates.customerConfirmed,dispatch,windows,fabric:gates.fabric,approval:gates.approval??null};
  return {orderId:id,target,expectedFingerprint:hash(basis),before:'需要预缩' as const,after:'无需预缩' as const,basis};
 }

 async preview(actor:TrustedActorContext,id:string,raw:unknown){
  const input=PreshrinkCorrectionPreviewSchema.parse(raw);
  return this.transaction(actor,id,db=>this.basis(db,id,input));
 }

 async apply(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  const input=PreshrinkCorrectionApplySchema.parse(raw);
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))conflict('缺少有效操作标识');
  return this.transaction(actor,id,async db=>{
   const command=`bulk-preshrink-correction:${id}`,payloadHash=hash(input);
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==payloadHash)conflict('操作标识已用于不同纠正内容');return prior.response;}
   const preview=await this.basis(db,id,input.target);
   if(preview.expectedFingerprint!==input.expectedFingerprint||hash(preview.target)!==hash(input.target))conflict('制单、范围、任务或质量依据已变化，请重新只读预览');
   const correctionId=randomUUID(),factId=randomUUID(),auditId=randomUUID(),at=businessNow().toISOString();
   const eventId=await new DigitalProductionTaskService(this.database).retirePreshrinkWithClient(db,actor,id,input.target.preparationId,input.target.preshrinkTaskId,correctionId);
   await db.query("INSERT INTO digital_bulk_preparation_facts(fact_id,preparation_id,kind,task_id,actor_id,recorded_at) VALUES($1,$2,'无需预缩',NULL,$3,$4)",[factId,input.target.preparationId,actor.actorId,at]);
   const result={correctionId,orderId:id,target:preview.target,requirement:'无需预缩',factId,cancellationEventId:eventId,auditEventId:auditId};
   await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state,reason)
    VALUES($1,$2,$3,'digital_bulk_preshrink_corrected','digital_bulk_preparation',$4,$5,$6,$7)`,[auditId,actor.requestId,actor.actorId,id,JSON.stringify({requirement:'需要预缩',expectedFingerprint:input.expectedFingerprint,target:preview.target}),JSON.stringify(result),input.reason]);
   const target=input.target;
   await db.query(`INSERT INTO digital_bulk_preshrink_corrections(correction_id,production_order_id,preparation_id,instruction_version,source_id,source_round,sla_snapshot_id,
    pattern_task_id,pattern_fact_id,marker_fact_id,preshrink_task_id,no_preshrink_fact_id,cancellation_event_id,audit_event_id,actor_id,expected_fingerprint,reason,recorded_at)
    VALUES($1,$2,$3,3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[correctionId,id,target.preparationId,target.sourceId,target.sourceRound,target.slaSnapshotId,
    target.patternTaskId,target.patternFactId,target.markerFactId,target.preshrinkTaskId,factId,eventId,auditId,actor.actorId,input.expectedFingerprint,input.reason,at]);
   for(const range of target.ranges)await db.query('INSERT INTO digital_bulk_preshrink_correction_ranges(correction_id,range_id,kind,version) VALUES($1,$2,$3,$4)',[correctionId,range.rangeId,range.kind,range.version]);
   // Converge this existing route through the ordinary fabric/approval gates,
   // without running initialization or order-wide supersession.
   await new BulkPreparationService(this.database).syncCorrectedPreparation(db,actor,id,target.preparationId,correctionId);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,payloadHash,JSON.stringify(result)]);
   return result;
  });
 }
}
