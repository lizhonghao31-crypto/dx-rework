import {readWashingCoverage} from './bulk-washing-coverage.js';
import {readNativePackingHeads} from '../receiving/receiving-quantity-query.js';
import {packingQualityCoverage} from './packing-quality-coverage.js';
import {packingReadinessEvidence} from './packing-readiness-evidence.js';
import {readBulkWashing} from './bulk-washing-service.js';
import {reworkSlaEvidence} from './rework-sla-evidence.js';
import {packingActualTime,PackingAllocationsSchema} from '@dx-rework/contracts';
import {journeyCutScopes,NATIVE_EMPTY_PACKING_SCOPE_SQL} from './journey-cut-scopes.js';
import {readClosureWorkSummaries} from './closure-work-summary.js';
import {orderDocumentHistory} from './order-document-history.js';
import {ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {receivingForecast} from './receiving-forecast.js';
import {receivingSpan} from './receiving-span.js';
import {garmentQuality,GarmentQualityService} from './garment-quality.js';
import {canReadExactOriginalQualityPhoto} from './original-quality-photo.js';
import type {ReceiptQuality,ReceiptQualityVerification} from '@dx-rework/contracts/order-closure';
import {canOpenOrderReceiving,receivingSummary,receiptTime} from './receiving-summary.js';
import {factoryDeliveryReadings} from './factory-delivery-reading.js';
import {factoryProductionScopes,factoryProductionFacts} from './factory-production-facts.js';
import {ReworkBusinessDetailService} from "../rework/rework-business-detail-service.js";
import {hasFinanceWageRole} from "@dx-rework/contracts/finance-access";
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {ClosureLine,OrderClosureSheet,SpecialClosure} from '@dx-rework/contracts/order-closure';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {readNativeReceivingTotals} from '../receiving/native-receiving-totals.js';
import {DigitalProductionTaskService} from './task-service.js';
import {CockpitReceiptService} from './cockpit-receipt-service.js';
type DB=Pick<Pool|PoolClient,'query'>;
const fail=(message:string):never=>{throw new ApplicationError('DIGITAL_CLOSURE_CONFLICT',message,409);};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class OrderClosureService{
 readonly cockpitReceipts:CockpitReceiptService;
 constructor(private readonly database:Pool){this.cockpitReceipts=new CockpitReceiptService(database);}
 private async canClose(db:DB,actor:TrustedActorContext){if(actor.actorRoles.includes('root_superuser')&&(await db.query('SELECT access_is_root_actor($1) AS allowed',[actor.actorId])).rows[0]?.allowed)return true;const policy=new DigitalProductionAccessPolicy(db);for(const role of ['production_management','owner_group'])if(actor.actorRoles.includes(role)&&await policy.activeRole(actor.actorId,role))return true;return false;}
 async recordQuality(actor:TrustedActorContext,id:string,input:ReceiptQuality,key:string){return new GarmentQualityService(this.database).record(actor,id,input,key);}
 async authorizeQualityUpload(actor:TrustedActorContext,orderId:string,receiptId:string,quantityVersion:string){return new GarmentQualityService(this.database).authorizeUpload(actor,orderId,receiptId,quantityVersion);}
 async canReadQualityPhoto(actor:TrustedActorContext,orderId:string,ref:{receiptId:string;quantityVersion:string;eventId:string;attachmentId:string}){return canReadExactOriginalQualityPhoto(this.database,actor,{kind:'garment-receipt',orderId,...ref});}
 async verifyQualityTime(actor:TrustedActorContext,id:string,input:ReceiptQualityVerification,key:string){return new GarmentQualityService(this.database).verifyTime(actor,id,input,key);}
 async documentHistory(actor:TrustedActorContext,id:string,beforeId?:string,eventId?:string){return orderDocumentHistory(this.database,actor,id,'receipt_quality',beforeId,eventId);}
 async read(actor:TrustedActorContext,id:string,db:DB=this.database):Promise<OrderClosureSheet>{
  await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');
  return this.project(actor,id,db);
 }
 /** Internal facts only. No route calls this entry; readers still authorize in read(). */
 async readFactsWithClient(id:string,db:PoolClient):Promise<OrderClosureSheet>{return this.project(null,id,db);}
 private async project(actor:TrustedActorContext|null,id:string,db:DB):Promise<OrderClosureSheet>{
  const original=(await db.query(`SELECT p.*,(SELECT jsonb_agg(jsonb_build_object('at',coalesce(event.after_state->'acceptanceClock'->>'now',change.created_at::text),'date',change.new_date::text,'reference',change.change_id,'version',change.version) ORDER BY change.version)
   FROM digital_po_date_changes change JOIN audit_events approval ON approval.id=change.approval_event_id
   LEFT JOIN operation_events event ON event.event_id::text=approval.after_state->>'sourceOperationEventId'
   WHERE change.line_id=p.line_id AND change.production_order_id=p.production_order_id AND change.date_kind='factory') AS factory_date_history,(${NATIVE_EMPTY_PACKING_SCOPE_SQL}) AS packing_absence_proven,(SELECT sum(quantity) FROM digital_production_po_sizes WHERE line_id=p.line_id) total_quantity FROM digital_production_po_lines p JOIN digital_production_orders o USING(production_order_id) WHERE p.production_order_id=$1 ORDER BY p.position`,[id])).rows;
  const cutScopes=new Map((await journeyCutScopes(db,id)).map(scope=>[scope.lineId,scope]));
  // A PO is one demand row. Several native cuts do not prove disjoint
  // allocation, so neither duplicate demand nor guess cumulative packing.
  for(const row of original){const scope=cutScopes.get(row.line_id);row.cut_scope=scope?.status??'missing';row.cutting_id=scope?.status==='verified'?scope.cuts[0]!.cuttingOrderId:null;}
  const cutIds=original.map(r=>r.cutting_id).filter(Boolean);
  const heads=new Map((await readNativePackingHeads(db,cutIds)).map(head=>[head.group_key,head]));
  const totals=await readNativeReceivingTotals(db,cutIds);
  const receipts=(await db.query(`SELECT l.line_id,r.receipt_id,r.received_at,e.after_state,origin.production_order_id AS factory_production_id,origin.factory_decision_id,coalesce(c.actual_quantity,r.actual_quantity) actual_quantity,coalesce(c.document_quantity,r.document_quantity) document_quantity,coalesce(c.defective_quantity,r.defective_quantity) defective_quantity FROM digital_production_child_lines l JOIN receiving_receipts r ON r.receipt_id=l.child_id JOIN receiving_batches b USING(receiving_batch_id) JOIN operation_events e ON e.event_id=r.operation_event_id
   LEFT JOIN sourcing_production_receipt_links origin ON origin.receipt_id=r.receipt_id
   LEFT JOIN LATERAL(SELECT x.actual_quantity,x.defective_quantity,x.document_quantity FROM receiving_receipt_corrections x WHERE x.receipt_id=r.receipt_id ORDER BY x.created_at DESC,x.correction_id DESC LIMIT 1)c ON true
   WHERE l.module='receiving' AND l.production_order_id=$1 AND b.deleted_at IS NULL ORDER BY r.received_at,r.receipt_id`,[id])).rows;
  const reworks=(await db.query(`SELECT l.line_id,r.*, (SELECT count(*)::int FROM rework_wage_items w WHERE w.rework_order_id=r.rework_order_id) wage_items FROM digital_production_child_lines l JOIN rework_orders r ON r.rework_order_id=l.child_id WHERE l.module='rework' AND l.production_order_id=$1 AND r.status<>'deleted' ORDER BY r.created_at,r.rework_order_id`,[id])).rows;
  const reworkAccess=new ReworkBusinessDetailService(this.database);
  const access=actor?await reworkAccess.existingReadAccess(actor,reworks,db):undefined;
  // Only original business-detail access grants the effective process summary.
  const summaries=await readClosureWorkSummaries(db,reworks.filter(rework=>access?.business.has(rework.rework_order_id)));
  const lines:ClosureLine[]=original.map(r=>{const total=totals.find(t=>t.group_key===`cut:${r.cutting_id}`),head=heads.get(`cut:${r.cutting_id}`),t={...total,...head},own=receipts.filter(receipt=>receipt.line_id===r.line_id),known=(key:'actual_quantity'|'document_quantity'|'defective_quantity')=>r.cut_scope==='unresolved'?own.reduce((sum,receipt)=>sum+Number(receipt[key]),0):0;return {lineId:r.line_id,poNumber:r.po_number,color:r.color,orderedQuantity:Number(r.total_quantity),cutScope:r.cut_scope,cuttingId:r.cutting_id??null,receivingBatchId:t?.receiving_batch_id??null,actualQuantity:Number(t?.current_actual_quantity??known('actual_quantity')),documentQuantity:Number(t?.document_quantity??known('document_quantity')),defectiveQuantity:Number(t?.current_defective_quantity??known('defective_quantity')),receiptCount:Number(t?.receipt_count??(r.cut_scope==='unresolved'?own.length:0)),packingQuantity:t?.packing_quantity==null?(r.packing_absence_proven||r.cut_scope==='verified'&&head?.packing_revision_id===null?0:null):Number(t.packing_quantity),packingRevisionId:t?.packing_revision_id??null,...(t?.packing_actual_time?{packingActualTime:packingActualTime(t.packing_actual_time)}:{}),...(PackingAllocationsSchema.safeParse(t?.packing_allocations).success?{packingAllocations:PackingAllocationsSchema.parse(t.packing_allocations)}:{}),packingRecordedAt:t?.packing_recorded_at?new Date(t.packing_recorded_at).toISOString():null,receivingResolutionAt:t?.receiving_resolution_at?new Date(t.receiving_resolution_at).toISOString():null,receivingResolutionRef:t?.receiving_resolution_ref??null,receivingResolution:t?.receiving_resolution??null,packingResolution:t?.packing_resolution??null,receipts:receipts.filter(x=>x.line_id===r.line_id).map(x=>({receiptId:x.receipt_id,...receiptTime(x.received_at,x.after_state),actualQuantity:Number(x.actual_quantity),defectiveQuantity:Number(x.defective_quantity)})),reworks:reworks.filter(x=>x.line_id===r.line_id).map(x=>({reworkId:x.rework_order_id,canView:access?.readable.has(x.rework_order_id)===true,reworkNo:x.rework_no,status:x.status,problem:[x.problem_part,x.problem_description].filter(Boolean).join('：'),quantity:x.rework_quantity,wageItemCount:x.wage_items,...(summaries.has(x.rework_order_id)?{businessSummary:summaries.get(x.rework_order_id)!}:{})}))};});
  const quality=await garmentQuality(db,id);
  const washing=original.some(row=>row.bulk_washing_plan_id)?await readWashingCoverage(db,id):undefined;
  const now=new Date((await new ContextBusinessClock(this.database,db===this.database?undefined:db as PoolClient).read({kind:'order',id})).now);
  const washScopes=washing?.size?(await readBulkWashing(db,id,null,now.toISOString())).scopes:[];
  const physicalReworks=reworks.length?(await reworkSlaEvidence(db,id)).windows:[];
  for(const line of lines)line.packingReadiness=packingReadinessEvidence(line,quality,now.toISOString(),washing,washScopes,physicalReworks);
  const registered=new Set((await db.query("SELECT payload->>'receiptId' AS id FROM digital_production_task_events WHERE resource_kind='order' AND resource_id=$1 AND event_kind='garment_receipt_registered'",[id])).rows.map(r=>r.id));
  const outstanding:string[]=[];
  for(const line of lines){
   const coverage=packingQualityCoverage(line,quality,washing);line.effectivePackingQuantity=coverage.effectiveQuantity;
   if(line.packingQuantity!==null&&line.packingQuantity>0&&coverage.effectiveQuantity===null){
    const label=`${line.poNumber??'待补PO'} ${line.color}`;
    outstanding.push(coverage.totals&&coverage.totals.inspected>=line.actualQuantity
     ?`${label}：有效合格${coverage.totals.qualified}，不足以覆盖原装箱${line.packingQuantity}，交付数量待核对`
     :`${label}：有效到仓质检覆盖尚未齐，原装箱${line.packingQuantity}的交付数量待核对`);
   }
  }
  for(const q of quality)if(q.quantity>0&&registered.has(q.receiptId)&&!q.inspected)outstanding.push(`到仓批次${q.receiptId.slice(-6)}：${q.priorInspection?'数量已更正，原检查范围待核对':'到仓质检尚未完成'}`);
  for(const l of lines){const label=`${l.poNumber??'待补PO'} ${l.color}`;if(l.cutScope==='unresolved')outstanding.push(`${label}：原开裁范围尚不能唯一对应本PO，累计回货与装箱待核对`);if(l.actualQuantity<l.orderedQuantity)outstanding.push(`${label}：实收${l.actualQuantity}，订购${l.orderedQuantity}，未到足量`);if(!l.receiptCount)outstanding.push(`${label}：尚无原收货事实`);if(l.packingQuantity===null)outstanding.push(`${label}：装箱累计待核对`);else if(l.packingQuantity<l.orderedQuantity)outstanding.push(`${label}：装箱${l.packingQuantity}，少于订购${l.orderedQuantity}`);if(l.receiptCount&&l.actualQuantity!==l.documentQuantity&&!l.receivingResolution)outstanding.push(`${label}：原收货差异待处理`);if(l.packingQuantity!==null&&l.packingQuantity!==l.actualQuantity&&!l.packingResolution)outstanding.push(`${label}：原装箱差异待处理`);for(const r of l.reworks)if(!['completed','cancelled'].includes(r.status))outstanding.push(`${label}：原返工${r.reworkNo??r.reworkId}未完成`);if(l.defectiveQuantity>0&&!l.reworks.some(r=>r.status==='completed'))outstanding.push(`${label}：原次品${l.defectiveQuantity}，未见已完成返工依据`);}
  const pending=(await db.query(`SELECT t.task_id,t.node_key,t.state,(SELECT label FROM digital_production_deadline_policies WHERE node_key=t.node_key ORDER BY version DESC LIMIT 1) AS label FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind NOT IN ('bulk_ship_sample','factory_material_count') AND t.state NOT IN ('completed','cancelled') ORDER BY t.task_id`,[id])).rows;
  if((await db.query("SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind='factory_production_qc' AND t.state='completed'",[id])).rowCount&&!(await factoryProductionFacts(db,id)).complete)outstanding.push('工厂范围已变化，当前范围的QC检查尚未完成；原完成记录保留');
  for(const t of pending)outstanding.push(`待办 ${t.label}：${({pending:"未就绪",ready:"待办理",blocked:"阻断"} as Record<string,string>)[t.state]??"待核对"}`);
  const native=(await db.query("SELECT child_id FROM digital_production_child_links WHERE module='production' AND production_order_id=$1",[id])).rows[0];
  const closed=(await db.query('SELECT c.*,u.display_name FROM digital_order_closures c JOIN app_users u ON u.id=c.closed_by WHERE c.production_order_id=$1',[id])).rows[0];
  const revisionLines=lines.map(l=>({...l,reworks:l.reworks.map(r=>Object.fromEntries(Object.entries(r).filter(([key])=>key!=='canView'&&key!=='businessSummary')))}));
  const revision=hash({lines:revisionLines,quality,washing:washing?[...washing]:undefined,pending,productionId:native?.child_id??null,closed:closed?.source_revision??null});
  const roles=actor?.actorRoles??[];
  const collection=receivingSummary(lines),span=await receivingSpan(db,id,collection.expected,collection.received);
  const factoryDeliveries=native?factoryDeliveryReadings((await factoryProductionScopes(db,id,{includeZero:true})).map(row=>({productionId:row.production_order_id,factoryDecisionId:row.factory_decision_id??null,lineId:row.line_id,expected:Number(row.quantity),targetDate:row.target_date??null,commitments:original.find(line=>line.line_id===row.line_id)?.factory_date_history??[]})),receipts.map(row=>({id:row.receipt_id,productionId:row.factory_production_id??null,factoryDecisionId:row.factory_decision_id??null,lineId:row.line_id,quantity:Number(row.actual_quantity),...receiptTime(row.received_at,row.after_state)})),now.toISOString()):[];
  return {canVerifyQualityTime:Boolean(actor&&roles.includes('root_superuser')),factoryDeliveries,receivingForecast:await receivingForecast(db,id,collection.expected,collection.received,now),quality,canRecordQuality:Boolean(actor&&(roles.includes('root_superuser')||roles.includes('quality_control')&&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'quality_control'))),orderId:id,revision,productionId:native?.child_id??null,stage:closed?'特殊结案':lines.length>0&&lines.every(l=>l.packingRevisionId&&l.packingQuantity!==null&&l.packingQuantity>=l.orderedQuantity)&&outstanding.length===0?'本期装箱完成':'等待回货与装箱',lines,outstanding,canClose:Boolean(actor&&!closed&&native&&outstanding.length>0&&await this.canClose(db,actor)),canOpenReceiving:canOpenOrderReceiving(roles),canOpenRework:roles.some(r=>['root_superuser','owner_group','production_management','pmc','quality_control','order_merchandiser'].includes(r)),canOpenWages:Boolean(actor&&(roles.includes('root_superuser')||hasFinanceWageRole(roles)&&(actor.authorizationCapabilities??[]).includes('wage:view'))),closed:closed?{reason:closed.reason,outstanding:closed.outstanding,closedBy:closed.display_name,closedAt:new Date(closed.closed_at).toISOString()}:null,collection,receivingSpan:span,shipmentStatus:collection.shipmentStatus,customerReceiptStatus:'未知'};
 }
 async close(actor:TrustedActorContext,id:string,input:SpecialClosure,key:string){
  if(!input.reason.trim()||input.reason.length>2000)fail('特殊结案必须填写具体原因');if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');
  const db=await this.database.connect();try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");if(!await this.canClose(db,actor))digitalForbidden();await new DigitalProductionAccessPolicy(db).assert(actor,'order',id,'technical');
   const command=`closure:${id}`,payloadHash=hash(input),prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];if(prior){if(prior.payload_hash!==payloadHash)fail('操作标识已用于不同内容');await db.query('COMMIT');return prior.response as OrderClosureSheet;}
   // A rare, short finalization barrier: native writers use several unrelated locks.
   // SHARE blocks every insert/update/delete (including new reworks and wage links)
   // until the immutable snapshot commits, without changing native writer permissions.
   // Acquire before the mother-order lock; do not also take native style/cutting
   // locks, which writers may already hold while waiting to insert their facts.
   await db.query('LOCK TABLE receiving_batches, receiving_receipts, receiving_receipt_corrections, receiving_packing_revisions, receiving_difference_resolutions, rework_orders, rework_wage_items IN SHARE MODE');
   await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[id]);
   const sheet=await this.read(actor,id,db);if(!sheet.canClose)fail('尚未进入原生产、已经结案或已正常完成，无需特殊结案');if(sheet.revision!==input.expectedRevision)fail('实绩或未清事项已变化，请刷新核对后再结案');
   const audit=randomUUID();await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'digital.order.special_close','digital_production_order',$4,$5)",[audit,actor.requestId,actor.actorId,id,JSON.stringify({reason:input.reason,outstanding:sheet.outstanding,revision:sheet.revision})]);
   const closedAt=(await new ContextBusinessClock(this.database,db).read({kind:'order',id})).now;
   await db.query('INSERT INTO digital_order_closures(production_order_id,reason,outstanding,source_revision,closed_by,audit_event_id,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,input.reason,JSON.stringify(sheet.outstanding),sheet.revision,actor.actorId,audit,closedAt]);
   await new DigitalProductionTaskService(this.database).cancelForSpecialClosureWithClient(db,actor,id,input.reason);
   const response=await this.read(actor,id,db);await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,payloadHash,JSON.stringify(response)]);await db.query('COMMIT');return response;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
}
