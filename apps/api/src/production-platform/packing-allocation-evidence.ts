import type {ClosureLine,ReceiptQualityFact} from '@dx-rework/contracts/order-closure';
import type {SlaBatchWindow,SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';

/** Explicit current cumulative allocation, not a heuristic distribution. Raw
 * older revisions remain history; changed receipt versions invalidate coverage. */
export function packingAllocationEvidence(line:ClosureLine,checks:readonly ReceiptQualityFact[],businessCompleted:boolean):SlaNodeFact|null{
 if(!line.packingAllocations)return null;
 const allocations=line.packingAllocations,reference=`packing:${line.packingRevisionId}:receipt-allocation`;
 const valid=new Set(allocations.map(row=>row.receiptId)).size===allocations.length&&allocations.reduce((sum,row)=>sum+row.quantity,0)===line.packingQuantity
  &&allocations.every(allocation=>checks.some(q=>q.receiptId===allocation.receiptId&&q.quantityVersion===allocation.quantityVersion&&allocation.quantity>0&&allocation.quantity<=q.quantity));
 if(!valid)return {businessCompleted,evidence:reference+':scope-stale',batchCoverageComplete:false,batchWindows:[{startedAt:null,deadline:null,warningAt:null,completedAt:null,complete:false,evidence:reference+':scope-stale'}]};
 const parts=line.actualQuantity>line.orderedQuantity?checks.filter(q=>allocations.some(a=>a.receiptId===q.receiptId)):checks;
 const windows:SlaBatchWindow[]=parts.map(q=>{
  const allocation=allocations.find(a=>a.receiptId===q.receiptId),proof=line.packingReadiness?.receipts.find(row=>row.receiptId===q.receiptId&&row.quantityVersion===q.quantityVersion)?.readiness;
  const startedAt=proof?.state==='ready'&&proof.ready.precision==='instant'?proof.ready.at:null;
  const complete=Boolean(allocation&&(line.actualQuantity>line.orderedQuantity||allocation.quantity===q.quantity));
  const end=complete&&allocation?.actualTime.precision==='instant'&&(!startedAt||Date.parse(allocation.actualTime.at)>=Date.parse(startedAt))?allocation.actualTime.at:null;
  return {startedAt,completedAt:end,complete,deadline:startedAt&&q.packingMinutes!=null?new Date(Date.parse(startedAt)+q.packingMinutes*60000).toISOString():null,
   warningAt:startedAt&&q.packingMinutes!=null&&q.warningPercent!=null?new Date(Date.parse(startedAt)+q.packingMinutes*60000*q.warningPercent/100).toISOString():null,
   evidence:`${reference}:${q.receiptId}:quantity:${q.quantityVersion}:${proof?.evidenceRefs.join(',')??'readiness-unknown'}`,policyAtStart:true};
 });
 const covered=checks.reduce((sum,q)=>sum+q.quantity,0)===line.actualQuantity&&line.actualQuantity>=line.orderedQuantity;
 if(!covered)windows.push({startedAt:null,completedAt:null,deadline:null,warningAt:null,complete:false,evidence:reference+':remaining-scope-unknown',policyAtStart:true});
 const selected=allocations.filter(a=>checks.some(q=>q.receiptId===a.receiptId)),allDates=selected.length>0&&selected.every(a=>a.actualTime.precision==='date'||a.actualTime.precision==='instant');
 const date=allDates?selected.map(a=>a.actualTime.precision==='date'?a.actualTime.date:a.actualTime.precision==='instant'?beijingCalendarDate(new Date(a.actualTime.at)):'').sort().at(-1):undefined;
 const ended=businessCompleted&&windows.length>0&&windows.every(w=>w.complete&&w.completedAt);
 return {businessCompleted,evidence:reference,batchWindows:windows,batchCoverageComplete:covered,
  ...(windows.length&&windows.every(w=>w.startedAt)?{startedAt:windows.map(w=>w.startedAt!).sort()[0]}:{}),
  ...(ended?{completedAt:windows.map(w=>w.completedAt!).sort().at(-1)!}:businessCompleted&&date&&selected.some(a=>a.actualTime.precision==='date')?{completedDate:date}:{})};
}
