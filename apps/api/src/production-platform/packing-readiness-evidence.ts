import type {ClosureLine,ReceiptQualityFact} from '@dx-rework/contracts/order-closure';
import type {BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import {packingScopeReadiness,type PackingReadinessCondition} from './packing-scope-readiness.js';
import type {reworkSlaEvidence} from './rework-sla-evidence.js';

const unknown={precision:'unknown'} as const;
const instant=(at:string|null|undefined)=>at?{precision:'instant' as const,at}:unknown;
type Rework=Awaited<ReturnType<typeof reworkSlaEvidence>>['windows'][number];

/** All required native conditions converge for the exact scope. This proves
 * whole-PO readiness, never an inferred allocation of individual garments. */
export function packingReadinessEvidence(line:ClosureLine,quality:readonly ReceiptQualityFact[],observedAt:string,
 washing:ReadonlyMap<string,number|null>|undefined,washScopes:readonly BulkWashingScopeView[],reworks:readonly Rework[]):NonNullable<ClosureLine['packingReadiness']>{
 const checks=[...new Map(quality.filter(q=>q.lineId===line.lineId&&q.quantity>0).map(q=>[q.receiptId,q])).values()];
 const common:PackingReadinessCondition[]=[];
 if(line.actualQuantity!==line.documentQuantity)common.push({reference:line.receivingResolutionRef??`receiving:${line.lineId}:difference`,complete:Boolean(line.receivingResolution),occurred:instant(line.receivingResolutionAt)});
 for(const work of line.reworks.filter(work=>work.status!=='cancelled')){
  const parts=reworks.filter(part=>part.reworkId===work.reworkId);
  common.push({reference:parts.map(part=>part.evidence).join(',')||`rework:${work.reworkId}:physical-scope-unknown`,complete:parts.length>0?parts.every(part=>part.complete):work.status==='completed',
   occurred:parts.length&&parts.every(part=>part.completedAt)?instant(parts.map(part=>part.completedAt!).sort().at(-1)):unknown});
 }
 const conditions=(q:ReceiptQualityFact):PackingReadinessCondition[]=>{
  const result:PackingReadinessCondition[]=[{reference:`receipt:${q.receiptId}:quantity:${q.quantityVersion}:qc:${q.packingReadyRef??q.eventId??'missing'}:verified:${q.verificationEventId??'none'}`,complete:q.inspected&&q.qualifiedQuantity===q.quantity,
   occurred:Object.hasOwn(q,'packingReadyAt')?instant(q.packingReadyAt):['现场登记','已核实'].includes(q.timeQuality??'')?instant(q.completedAt):unknown}];
  if(washing?.has(q.receiptId)){
   const scopes=washScopes.filter(scope=>scope.lineId===line.lineId&&(scope.scopeId===`receipt:${q.receiptId}`||scope.receipts?.some(receipt=>receipt.receiptId===q.receiptId)));
   const events=scopes.flatMap(scope=>scope.facts.filter(fact=>!fact.voided&&fact.kind==='inspection'));
   result.push({reference:`washing:${q.receiptId}:${scopes.map(scope=>scope.planId+':'+scope.revision).join(',')||'missing'}`,complete:washing.get(q.receiptId)!==null&&washing.get(q.receiptId)!>=q.quantity&&scopes.length>0&&scopes.every(scope=>!scope.ledger.conflict),
    occurred:events.length&&events.every(event=>event.occurredAt)?instant(events.map(event=>event.occurredAt!).sort().at(-1)):unknown});
  }
  return result;
 };
 const verified=line.cutScope!=='unresolved'&&checks.reduce((sum,q)=>sum+q.quantity,0)===line.actualQuantity;
 const whole=packingScopeReadiness({scope:'whole_po',scopeRef:`po:${line.lineId}`,observedAt,expectedQuantity:verified?line.orderedQuantity:null,receivedQuantity:line.actualQuantity,
  qualifiedQuantity:checks.reduce((sum,q)=>sum+(q.inspected?q.qualifiedQuantity:0),0),conditions:[...common,...checks.flatMap(conditions)]});
 const receipts=checks.map(q=>({receiptId:q.receiptId,quantityVersion:q.quantityVersion,readiness:packingScopeReadiness({scope:'receipt_allocation',scopeRef:`receipt:${q.receiptId}:quantity:${q.quantityVersion}`,observedAt,
  expectedQuantity:verified?q.quantity:null,receivedQuantity:q.quantity,qualifiedQuantity:q.inspected?q.qualifiedQuantity:0,
  conditions:[...conditions(q),...common.map(condition=>line.reworks.length?{...condition,occurred:unknown}:condition)]})}));
 return {whole,receipts};
}
