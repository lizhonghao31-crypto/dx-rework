import type {Pool,PoolClient} from 'pg';
import {bulkWashingInstalled,washingCoverageValidSql,washingRequiredSql} from './bulk-washing-coverage.js';
import type {ClosureLine,ReceiptQualityFact} from '@dx-rework/contracts/order-closure';

export type PackingQualityCoverage={received:number;inspected:number;qualified:number};
type PackingLine=Pick<ClosureLine,'lineId'|'actualQuantity'|'packingQuantity'|'cutScope'>;

/** A cumulative packing count is not a new quality result or an allocation of
 * individual garments. Keep the recorded count and expose unknown delivery
 * when the effective receipt/QC scope cannot cover it; never cap it to QC. */
export function effectivePackingQuantity(packed:number|null,received:number,quality:PackingQualityCoverage|null):number|null{
 if(packed===null)return null;
 if(packed===0)return 0;
 if(!quality||quality.received!==received||quality.inspected>received||quality.qualified>quality.inspected
  ||packed>received||packed>quality.qualified)return null;
 return packed;
}
export function packingQualityCoverage(line:PackingLine,quality:readonly ReceiptQualityFact[]|undefined,washing?:ReadonlyMap<string,number|null>){
 const checks=[...new Map((quality??[]).filter(check=>check.lineId===line.lineId).map(check=>[check.receiptId,check])).values()];
 const totals=quality===undefined||checks.some(check=>washing?.has(check.receiptId)&&washing.get(check.receiptId)===null)?null:{received:checks.reduce((sum,check)=>sum+check.quantity,0),
  inspected:checks.filter(check=>check.inspected).reduce((sum,check)=>sum+check.quantity,0),
  qualified:checks.filter(check=>check.inspected).reduce((sum,check)=>sum+Math.min(check.qualifiedQuantity,washing?.get(check.receiptId)??check.qualifiedQuantity),0)};
 return {checks,totals,effectiveQuantity:line.cutScope==='unresolved'?null:effectivePackingQuantity(line.packingQuantity,line.actualQuantity,totals)};
}

/** Same native receipt, latest quantity correction and latest receipt-QC event
 * as garmentQuality(). Only scalar quantities leave this query, after callers
 * have authorized the complete order set. No Journey or SLA per-order load. */
export const packingQualityCoverageSql=(ordersParameter:'$1'|'$5',washing=false)=>`WITH current_receipt_quality AS (
 SELECT DISTINCT l.production_order_id,l.line_id,r.receipt_id,
  coalesce(c.actual_quantity,r.actual_quantity)::bigint AS quantity,
  coalesce(c.correction_id,r.receipt_id)::text AS quantity_version,q.payload${washing?`,${washingRequiredSql('po')} AS washing_required,
 CASE WHEN w.plan_id=po.bulk_washing_plan_id AND ${washingCoverageValidSql('w',"coalesce(c.correction_id,r.receipt_id)::text")} THEN w.qualified ELSE NULL END AS washing_qualified`:''}
 FROM digital_production_child_lines l JOIN receiving_receipts r ON r.receipt_id=l.child_id
 JOIN receiving_batches b USING(receiving_batch_id)
 ${washing?'JOIN digital_production_po_lines po ON po.line_id=l.line_id LEFT JOIN digital_bulk_washing_receipt_coverage w ON w.receipt_id=r.receipt_id':''}
 LEFT JOIN LATERAL(SELECT correction_id,actual_quantity FROM receiving_receipt_corrections
  WHERE receipt_id=r.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1)c ON true
 LEFT JOIN LATERAL(SELECT payload FROM digital_production_task_events
  WHERE resource_kind='order' AND resource_id=l.production_order_id AND event_kind='garment_receipt_qc'
   AND payload->>'receiptId'=r.receipt_id::text ORDER BY recorded_at DESC,event_id DESC LIMIT 1)q ON true
 WHERE l.module='receiving' AND l.production_order_id=ANY(${ordersParameter}::uuid[]) AND b.deleted_at IS NULL
), checked_receipt_quality AS (
 SELECT *,coalesce(payload->>'quantityVersion'=quantity_version AND payload->'quantity'=to_jsonb(quantity)
  AND CASE WHEN jsonb_typeof(payload->'qualifiedQuantity')='number'
   THEN (payload->>'qualifiedQuantity')::numeric BETWEEN 0 AND quantity
    AND trunc((payload->>'qualifiedQuantity')::numeric)=(payload->>'qualifiedQuantity')::numeric
   ELSE false END,false) AS inspected FROM current_receipt_quality
)
SELECT production_order_id,line_id,sum(quantity)::text AS received,
 sum(CASE WHEN inspected THEN quantity ELSE 0 END)::text AS inspected,
 ${washing?"CASE WHEN bool_or(washing_required AND washing_qualified IS NULL) THEN NULL ELSE sum(CASE WHEN inspected THEN least((payload->>'qualifiedQuantity')::numeric,CASE WHEN washing_required THEN washing_qualified ELSE quantity END) ELSE 0 END)::text END":"sum(CASE WHEN inspected THEN (payload->>'qualifiedQuantity')::numeric ELSE 0 END)::text"} AS qualified
FROM checked_receipt_quality GROUP BY production_order_id,line_id`;

export async function readPackingQualityCoverage(db:Pick<Pool|PoolClient,'query'>,orderIds:readonly string[]){
 const result=new Map<string,PackingQualityCoverage>();if(!orderIds.length)return result;
 const rows=(await db.query(packingQualityCoverageSql('$1',await bulkWashingInstalled(db)),[orderIds])).rows;
 for(const row of rows)if(row.qualified!==null)result.set(row.line_id,{received:Number(row.received),inspected:Number(row.inspected),qualified:Number(row.qualified)});
 return result;
}
/** The debt counters stay scalar SQL, using the same effective QC totals and
 * the same conditions as effectivePackingQuantity (covered by PG cases). */
export const effectivePackingQuantitySql=(packed:string,received:string,inspected:string,qualified:string,coverageReceived=received)=>
 `CASE WHEN ${packed}=0 THEN 0 WHEN ${packed} IS NULL OR ${received} IS NULL
  OR ${coverageReceived} IS NULL OR ${coverageReceived}<>${received}
  OR ${qualified} IS NULL OR ${inspected}>${received} OR ${qualified}>${inspected}
  OR ${packed}>${received} OR ${packed}>${qualified} THEN NULL ELSE ${packed} END`;
