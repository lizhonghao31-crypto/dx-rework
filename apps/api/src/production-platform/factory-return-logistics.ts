import {receiptTime} from './receiving-summary.js';
import type {Pool,PoolClient} from 'pg';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
/** Read original factory shipments. A business date is a range, never an actual midnight instant. */
export async function factoryReturnLogistics(db:Pick<Pool|PoolClient,'query'>,orderId:string,now=new Date()){
 const snapshot=(await db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[orderId])).rows[0];
 const value=snapshot?validateDigitalSlaSnapshot({ruleVersion:snapshot.rule_version,parameters:snapshot.parameters_json}).parameters.return_logistics?.value:null;
 const minutes=value?.kind==='estimate'?value.minutes:null;
 const rows=(await db.query(`SELECT s.production_order_id,s.factory_decision_id,s.shipped_on::text AS shipped_on,s.operation_event_id,p.supplier_name_snapshot,
 (SELECT jsonb_build_object('receivedAt',receipt.received_at,'afterState',event.after_state) FROM sourcing_production_receipt_links received JOIN receiving_receipts receipt USING(receipt_id)
 JOIN receiving_batches batch USING(receiving_batch_id) JOIN operation_events event ON event.event_id=receipt.operation_event_id
 LEFT JOIN LATERAL(SELECT actual_quantity FROM receiving_receipt_corrections correction WHERE correction.receipt_id=receipt.receipt_id ORDER BY correction.created_at DESC,correction.correction_id DESC LIMIT 1) correction ON true
 WHERE received.production_order_id=s.production_order_id AND received.factory_decision_id IS NOT DISTINCT FROM s.factory_decision_id
 AND batch.deleted_at IS NULL AND coalesce(correction.actual_quantity,receipt.actual_quantity)>0 ORDER BY receipt.received_at,receipt.receipt_id LIMIT 1) AS first_received
 FROM digital_production_child_links link JOIN sourcing_production_shipments s ON s.production_order_id=link.child_id
 JOIN sourcing_production_factory_orders p ON p.production_order_id=s.production_order_id AND p.factory_decision_id IS NOT DISTINCT FROM s.factory_decision_id
 WHERE link.module='production' AND link.production_order_id=$1 ORDER BY s.shipped_on,s.production_order_id,s.factory_decision_id`,[orderId])).rows;
 return rows.map(r=>{
  const received=r.first_received?receiptTime(r.first_received.receivedAt,r.first_received.afterState):null;
  const start=Date.parse(`${r.shipped_on}T00:00:00+08:00`),from=minutes===null?null:new Date(start+minutes*60000).toISOString(),until=minutes===null?null:new Date(start+86400000+minutes*60000).toISOString();
  return {productionId:r.production_order_id as string,factoryDecisionId:r.factory_decision_id as string|null,supplierName:r.supplier_name_snapshot as string,
   firstReceivedAt:received?.receivedAt??null,firstReceivedDate:received?.receivedDate??null,hasReceived:Boolean(received),shippedOn:r.shipped_on as string,dispatchPrecision:'date' as const,actualDispatchedAt:null,
   estimatedMinutes:minutes,arrivalRange:from&&until?{fromInclusive:from,toExclusive:until}:null,
   estimateExpired:until&&!received?now.getTime()>=Date.parse(until):false,evidence:`sourcing_production_shipments:${r.operation_event_id}`,snapshotId:snapshot?.snapshot_id??null};
 });
}
