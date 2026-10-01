import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BulkDispatch, BulkCompletion, BulkPreparationSheet } from "@dx-rework/contracts/bulk-preparation";
import type { InstructionDocument } from "@dx-rework/contracts/production-instruction";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound, isDigitalLeader, isDigitalTechnicalManager } from "./access-policy.js";
import { DigitalProductionTaskService } from "./task-service.js";
import { developmentDocumentRow } from "./development-round-repository.js";
import { resolveDigitalChild } from "./child-link-repository.js";
type DB=Pick<Pool|PoolClient,"query">;
const fail=(message:string):never=>{throw new ApplicationError("BULK_PREPARATION_CONFLICT",message,409);};
const lock=(db:DB)=>db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
export class BulkPreparationService {
 constructor(private readonly database:Pool){}
 private tasks(){return new DigitalProductionTaskService(this.database);}
 async gates(db:DB,id:string){
  const order=(await db.query("SELECT * FROM digital_production_orders WHERE production_order_id=$1",[id])).rows[0]??digitalNotFound();
  const source=order.source_id?await developmentDocumentRow(db,order.source_id):null;
  const instruction=(await db.query(`SELECT v.* FROM digital_instruction_documents d JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version WHERE d.production_order_id=$1`,[id])).rows[0];
  const customerConfirmed=Boolean(source?.status==='published'&&(await db.query("SELECT 1 FROM digital_development_route_facts WHERE source_id=$1 AND route_version=$2 AND kind='客户样板确认'",[order.source_id,source.round_number])).rowCount);
  const sourcing=(await db.query("SELECT s.* FROM digital_production_child_links l JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id WHERE l.module='sourcing' AND l.production_order_id=$1",[id])).rows[0];
  let approval;
  if(sourcing){
   await resolveDigitalChild(db,'sourcing',sourcing.sourcing_case_id,sourcing.workflow_generation);
   approval=(await db.query(`SELECT a.* FROM sourcing_approval_snapshots a WHERE a.sourcing_case_id=$1 AND a.sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_decisions WHERE sourcing_case_id=$1 ORDER BY decision_version DESC LIMIT 1)
    AND EXISTS(SELECT 1 FROM sourcing_owner_decisions d WHERE d.sourcing_case_id=$1 AND d.sourcing_decision_id=a.sourcing_decision_id AND d.decision='approved') ORDER BY a.approved_at DESC LIMIT 1`,[sourcing.sourcing_case_id])).rows[0];
  }
  const instructionValid=Boolean(instruction&&source&&instruction.source_round===source.round_number&&['需要预缩','无需预缩'].includes(instruction.document.preshrink));
  const ownerApproved=Boolean(approval&&!sourcing?.deleted_at);
  const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE (resource_kind='order' AND resource_id=$1) OR (resource_kind='source' AND resource_id=$2)",[id,order.source_id])).rows;
  const reasons:string[]=[];
  if(!customerConfirmed)reasons.push('当前开发轮次尚未确认客户样板');
  if(!ownerApproved)reasons.push('原外发老板批准尚未通过或已换版');
  if(!instructionValid)reasons.push('请核对当前开发资料并发布有效大货制单');
  if(lifecycle.some(r=>r.state!=='active'))reasons.push('母单或开发来源已暂停/取消');
  return {order,source,instruction,approval,customerConfirmed,ownerApproved,instructionValid,reasons};
 }
 private async current(db:DB,id:string,g:Awaited<ReturnType<BulkPreparationService['gates']>>){
  if(g.reasons.length)return null;
  return (await db.query("SELECT * FROM digital_bulk_preparations WHERE production_order_id=$1 AND instruction_version=$2 AND source_round=$3",[id,g.instruction.version,g.source!.round_number])).rows[0]??null;
 }
 private async routeTasks(db:DB,preparationId:string){return (await db.query("SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.route_instance_id=$1 ORDER BY t.created_at,t.task_id",[preparationId])).rows;}
 private async fact(db:PoolClient,actor:TrustedActorContext,preparationId:string,kind:string,taskId:string|null){await db.query("INSERT INTO digital_bulk_preparation_facts(fact_id,preparation_id,kind,task_id,actor_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(preparation_id,kind) DO NOTHING",[randomUUID(),preparationId,kind,taskId,actor.actorId]);}
 private async validAssignee(db:DB,id:string|null|undefined,role:string){return id&&await new DigitalProductionAccessPolicy(db).activeRole(id,role)?id:null;}
 private async nextOccurrence(db:DB,id:string,kind:string){return Number((await db.query("SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind=$2",[id,kind])).rows[0].n);}
 async sync(db:PoolClient,actor:TrustedActorContext,id:string){
  if(!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return;
  await lock(db);await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE",[id]);
  const g=await this.gates(db,id);
  // Never rewrite or supersede a route once a real cutting fact exists.
  if((await db.query("SELECT 1 FROM digital_production_child_links l JOIN cutting_orders c ON c.sourcing_case_id=l.child_id JOIN cutting_records r ON r.cutting_order_id=c.cutting_order_id WHERE l.module='sourcing' AND l.production_order_id=$1 LIMIT 1",[id])).rowCount){if(g.instruction&&g.source&&g.instruction.source_round!==g.source.round_number)fail('已开始实裁，不能发布影响本单大货的开发修改');return;}
  if(g.reasons.length){if(!g.instructionValid||!g.customerConfirmed)await this.tasks().supersedeBulkTasksWithClient(db,actor,id);return;}
  let prep=await this.current(db,id,g);
  if(!prep){
   await this.tasks().supersedeBulkTasksWithClient(db,actor,id);
   const pid=randomUUID(),document=g.instruction.document as InstructionDocument;
   await db.query("INSERT INTO digital_bulk_preparations(preparation_id,production_order_id,instruction_version,approval_snapshot_id,source_id,source_round,preshrink,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[pid,id,g.instruction.version,g.approval.sourcing_approval_snapshot_id,g.order.source_id,g.source!.round_number,document.preshrink,actor.actorId]);
   prep=(await db.query("SELECT * FROM digital_bulk_preparations WHERE preparation_id=$1",[pid])).rows[0];
   const dispatch=(await db.query("SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1",[id])).rows[0];
   for(const kind of ['bulk_pattern',...(document.preshrink==='需要预缩'?['warehouse_preshrink']:[])] as Array<'bulk_pattern'|'warehouse_preshrink'>){
    const assignee=await this.validAssignee(db,kind==='bulk_pattern'?dispatch?.pattern_worker_id:dispatch?.warehouse_worker_id,kind==='bulk_pattern'?'pattern_room_worker':'warehouse_receiver');
    const task=await this.tasks().createWithClient(db,actor,{resource:{kind:'order',id},kind,routeId:pid,routeVersion:g.instruction.version,occurrence:await this.nextOccurrence(db,id,kind),assigneeId:assignee,conditions:['handover_received']});
    await this.tasks().setConditionWithClient(db,actor,task.taskId,'owner_approved',true,new Date().toISOString(),'客户样板、原批准与制单已齐');
    if(kind==='warehouse_preshrink'&&assignee)await this.tasks().setConditionWithClient(db,actor,task.taskId,'handover_received',true,new Date().toISOString(),'整批预缩已可办理');
   }
   if(document.preshrink==='无需预缩')await this.fact(db,actor,pid,'无需预缩',null);
  }
  const tasks=await this.routeTasks(db,prep.preparation_id);
  const pattern=tasks.find(t=>t.task_kind==='bulk_pattern'),preshrink=tasks.find(t=>t.task_kind==='warehouse_preshrink');
  if(pattern?.state==='completed'&&(prep.preshrink==='无需预缩'||preshrink?.state==='completed')&&!tasks.some(t=>t.task_kind==='bulk_cutting')){
   const dispatch=(await db.query("SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1",[id])).rows[0];
   const task=await this.tasks().createWithClient(db,actor,{resource:{kind:'order',id},kind:'bulk_cutting',routeId:prep.preparation_id,routeVersion:prep.instruction_version,occurrence:await this.nextOccurrence(db,id,'bulk_cutting'),assigneeId:await this.validAssignee(db,dispatch?.cutting_worker_id,'cutting_worker')});
   for(const condition of ['owner_approved','pattern_ready','preshrink_ready'] as const)await this.tasks().setConditionWithClient(db,actor,task.taskId,condition,true,new Date().toISOString(),'全部PO前置汇合');
  }
 }
 async syncSource(db:PoolClient,actor:TrustedActorContext,sourceId:string){
  if(!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return;
  for(const row of (await db.query("SELECT production_order_id FROM digital_production_orders WHERE source_id=$1 ORDER BY production_order_id",[sourceId])).rows)await this.sync(db,actor,row.production_order_id);
 }
 async read(actor:TrustedActorContext,id:string,db:DB=this.database):Promise<BulkPreparationSheet>{
  await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');const g=await this.gates(db,id),prep=await this.current(db,id,g);
  const row=(await db.query("SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1",[id])).rows[0];
  return {orderId:id,instructionVersion:g.instruction?.version??null,sourceRound:g.source?.round_number??null,customerConfirmed:g.customerConfirmed,ownerApproved:g.ownerApproved,instructionValid:g.instructionValid,reasons:g.reasons,preparationId:prep?.preparation_id??null,preshrink:g.instruction?.document.preshrink??null,
   dispatch:{version:row?.version??0,patternWorkerId:row?.pattern_worker_id??null,warehouseWorkerId:row?.warehouse_worker_id??null,cuttingWorkerId:row?.cutting_worker_id??null},canDispatchPattern:isDigitalLeader(actor)||isDigitalTechnicalManager(actor)||actor.actorRoles.includes('development_clerk'),canDispatchWarehouse:isDigitalLeader(actor),
   facts:prep?(await db.query('SELECT kind,recorded_at AS "recordedAt" FROM digital_bulk_preparation_facts WHERE preparation_id=$1 ORDER BY recorded_at',[prep.preparation_id])).rows:[],tasks:prep?await Promise.all((await this.routeTasks(db,prep.preparation_id)).map(t=>this.tasks().read(actor,t.task_id,db))):[]};
 }
 private async command(actor:TrustedActorContext,id:string,action:string,input:unknown,key:string,work:(db:PoolClient)=>Promise<void>){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');const db=await this.database.connect();try{
   await db.query('BEGIN');await lock(db);await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');
   await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE",[id]);
   const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex'),command=`bulk:${id}:${action}`;
   const prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior&&prior.payload_hash!==hash)fail('操作标识已用于不同内容');
   if(prior){await db.query('COMMIT');return prior.response as BulkPreparationSheet;}
   const state=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1",[id])).rows[0]?.state;if(state&&state!=='active')fail('母单已暂停或取消');
   await work(db);const result=await this.read(actor,id,db);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);
   await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_bulk_preparation',$5,$6)",[randomUUID(),actor.requestId,actor.actorId,action,id,JSON.stringify(input)]);
   await db.query('COMMIT');return result;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async dispatch(actor:TrustedActorContext,id:string,input:BulkDispatch,key:string){
  if(!isDigitalLeader(actor)&&!isDigitalTechnicalManager(actor)&&!actor.actorRoles.includes('development_clerk'))digitalForbidden();
  return this.command(actor,id,'dispatch',input,key,async db=>{
   const before=(await db.query('SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1',[id])).rows[0];if((before?.version??0)!==input.expectedVersion)fail('派工已更新，请刷新');
   if(!isDigitalLeader(actor)&&(input.warehouseWorkerId!==undefined&&input.warehouseWorkerId!==(before?.warehouse_worker_id??null)||input.cuttingWorkerId!==undefined&&input.cuttingWorkerId!==(before?.cutting_worker_id??null)))digitalForbidden();
   const warehouse=input.warehouseWorkerId===undefined?before?.warehouse_worker_id??null:input.warehouseWorkerId,cutting=input.cuttingWorkerId===undefined?before?.cutting_worker_id??null:input.cuttingWorkerId;
   for(const [person,role] of [[input.patternWorkerId,'pattern_room_worker'],[warehouse,'warehouse_receiver'],[cutting,'cutting_worker']] as const)if(person&&!await new DigitalProductionAccessPolicy(db).activeRole(person,role))fail('主办人必须为在职有效对应岗位');
   await db.query(`INSERT INTO digital_bulk_dispatch(production_order_id,pattern_worker_id,warehouse_worker_id,cutting_worker_id,changed_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(production_order_id) DO UPDATE SET version=digital_bulk_dispatch.version+1,pattern_worker_id=$2,warehouse_worker_id=$3,cutting_worker_id=$4,changed_by=$5,changed_at=CURRENT_TIMESTAMP`,[id,input.patternWorkerId,warehouse,cutting,actor.actorId]);
   await this.sync(db,actor,id);const g=await this.gates(db,id),prep=await this.current(db,id,g);
   if(input.deliverPattern&&(!prep||!input.patternWorkerId))fail('三项前置通过并指定纸样师后才能派交');
   if(!prep)return;
   const tasks=await this.routeTasks(db,prep.preparation_id);
   for(const t of tasks){
    const assignee=t.task_kind==='bulk_pattern'?input.patternWorkerId:t.task_kind==='warehouse_preshrink'?warehouse:cutting;
    if(assignee&&assignee!==t.assignee_id&&!['completed','cancelled'].includes(t.state))await this.tasks().reassignWithClient(db,actor,t.task_id,assignee);
    if(t.task_kind==='warehouse_preshrink'&&warehouse&&t.state==='pending')await this.tasks().setConditionWithClient(db,actor,t.task_id,'handover_received',true,new Date().toISOString(),'预缩主办已到位');
    if(t.task_kind==='bulk_pattern'&&input.deliverPattern&&t.state==='pending'){
     await this.fact(db,actor,prep.preparation_id,'纸样派交',t.task_id);await this.tasks().setConditionWithClient(db,actor,t.task_id,'handover_received',true,new Date().toISOString(),'文员已派交大货纸样唛架');
    }
   }
  });
 }
 async complete(actor:TrustedActorContext,id:string,input:BulkCompletion,key:string){return this.command(actor,id,'complete',input,key,async db=>{
  const g=await this.gates(db,id),prep=await this.current(db,id,g);if(!prep||prep.preparation_id!==input.preparationId)fail(g.reasons.join('；')||'技术版本已更新，不能沿用旧版完成');
  const tasks=await this.routeTasks(db,prep.preparation_id),task=tasks.find(t=>t.task_kind===(input.kind==='预缩完成'?'warehouse_preshrink':'bulk_pattern'));
  if(!task)fail('本路线不含此任务');await new DigitalProductionAccessPolicy(db).assert(actor,'task',task.task_id,'execute');
  if((await db.query('SELECT 1 FROM digital_bulk_preparation_facts WHERE preparation_id=$1 AND kind=$2',[prep.preparation_id,input.kind])).rowCount)return;
  if(task.state!=='ready')fail('任务尚不可办理');
  await this.fact(db,actor,prep.preparation_id,input.kind,task.task_id);
  const facts=(await db.query('SELECT kind FROM digital_bulk_preparation_facts WHERE preparation_id=$1',[prep.preparation_id])).rows.map(r=>r.kind);
  if(input.kind==='预缩完成'||facts.includes('纸样完成')&&facts.includes('唛架完成')){
   await this.tasks().setConditionWithClient(db,actor,task.task_id,'business_recorded',true,new Date().toISOString(),'产前完成事实已齐');
   await this.tasks().completeWithClient(db,actor,task.task_id,{note:input.kind},`bulk-complete:${prep.preparation_id}:${task.task_kind}`);
  }
  await this.sync(db,actor,id);
 });}
}
export async function syncBulkSourcing(db:PoolClient,pool:Pool,actor:TrustedActorContext,caseId:string){
 if(!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return;
 const row=(await db.query("SELECT workflow_generation FROM sourcing_cases WHERE sourcing_case_id=$1",[caseId])).rows[0];
 if(!row||row.workflow_generation!=='digital_production_v1')return;
 const id=await resolveDigitalChild(db,'sourcing',caseId,row.workflow_generation);await new BulkPreparationService(pool).sync(db,actor,id!);
}
export async function digitalCuttingGate(db:DB,pool:Pool,cuttingId:string){
 const row=(await db.query("SELECT c.sourcing_case_id,to_jsonb(s)->>'workflow_generation' AS generation FROM cutting_orders c JOIN sourcing_cases s USING(sourcing_case_id) WHERE c.cutting_order_id=$1",[cuttingId])).rows[0];
 if(!row)return null;
 if(row.generation!=='digital_production_v1'){if((await db.query("SELECT to_regclass('digital_production_child_links') AS relation")).rows[0]?.relation)await resolveDigitalChild(db,'sourcing',row.sourcing_case_id,'legacy');return null;}
 const id=await resolveDigitalChild(db,'sourcing',row.sourcing_case_id,'digital_production_v1');
 const g=await new BulkPreparationService(pool).gates(db,id!);if(g.reasons.length)return {orderId:id!,ready:false,reason:g.reasons.join('；')};
 const task=(await db.query(`SELECT t.state FROM digital_bulk_preparations p JOIN digital_production_tasks t ON t.route_instance_id=p.preparation_id JOIN digital_production_task_access a USING(task_id)
  WHERE p.production_order_id=$1 AND p.instruction_version=$2 AND p.source_round=$3 AND a.task_kind='bulk_cutting'`,[id,g.instruction.version,g.source!.round_number])).rows[0];
 return {orderId:id!,ready:task?.state==='ready'||task?.state==='completed',reason:task?.state==='ready'||task?.state==='completed'?'':'纸样、唛架及预缩条件未齐'};
}
