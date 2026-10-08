import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FactoryFlowSheet,FactoryLogistics,FactoryQc,FactoryDispatch,FactoryFollowup} from '@dx-rework/contracts/factory-flow';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {BulkPreparationService} from './bulk-preparation-service.js';
import {DigitalProductionTaskService} from './task-service.js';
import {DigitalProductionAccessPolicy,digitalForbidden,isDigitalLeader} from './access-policy.js';
import {SourcingProductionService} from '../sourcing/sourcing-production-service.js';
type DB=Pick<Pool|PoolClient,'query'>;
const fail=(message:string):never=>{throw new ApplicationError('FACTORY_FLOW_CONFLICT',message,409);};
const iso=(v:Date|string|null)=>v===null?null:new Date(v).toISOString();
const ROOT='root_superuser';
export class FactoryFlowService{
 constructor(private readonly database:Pool){}
 private tasks(){return new DigitalProductionTaskService(this.database);}
 private async state(db:DB,id:string){
  const gate=await new BulkPreparationService(this.database).gates(db,id);
  const route=(await db.query('SELECT route.*,completion.completed_at AS cutting_completed_at FROM digital_factory_routes route JOIN digital_bulk_cutting_completions completion USING(preparation_id) WHERE route.production_order_id=$1',[id])).rows[0];
  const facts=route?(await db.query('SELECT f.*,u.display_name AS actor_name FROM digital_factory_facts f JOIN app_users u ON u.id=f.actor_id WHERE preparation_id=$1 ORDER BY sequence',[route.preparation_id])).rows:[];
  const tasks=route?(await db.query("SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.route_instance_id=$1 AND a.task_kind IN ('process_logistics','bulk_qc','warehouse_dispatch','factory_material_count','bulk_ship_sample') ORDER BY t.created_at",[route.preparation_id])).rows:[];
  const lines=(await db.query('SELECT line_id,po_number,color,customer_warehouse_arrival_date::text AS customer_date,(customer_warehouse_arrival_date-10)::text AS sample_date FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[id])).rows;
  const checks=route?(await db.query('SELECT q.*,u.display_name AS checker FROM digital_factory_qc q JOIN app_users u ON u.id=q.checked_by WHERE preparation_id=$1 ORDER BY q.sequence',[route.preparation_id])).rows:[];
  const lastMovement=facts.filter(f=>['工艺发出','工艺回仓'].includes(f.kind)).at(-1),returned=lastMovement?.kind==='工艺回仓'?lastMovement:null;
  const latest=lines.map(line=>({line,check:checks.filter(c=>c.line_id===line.line_id&&c.return_fact_id===returned?.fact_id).at(-1)}));
  const allQc=Boolean(route&&(route.secondary_craft==='无'||returned&&latest.every(r=>r.check?.result==='合格')));
  const dispatched=facts.find(f=>f.kind==='仓库实际发厂');
  const revision=facts.length+checks.length;
  const contract=gate.approval?(await db.query('SELECT status,sourcing_contract_document_id FROM sourcing_contract_documents WHERE sourcing_approval_snapshot_id=$1 ORDER BY contract_version DESC LIMIT 1',[gate.approval.sourcing_approval_snapshot_id])).rows[0]:null;
  return {gate,route,facts,tasks,lines,checks,latest,allQc,returned,lastMovement,dispatched,revision,contract};
 }
 async sync(db:PoolClient,actor:TrustedActorContext,id:string){
  if(!(await db.query("SELECT to_regclass('digital_factory_routes') AS relation")).rows[0]?.relation)return;
  const completion=(await db.query('SELECT * FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rows[0];if(!completion)return;
  let s=await this.state(db,id);
  if(!s.route){
   if(s.gate.reasons.length)fail(s.gate.reasons.join('；'));
   const chosen=s.gate.instruction.document.secondaryCraft,craft=chosen&&chosen!=='沿用开发'?chosen:s.gate.source?.document.craft;
   if(!['无','印花','绣花','印绣花'].includes(craft))fail('请在有效制单明确大货印绣路线');
   await db.query('INSERT INTO digital_factory_routes(preparation_id,production_order_id,secondary_craft) VALUES($1,$2,$3)',[completion.preparation_id,id,craft]);
   const warehouse=(await db.query('SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1',[id])).rows[0]?.warehouse_worker_id;
   for(const kind of [...(craft==='无'?[]:['process_logistics','bulk_qc'] as const),'warehouse_dispatch','factory_material_count','bulk_ship_sample'] as const){
    let assignee=kind==='warehouse_dispatch'?warehouse:['factory_material_count','bulk_ship_sample'].includes(kind)?s.gate.order.primary_merchandiser_id:null;
    const role=kind==='warehouse_dispatch'?'warehouse_receiver':'order_merchandiser';
    if(assignee&&!await new DigitalProductionAccessPolicy(db).activeRole(assignee,role))assignee=null;
    const task=await this.tasks().createWithClient(db,actor,{resource:{kind:'order',id},kind,routeId:completion.preparation_id,routeVersion:s.gate.instruction.version,occurrence:1,assigneeId:assignee,conditions:kind==='bulk_qc'?['handover_received']:[]});
    if(kind==='warehouse_dispatch'){
     await this.tasks().setConditionWithClient(db,actor,task.taskId,'all_po_complete',true,undefined,'全部PO原实裁已齐');
     if(craft==='无')await this.tasks().setConditionWithClient(db,actor,task.taskId,'qc_approved',true,undefined,'无印绣路线无需裁片工艺QC');
    }
   }
   s=await this.state(db,id);
  }
  if(s.dispatched)return;
  const warehouse=s.tasks.find(t=>t.task_kind==='warehouse_dispatch');
  if(warehouse){await this.tasks().setConditionWithClient(db,actor,warehouse.task_id,'qc_approved',s.allQc,undefined,s.allQc?'整款工艺检查满足':'任一PO未通过，整款不得发厂');if(s.allQc)await this.tasks().refreshBusinessConditionsWithClient(db,actor,warehouse.task_id);}
 }
 private async authorized(db:DB,actor:TrustedActorContext,s:Awaited<ReturnType<FactoryFlowService['state']>>,kind:string){
  const task=s.tasks.find(t=>t.task_kind===kind);if(!task)return false;
  if(actor.actorRoles.includes(ROOT))return true;
  if(['factory_material_count','bulk_ship_sample'].includes(kind)&&s.gate.order.primary_merchandiser_id!==actor.actorId)return false;
  return new DigitalProductionAccessPolicy(db).allowed(actor,'task',task.task_id,'execute');
 }
 async read(actor:TrustedActorContext,id:string,db:DB=this.database):Promise<FactoryFlowSheet>{
  await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');const s=await this.state(db,id);
  const sampleTargetDate=(await db.query('SELECT min(customer_warehouse_arrival_date-10)::text AS day FROM digital_production_po_lines WHERE production_order_id=$1',[id])).rows[0]?.day??null;
  const link=(await db.query("SELECT child_id FROM digital_production_child_links WHERE module='production' AND production_order_id=$1",[id])).rows[0];
  return {orderId:id,preparationId:s.route?.preparation_id??null,revision:s.revision,secondaryCraft:s.route?.secondary_craft??null,reasons:[...s.gate.reasons,...(!s.route?['全部PO实裁尚未完成']:[]),...(s.route&&!s.dispatched&&s.contract?.status!=='ready'?['当前原合同尚未生成，发厂前请在原合同页补齐资料']:[])],allCut:Boolean(s.route),allQc:s.allQc,inTransit:s.lastMovement?.kind==='工艺发出',dispatched:Boolean(s.dispatched),supplierId:s.gate.approval?.supplier_id??null,supplierName:s.gate.approval?.supplier_name_snapshot??null,productionId:link?.child_id??null,sampleTargetDate,canManage:isDigitalLeader(actor),canLogistics:await this.authorized(db,actor,s,'process_logistics'),canQc:await this.authorized(db,actor,s,'bulk_qc'),canWarehouse:await this.authorized(db,actor,s,'warehouse_dispatch'),canFollowup:await this.authorized(db,actor,s,'factory_material_count'),tasks:await Promise.all(s.tasks.map(t=>this.tasks().read(actor,t.task_id,db))),lines:s.latest.map(({line,check})=>({lineId:line.line_id,poNumber:line.po_number,color:line.color,customerWarehouseArrivalDate:line.customer_date,sampleTargetDate:line.sample_date,result:check?.result??null,problem:check?.problem??'',treatment:check?.treatment??''})),facts:s.facts.map(f=>({factId:f.fact_id,kind:f.kind,occurredAt:iso(f.occurred_at),recordedAt:iso(f.recorded_at)!,actorName:f.actor_name,payload:f.payload})),checks:s.checks.map(c=>({checkId:c.check_id,lineId:c.line_id,returnFactId:c.return_fact_id,result:c.result,problem:c.problem,treatment:c.treatment,attachmentIds:c.attachment_ids,checkedBy:c.checker,checkedAt:iso(c.checked_at)!}))};
 }
 private async command(actor:TrustedActorContext,id:string,action:string,input:{expectedRevision:number},key:string,work:(db:PoolClient,s:Awaited<ReturnType<FactoryFlowService['state']>>)=>Promise<void>){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[id]);
   const command=`factory:${id}:${action}`,hash=createHash('sha256').update(JSON.stringify(input)).digest('hex'),prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)fail('操作标识已用于不同内容');await db.query('COMMIT');return prior.response as FactoryFlowSheet;}
   await this.sync(db,actor,id);const s=await this.state(db,id);if(!s.route)fail('全部PO原实裁完成后才能办理裁后');if(s.gate.reasons.length)fail(s.gate.reasons.join('；'));if(s.revision!==input.expectedRevision)fail('已有新办理事实，请刷新后重试');
   await work(db,s);await this.sync(db,actor,id);const response=await this.read(actor,id,db);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(response)]);
   await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_factory_route',$5,$6)",[randomUUID(),actor.requestId,actor.actorId,action,id,JSON.stringify(input)]);await db.query('COMMIT');return response;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 private latestTime(...values:Array<Date|string|null|undefined>){const times=values.filter((v):v is Date|string=>v!=null).map(v=>new Date(v).getTime());return times.length?new Date(Math.max(...times)):null;}
 private checkTime(at:string|null,earliest?:Date|string|null){if(at&&(!Number.isFinite(new Date(at).getTime())||new Date(at).getTime()>Date.now()||earliest&&new Date(at)<new Date(earliest)))fail('真实时间不能晚于当前或早于前置发生时间');}
 private async fact(db:PoolClient,actor:TrustedActorContext,prep:string,kind:string,at:string|null,payload:unknown){const id=randomUUID();await db.query('INSERT INTO digital_factory_facts(fact_id,preparation_id,sequence,kind,payload,actor_id,occurred_at) SELECT $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5,$6 FROM digital_factory_facts WHERE preparation_id=$2',[id,prep,kind,JSON.stringify(payload),actor.actorId,at]);return id;}
 async logistics(actor:TrustedActorContext,id:string,input:FactoryLogistics,key:string){return this.command(actor,id,'logistics',input,key,async(db,s)=>{
  if(!await this.authorized(db,actor,s,'process_logistics'))digitalForbidden();if(s.dispatched)fail('已发厂，裁后工艺记录已结束');if(s.tasks.find(t=>t.task_kind==='process_logistics')?.state!=='ready')fail('工艺收发任务尚不可办理');
  if(input.kind==='工艺沟通'&&!input.note.trim())fail('请填写沟通记录');
  if(input.kind==='工艺发出'&&s.lastMovement?.kind==='工艺发出')fail('整款已在工艺厂，不能重复发出');
  if(input.kind==='工艺发出'&&!input.supplier.trim())fail('请登记实际工艺供应厂');
  if(input.kind==='工艺回仓'&&s.lastMovement?.kind!=='工艺发出')fail('须有整款工艺发出事实才能回仓');
  this.checkTime(input.occurredAt,input.kind==='工艺沟通'?null:this.latestTime(s.route.cutting_completed_at,s.lastMovement?.occurred_at));
  await this.fact(db,actor,s.route.preparation_id,input.kind,input.occurredAt,{supplier:input.supplier,note:input.note});
  if(input.kind==='工艺回仓'){const task=s.tasks.find(t=>t.task_kind==='bulk_qc');await this.tasks().setConditionWithClient(db,actor,task.task_id,'handover_received',true,input.occurredAt,'整款工艺已回仓待QC');}
 });}
 async qc(actor:TrustedActorContext,id:string,input:FactoryQc,key:string){return this.command(actor,id,'qc',input,key,async(db,s)=>{
  if(!await this.authorized(db,actor,s,'bulk_qc'))digitalForbidden();if(s.dispatched||!s.returned)fail('整款须已回仓且尚未发厂才能检查');if(s.tasks.find(t=>t.task_kind==='bulk_qc')?.state!=='ready')fail('QC任务尚不可办理');
  if(new Set(input.checks.map(c=>c.lineId)).size!==input.checks.length||input.checks.some(c=>!s.lines.some(l=>l.line_id===c.lineId)))fail('检查款色必须属于本母单且不可重复');
  for(const check of input.checks){
   if(check.result==='需处理'&&!check.problem.trim())fail('需处理必须说明问题及处理要求');
   if(new Set(check.attachmentIds).size!==check.attachmentIds.length)fail('图片不可重复');
   const images=await db.query("SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2 AND status='ready' AND entity_type IS NULL AND entity_id IS NULL AND mime_type IN ('image/jpeg','image/png','image/webp') FOR UPDATE",[check.attachmentIds,actor.actorId]);if(images.rowCount!==check.attachmentIds.length)fail('检查图片须由本人上传并可用，不能借用其他模块图片');
   const checkId=randomUUID();await db.query('INSERT INTO digital_factory_qc(check_id,preparation_id,return_fact_id,line_id,result,problem,treatment,attachment_ids,checked_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[checkId,s.route.preparation_id,s.returned.fact_id,check.lineId,check.result,check.problem,check.treatment,check.attachmentIds,actor.actorId]);
   await db.query("UPDATE attachments SET entity_type='digital_factory_qc',entity_id=$1,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($2::uuid[])",[checkId,check.attachmentIds]);
  }
 });}
 async dispatch(actor:TrustedActorContext,id:string,input:FactoryDispatch,key:string){return this.command(actor,id,'warehouse',input,key,async(db,s)=>{
  if(!await this.authorized(db,actor,s,'warehouse_dispatch'))digitalForbidden();if(s.dispatched)fail('整款已实际发厂，不能重复发出');if(!s.allQc)fail('任一PO工艺QC未合格，整款不可发厂');
  if(input.supplierId!==s.gate.approval?.supplier_id)fail('请刷新确认当前原批准的唯一加工厂');
  const task=s.tasks.find(t=>t.task_kind==='warehouse_dispatch');if(task.state!=='ready')fail('仓库发厂尚不可办理');
  this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,s.returned?.occurred_at,...s.latest.map(l=>l.check?.checked_at)));
  const factId=await this.fact(db,actor,s.route.preparation_id,'仓库实际发厂',input.occurredAt,{supplierId:input.supplierId,note:input.note});
  await new SourcingProductionService(this.database).dispatchDigitalWithClient(db,actor,id,factId);
  await this.tasks().completeFactoryDispatchFactsWithClient(db,actor,id,factId);
 });}
 async followup(actor:TrustedActorContext,id:string,input:FactoryFollowup,key:string){return this.command(actor,id,'followup',input,key,async(db,s)=>{
  const kind=input.kind==='船样寄出'?'bulk_ship_sample':'factory_material_count';if(!await this.authorized(db,actor,s,kind))digitalForbidden();this.checkTime(input.occurredAt);
  const prior=s.facts.filter(f=>f.kind===input.kind).at(-1),task=s.tasks.find(t=>t.task_kind===kind);
  if(prior&&(input.kind!=='工厂到料'||prior.occurred_at))fail('已有该实际事实，不能重复改写');
  if(input.kind!=='工厂到料'&&task.state!=='ready')fail('跟进任务尚不可办理');
  if(input.kind==='船样寄出'&&(!input.occurredAt||!input.trackingNumber))fail('请填写真实寄出日期和快递单号');
  if(input.kind==='到料清点'&&(!input.occurredAt||!input.note.trim()))fail('请填写真实清点时间和清点结果');
  const arrived=s.facts.filter(f=>f.kind==='工厂到料'&&f.occurred_at).at(-1);if(input.kind==='到料清点'){if(!arrived)fail('实际到厂时间未确认，不能完成48小时清点');this.checkTime(input.occurredAt,arrived.occurred_at);}
  await this.fact(db,actor,s.route.preparation_id,input.kind,input.occurredAt,{trackingNumber:input.trackingNumber,note:input.note});
  if(input.kind==='工厂到料'&&input.occurredAt)await this.tasks().setConditionWithClient(db,actor,task.task_id,'factory_arrived',true,input.occurredAt,'主跟单确认工厂实际收到面辅料');
  if(input.kind!=='工厂到料'){
   await this.tasks().setConditionWithClient(db,actor,task.task_id,'business_recorded',true,input.occurredAt,input.note);
   await this.tasks().completeWithClient(db,actor,task.task_id,{note:input.note,occurredAt:input.occurredAt},`factory:${s.route.preparation_id}:${kind}`);
  }
 });}
 async authorizeUpload(actor:TrustedActorContext,id:string){await new DigitalProductionAccessPolicy(this.database).assert(actor,'order',id,'technical');const s=await this.state(this.database,id);if(!await this.authorized(this.database,actor,s,'bulk_qc')||s.dispatched||!s.returned)digitalForbidden();}
 async canDownload(actor:TrustedActorContext,id:string,attachmentId:string){if(!await new DigitalProductionAccessPolicy(this.database).allowed(actor,'order',id,'technical'))return false;return Boolean((await this.database.query("SELECT 1 FROM digital_factory_qc q JOIN digital_factory_routes r USING(preparation_id) JOIN attachments a ON a.attachment_id=ANY(q.attachment_ids) AND a.entity_type='digital_factory_qc' AND a.entity_id=q.check_id::text WHERE r.production_order_id=$1 AND a.attachment_id=$2 AND a.status='ready'",[id,attachmentId])).rowCount);}
}
