import type {PoolClient} from 'pg';
import {readWarehouseFactoryDispatchScopesForOrders} from '../production-platform/warehouse-factory-dispatch-evidence.js';

/** A false numbered-source flag does not convert historic digital orders. */
export const NATIVE_RECEIVING_MANAGED_SQL=`(COALESCE((to_jsonb(o)->>'order_time_managed')::boolean,false) OR
    COALESCE((to_jsonb(s)->>'workbench_generated_number')::boolean,false) OR EXISTS(
      SELECT 1 FROM digital_factory_routes route JOIN digital_factory_facts f USING(preparation_id)
      WHERE route.production_order_id=o.production_order_id AND f.kind='仓库实际发厂' AND f.payload ? 'dispatchEvidence') OR EXISTS(
      SELECT 1 FROM digital_factory_routes route WHERE route.production_order_id=o.production_order_id
       AND (to_jsonb(route)->>'route_schema_version')::int>=2))`;

type Source={orderIds:readonly string[]}|{batchIds:readonly string[]}|{cutIds:readonly string[]};
type Candidate={orderId:string;lineId:string;receiptId:string;batchId:string;cuttingId:string|null;quantityVersion:string;quantity:number;
 receivedAt:Date;nativeDay:string;productionId:string|null;factoryDecisionId:string|null;shippedOn:string|null;
 cutVerified:boolean;receiptVerified:boolean};
export type NativeReceiptException=Pick<Candidate,'receiptId'|'orderId'|'lineId'|'batchId'|'cuttingId'|'productionId'|'factoryDecisionId'|'quantityVersion'|'quantity'>&{
 reason:'原裁单、PO或工厂执行关联待核'|'没有早于本次实收的有效原仓库发厂'|'没有本次实收日期前的有效原工厂发回';
};

export async function nativeExceptionsForBatchGroup(db:Pick<PoolClient,'query'>,batchId:string){
 const row=(await db.query<{cutting_order_id:string|null}>('SELECT cutting_order_id FROM receiving_batches WHERE receiving_batch_id=$1',[batchId])).rows[0];
 if(!row)return [];
 return readNativeReceiptExceptions(db,row.cutting_order_id?{cutIds:[row.cutting_order_id]}:{batchIds:[batchId]});
}

/** For readers that already authorized these originals. Never associate a
 * receipt by a displayed PO, factory or style name. Unknown legacy records
 * remain on the original ledger without becoming effective digital receipts. */
export async function readNativeReceiptExceptions(db:Pick<PoolClient,'query'>,source:Source,
 alreadyReadDispatches?:Awaited<ReturnType<typeof readWarehouseFactoryDispatchScopesForOrders>>):Promise<NativeReceiptException[]>{
 const batchScope='batchIds'in source,ids='orderIds'in source?source.orderIds:batchScope?source.batchIds:source.cutIds;
 if(!ids.length||!(await db.query("SELECT to_regclass('digital_production_child_lines') AS relation")).rows[0]?.relation)return [];
 const selection='orderIds'in source?`SELECT l.production_order_id,l.line_id,l.child_id,l.module
  FROM digital_production_child_lines l WHERE l.module IN ('cutting','receiving') AND l.production_order_id=ANY($1::uuid[])`:
  'cutIds'in source?`SELECT l.production_order_id,l.line_id,l.child_id,l.module
  FROM digital_production_child_lines l WHERE l.module='cutting' AND l.child_id=ANY($1::uuid[])`:
  `SELECT l.production_order_id,l.line_id,l.child_id,l.module FROM receiving_receipts r
   JOIN digital_production_child_lines l ON l.module='cutting' AND l.child_id=r.cutting_order_id OR l.module='receiving' AND l.child_id=r.receipt_id
   WHERE r.receiving_batch_id=ANY($1::uuid[])`;
 const rows=(await db.query<Candidate>(`WITH authorized AS (${selection}), exact_refs AS (
   SELECT DISTINCT a.production_order_id,a.line_id,receipt.receipt_id FROM authorized a
   JOIN receiving_receipts receipt ON a.module='cutting' AND a.child_id=receipt.cutting_order_id OR a.module='receiving' AND a.child_id=receipt.receipt_id
   ${batchScope?'WHERE receipt.receiving_batch_id=ANY($1::uuid[])':''}
  )
  SELECT ref.production_order_id AS "orderId",ref.line_id AS "lineId",receipt.receipt_id AS "receiptId",
   receipt.receiving_batch_id AS "batchId",receipt.cutting_order_id AS "cuttingId",receipt.received_at AS "receivedAt",
   (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date::text AS "nativeDay",
   coalesce(correction.correction_id,receipt.receipt_id)::text AS "quantityVersion",
   coalesce(correction.actual_quantity,receipt.actual_quantity)::int AS "quantity",
   execution.child_id AS "productionId",original.factory_decision_id AS "factoryDecisionId",
   shipment.shipped_on::text AS "shippedOn",
   EXISTS(SELECT 1 FROM digital_production_child_lines line WHERE line.module='cutting' AND line.child_id=receipt.cutting_order_id
    AND line.production_order_id=ref.production_order_id AND line.line_id=ref.line_id) AS "cutVerified",
   EXISTS(SELECT 1 FROM digital_production_child_lines line WHERE line.module='receiving' AND line.child_id=receipt.receipt_id
    AND line.production_order_id=ref.production_order_id AND line.line_id=ref.line_id) AS "receiptVerified"
  FROM exact_refs ref JOIN digital_production_orders o USING(production_order_id)
  LEFT JOIN digital_production_sources s ON s.source_id=o.source_id
  JOIN receiving_receipts receipt USING(receipt_id)
  JOIN receiving_batches batch ON batch.receiving_batch_id=receipt.receiving_batch_id AND batch.deleted_at IS NULL
  LEFT JOIN LATERAL(SELECT correction_id,actual_quantity FROM receiving_receipt_corrections WHERE receipt_id=receipt.receipt_id
   ORDER BY created_at DESC,correction_id DESC LIMIT 1) correction ON true
  LEFT JOIN sourcing_production_receipt_links original ON original.receipt_id=receipt.receipt_id
  LEFT JOIN digital_production_child_links execution ON execution.module='production' AND execution.child_id=original.production_order_id
   AND execution.production_order_id=ref.production_order_id
  LEFT JOIN sourcing_production_shipments shipment ON shipment.production_order_id=execution.child_id
   AND shipment.factory_decision_id IS NOT DISTINCT FROM original.factory_decision_id AND shipment.recorded_quantity>0
  WHERE ${NATIVE_RECEIVING_MANAGED_SQL}
  ORDER BY ref.production_order_id,ref.line_id,receipt.received_at,receipt.receipt_id`,[[...new Set(ids)]])).rows;
 if(!rows.length)return [];
 const dispatches=alreadyReadDispatches??await readWarehouseFactoryDispatchScopesForOrders(db,[...new Set(rows.map(row=>row.orderId))]);
 const key=(row:{orderId:string;lineId:string;factoryDecisionId:string|null},cuttingId:string|null,productionId:string|null)=>
  JSON.stringify([row.orderId,row.lineId,cuttingId,productionId,row.factoryDecisionId]);
 const firstDispatch=new Map<string,number>();
 for(const dispatch of dispatches){
  if(dispatch.quantity<=0)continue;
  const scope=key(dispatch,dispatch.cuttingOrderId,dispatch.productionId),at=Date.parse(dispatch.dispatchedAt);
  if(!firstDispatch.has(scope)||at<firstDispatch.get(scope)!)firstDispatch.set(scope,at);
 }
 return rows.flatMap(row=>{
  const start=firstDispatch.get(key(row,row.cuttingId,row.productionId));
  const reason:NativeReceiptException['reason']|null=!row.cuttingId||!row.productionId||!row.cutVerified||!row.receiptVerified?
   '原裁单、PO或工厂执行关联待核':start===undefined||start>row.receivedAt.getTime()?'没有早于本次实收的有效原仓库发厂':
   !row.shippedOn||row.shippedOn>row.nativeDay?'没有本次实收日期前的有效原工厂发回':null;
  return reason?[{orderId:row.orderId,lineId:row.lineId,cuttingId:row.cuttingId,productionId:row.productionId,factoryDecisionId:row.factoryDecisionId,batchId:row.batchId,receiptId:row.receiptId,
   quantityVersion:row.quantityVersion,quantity:row.quantity,reason}]:[];
 });
}
