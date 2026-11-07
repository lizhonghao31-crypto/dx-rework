import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import type {reworkSlaEvidence} from './rework-sla-evidence.js';

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
   const first=native.receiving?.firstEffectiveReceipt?.receivedAt;
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
