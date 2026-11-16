import type {PoolClient} from 'pg';
import {PackingAllocationsInputSchema,type PackingAllocationInput} from '@dx-rework/contracts';
import {ApplicationError} from '../platform/errors.js';
import {resolvePackingTime} from './packing-actual-time.js';
const fail=(message:string):never=>{throw new ApplicationError('CONFLICT',message,409);};

/** Already under the original group/version/Root correction lock. Binding
 * adds no stock, shipment or QC event, and never allocates by FIFO. */
export async function packingReceiptAllocations(db:PoolClient,batchId:string,quantity:number,raw:readonly PackingAllocationInput[],now:string){
 const parsed=PackingAllocationsInputSchema.safeParse(raw);if(!parsed.success)fail(parsed.error.issues[0]?.message??'请核对装箱批次关联');
 const rows=parsed.data!;
 if(rows.reduce((sum,row)=>sum+row.quantity,0)!==quantity)fail('明确关联的装箱数量合计须等于本次累计装箱数量');
 if(!rows.length)return [];
 const native=(await db.query(`SELECT r.receipt_id,coalesce(c.correction_id,r.receipt_id)::text AS quantity_version,coalesce(c.actual_quantity,r.actual_quantity)::bigint AS quantity
  FROM receiving_receipts r JOIN receiving_batches b USING(receiving_batch_id)
  JOIN receiving_batches original ON original.receiving_batch_id=$1 AND original.deleted_at IS NULL
  LEFT JOIN LATERAL(SELECT correction_id,actual_quantity FROM receiving_receipt_corrections WHERE receipt_id=r.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1)c ON true
  WHERE r.receipt_id=ANY($2::uuid[]) AND b.deleted_at IS NULL
   AND coalesce('cut:'||b.cutting_order_id::text,'style:'||upper(btrim(b.style_no)))=coalesce('cut:'||original.cutting_order_id::text,'style:'||upper(btrim(original.style_no)))`,[batchId,rows.map(row=>row.receiptId)])).rows;
 return rows.map(row=>{
  const receipt=native.find(receipt=>receipt.receipt_id===row.receiptId);
  if(!receipt||receipt.quantity_version!==row.quantityVersion||row.quantity>Number(receipt.quantity))fail('关联收货不属于本款／PO、数量版本已变化或装箱超过本笔实收，请重新核对');
  return {receiptId:row.receiptId,quantityVersion:row.quantityVersion,quantity:row.quantity,actualTime:resolvePackingTime(row.packingTime,now)};
 });
}
