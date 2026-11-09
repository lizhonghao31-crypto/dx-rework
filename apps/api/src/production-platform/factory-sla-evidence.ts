import type {PoolClient} from 'pg';
import type {SlaNodeFact,SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {factoryBatchTiming} from './factory-batch-timing.js';
import type {AdoptedCraftStep} from '@dx-rework/contracts/digital-craft';
import {fixedCraftSteps} from './fixed-craft-steps.js';
/** Stage completion requires all applicable physical quantities, not the first dispatch. */
export async function factorySlaEvidence(db:Pick<PoolClient,'query'>,orderId:string){
 const timing=await factoryBatchTiming(db,orderId);if(!timing)return null;
 if('stepLedger'in timing&&timing.stepLedger){
  const steps=await fixedCraftSteps(db,timing.preparationId),facts:Record<string,SlaNodeFact>={};
  const put=(key:string,windows:typeof timing.windows,done:boolean,covered:boolean)=>{
   const starts=windows.map(window=>window.enteredAt),ends=windows.map(window=>window.completedAt);
   facts[key]={evidence:`factory-route:${orderId}:${key}`,businessCompleted:done,batchCoverageComplete:covered,
    batchWindows:windows.map(window=>({startedAt:window.enteredAt,deadline:window.dueAt,warningAt:window.warningAt,completedAt:window.completedAt,complete:window.complete,evidence:window.evidence})),
    ...(starts.length&&starts.every(Boolean)?{startedAt:new Date(Math.min(...starts.map(at=>Date.parse(at!)))).toISOString()}:{}),
    ...(done&&ends.length&&ends.every(Boolean)?{completedAt:new Date(Math.max(...ends.map(at=>Date.parse(at!)))).toISOString()}:{}),};
  };
  for(const step of timing.stepLedger.steps){
   const windows=timing.windows.filter(window=>window.kind==='process_logistics'&&window.stepRef===step.step.stepId);
   put(`bulk_${step.step.craftKind}`,windows,windows.length>0&&windows.every(window=>window.complete),step.completion.every(line=>line.complete));
  }
  const qc=timing.windows.filter(window=>window.kind==='bulk_qc'),dispatch=timing.windows.filter(window=>window.kind==='warehouse_dispatch');
  put('bulk_qc',qc,qc.length===steps.length&&qc.every(window=>window.complete),timing.stepLedger.steps.every(step=>step.completion.every(line=>line.complete)));
  put('warehouse_dispatch',dispatch,timing.ledger.complete,timing.ledger.canDispatch||timing.ledger.complete);
  return {preparationId:timing.preparationId,craftKey:steps.length===1?`bulk_${steps[0]!.craftKind}`:null,craftSteps:steps,facts,windows:timing.windows.map(window=>({...window,lineIds:window.lineId?[window.lineId]:timing.ledger.totals.map(line=>line.lineId)}))};
 }
 const craft=(await db.query('SELECT secondary_craft FROM digital_factory_routes WHERE production_order_id=$1',[orderId])).rows[0].secondary_craft as string;
 const craftKey=craft==='无'?null:craft==='印花'?'bulk_printing':craft==='绣花'?'bulk_embroidery':'bulk_print_embroidery';
 const facts:Record<string,SlaNodeFact>={};
 const craftCovered=timing.ledger.totals.every(l=>l.craftRemaining===0),craftDone=craftCovered&&timing.ledger.pendingSends.every(s=>s.rows.every(l=>l.remaining===0));
 for(const [kind,key,covered,done] of [
  ['process_logistics',craftKey,craftCovered,craftDone],
  ['bulk_qc',craftKey?'bulk_qc':null,craftDone,craftDone&&timing.ledger.batches.every(b=>b.rows.every(l=>l.result!==null))],
  ['warehouse_dispatch','warehouse_dispatch',craft==='无'||craftDone&&timing.ledger.batches.every(b=>b.rows.every(l=>l.available===0||l.allowDispatch)),timing.ledger.complete],
 ] as const){if(!key)continue;
  const windows=timing.windows.filter(w=>w.kind===kind),starts=windows.map(w=>w.enteredAt),ends=windows.map(w=>w.completedAt);
  facts[key]={evidence:`factory-route:${orderId}`,businessCompleted:done,batchCoverageComplete:covered,
   batchWindows:windows.map(w=>({startedAt:w.enteredAt,deadline:w.dueAt,warningAt:w.warningAt,completedAt:w.completedAt,complete:w.complete,evidence:w.evidence})),
   ...(starts.length&&starts.every(Boolean)?{startedAt:new Date(Math.min(...starts.map(x=>Date.parse(x!)))).toISOString()}:{}),
   ...(done&&ends.length&&ends.every(Boolean)?{completedAt:new Date(Math.max(...ends.map(x=>Date.parse(x!)))).toISOString()}:{}),
  };
 }
 const windows=timing.windows.map(window=>({...window,lineIds:window.lineId?[window.lineId]
  :window.kind==='bulk_qc'?timing.ledger.batches.find(batch=>batch.factId===window.key)?.rows.map(line=>line.lineId)??[]
  :timing.ledger.pendingSends.find(send=>send.factId===window.key)?.rows.map(line=>line.lineId)??[]}));
 return {preparationId:timing.preparationId,craftKey,facts,windows};
}
export function factoryEvaluationPlan(plan:SlaPlan,craftKey:string|null,steps?:readonly AdoptedCraftStep[]){
 const copy=structuredClone(plan);
 if(steps?.length){
  for(const node of copy.nodes){
   if(['bulk_printing','bulk_embroidery','bulk_print_embroidery'].includes(node.id)){
    const index=steps.findIndex(step=>node.id===`bulk_${step.craftKind}`),step=steps[index];node.applicable=step?'yes':'no';
    if(step){node.kind=step.responsibilitySlaRef?'duration':'unlimited';node.minutes=step.responsibilitySlaRef?step.responsibilityMinutes:null;node.dependsOn=index?[`bulk_${steps[index-1]!.craftKind}`]:['bulk_cutting'];}
   }
   if(node.id==='bulk_qc'){node.applicable='yes';node.dependsOn=[`bulk_${steps.at(-1)!.craftKind}`];}
   if(node.id==='warehouse_dispatch')node.dependsOn=['bulk_qc','sourcing_approval'];
  }
  return copy;
 }
 for(const n of copy.nodes){
  if(['bulk_printing','bulk_embroidery','bulk_print_embroidery'].includes(n.id))n.applicable=n.id===craftKey?'yes':'no';
  if(n.id==='bulk_qc'){n.applicable=craftKey?'yes':'no';n.dependsOn=craftKey?[craftKey]:['bulk_cutting'];}
  if(n.id==='warehouse_dispatch')n.dependsOn=[craftKey?'bulk_qc':'bulk_cutting','sourcing_approval'];
 }
 return copy;
}
