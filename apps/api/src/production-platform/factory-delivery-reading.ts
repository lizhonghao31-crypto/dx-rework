import type {FactoryDeliveryReading} from '@dx-rework/contracts/order-closure';
import {firstEffectiveReceipt,type EffectiveReceiptTime} from './first-effective-receipt.js';

export type FactoryDeliveryScope={productionId:string;factoryDecisionId:string|null;lineId:string;expected:number;targetDate:string|null;commitments:Array<{at:string|null;date:string;reference:string;version:number}>};
export type FactoryDeliveryReceipt=EffectiveReceiptTime&{productionId:string|null;factoryDecisionId:string|null;lineId:string;quantity:number};

/** Caller supplies original allocations and the authorized effective receipt
 * ledger. First delivery never closes the complete-return or packing nodes. */
export function factoryDeliveryReadings(scopes:readonly FactoryDeliveryScope[],receipts:readonly FactoryDeliveryReceipt[],asOf:string):FactoryDeliveryReading[]{
 return scopes.map(scope=>{
  const own=[...new Map(receipts.filter(row=>row.lineId===scope.lineId&&row.productionId===scope.productionId&&row.factoryDecisionId===scope.factoryDecisionId&&row.quantity>0).map(row=>[row.id,row])).values()];
  const uncertain=receipts.filter(row=>row.lineId===scope.lineId&&row.productionId===null&&row.quantity>0);
  const first=firstEffectiveReceipt(own),received=own.reduce((sum,row)=>sum+row.quantity,0);
  if(uncertain.length){first.occurred={precision:'unknown'};first.reason='有效实收的工厂归属待核，不能确定本范围首收';}
  const at=first.occurred.precision==='instant'?Date.parse(first.occurred.at):first.occurred.precision==='date'?Date.parse(first.occurred.date+'T00:00:00+08:00'):null;
  const end=at===null?null:first.occurred.precision==='date'?at+86400000-1:at;
  const history=[...scope.commitments].sort((a,b)=>b.version-a.version),prior=at===null?null:history.find(row=>row.at&&Date.parse(row.at)<=at);
  const ambiguous=first.delivered&&(history.some(row=>!row.at)||history.some(row=>row.at&&at!==null&&end!==null&&Date.parse(row.at)>at&&Date.parse(row.at)<=end));
  const assessmentTargetDate=first.delivered?ambiguous?null:prior?.date??null:scope.targetDate;
  const deadline=assessmentTargetDate?Date.parse(assessmentTargetDate+'T00:00:00+08:00')+86400000:null;
  const status=uncertain.length||deadline===null?'unknown':first.delivered?at===null?'unknown':at>=deadline?'late':'on_time':Date.parse(asOf)>=deadline?'late':'pending';
  return {productionId:scope.productionId,factoryDecisionId:scope.factoryDecisionId,lineId:scope.lineId,expected:scope.expected,targetDate:scope.targetDate,assessmentTargetDate,assessmentTargetRef:first.delivered?prior?.reference??null:null,
   delivered:first.delivered?true:uncertain.length?null:false,firstReceipt:first.occurred,firstReceiptIds:first.candidateIds,received,remaining:uncertain.length?null:Math.max(0,scope.expected-received),collected:uncertain.length?null:scope.expected>0&&received>=scope.expected,status,reason:first.reason??(first.delivered&&!assessmentTargetDate?'首次交付时的工厂承诺版本待核':null)};
 });
}
