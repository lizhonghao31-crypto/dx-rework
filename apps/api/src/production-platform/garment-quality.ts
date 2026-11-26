import {slaApplications,appliedSlaWindow} from './sla-applied-window.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {GarmentReworkSource,ReceiptQuality,ReceiptQualityFact,ReceiptQualityVerification} from '@dx-rework/contracts/order-closure';
import {ApplicationError} from '../platform/errors.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {receiptTime} from './receiving-summary.js';
import {exactUnboundQualityPhotos,garmentReceiptQualityAttachment} from './original-quality-photo.js';
import {readNativeReceiptExceptions} from '../receiving/native-receipt-qualification.js';
type DB=Pick<Pool|PoolClient,'query'>;
const fail=(message:string):never=>{throw new ApplicationError('GARMENT_QUALITY_CONFLICT',message,409);};
async function ensureCurrentQualityOrder(db:DB,orderId:string){
 if((await db.query("SELECT 1 FROM digital_order_closures WHERE production_order_id=$1 UNION ALL SELECT 1 FROM digital_production_resource_lifecycle WHERE (resource_kind='order' AND resource_id=$1 OR resource_kind='source' AND resource_id=(SELECT source_id FROM digital_production_orders WHERE production_order_id=$1)) AND state<>'active'",[orderId])).rowCount)fail('订单或开发来源已暂停、取消或结案，原质检历史保留');
}
async function assertGarmentReworkAuthority(db:DB,actor:TrustedActorContext,orderId:string,lockRole:boolean){
 const policy=new DigitalProductionAccessPolicy(db);
 await policy.assert(actor,'order',orderId,'technical');
 if(!actor.actorRoles.includes('root_superuser')&&(!actor.actorRoles.includes('quality_control')||
  !await (lockRole?policy.lockActiveRole(actor.actorId,'quality_control'):policy.activeRole(actor.actorId,'quality_control'))))return digitalForbidden();
}
export async function lockGarmentReworkAuthority(db:PoolClient,actor:TrustedActorContext,orderId:string){
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
 await assertGarmentReworkAuthority(db,actor,orderId,true);
}
/** Resolve only the selected receipt, effective quantity revision and current original QC event. */
export async function readGarmentReworkSource(db:DB,actor:TrustedActorContext,source:GarmentReworkSource){
 await assertGarmentReworkAuthority(db,actor,source.orderId,false);
 await ensureCurrentQualityOrder(db,source.orderId);
 const receipt=(await garmentQuality(db,source.orderId)).find(row=>row.receiptId===source.receiptId);
 if(!receipt?.inspected||receipt.quantityVersion!==source.quantityVersion||receipt.eventId!==source.eventId||receipt.qualifiedQuantity>=receipt.quantity||!receipt.problem.trim())
  return fail('原检查或本批实收数量版本已变化，或没有可计量的实际质量问题');
 const metadata=(await db.query<{merchandiser_id:string|null;factory_supplier_id:string|null}>(`SELECT o.primary_merchandiser_id AS merchandiser_id,
    f.supplier_id AS factory_supplier_id FROM digital_production_orders o
    LEFT JOIN sourcing_production_receipt_links r ON r.receipt_id=$2
    LEFT JOIN sourcing_production_factory_orders f ON f.production_order_id=r.production_order_id AND f.factory_decision_id IS NOT DISTINCT FROM r.factory_decision_id
    WHERE o.production_order_id=$1`,[source.orderId,source.receiptId])).rows;
 return {receivingBatchId:receipt.batchId,lineId:receipt.lineId,sourceEventId:source.eventId,quantity:receipt.quantity-receipt.qualifiedQuantity,
  problem:receipt.problem,merchandiserId:metadata[0]?.merchandiser_id??null,factorySupplierId:metadata.length===1?metadata[0]?.factory_supplier_id??null:null};
}
export async function lockOriginalGarmentReworkOrder(db:PoolClient,actor:TrustedActorContext,reworkId:string){
 const binding=(await db.query<{check_id:string|null}>(`SELECT to_jsonb(orders)->>'source_garment_qc_event_id' AS check_id
  FROM rework_orders orders WHERE orders.rework_order_id=$1 AND ($2 OR orders.created_by=$3) AND orders.status<>'deleted'`,
 [reworkId,actor.actorRoles.includes('root_superuser'),actor.actorId])).rows[0]?.check_id;
 if(!binding)return null;
 const original=(await db.query<GarmentReworkSource>(`SELECT resource_id AS "orderId",event_id AS "eventId",
  payload->>'receiptId' AS "receiptId",payload->>'quantityVersion' AS "quantityVersion" FROM digital_production_task_events
  WHERE event_id=$1 AND resource_kind='order' AND event_kind='garment_receipt_qc'`,[binding])).rows[0];
 if(!original)fail('无法核对这张原返工单的成衣质检来源');
 await lockGarmentReworkAuthority(db,actor,original!.orderId);
 return original!;
}
/** Each native receipt is a batch. Current quantity correction invalidates coverage, never deletes inspection history. */
export async function garmentQuality(db:DB,orderId:string,except?:readonly string[]){
 const excluded=except??(await readNativeReceiptExceptions(db,{orderIds:[orderId]})).map(row=>row.receiptId);
 const rows=(await db.query(`SELECT l.line_id,r.receipt_id,r.receiving_batch_id,r.cutting_order_id,r.received_at,e.after_state,
  coalesce(c.actual_quantity,r.actual_quantity)::bigint AS quantity,coalesce(c.correction_id,r.receipt_id)::text AS quantity_version,
  q.event_id,q.occurred_at,q.time_quality,q.payload,q.actor_id,u.display_name,verification.event_id AS verification_event_id,availability.event_id AS availability_event_id,availability.occurred_at AS availability_at,snapshot.snapshot_id,snapshot.rule_version,snapshot.parameters_json
  FROM digital_production_child_lines l JOIN receiving_receipts r ON r.receipt_id=l.child_id JOIN receiving_batches b USING(receiving_batch_id)
  JOIN operation_events e ON e.event_id=r.operation_event_id
  LEFT JOIN LATERAL(SELECT * FROM receiving_receipt_corrections WHERE receipt_id=r.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1)c ON true
  LEFT JOIN LATERAL(SELECT * FROM digital_production_task_events WHERE resource_kind='order' AND resource_id=l.production_order_id AND event_kind='garment_receipt_qc'
   AND payload->>'receiptId'=r.receipt_id::text ORDER BY recorded_at DESC,event_id DESC LIMIT 1)q ON true
  LEFT JOIN LATERAL(SELECT v.event_id FROM digital_production_task_events v WHERE v.resource_kind='order' AND v.resource_id=l.production_order_id
   AND v.event_kind='garment_receipt_qc_time_verified' AND v.corrects_event_id=q.event_id AND v.time_quality='已核实' AND v.occurred_at=q.occurred_at
   AND v.payload->>'receiptId'=r.receipt_id::text AND v.payload->>'quantityVersion'=coalesce(c.correction_id,r.receipt_id)::text
   ORDER BY v.recorded_at DESC,v.event_id DESC LIMIT 1)verification ON true
  LEFT JOIN LATERAL(SELECT old.event_id,old.occurred_at FROM digital_production_task_events old
   WHERE old.resource_kind='order' AND old.resource_id=l.production_order_id AND old.event_kind='garment_receipt_qc'
    AND old.payload->>'receiptId'=r.receipt_id::text AND old.payload->>'quantityVersion'=coalesce(c.correction_id,r.receipt_id)::text
    AND old.payload->'quantity'=to_jsonb(coalesce(c.actual_quantity,r.actual_quantity)::bigint)
    AND old.payload->'qualifiedQuantity'=old.payload->'quantity' AND old.occurred_at IS NOT NULL
    AND (old.time_quality IN ('现场登记','已核实') OR EXISTS(SELECT 1 FROM digital_production_task_events v WHERE v.event_kind='garment_receipt_qc_time_verified'
     AND v.resource_kind='order' AND v.resource_id=l.production_order_id AND v.corrects_event_id=old.event_id AND v.occurred_at=old.occurred_at AND v.time_quality='已核实'
     AND v.payload->>'quantityVersion'=coalesce(c.correction_id,r.receipt_id)::text))
    AND NOT EXISTS(SELECT 1 FROM digital_production_task_events later WHERE later.resource_kind='order' AND later.resource_id=l.production_order_id
     AND later.event_kind='garment_receipt_qc' AND later.payload->>'receiptId'=r.receipt_id::text
     AND later.payload->>'quantityVersion'=coalesce(c.correction_id,r.receipt_id)::text AND (later.recorded_at,later.event_id)>(old.recorded_at,old.event_id)
     AND later.payload->'qualifiedQuantity' IS DISTINCT FROM later.payload->'quantity')
   ORDER BY old.occurred_at,old.recorded_at,old.event_id LIMIT 1)availability ON true
  LEFT JOIN app_users u ON u.id=q.actor_id
  LEFT JOIN digital_sla_order_snapshots snapshot ON snapshot.snapshot_id::text=q.payload->>'snapshotId' AND snapshot.production_order_id=l.production_order_id
  WHERE l.module='receiving' AND l.production_order_id=$1 AND b.deleted_at IS NULL AND r.receipt_id<>ALL($2::uuid[])
  ORDER BY r.received_at,r.receipt_id`,[orderId,[...new Set(excluded)]])).rows;
 const applications=await slaApplications(db,orderId);
 return rows.map(r=>{
  const base=r.snapshot_id?validateDigitalSlaSnapshot({ruleVersion:r.rule_version,parameters:r.parameters_json}):null,applied=base?appliedSlaWindow(base,'garment_packing',`packing:${r.line_id}`,applications):null,frozen=applied?.snapshot.parameters;
  const packing=frozen?.garment_packing?.value,warning=frozen?.warning_ratio?.value;
  const valid=Boolean(r.event_id&&r.payload.quantityVersion===r.quantity_version&&r.payload.quantity===Number(r.quantity));
  return {packingReadyAt:valid&&r.payload.qualifiedQuantity===Number(r.quantity)&&r.availability_at?new Date(r.availability_at).toISOString():null,packingReadyRef:valid?r.availability_event_id??null:null,timeQuality:(valid?(r.verification_event_id?'已核实':r.time_quality):'缺失') as NonNullable<ReceiptQualityFact['timeQuality']>,verificationEventId:r.verification_event_id??null,receiptId:r.receipt_id as string,lineId:r.line_id as string,batchId:r.receiving_batch_id as string,cuttingId:r.cutting_order_id as string|null,
   packingMinutes:packing?.kind==='duration'?packing.minutes:null,warningPercent:warning?.kind==='ratio'?warning.percent:null,snapshotId:applied?.snapshotId??r.snapshot_id??null,quantity:Number(r.quantity),quantityVersion:r.quantity_version as string,...receiptTime(r.received_at,r.after_state),
   inspected:valid,qualifiedQuantity:valid?Number(r.payload.qualifiedQuantity):0,problem:valid?r.payload.problem as string:'',
   completedAt:valid&&r.occurred_at?new Date(r.occurred_at).toISOString():null,eventId:r.event_id as string|null,operator:r.display_name as string|null,
   priorInspection:Boolean(r.event_id)&&!valid,...(valid&&Array.isArray(r.payload.attachmentIds)&&r.payload.attachmentIds.length?{attachmentIds:r.payload.attachmentIds as string[]}:{})};
 });
}
export class GarmentQualityService{
 constructor(private readonly pool:Pool){}
 async authorizeUpload(actor:TrustedActorContext,orderId:string,receiptId:string,quantityVersion:string){
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const policy=new DigitalProductionAccessPolicy(db);
   await policy.assert(actor,'order',orderId,'technical');
   if(!actor.actorRoles.includes('root_superuser')&&!await policy.activeRole(actor.actorId,'quality_control'))digitalForbidden();
   await ensureCurrentQualityOrder(db,orderId);
   const receipt=(await garmentQuality(db,orderId)).find(row=>row.receiptId===receiptId);
   if(!receipt||receipt.quantityVersion!==quantityVersion)fail('收货范围或数量版本已变化，请刷新后核对本批次');
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async record(actor:TrustedActorContext,orderId:string,input:ReceiptQuality,key:string){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");const policy=new DigitalProductionAccessPolicy(db);await policy.assert(actor,'order',orderId,'technical');
   if(!actor.actorRoles.includes('root_superuser')&&!await policy.lockActiveRole(actor.actorId,'quality_control'))digitalForbidden();
   const native=(await db.query(`SELECT r.cutting_order_id,b.style_no FROM receiving_receipts r JOIN receiving_batches b USING(receiving_batch_id)
    JOIN digital_production_child_lines l ON l.module='receiving' AND l.child_id=r.receipt_id AND l.production_order_id=$2 WHERE r.receipt_id=$1 AND b.deleted_at IS NULL`,[input.receiptId,orderId])).rows[0];
   if(!native)fail('本单没有该有效收货批次');
   // Preserve the exact quantity version observed. Native corrections may proceed independently;
   // current projection invalidates any superseded coverage instead of rewriting QC or taking inverse native locks.
   const command=`garment-qc:${orderId}`,payloadHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==payloadHash)fail('该操作标识已用于不同内容');await db.query('COMMIT');return prior.response;}
   await ensureCurrentQualityOrder(db,orderId);
   const receipt=(await garmentQuality(db,orderId)).find(r=>r.receiptId===input.receiptId)!;
   if(receipt.quantityVersion!==input.quantityVersion)fail('收货数量已经更正，请刷新后核对本批次');
   if(input.qualifiedQuantity>receipt.quantity||input.qualifiedQuantity<0||!Number.isSafeInteger(input.qualifiedQuantity))fail('合格数量必须在本批有效实收范围内');
   if(input.qualifiedQuantity<receipt.quantity&&!input.problem.trim())fail('存在不合格成衣时请保留具体质量问题');
   const now=businessNow(),occurredAt=input.timeMode==='now'?now.toISOString():input.occurredAt;
   const at=occurredAt?Date.parse(occurredAt):NaN,earliest=receipt.receivedAt?Date.parse(receipt.receivedAt):receipt.receivedDate?Date.parse(`${receipt.receivedDate}T00:00:00+08:00`):null;
   if(!Number.isFinite(at)||at>now.getTime()||earliest!==null&&at<earliest)fail('检查完成时间不能早于到仓范围或晚于当前时间');
   const photos=input.attachmentIds??[];
   if(!await exactUnboundQualityPhotos(db,actor.actorId,photos))fail('检查图片须由本人上传并可用，不能借用原记录或其他模块图片');
   const snapshot=(await db.query('SELECT snapshot_id FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[orderId])).rows[0];
   const eventId=randomUUID();await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
    VALUES($1,'order',$2,'garment_receipt_qc',$3,$4,$5,$6)`,[eventId,orderId,actor.actorId,occurredAt,input.timeMode==='now'?'现场登记':'补报未核实',JSON.stringify({...input,quantity:receipt.quantity,snapshotId:snapshot?.snapshot_id??null})]);
   if(photos.length)await db.query('UPDATE attachments SET entity_type=$1,entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($3::uuid[])',[garmentReceiptQualityAttachment,eventId,photos]);
   const response={eventId,receiptId:input.receiptId};await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,payloadHash,JSON.stringify(response)]);
   await db.query('COMMIT');return response;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async verifyTime(actor:TrustedActorContext,orderId:string,input:ReceiptQualityVerification,key:string){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const policy=new DigitalProductionAccessPolicy(db);await policy.assert(actor,'order',orderId,'technical');
   if(!actor.actorRoles.includes('root_superuser')||!(await db.query('SELECT access_is_root_actor($1) AS allowed',[actor.actorId])).rows[0]?.allowed)digitalForbidden();
   const command=`garment-qc-time-verify:${orderId}`,payloadHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==payloadHash)fail('该操作标识已用于不同内容');await db.query('COMMIT');return prior.response;}
   const receipt=(await garmentQuality(db,orderId)).find(row=>row.receiptId===input.receiptId);
   if(!receipt?.inspected||receipt.quantityVersion!==input.quantityVersion||receipt.eventId!==input.eventId||receipt.completedAt!==new Date(input.occurredAt).toISOString())fail('原检查或收货范围已变化，请重新读取核对原记录');
   if(Date.parse(input.occurredAt)>businessNow().getTime())fail('原检查时间不能晚于当前时间');
   const eventId=randomUUID();await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,corrects_event_id,payload)
    VALUES($1,'order',$2,'garment_receipt_qc_time_verified',$3,$4,'已核实',$5,$6)`,[eventId,orderId,actor.actorId,input.occurredAt,input.eventId,JSON.stringify(input)]);
   const response={eventId,receiptId:input.receiptId};await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,payloadHash,JSON.stringify(response)]);
   await db.query('COMMIT');return response;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
}
/** Pin the current standard reference alongside a native receipt; this does not change native packing permissions. */
export async function registerGarmentReceipt(db:PoolClient,orderId:string,receiptId:string){
 if(!(await db.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation)return;
 const snapshot=(await db.query('SELECT snapshot_id FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[orderId])).rows[0];if(!snapshot)return;
 await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,time_quality,payload)
  SELECT $1,'order',$2,'garment_receipt_registered',received_by,'缺失',jsonb_build_object('receiptId',receipt_id,'snapshotId',$4::text,'sourceEventId',operation_event_id)
  FROM receiving_receipts WHERE receipt_id=$3`,[randomUUID(),orderId,receiptId,snapshot.snapshot_id]);
}
