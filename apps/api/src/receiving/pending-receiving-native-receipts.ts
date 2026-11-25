import type {PoolClient} from 'pg';
import type {PendingReceivingReceipt} from './pending-receiving-scope.js';

type NativeReceipt={orderId:string;lineId:string;cuttingOrderId:string;receiptId:string;quantityVersion:string;
 actualQuantity:number;productionId:string|null;factoryDecisionId:string|null;cutLinkVerified:boolean};

/** A changed factory and a known original execution are both explicit keys.
 * An absent or unverified link is neither. */
export function receivingFactoryAllocationKey(productionId:string,factoryDecisionId:string|null){
 return `${productionId}:${factoryDecisionId??'original'}`;
}

/** Load current, not historical totals for already authorized native masters,
 * within the caller's allocation read snapshot. No new receipt or QC fact. */
export async function readPendingReceivingNativeReceipts(db:Pick<PoolClient,'query'>,orderIds:readonly string[]){
 const records=new Map<string,PendingReceivingReceipt[]>();
 if(!orderIds.length)return records;
 const result=await db.query<NativeReceipt>(`SELECT cut.production_order_id AS "orderId",cut.line_id AS "lineId",cut.child_id AS "cuttingOrderId",
  receipt.receipt_id AS "receiptId",COALESCE(correction.correction_id,receipt.receipt_id)::text AS "quantityVersion",
  COALESCE(correction.actual_quantity,receipt.actual_quantity)::int AS "actualQuantity",
  execution.production_order_id AS "productionId",execution.factory_decision_id AS "factoryDecisionId",
  EXISTS(SELECT 1 FROM digital_production_child_lines native WHERE native.module='receiving' AND native.child_id=receipt.receipt_id
   AND native.production_order_id=cut.production_order_id AND native.line_id=cut.line_id) AS "cutLinkVerified"
  FROM digital_production_child_lines cut JOIN receiving_receipts receipt ON receipt.cutting_order_id=cut.child_id
  JOIN receiving_batches batch ON batch.receiving_batch_id=receipt.receiving_batch_id AND batch.deleted_at IS NULL
  LEFT JOIN LATERAL(SELECT correction_id,actual_quantity FROM receiving_receipt_corrections
   WHERE receipt_id=receipt.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1) correction ON true
  LEFT JOIN sourcing_production_receipt_links original ON original.receipt_id=receipt.receipt_id
  LEFT JOIN digital_production_child_links link ON link.module='production' AND link.child_id=original.production_order_id
   AND link.production_order_id=cut.production_order_id
  LEFT JOIN sourcing_production_factory_orders execution ON execution.production_order_id=link.child_id
   AND execution.factory_decision_id IS NOT DISTINCT FROM original.factory_decision_id
  WHERE cut.module='cutting' AND cut.production_order_id=ANY($1::uuid[])
  ORDER BY cut.production_order_id,receipt.received_at,receipt.receipt_id`,[[...new Set(orderIds)]]);
 for(const row of result.rows){
  const productionId=row.cutLinkVerified?row.productionId:null;
  const collection=records.get(row.orderId)??[];
  collection.push({receiptId:row.receiptId,quantityVersion:row.quantityVersion,actualQuantity:row.actualQuantity,
   identity:{orderId:row.orderId,lineId:row.lineId,cuttingOrderId:row.cuttingOrderId,productionId,
    factoryAllocationKey:productionId?receivingFactoryAllocationKey(productionId,row.factoryDecisionId):null}});
  records.set(row.orderId,collection);
 }
 return records;
}
