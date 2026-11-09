import type {AdoptedCraftStep} from '@dx-rework/contracts/digital-craft';
import {factoryBatchLedger,scopes,type BatchFact,type BatchCheck,type FactoryScope} from './factory-batch-ledger.js';

type Step=Pick<AdoptedCraftStep,'stepId'|'craftKind'|'sequence'>;
/** Original immutable movements stay the quantity source. A second craft is
 * another operation on the same pieces, never another supply of cut pieces.
 */
export function factoryStepLedger(lines:FactoryScope[],facts:BatchFact[],checks:BatchCheck[],steps:readonly Step[]){
 if(!steps.length||steps.length>2||new Set(steps.map(step=>step.stepId)).size!==steps.length
  ||new Set(steps.map(step=>step.craftKind)).size!==steps.length||steps.some((step,index)=>step.sequence!==index+1))throw Error('独立工艺路线身份或先后顺序无效');
 const result=steps.map((step,index)=>{
  const own=facts.filter(fact=>fact.payload.stepRef===step.stepId);
  const ownReturnIds=new Set(own.filter(fact=>fact.kind==='工艺回仓').map(fact=>fact.fact_id));
  // A genuine next-step handoff consumes the previous return's available
  // pieces exactly as the original batch ledger consumes a re-send.
  const next=steps[index+1],transfers=next?facts.filter(fact=>fact.kind==='工艺发出'&&fact.payload.stepRef===next.stepId&&typeof fact.payload.fromReturnId==='string'&&ownReturnIds.has(fact.payload.fromReturnId)):[];
  const ledger=factoryBatchLedger(lines,[...own,...transfers],checks.filter(check=>ownReturnIds.has(check.return_fact_id)),false);
  const batches=ledger.batches.map(batch=>({...batch,stepRef:step.stepId}));
  const completion=lines.map(line=>{
   const qualified=batches.reduce((sum,batch)=>{
    const row=batch.rows.find(row=>row.lineId===line.lineId);if(!row?.allowDispatch)return sum;
    const handedOn=transfers.filter(fact=>fact.payload.fromReturnId===batch.factId).reduce((n,fact)=>n+(scopes(fact.payload.lines).find(scope=>scope.lineId===line.lineId)?.quantity??0),0);
    return sum+row.available+row.sent+handedOn;
   },0);
   return {lineId:line.lineId,qualified,complete:qualified===line.quantity,conflict:qualified>line.quantity};
  });
  const ownSendIds=new Set(own.filter(fact=>fact.kind==='工艺发出').map(fact=>fact.fact_id));
  return {step,batches,totals:ledger.totals,pendingSends:ledger.pendingSends.filter(send=>ownSendIds.has(send.factId)),completion,quantityConflict:ledger.quantityConflict||completion.some(line=>line.conflict)};
 });
 const terminal=result.at(-1)!;
 return {steps:result,terminalStepRef:terminal.step.stepId,
  batches:terminal.batches,totals:terminal.totals,pendingSends:result.flatMap(step=>step.pendingSends.map(send=>({...send,stepRef:step.step.stepId}))),
  quantityConflict:result.some(step=>step.quantityConflict),
  complete:terminal.totals.length>0&&terminal.totals.every(line=>line.sent===line.quantity),
  canDispatch:terminal.batches.some(batch=>batch.rows.some(row=>row.available>0&&row.allowDispatch)),
  // Requested lines must additionally satisfy these per-PO predecessor facts
  // in the original write transaction; one ready PO does not unlock a sibling.
  sendable:result.map((step,index)=>({stepRef:step.step.stepId,lines:lines.map(line=>{
   const own=step.totals.find(total=>total.lineId===line.lineId)!;
   const prior=index?result[index-1]!:null,available=prior?.batches.reduce((sum,batch)=>sum+batch.rows.filter(row=>row.lineId===line.lineId&&row.allowDispatch).reduce((n,row)=>n+row.available,0),0);
   return {lineId:line.lineId,remaining:!prior?own.craftRemaining:prior.completion.find(item=>item.lineId===line.lineId)?.complete?Math.min(own.craftRemaining,available??0):0};
  })}))};
}
