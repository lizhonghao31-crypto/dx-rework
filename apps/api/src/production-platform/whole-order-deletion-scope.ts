import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ApplicationError} from '../platform/errors.js';

type DB=Pick<PoolClient,'query'>;
export type DeletionObject={kind:string;id:string};
export type WholeOrderScope={id:string;sourceId:string|null;orderId:string|null;label:string;customer:string|null;poCount:number;objects:DeletionObject[];revision:string;counts:Record<string,number>};
/** Explicit ownership links only; matching style/customer strings are never
 * grounds to remove another order or shared catalogue/attachment bytes. */
export async function wholeOrderScope(db:DB,id:string):Promise<WholeOrderScope>{
 const root=(await db.query(`SELECT s.source_id,o.production_order_id,coalesce(o.design_style_no,s.design_style_no) AS label,
  coalesce(o.customer_code,s.customer_code) AS customer,o.version
  FROM digital_production_sources s FULL JOIN digital_production_orders o ON o.source_id=s.source_id
  WHERE s.source_id=$1 OR o.production_order_id=$1`,[id])).rows[0];
 if(!root)throw new ApplicationError('NOT_FOUND','订单不存在',404);
 const sourceId=root.source_id??null,orderId=root.production_order_id??null;
 const objects=new Map<string,DeletionObject>();
 const add=(kind:string,objectId:string)=>objects.set(kind+':'+objectId,{kind,id:objectId});
 if(sourceId)add('source',sourceId);if(orderId)add('order',orderId);
 const pos=(await db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY line_id',[orderId])).rows;
 for(const po of pos)add('po',po.line_id);
 const children=(await db.query('SELECT module,child_id FROM digital_production_child_links WHERE production_order_id=$1 ORDER BY module,child_id',[orderId])).rows;
 for(const row of children)add(row.module,row.child_id);
 const ids=(kind:string)=>[...objects.values()].filter(item=>item.kind===kind).map(item=>item.id);
 // Native children may predate the digital link adapter. Traverse foreign keys,
 // never a style number, so historical downstream orders are included too.
 for(const row of (await db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=ANY($1::uuid[])',[ids('sourcing')])).rows)add('cutting',row.cutting_order_id);
 for(const row of (await db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=ANY($1::uuid[])',[ids('sourcing')])).rows)add('production',row.production_order_id);
 for(const row of (await db.query(`SELECT receipt_id FROM receiving_receipts WHERE cutting_order_id=ANY($1::uuid[])
  UNION SELECT receipt_id FROM sourcing_production_receipt_links WHERE production_order_id=ANY($2::uuid[])`,[ids('cutting'),ids('production')])).rows)add('receiving',row.receipt_id);
 const patterns=(await db.query(`SELECT l.order_id FROM digital_development_pattern_links l WHERE l.source_id=$1
  UNION SELECT o.order_id FROM pattern_room_orders o WHERE o.misc_association->>'kind'='source' AND o.misc_association->>'id'=$1::text
  OR o.misc_association->>'kind'='po' AND EXISTS(SELECT 1 FROM digital_production_po_lines po WHERE po.production_order_id=$2 AND po.line_id::text=o.misc_association->>'id')`,[sourceId,orderId])).rows;
 for(const row of patterns)add('pattern_room',row.order_id);
 const tasks=(await db.query(`SELECT a.task_id FROM digital_production_task_access a WHERE a.source_id=$1 OR a.production_order_id=$2 ORDER BY a.task_id`,[sourceId,orderId])).rows;
 for(const row of tasks)add('task',row.task_id);
 // Receipt links use the individual receipt identity. A batch is included only
 // when ALL of its receipts belong to this whole order; shared batches survive.
 const receipts=[...objects.values()].filter(item=>item.kind==='receiving').map(item=>item.id);
 const batches=(await db.query(`SELECT DISTINCT r.receiving_batch_id FROM receiving_receipts r WHERE r.receipt_id=ANY($1::uuid[])
  AND NOT EXISTS(SELECT 1 FROM receiving_receipts other WHERE other.receiving_batch_id=r.receiving_batch_id AND NOT(other.receipt_id=ANY($1::uuid[])))`,[receipts])).rows;
 for(const row of batches)add('receiving_batch',row.receiving_batch_id);
 for(const row of (await db.query('SELECT rework_order_id FROM rework_orders WHERE source_receiving_batch_id=ANY($1::uuid[])',[ids('receiving_batch')])).rows)add('rework',row.rework_order_id);
 const sorted=[...objects.values()].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
 const counts:Record<string,number>={};for(const item of sorted)counts[item.kind]=(counts[item.kind]??0)+1;
 const canonical=orderId??sourceId!;
 const revision=createHash('sha256').update(JSON.stringify({id:canonical,version:root.version??null,objects:sorted})).digest('hex');
 return {id:canonical,sourceId,orderId,label:root.label,customer:root.customer,poCount:pos.length,objects:sorted,revision,counts};
}
