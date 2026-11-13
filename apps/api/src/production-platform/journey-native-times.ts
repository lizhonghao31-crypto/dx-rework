import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import type {reworkSlaEvidence} from './rework-sla-evidence.js';
import type {NativeCuttingReadiness} from './task-readiness-facts.js';

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
  const scopes=node.records.filter(record=>record.domain==='rework'&&record.id===node.instanceId&&record.lineId);
  const windows=native.rework.filter(window=>window.reworkId===node.instanceId&&scopes.some(record=>record.lineId===window.lineId));
  node.actualAt=null;node.actualDate=null;node.actualQuality='missing';node.completionResult=node.state==='completed'?'unknown':null;node.overdueSeconds=null;
  if(!windows.length){node.enteredAt=null;continue;}
  node.enteredAt=windows.every(window=>instant(window.startedAt,asOf))?new Date(Math.min(...windows.map(window=>Date.parse(window.startedAt!)))).toISOString():null;
  if(node.state==='completed'){
   const complete=windows.every(window=>window.complete&&instant(window.completedAt,asOf)&&(!window.startedAt||Date.parse(window.completedAt)>=Date.parse(window.startedAt)));
   node.actualAt=complete?new Date(Math.max(...windows.map(window=>Date.parse(window.completedAt!)))).toISOString():null;
   node.actualDate=null;node.actualQuality=complete?'unverified':'missing';node.completionResult='unknown';node.overdueSeconds=null;
  }
 }
}
