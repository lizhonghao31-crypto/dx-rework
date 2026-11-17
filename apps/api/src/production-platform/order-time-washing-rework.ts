import {OrderTimeWashingReworkChangesSchema,OrderTimeWashingReworkPlanSchema,
 type OrderTimeWashingReworkChanges,type OrderTimeWashingReworkPlan} from '@dx-rework/contracts/order-time-washing-rework';
import type {PoolClient} from 'pg';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import type {FrozenTimeFramework,TimeFrameworkInput} from '@dx-rework/contracts/order-time-framework';
import type {OrderTimeNativeProgress} from './order-time-request-plan.js';
import type {OrderTimeInput,StoredOrderTimePlan} from './order-time-plan-repository.js';
import {readBulkWashing} from './bulk-washing-service.js';
import {washingPlans} from './bulk-washing-repository.js';
import {washingReworkCandidates,washingReworkPlanningInput} from './bulk-washing-rework-planning.js';
import {retainedFrameworkWork} from './order-time-framework-route.js';
import {ApplicationError} from '../platform/errors.js';

const conflict=(message:string):never=>{throw new ApplicationError('ORDER_TIME_STALE',message,409);};
export function preparedStoredRewash(row:OrderTimeWashingReworkPlan){
 return washingReworkPlanningInput({orderId:row.orderId,lineId:row.lineId,scopeId:row.scopeId,factoryDecisionId:row.factoryDecisionId,
  quantityVersion:row.quantityVersion,inspectionId:row.inspectionId,inspectionAt:row.inspectionAt,availableQuantity:row.quantity,round:row.round,
  plan:{id:row.planId,orderId:row.orderId,lineId:row.lineId,version:row.arrangement.mode==='none'?1:row.arrangement.revision,
   document:{arrangement:row.arrangement,fee:{kind:'pending'},sourceRef:row.introducedEventRef??'待原本单安排生效'}}},row.intentId,row.quantity);
}

/** Read original availability, then introduce only the explicit manager intent.
 * A failed check alone never creates work or a historical plan. */
export async function orderTimeWashingReworkState(db:PoolClient,orderId:string,previous:StoredOrderTimePlan|null,changes:OrderTimeWashingReworkChanges){
 const proposed=OrderTimeWashingReworkChangesSchema.parse(changes),sheet=await readBulkWashing(db,orderId,null),plans=await washingPlans(db,orderId);
 const existing=structuredClone(previous?.input.rewashing??[]),byId=new Map(existing.map(row=>[row.intentId,row]));
 const candidates=sheet.scopes.flatMap(scope=>{
  const plan=plans.find(row=>row.id===scope.planId);if(!plan||scope.ledger.conflict)return [];
  return washingReworkCandidates(orderId,scope,plan).map(candidate=>{
   const reserved=existing.filter(row=>row.scopeId===scope.scopeId&&row.quantityVersion===scope.quantityVersion&&row.inspectionId===candidate.inspectionId).reduce((sum,row)=>{
    const used=scope.facts.filter(fact=>!fact.voided&&(fact.kind==='send'||fact.kind==='factory_start')&&fact.rewashWorkId===row.intentId).reduce((n,fact)=>n+fact.quantity,0);
    return sum+Math.max(0,row.quantity-used);
   },0);
   return {...candidate,label:scope.label,availableQuantity:Math.max(0,candidate.availableQuantity-reserved)};
  }).filter(candidate=>candidate.availableQuantity>0);
 });
 const used=new Map<string,number>();
 const added=proposed.map(intent=>{
  if(byId.has(intent.intentId))conflict('该返洗工作已经正式安排，不能作为新增工作重复提交');
  const candidate=candidates.find(row=>row.lineId===intent.lineId&&row.scopeId===intent.scopeId&&row.quantityVersion===intent.quantityVersion&&row.inspectionId===intent.inspectionId);
  if(!candidate)conflict('返洗候选范围或不合格余量已变化，请重新核对');
  const key=intent.scopeId+'|'+intent.inspectionId,total=(used.get(key)??0)+intent.quantity;used.set(key,total);
  if(total>candidate!.availableQuantity)conflict('返洗计划数量超过本批尚可安排的不合格余量');
  return OrderTimeWashingReworkPlanSchema.parse({...intent,orderId,factoryDecisionId:candidate!.factoryDecisionId,planId:candidate!.plan.id,round:candidate!.round,
   inspectionAt:candidate!.inspectionAt,arrangement:structuredClone(candidate!.plan.document.arrangement),introducedAt:null,introducedEventRef:null});
 });
 return {rows:[...existing,...added],added:added.length,candidates,sourceVersion:{plans:plans.map(row=>[row.id,row.version]),
  scopes:sheet.scopes.map(scope=>({id:scope.scopeId,version:scope.quantityVersion,revision:scope.revision,
   facts:scope.facts.map(fact=>[fact.id,fact.kind,fact.occurredAt,fact.voided]),available:scope.ledger.rework?.available??[]})),proposed}};
}

/** Extend the selected PO's remaining delivery, preserving old work and quantity.
 * No new inclusion deduction is made from the first factory production budget. */
export function attachWashingReworkInput(value:OrderTimeInput,rows:readonly OrderTimeWashingReworkPlan[]){
 const bounds:Record<string,SlaAnchor>={};
 for(const row of rows){
  const prepared=preparedStoredRewash(row),scope=value.scopes.find(scope=>scope.lineId===row.lineId);
  if(!scope)conflict('返洗计划PO不属于本单交付范围');
  for(const work of prepared.work){if(value.work.some(old=>old.id===work.id))conflict('返洗工作身份重复');value.work.push(work);}
  scope!.terminalIds=[...scope!.terminalIds,prepared.requiredForDelivery];scope!.customerGoalIds=[...scope!.customerGoalIds,prepared.requiredForDelivery];
  scope!.goals={...scope!.goals,[prepared.requiredForDelivery]:scope!.customerGoal};Object.assign(bounds,prepared.notBefore);
 }
 if(rows.length){value.version='order-time-input-rewash-v1';value.rewashing=structuredClone([...rows]);}
 return bounds;
}

/** A new-work-only arrangement retains every prior P. Introduced rewash P also
 * remains frozen during later arrangements; no A-to-zero-duration fallback. */
export function retainedWashingReworkTargets(input:TimeFrameworkInput,progress:ReadonlyMap<string,OrderTimeNativeProgress>,previous:FrozenTimeFramework|undefined,asOf:string,newWorkOnly:boolean,rewashing:readonly OrderTimeWashingReworkPlan[]=[]){
 const kept={...retainedFrameworkWork(input,progress,previous,asOf)};if(!previous)return kept;
 const ids=new Set(rewashing.filter(row=>row.introducedAt).flatMap(row=>preparedStoredRewash(row).work.map(work=>work.id)));
 for(const target of previous.arranged)if(input.work.some(work=>work.id===target.id)&&(newWorkOnly||ids.has(target.id)))
  kept[target.id]={...kept[target.id],target:structuredClone(target),sourceRef:previous.reference};
 return kept;
}
