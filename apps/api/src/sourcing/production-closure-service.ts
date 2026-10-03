import { productionNotExcluded, productionMerchandiserId } from "./production-visibility.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ProductionPilotInputSchema, ProductionPilotListSchema, ProductionExpectedReceiptsSchema, ProductionReceivingSummarySchema, TodoResponseSchema, type TodoResponse, type ProductionReceivingSummary } from "@dx-rework/contracts";
import { readProductionProgressFacts } from "./production-dashboard-service.js";
import { canReadProductionReporting, productionVisibility, productionVisibilityArgs } from "./production-reporting-service.js";
import { isRootActor } from "../access/business-authority.js";
import { memberCanReceiveFact } from "../access/member-module-policy.js";
import type { RootAuthority } from "../access/root-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
const caps=(actor:TrustedActorContext)=>actor.authorizationCapabilities??[actor.authorizationCapability];
function fail(message:string,status=403):never {throw new ApplicationError(status===404?"NOT_FOUND":status===400?"VALIDATION_ERROR":status===409?"INVALID_STATE_TRANSITION":"FORBIDDEN",message,status);};
const iso=(value:Date|string)=>new Date(value).toISOString();
export function isProductionRiskRecipient(actor:TrustedActorContext,createdBy:string,root=false) {
 return root||isRootActor(actor)||(caps(actor).includes("sourcing:view")&&caps(actor).includes("todo:view")&&
  (actor.actorRoles.some(r=>r==="owner_group"||r==="production_management")||(actor.actorRoles.includes("order_merchandiser")&&actor.actorId===createdBy)));
}
export function productionRiskKind(state:string):"behind"|"high_risk"|"stale"|null {
 return state==="behind"||state==="high_risk"||state==="stale"?state:null;
}
export class ProductionClosureService {
 constructor(private readonly database:Pool,private readonly root?:Pick<RootAuthority,"isRootUser">,private readonly clock?:()=>Date,private readonly events=new OperationEventRepository()) {}
 private async rootActor(actor:TrustedActorContext) {return isRootActor(actor)||await this.root?.isRootUser(actor.actorId)===true;}
 private warehouse(actor:TrustedActorContext){return isRootActor(actor)||(actor.actorRoles.includes("warehouse_receiver")&&caps(actor).includes("receiving:create"));}
 async pilots(actor:TrustedActorContext){
  if(!await this.rootActor(actor))fail("仅超级用户可设置生产试点");
  const result=await this.database.query<{supplier_id:string;supplier_name:string;enabled:boolean}>(`SELECT DISTINCT ON(production.supplier_id) production.supplier_id,
   production.supplier_name_snapshot AS supplier_name,COALESCE(pilot.enabled,false) AS enabled FROM sourcing_production_orders production
   LEFT JOIN sourcing_production_pilots pilot USING(supplier_id) WHERE ${productionNotExcluded} ORDER BY production.supplier_id,production.dispatched_at DESC,production.production_order_id`);
  return ProductionPilotListSchema.parse({suppliers:result.rows.map(r=>({supplierId:r.supplier_id,supplierName:r.supplier_name,enabled:r.enabled}))});
 }
 async setPilot(actor:TrustedActorContext,input:unknown){
  if(!await this.rootActor(actor))fail("仅超级用户可设置生产试点");
  const parsed=ProductionPilotInputSchema.safeParse(input);if(!parsed.success)fail("试点设置无效",400);
  const {supplierId,enabled}=parsed.data,client=await this.database.connect();
  try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext('production-closure'))");
   const supplier=await client.query("SELECT 1 FROM supplier_catalog_items WHERE supplier_id=$1",[supplierId]);if(!supplier.rows[0])fail("供应商不存在",404);
   const previous=await client.query<{enabled:boolean}>("SELECT enabled FROM sourcing_production_pilots WHERE supplier_id=$1",[supplierId]);
   if((previous.rows[0]?.enabled??false)!==enabled){
    const event=await this.events.append(client,actor,{action:"production.pilot.set",entityType:"supplier",entityId:supplierId,before:{enabled:previous.rows[0]?.enabled??false},after:{enabled}});
    await client.query(`INSERT INTO sourcing_production_pilots(supplier_id,enabled,operation_event_id) VALUES($1,$2,$3)
     ON CONFLICT(supplier_id) DO UPDATE SET enabled=excluded.enabled,operation_event_id=excluded.operation_event_id,updated_at=clock_timestamp()`,[supplierId,enabled,event]);
    if(!enabled)await client.query(`UPDATE sourcing_production_alerts SET resolved_at=clock_timestamp() WHERE resolved_at IS NULL AND production_order_id IN
     (SELECT production_order_id FROM sourcing_production_orders WHERE supplier_id=$1)`,[supplierId]);
   }
   await client.query("COMMIT");return {supplierId,enabled};
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
 }
 private async project(client:PoolClient,ids:string[],facts:Awaited<ReturnType<typeof readProductionProgressFacts>>) {
  for(const id of ids){const kind=productionRiskKind(facts.get(id)?.progressState??"");
   await client.query(`UPDATE sourcing_production_alerts SET resolved_at=clock_timestamp() WHERE production_order_id=$1 AND resolved_at IS NULL AND kind IS DISTINCT FROM $2`,[id,kind]);
   if(kind)await client.query(`INSERT INTO sourcing_production_alerts(alert_id,production_order_id,kind) VALUES($1,$2,$3)
    ON CONFLICT(production_order_id) WHERE resolved_at IS NULL DO NOTHING`,[randomUUID(),id,kind]);
  }
 }
 // Record report-driven recovery in the same transaction, even if nobody opens a todo between reports.
 async refreshOrder(client:PoolClient,id:string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('production-closure'))");
  const pilot=await client.query(`SELECT 1 FROM sourcing_production_orders production JOIN sourcing_production_pilots pilot USING(supplier_id)
   WHERE production_order_id=$1 AND ${productionNotExcluded} AND pilot.enabled=true`,[id]);
  const at=await client.query<{as_of:Date}>("SELECT clock_timestamp() AS as_of");
  const facts=await readProductionProgressFacts(client,pilot.rows[0]?[id]:[],at.rows[0]!.as_of.toISOString());
  await this.project(client,[id],facts);
 }
 // Refresh when the existing todo list/indicator is read. No new scheduler, push or escalation.
 // A single lock serializes projections; repeating observations creates no new episode.
 async todos(actor:TrustedActorContext):Promise<TodoResponse[]> {
  const root=await this.rootActor(actor);
  if(!isProductionRiskRecipient(actor,actor.actorId,root))return [];
  if(!await memberCanReceiveFact(this.database,actor.actorId,"sourcing.production.dispatch","production_order"))return [];
  const client=await this.database.connect();
  try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext('production-closure'))");
   const timestamp=await client.query<{as_of:Date}>("SELECT clock_timestamp() AS as_of"),asOf=(this.clock?.()??timestamp.rows[0]!.as_of).toISOString();
   const orders=await client.query<{production_order_id:string;created_by:string;operation_event_id:string;first_style_no:string;supplier_name_snapshot:string;merchandiser_name:string|null}>(`SELECT production.production_order_id,${productionMerchandiserId} AS created_by,production.operation_event_id,sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,production.supplier_name_snapshot,merchandiser.display_name merchandiser_name
    FROM sourcing_production_orders production JOIN sourcing_cases source_case USING(sourcing_case_id)
    LEFT JOIN app_users merchandiser ON merchandiser.id=${productionMerchandiserId}
    JOIN sourcing_production_pilots pilot ON pilot.supplier_id=production.supplier_id AND pilot.enabled=true WHERE ${productionNotExcluded}`);
   const facts=await readProductionProgressFacts(client,orders.rows.map(r=>r.production_order_id),asOf);
   await this.project(client,orders.rows.map(o=>o.production_order_id),facts);
   const alerts=await client.query<{alert_id:string;production_order_id:string;kind:string;opened_at:Date;read_at:Date|null}>(`SELECT alert.*,reading.read_at FROM sourcing_production_alerts alert
    LEFT JOIN sourcing_production_alert_reads reading ON reading.alert_id=alert.alert_id AND reading.user_id=$1
    WHERE alert.resolved_at IS NULL ORDER BY CASE alert.kind WHEN 'stale' THEN 0 WHEN 'high_risk' THEN 1 ELSE 2 END,alert.opened_at,alert.alert_id`,[actor.actorId]);
   const byId=new Map(orders.rows.map(o=>[o.production_order_id,o]));
   const result=alerts.rows.flatMap(a=>{const o=byId.get(a.production_order_id);if(!o||!isProductionRiskRecipient(actor,o.created_by,root))return [];
    const p=facts.get(o.production_order_id)!;
    return [TodoResponseSchema.parse({todoId:a.alert_id,todoType:"business_action",category:`production_${a.kind}`,sourceEventId:o.operation_event_id,
     sourceAction:"sourcing.production.dispatch",entityType:"production_order",entityId:o.production_order_id,recipientUserId:actor.actorId,
     requiredRole:null,requiredCapability:"sourcing:view",route:{routeName:"production_detail",entityId:o.production_order_id,todoId:a.alert_id},policyKey:null,dueAt:null,reminderCount:0,
     status:"pending",blockedReason:null,orderContext:{reworkNo:null,orderNo:null,styleNo:o.first_style_no,supplierName:o.supplier_name_snapshot,merchandiserName:o.merchandiser_name ?? null,status:a.kind,updatedAt:asOf},
     unread:a.read_at===null,productionProgress:p.productionProgress,daysWithoutUpdate:p.daysWithoutUpdate,
     version:1,createdAt:iso(a.opened_at),updatedAt:asOf})];});
   await client.query("COMMIT");return result;
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
 }
 async markRead(actor:TrustedActorContext,id:string){
  if(!z.string().uuid().safeParse(id).success)fail("待办编号无效",400);
  const todos=await this.todos(actor);if(!todos.some(t=>t.todoId===id))fail("待办已解除或不属于你",404);
  await this.database.query(`INSERT INTO sourcing_production_alert_reads(alert_id,user_id)
   SELECT alert_id,$2 FROM sourcing_production_alerts WHERE alert_id=$1 AND resolved_at IS NULL ON CONFLICT DO NOTHING`,[id,actor.actorId]);
  return {read:true};
 }
 async linkReceiptByCuttingOrder(client:PoolClient,actor:TrustedActorContext,input:{cuttingOrderId:string;receiptId:string;styleNo:string;operationEventId:string;receivedAt:string}) {
  if(!this.warehouse(actor))fail("仅仓管可关联实际收货");
  const matched=await client.query<{production_order_id:string;sourcing_line_position:number}>(`SELECT production.production_order_id,cutting.sourcing_line_position
   FROM cutting_orders cutting
   JOIN sourcing_production_orders production ON production.sourcing_case_id=cutting.sourcing_case_id
   JOIN sourcing_production_shipments shipment USING(production_order_id)
   JOIN sourcing_production_pilots pilot ON pilot.supplier_id=production.supplier_id AND pilot.enabled=true
   WHERE cutting.cutting_order_id=$1
     AND shipment.shipped_on <= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
     AND ${productionNotExcluded}
   ORDER BY shipment.shipped_on DESC,production.production_order_id
   LIMIT 1
   FOR SHARE OF pilot`,[input.cuttingOrderId,input.receivedAt]);
  const match=matched.rows[0];
  if(!match)return null;
  await this.linkReceipt(client,actor,{productionOrderId:match.production_order_id,receiptId:input.receiptId,styleNo:input.styleNo,
   operationEventId:input.operationEventId,receivedAt:input.receivedAt,sourcePosition:match.sourcing_line_position});
  return match.production_order_id;
 }
 async linkReceipt(client:PoolClient,actor:TrustedActorContext,input:{productionOrderId:string;receiptId:string;styleNo:string;operationEventId:string;receivedAt:string;sourcePosition?:number}){
  if(!this.warehouse(actor))fail("仅仓管可关联实际收货");
  if(!z.string().uuid().safeParse(input.productionOrderId).success)fail("生产订单编号无效",400);
  const result=await client.query<{style_matches:boolean;shipped_on:string}>(`SELECT EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=production.sourcing_case_id AND alias.position=COALESCE($3,1) AND upper(btrim(alias.style_no))=upper(btrim($2))) AS style_matches,shipment.shipped_on::text FROM sourcing_production_shipments shipment
   JOIN sourcing_production_orders production USING(production_order_id) JOIN sourcing_production_pilots pilot USING(supplier_id)
   WHERE shipment.production_order_id=$1 AND ${productionNotExcluded} AND pilot.enabled=true FOR SHARE OF pilot`,[input.productionOrderId,input.styleNo,input.sourcePosition??null]);
  const shipment=result.rows[0];
  if(!shipment)fail("该订单未发货或未启用试点",409);
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(input.receivedAt));
  if(!shipment.style_matches||day<shipment.shipped_on)fail("收货款号或日期与所选发货单不符",409);
  await client.query("INSERT INTO sourcing_production_receipt_links(receipt_id,production_order_id,operation_event_id) VALUES($1,$2,$3)",[input.receiptId,input.productionOrderId,input.operationEventId]);
 }
 private async receipts(ids:string[]):Promise<ProductionReceivingSummary[]> {
  const result=await this.database.query<{production_order_id:string;first_style_no:string;supplier_name_snapshot:string;contract_number:string;shipped_on:string;recorded_quantity:number}>(`SELECT shipment.*,sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,shipment.shipped_on::text,production.supplier_name_snapshot,
   sourcing_contract_display_number(production.sourcing_contract_document_id,production.contract_number) AS contract_number
   FROM sourcing_production_shipments shipment JOIN sourcing_production_orders production USING(production_order_id) WHERE production_order_id=ANY($1::uuid[])`,[ids]);
  const receipts=await this.database.query<{production_order_id:string;receipt_id:string;receiving_batch_id:string;actual_quantity:number;received_at:Date;archived:boolean}>(`SELECT link.production_order_id,receipt.receipt_id,receipt.receiving_batch_id,
   COALESCE(correction.actual_quantity,receipt.actual_quantity)::integer AS actual_quantity,receipt.received_at,batch.deleted_at IS NOT NULL AS archived
   FROM sourcing_production_receipt_links link JOIN receiving_receipts receipt USING(receipt_id) JOIN receiving_batches batch USING(receiving_batch_id)
   LEFT JOIN LATERAL (SELECT actual_quantity FROM receiving_receipt_corrections WHERE receipt_id=receipt.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1) correction ON true
   WHERE link.production_order_id=ANY($1::uuid[]) ORDER BY receipt.received_at,receipt.receipt_id`,[ids]);
  return result.rows.map(r=>ProductionReceivingSummarySchema.parse({productionOrderId:r.production_order_id,firstStyleNo:r.first_style_no,contractNumber:r.contract_number,supplierName:r.supplier_name_snapshot,
   shippedOn:r.shipped_on,expectedQuantity:r.recorded_quantity,receipts:receipts.rows.filter(x=>x.production_order_id===r.production_order_id).map(x=>({receiptId:x.receipt_id,receivingBatchId:x.receiving_batch_id,actualQuantity:x.actual_quantity,receivedAt:iso(x.received_at),archived:x.archived}))}));
 }
 async expected(actor:TrustedActorContext,input:{q?:string|undefined;page?:number|undefined}={}){
  if(!this.warehouse(actor))fail("仅仓管可查看预期回货");
  const q=input.q?.trim()??"",page=input.page??1;if(q.length>100||!Number.isInteger(page)||page<1||page>100000)fail("回货筛选无效",400);
  const where=`FROM sourcing_production_shipments shipment JOIN sourcing_production_orders production USING(production_order_id)
   JOIN sourcing_production_pilots pilot USING(supplier_id) WHERE pilot.enabled=true AND ${productionNotExcluded}
   AND ($1='' OR EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=production.sourcing_case_id AND alias.position=1 AND strpos(upper(alias.style_no),upper($1))>0) OR strpos(upper(production.supplier_name_snapshot),upper($1))>0)`;
  const count=await this.database.query<{count:string}>(`SELECT count(*) ${where}`,[q]);
  const rows=await this.database.query<{production_order_id:string}>(`SELECT shipment.production_order_id ${where} ORDER BY shipment.shipped_on DESC,shipment.production_order_id LIMIT 15 OFFSET $2`,[q,(page-1)*15]);
  const summaries=await this.receipts(rows.rows.map(r=>r.production_order_id));const byId=new Map(summaries.map(s=>[s.productionOrderId,s]));
  return ProductionExpectedReceiptsSchema.parse({items:rows.rows.map(r=>byId.get(r.production_order_id)),page,totalCount:Number(count.rows[0]?.count??0)});
 }
 async receiptSummary(actor:TrustedActorContext,id:string){
  if(!z.string().uuid().safeParse(id).success)fail("生产订单编号无效",400);
  if(!canReadProductionReporting(actor))fail("无权查看生产回货");
  const visible=await this.database.query(`SELECT 1 FROM sourcing_production_orders production JOIN sourcing_cases source_case USING(sourcing_case_id)
   WHERE ${productionVisibility} AND production.production_order_id=$5`,[...productionVisibilityArgs(actor),id]);
  if(!visible.rows[0])fail("订单不存在或不在负责范围内",404);
  return {shipment:(await this.receipts([id]))[0]??null};
 }
}
