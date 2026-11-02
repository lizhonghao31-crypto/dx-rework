import type {Pool} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';

/** Two fixed original read domains. No caller-supplied table, event kind or write operation. */
export async function orderDocumentHistory(pool:Pool,actor:TrustedActorContext,orderId:string,family:'fabric'|'receipt_quality',beforeId?:string){
 const kinds=family==='fabric'?['bulk_fabric_report','bulk_fabric_decision']:['garment_receipt_qc'];
 const db=await pool.connect();try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  // Same authority as the original bulk-preparation and closure readers, before cursor lookup or counts.
  await new DigitalProductionAccessPolicy(db).assert(actor,'order',orderId,'technical');
  if(beforeId&&!(await db.query("SELECT 1 FROM digital_production_task_events WHERE resource_kind='order' AND resource_id=$1 AND event_kind=ANY($2::text[]) AND event_id=$3",[orderId,kinds,beforeId])).rowCount)throw new ApplicationError('NOT_FOUND','找不到本单所选历史游标',404);
  const found=(await db.query(`SELECT e.event_id,e.event_kind,e.payload,e.occurred_at,e.recorded_at,u.display_name
   FROM digital_production_task_events e LEFT JOIN app_users u ON u.id=e.actor_id
   WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind=ANY($2::text[])
    AND ($3::uuid IS NULL OR (e.recorded_at,e.event_id)<(SELECT recorded_at,event_id FROM digital_production_task_events WHERE event_id=$3))
   ORDER BY e.recorded_at DESC,e.event_id DESC LIMIT 21`,[orderId,kinds,beforeId??null])).rows;
  const page=found.slice(0,20),items=page.map(r=>({eventId:r.event_id,kind:r.event_kind,payload:r.payload,occurredAt:r.occurred_at?new Date(r.occurred_at).toISOString():null,recordedAt:new Date(r.recorded_at).toISOString(),operatorName:r.display_name??null}));
  await db.query('COMMIT');return {orderId,family,items,nextBeforeId:found.length>20?page.at(-1)!.event_id:null};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
