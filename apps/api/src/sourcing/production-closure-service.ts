import type {TodoSelection,TodoSelectionKey} from '../todos/selection.js';
import {todoContentToken} from '../todos/content-reads.js';
import { hasWarehouseReceivingRole } from "@dx-rework/contracts";
import { productionNotExcluded, productionMerchandiserId } from "./production-visibility.js";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ProductionPilotInputSchema, ProductionPilotListSchema, ProductionExpectedReceiptsSchema, ProductionReceivingSummarySchema, TodoResponseSchema, type TodoResponse, type ProductionReceivingSummary } from "@dx-rework/contracts";
import { readFactoryProductionProgressFacts } from "./production-dashboard-service.js";
import { productionProgressRank, type calculateProductionProgress } from "@dx-rework/domain";
import { canReadProductionReporting, productionVisibility, productionVisibilityArgs } from "./production-reporting-service.js";
import { isRootActor } from "../access/business-authority.js";
import { memberCanReceiveFact } from "../access/member-module-policy.js";
import type { RootAuthority } from "../access/root-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
const caps=(actor:TrustedActorContext)=>actor.authorizationCapabilities??[actor.authorizationCapability];
function fail(message:string,status=403):never {throw new ApplicationError(status===404?"NOT_FOUND":status===400?"VALIDATION_ERROR":status===409?"INVALID_STATE_TRANSITION":"FORBIDDEN",message,status);};
const iso=(value:Date|string)=>new Date(value).toISOString();
type PilotOrderRow={production_order_id:string;factory_decision_id:string|null;created_by:string;operation_event_id:string;first_style_no:string;supplier_name_snapshot:string;merchandiser_name:string|null};
export function isProductionRiskRecipient(actor:TrustedActorContext,createdBy:string,root=false) {
 return root||isRootActor(actor)||(caps(actor).includes("sourcing:view")&&caps(actor).includes("todo:view")&&
  (actor.actorRoles.some(r=>r==="owner_group"||r==="production_management")||(actor.actorRoles.includes("order_merchandiser")&&actor.actorId===createdBy)));
}
/** QC freshness has its own48/72 routing; quantity alerts rank the remaining quantity risk. */
export const productionAlertState=(fact:{progressState:string;quantityRiskState?:string}|undefined)=>fact?.quantityRiskState??fact?.progressState??'';
export const productionAlertRank=(fact:{progressState:Parameters<typeof productionProgressRank>[0];quantityRiskState?:Parameters<typeof productionProgressRank>[0]})=>productionProgressRank(fact.quantityRiskState??fact.progressState);
export function productionRiskKind(state:string):"behind"|"high_risk"|"stale"|null {
 return state==="behind"||state==="high_risk"||state==="stale"?state:null;
}
export class ProductionClosureService {
 constructor(private readonly database:Pool,private readonly root?:Pick<RootAuthority,"isRootUser">,private readonly clock?:()=>Date,private readonly events=new OperationEventRepository()) {}
 private async rootActor(actor:TrustedActorContext) {return isRootActor(actor)||await this.root?.isRootUser(actor.actorId)===true;}
 private warehouse(actor:TrustedActorContext){return isRootActor(actor)||(hasWarehouseReceivingRole(actor.actorRoles)&&caps(actor).includes("receiving:create"));}
 async pilots(actor:TrustedActorContext){
  if(!await this.rootActor(actor))fail("仅超级用户可设置生产风险提醒");
  const result=await this.database.query<{supplier_id:string;supplier_name:string;enabled:boolean}>(`SELECT DISTINCT ON(production.supplier_id) production.supplier_id,
   production.supplier_name_snapshot AS supplier_name,COALESCE(pilot.enabled,false) AS enabled FROM sourcing_production_factory_orders production
   LEFT JOIN sourcing_production_pilots pilot USING(supplier_id) WHERE ${productionNotExcluded} ORDER BY production.supplier_id,production.dispatched_at DESC,production.production_order_id`);
  return ProductionPilotListSchema.parse({suppliers:result.rows.map(r=>({supplierId:r.supplier_id,supplierName:r.supplier_name,enabled:r.enabled}))});
 }
 async setPilot(actor:TrustedActorContext,input:unknown){
  if(!await this.rootActor(actor))fail("仅超级用户可设置生产风险提醒");
  const parsed=ProductionPilotInputSchema.safeParse(input);if(!parsed.success)fail("生产风险提醒设置无效",400);
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
 private async pilotFacts(client:PoolClient,ids:string[]|null,asOf:string) {
  const result=await client.query<PilotOrderRow>(`SELECT production.production_order_id,production.factory_decision_id,${productionMerchandiserId} AS created_by,
   dispatch.operation_event_id,sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,production.supplier_name_snapshot,merchandiser.display_name AS merchandiser_name
   FROM sourcing_production_factory_orders production JOIN sourcing_production_orders dispatch ON dispatch.production_order_id=production.production_order_id
   JOIN sourcing_cases source_case ON source_case.sourcing_case_id=production.sourcing_case_id
   LEFT JOIN app_users merchandiser ON merchandiser.id=${productionMerchandiserId}
   JOIN sourcing_production_pilots pilot ON pilot.supplier_id=production.supplier_id AND pilot.enabled=true
   WHERE ${productionNotExcluded} AND ($1::uuid[] IS NULL OR production.production_order_id=ANY($1))
   ORDER BY production.production_order_id,production.dispatched_at,production.factory_decision_id NULLS FIRST`,[ids]);
  const selectedIds=[...new Set(result.rows.map(order=>order.production_order_id))];
  const executions=await readFactoryProductionProgressFacts(client,selectedIds,asOf);
  const orders=new Map<string,PilotOrderRow>(),facts=new Map<string,ReturnType<typeof calculateProductionProgress>>();
  // Preserve one order-level alert; only enabled actual factories contribute, with the existing risk priority.
  for(const order of result.rows){
   const key=order.factory_decision_id?`${order.production_order_id}:${order.factory_decision_id}`:order.production_order_id;
   const current=executions.get(key),previous=facts.get(order.production_order_id);
   if(!current||(previous&&productionAlertRank(previous)<=productionAlertRank(current)))continue;
   orders.set(order.production_order_id,order);facts.set(order.production_order_id,current);
  }
  return {orders,facts,ids:selectedIds};
 }
 private async project(client:PoolClient,ids:string[],facts:Awaited<ReturnType<typeof readFactoryProductionProgressFacts>>) {
  if(!ids.length)return;
  const kinds=ids.map(id=>productionRiskKind(productionAlertState(facts.get(id))));
  await client.query(`UPDATE sourcing_production_alerts alert SET resolved_at=clock_timestamp()
   FROM unnest($1::uuid[],$2::text[]) AS observed(order_id,kind)
   WHERE alert.production_order_id=observed.order_id AND alert.resolved_at IS NULL
     AND alert.kind IS DISTINCT FROM observed.kind`,[ids,kinds]);

  const opening=ids.flatMap((id,index)=>{const kind=kinds[index];return kind?[{alertId:randomUUID(),id,kind}]:[];});
  if(!opening.length)return;
  // Keep this separate from resolution so the partial index observes a closed episode.
  await client.query(`INSERT INTO sourcing_production_alerts(alert_id,production_order_id,kind)
   SELECT alert_id,order_id,kind FROM unnest($1::uuid[],$2::uuid[],$3::text[]) AS observed(alert_id,order_id,kind)
   ON CONFLICT(production_order_id) WHERE resolved_at IS NULL DO NOTHING`,
   [opening.map(row=>row.alertId),opening.map(row=>row.id),opening.map(row=>row.kind)]);
 }
 // Record report-driven recovery in the same transaction, even if nobody opens a todo between reports.
 async refreshOrder(client:PoolClient,id:string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('production-closure'))");
  const at=await client.query<{as_of:Date}>("SELECT clock_timestamp() AS as_of");
  const {facts}=await this.pilotFacts(client,[id],at.rows[0]!.as_of.toISOString());
  await this.project(client,[id],facts);
 }
 // Refresh when the existing todo list/indicator is read. No new scheduler, push or escalation.
 // A single lock serializes projections; repeating observations creates no new episode.
 async todos(actor:TrustedActorContext):Promise<TodoResponse[]> {return (await this.readTodos(actor)).todos;}
 async todoSelections(actor:TrustedActorContext){return (await this.readTodos(actor,{selection:true})).selections;}
 async todoCounts(actor:TrustedActorContext){const result=await this.readTodos(actor,{details:false});return {totalCount:result.totalCount,unreadCount:result.unreadCount,pendingCount:result.unreadCount};}
 async todoPage(actor:TrustedActorContext,page:number){return this.readTodos(actor,{page});}
 async todo(actor:TrustedActorContext,id:string){if(!z.string().uuid().safeParse(id).success)return null;return (await this.readTodos(actor,{todoId:id})).todos[0]??null;}
 private async readTodos(actor:TrustedActorContext,options:{details?:boolean;page?:number;todoId?:string;selection?:boolean}={}) {
  const root=await this.rootActor(actor);
  if(!isProductionRiskRecipient(actor,actor.actorId,root))return {todos:[] as TodoResponse[],selections:[] as TodoSelection[],totalCount:0,unreadCount:0,page:1,totalPages:0};
  if(!await memberCanReceiveFact(this.database,actor.actorId,"sourcing.production.dispatch","production_order"))return {todos:[] as TodoResponse[],selections:[] as TodoSelection[],totalCount:0,unreadCount:0,page:1,totalPages:0};
  const client=await this.database.connect();
  try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext('production-closure'))");
   const timestamp=await client.query<{as_of:Date}>("SELECT clock_timestamp() AS as_of"),asOf=(this.clock?.()??timestamp.rows[0]!.as_of).toISOString();
   const target=options.todoId?(await client.query<{production_order_id:string}>('SELECT production_order_id FROM sourcing_production_alerts WHERE alert_id=$1',[options.todoId])).rows.map(row=>row.production_order_id):null;
   const {orders:byId,facts,ids}=await this.pilotFacts(client,target,asOf);
   await this.project(client,ids,facts);
   const alerts=await client.query<{alert_id:string;production_order_id:string;kind:string;opened_at:Date;read_at:Date|null}>(`SELECT alert.*,reading.read_at FROM sourcing_production_alerts alert
    LEFT JOIN sourcing_production_alert_reads reading ON reading.alert_id=alert.alert_id AND reading.user_id=$1
    WHERE alert.resolved_at IS NULL AND ($2::uuid IS NULL OR alert.alert_id=$2) ORDER BY CASE alert.kind WHEN 'stale' THEN 0 WHEN 'high_risk' THEN 1 ELSE 2 END,alert.opened_at,alert.alert_id`,[actor.actorId,options.todoId??null]);
   const visible=alerts.rows.filter(a=>{const order=byId.get(a.production_order_id);return order&&isProductionRiskRecipient(actor,order.created_by,root);});
   const totalCount=visible.length,unreadCount=visible.filter(a=>a.read_at===null).length,totalPages=Math.ceil(totalCount/15),page=totalPages?Math.min(options.page??1,totalPages):1;
   const selections:TodoSelection[]=options.details===false?[]:visible.map(a=>{const o=byId.get(a.production_order_id)!,p=facts.get(a.production_order_id)!;const key:TodoSelectionKey={todoId:a.alert_id,todoType:"business_action",category:`production_${a.kind}`,sourceAction:"sourcing.production.dispatch",recipientUserId:actor.actorId,route:{routeName:"production_detail",entityId:o.production_order_id,todoId:a.alert_id,...(o.factory_decision_id?{factoryDecisionId:o.factory_decision_id}:{})},dueAt:null,status:"pending",orderContext:{reworkNo:null,orderNo:null,styleNo:o.first_style_no,supplierName:o.supplier_name_snapshot,merchandiserName:o.merchandiser_name ?? null,status:a.kind,updatedAt:asOf},contentToken:todoContentToken(['production-risk',a.alert_id,a.production_order_id,a.kind,iso(a.opened_at)]),readAt:a.read_at?iso(a.read_at):null,unread:a.read_at===null,daysWithoutUpdate:p.daysWithoutUpdate,createdAt:iso(a.opened_at)};return {key,load:async()=>TodoResponseSchema.parse({...key,sourceEventId:o.operation_event_id,entityType:"production_order",entityId:o.production_order_id,requiredRole:null,requiredCapability:"sourcing:view",policyKey:null,reminderCount:0,blockedReason:null,productionProgress:p.productionProgress,version:1,updatedAt:asOf})};});
   const selected=options.selection?[]:options.page===undefined?selections:selections.slice((page-1)*15,page*15),result:TodoResponse[]=[];for(const item of selected)result.push(await item.load());
   await client.query("COMMIT");return {todos:result,selections,totalCount,unreadCount,page,totalPages};
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
 }
 async markRead(actor:TrustedActorContext,id:string){
  if(!z.string().uuid().safeParse(id).success)fail("待办编号无效",400);
  if(!await this.todo(actor,id))fail("待办已解除或不属于你",404);
  await this.database.query(`INSERT INTO sourcing_production_alert_reads(alert_id,user_id)
   SELECT alert_id,$2 FROM sourcing_production_alerts WHERE alert_id=$1 AND resolved_at IS NULL ON CONFLICT DO NOTHING`,[id,actor.actorId]);
  return {read:true};
 }
 async linkReceiptByCuttingOrder(client:PoolClient,actor:TrustedActorContext,input:{cuttingOrderId:string;receiptId:string;styleNo:string;operationEventId:string;receivedAt:string;productionOrderId?:string;factoryDecisionId?:string|null}) {
  if(!this.warehouse(actor))fail("仅仓管可关联实际收货");
  const matched=await client.query<{production_order_id:string;factory_decision_id:string|null;sourcing_line_position:number}>(`SELECT production.production_order_id,production.factory_decision_id,cutting.sourcing_line_position
   FROM cutting_orders cutting JOIN sourcing_production_factory_orders production ON production.sourcing_case_id=cutting.sourcing_case_id
   JOIN sourcing_production_shipments shipment ON shipment.production_order_id=production.production_order_id AND shipment.factory_decision_id IS NOT DISTINCT FROM production.factory_decision_id
   WHERE cutting.cutting_order_id=$1 AND shipment.shipped_on<=($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
    AND ($3::uuid IS NULL OR production.production_order_id=$3) AND (NOT $4::boolean OR production.factory_decision_id IS NOT DISTINCT FROM $5::uuid)
    AND EXISTS(SELECT 1 FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation WHERE allocation.position=cutting.sourcing_line_position AND allocation.quantity>0)
    AND ${productionNotExcluded} ORDER BY shipment.shipped_on DESC,production.production_order_id LIMIT 2 FOR SHARE OF shipment`,
   [input.cuttingOrderId,input.receivedAt,input.productionOrderId??null,input.factoryDecisionId!==undefined,input.factoryDecisionId??null]);
  if(matched.rows.length>1)fail("该裁剪单有多个工厂发货，请选择本次到货工厂",409);
  const match=matched.rows[0];if(match?.factory_decision_id&&input.factoryDecisionId===undefined)fail("请明确选择本次到货加工厂",409);if(!match){if(input.productionOrderId||input.factoryDecisionId!==undefined)fail("所选工厂尚未发货或与该裁剪单不符",409);return null;}
  await this.linkReceipt(client,actor,{productionOrderId:match.production_order_id,factoryDecisionId:match.factory_decision_id,receiptId:input.receiptId,styleNo:input.styleNo,operationEventId:input.operationEventId,receivedAt:input.receivedAt,sourcePosition:match.sourcing_line_position});
  return match.production_order_id;
 }
 async linkReceipt(client:PoolClient,actor:TrustedActorContext,input:{productionOrderId:string;factoryDecisionId?:string|null;receiptId:string;styleNo:string;operationEventId:string;receivedAt:string;sourcePosition?:number}){
  if(!this.warehouse(actor))fail("仅仓管可关联实际收货");
  if(!z.string().uuid().safeParse(input.productionOrderId).success)fail("生产订单编号无效",400);
  const result=await client.query<{style_matches:boolean;shipped_on:string}>(`SELECT EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=production.sourcing_case_id AND alias.position=COALESCE($3,1) AND upper(btrim(alias.style_no))=upper(btrim($2))) AS style_matches,shipment.shipped_on::text
   FROM sourcing_production_shipments shipment JOIN sourcing_production_factory_orders production ON production.production_order_id=shipment.production_order_id AND production.factory_decision_id IS NOT DISTINCT FROM shipment.factory_decision_id
   WHERE shipment.production_order_id=$1 AND shipment.factory_decision_id IS NOT DISTINCT FROM $4::uuid AND ${productionNotExcluded}
   AND EXISTS(SELECT 1 FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation WHERE allocation.position=COALESCE($3,1) AND allocation.quantity>0) FOR SHARE OF shipment`,
   [input.productionOrderId,input.styleNo,input.sourcePosition??null,input.factoryDecisionId??null]);
  const shipment=result.rows[0];if(!shipment)fail("该工厂尚未有效发货",409);
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(input.receivedAt));
  if(!shipment.style_matches||day<shipment.shipped_on)fail("收货款号或日期与所选发货单不符",409);
  await client.query("INSERT INTO sourcing_production_receipt_links(receipt_id,production_order_id,operation_event_id,factory_decision_id) VALUES($1,$2,$3,$4)",[input.receiptId,input.productionOrderId,input.operationEventId,input.factoryDecisionId??null]);
 }
 private async receipts(ids:string[]):Promise<ProductionReceivingSummary[]> {
  const result=await this.database.query<{production_order_id:string;first_style_no:string;supplier_name_snapshot:string;contract_number:string;shipped_on:string;recorded_quantity:number;factory_decision_id:string|null;cutting_order_ids:string[]}>(`SELECT shipment.*,sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,shipment.shipped_on::text,production.supplier_name_snapshot,
   sourcing_contract_display_number(production.sourcing_contract_document_id,production.contract_number) AS contract_number,
   ARRAY(SELECT cutting.cutting_order_id FROM cutting_orders cutting JOIN sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation ON allocation.position=cutting.sourcing_line_position AND allocation.quantity>0 WHERE cutting.sourcing_case_id=production.sourcing_case_id) AS cutting_order_ids
   FROM sourcing_production_shipments shipment JOIN sourcing_production_factory_orders production ON production.production_order_id=shipment.production_order_id AND production.factory_decision_id IS NOT DISTINCT FROM shipment.factory_decision_id WHERE shipment.production_order_id=ANY($1::uuid[])`,[ids]);
  const receipts=await this.database.query<{production_order_id:string;receipt_id:string;receiving_batch_id:string;actual_quantity:number;received_at:Date;archived:boolean;factory_decision_id:string|null}>(`SELECT link.production_order_id,link.factory_decision_id,receipt.receipt_id,receipt.receiving_batch_id,
   COALESCE(correction.actual_quantity,receipt.actual_quantity)::integer AS actual_quantity,receipt.received_at,batch.deleted_at IS NOT NULL AS archived
   FROM sourcing_production_receipt_links link JOIN receiving_receipts receipt USING(receipt_id) JOIN receiving_batches batch USING(receiving_batch_id)
   LEFT JOIN LATERAL (SELECT actual_quantity FROM receiving_receipt_corrections WHERE receipt_id=receipt.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1) correction ON true
   WHERE link.production_order_id=ANY($1::uuid[]) ORDER BY receipt.received_at,receipt.receipt_id`,[ids]);
  return result.rows.map(r=>ProductionReceivingSummarySchema.parse({productionOrderId:r.production_order_id,factoryDecisionId:r.factory_decision_id,cuttingOrderIds:r.cutting_order_ids,firstStyleNo:r.first_style_no,contractNumber:r.contract_number,supplierName:r.supplier_name_snapshot,
   shippedOn:r.shipped_on,expectedQuantity:r.recorded_quantity,receipts:receipts.rows.filter(x=>x.production_order_id===r.production_order_id&&x.factory_decision_id===r.factory_decision_id).map(x=>({receiptId:x.receipt_id,receivingBatchId:x.receiving_batch_id,actualQuantity:x.actual_quantity,receivedAt:iso(x.received_at),archived:x.archived}))}));
 }
 async expected(actor:TrustedActorContext,input:{q?:string|undefined;page?:number|undefined;cuttingOrderId?:string|undefined}={}){
  if(!this.warehouse(actor))fail("仅仓管可查看预期回货");
  const q=input.q?.trim()??"",page=input.page??1;if(q.length>100||!Number.isInteger(page)||page<1||page>100000)fail("回货筛选无效",400);
  if(input.cuttingOrderId&&!z.string().uuid().safeParse(input.cuttingOrderId).success)fail("裁剪单编号无效",400);
  const where=`FROM sourcing_production_shipments shipment JOIN sourcing_production_factory_orders production ON production.production_order_id=shipment.production_order_id AND production.factory_decision_id IS NOT DISTINCT FROM shipment.factory_decision_id
   WHERE ${productionNotExcluded}
   AND ($1='' OR EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=production.sourcing_case_id AND alias.position=1 AND strpos(upper(alias.style_no),upper($1))>0) OR strpos(upper(production.supplier_name_snapshot),upper($1))>0)
   AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM cutting_orders cutting JOIN sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation ON allocation.position=cutting.sourcing_line_position AND allocation.quantity>0
     WHERE cutting.cutting_order_id=$2 AND cutting.sourcing_case_id=production.sourcing_case_id))`;
  const count=await this.database.query<{count:string}>(`SELECT count(*) ${where}`,[q,input.cuttingOrderId??null]);
  const rows=await this.database.query<{production_order_id:string;factory_decision_id:string|null}>(`SELECT shipment.production_order_id,shipment.factory_decision_id ${where} ORDER BY shipment.shipped_on DESC,shipment.production_order_id,shipment.factory_execution_key LIMIT 15 OFFSET $3`,[q,input.cuttingOrderId??null,(page-1)*15]);
  const summaries=await this.receipts(rows.rows.map(r=>r.production_order_id));const byId=new Map(summaries.map(s=>[s.productionOrderId+":"+(s.factoryDecisionId??"original"),s]));
  return ProductionExpectedReceiptsSchema.parse({items:rows.rows.map(r=>byId.get(r.production_order_id+":"+(r.factory_decision_id??"original"))),page,totalCount:Number(count.rows[0]?.count??0)});
 }
 async receiptSummary(actor:TrustedActorContext,id:string,factoryDecisionId:string|null=null){
  if(!z.string().uuid().safeParse(id).success)fail("生产订单编号无效",400);
  if(factoryDecisionId!==null&&!z.string().uuid().safeParse(factoryDecisionId).success)fail("分厂标识无效",400);
  if(!canReadProductionReporting(actor))fail("无权查看生产回货");
  const visible=await this.database.query(`SELECT 1 FROM sourcing_production_factory_orders production JOIN sourcing_cases source_case USING(sourcing_case_id)
   WHERE ${productionVisibility.replace("sourcing_production_reporter_allowed($3,production.production_order_id)","sourcing_production_factory_reporter_allowed($3,production.production_order_id,production.factory_decision_id)")} AND production.production_order_id=$5 AND production.factory_decision_id IS NOT DISTINCT FROM $6::uuid`,[...productionVisibilityArgs(actor),id,factoryDecisionId]);
  if(!visible.rows[0])fail("订单不存在或不在负责范围内",404);
  return {shipment:(await this.receipts([id])).find(s=>s.factoryDecisionId===factoryDecisionId)??null};
 }
}
