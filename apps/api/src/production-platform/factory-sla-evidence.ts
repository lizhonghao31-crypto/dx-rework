import type {PoolClient} from 'pg';
import type {SlaNodeFact,SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {factoryBatchTiming} from './factory-batch-timing.js';
/** Stage completion requires all applicable physical quantities, not the first dispatch. */
export async function factorySlaEvidence(db:Pick<PoolClient,'query'>,orderId:string){
 const timing=await factoryBatchTiming(db,orderId);if(!timing)return null;
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
 return {craftKey,facts,windows:timing.windows};
}
export function factoryEvaluationPlan(plan:SlaPlan,craftKey:string|null){
 const copy=structuredClone(plan);
 for(const n of copy.nodes){
  if(['bulk_printing','bulk_embroidery','bulk_print_embroidery'].includes(n.id))n.applicable=n.id===craftKey?'yes':'no';
  if(n.id==='bulk_qc'){n.applicable=craftKey?'yes':'no';n.dependsOn=craftKey?[craftKey]:['bulk_cutting'];}
  if(n.id==='warehouse_dispatch')n.dependsOn=[craftKey?'bulk_qc':'bulk_cutting','sourcing_approval'];
 }
 return copy;
}
