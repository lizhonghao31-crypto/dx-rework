import {todoSlaTiming} from "../todos/sla-presentation.js";
import {ContextBusinessClock} from "../acceptance-clock/business-time.js";
import type {BusinessClock} from "@dx-rework/domain/business-clock";
import type {Pool,PoolClient} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {garmentSlaEvidence} from './garment-sla-evidence.js';
import {todoContentToken} from '../todos/content-reads.js';
export async function garmentQualityTodos(db:Pick<Pool|PoolClient,'query'>,actor:TrustedActorContext,clock:BusinessClock=new ContextBusinessClock(db as Pool)):Promise<TodoResponse[]>{
 const policy=new DigitalProductionAccessPolicy(db);
 if(!actor.actorRoles.includes('root_superuser')&&(!actor.actorRoles.includes('quality_control')||!await policy.activeRole(actor.actorId,'quality_control')))return [];
 const records=(await db.query(`SELECT e.event_id,e.recorded_at,e.resource_id AS order_id,e.payload->>'receiptId' AS receipt_id,o.design_style_no
 FROM digital_production_task_events e JOIN digital_production_orders o ON o.production_order_id=e.resource_id
 LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind='order' AND l.resource_id=o.production_order_id
 LEFT JOIN digital_production_resource_lifecycle sl ON sl.resource_kind='source' AND sl.resource_id=o.source_id
 WHERE e.resource_kind='order' AND e.event_kind='garment_receipt_registered' AND coalesce(l.state,'active')='active' AND coalesce(sl.state,'active')='active'
 AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id)`)).rows;
 const result:TodoResponse[]=[];
 for(const id of new Set(records.map(r=>r.order_id))){
  if(!await policy.allowed(actor,'order',id,'technical'))continue;
  const state=await garmentSlaEvidence(db,id),time=await clock.read({kind:"order",id});
  for(const row of records.filter(r=>r.order_id===id)){
   const receipt=state.quality.find(r=>r.receiptId===row.receipt_id);if(!receipt||receipt.inspected)continue;
   const window=state.windows.find(w=>w.receiptId===receipt.receiptId),at=new Date(row.recorded_at).toISOString();
   result.push({todoId:row.event_id,contentToken:todoContentToken(['garment-quality',receipt.receiptId,receipt.quantityVersion]),taskTitle:receipt.priorInspection?'核对更正后的到仓检查范围':'办理成衣到仓质检',todoType:'business_action',category:'digital_garment_quality',sourceEventId:row.event_id,sourceAction:'garment_receipt_registered',entityType:'digital_production',entityId:id,recipientUserId:actor.actorId,requiredRole:'quality_control',requiredCapability:null,route:{routeName:'digital_production_closure',entityId:id,todoId:row.event_id},policyKey:null,dueAt:window?.deadline??null,timing:todoSlaTiming({dueAt:window?.deadline??null,warningAt:window?.warningAt??null,enteredAt:window?.startedAt??null,asOf:time.now}),reminderCount:0,status:'pending',blockedReason:null,orderContext:{reworkNo:null,orderNo:null,styleNo:row.design_style_no,supplierName:null,status:receipt.receivedAt?`本批实收${receipt.quantity}件，待检查`:`本批实收${receipt.quantity}件，到仓仅有日期，精确时效未知`,updatedAt:at},unread:true,version:1,createdAt:at,updatedAt:at});
  }
 }
 return result;
}
