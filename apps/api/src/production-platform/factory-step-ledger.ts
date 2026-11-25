import {craftStepIdentity,type AdoptedCraftStep} from '@dx-rework/contracts/digital-craft';
import {factoryBatchLedger,factoryBatchReleaseAvailable,scopes,type BatchFact,type BatchCheck,type BatchRow,type FactoryScope} from './factory-batch-ledger.js';

export function priorCraftReleasedPieces(prior:{completion:ReadonlyArray<{lineId:string;complete:boolean}>},row:BatchRow){
 return prior.completion.find(item=>item.lineId===row.lineId)?.complete?factoryBatchReleaseAvailable(row):row.releasedAvailable??0;
}

type Step=Pick<AdoptedCraftStep,'stepId'|'craftKind'|'sequence'|'specialCraft'>;
/** Original immutable movements stay the quantity source. A second craft is
 * another operation on the same pieces, never another supply of cut pieces.
 */
export function factoryStepLedger(lines:FactoryScope[],facts:BatchFact[],checks:BatchCheck[],steps:readonly Step[]){
 if(!steps.length||steps.length>64||new Set(steps.map(step=>step.stepId)).size!==steps.length
  ||new Set(steps.map(craftStepIdentity)).size!==steps.length||steps.some((step,index)=>step.sequence!==index+1))throw Error('独立工艺路线身份或先后顺序无效');
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
    const row=batch.rows.find(row=>row.lineId===line.lineId);if(!row||!row.allowDispatch&&row.releasedAvailable===undefined)return sum;
    const handedOn=transfers.filter(fact=>fact.payload.fromReturnId===batch.factId).reduce((n,fact)=>n+(scopes(fact.payload.lines).find(scope=>scope.lineId===line.lineId)?.quantity??0),0);
    return sum+factoryBatchReleaseAvailable(row)+row.sent+handedOn;
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
  canDispatch:terminal.batches.some(batch=>batch.rows.some(row=>factoryBatchReleaseAvailable(row)>0)),
  // Requested lines must additionally satisfy these per-PO predecessor facts
  // in the original write transaction; one ready PO does not unlock a sibling.
  sendable:result.map((step,index)=>({stepRef:step.step.stepId,lines:lines.map(line=>{
   const own=step.totals.find(total=>total.lineId===line.lineId)!;
   const prior=index?result[index-1]!:null,priorRows=prior?.batches.flatMap(batch=>batch.rows.filter(row=>row.lineId===line.lineId))??[];
   // Existing orders wait for their original whole-PO release. A new counted check
   // can additionally prove an explicit partial scope on its own exact lot.
   const available=prior?priorRows.reduce((sum,row)=>sum+priorCraftReleasedPieces(prior,row),0):0;
   return {lineId:line.lineId,remaining:!prior?own.craftRemaining:Math.min(own.craftRemaining,available)};
  })}))};
}
