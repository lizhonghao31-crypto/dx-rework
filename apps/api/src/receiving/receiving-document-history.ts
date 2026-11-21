import {packingActualTime} from '@dx-rework/contracts';
import {receiptTime} from '../production-platform/receiving-summary.js';
import type {Pool,PoolClient} from "pg";
import {ApplicationError} from "../platform/errors.js";

/** Called only after the original receiving read authority. Exact batch/cutting group, never style text. */
export async function receivingDocumentHistory(database:Pool,batchId:string){
 const db=await database.connect();
 try{
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const batch=(await db.query("SELECT receiving_batch_id,cutting_order_id FROM receiving_batches WHERE receiving_batch_id=$1 AND deleted_at IS NULL",[batchId])).rows[0];
  if(!batch)throw new ApplicationError("NOT_FOUND","收货记录不存在",404);
  const ids=(await db.query("SELECT receiving_batch_id FROM receiving_batches WHERE deleted_at IS NULL AND (receiving_batch_id=$1 OR cutting_order_id=$2::uuid AND $2::uuid IS NOT NULL) ORDER BY receiving_batch_id",[batchId,batch.cutting_order_id])).rows.map(row=>row.receiving_batch_id);
  const history=await readReceivingDocumentHistory(db,ids);
  await db.query("COMMIT");
  return history;
 }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
}

/** Caller must prove every supplied batch before reading at the same snapshot. */
export async function readReceivingDocumentHistory(db:PoolClient,ids:readonly string[]){
  const receipts=(await db.query(`SELECT r.receipt_id AS "receiptId",r.receiving_batch_id AS "batchId",r.received_at AS "receivedAt",e.after_state AS "actualTimeState",u.display_name AS "receivedBy",r.document_quantity AS "documentQuantity",r.actual_quantity AS "actualQuantity",r.defective_quantity AS "defectiveQuantity"
    FROM receiving_receipts r LEFT JOIN operation_events e ON e.event_id=r.operation_event_id LEFT JOIN app_users u ON u.id=r.received_by WHERE r.receiving_batch_id=ANY($1::uuid[]) ORDER BY r.received_at,r.receipt_id`,[ids])).rows;
  const corrections=(await db.query(`SELECT c.correction_id AS id,c.receipt_id AS "receiptId",c.created_at AS at,u.display_name AS "by",c.document_quantity AS "documentQuantity",c.actual_quantity AS "actualQuantity",c.defective_quantity AS "defectiveQuantity"
    FROM receiving_receipt_corrections c LEFT JOIN app_users u ON u.id=c.corrected_by WHERE c.receiving_batch_id=ANY($1::uuid[]) ORDER BY c.created_at,c.correction_id`,[ids])).rows;
  const packing=(await db.query(`SELECT p.packing_revision_id AS id,p.receiving_batch_id AS "batchId",p.packing_quantity AS quantity,p.created_at AS at,u.display_name AS "by",event.after_state->'packingActualTime' AS actual_time
    FROM receiving_packing_revisions p LEFT JOIN operation_events event ON event.event_id=p.operation_event_id LEFT JOIN app_users u ON u.id=p.recorded_by WHERE p.receiving_batch_id=ANY($1::uuid[]) ORDER BY p.created_at,p.packing_revision_id`,[ids])).rows;
  const resolutions=(await db.query(`SELECT r.resolution_id AS id,r.difference_type AS "differenceType",r.result,r.created_at AS at,u.display_name AS "by",r.packing_revision_id AS "packingRevisionId"
    FROM receiving_difference_resolutions r LEFT JOIN app_users u ON u.id=r.handled_by WHERE r.receiving_batch_id=ANY($1::uuid[]) ORDER BY r.created_at,r.resolution_id`,[ids])).rows;
  const files=(await db.query(`SELECT a.attachment_id AS id,a.original_filename AS filename,a.entity_id AS "entityId",a.status,a.created_at AS at,u.display_name AS "by",retired.retired_at AS "retiredAt"
    FROM attachments a LEFT JOIN app_users u ON u.id=a.uploaded_by LEFT JOIN receiving_attachment_retirements retired USING(attachment_id)
    WHERE a.entity_type='receiving_batch' AND a.entity_id=ANY($1::text[]) OR a.entity_type='receiving_difference_resolution' AND a.entity_id=ANY($2::text[]) ORDER BY a.created_at,a.attachment_id`,[ids,resolutions.map(row=>row.id)])).rows;
  return {batchIds:ids,receipts:receipts.map(({actualTimeState,...receipt})=>({...receipt,...receiptTime(receipt.receivedAt,actualTimeState)})),corrections,packing:packing.map(({actual_time,...item})=>({...item,actualTime:packingActualTime(actual_time)})),resolutions,files};
}
