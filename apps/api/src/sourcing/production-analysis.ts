import {ProductionAnalysisResponseSchema, type ProductionAnalysisQuery, type SourcingProductionOrder} from "@dx-rework/contracts";
import type {PoolClient} from "pg";
import type {TrustedActorContext} from "../tools/repositories.js";
import {RECEIVING_ANALYSIS_LINKS_SQL} from "../receiving/receiving-analysis.js";

export function productionDueBucket(order: Pick<SourcingProductionOrder,"status"|"deliveryDate">, day: string): ProductionAnalysisQuery["dueBucket"] {
  if (order.status !== "in_production") return "closed";
  if (!order.deliveryDate) return "missing";
  if (order.deliveryDate < day) return "overdue";
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0,10);
  return order.deliveryDate <= end ? "soon" : "later";
}
export function selectProductionAnalysisOrders(orders: readonly SourcingProductionOrder[], filters: ProductionAnalysisQuery, day: string) {
  const needle = filters.q.toLocaleLowerCase();
  return orders.filter(order => (!filters.supplierId || order.supplierId === filters.supplierId)
    && (!filters.status || order.status === filters.status)
    && (!filters.dueFrom || !!order.deliveryDate && order.deliveryDate >= filters.dueFrom)
    && (!filters.dueTo || !!order.deliveryDate && order.deliveryDate <= filters.dueTo)
    && (filters.dueBucket === "all" || productionDueBucket(order,day) === filters.dueBucket)
    && (!needle || [order.supplierName,...order.lines.map(line=>line.styleNo)].some(value=>value.toLocaleLowerCase().includes(needle))))
    .sort((a,b)=>(a.deliveryDate??"9999").localeCompare(b.deliveryDate??"9999")||a.productionOrderId.localeCompare(b.productionOrderId));
}
export function mayReadProductionQuality(actor: TrustedActorContext) {
  return actor.actorRoles.includes("root_superuser") || (actor.authorizationCapabilities ?? [actor.authorizationCapability]).includes("dashboard:management:read");
}
const iso = (value: Date|string|null) => value === null ? null : new Date(value).toISOString();
type Receipt = {receipt_id:string;receiving_batch_id:string;production_order_id:string;actual_quantity:string;received_at:Date;correction_id:string|null;archived:boolean;excluded:boolean};
type Batch = {receiving_batch_id:string;unallocated:string;order_count:number;unlinked_count:number};
type Quality = {production_order_id:string;rework_order_id:string;rework_no:string|null;rework_quantity:string|null;status:string};
type Timing = {production_order_id:string;completed_on:string|null;completed_at:Date|null;shipped_on:string|null;shipped_at:Date|null;shipped_quantity:string|null};
type Alert = {production_order_id:string;alert_id:string;kind:"behind"|"high_risk"|"stale";opened_at:Date;resolved_at:Date|null;read_at:Date|null;next_report_at:Date|null;next_report_on:string|null};

// Caller supplies the complete order set after the existing production visibility predicate,
// under its authenticated repeatable-read transaction. No mutable approval/price rows are read.
export async function readProductionAnalysis(client: PoolClient, allVisibleOrders: readonly SourcingProductionOrder[], actor: TrustedActorContext, asOf: string, filters: ProductionAnalysisQuery) {
  const day = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(asOf));
  const orders = selectProductionAnalysisOrders(allVisibleOrders,filters,day), ids = orders.map(order=>order.productionOrderId);
  const linked = await client.query<Receipt>(`WITH links AS (${RECEIVING_ANALYSIS_LINKS_SQL}) SELECT * FROM links
    WHERE production_order_id=ANY($1::uuid[]) AND NOT excluded ORDER BY received_at,receipt_id`,[ids]);
  const receipts = linked.rows;
  const batches = await client.query<Batch>(`WITH links AS (${RECEIVING_ANALYSIS_LINKS_SQL}), selected_batches AS (
    SELECT DISTINCT receiving_batch_id FROM links WHERE production_order_id=ANY($1::uuid[]) AND NOT archived AND NOT excluded)
    SELECT batch.receiving_batch_id,
      (sum(receipt.actual_quantity)+batch.actual_quantity_adjustment-sum(links.actual_quantity))::text AS unallocated,
      count(DISTINCT links.production_order_id)::int AS order_count,
      count(*) FILTER(WHERE links.production_order_id IS NULL OR links.excluded)::int AS unlinked_count
    FROM selected_batches selected JOIN receiving_batches batch USING(receiving_batch_id)
    JOIN receiving_receipts receipt USING(receiving_batch_id) JOIN links USING(receipt_id)
    GROUP BY batch.receiving_batch_id,batch.actual_quantity_adjustment`,[ids]);
  const byBatch = new Map(batches.rows.map(batch=>[batch.receiving_batch_id,batch]));
  const timings = await client.query<Timing>(`SELECT production.production_order_id,completed.business_date::text AS completed_on,
    completed.created_at AS completed_at,shipment.shipped_on::text,shipment.created_at AS shipped_at,shipment.recorded_quantity::text AS shipped_quantity
    FROM sourcing_production_orders production
    LEFT JOIN LATERAL (SELECT max(business_date) AS business_date,max(created_at) AS created_at FROM sourcing_production_transitions
      WHERE production_order_id=production.production_order_id AND status='production_completed' AND sourcing_factory_order_status(production.production_order_id)<>'in_production') completed ON true
    LEFT JOIN LATERAL (SELECT sum(recorded_quantity) AS recorded_quantity,max(shipped_on) AS shipped_on,max(created_at) AS created_at FROM sourcing_production_shipments WHERE production_order_id=production.production_order_id) shipment ON true
    WHERE production.production_order_id=ANY($1::uuid[])`,[ids]);
  const byTiming = new Map(timings.rows.map(row=>[row.production_order_id,row]));
  const alertRows = await client.query<Alert>(`SELECT alert.production_order_id,alert.alert_id,alert.kind,alert.opened_at,alert.resolved_at,
    reading.read_at,next_report.created_at AS next_report_at,next_report.business_date::text AS next_report_on
    FROM sourcing_production_alerts alert
    LEFT JOIN sourcing_production_alert_reads reading ON reading.alert_id=alert.alert_id AND reading.user_id=$2
    LEFT JOIN LATERAL (SELECT report.created_at,report.business_date FROM sourcing_production_reports report
      WHERE report.production_order_id=alert.production_order_id AND report.created_at> alert.opened_at
      ORDER BY report.created_at,report.report_id LIMIT 1) next_report ON true
    WHERE alert.production_order_id=ANY($1::uuid[]) ORDER BY alert.opened_at,alert.alert_id`,[ids,actor.actorId]);
  const qualityAllowed = mayReadProductionQuality(actor);
  let qualityRows: Quality[] = [];
  if (qualityAllowed) {
    if (!actor.actorRoles.includes("root_superuser")) await client.query("SELECT access_authorized_actor_roles($1,$2)",[actor.actorId,"dashboard:management:read"]);
    const unambiguous = batches.rows.filter(batch=>batch.order_count===1 && batch.unlinked_count===0).map(batch=>batch.receiving_batch_id);
    const result = await client.query<Quality>(`SELECT DISTINCT link.production_order_id,rework.rework_order_id,rework.rework_no,
      rework.rework_quantity::text,rework.status
      FROM rework_orders rework JOIN receiving_receipts receipt ON receipt.receiving_batch_id=rework.source_receiving_batch_id
      JOIN sourcing_production_receipt_links link USING(receipt_id)
      WHERE rework.source_receiving_batch_id=ANY($1::uuid[]) AND link.production_order_id=ANY($2::uuid[])
        AND rework.status NOT IN ('draft','cancelled','deleted') ORDER BY rework.rework_order_id`,[unambiguous,ids]);
    qualityRows = result.rows;
  }
  const items = orders.map(order=>{
    const rows = receipts.filter(row=>row.production_order_id===order.productionOrderId), effective = rows.filter(row=>!row.archived);
    const batchIds = [...new Set(effective.map(row=>row.receiving_batch_id))];
    const unallocatedBatchCount = batchIds.filter(id=>BigInt(byBatch.get(id)?.unallocated??"0")!==0n).length;
    const timing = byTiming.get(order.productionOrderId);
    const receivedQuantity = effective.reduce((sum,row)=>sum+BigInt(row.actual_quantity),0n);
    const shippedQuantity = timing?.shipped_quantity??null;
    const remainingQuantity = order.status === "in_production" ? String(Math.max(0,order.quantity-order.completedQuantity)) : "0";
    const orderQuality = qualityRows.filter(row=>row.production_order_id===order.productionOrderId);
    return {order,dueBucket:productionDueBucket(order,day),remainingQuantity,
      completedOn:timing?.completed_on??null,completedRecordedAt:iso(timing?.completed_at??null),
      shippedOn:timing?.shipped_on??null,shipmentRecordedAt:iso(timing?.shipped_at??null),shippedQuantity,
      firstReceivedAt:iso(effective[0]?.received_at??null),receivedQuantity:receivedQuantity.toString(),
      receivingState:unallocatedBatchCount ? "unverified" as const : !effective.length ? "none" as const
        : shippedQuantity!==null && BigInt(shippedQuantity)>0n && receivedQuantity>=BigInt(shippedQuantity) ? "quantity_met" as const : "partial" as const,
      archivedReceiptCount:rows.length-effective.length,unallocatedBatchCount,
      receipts:rows.map(row=>({receiptId:row.receipt_id,receivingBatchId:row.receiving_batch_id,actualQuantity:String(row.actual_quantity),receivedAt:iso(row.received_at)!,correctionId:row.correction_id,archived:row.archived})),
      quality:qualityAllowed ? {reworkOrderCount:orderQuality.length,orders:orderQuality.map(row=>({reworkOrderId:row.rework_order_id,reworkNo:row.rework_no,quantity:row.rework_quantity,status:row.status})),
        ambiguousBatchCount:batchIds.filter(id=>{const batch=byBatch.get(id);return !!batch && (batch.order_count!==1 || batch.unlinked_count!==0);}).length} : null,
      alerts:alertRows.rows.filter(row=>row.production_order_id===order.productionOrderId).map(row=>({alertId:row.alert_id,kind:row.kind,firstObservedAt:iso(row.opened_at)!,closedAt:iso(row.resolved_at),readAt:iso(row.read_at),nextReportAt:iso(row.next_report_at),nextReportBusinessDate:row.next_report_on})),
    };
  });
  const groups = new Map<string,{supplierId:string;supplierName:string;orderCount:number;openCount:number;remainingQuantity:bigint;overdueCount:number}>();
  for (const item of [...items].sort((a,b)=>b.order.dispatchedAt.localeCompare(a.order.dispatchedAt))) {
    const group=groups.get(item.order.supplierId)??{supplierId:item.order.supplierId,supplierName:item.order.supplierName,orderCount:0,openCount:0,remainingQuantity:0n,overdueCount:0};
    group.orderCount++; if(item.order.status==="in_production")group.openCount++;group.remainingQuantity+=BigInt(item.remainingQuantity);if(item.dueBucket==="overdue")group.overdueCount++;groups.set(group.supplierId,group);
  }
  const sortedGroups=[...groups.values()].sort((a,b)=>a.remainingQuantity===b.remainingQuantity?a.supplierId.localeCompare(b.supplierId):a.remainingQuantity>b.remainingQuantity?-1:1);
  return ProductionAnalysisResponseSchema.parse({asOf,filters,
    summary:{totalCount:items.length,openCount:items.filter(item=>item.order.status==="in_production").length,
      remainingQuantity:items.reduce((sum,item)=>sum+BigInt(item.remainingQuantity),0n).toString(),
      overdueCount:items.filter(item=>item.dueBucket==="overdue").length,soonCount:items.filter(item=>item.dueBucket==="soon").length,missingDueCount:items.filter(item=>item.dueBucket==="missing").length,
      ordersWithoutReceipts:items.filter(item=>!item.firstReceivedAt).length,ordersWithUnallocatedAdjustments:items.filter(item=>item.unallocatedBatchCount>0).length,
      alertCount:alertRows.rows.length,qualityOrderCount:qualityAllowed?new Set(qualityRows.map(row=>row.rework_order_id)).size:null},
    groupTotal:groups.size,groups:sortedGroups.slice((filters.groupPage-1)*15,filters.groupPage*15).map(group=>({...group,remainingQuantity:group.remainingQuantity.toString()})),
    items:items.slice((filters.page-1)*15,filters.page*15)});
}
