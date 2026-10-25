import {factoryReturnLogistics} from './factory-return-logistics.js';
import {factoryProductionFacts,factoryProductionScopes} from './factory-production-facts.js';
import type {FactoryProductionQc} from '@dx-rework/contracts/factory-flow';
import {shipSampleTargets} from './ship-sample-timing.js';
import {ShipSampleService} from './ship-sample-service.js';
import {shipSampleFacts} from './ship-sample-facts.js';
import {factoryBatchTiming} from './factory-batch-timing.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FactoryFlowSheet,FactoryLogistics,FactoryQc,FactoryDispatch,FactoryFollowup} from '@dx-rework/contracts/factory-flow';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {BulkPreparationService} from './bulk-preparation-service.js';
import {DigitalProductionTaskService} from './task-service.js';
import {DigitalProductionAccessPolicy,digitalForbidden,isDigitalLeader} from './access-policy.js';
import {SourcingProductionService} from '../sourcing/sourcing-production-service.js';
import {factoryBatchLedger,type FactoryScope} from './factory-batch-ledger.js';
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
  const tasks=(await db.query("SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND (t.route_instance_id=$2 OR a.task_kind='bulk_ship_sample') AND a.task_kind IN ('process_logistics','bulk_qc','factory_production_qc','warehouse_dispatch','factory_material_count','bulk_ship_sample') ORDER BY t.created_at",[id,route?.preparation_id??null])).rows;
  const lines=(await db.query('SELECT line_id,po_number,color,customer_warehouse_arrival_date::text AS customer_date,(customer_warehouse_arrival_date-10)::text AS sample_date FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[id])).rows;
  const checks=route?(await db.query('SELECT q.*,u.display_name AS checker FROM digital_factory_qc q JOIN app_users u ON u.id=q.checked_by WHERE preparation_id=$1 ORDER BY q.sequence',[route.preparation_id])).rows:[];
  const lastMovement=facts.filter(f=>['工艺发出','工艺回仓'].includes(f.kind)).at(-1),returned=lastMovement?.kind==='工艺回仓'?lastMovement:null;
  const latest=lines.map(line=>({line,check:checks.filter(c=>c.line_id===line.line_id&&c.return_fact_id===returned?.fact_id).at(-1)}));
  const allQc=Boolean(route&&(route.secondary_craft==='无'||returned&&latest.every(r=>r.check?.result==='合格')));
  const dispatched=facts.find(f=>f.kind==='仓库实际发厂');
  const quantities=(await db.query(`SELECT po.line_id AS "lineId",r.actual_cut_count::int AS quantity FROM digital_production_po_lines po JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=po.line_id JOIN current_cutting_records r ON r.cutting_order_id=l.child_id WHERE po.production_order_id=$1 ORDER BY po.position`,[id])).rows as FactoryScope[];
  const batch=route?.workflow_version===2?factoryBatchLedger(quantities,facts,checks,route.secondary_craft==='无'):null;
  const production=await factoryProductionFacts(db,id);
  const revision=facts.length+checks.length+production.revision;
  const contract=gate.approval?(await db.query('SELECT status,sourcing_contract_document_id FROM sourcing_contract_documents WHERE sourcing_approval_snapshot_id=$1 ORDER BY contract_version DESC LIMIT 1',[gate.approval.sourcing_approval_snapshot_id])).rows[0]:null;
  return {production,gate,route,facts,tasks,lines,checks,latest,allQc:batch?batch.totals.every(l=>l.sent+l.remaining===l.quantity)&&batch.totals.every(l=>l.remaining===0||route.secondary_craft==='无'||batch.batches.reduce((n,b)=>n+b.rows.filter(r=>r.lineId===l.lineId&&r.allowDispatch).reduce((a,r)=>a+r.available,0),0)>=l.remaining):allQc,returned,lastMovement,dispatched:batch?(batch.complete?dispatched:undefined):dispatched,revision,contract,batch};
 }
 async sync(db:PoolClient,actor:TrustedActorContext,id:string){
  if(!(await db.query("SELECT to_regclass('digital_factory_routes') AS relation")).rows[0]?.relation)return;
  const completion=(await db.query('SELECT * FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rows[0];if(!completion)return;
  let s=await this.state(db,id);
  if(!s.route){
   if(s.gate.reasons.length)fail(s.gate.reasons.join('；'));
   const chosen=s.gate.instruction.document.secondaryCraft,craft=chosen&&chosen!=='沿用开发'?chosen:s.gate.source?.document.craft;
   if(!['无','印花','绣花','印绣花'].includes(craft))fail('请在有效制单明确大货印绣路线');
   await db.query('INSERT INTO digital_factory_routes(preparation_id,production_order_id,secondary_craft,workflow_version) VALUES($1,$2,$3,$4)',[completion.preparation_id,id,craft,s.gate.parallel?2:1]);
   const warehouse=(await db.query('SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1',[id])).rows[0]?.warehouse_worker_id;
   for(const kind of [...(craft==='无'?[]:['process_logistics','bulk_qc'] as const),'warehouse_dispatch','factory_material_count','bulk_ship_sample'] as const){
    if(kind==='bulk_ship_sample'&&s.tasks.some(t=>t.task_kind==='bulk_ship_sample'))continue;
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
  if(s.batch)await this.tasks().refreshFactoryBatchTimingWithClient(db,actor,id);
  if(s.dispatched)return;
  const warehouse=s.tasks.find(t=>t.task_kind==='warehouse_dispatch');
  if(warehouse){await this.tasks().setConditionWithClient(db,actor,warehouse.task_id,'qc_approved',s.batch?s.batch.canDispatch:s.allQc,undefined,s.batch?'按本批检查及放行范围发厂':s.allQc?'整款工艺检查满足':'任一PO未通过，整款不得发厂');if(s.batch?s.batch.canDispatch:s.allQc)await this.tasks().refreshBusinessConditionsWithClient(db,actor,warehouse.task_id);}
 }
 private async authorized(db:DB,actor:TrustedActorContext,s:Awaited<ReturnType<FactoryFlowService['state']>>,kind:string){
  const task=s.tasks.find(t=>t.task_kind===kind);if(!task)return false;
  if(actor.actorRoles.includes(ROOT))return true;
  if(['factory_material_count','bulk_ship_sample'].includes(kind)&&s.gate.order.primary_merchandiser_id!==actor.actorId)return false;
  return new DigitalProductionAccessPolicy(db).allowed(actor,'task',task.task_id,'execute');
 }
 async read(actor:TrustedActorContext,id:string,db:DB=this.database):Promise<FactoryFlowSheet>{
  await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');const s=await this.state(db,id);
  const sampleTargets=await shipSampleTargets(db,id),sampleTargetDate=sampleTargets.lines.map(l=>l.targetDate).filter((d):d is string=>d!==null).sort()[0]??null;
  const link=(await db.query("SELECT child_id FROM digital_production_child_links WHERE module='production' AND production_order_id=$1",[id])).rows[0];
  const tasks=await this.tasks().readAuthorized(actor,s.tasks.map(t=>t.task_id),db);
  const batchTiming=s.batch?await factoryBatchTiming(db,id):null;
  return {returnLogistics:await factoryReturnLogistics(db,id),productionInspectionHistory:s.production.history,productionChecks:s.production.checks,canProductionQc:await this.authorized(db,actor,s,'factory_production_qc'),sampleAdvanceDays:sampleTargets.days,canRecordShipSample:actor.actorRoles.includes(ROOT)||s.gate.order.primary_merchandiser_id===actor.actorId&&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'order_merchandiser'),shipSamples:await shipSampleFacts(db,id),...(batchTiming?{batchWindows:batchTiming.windows}:{}),batchMode:Boolean(s.batch),canPartialDispatch:s.batch?.canDispatch??s.allQc,...(s.batch?{batches:s.batch.batches,batchTotals:s.batch.totals,pendingSends:s.batch.pendingSends}:{}),currentReturn:s.returned?{factId:s.returned.fact_id,occurredAt:iso(s.returned.occurred_at),recordedAt:iso(s.returned.recorded_at)!}:null,orderId:id,preparationId:s.route?.preparation_id??null,revision:s.revision,secondaryCraft:s.route?.secondary_craft??null,reasons:[...s.gate.reasons,...(s.batch?.quantityConflict?['已发数量超过当前实裁，请核对原数量更正记录']:[]),...(!s.route?['全部PO实裁尚未完成']:[]),...(s.route&&!s.dispatched&&s.contract?.status!=='ready'?['当前原合同尚未生成，发厂前请在原合同页补齐资料']:[])],allCut:Boolean(s.route),allQc:s.allQc,inTransit:s.batch?s.batch.pendingSends.some(b=>b.rows.some(l=>l.remaining>0)):s.lastMovement?.kind==='工艺发出',dispatched:Boolean(s.dispatched),supplierId:s.gate.approval?.supplier_id??null,supplierName:s.gate.approval?.supplier_name_snapshot??null,productionId:link?.child_id??null,sampleTargetDate,canManage:isDigitalLeader(actor),canLogistics:await this.authorized(db,actor,s,'process_logistics'),canQc:await this.authorized(db,actor,s,'bulk_qc'),canWarehouse:await this.authorized(db,actor,s,'warehouse_dispatch'),canFollowup:await this.authorized(db,actor,s,'factory_material_count'),tasks,lines:s.latest.map(({line,check})=>({lineId:line.line_id,poNumber:line.po_number,color:line.color,customerWarehouseArrivalDate:line.customer_date,sampleTargetDate:sampleTargets.lines.find(l=>l.lineId===line.line_id)?.targetDate??null,result:check?.result??null,problem:check?.problem??'',treatment:check?.treatment??''})),facts:s.facts.map(f=>({factId:f.fact_id,kind:f.kind,occurredAt:iso(f.occurred_at),recordedAt:iso(f.recorded_at)!,actorName:f.actor_name,payload:f.payload})),checks:s.checks.map(c=>({checkId:c.check_id,lineId:c.line_id,returnFactId:c.return_fact_id,result:c.result,problem:c.problem,treatment:c.treatment,attachmentIds:c.attachment_ids,checkedBy:c.checker,checkedAt:iso(c.checked_at)!}))};
 }
 private async command(actor:TrustedActorContext,id:string,action:string,input:{expectedRevision:number},key:string,work:(db:PoolClient,s:Awaited<ReturnType<FactoryFlowService['state']>>)=>Promise<void>){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[id]);
   const command=`factory:${id}:${action}`,hash=createHash('sha256').update(JSON.stringify(input)).digest('hex'),prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)fail('操作标识已用于不同内容');await db.query('COMMIT');return prior.response as FactoryFlowSheet;}
   await this.sync(db,actor,id);const s=await this.state(db,id);if(s.batch?.quantityConflict)fail('实际发厂数量超过当前更正后实裁数量，请按原数量更正流程核对差异；保留已发事实');if(!s.route)fail('全部PO原实裁完成后才能办理裁后；请主跟单在本单产前准备查看未完成PO，由本厂裁床或外裁跟单按实际裁剪方式登记实裁');if(s.gate.reasons.length)fail(s.gate.reasons.join('；'));if(s.revision!==input.expectedRevision)fail('已有新办理事实，本次未覆盖；请重新读取本单核对最新工艺、QC或发厂记录，再提交仍未完成的事项');
   await work(db,s);await this.sync(db,actor,id);const response=await this.read(actor,id,db);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(response)]);
   await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_factory_route',$5,$6)",[randomUUID(),actor.requestId,actor.actorId,action,id,JSON.stringify(input)]);await db.query('COMMIT');return response;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 private async taskBlockReason(db:DB,actor:TrustedActorContext,s:Awaited<ReturnType<FactoryFlowService['state']>>,kind:string){
  const raw=s.tasks.find(t=>t.task_kind===kind);
  if(!raw)return '本轮尚未生成该工序任务：请主跟单在本单产前准备核对全部PO实裁及当前有效版本；仍未生成时联系管理员核查';
  const task=await this.tasks().read(actor,raw.task_id,db);
  if(task.paused)return '本单已暂停：请业务负责人在本单任务页核对暂停原因，恢复后再办理';
  if(task.state==='completed'||task.state==='cancelled')return `本任务${task.state==='completed'?'已完成':'已取消'}：请从我的待办打开当前有效任务，不能重复登记原任务`;
  return task.unmetConditions?.length?task.unmetConditions.map(item=>`${item.name}：${item.missing}；${item.action??'请本任务负责岗位核对当前办理页'}`).join('；'):'本工序尚未取得可办理状态，具体原因暂未确认；请重新读取本单，仍未恢复时提供任务链接给管理员核查';
 }
 private latestTime(...values:Array<Date|string|null|undefined>){const times=values.filter((v):v is Date|string=>v!=null).map(v=>new Date(v).getTime());return times.length?new Date(Math.max(...times)):null;}
 private checkTime(at:string|null,earliest?:Date|string|null){if(at&&(!Number.isFinite(new Date(at).getTime())||new Date(at).getTime()>Date.now()||earliest&&new Date(at)<new Date(earliest)))fail('真实时间不能晚于当前或早于前置发生时间；请在本页操作记录核对最近的实际发出、回仓或到厂时间后填写，不要用预计日期替代');}
 private async fact(db:PoolClient,actor:TrustedActorContext,prep:string,kind:string,at:string|null,payload:unknown){const id=randomUUID();await db.query('INSERT INTO digital_factory_facts(fact_id,preparation_id,sequence,kind,payload,actor_id,occurred_at) SELECT $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5,$6 FROM digital_factory_facts WHERE preparation_id=$2',[id,prep,kind,JSON.stringify(payload),actor.actorId,at]);return id;}
 async logistics(actor:TrustedActorContext,id:string,input:FactoryLogistics,key:string){return this.command(actor,id,'logistics',input,key,async(db,s)=>{
  if(!await this.authorized(db,actor,s,'process_logistics'))digitalForbidden();if(s.batch)return this.batchLogistics(db,actor,s,input);if(s.dispatched)fail('已发厂，裁后工艺记录已结束');if(s.tasks.find(t=>t.task_kind==='process_logistics')?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,'process_logistics'));
  if(input.kind==='工艺沟通'&&!input.note.trim())fail('请填写沟通记录');
  if(input.kind==='工艺发出'&&s.lastMovement?.kind==='工艺发出')fail('整款已在工艺厂，不能重复发出');
  if(input.kind==='工艺发出'&&!input.supplier.trim())fail('请登记实际工艺供应厂');
  if(input.kind==='工艺回仓'&&s.lastMovement?.kind!=='工艺发出')fail('须有整款工艺发出事实才能回仓；请印绣洗跟单在本页工艺物流核对最近一次发出记录，按实际交接顺序登记');
  this.checkTime(input.occurredAt,input.kind==='工艺沟通'?null:this.latestTime(s.route.cutting_completed_at,s.lastMovement?.occurred_at));
  await this.fact(db,actor,s.route.preparation_id,input.kind,input.occurredAt,{supplier:input.supplier,note:input.note});
  if(input.kind==='工艺回仓'){const task=s.tasks.find(t=>t.task_kind==='bulk_qc');await this.tasks().setConditionWithClient(db,actor,task.task_id,'handover_received',true,input.occurredAt,'整款工艺已回仓待QC');}
 });}
 async qc(actor:TrustedActorContext,id:string,input:FactoryQc,key:string){return this.command(actor,id,'qc',input,key,async(db,s)=>{
  if(!await this.authorized(db,actor,s,'bulk_qc'))digitalForbidden();if(s.batch)return this.batchQc(db,actor,s,input);if(s.dispatched||!s.returned)fail(s.dispatched?'本单已经实际发厂，本轮QC记录已结束；请QC在本单操作记录核对原检查结果，不要补写本轮检查':'尚无整款工艺回仓记录；请印绣洗跟单在本单工艺物流登记实际回仓，再由QC逐PO检查');if(s.tasks.find(t=>t.task_kind==='bulk_qc')?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,'bulk_qc'));
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
  if(!await this.authorized(db,actor,s,'warehouse_dispatch'))digitalForbidden();if(s.batch)return this.batchDispatch(db,actor,id,s,input);if(s.dispatched)fail('整款已实际发厂，不能重复发出');if(!s.allQc)fail(`任一PO工艺QC未合格，整款不可发厂：${!s.returned?'尚无本轮工艺回仓记录，请印绣洗跟单在工艺物流登记实际回仓':s.latest.filter(row=>row.check?.result!=='合格').map(row=>`PO ${row.line.po_number}／${row.line.color}：${row.check?.result==='需处理'?'问题待处理及复查':'尚未检查'}`).join('；')}。请QC在本单工艺QC逐项处理，仓库随后登记实际发厂。`);
  if(input.supplierId!==s.gate.approval?.supplier_id)fail('请刷新确认当前原批准的唯一加工厂');
  const task=s.tasks.find(t=>t.task_kind==='warehouse_dispatch');if(task?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,'warehouse_dispatch'));
  this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,s.returned?.occurred_at,...s.latest.map(l=>l.check?.checked_at)));
  const factId=await this.fact(db,actor,s.route.preparation_id,'仓库实际发厂',input.occurredAt,{supplierId:input.supplierId,note:input.note});
  await new SourcingProductionService(this.database).dispatchDigitalWithClient(db,actor,id,factId);
  await this.ensureProductionQc(db,actor,id,s.route.preparation_id);
  await this.tasks().completeFactoryDispatchFactsWithClient(db,actor,id,factId);
 });}
 private scope(input:FactoryScope[]|undefined,limits:Array<{lineId:string;remaining:number}>):FactoryScope[]{
  const value=input??limits.filter(l=>l.remaining>0).map(l=>({lineId:l.lineId,quantity:l.remaining}));
  if(!value.length||new Set(value.map(l=>l.lineId)).size!==value.length||value.some(l=>!Number.isSafeInteger(l.quantity)||l.quantity<=0||l.quantity>(limits.find(x=>x.lineId===l.lineId)?.remaining??0)))fail('本批PO或数量不合法，不能超过当前未发/未回余量；请刷新核对');
  return value;
 }
 private async batchLogistics(db:PoolClient,actor:TrustedActorContext,s:Awaited<ReturnType<FactoryFlowService['state']>>,input:FactoryLogistics){
  if(s.dispatched||s.tasks.find(t=>t.task_kind==='process_logistics')?.state!=='ready')fail('本轮工艺任务不可办理');
  if(input.kind==='工艺沟通'){if(!input.note.trim())fail('请填写沟通记录');this.checkTime(input.occurredAt);await this.fact(db,actor,s.route.preparation_id,input.kind,input.occurredAt,{supplier:input.supplier,note:input.note});return;}
  const ledger=s.batch!;let lines:FactoryScope[],sendFactId:string|undefined,fromReturnId:string|undefined;
  if(input.kind==='工艺发出'){
   if(!input.supplier.trim())fail('请登记实际工艺供应厂');
   fromReturnId=input.fromReturnId;
   // Old whole-order form may re-send the current return, but never resend dispatched pieces.
   if(!input.lines&&!fromReturnId&&ledger.totals.every(l=>l.craftRemaining===0))fromReturnId=ledger.batches.at(-1)?.factId;
   const from=fromReturnId?ledger.batches.find(b=>b.factId===fromReturnId):null;if(fromReturnId&&!from)fail('返工来源批次不属于本单');
   lines=this.scope(input.lines,from?from.rows.map(l=>({lineId:l.lineId,remaining:l.available})):ledger.totals.map(l=>({lineId:l.lineId,remaining:l.craftRemaining})));
   this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,from?.occurredAt));
  }else{
   sendFactId=input.sendFactId??ledger.pendingSends.filter(b=>b.rows.some(l=>l.remaining>0)).at(-1)?.factId;
   const send=ledger.pendingSends.find(b=>b.factId===sendFactId);if(!send)fail('请选本单尚有未回数量的工艺发出批次');
   lines=this.scope(input.lines,send!.rows);this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,send!.occurredAt));
  }
  await this.fact(db,actor,s.route.preparation_id,input.kind,input.occurredAt,{supplier:input.supplier,note:input.note,lines,...(sendFactId?{sendFactId}:{}),...(fromReturnId?{fromReturnId}:{})});
  if(input.kind==='工艺回仓'){const task=s.tasks.find(t=>t.task_kind==='bulk_qc');await this.tasks().setConditionWithClient(db,actor,task.task_id,'handover_received',true,input.occurredAt,'已有工艺批次回仓，先回先检查');}
 }
 private async batchQc(db:PoolClient,actor:TrustedActorContext,s:Awaited<ReturnType<FactoryFlowService['state']>>,input:FactoryQc){
  const batch=s.batch!.batches.find(b=>b.factId===(input.returnFactId??s.returned?.fact_id));
  if(s.dispatched||!batch||s.tasks.find(t=>t.task_kind==='bulk_qc')?.state!=='ready')fail('请在本单选择可检查的实际回仓批次');
  if(new Set(input.checks.map(c=>c.lineId)).size!==input.checks.length)fail('同批检查PO不可重复');
  for(const check of input.checks){
   const row=batch!.rows.find(l=>l.lineId===check.lineId);if(!row||row.available<=0)fail('本批PO已发完或已重新发工艺，不可覆盖检查');
   if(check.result==='需处理'&&!check.problem.trim())fail('需处理必须保留原问题');
   if(check.allowDispatch&&(check.result!=='需处理'||!check.dispatchReason?.trim()||!check.treatment.trim()))fail('不合格先发须由质检填写原因及后续安排');
   if(new Set(check.attachmentIds).size!==check.attachmentIds.length)fail('图片不可重复');
   const images=await db.query("SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2 AND status='ready' AND entity_type IS NULL AND entity_id IS NULL AND mime_type IN ('image/jpeg','image/png','image/webp') FOR UPDATE",[check.attachmentIds,actor.actorId]);if(images.rowCount!==check.attachmentIds.length)fail('检查图片须由本人上传并可用');
   const checkId=randomUUID();await db.query('INSERT INTO digital_factory_qc(check_id,preparation_id,return_fact_id,line_id,result,problem,treatment,attachment_ids,checked_by,allow_dispatch,dispatch_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[checkId,s.route.preparation_id,batch!.factId,check.lineId,check.result,check.problem,check.treatment,check.attachmentIds,actor.actorId,check.allowDispatch??false,check.dispatchReason??'']);
   await db.query("UPDATE attachments SET entity_type='digital_factory_qc',entity_id=$1,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($2::uuid[])",[checkId,check.attachmentIds]);
  }
 }
 private async batchDispatch(db:PoolClient,actor:TrustedActorContext,id:string,s:Awaited<ReturnType<FactoryFlowService['state']>>,input:FactoryDispatch){
  if(s.dispatched)fail('全部应发裁片已发厂');
  if(input.supplierId!==s.gate.approval?.supplier_id)fail('请刷新确认当前批准加工厂');
  if(s.contract?.status!=='ready')fail('当前批准合同未就绪，不能发厂');
  const batch=s.route.secondary_craft==='无'?null:s.batch!.batches.find(b=>b.factId===(input.returnFactId??s.returned?.fact_id));
  if(s.route.secondary_craft!=='无'&&!batch)fail('请选择本单实际回仓批次');
  if(!input.lines&&!s.allQc){
   const blocked=batch?.rows.filter(row=>row.available>0&&!row.allowDispatch).map(row=>{
    const line=s.latest.find(item=>item.line.line_id===row.lineId)?.line;
    return `PO ${line?.po_number??row.lineId}／${line?.color??''}：${row.result==='需处理'?'问题待处理及复查':'尚未检查'}`;
   }).join('；');
   fail(`任一PO工艺QC未满足，不能整款发厂：${blocked||'其他未发批次尚未全部放行'}。请QC在本单处理，仓库随后登记实际发厂，或选择已放行批次先发。`);
  }
  const limits=batch?batch.rows.map(l=>({lineId:l.lineId,remaining:l.allowDispatch?Math.min(l.available,s.batch!.totals.find(t=>t.lineId===l.lineId)?.remaining??0):0})):s.batch!.totals;
  const lines=this.scope(input.lines,limits);
  if(s.tasks.find(t=>t.task_kind==='warehouse_dispatch')?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,'warehouse_dispatch'));
  this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,batch?.occurredAt,...(batch?.rows.filter(l=>lines.some(x=>x.lineId===l.lineId)).map(l=>l.checkedAt)??[])));
  const factId=await this.fact(db,actor,s.route.preparation_id,'仓库实际发厂',input.occurredAt,{supplierId:input.supplierId,note:input.note,lines,...(batch?{returnFactId:batch.factId,releaseCheckIds:lines.map(l=>({lineId:l.lineId,checkId:s.checks.filter(c=>c.return_fact_id===batch.factId&&c.line_id===l.lineId).at(-1)!.check_id}))}:{})});
  await new SourcingProductionService(this.database).dispatchDigitalWithClient(db,actor,id,factId);
  await this.ensureProductionQc(db,actor,id,s.route.preparation_id);
  const after=await this.state(db,id);if(after.batch!.complete)await this.tasks().completeFactoryDispatchFactsWithClient(db,actor,id,factId);
 }
 private async ensureProductionQc(db:PoolClient,actor:TrustedActorContext,id:string,routeId:string){
  if((await db.query("SELECT 1 FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='factory_production_qc'",[id])).rowCount)return;
  await this.tasks().createWithClient(db,actor,{resource:{kind:'order',id},kind:'factory_production_qc',routeId,routeVersion:1,occurrence:1,assigneeId:null,occurredAt:null});
 }
 async productionQc(actor:TrustedActorContext,id:string,input:FactoryProductionQc,key:string){return this.command(actor,id,'production-qc',input,key,async(db,s)=>{
  if(!await this.authorized(db,actor,s,'factory_production_qc'))digitalForbidden();
  if(!actor.actorRoles.includes(ROOT)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,'quality_control'))digitalForbidden();
  this.checkTime(input.occurredAt);
  if((await db.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE (resource_kind='order' AND resource_id=$1 OR resource_kind='source' AND resource_id=$2) AND state<>'active'",[id,s.gate.order.source_id])).rowCount)fail('本单已暂停或取消，保留原检查事实');
  if((await db.query('SELECT 1 FROM digital_order_closures WHERE production_order_id=$1',[id])).rowCount)fail('本单已结案，保留原检查事实');
  await db.query(`SELECT c.sourcing_case_id FROM sourcing_cases c JOIN digital_production_child_links l ON l.module='sourcing' AND l.child_id=c.sourcing_case_id WHERE l.production_order_id=$1 FOR UPDATE OF c`,[id]);
  const scopes=(await factoryProductionScopes(db,id)).filter(r=>r.factory_decision_id===input.factoryDecisionId);
  if(new Set(input.checks.map(c=>c.lineId)).size!==input.checks.length||input.checks.some(c=>!scopes.some(r=>r.line_id===c.lineId)))fail('检查范围不属于当前加工厂的有效PO范围');
  this.checkTime(input.occurredAt,scopes[0]?.dispatched_at);
  if(input.checks.some(c=>c.result==='需处理'&&!c.problem.trim()))fail('不合格检查须保留具体质量问题');
  const task=s.tasks.find(t=>t.task_kind==='factory_production_qc');
  if(!task||task.state==='cancelled')fail('工厂检查任务已取消或尚未建立');
  const eventId=randomUUID(),checks=input.checks.map(c=>({...c,allocationQuantity:Number(scopes.find(r=>r.line_id===c.lineId).quantity)}));
  await db.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
   VALUES($1,$2,'order',$3,'factory_garment_qc',$4,$5,'补报未核实',$6)`,[eventId,task.task_id,id,actor.actorId,input.occurredAt,JSON.stringify({productionId:scopes[0].production_order_id,factoryDecisionId:input.factoryDecisionId,checks,note:input.note})]);
  const after=await factoryProductionFacts(db,id);
  if(after.complete&&task.state!=='completed'){
   const completedAt=new Date(Math.max(...after.checks.map(c=>Date.parse(c.completedAt!)))).toISOString();
   await this.tasks().setConditionWithClient(db,actor,task.task_id,'business_recorded',true,completedAt,'工厂检查已完成，质量结论仍以各PO检查记录为准');
   await this.tasks().completeWithClient(db,actor,task.task_id,{occurredAt:completedAt,note:input.note},`factory-qc:${eventId}`);
  }
 });}
 async followup(actor:TrustedActorContext,id:string,input:FactoryFollowup,key:string){if(input.kind==='船样寄出'){await new ShipSampleService(this.database).record(actor,id,input,key);return this.read(actor,id);}return this.command(actor,id,'followup',input,key,async(db,s)=>{
  const kind=input.kind==='船样寄出'?'bulk_ship_sample':'factory_material_count';if(!await this.authorized(db,actor,s,kind))digitalForbidden();this.checkTime(input.occurredAt);
  const prior=s.facts.filter(f=>f.kind===input.kind).at(-1),task=s.tasks.find(t=>t.task_kind===kind);
  if(prior&&(input.kind!=='工厂到料'||prior.occurred_at))fail('已有该实际事实，不能重复改写');
  if(input.kind!=='工厂到料'&&task?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,kind));
  if(input.kind==='船样寄出'&&(!input.occurredAt||!input.trackingNumber))fail('请填写真实寄出日期和快递单号');
  if(input.kind==='到料清点'&&(!input.occurredAt||!input.note.trim()))fail('请填写真实清点时间和清点结果');
  const arrived=s.facts.filter(f=>f.kind==='工厂到料'&&f.occurred_at).at(-1);if(input.kind==='到料清点'){if(!arrived)fail('实际到厂时间未确认，不能完成48小时清点；请主跟单先在本页工厂到料登记实际收到时间，再登记清点结果');this.checkTime(input.occurredAt,arrived.occurred_at);}
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
