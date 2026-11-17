import type {BulkWashingArrangement,BulkWashingScope} from '@dx-rework/contracts/bulk-washing';
import {bulkWashingLedger} from './bulk-washing-ledger.js';
import {washingFact,type WashingEvent,type WashingPlan} from './bulk-washing-repository.js';

type ApplicableArrangement=Exclude<BulkWashingArrangement,{mode:'none'}>;
export type NativeWashingReworkSource={
 orderId:string;lineId:string;factoryDecisionId:string|null;scopeId:string;quantityVersion:string;
 startEventId:string;originalInspectionId:string;planId:string;round:number;quantity:number;
 /** Original adopted policy, not a new approved planning duration or allowance. */
 adoptedArrangement:ApplicableArrangement;
 /** Native evidence references only; formal work/canonical identity still
  * needs the authorized introduction-to-arrangement binding. */
 references:{washing:string;inspection:string};
};

/** Identity/fact preparation only. This does not create a plan, approve work,
 * calculate P/R/D/A, alter a denominator or authorize an operator. The original
 * ledger owns quantity/ancestry validation. Callers must retain old plan/history
 * references separately when an original event is later voided.
 */
export function nativeWashingReworkSources(orderId:string,scope:BulkWashingScope,
 plans:readonly WashingPlan[],events:readonly WashingEvent[]):NativeWashingReworkSource[]{
 const own=events.filter(event=>event.scopeId===scope.scopeId).sort((left,right)=>left.sequence-right.sequence);
 const voided=new Set(own.filter(event=>event.kind==='void').map(event=>String(event.payload.factId)));
 const effective=own.filter(event=>event.kind!=='void'&&!voided.has(event.id));
 const byId=new Map(effective.map(event=>[event.id,event]));
 const starts=effective.filter(event=>(event.kind==='send'||event.kind==='factory_start')&&event.payload.reworkOfInspectionId);
 if(!starts.length)return [];
 // The start event itself names the adopted version. A later fee/arrangement
 // version cannot replace it or become part of the same work's identity.
 const planFor=(event:WashingEvent)=>{
  const matches=plans.filter(plan=>plan.id===event.planId);
  if(matches.length!==1||matches[0]!.orderId!==orderId||matches[0]!.lineId!==scope.lineId)
   throw Error('返洗原采用记录与订单或PO不一致');
  const plan=matches[0]!;
  if(plan.document.arrangement.mode==='none')throw Error('返洗原采用记录缺少适用洗水路线');
  return plan;
 };
 const first=effective[0];
 if(!first)throw Error('返洗缺少有效原事实');
 const firstPlan=planFor(first),mode=firstPlan.document.arrangement.mode;
 if(mode==='factory'){
  const parts=scope.scopeId.split(':');
  if(parts.length!==4||parts[0]!=='factory'||!parts[1]||parts[2]!== (scope.factoryDecisionId??'original')||parts[3]!==scope.lineId)
   throw Error('返洗工厂身份与原批范围不一致');
 }else if(!/^receipt:[^:]+$/.test(scope.scopeId)||scope.factoryDecisionId!==null)
  throw Error('返洗收货身份与原批范围不一致');
 // The current native reader freezes one plan for this actual scope. Do not
 // silently interpret a differently adopted row using its current policy.
 for(const event of effective)if(planFor(event).id!==firstPlan.id)
  throw Error('返洗采用记录与本批已冻结范围不一致');
 const ledger=bulkWashingLedger(scope,mode,effective.map(washingFact));
 if(ledger.conflict)throw Error(ledger.reasons.join('；'));
 return starts.map(start=>{
  const plan=planFor(start),arrangement=plan.document.arrangement;
  if(arrangement.mode==='none'||arrangement.mode!==mode)throw Error('返洗原采用路线与本批事实不一致');
  const origin=byId.get(String(start.payload.reworkOfInspectionId)),round=ledger.rework.rounds[start.id];
  if(origin?.kind!=='inspection'||typeof round!=='number'||!Number.isSafeInteger(round)||round<1)
   throw Error('返洗缺少本范围有效原不合格检查');
  planFor(origin);
  const reference=`order:${orderId}:line:${scope.lineId}:rewash:${start.id}`;
  return {orderId,lineId:scope.lineId,factoryDecisionId:scope.factoryDecisionId,scopeId:scope.scopeId,
   quantityVersion:scope.quantityVersion,startEventId:start.id,originalInspectionId:origin.id,
   planId:plan.id,round,quantity:Number(start.payload.quantity),adoptedArrangement:structuredClone(arrangement),
   references:{washing:`${reference}:washing`,inspection:`${reference}:inspection`}};
 });
}
