import type {PoolClient} from 'pg';
import {linkNewDigitalChild,resolveDigitalChild} from './child-link-repository.js';
import {ApplicationError} from '../platform/errors.js';
// Native facts only. A style suffix is never a lifecycle key.
async function source(db:PoolClient,batchId:string){
 if(!(await db.query("SELECT to_regclass('digital_production_child_links') AS relation")).rows[0]?.relation)return null;
 const row=(await db.query(`SELECT c.cutting_order_id,s.workflow_generation FROM receiving_batches b JOIN cutting_orders c USING(cutting_order_id) JOIN sourcing_cases s USING(sourcing_case_id) WHERE b.receiving_batch_id=$1`,[batchId])).rows[0];
 if(!row)return null;
 const id=await resolveDigitalChild(db,'cutting',row.cutting_order_id,row.workflow_generation);if(!id)return null;
 const lines=(await db.query("SELECT line_id FROM digital_production_child_lines WHERE module='cutting' AND child_id=$1 AND production_order_id=$2",[row.cutting_order_id,id])).rows;
 if(lines.length!==1)throw new ApplicationError('DIGITAL_LINK_MISSING','原裁单款色来源缺失，不能模糊绑定回货',409);
 return {id,lineId:lines[0].line_id};
}
export async function linkDigitalReceipt(db:PoolClient,receiptId:string,batchId:string){const s=await source(db,batchId);if(s)await linkNewDigitalChild(db,{module:'receiving',childId:receiptId,productionOrderId:s.id,lines:[{childLineKey:'record',lineId:s.lineId}]});}
export async function linkDigitalRework(db:PoolClient,reworkId:string,batchId:string|null){if(!batchId)return;const s=await source(db,batchId);if(s)await linkNewDigitalChild(db,{module:'rework',childId:reworkId,productionOrderId:s.id,lines:[{childLineKey:'record',lineId:s.lineId}]});}
