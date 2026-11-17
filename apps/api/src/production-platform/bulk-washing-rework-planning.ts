import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import type {BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import type {WashingPlan} from './bulk-washing-repository.js';
import type {OrderTimeWork} from './order-time-schedule.js';

/** A genuine failed inspection is a planning input, not evidence that every
 * failed piece will be rewashed. The original manager still selects a scope.
 */
export type WashingReworkCandidate={
 orderId:string;lineId:string;scopeId:string;factoryDecisionId:string|null;quantityVersion:string;
 inspectionId:string;inspectionAt:string|null;availableQuantity:number;round:number;plan:WashingPlan;
};

/** Consume the original authorized native read, including its effective ledger.
 * No new stock/quality projection or alternative availability rule is introduced.
 */
export function washingReworkCandidates(orderId:string,scope:BulkWashingScopeView,plan:WashingPlan):WashingReworkCandidate[]{
 if(scope.ledger.conflict)throw Error(scope.ledger.reasons.join('；'));
 if(plan.id!==scope.planId||plan.orderId!==orderId||plan.lineId!==scope.lineId
  ||plan.document.arrangement.mode!==scope.mode)throw Error('返洗候选与原订单、PO或采用版本不一致');
 return (scope.ledger.rework?.available??[]).map(available=>{
  const originals=scope.facts.filter(fact=>fact.id===available.inspectionId&&!fact.voided);
  const original=originals[0];
  if(originals.length!==1||original?.kind!=='inspection'||original.scopeId!==scope.scopeId
   ||original.quantityVersion!==scope.quantityVersion||!Number.isSafeInteger(available.quantity)||available.quantity<=0
   ||available.quantity>original.quantity-original.qualifiedQuantity||!Number.isSafeInteger(available.round)||available.round<1)
   throw Error('返洗候选缺少本批有效不合格检查或剩余范围');
  return {orderId,lineId:scope.lineId,scopeId:scope.scopeId,factoryDecisionId:scope.factoryDecisionId,
   quantityVersion:scope.quantityVersion,inspectionId:original.id,inspectionAt:original.occurredAt,
   availableQuantity:available.quantity,round:available.round,plan:structuredClone(plan)};
 });
}

/** Prepare explicit work BEFORE a logistics start exists. intentId is the stable
 * new business identity, not an arrangement revision or a future event timestamp.
 * The original arrange/confirm path must validate reservation, replay and scope,
 * supply its real business observation to fixedTimelineForward, then freeze.
 * This pure adapter neither approves nor persists an arrangement.
 */
export function washingReworkPlanningInput(candidate:WashingReworkCandidate,intentId:string,quantity:number){
 DigitalIdSchema.parse(intentId);
 if(!Number.isSafeInteger(quantity)||quantity<=0||quantity>candidate.availableQuantity)
  throw Error('返洗计划数量超过本批尚可安排范围');
 const arrangement=candidate.plan.document.arrangement;
 if(arrangement.mode==='none')throw Error('返洗计划缺少原适用洗水采用');
 const prefix=arrangement.mode==='factory'?'bulk_factory_washing':'bulk_return_washing';
 const reference=`order:${candidate.orderId}:line:${candidate.lineId}:rewash:${intentId}`;
 const id=`${prefix}:rewash:${intentId}:${candidate.lineId}`,inspectionId=`${prefix}_inspection:rewash:${intentId}:${candidate.lineId}`;
 const node=(nodeId:string,parameterKey:string,kind:'washing'|'inspection',dependsOn:string[]):OrderTimeWork=>({
  id:nodeId,parameterKey,stage:arrangement.mode==='factory'?6:7,dependsOn,
  canonicalWorkRef:`${reference}:${kind}`,nativeDuration:{reference:`bulk-washing-plan:${candidate.plan.id}:${kind}`,
   minutes:arrangement[kind].minutes,calendar:arrangement[kind].calendar},
 });
 // The failed inspection is a precise external prerequisite. It is not the
 // aggregate PO inspection that may itself still await this rewash's quality.
 const prerequisite:SlaAnchor=candidate.inspectionAt
  ?{precision:'instant',value:candidate.inspectionAt,source:`digital_bulk_washing_events:${candidate.inspectionId}`}
  :{precision:'unknown',reason:'本批原不合格检查的真实发生时间待核'};
 return {intentId,quantity,source:structuredClone(candidate),
  work:[node(id,prefix,'washing',[]),node(inspectionId,prefix+'_inspection','inspection',[id])],
  notBefore:{[id]:prerequisite},requiredForDelivery:inspectionId};
}
