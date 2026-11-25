import {craftStepIdentity,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {startQcTrackingFromDispatch} from './qc-production-progress-service.js';
import {businessNow,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {factoryReturnLogistics} from './factory-return-logistics.js';
import {factoryProductionFacts,factoryProductionScopes} from './factory-production-facts.js';
import type {FactoryProductionQc} from '@dx-rework/contracts/factory-flow';
import {shipSampleTargets} from './ship-sample-timing.js';
import {ShipSampleService} from './ship-sample-service.js';
import {shipSampleFacts} from './ship-sample-facts.js';
import {factoryBatchTiming} from './factory-batch-timing.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FactoryFlowSheet,FactoryLogistics,FactoryQc,FactoryDispatch,FactoryFollowup,WarehouseCraftWorkChoice,WarehouseCraftWorkSheet} from '@dx-rework/contracts/factory-flow';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {BulkPreparationService} from './bulk-preparation-service.js';
import {DigitalProductionTaskService} from './task-service.js';
import {DigitalProductionAccessPolicy,digitalForbidden,isDigitalLeader} from './access-policy.js';
import {SourcingProductionService} from '../sourcing/sourcing-production-service.js';
import {factoryBatchLedger,factoryBatchReleaseAvailable,type FactoryScope} from './factory-batch-ledger.js';
import {factoryStepLedger,priorCraftReleasedPieces} from './factory-step-ledger.js';
import {fixedCraftSteps} from './fixed-craft-steps.js';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {craftLegacyLabel,craftStepLabel} from '@dx-rework/contracts/digital-craft';
import {readFixedOrderRoute} from './fixed-order-route.js';
import {reuseJourneySnapshotReads} from './journey-snapshot-reads.js';
import {warehouseFactoryDispatchEvidence} from './warehouse-factory-dispatch-evidence.js';
import {readWarehouseCraftFactoryBasis} from './warehouse-craft-factory-basis.js';
import {availableWarehouseCraftQuantities,qualifyWarehouseCraftMovement,type WarehouseCraftMotion,type WarehouseCraftOccupationReader} from './warehouse-craft-movement.js';
import {canReadExactOriginalQualityPhoto,exactUnboundQualityPhotos,factoryInspectionQualityAttachment,type OriginalQualityPhotoReference} from './original-quality-photo.js';
import {countedCraftCheck,readCurrentCraftProblem,type CraftProblemLocator} from './quality-craft-problem-scope.js';
import {internalCraftReinspection} from './internal-craft-quality-reinspection.js';
import {checkedExternalCraftRepairFact,lockExternalCraftRepair,readExternalCraftRepairProof} from './warehouse-craft-rework-return.js';
type DB=Pick<Pool|PoolClient,'query'>;
function fail(message:string):never{throw new ApplicationError('FACTORY_FLOW_CONFLICT',message,409);}
const iso=(v:Date|string|null)=>v===null?null:new Date(v).toISOString();
const ROOT='root_superuser';
type WarehouseCraftCommand=Omit<WarehouseCraftMotion,'scope'|'lines'>&{expectedRevision:number;taskId:string;preparationId:string;stepRef:string;lines:FactoryScope[];note:string};
type WarehouseCraftRepairCommand=WarehouseCraftCommand&{reworkId:string};
// The original route and the internal entry share the original receipt key.
// Canonicalize wire-key order only for these new commands, not legacy hashes.
const warehouseCraftPayload=(input:WarehouseCraftCommand,reworkId?:string)=>({
 expectedRevision:input.expectedRevision,taskId:input.taskId,preparationId:input.preparationId,stepRef:input.stepRef,
 kind:input.kind,sourceFactId:input.sourceFactId,factoryId:input.factoryId,occurredAt:input.occurredAt,note:input.note,
 lines:input.lines.map(line=>({lineId:line.lineId,quantity:line.quantity})),...(reworkId?{reworkId}:{}),
});
export class FactoryFlowService{
 constructor(private readonly database:Pool,private readonly readWarehouseCraftOccupation?:WarehouseCraftOccupationReader){}
 private tasks(){return new DigitalProductionTaskService(this.database);}
 private async state(db:DB,id:string){
  const gate=await new BulkPreparationService(this.database).gates(db,id);
  const route=(await db.query('SELECT route.*,completion.completed_at AS cutting_completed_at FROM digital_factory_routes route JOIN digital_bulk_cutting_completions completion USING(preparation_id) WHERE route.production_order_id=$1',[id])).rows[0];
  const facts=route?(await db.query('SELECT f.*,u.display_name AS actor_name FROM digital_factory_facts f JOIN app_users u ON u.id=f.actor_id WHERE preparation_id=$1 ORDER BY sequence',[route.preparation_id])).rows:[];
  const fixed=route?.route_schema_version===2;
  const tasks=(await db.query(`SELECT t.*,a.task_kind,a.assignee_id${fixed?',p.step_id,p.phase':''} FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) ${fixed?'LEFT JOIN digital_timeline_task_positions p USING(task_id)':''} WHERE a.production_order_id=$1 AND (t.route_instance_id=$2 OR a.task_kind='bulk_ship_sample') AND a.task_kind IN ('process_logistics','bulk_qc','factory_production_qc','warehouse_dispatch','bulk_ship_sample') ORDER BY t.created_at`,[id,route?.preparation_id??null])).rows;
  const lines=(await db.query('SELECT line_id,po_number,color,customer_warehouse_arrival_date::text AS customer_date,(customer_warehouse_arrival_date-10)::text AS sample_date FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[id])).rows;
  const checks=route?(await db.query('SELECT q.*,u.display_name AS checker FROM digital_factory_qc q JOIN app_users u ON u.id=q.checked_by WHERE preparation_id=$1 ORDER BY q.sequence',[route.preparation_id])).rows:[];
  const lastMovement=facts.filter(f=>['工艺发出','工艺回仓'].includes(f.kind)).at(-1),returned=lastMovement?.kind==='工艺回仓'?lastMovement:null;
  const latest=lines.map(line=>({line,check:checks.filter(c=>c.line_id===line.line_id&&c.return_fact_id===returned?.fact_id).at(-1)}));
  const allQc=Boolean(route&&(route.secondary_craft==='无'||returned&&latest.every(r=>r.check?.result==='合格')));
  const dispatched=facts.find(f=>f.kind==='仓库实际发厂');
  const quantities=(await db.query(`SELECT po.line_id AS "lineId",r.actual_cut_count::int AS quantity FROM digital_production_po_lines po JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=po.line_id JOIN current_cutting_records r ON r.cutting_order_id=l.child_id WHERE po.production_order_id=$1 ORDER BY po.position`,[id])).rows as FactoryScope[];
  const craftSteps=fixed?await fixedCraftSteps(db,route.preparation_id):[];
  const stepLedger=craftSteps.length?factoryStepLedger(quantities,facts,checks,craftSteps):null;
  const batch=stepLedger??(route?.workflow_version===2?factoryBatchLedger(quantities,facts,checks,route.secondary_craft==='无'):null);
  const production=await factoryProductionFacts(db,id);
  const revision=facts.length+checks.length+production.revision;
  const contract=gate.approval?(await db.query('SELECT status,sourcing_contract_document_id FROM sourcing_contract_documents WHERE sourcing_approval_snapshot_id=$1 ORDER BY contract_version DESC LIMIT 1',[gate.approval.sourcing_approval_snapshot_id])).rows[0]:null;
  return {production,gate,route,facts,tasks,lines,checks,latest,craftSteps,stepLedger,allQc:batch?batch.totals.every(l=>l.sent+l.remaining===l.quantity)&&batch.totals.every(l=>l.remaining===0||route.secondary_craft==='无'||batch.batches.reduce((n,b)=>n+b.rows.filter(r=>r.lineId===l.lineId).reduce((a,r)=>a+factoryBatchReleaseAvailable(r),0),0)>=l.remaining):allQc,returned,lastMovement,dispatched:batch?(batch.complete?dispatched:undefined):dispatched,revision,contract,batch};
 }
 async sync(db:PoolClient,actor:TrustedActorContext,id:string){
  if(!(await db.query("SELECT to_regclass('digital_factory_routes') AS relation")).rows[0]?.relation)return;
  const completion=(await db.query('SELECT * FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rows[0];if(!completion)return;
  let s=await this.state(db,id);
  if(!s.route){
   if(s.gate.reasons.length)fail(s.gate.reasons.join('；'));
   const chosen=s.gate.instruction.document.secondaryCraft,craft=chosen&&chosen!=='沿用开发'?chosen:s.gate.source?.document.craft;
   if(!['无','印花','绣花','印绣花','特殊工艺'].includes(craft))fail('请在有效制单明确大货工艺路线');
   const adopted=await new FixedTimelineAdoptionRepository(db).existing({kind:'order',id});
   if(craft==='特殊工艺'&&!adopted)fail('特殊工艺须沿已冻结的独立步骤办理');
   const scope=adopted?await readFixedOrderRoute(db,adopted,completion.preparation_id):null;
   const steps=adopted?await fixedCraftSteps(db,completion.preparation_id):[];
   if(adopted&&steps.length!==(scope?.craftSteps.length??adopted.input.craftSteps?.length??0))fail('本次原冻结工艺步骤尚未完整登记');
   if(adopted){
    const chosenSteps=s.gate.instruction.document.secondaryCraft==='沿用开发'?s.gate.source?.document.craftSteps:s.gate.instruction.document.craftSteps;
    if(craftLegacyLabel(steps)!==craft||chosenSteps&&(chosenSteps.length!==steps.length||chosenSteps.some((step:CraftStepChoice,index:number)=>craftStepIdentity(step)!==craftStepIdentity(steps[index]!)||step.sequence!==steps[index]?.sequence)))fail('本次工艺内容与首次冻结路线不同，须保留原范围并登记新增工艺范围，不能覆盖原目标');
   }
   await db.query(`INSERT INTO digital_factory_routes(preparation_id,production_order_id,secondary_craft,workflow_version${adopted?',route_schema_version,timeline_adoption_id':''}) VALUES($1,$2,$3,$4${adopted?',2,$5':''})`,[completion.preparation_id,id,craft,s.gate.parallel?2:1,...(adopted?[adopted.adoptionId]:[])]);
   const warehouse=(await db.query('SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1',[id])).rows[0]?.warehouse_worker_id;
   const operations:Array<{kind:'process_logistics'|'bulk_qc'|'warehouse_dispatch'|'bulk_ship_sample';position?:number}>=adopted
    ?[...(scope?.route??adopted.input.route??[]).map(position=>({kind:position.kind as 'process_logistics'|'bulk_qc'|'warehouse_dispatch',position:position.position})),{kind:'bulk_ship_sample'}]
    :([...(craft==='无'?[]:['process_logistics','bulk_qc'] as const),'warehouse_dispatch','bulk_ship_sample'] as const).map(kind=>({kind}));
   for(const {kind,position} of operations){
    if(kind==='bulk_ship_sample'&&s.tasks.some(t=>t.task_kind==='bulk_ship_sample'))continue;
    let assignee=kind==='warehouse_dispatch'?warehouse:kind==='bulk_ship_sample'?s.gate.order.primary_merchandiser_id:null;
    const role=kind==='warehouse_dispatch'?'warehouse_receiver':'order_merchandiser';
    if(assignee&&!await new DigitalProductionAccessPolicy(db).activeRole(assignee,role))assignee=null;
    const ownStep=position===undefined?null:(scope?.route??adopted?.input.route??[]).find(row=>row.position===position)?.stepId;
    const needsPrior=kind==='process_logistics'&&steps.some(step=>step.stepId===ownStep&&step.sequence>1);
    const task=await this.tasks().createWithClient(db,actor,{resource:{kind:'order',id},kind,routeId:completion.preparation_id,routeVersion:s.gate.instruction.version,occurrence:1,assigneeId:assignee,...(position===undefined?{}:{routePosition:position}),
      conditions:kind==='bulk_qc'?['handover_received']:needsPrior?['qc_approved']:[]});
    if(kind==='warehouse_dispatch'){
     await this.tasks().setConditionWithClient(db,actor,task.taskId,'all_po_complete',true,undefined,'全部PO原实裁已齐');
     if(craft==='无')await this.tasks().setConditionWithClient(db,actor,task.taskId,'qc_approved',true,undefined,'无印绣路线无需裁片工艺QC');
    }
   }
   s=await this.state(db,id);
  }
  if(s.stepLedger){
   for(const step of s.stepLedger.steps.filter(step=>step.step.sequence>1)){
    const task=s.tasks.find(task=>task.task_kind==='process_logistics'&&task.step_id===step.step.stepId);if(!task||['completed','cancelled'].includes(task.state))continue;
    const ready=s.facts.some(fact=>fact.kind==='工艺发出'&&fact.payload.stepRef===step.step.stepId)||s.stepLedger.sendable.find(row=>row.stepRef===step.step.stepId)!.lines.some(line=>line.remaining>0);
    const prior=(await db.query("SELECT satisfied FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='qc_approved'",[task.task_id])).rows[0];
    if(prior&&prior.satisfied!==ready)await this.tasks().setConditionWithClient(db,actor,task.task_id,'qc_approved',ready,undefined,'前一道工艺已有本PO完整合格范围，或本工艺已有合法发出批次');
    if(ready&&task.state==='pending')await this.tasks().refreshBusinessConditionsWithClient(db,actor,task.task_id);
   }
  }
  if(s.batch)await this.tasks().refreshFactoryBatchTimingWithClient(db,actor,id);
  if(s.dispatched)return;
  const warehouse=s.tasks.find(t=>t.task_kind==='warehouse_dispatch');
  if(warehouse){await this.tasks().setConditionWithClient(db,actor,warehouse.task_id,'qc_approved',s.batch?s.batch.canDispatch:s.allQc,undefined,s.batch?'按本批检查及放行范围发厂':s.allQc?'整款工艺检查满足':'任一PO未通过，整款不得发厂');if(s.batch?s.batch.canDispatch:s.allQc)await this.tasks().refreshBusinessConditionsWithClient(db,actor,warehouse.task_id);}
 }
 private async authorized(db:DB,actor:TrustedActorContext,s:Awaited<ReturnType<FactoryFlowService['state']>>,kind:string,stepRef?:string){
  const tasks=s.tasks.filter(t=>t.task_kind===kind&&(!stepRef||t.step_id===stepRef));if(!tasks.length)return false;
  if(actor.actorRoles.includes(ROOT))return true;
  if(kind==='bulk_ship_sample'&&s.gate.order.primary_merchandiser_id!==actor.actorId)return false;
  for(const task of tasks)if(await new DigitalProductionAccessPolicy(db).allowed(actor,'task',task.task_id,'execute'))return true;
  return false;
 }
 async read(actor:TrustedActorContext,id:string,db:DB=this.database):Promise<FactoryFlowSheet>{
  if(db!==this.database)return this.readFlow(actor,id,db);
  const client=await this.database.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const snapshot=reuseJourneySnapshotReads(client);
   const sheet=await this.readFlow(actor,id,snapshot,snapshot);
   await client.query('COMMIT');return sheet;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 private async readFlow(actor:TrustedActorContext,id:string,db:DB,readOnlyClient?:PoolClient):Promise<FactoryFlowSheet>{
  await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');const s=await this.state(db,id);
  const sampleTargets=await shipSampleTargets(db,id,s.gate.order.order_time_managed===true),sampleTargetDate=sampleTargets.lines.map(l=>l.targetDate).filter((d):d is string=>d!==null).sort()[0]??null;
  const link=(await db.query("SELECT child_id FROM digital_production_child_links WHERE module='production' AND production_order_id=$1",[id])).rows[0];
  const currentProduction=link&&s.gate.approval?(await db.query('SELECT production_order_id,factory_decision_id FROM sourcing_production_factory_orders WHERE production_order_id=$1 AND sourcing_decision_id=sourcing_factory_execution_basis(sourcing_case_id,$2) AND quantity>0',[link.child_id,s.gate.approval.sourcing_decision_id])).rows[0]:null;
  const taskIds=s.tasks.map(t=>t.task_id),tasks=readOnlyClient?[...(await this.tasks().readPage(actor,taskIds,readOnlyClient)).values()]
   :await this.tasks().readAuthorized(actor,taskIds,db);
  // Only the assigned person's display name crosses into logistics. Quotation
  // prices and other rows remain behind the original quotation access policy.
  const craftOwnerRows=s.craftSteps.some(step=>step.craftKind==='special')?(await db.query(`SELECT ref.value->'craftRef'->>'libraryId' AS library_id,ref.value->'craftRef'->>'libraryVersion' AS library_version,u.display_name
   FROM digital_quotation_documents q CROSS JOIN LATERAL jsonb_each(q.assembly->'rows') ref
   JOIN LATERAL jsonb_array_elements(q.assignments) a ON a->>'rowId'=ref.key
   LEFT JOIN app_users u ON u.id=(a->>'priceAssigneeId')::uuid
   WHERE q.production_order_id=$1 AND ref.value->>'stage'='bulk'`,[id])).rows:[];
  const craftOwners=s.craftSteps.filter(step=>step.specialCraft).map(step=>({stepRef:step.stepId,name:craftOwnerRows.find(row=>row.library_id===step.specialCraft!.id&&Number(row.library_version)===step.specialCraft!.version)?.display_name??null}));
  const batchTiming=s.batch?await factoryBatchTiming(db,id):null;
  const now=new Date((await new ContextBusinessClock(this.database,readOnlyClient).read({kind:'order',id})).now);
  return {currentProduction:currentProduction?{productionId:currentProduction.production_order_id as string,factoryDecisionId:currentProduction.factory_decision_id as string|null}:null,...(s.route?.route_schema_version===2?{routeSchemaVersion:2 as const,craftSteps:s.craftSteps,craftOwners,craftSendable:s.stepLedger?.sendable??[]}:{}),returnLogistics:await factoryReturnLogistics(db,id,now),productionInspectionHistory:s.production.history,productionChecks:s.production.checks,canProductionQc:await this.authorized(db,actor,s,'factory_production_qc'),sampleAdvanceDays:sampleTargets.days,canRecordShipSample:actor.actorRoles.includes(ROOT)||s.gate.order.primary_merchandiser_id===actor.actorId&&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'order_merchandiser'),shipSamples:await shipSampleFacts(db,id),...(batchTiming?{batchWindows:batchTiming.windows}:{}),batchMode:Boolean(s.batch),canPartialDispatch:s.batch?.canDispatch??s.allQc,...(s.batch?{batches:s.stepLedger?s.stepLedger.steps.flatMap(step=>step.batches):s.batch.batches,batchTotals:s.batch.totals,pendingSends:s.batch.pendingSends}:{}),currentReturn:s.returned?{factId:s.returned.fact_id,occurredAt:iso(s.returned.occurred_at),recordedAt:iso(s.returned.recorded_at)!}:null,orderId:id,preparationId:s.route?.preparation_id??null,revision:s.revision,secondaryCraft:s.route?.secondary_craft??null,reasons:[...s.gate.reasons,...(s.batch?.quantityConflict?['已发数量超过当前实裁，请核对原数量更正记录']:[]),...(!s.route?['全部PO实裁尚未完成']:[]),...(s.route&&!s.dispatched&&s.contract?.status!=='ready'?['当前原合同尚未生成，发厂前请在原合同页补齐资料']:[])],allCut:Boolean(s.route),allQc:s.allQc,inTransit:s.batch?s.batch.pendingSends.some(b=>b.rows.some(l=>l.remaining>0)):s.lastMovement?.kind==='工艺发出',dispatched:Boolean(s.dispatched),supplierId:s.gate.approval?.supplier_id??null,supplierName:s.gate.approval?.supplier_name_snapshot??null,productionId:link?.child_id??null,sampleTargetDate,canManage:isDigitalLeader(actor),canLogistics:await this.authorized(db,actor,s,'process_logistics'),canQc:await this.authorized(db,actor,s,'bulk_qc'),canWarehouse:await this.authorized(db,actor,s,'warehouse_dispatch'),canFollowup:false,tasks,lines:s.latest.map(({line,check})=>({lineId:line.line_id,poNumber:line.po_number,color:line.color,customerWarehouseArrivalDate:line.customer_date,sampleTargetDate:sampleTargets.lines.find(l=>l.lineId===line.line_id)?.targetDate??null,result:check?.result??null,problem:check?.problem??'',treatment:check?.treatment??''})),facts:s.facts.map(f=>({factId:f.fact_id,kind:f.kind,occurredAt:iso(f.occurred_at),recordedAt:iso(f.recorded_at)!,actorName:f.actor_name,payload:f.payload})),checks:s.checks.map(c=>({checkId:c.check_id,lineId:c.line_id,returnFactId:c.return_fact_id,result:c.result,problem:c.problem,treatment:c.treatment,attachmentIds:c.attachment_ids,checkedBy:c.checker,checkedAt:iso(c.checked_at)!,...(c.quantity_scope?{quantityScope:c.quantity_scope}:{})}))};
 }
 async craftRemediation(actor:TrustedActorContext,locator:CraftProblemLocator){
  const db=await this.database.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const access=new DigitalProductionAccessPolicy(db);
   await access.assert(actor,'order',locator.orderId,'technical');
   const sheet=await this.readFlow(actor,locator.orderId,db,db);
   const task=sheet.tasks.find(row=>row.taskKind==='bulk_qc'&&row.stepRef===locator.stepRef&&row.canExecute);
   if(!task||sheet.preparationId!==locator.preparationId)return digitalForbidden();
   const evidence=await readCurrentCraftProblem(db,locator);
   if(!evidence){await db.query('COMMIT');return null;}
   const original=(await db.query<{rework_id:string;execution:'factory'|'internal';status:string;quantity:number}>(`SELECT rework_order_id AS rework_id,
     craft_rework_execution AS execution,status,rework_quantity::int AS quantity FROM rework_orders
     WHERE source_craft_qc_check_id=$1 AND status NOT IN ('cancelled','deleted')`,[locator.checkId])).rows[0];
   if(!original){await db.query('COMMIT');return null;}
   const available=sheet.batches?.find(row=>row.factId===locator.returnFactId&&row.stepRef===locator.stepRef)?.rows.find(row=>row.lineId===locator.lineId)?.available??0;
   const proof=original.execution==='internal'&&task.state==='ready'&&!task.paused&&!sheet.dispatched?
    await internalCraftReinspection(db,{...locator,reworkId:original.rework_id,currentCheckId:locator.checkId},{unit:'片',inspectedQuantity:original.quantity,
      qualifiedQuantity:original.quantity,problemQuantity:0},available,evidence.actualReturned,false):null;
   await db.query('COMMIT');
   return {reworkId:original.rework_id,execution:original.execution,status:original.status,quantity:original.quantity,canConfirmReinspection:Boolean(proof)};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async warehouseCraftWork(actor:TrustedActorContext,id:string):Promise<WarehouseCraftWorkSheet>{
  if(!this.readWarehouseCraftOccupation)fail('原仓库工艺任务尚未接入当前质检放行依据');
  const db=await this.database.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const policy=new DigitalProductionAccessPolicy(db);
   await policy.assert(actor,'order',id,'technical');
   if(!actor.actorRoles.includes(ROOT)){
    const assigned=(await db.query('SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1',[id])).rows[0];
    if(assigned?.warehouse_worker_id!==actor.actorId||!await policy.activeRole(actor.actorId,'warehouse_receiver'))digitalForbidden();
   }
   const s=await this.state(db,id),choices:WarehouseCraftWorkChoice[]=[];
   const preparationId=s.route?.preparation_id;
   if(!preparationId||!s.stepLedger)fail('本单没有已采用的独立裁片工艺');
   if(!s.dispatched&&!s.gate.reasons.length&&!s.batch?.quantityConflict){
    for(const exact of s.stepLedger.steps){
     const step=exact.step,task=s.tasks.find(task=>task.task_kind==='process_logistics'&&task.step_id===step.stepId&&task.state==='ready');
     if(!task)continue;
     const fixed={stepRef:step.stepId,title:craftStepLabel(step),taskId:task.task_id};
     const add=(choice:Omit<WarehouseCraftWorkChoice,'id'|'stepRef'|'title'|'taskId'|'lines'>,limits:Iterable<readonly [string,number]>)=>{
      const lines=Array.from(limits,([lineId,remaining])=>{const line=s.lines.find(line=>line.line_id===lineId);return {lineId,remaining,poNumber:line?.po_number??null,color:line?.color??''};}).filter(line=>line.remaining>0);
      if(lines.length)choices.push({...fixed,...choice,lines,id:JSON.stringify([fixed.stepRef,choice.kind,choice.sourceFactId,choice.reworkId??null])});
     };
     const basis=await readWarehouseCraftFactoryBasis(db,id,step,false);
     const stepLimits=s.stepLedger.sendable.find(row=>row.stepRef===step.stepId)?.lines??[];
     const prior=step.sequence>1?s.stepLedger.steps[step.sequence-2]:null;
     if(basis){
      const sources=prior?.batches.map(batch=>({id:batch.factId,rows:batch.rows.map(row=>({lineId:row.lineId,remaining:row.releasedAvailable===undefined?
       Math.min(priorCraftReleasedPieces(prior,row),stepLimits.find(line=>line.lineId===row.lineId)?.remaining??0):row.available}))}))??[{id:null,rows:stepLimits}];
      for(const source of sources){
       const scope={orderId:id,preparationId,stepRef:step.stepId,sourceFactId:source.id};
       const limit=availableWarehouseCraftQuantities(scope,source.rows,await this.readWarehouseCraftOccupation!(db,scope));
       if(limit)add({kind:'send',sourceFactId:source.id,factoryId:basis.supplierId,factoryName:basis.supplierName},limit);
      }
     }
     for(const send of exact.pendingSends){
      const original=s.facts.find(fact=>fact.fact_id===send.factId),motion=original?.payload.warehouseMotion;
      if(!motion?.factoryId||!original?.payload.supplier)continue;
      add({kind:'return',sourceFactId:send.factId,factoryId:motion.factoryId,factoryName:original.payload.supplier,
       ...(motion.reworkId?{reworkId:motion.reworkId}:{})},send.rows.map(row=>[row.lineId,row.remaining] as const));
     }
     const repairs=(await db.query<{id:string;line_id:string;fact_id:string;factory_id:string;factory_name:string;quantity:number}>(`SELECT r.rework_order_id AS id,
      q.line_id,q.return_fact_id AS fact_id,f.payload#>>'{warehouseMotion,factoryId}' AS factory_id,f.payload->>'supplier' AS factory_name,r.rework_quantity::int AS quantity
      FROM rework_orders r JOIN digital_factory_qc q ON q.check_id=r.source_craft_qc_check_id
      JOIN digital_factory_facts f ON f.fact_id=q.return_fact_id AND f.preparation_id=q.preparation_id
      WHERE q.preparation_id=$1 AND f.payload->>'stepRef'=$2 AND r.craft_rework_execution='factory' AND r.status='in_progress'`,[preparationId,step.stepId])).rows;
     for(const repair of repairs){
      if(!repair.factory_id||!repair.factory_name)continue;
      const sent=s.facts.filter(fact=>fact.kind==='工艺发出'&&fact.payload.warehouseMotion?.reworkId===repair.id)
       .reduce((total,fact)=>total+(fact.payload.lines?.find((line:FactoryScope)=>line.lineId===repair.line_id)?.quantity??0),0);
      const remaining=exact.batches.find(batch=>batch.factId===repair.fact_id)?.rows.find(row=>row.lineId===repair.line_id)?.available??0;
      add({kind:'send',sourceFactId:repair.fact_id,factoryId:repair.factory_id,factoryName:repair.factory_name,reworkId:repair.id},
       [[repair.line_id,Math.min(remaining,repair.quantity-sent)]]);
     }
    }
   }
   await db.query('COMMIT');return {orderId:id,preparationId,revision:s.revision,choices};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private async command(actor:TrustedActorContext,id:string,action:string,input:{expectedRevision:number},key:string,work:(db:PoolClient,s:Awaited<ReturnType<FactoryFlowService['state']>>)=>Promise<void>,authorizeReplay?:(db:PoolClient)=>Promise<void>){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[id]);
   await authorizeReplay?.(db);
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
 private checkTime(at:string|null,earliest?:Date|string|null){if(at&&(!Number.isFinite(new Date(at).getTime())||new Date(at).getTime()>businessNow().getTime()||earliest&&new Date(at)<new Date(earliest)))fail('真实时间不能晚于当前或早于前置发生时间；请在本页操作记录核对最近的实际发出、回仓或到厂时间后填写，不要用预计日期替代');}
 private async fact(db:PoolClient,actor:TrustedActorContext,prep:string,kind:string,at:string|null,payload:unknown){const id=randomUUID();await db.query('INSERT INTO digital_factory_facts(fact_id,preparation_id,sequence,kind,payload,actor_id,occurred_at) SELECT $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5,$6 FROM digital_factory_facts WHERE preparation_id=$2',[id,prep,kind,JSON.stringify(payload),actor.actorId,at]);return id;}
 private async dispatchEvidence(db:PoolClient,id:string,s:Awaited<ReturnType<FactoryFlowService['state']>>,lines?:readonly FactoryScope[]){
  const approval=s.gate.approval,contract=s.contract;
  if(!approval||contract?.status!=='ready')return {};
  const dispatchEvidence=await warehouseFactoryDispatchEvidence(db,id,{sourcingCaseId:approval.sourcing_case_id,
   sourcingDecisionId:approval.sourcing_decision_id,approvalSnapshotId:approval.sourcing_approval_snapshot_id,
   contractDocumentId:contract.sourcing_contract_document_id},lines);
  return dispatchEvidence?{dispatchEvidence}:{};
 }
 async logistics(actor:TrustedActorContext,id:string,input:FactoryLogistics,key:string){
  if(input.warehouse){
   if(input.kind==='工艺沟通'||!input.stepRef||!input.occurredAt||!input.lines)return fail('原仓库实际收发须引用真实工艺及本批范围');
   const {reworkId,...warehouse}=input.warehouse,kind=input.kind==='工艺发出'?'send':'return';
   const native={...warehouse,kind,stepRef:input.stepRef,occurredAt:input.occurredAt,lines:input.lines,expectedRevision:input.expectedRevision,note:input.note,
    sourceFactId:(kind==='send'?input.fromReturnId:input.sendFactId)??null} as const;
   return reworkId?this.warehouseCraftRepair(actor,id,{...native,reworkId},key):this.warehouseCraftMotion(actor,id,native,key);
  }
  return this.command(actor,id,'logistics',input,key,async(db,s)=>{
  if(!await this.authorized(db,actor,s,'process_logistics',input.stepRef))digitalForbidden();if(s.batch)return this.batchLogistics(db,actor,s,input);if(s.dispatched)fail('已发厂，裁后工艺记录已结束');if(s.tasks.find(t=>t.task_kind==='process_logistics')?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,'process_logistics'));
  if(input.kind==='工艺沟通'&&!input.note.trim())fail('请填写沟通记录');
  if(input.kind==='工艺发出'&&s.lastMovement?.kind==='工艺发出')fail('整款已在工艺厂，不能重复发出');
  if(input.kind==='工艺发出'&&!input.supplier.trim())fail('请登记实际工艺供应厂');
  if(input.kind==='工艺回仓'&&s.lastMovement?.kind!=='工艺发出')fail('须有整款工艺发出事实才能回仓；请印绣洗跟单在本页工艺物流核对最近一次发出记录，按实际交接顺序登记');
  this.checkTime(input.occurredAt,input.kind==='工艺沟通'?null:this.latestTime(s.route.cutting_completed_at,s.lastMovement?.occurred_at));
  await this.fact(db,actor,s.route.preparation_id,input.kind,input.occurredAt,{supplier:input.supplier,note:input.note});
  if(input.kind==='工艺回仓'){const task=s.tasks.find(t=>t.task_kind==='bulk_qc');await this.tasks().setConditionWithClient(db,actor,task.task_id,'handover_received',true,input.occurredAt,'整款工艺已回仓待QC');}
 });}
 /** Joint X3/X5 internal command. No route enables it without the original
  * quality occupation reader. Uses the existing fact, task and receipt path. */
 private async assertAssignedWarehouse(db:PoolClient,actor:TrustedActorContext,id:string){
  if(actor.actorRoles.includes(ROOT))return;
  const assignment=(await db.query('SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1',[id])).rows[0];
  if(assignment?.warehouse_worker_id!==actor.actorId||!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,'warehouse_receiver'))digitalForbidden();
 }
 async warehouseCraftMotion(actor:TrustedActorContext,id:string,input:WarehouseCraftCommand,key:string){
  const readOccupation=this.readWarehouseCraftOccupation;
  if(!readOccupation)return fail('仓库工艺收发尚无有效质检返工占用依据');
  return this.command(actor,id,'logistics',warehouseCraftPayload(input),key,async(db,s)=>{
   const step=s.stepLedger?.steps.find(value=>value.step.stepId===input.stepRef);
   if(!step||s.route.preparation_id!==input.preparationId||!s.tasks.some(task=>task.task_id===input.taskId&&task.task_kind==='process_logistics'&&
    task.step_id===input.stepRef&&task.state==='ready'))return fail('仓库收发须引用本单当前独立工艺的原任务');
   if(input.kind!=='send'&&input.kind!=='return')return fail('收发动作不合法');
   const scope={orderId:id,preparationId:input.preparationId,stepRef:input.stepRef};
   const prior=step.step.sequence>1?s.stepLedger!.steps[step.step.sequence-2]:undefined;
   const send=input.kind==='return'?step.pendingSends.find(row=>row.factId===input.sourceFactId):undefined;
   const sendFact=send?s.facts.find(row=>row.fact_id===send.factId):undefined;
   if(sendFact?.payload.warehouseMotion?.reworkId)fail('本次实际发出属于原返工，请沿同一返工范围回仓');
   const approved=input.kind==='send'?await readWarehouseCraftFactoryBasis(db,id,step.step,true):null;
   const factoryId=input.kind==='send'?approved?.supplierId:sendFact?.payload.warehouseMotion?.factoryId;
   const supplier=input.kind==='send'?approved?.supplierName:sendFact?.payload.supplier;
   if(!factoryId||!supplier)return fail('缺少本工艺批准工厂或实际发出工厂依据');
   const predecessor=prior?.batches.find(row=>row.factId===input.sourceFactId);
   if(input.kind==='send'&&(prior?!predecessor:input.sourceFactId!==null)||input.kind==='return'&&!send)
    return fail('请核对本工艺可用的实裁、前道放行批次或原发出批次');
   const stepLimits=s.stepLedger!.sendable.find(row=>row.stepRef===input.stepRef)!.lines;
   const quantities=send?send.rows:predecessor?predecessor.rows.map(row=>({lineId:row.lineId,
    remaining:row.releasedAvailable===undefined?Math.min(priorCraftReleasedPieces(prior!,row),stepLimits.find(value=>value.lineId===row.lineId)?.remaining??0):row.available})):stepLimits;
   const occurredAt=this.latestTime(s.route.cutting_completed_at,send?.occurredAt,predecessor?.occurredAt)?.toISOString();
   const occupation=await readOccupation(db,{...scope,sourceFactId:input.sourceFactId});
   if(!occurredAt||!qualifyWarehouseCraftMovement({motion:{...input,scope},original:{...scope,factId:input.sourceFactId,factoryId,occurredAt,quantities},
    occupation,asOf:businessNow().toISOString()}))return fail('本批工厂、时间或可用余量已变化，原返工占用不能发出或回补');
   await this.batchLogistics(db,actor,s,{kind:input.kind==='send'?'工艺发出':'工艺回仓',expectedRevision:input.expectedRevision,
    note:input.note,supplier,stepRef:input.stepRef,occurredAt:input.occurredAt,lines:input.lines,
    ...(input.sourceFactId?input.kind==='return'?{sendFactId:input.sourceFactId}:{fromReturnId:input.sourceFactId}:{})},
    {factoryId,...(approved?{approvalId:approved.approvalId,approvalRevision:approved.approvalRevision,supplierVersion:approved.supplierVersion}:{})});
  },db=>this.assertAssignedWarehouse(db,actor,id));
 }
 async warehouseCraftRepair(actor:TrustedActorContext,id:string,input:WarehouseCraftRepairCommand,key:string){
  if(!this.readWarehouseCraftOccupation)return fail('仓库返工收发尚无有效质检返工占用依据');
  return this.command(actor,id,'logistics',warehouseCraftPayload(input,input.reworkId),key,async(db,s)=>{
   const exact=await lockExternalCraftRepair(db,id,input.reworkId),step=s.stepLedger?.steps.find(item=>item.step.stepId===input.stepRef);
   if(!exact||!step||!input.sourceFactId||!['send','return'].includes(input.kind)||s.route.preparation_id!==exact.preparationId
    ||input.preparationId!==exact.preparationId||input.stepRef!==exact.stepRef||input.factoryId!==exact.factoryId
    ||!s.tasks.some(task=>task.task_id===input.taskId&&task.task_kind==='process_logistics'&&task.step_id===exact.stepRef&&task.state==='ready'))
    return fail('请沿本单原工艺、原返工、真实工厂及仓库任务办理收发');
   const original=s.facts.find(row=>row.fact_id===exact.originalReturnFactId),source=s.facts.find(row=>row.fact_id===input.sourceFactId),
    check=s.checks.find(row=>row.check_id===exact.checkId),qty=input.lines[0];
   if(!original||!source||!check||input.lines.length!==1||qty?.lineId!==exact.lineId||!Number.isFinite(Date.parse(input.occurredAt)))
    return fail('本次返工须绑定原检查与实际发出/回仓片数');
   if(input.kind==='send'){
    const available=step.batches.find(batch=>batch.factId===exact.originalReturnFactId)?.rows.find(row=>row.lineId===exact.lineId)?.available??0;
    if(source.fact_id!==exact.originalReturnFactId||(qty?.quantity??0)>available)return fail('本次返工发出超过原回仓批次有效余量');
   }
   this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,source.occurred_at,check.checked_at));
   const kind=input.kind==='send'?'工艺发出':'工艺回仓';
   const payload={supplier:original.payload.supplier,note:input.note,stepRef:exact.stepRef,lines:input.lines,
    ...(input.kind==='send'?{fromReturnId:input.sourceFactId}:{sendFactId:input.sourceFactId}),
    warehouseMotion:{factoryId:exact.factoryId,reworkId:exact.reworkId,checkId:exact.checkId}};
   if(!checkedExternalCraftRepairFact(exact,s.facts,{fact_id:randomUUID(),kind,payload,occurred_at:input.occurredAt}))
    return fail('原返工尚未进入实际执行，或当前发出/回补超过同一范围');
   await this.fact(db,actor,exact.preparationId,kind,input.occurredAt,payload);
   if(input.kind==='return'){
    const qc=s.tasks.find(task=>task.task_kind==='bulk_qc'&&task.step_id===exact.stepRef);
    if(!qc)return fail('该工艺缺少原复检任务，请在原订单核对');
    await this.tasks().setConditionWithClient(db,actor,qc.task_id,'handover_received',true,input.occurredAt,'实际返工回仓待原质量复检');
   }
  },db=>this.assertAssignedWarehouse(db,actor,id));
 }
 async qc(actor:TrustedActorContext,id:string,input:FactoryQc,key:string){return this.command(actor,id,'qc',input,key,async(db,s)=>{
  if(input.internalReworkId&&(!input.returnFactId||!input.stepRef||input.checks.length!==1||!s.stepLedger||!this.readWarehouseCraftOccupation))
   fail('本厂返工复检须引用同一工艺、本批回仓及本次原返工');
  if(!await this.authorized(db,actor,s,'bulk_qc',input.stepRef))digitalForbidden();const checkedAt=businessNow().toISOString();if(s.batch)return this.batchQc(db,actor,s,input,checkedAt);if(input.checks.some(check=>check.quantityScope))fail('分量检查需要原工艺回仓批次');if(s.dispatched||!s.returned)fail(s.dispatched?'本单已经实际发厂，本轮QC记录已结束；请QC在本单操作记录核对原检查结果，不要补写本轮检查':'尚无整款工艺回仓记录；请印绣洗跟单在本单工艺物流登记实际回仓，再由QC逐PO检查');if(s.tasks.find(t=>t.task_kind==='bulk_qc')?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,'bulk_qc'));
  this.checkTime(checkedAt,this.latestTime(s.route.cutting_completed_at,s.returned.occurred_at));
  if(new Set(input.checks.map(c=>c.lineId)).size!==input.checks.length||input.checks.some(c=>!s.lines.some(l=>l.line_id===c.lineId)))fail('检查款色必须属于本母单且不可重复');
  for(const check of input.checks){
   if(check.result==='需处理'&&!check.problem.trim())fail('需处理必须说明问题及处理要求');
   if(new Set(check.attachmentIds).size!==check.attachmentIds.length)fail('图片不可重复');
   const images=await db.query("SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2 AND status='ready' AND entity_type IS NULL AND entity_id IS NULL AND mime_type IN ('image/jpeg','image/png','image/webp') FOR UPDATE",[check.attachmentIds,actor.actorId]);if(images.rowCount!==check.attachmentIds.length)fail('检查图片须由本人上传并可用，不能借用其他模块图片');
   const checkId=randomUUID();await db.query('INSERT INTO digital_factory_qc(check_id,preparation_id,return_fact_id,line_id,result,problem,treatment,attachment_ids,checked_by,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[checkId,s.route.preparation_id,s.returned.fact_id,check.lineId,check.result,check.problem,check.treatment,check.attachmentIds,actor.actorId,checkedAt]);
   await db.query("UPDATE attachments SET entity_type='digital_factory_qc',entity_id=$1,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($2::uuid[])",[checkId,check.attachmentIds]);
  }
 });}
 async dispatch(actor:TrustedActorContext,id:string,request:FactoryDispatch,key:string){return this.command(actor,id,'warehouse',request,key,async(db,s)=>{
  // Resolve only inside the first execution, after the original idempotency check.
  const input={...request,occurredAt:request.occurredAt===undefined?businessNow().toISOString():request.occurredAt};
  if(!await this.authorized(db,actor,s,'warehouse_dispatch'))digitalForbidden();if(s.batch)return this.batchDispatch(db,actor,id,s,input);if(s.dispatched)fail('整款已实际发厂，不能重复发出');if(!s.allQc)fail(`任一PO工艺QC未合格，整款不可发厂：${!s.returned?'尚无本轮工艺回仓记录，请印绣洗跟单在工艺物流登记实际回仓':s.latest.filter(row=>row.check?.result!=='合格').map(row=>`PO ${row.line.po_number}／${row.line.color}：${row.check?.result==='需处理'?'问题待处理及复查':'尚未检查'}`).join('；')}。请QC在本单工艺QC逐项处理，仓库随后登记实际发厂。`);
  if(input.supplierId!==s.gate.approval?.supplier_id)fail('请刷新确认当前原批准的唯一加工厂');
  const task=s.tasks.find(t=>t.task_kind==='warehouse_dispatch');if(task?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,'warehouse_dispatch'));
  this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,s.returned?.occurred_at,...s.latest.map(l=>l.check?.checked_at)));
  const factId=await this.fact(db,actor,s.route.preparation_id,'仓库实际发厂',input.occurredAt,{supplierId:input.supplierId,note:input.note,...await this.dispatchEvidence(db,id,s)});
  await new SourcingProductionService(this.database).dispatchDigitalWithClient(db,actor,id,factId);
  await this.ensureProductionQc(db,actor,id,s.route.preparation_id);
  await startQcTrackingFromDispatch(db,actor,id,factId);
  await this.tasks().completeFactoryDispatchFactsWithClient(db,actor,id,factId);
 });}
 private scope(input:FactoryScope[]|undefined,limits:Array<{lineId:string;remaining:number}>):FactoryScope[]{
  const value=input??limits.filter(l=>l.remaining>0).map(l=>({lineId:l.lineId,quantity:l.remaining}));
  if(!value.length||new Set(value.map(l=>l.lineId)).size!==value.length||value.some(l=>!Number.isSafeInteger(l.quantity)||l.quantity<=0||l.quantity>(limits.find(x=>x.lineId===l.lineId)?.remaining??0)))fail('本批PO或数量不合法，不能超过当前未发/未回余量；请刷新核对');
  return value;
 }
 private async batchLogistics(db:PoolClient,actor:TrustedActorContext,s:Awaited<ReturnType<FactoryFlowService['state']>>,input:FactoryLogistics,warehouseMotion?:{factoryId:string;approvalId?:string;approvalRevision?:number;supplierVersion?:number}){
  const step=s.stepLedger?s.stepLedger.steps.find(step=>step.step.stepId===input.stepRef):null;
  if(s.stepLedger&&!step)fail('请明确本次实际办理的绣花或印花步骤');
  if(s.dispatched||s.tasks.find(t=>t.task_kind==='process_logistics'&&(!step||t.step_id===step.step.stepId))?.state!=='ready')fail('本轮工艺任务不可办理');
  const identity=step?{stepRef:step.step.stepId}:{};
  if(input.kind==='工艺沟通'){if(!input.note.trim())fail('请填写沟通记录');this.checkTime(input.occurredAt);await this.fact(db,actor,s.route.preparation_id,input.kind,input.occurredAt,{supplier:input.supplier,note:input.note,...identity});return;}
  const ledger=step??s.batch!;let lines:FactoryScope[],sendFactId:string|undefined,fromReturnId:string|undefined;
  if(input.kind==='工艺发出'){
   if(!input.supplier.trim())fail('请登记实际工艺供应厂');
   fromReturnId=input.fromReturnId;
   // Old whole-order form may re-send the current return, but never resend dispatched pieces.
   if(!input.lines&&!fromReturnId&&ledger.totals.every(l=>l.craftRemaining===0))fromReturnId=ledger.batches.at(-1)?.factId;
   const prior=step&&step.step.sequence>1?s.stepLedger!.steps[step.step.sequence-2]:null;
   const own=fromReturnId?ledger.batches.find(b=>b.factId===fromReturnId):null;
   const previous=fromReturnId?prior?.batches.find(b=>b.factId===fromReturnId):null;
   const from=own??previous;if(fromReturnId&&!from)fail('来源批次不属于本单该步骤或其前一道工艺');
   if(prior&&!own&&!previous)fail('后一道工艺须选择前一道已检查放行的真实回仓批次');
   const sendable=step?s.stepLedger!.sendable.find(row=>row.stepRef===step.step.stepId)!.lines:null;
   lines=this.scope(input.lines,from?from.rows.map(l=>({lineId:l.lineId,remaining:previous?Math.min(priorCraftReleasedPieces(prior!,l),sendable!.find(row=>row.lineId===l.lineId)?.remaining??0):l.available})):sendable??ledger.totals.map(l=>({lineId:l.lineId,remaining:l.craftRemaining})));
   // The pre-existing workflow is still valid for ordinary movements, but
   // must not silently surrender counted pieces reserved for original rework.
   if(!warehouseMotion&&step&&from&&this.readWarehouseCraftOccupation){
    const scope={orderId:s.route.production_order_id,preparationId:s.route.preparation_id,stepRef:step.step.stepId,sourceFactId:from.factId};
    const available=availableWarehouseCraftQuantities(scope,from.rows.map(row=>({lineId:row.lineId,remaining:row.available})),await this.readWarehouseCraftOccupation(db,scope));
    if(!available||lines.some(line=>line.quantity>(available.get(line.lineId)??0)))fail('原质检或返工已占用本批部分裁片，请从原返工办理对应范围');
   }
   this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,from?.occurredAt));
  }else{
   sendFactId=input.sendFactId??ledger.pendingSends.filter(b=>b.rows.some(l=>l.remaining>0)).at(-1)?.factId;
   const send=ledger.pendingSends.find(b=>b.factId===sendFactId);if(!send)fail('请选本单尚有未回数量的工艺发出批次');
   if(!warehouseMotion&&this.readWarehouseCraftOccupation&&s.facts.find(fact=>fact.fact_id===sendFactId)?.payload.warehouseMotion)
    fail('本批使用原仓库任务发出，请沿同一仓库任务和工厂范围登记回仓');
   lines=this.scope(input.lines,send!.rows);this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,send!.occurredAt));
  }
  await this.fact(db,actor,s.route.preparation_id,input.kind,input.occurredAt,{supplier:input.supplier,note:input.note,lines,...identity,...(sendFactId?{sendFactId}:{}),...(fromReturnId?{fromReturnId}:{}),...(warehouseMotion?{warehouseMotion}:{})});
  if(input.kind==='工艺回仓'){const task=s.tasks.find(t=>t.task_kind==='bulk_qc'&&(!step||t.step_id===step.step.stepId));await this.tasks().setConditionWithClient(db,actor,task.task_id,'handover_received',true,input.occurredAt,'本工艺已有批次回仓，先回先检查');}
 }
 private async batchQc(db:PoolClient,actor:TrustedActorContext,s:Awaited<ReturnType<FactoryFlowService['state']>>,input:FactoryQc,checkedAt:string){
  const step=s.stepLedger?s.stepLedger.steps.find(step=>step.step.stepId===input.stepRef):null;
  if(s.stepLedger&&!step)fail('请明确本次检查的绣花或印花步骤');
  const batch=(step??s.batch!).batches.find(b=>b.factId===(input.returnFactId??s.returned?.fact_id));
  if(s.dispatched||!batch||s.tasks.find(t=>t.task_kind==='bulk_qc'&&(!step||t.step_id===step.step.stepId))?.state!=='ready')fail('请在本单选择该工艺可检查的实际回仓批次');
  this.checkTime(checkedAt,this.latestTime(s.route.cutting_completed_at,batch!.occurredAt));
  if(new Set(input.checks.map(c=>c.lineId)).size!==input.checks.length)fail('同批检查PO不可重复');
  const nativeReturn=s.facts.find(fact=>fact.fact_id===batch!.factId);
  const externalReworkId=nativeReturn?.payload.warehouseMotion?.reworkId;
  if(externalReworkId){
   const exact=await lockExternalCraftRepair(db,s.route.production_order_id,externalReworkId);
   const physical=exact?await readExternalCraftRepairProof(db,exact.reworkId):null;
   if(!exact||exact.status==='cancelled'||!physical?.physicalCompletedAt||!physical.returnFactIds.includes(batch!.factId)||
    input.checks.some(check=>check.lineId!==exact.lineId||!check.quantityScope))
    fail('原外厂返修须同一范围全部实际回仓，再按实际回仓批次分量复检；财务状态不代替复检');
  }
  for(const check of input.checks){
   const row=batch!.rows.find(l=>l.lineId===check.lineId);if(!row||row.available<=0)fail('本批PO已发完或已重新发工艺，不可覆盖检查');
   const prior=s.checks.filter(c=>c.return_fact_id===batch!.factId&&c.line_id===check.lineId).at(-1);
   if(input.internalReworkId){
    if(!prior?.quantity_scope||!step||externalReworkId||check.result!=='合格'||check.allowDispatch||check.dispatchReason||!nativeReturn)
     fail('本次仅确认原本厂返工且已实际复检合格的片数，未通过的范围继续保留为原问题');
    const verified=await internalCraftReinspection(db,{reworkId:input.internalReworkId,orderId:s.route.production_order_id,
     preparationId:s.route.preparation_id,returnFactId:batch!.factId,stepRef:step.step.stepId,lineId:check.lineId,currentCheckId:prior.check_id},
     check.quantityScope,row.available,row.returned);
    if(!verified)fail('原本厂返工还未完成实际执行，或复检不属于本批已完成的原数量');
    if(!await exactUnboundQualityPhotos(db,actor.actorId,check.attachmentIds))fail('复检图片须由本人上传并可用');
    const checkId=randomUUID(),hasProblems=verified.count.problemQuantity>0;
    await db.query(`INSERT INTO digital_factory_qc(check_id,preparation_id,return_fact_id,line_id,result,problem,treatment,attachment_ids,checked_by,
      allow_dispatch,dispatch_reason,checked_at,quantity_scope,reinspection_rework_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
     [checkId,s.route.preparation_id,batch!.factId,check.lineId,hasProblems?'需处理':'合格',hasProblems?verified.problem:'',check.treatment||verified.treatment,
      check.attachmentIds,actor.actorId,hasProblems&&verified.allowDispatch,hasProblems?verified.dispatchReason:'',checkedAt,JSON.stringify(verified.count),input.internalReworkId]);
    await db.query("UPDATE attachments SET entity_type='digital_factory_qc',entity_id=$1,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($2::uuid[])",[checkId,check.attachmentIds]);
    continue;
   }
   const counted=check.quantityScope&&row?countedCraftCheck(check.quantityScope,row.returned):null;
   if(check.quantityScope){
    const original=nativeReturn;
    const outgoing=original?.payload.sendFactId?s.facts.find(fact=>fact.fact_id===original.payload.sendFactId&&fact.kind==='工艺发出'):null;
    if(!counted||!step||!this.readWarehouseCraftOccupation||input.returnFactId!==batch!.factId||
      original?.payload.stepRef!==step.step.stepId||outgoing?.payload.stepRef!==step.step.stepId||
      !original?.payload.warehouseMotion?.factoryId||outgoing?.payload.warehouseMotion?.factoryId!==original.payload.warehouseMotion.factoryId||
      !row||row.available!==row.returned||(check.result==='需处理')!==(counted.problemQuantity>0))
     fail('请按同一原回仓批次核对合格、问题和未检片数；已发或在返工的范围不可覆盖');
    if(prior?.quantity_scope)fail('该批已保存真实分量检查，请按原问题范围办理返工或复检');
   }else if(prior?.quantity_scope)fail('该批已保存分量检查，请保留原回仓数量依据');
   if(check.result==='需处理'&&!check.problem.trim())fail('需处理必须保留原问题');
   if(check.allowDispatch&&(check.result!=='需处理'||!check.dispatchReason?.trim()||!check.treatment.trim()))fail('不合格先发须由质检填写原因及后续安排');
   if(new Set(check.attachmentIds).size!==check.attachmentIds.length)fail('图片不可重复');
   const images=await db.query("SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2 AND status='ready' AND entity_type IS NULL AND entity_id IS NULL AND mime_type IN ('image/jpeg','image/png','image/webp') FOR UPDATE",[check.attachmentIds,actor.actorId]);if(images.rowCount!==check.attachmentIds.length)fail('检查图片须由本人上传并可用');
   const checkId=randomUUID();
   if(counted)await db.query('INSERT INTO digital_factory_qc(check_id,preparation_id,return_fact_id,line_id,result,problem,treatment,attachment_ids,checked_by,allow_dispatch,dispatch_reason,checked_at,quantity_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[checkId,s.route.preparation_id,batch!.factId,check.lineId,check.result,check.problem,check.treatment,check.attachmentIds,actor.actorId,check.allowDispatch??false,check.dispatchReason??'',checkedAt,JSON.stringify(counted)]);
   else await db.query('INSERT INTO digital_factory_qc(check_id,preparation_id,return_fact_id,line_id,result,problem,treatment,attachment_ids,checked_by,allow_dispatch,dispatch_reason,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[checkId,s.route.preparation_id,batch!.factId,check.lineId,check.result,check.problem,check.treatment,check.attachmentIds,actor.actorId,check.allowDispatch??false,check.dispatchReason??'',checkedAt]);
   await db.query("UPDATE attachments SET entity_type='digital_factory_qc',entity_id=$1,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($2::uuid[])",[checkId,check.attachmentIds]);
  }
 }
 private async batchDispatch(db:PoolClient,actor:TrustedActorContext,id:string,s:Awaited<ReturnType<FactoryFlowService['state']>>,input:FactoryDispatch&{occurredAt:string}){
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
  const limits=batch?batch.rows.map(l=>({lineId:l.lineId,remaining:Math.min(factoryBatchReleaseAvailable(l),s.batch!.totals.find(t=>t.lineId===l.lineId)?.remaining??0)})):s.batch!.totals;
  const lines=this.scope(input.lines,limits);
  if(batch&&s.stepLedger&&this.readWarehouseCraftOccupation){
   const scope={orderId:id,preparationId:s.route.preparation_id,stepRef:s.stepLedger.terminalStepRef,sourceFactId:batch.factId};
   const physical=batch.rows.map(row=>({lineId:row.lineId,remaining:row.releasedAvailable===undefined?(limits.find(limit=>limit.lineId===row.lineId)?.remaining??0):row.available}));
   const available=availableWarehouseCraftQuantities(scope,physical,await this.readWarehouseCraftOccupation(db,scope));
   if(!available||lines.some(line=>line.quantity>(available.get(line.lineId)??0)))fail('本批放行数量或返工占用已变，请核对原检查与复检后再实际发厂');
  }
  if(s.tasks.find(t=>t.task_kind==='warehouse_dispatch')?.state!=='ready')fail(await this.taskBlockReason(db,actor,s,'warehouse_dispatch'));
  this.checkTime(input.occurredAt,this.latestTime(s.route.cutting_completed_at,batch?.occurredAt,...(batch?.rows.filter(l=>lines.some(x=>x.lineId===l.lineId)).map(l=>l.checkedAt)??[])));
  const factId=await this.fact(db,actor,s.route.preparation_id,'仓库实际发厂',input.occurredAt,{supplierId:input.supplierId,note:input.note,lines,...await this.dispatchEvidence(db,id,s,lines),...(s.stepLedger?{stepRef:s.stepLedger.terminalStepRef}:{}),...(batch?{returnFactId:batch.factId,releaseCheckIds:lines.map(l=>({lineId:l.lineId,checkId:s.checks.filter(c=>c.return_fact_id===batch.factId&&c.line_id===l.lineId).at(-1)!.check_id}))}:{})});
  await new SourcingProductionService(this.database).dispatchDigitalWithClient(db,actor,id,factId);
  await this.ensureProductionQc(db,actor,id,s.route.preparation_id);
  await startQcTrackingFromDispatch(db,actor,id,factId);
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
  const photos=input.checks.flatMap(check=>check.attachmentIds??[]);
  if(!await exactUnboundQualityPhotos(db,actor.actorId,photos))fail('检查图片须由本人上传并可用，不可跨PO或复用原检查图片');
  const eventId=randomUUID(),checks=input.checks.map(c=>({...c,allocationQuantity:Number(scopes.find(r=>r.line_id===c.lineId).quantity)}));
  await db.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
   VALUES($1,$2,'order',$3,'factory_garment_qc',$4,$5,'补报未核实',$6)`,[eventId,task.task_id,id,actor.actorId,input.occurredAt,JSON.stringify({productionId:scopes[0].production_order_id,factoryDecisionId:input.factoryDecisionId,checks,note:input.note})]);
  if(photos.length)await db.query('UPDATE attachments SET entity_type=$1,entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($3::uuid[])',[factoryInspectionQualityAttachment,eventId,photos]);
  const after=await factoryProductionFacts(db,id);
  if(after.complete&&task.state!=='completed'){
   const completedAt=new Date(Math.max(...after.checks.map(c=>Date.parse(c.completedAt!)))).toISOString();
   await this.tasks().setConditionWithClient(db,actor,task.task_id,'business_recorded',true,completedAt,'工厂检查已完成，质量结论仍以各PO检查记录为准');
   await this.tasks().completeWithClient(db,actor,task.task_id,{occurredAt:completedAt,note:input.note},`factory-qc:${eventId}`);
  }
 });}
 async followup(actor:TrustedActorContext,id:string,input:FactoryFollowup,key:string){
  if(input.kind!=='船样寄出'){
   await new DigitalProductionAccessPolicy(this.database).assert(actor,'order',id,'technical');
   throw new ApplicationError('FACTORY_RECEIPT_RETIRED','工厂到料确认和到料清点已停用，无需填报；原历史保留，船样仍在原入口办理',410);
  }
  await new ShipSampleService(this.database).record(actor,id,input,key);return this.read(actor,id);
 }
 async authorizeUpload(actor:TrustedActorContext,id:string){
  await new DigitalProductionAccessPolicy(this.database).assert(actor,'order',id,'technical');const s=await this.state(this.database,id);
  const hasReturnedScope=s.batch?s.batch.batches.some(batch=>batch.rows.some(row=>row.available>0)):Boolean(s.returned);
  if(!await this.authorized(this.database,actor,s,'bulk_qc')||s.dispatched||!hasReturnedScope)digitalForbidden();
 }
 async authorizeProductionQcPhoto(actor:TrustedActorContext,id:string,ref:{productionId:string;factoryDecisionId:string|null;lineId:string}){
  const db=await this.database.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const policy=new DigitalProductionAccessPolicy(db);
   await policy.assert(actor,'order',id,'technical');
   const state=await this.state(db,id);
   if(!await this.authorized(db,actor,state,'factory_production_qc')||!actor.actorRoles.includes(ROOT)&&!await policy.activeRole(actor.actorId,'quality_control'))digitalForbidden();
   if(state.gate.terminal)fail('本单已停止办理，保留原检查事实');
   const scopes=await factoryProductionScopes(db,id);
   if(scopes.filter(row=>row.production_order_id===ref.productionId&&row.factory_decision_id===ref.factoryDecisionId&&row.line_id===ref.lineId).length!==1)fail('本工厂检查范围已变，请重新读取');
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async canDownloadOriginal(actor:TrustedActorContext,ref:Extract<OriginalQualityPhotoReference,{kind:'craft-return'|'factory-inspection'}>){
  return canReadExactOriginalQualityPhoto(this.database,actor,ref);
 }
 async canDownload(actor:TrustedActorContext,id:string,attachmentId:string){if(!await new DigitalProductionAccessPolicy(this.database).allowed(actor,'order',id,'technical'))return false;return Boolean((await this.database.query("SELECT 1 FROM digital_factory_qc q JOIN digital_factory_routes r USING(preparation_id) JOIN attachments a ON a.attachment_id=ANY(q.attachment_ids) AND a.entity_type='digital_factory_qc' AND a.entity_id=q.check_id::text WHERE r.production_order_id=$1 AND a.attachment_id=$2 AND a.status='ready'",[id,attachmentId])).rowCount);}
}
