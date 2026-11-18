import {assertWashingReworkBinding,attachWashingReworkPlans} from './bulk-washing-rework-binding.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {BulkWashingCommandSchema,type BulkWashingCommand,type BulkWashingSheet,type BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import {garmentQuality} from './garment-quality.js';
import {factoryProductionScopes} from './factory-production-facts.js';
import {bulkWashingLedger} from './bulk-washing-ledger.js';
import {bulkWashingWindows} from './bulk-washing-windows.js';
import {journeyTermination} from './journey-termination.js';
import {refreshBulkWashingCoverage} from './bulk-washing-coverage.js';
import {washingOrderActive,washingPlans,washingEvents,washingFact,washingHash,washingConflict,type WashingDB,type WashingPlan} from './bulk-washing-repository.js';

async function root(db:WashingDB,actor:TrustedActorContext){return actor.actorRoles.includes('root_superuser')&&Boolean((await db.query('SELECT access_is_root_actor($1) AS allowed',[actor.actorId])).rows[0]?.allowed);}
async function capabilities(db:WashingDB,actor:TrustedActorContext,plan:WashingPlan,lock=false){
 const policy=new DigitalProductionAccessPolicy(db),isRoot=await root(db,actor);
 const role=(id:string,name:string)=>actor.actorId===id&&(lock?policy.lockActiveRole(id,name):policy.activeRole(id,name));
 return {canLogistics:isRoot||await role(plan.document.staff?.logisticsId??'','embroidery_washing_merchandiser'),
  canInspect:isRoot||await role(plan.document.staff?.inspectorId??'','quality_control'),canCorrect:isRoot};
}
async function washingReadAuthorization(db:WashingDB,actor:TrustedActorContext|null,orderId:string,plans:readonly WashingPlan[],includeFees=true){
 if(!actor)return {canReadAll:true,canReadFees:false,permissions:()=>({canLogistics:false,canInspect:false,canCorrect:false})};
 const policy=new DigitalProductionAccessPolicy(db),isRoot=await root(db,actor);
 const canOperate=plans.some(plan=>plan.document.staff?.logisticsId===actor.actorId)&&await policy.activeRole(actor.actorId,'embroidery_washing_merchandiser');
 const canCheck=plans.some(plan=>plan.document.staff?.inspectorId===actor.actorId)&&await policy.activeRole(actor.actorId,'quality_control');
 const canReadAll=await policy.allowed(actor,'order',orderId,'technical'),canReadFees=includeFees&&await policy.allowed(actor,'order',orderId,'budget');
 return {canReadAll,canReadFees,permissions:(plan:WashingPlan)=>({canLogistics:isRoot||canOperate&&plan.document.staff?.logisticsId===actor.actorId,
  canInspect:isRoot||canCheck&&plan.document.staff?.inspectorId===actor.actorId,canCorrect:isRoot})};
}
/** Same client for native quantities, adopted plan, facts and permission checks. */
export async function readBulkWashing(db:WashingDB,orderId:string,actor:TrustedActorContext|null,observationAt?:string,options:{includeFees?:boolean}={}):Promise<BulkWashingSheet>{
 const plans=await washingPlans(db,orderId);if(!plans.length)return {orderId,scopes:[]};
 return assembleWashingSheet(db,orderId,plans,await washingReadAuthorization(db,actor,orderId,plans,options.includeFees),observationAt);
}
async function assembleWashingSheet(db:WashingDB,orderId:string,plans:WashingPlan[],access:Awaited<ReturnType<typeof washingReadAuthorization>>,observationAt?:string):Promise<BulkWashingSheet>{
 if(!plans.length)return {orderId,scopes:[]};
 const events=await washingEvents(db,orderId),latest=new Map(plans.map(p=>[p.lineId,p]));
 const plansById=new Map(plans.map(plan=>[plan.id,plan])),eventsByScope=new Map<string,typeof events>();
 for(const event of events){const own=eventsByScope.get(event.scopeId);if(own)own.push(event);else eventsByScope.set(event.scopeId,[event]);}
 const receipts=await garmentQuality(db,orderId),factories=await factoryProductionScopes(db,orderId);
 const receiptLinks=(await db.query(`SELECT l.receipt_id,l.production_order_id,l.factory_decision_id FROM sourcing_production_receipt_links l
  JOIN digital_production_child_links c ON c.module='production' AND c.child_id=l.production_order_id WHERE c.production_order_id=$1`,[orderId])).rows;
 const observed=observationAt??businessNow().toISOString(),termination=await journeyTermination(db,{kind:'order',id:orderId},observed);
 const inputs=[...receipts.map(r=>({scopeId:`receipt:${r.receiptId}`,lineId:r.lineId,factoryDecisionId:null,quantityVersion:r.quantityVersion,quantity:r.quantity,
  label:`收货批次 ${r.receiptId.slice(0,8)}`,receivedAt:r.receivedAt,availableAt:r.receivedAt??(r.receivedDate?`${r.receivedDate}T00:00:00+08:00`:null),mode:'after_receipt' as const,
  allowedSend:r.inspected?r.qualifiedQuantity:0})),...factories.map(r=>({scopeId:`factory:${r.production_order_id}:${r.factory_decision_id??'original'}:${r.line_id}`,
  lineId:r.line_id as string,factoryDecisionId:r.factory_decision_id as string|null,quantity:Number(r.quantity),quantityVersion:washingHash([r.production_order_id,r.factory_decision_id,r.sourcing_decision_id,r.line_id,Number(r.quantity)]),
  label:`${r.supplier_name_snapshot} · ${r.po_number??r.color}`,receivedAt:null,availableAt:r.dispatched_at?new Date(r.dispatched_at).toISOString():null,mode:'factory' as const,allowedSend:0}))];
 const selected=[];
 for(const input of inputs){
  const own=eventsByScope.get(input.scopeId)??[];
  // Once real work exists, later arrangements cannot reset its allowance.
  const first=own.find(e=>e.kind!=='void'),current=latest.get(input.lineId),plan=first?plansById.get(first.planId):current;
  if(!plan||plan.document.arrangement.mode!==input.mode)continue;
  const permissions=access.permissions(current?.document.staff?current:plan);
  if(!access.canReadAll&&!permissions.canLogistics&&!permissions.canInspect)continue;
  selected.push({input,own,plan,permissions,feeSource:(current??plan).document.fee});
 }
 const versions=access.canReadFees?[...new Set(selected.flatMap(({feeSource})=>feeSource.kind==='budget_row'?[feeSource.version]:[]))]:[];
 const budgets=versions.length?(await db.query('SELECT version,document FROM digital_budget_versions WHERE production_order_id=$1 AND version=ANY($2::integer[])',[orderId,versions])).rows:[];
 const budgetByVersion=new Map(budgets.map(budget=>[Number(budget.version),budget.document]));
 const scopes:BulkWashingScopeView[]=[];
 for(const {input,own,plan,permissions,feeSource:source} of selected){
  const voids=new Set(own.filter(e=>e.kind==='void').map(e=>String(e.payload.factId)));
  const facts=own.filter(e=>e.kind!=='void'),effective=facts.filter(e=>!voids.has(e.id)).map(washingFact);
  const ledger=bulkWashingLedger(input,input.mode,effective);
  if(input.mode==='after_receipt')ledger.sendable=Math.max(0,Math.min(ledger.sendable,input.allowedSend-ledger.sent));
  let fee:BulkWashingScopeView['fee'];
  if(access.canReadFees){
   fee={state:'pending'};
   if(source.kind==='budget_row'){
    const row=budgetByVersion.get(source.version)?.rows.find((r:{rowId:string})=>r.rowId===source.rowId);
    if(row)fee={state:'referenced',version:source.version,rowId:source.rowId,name:row.name,unitPrice:row.unitPrice,consumption:row.consumption};
   }
  }
  const nativeFactory=input.mode==='factory'?factories.find(f=>input.scopeId===`factory:${f.production_order_id}:${f.factory_decision_id??'original'}:${f.line_id}`):null;
  const linkedReceipts=nativeFactory?receipts.filter(r=>r.lineId===input.lineId&&receiptLinks.some(l=>l.receipt_id===r.receiptId&&l.production_order_id===nativeFactory.production_order_id&&l.factory_decision_id===nativeFactory.factory_decision_id))
   .map(r=>({receiptId:r.receiptId,quantity:r.quantity,quantityVersion:r.quantityVersion})):undefined;
  scopes.push({...input,planId:plan.id,revision:own.at(-1)?.sequence??0,...permissions,ledger,...(nativeFactory?{factorySource:{productionId:nativeFactory.production_order_id,sourcingDecisionId:nativeFactory.sourcing_decision_id,position:Number(nativeFactory.position),quantity:Number(nativeFactory.quantity)}}:{}),...(linkedReceipts?{receipts:linkedReceipts}:{}),windows:bulkWashingWindows(plan.document.arrangement,own,voids,observed,termination),
   facts:facts.map(e=>({...washingFact(e),recordedAt:e.recordedAt,operator:e.operator,note:String(e.payload.note??''),voided:voids.has(e.id)})),...(fee?{fee}:{})});
 }
 return {orderId,scopes};
}
export class BulkWashingService{
 constructor(private readonly pool:Pool){}
 async read(actor:TrustedActorContext,orderId:string){
  const db=await this.pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const active=await washingOrderActive(db,orderId),plans=await washingPlans(db,orderId),access=await washingReadAuthorization(db,actor,orderId,plans);
   if(!access.canReadAll){
    const currentStaff=new Map(plans.filter(plan=>plan.document.staff).map(plan=>[plan.lineId,plan]));
    if(![...currentStaff.values()].some(plan=>{const permissions=access.permissions(plan);return permissions.canLogistics||permissions.canInspect;}))digitalForbidden();
   }
   const result=await assembleWashingSheet(db,orderId,plans,access);if(!active)for(const scope of result.scopes)scope.canLogistics=scope.canInspect=scope.canCorrect=false;
   if(result.scopes.some(scope=>(scope.ledger.rework?.available.length??0)>0||(scope.ledger.rework?.sent??0)>0)){const {OrderTimePlanRepository}=await import('./order-time-plan-repository.js');attachWashingReworkPlans(result,await new OrderTimePlanRepository(db).current({kind:'order',id:orderId}));}
   await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async record(actor:TrustedActorContext,orderId:string,value:BulkWashingCommand,key:string){
  const input=BulkWashingCommandSchema.parse(value);if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))washingConflict('缺少有效操作标识');
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   if(!await washingOrderActive(db,orderId))washingConflict('订单已暂停、取消或结案，洗水历史保留');
   const plans=await washingPlans(db,orderId),plan=plans.find(p=>p.id===input.planId);if(!plan)washingConflict('洗水安排不属于本单');
   const assignment=plans.filter(p=>p.lineId===plan!.lineId&&p.document.staff).at(-1)??plan!;
   const caps=await capabilities(db,actor,assignment,true);
   if(input.kind==='void'?!caps.canCorrect:input.kind==='inspection'?!caps.canInspect:!caps.canLogistics)digitalForbidden();
   const command=`bulk-washing:${orderId}`,hash=washingHash(input),prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)washingConflict('操作标识已用于不同内容');await db.query('COMMIT');return prior.response;}
   const state=await readBulkWashing(db,orderId,actor),scope=state.scopes.find(s=>s.scopeId===input.scopeId);
   if(!scope||scope.planId!==input.planId||scope.quantityVersion!==input.quantityVersion||scope.revision!==input.expectedRevision)washingConflict('洗水范围、数量或安排已变化，请刷新核对');
   const own=scope!,events=await washingEvents(db,orderId),id=randomUUID();
   if((input.kind==='send'||input.kind==='factory_start')&&(input.reworkOfInspectionId||input.rewashWorkId)){const {OrderTimePlanRepository}=await import('./order-time-plan-repository.js');assertWashingReworkBinding(await new OrderTimePlanRepository(db).current({kind:'order',id:orderId}),own,input);}
   if(input.occurredAt&&Date.parse(input.occurredAt)>businessNow().getTime())washingConflict('实际发生时间不能晚于当前时间');
   if(input.kind!=='void'&&input.occurredAt&&own.availableAt&&Date.parse(input.occurredAt)<Date.parse(own.availableAt))washingConflict('实际发生时间早于本批可办理范围');
   if(input.kind==='inspection'&&input.qualifiedQuantity<input.quantity&&!input.note.trim())washingConflict('洗后不合格须说明质量问题');
   if((input.kind==='send'||input.kind==='factory_start')&&input.reworkOfInspectionId){
    const available=own.ledger.rework?.available.find(item=>item.inspectionId===input.reworkOfInspectionId);
    if(!available||input.quantity>available.quantity)washingConflict('请选择本批真实不合格检查，返洗不得超过尚未投入的失败余量');
   }else if(input.kind==='send'&&input.quantity>own.ledger.sendable)washingConflict('送洗数量超过本批有效到仓合格余量');
   const voided=new Set(events.filter(e=>e.scopeId===input.scopeId&&e.kind==='void').map(e=>String(e.payload.factId)));
   if(input.kind==='receipt_link'){
    const receipt=own.receipts?.find(r=>r.receiptId===input.receiptId&&r.quantityVersion===input.receiptQuantityVersion);
    const live=events.filter(e=>e.scopeId===input.scopeId&&!voided.has(e.id));
    const completion=live.find(e=>e.id===input.completionId&&e.kind==='factory_complete');
    const check=live.find(e=>e.kind==='inspection'&&e.payload.completionId===input.completionId&&e.payload.quantity===completion?.payload.quantity);
    const linked=live.filter(e=>e.kind==='receipt_link');
    if(own.mode!=='factory'||!receipt||!completion||!check||completion.quantityVersion!==own.quantityVersion)washingConflict('请选择本厂本PO有效收货和已检查的洗水批次');
    const fromCompletion=linked.filter(e=>e.payload.completionId===input.completionId).reduce((sum,e)=>sum+Number(e.payload.quantity),0);
    const toReceipt=linked.filter(e=>e.payload.receiptId===input.receiptId).reduce((sum,e)=>sum+Number(e.payload.quantity),0);
    if(fromCompletion+input.quantity>Number(check!.payload.qualifiedQuantity)||toReceipt+input.quantity>receipt!.quantity)washingConflict('关联数量超过洗水合格或原实收范围');
   }
   if(input.kind==='void'){
    const target=events.find(e=>e.scopeId===input.scopeId&&e.id===input.factId&&e.kind!=='void');if(!target||voided.has(input.factId))washingConflict('该记录不存在或已撤销');
   }else{
    const facts=events.filter(e=>e.scopeId===input.scopeId&&e.kind!=='void'&&!voided.has(e.id)).map(washingFact);
    const next=bulkWashingLedger(own,own.mode,[...facts,{...input,id}]);
    if(next.conflict)washingConflict(next.reasons.join('；'));
   }
   await db.query(`INSERT INTO digital_bulk_washing_events(event_id,production_order_id,plan_id,scope_id,quantity_version,sequence,kind,payload,occurred_at,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,orderId,input.planId,input.scopeId,input.quantityVersion,own.revision+1,input.kind,JSON.stringify(input),input.occurredAt,actor.actorId]);
   await refreshBulkWashingCoverage(db,orderId,await readBulkWashing(db,orderId,null));
   const response={eventId:id,scopeId:input.scopeId,revision:own.revision+1};
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(response)]);
   await db.query('COMMIT');return response;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
}
