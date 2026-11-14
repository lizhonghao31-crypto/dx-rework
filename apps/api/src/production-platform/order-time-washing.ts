import type {PoolClient} from 'pg';
import type {OrderTimeWashingChanges} from '@dx-rework/contracts/order-time-requests';
import type {BulkWashingAdoption} from '@dx-rework/contracts/bulk-washing';
import {washingPlans,washingConflict} from './bulk-washing-repository.js';

/** One bounded original-order read. Proposed values affect only this calculation;
 * the original apply transaction separately validates and writes the adoption. */
export async function orderTimeWashingState(db:Pick<PoolClient,'query'>,orderId:string,changes:OrderTimeWashingChanges){
 const lines=(await db.query('SELECT line_id,coalesce(po_number,formal_style_no,line_id::text) AS label FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[orderId])).rows;
 const result=new Map<string,{label:string;version:number;document:BulkWashingAdoption|null}>(lines.map(row=>[row.line_id,{label:row.label??row.line_id,version:0,document:null}]));
 for(const plan of await washingPlans(db,orderId))if(result.has(plan.lineId))result.set(plan.lineId,{...result.get(plan.lineId)!,version:plan.version,document:plan.document});
 const seen=new Set<string>();
 for(const change of changes){
  if(seen.has(change.lineId))washingConflict('请选择不重复的洗水PO');seen.add(change.lineId);
  const current=result.get(change.lineId);if(!current)washingConflict('洗水PO不属于本单');
  if(current!.version!==change.expectedVersion)washingConflict('本单洗水安排已更新，本次填写已保留');
  result.set(change.lineId,{...current!,document:structuredClone(change.document)});
 }
 return result;
}
