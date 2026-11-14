import type {BulkWashingSheet} from '@dx-rework/contracts/bulk-washing';
import {washingPlans,type WashingDB} from './bulk-washing-repository.js';
import {garmentQuality} from './garment-quality.js';
/** Projection writes cannot change receipts, QC, packing, budgets or contracts. */
export async function refreshBulkWashingCoverage(db:WashingDB,orderId:string,sheet:BulkWashingSheet){
 const latest=new Map((await washingPlans(db,orderId)).map(p=>[p.lineId,p]));
 for(const receipt of await garmentQuality(db,orderId)){
  const scopes=sheet.scopes.filter(s=>s.lineId===receipt.lineId&&(s.scopeId===`receipt:${receipt.receiptId}`||s.receipts?.some(r=>r.receiptId===receipt.receiptId)));
  let qualified:number|null=0;
  const modes=new Set(scopes.map(s=>s.mode));
  if(modes.size>1)qualified=null; // A route change cannot silently certify overlapping physical batches.
  for(const scope of scopes){
   if(qualified===null)break;
   if(scope.ledger.conflict){qualified=null;break;}
   if(scope.mode==='after_receipt'){qualified=scope.ledger.qualified;continue;}
   const links=scope.facts.filter(f=>!f.voided&&f.kind==='receipt_link'&&f.receiptId===receipt.receiptId);
   for(const link of links){
    if(link.kind!=='receipt_link')continue;
    const completion=scope.facts.find(f=>!f.voided&&f.id===link.completionId&&f.kind==='factory_complete');
    const qc=scope.facts.find(f=>!f.voided&&f.kind==='inspection'&&f.completionId===link.completionId);
    // One completion may feed several receipts. Re-check its entire live
    // allocation after QC withdrawal/replacement, not just this receipt.
    const allocated=scope.facts.filter(f=>!f.voided&&f.kind==='receipt_link'&&f.completionId===link.completionId)
     .reduce((sum,f)=>sum+f.quantity,0);
    if(link.receiptQuantityVersion!==receipt.quantityVersion||!completion||!qc||qc.kind!=='inspection'
     ||allocated>qc.qualifiedQuantity){qualified=null;break;}
    qualified+=link.quantity;
   }
  }
  if(qualified!==null&&qualified>receipt.quantity)qualified=null;
  await db.query(`INSERT INTO digital_bulk_washing_receipt_coverage(receipt_id,production_order_id,line_id,quantity_version,qualified,factory_sources,plan_id)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(receipt_id) DO UPDATE SET quantity_version=excluded.quantity_version,qualified=excluded.qualified,factory_sources=excluded.factory_sources,plan_id=excluded.plan_id,refreshed_at=CURRENT_TIMESTAMP`,
  [receipt.receiptId,orderId,receipt.lineId,receipt.quantityVersion,qualified,JSON.stringify(scopes.flatMap(s=>s.factorySource?[s.factorySource]:[])),latest.get(receipt.lineId)?.id??null]);
 }
}
/** Current native corrections and factory allocations invalidate a stale
 * cached release in the SELECT, without waiting for a background rebuild. */
export const washingCoverageValidSql=(alias:string,quantityVersion:string)=>`${alias}.quantity_version=${quantityVersion}
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${alias}.factory_sources) source
  WHERE NOT EXISTS(SELECT 1 FROM sourcing_factory_execution_lines((source->>'productionId')::uuid,(source->>'sourcingDecisionId')::uuid) allocation
   WHERE allocation.position=(source->>'position')::integer AND allocation.quantity=(source->>'quantity')::bigint))`;
const installed=new WeakSet<WashingDB>();
export async function bulkWashingInstalled(db:WashingDB){
 if(installed.has(db))return true;
 const found=Boolean((await db.query("SELECT to_regclass('digital_bulk_washing_receipt_coverage') AS relation")).rows[0]?.relation);
 if(found)installed.add(db);return found;
}
export const washingRequiredSql=(po:string)=>`(${po}.bulk_washing_plan_id IS NOT NULL AND (
 EXISTS(SELECT 1 FROM digital_bulk_washing_plans wp WHERE wp.plan_id=${po}.bulk_washing_plan_id AND wp.document->'arrangement'->>'mode'<>'none')
 OR EXISTS(SELECT 1 FROM digital_bulk_washing_events we JOIN digital_bulk_washing_plans wp ON wp.plan_id=we.plan_id
  WHERE wp.line_id=${po}.line_id AND we.kind IN ('send','factory_start') AND NOT EXISTS(
   SELECT 1 FROM digital_bulk_washing_events v WHERE v.production_order_id=we.production_order_id AND v.scope_id=we.scope_id AND v.kind='void' AND v.payload->>'factId'=we.event_id::text))))`;
export async function readWashingCoverage(db:WashingDB,orderId:string){
 const rows=(await db.query(`SELECT r.receipt_id,CASE WHEN w.plan_id=p.bulk_washing_plan_id AND ${washingCoverageValidSql('w',"coalesce(c.correction_id,r.receipt_id)::text")} THEN w.qualified ELSE NULL END AS qualified
  FROM digital_production_child_lines l JOIN receiving_receipts r ON r.receipt_id=l.child_id
  JOIN digital_production_po_lines p ON p.line_id=l.line_id
  LEFT JOIN LATERAL(SELECT correction_id FROM receiving_receipt_corrections WHERE receipt_id=r.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1)c ON true
  LEFT JOIN digital_bulk_washing_receipt_coverage w ON w.receipt_id=r.receipt_id
  WHERE l.module='receiving' AND l.production_order_id=$1 AND ${washingRequiredSql('p')}`, [orderId])).rows;
 return new Map<string,number|null>(rows.map(r=>[r.receipt_id,r.qualified===null?null:Number(r.qualified)]));
}
