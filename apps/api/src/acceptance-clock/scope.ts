import type {Pool,PoolClient} from 'pg';
import {ApplicationError} from '../platform/errors.js';
export type ClockRoot=Readonly<{kind:'source'|'order'|'unbound';id:string;scenarioId:string|null}>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const clockUuid=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value);
/** The new request is a pointer to its existing native source/order. Resolve
 * only this route's stable request ID, without making all arbitrary request
 * UUIDs native clock roots or guessing from a style number. */
export async function clockOrderTimeRequestRoots(db:Pick<Pool|PoolClient,'query'>,id:unknown):Promise<ClockRoot[]>{
 if(!clockUuid(id))return [];
 const row=(await db.query('SELECT source_id,production_order_id FROM digital_order_time_requests WHERE request_id=$1',[id])).rows[0];
 return row?.production_order_id?clockRoots(db,row.production_order_id):row?.source_id?clockRoots(db,row.source_id):[];
}
/** Only the known lifecycle route may interpret resourceId, and only as the
 * declared native kind. Arbitrary body resourceId fields remain non-roots. */
export async function clockLifecycleRoots(db:Pick<Pool|PoolClient,'query'>,kind:unknown,id:unknown):Promise<ClockRoot[]>{
 if((kind!=='source'&&kind!=='order')||!clockUuid(id))throw new ApplicationError('VALIDATION_ERROR','请检查生命周期对象类型及标识',400);
 const roots=await clockRoots(db,id),native=roots.filter(root=>root.id===id&&(root.kind==='source'||root.kind==='order'));
 const exact=native.filter(root=>root.kind===kind);
 if(native.length&&!exact.length)throw new ApplicationError('VALIDATION_ERROR','生命周期对象类型与原单不一致',400);
 return exact;
}
/** Stable native IDs only; never infer lifecycle from a style/PO text search. */
export async function clockRoots(db:Pick<Pool|PoolClient,'query'>,id:string):Promise<ClockRoot[]>{
 if(!clockUuid(id))return [];
 return (await db.query(`WITH roots(kind,id) AS (
  SELECT 'source',source_id FROM digital_production_sources WHERE source_id=$1
  UNION SELECT 'order',production_order_id FROM digital_production_orders WHERE production_order_id=$1
  UNION SELECT CASE WHEN production_order_id IS NULL THEN 'source' ELSE 'order' END,coalesce(production_order_id,source_id) FROM digital_production_task_access WHERE task_id=$1
  UNION SELECT 'order',production_order_id FROM digital_production_po_lines WHERE line_id=$1
  UNION SELECT 'order',production_order_id FROM digital_production_child_links WHERE child_id=$1
  UNION SELECT 'order',l.production_order_id FROM receiving_receipts r JOIN digital_production_child_links l ON l.module='receiving' AND l.child_id=r.receipt_id WHERE r.receipt_id=$1 OR r.receiving_batch_id=$1
  UNION SELECT 'order',l.production_order_id FROM receiving_batches b JOIN digital_production_child_links l ON l.module='cutting' AND l.child_id=b.cutting_order_id WHERE b.receiving_batch_id=$1
  UNION SELECT 'order',l.production_order_id FROM rework_work_tasks t JOIN digital_production_child_links l ON l.module='rework' AND l.child_id=t.rework_order_id WHERE t.work_task_id=$1
  UNION SELECT 'order',l.production_order_id FROM rework_work_reports r JOIN digital_production_child_links l ON l.module='rework' AND l.child_id=r.rework_order_id WHERE r.work_report_id=$1
  UNION SELECT 'order',l.production_order_id FROM rework_wage_items w JOIN digital_production_child_links l ON l.module='rework' AND l.child_id=w.rework_order_id WHERE w.wage_item_id=$1
  UNION SELECT 'source',l.source_id FROM digital_development_pattern_links l
   LEFT JOIN pattern_room_rounds r ON r.order_id=l.order_id LEFT JOIN pattern_room_segments s ON s.round_id=r.round_id
   WHERE l.order_id=$1 OR r.round_id=$1 OR s.segment_id=$1
  UNION SELECT 'unbound',sourcing_case_id FROM sourcing_cases n WHERE sourcing_case_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='sourcing' AND l.child_id=n.sourcing_case_id)
  UNION SELECT 'unbound',cutting_order_id FROM cutting_orders n WHERE cutting_order_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='cutting' AND l.child_id=n.cutting_order_id)
  UNION SELECT 'unbound',production_order_id FROM sourcing_production_orders n WHERE production_order_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='production' AND l.child_id=n.production_order_id)
  UNION SELECT 'unbound',rework_order_id FROM rework_orders n WHERE rework_order_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='rework' AND l.child_id=n.rework_order_id)
  UNION SELECT 'unbound',receiving_batch_id FROM receiving_batches n WHERE receiving_batch_id=$1
   AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='cutting' AND l.child_id=n.cutting_order_id)
   AND NOT EXISTS(SELECT 1 FROM receiving_receipts r JOIN digital_production_child_links l ON l.module='receiving' AND l.child_id=r.receipt_id WHERE r.receiving_batch_id=n.receiving_batch_id)
  UNION SELECT 'unbound',receipt_id FROM receiving_receipts n WHERE receipt_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='receiving' AND l.child_id=n.receipt_id)
  UNION SELECT 'unbound',work_task_id FROM rework_work_tasks n WHERE work_task_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='rework' AND l.child_id=n.rework_order_id)
  UNION SELECT 'unbound',work_report_id FROM rework_work_reports n WHERE work_report_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='rework' AND l.child_id=n.rework_order_id)
  UNION SELECT 'unbound',order_id FROM pattern_room_orders n WHERE order_id=$1
   AND NOT EXISTS(SELECT 1 FROM digital_production_child_links l WHERE l.module='pattern_room' AND l.child_id=n.order_id)
   AND NOT EXISTS(SELECT 1 FROM digital_development_pattern_links l WHERE l.order_id=n.order_id)
 ) SELECT roots.kind,roots.id,m.scenario_id AS "scenarioId" FROM roots
 LEFT JOIN acceptance_sla_clock_resources m ON m.resource_kind=roots.kind AND m.resource_id=roots.id`,[id])).rows;
}
const idFields=new Set(['id','sourceId','orderId','taskId','caseId','sourcingCaseId','productionOrderId','cuttingOrderId','receivingBatchId','batchId','receiptId','reworkOrderId','workTaskId','workReportId','wageItemId','roundId','segmentId','lineId','patternOrderId','parentSourceId']);
export function clockRequestIds(...values:unknown[]):string[]{
 const ids=new Set<string>();
 const walk=(value:unknown,depth:number)=>{
  if(depth>16||ids.size>100)throw new ApplicationError('VALIDATION_ERROR','测试业务关联过多或嵌套过深，请分次办理',400);
  if(Buffer.isBuffer(value))return;
  if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
   if(idFields.has(key)&&clockUuid(item))ids.add(item);else if(item&&typeof item==='object')walk(item,depth+1);
  }
 };
 for(const value of values)walk(value,0);return [...ids];
}
