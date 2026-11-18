import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import type {reworkSlaEvidence} from './rework-sla-evidence.js';
import type {NativeCuttingReadiness} from './task-readiness-facts.js';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import {journeyCompletion} from './journey-projection.js';

/** A logical all-PO join has no invented duration or task-entry timestamp. Its
 * completion is the latest first-ready fact of the exact current cut scopes. */
export function journeyCuttingGateTime(taskId:string,lines:readonly {lineId:string;cuttingOrderId?:string|null}[],facts:readonly NativeCuttingReadiness[],asOf:string):string|null{
 if(!lines.length)return null;
 const times=lines.map(line=>{
  const own=facts.filter(fact=>fact.taskId===taskId&&fact.lineId===line.lineId&&line.cuttingOrderId&&fact.cuttingOrderId===line.cuttingOrderId);
  return own.length===1&&instant(own[0]!.firstReadyAt,asOf)?own[0]!.firstReadyAt:null;
 });
 return times.every((at):at is string=>at!==null)?new Date(Math.max(...times.map(at=>Date.parse(at)))).toISOString():null;
}

type Native = {orderId:string;rework:Awaited<ReturnType<typeof reworkSlaEvidence>>['windows'];receiving:OrderClosureSheet['receivingSpan']};
const instant=(value:string|null|undefined,asOf:string):value is string=>Boolean(value&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=Date.parse(asOf));

/** Called only after the original whole-order timing authorization. Keep exact
 * original rework+PO scope; packing registration is intentionally not adapted.
 */
export function attachJourneyNativeTimes(item:OrderJourney,native:Native,asOf:string){
 if(item.orderId!==native.orderId)return;
 for(const node of item.stages.flatMap(stage=>stage.nodes)){
  if(!node.current)continue;
  if(node.key==='receipts'&&['active','completed'].includes(node.state)&&(!node.enteredAt||node.occurrence===null&&node.instanceId===`receipts:${node.round??0}`)){
   const delivery=native.receiving?.firstDelivery;
   const first=delivery?delivery.occurred.precision==='instant'?delivery.occurred.at:null:native.receiving?.firstEffectiveReceipt?.receivedAt;
   node.enteredAt=instant(first,asOf)?first:null;
  }
  if(node.key!=='rework'||!['active','completed'].includes(node.state))continue;
  // The native rework order is bound to one original receiving/PO line.
  // Neither another PO nor a partial/duplicate set can provide this window.
  const scopes=new Set(node.records.flatMap(record=>record.domain==='rework'&&record.id===node.instanceId&&record.lineId?[record.lineId]:[]));
  const windows=native.rework.filter(window=>window.reworkId===node.instanceId&&scopes.has(window.lineId));
  node.actualAt=null;node.actualDate=null;node.actualQuality='missing';node.completionResult=node.state==='completed'?'unknown':null;node.overdueSeconds=null;
  delete node.nativeWindows;
  const window=scopes.size===1&&windows.length===1?windows[0]:undefined;
  if(!window?.assignmentId||window.windowKey!==`rework:${node.instanceId}:${window.assignmentId}`||!instant(window.startedAt,asOf)){
   node.enteredAt=null;node.sla='not_started';continue;
  }
  node.enteredAt=window.startedAt;
  // Worker completion and the later quantity/finance workflow have different
  // owners. Preserve the business state while projecting this exact work A.
  const complete=window.complete&&instant(window.completedAt,asOf)&&Date.parse(window.completedAt)>=Date.parse(window.startedAt);
  node.actualAt=complete?window.completedAt:null;
  node.actualQuality=complete?'verified':'missing';node.sla=complete?'finished':'running';
  const deadline=window.snapshotId&&window.deadline&&Number.isFinite(Date.parse(window.deadline))&&Date.parse(window.deadline)>=Date.parse(window.startedAt)?window.deadline:null;
  const line=item.lines?.find(row=>row.id===window.lineId);
  node.nativeWindows=[{evidence:window.evidence,scopeLabel:line?`PO ${line.po??'号码尚未取得'} · ${line.color}`:'原返工范围',startedAt:node.enteredAt,deadline,warningAt:deadline?window.warningAt:null,
   completedAt:node.actualAt,complete,snapshotId:window.snapshotId}];
  if(complete){const result=journeyCompletion(deadline,node.actualAt,true);node.completionResult=result.result;node.overdueSeconds=result.overdueSeconds;}
 }
}

/** Packing's physical completion has its own scope. Its cumulative save time
 * and order-level difference closure are never substitutes for physical A. */
export function attachJourneyPackingTime(item:OrderJourney,sheet:OrderClosureSheet,facts:Record<string,SlaNodeFact>,asOf:string){
 for(const node of item.stages.flatMap(stage=>stage.nodes))attachJourneyPackingNodeTime(node,item.orderId,sheet,facts,asOf);
}
export function attachJourneyPackingNodeTime(node:JourneyNode,orderId:string|null,sheet:OrderClosureSheet,facts:Record<string,SlaNodeFact>,asOf:string){
 if(orderId!==sheet.orderId||node.key!=='packing'||!node.current||['unavailable','not_applicable'].includes(node.state))return;
 const lineIds=new Set(node.records.flatMap(record=>record.lineId?[record.lineId]:[]));
 const lines=sheet.lines.filter(line=>!lineIds.size||lineIds.has(line.lineId));
 const own=lines.map(line=>facts[`garment_packing:${line.lineId}`]);
 const day=(at:string)=>new Date(Date.parse(at)+8*3600000).toISOString().slice(0,10);
 const actuals=own.map(fact=>{
  if(!fact?.businessCompleted)return null;
  if(fact.completedAt)return instant(fact.completedAt,asOf)&&(!fact.startedAt||Date.parse(fact.completedAt)>=Date.parse(fact.startedAt))?{precision:'instant' as const,at:fact.completedAt}:null;
  const date=fact.completedDate,midnight=date?Date.parse(date+'T00:00:00+08:00'):NaN;
  if(date&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(midnight)&&day(new Date(midnight).toISOString())===date&&date<=day(asOf)&&(!fact.startedAt||midnight+86400000>Date.parse(fact.startedAt)))return {precision:'date' as const,at:date};
  return null;
 });
 const complete=lines.length>0&&actuals.every(actual=>actual!==null),exact=complete&&actuals.every(actual=>actual?.precision==='instant');
 node.completesOrder=sheet.stage==='本期装箱完成'&&!lineIds.size;
 node.actualAt=exact?new Date(Math.max(...actuals.map(actual=>Date.parse(actual!.at)))).toISOString():null;
 node.actualDate=complete&&!exact?actuals.map(actual=>actual!.precision==='date'?actual!.at:day(actual!.at)).sort().at(-1)!:null;node.actualQuality=complete?'unverified':'missing';
 if(complete){node.state='completed';node.sla='finished';node.completionResult='unknown';node.overdueSeconds=null;}
 else if(node.state==='completed'&&!node.completesOrder){node.state='active';node.sla='not_started';node.completionResult=null;node.overdueSeconds=null;}
}
