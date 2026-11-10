import {NATIVE_CUT_SCOPE_ROWS_SQL,NATIVE_EMPTY_PACKING_SCOPE_SQL} from './journey-cut-scopes.js';
import type {PoolClient} from 'pg';
import type {DeliveryCalendarFilters,DeliverySummary} from '@dx-rework/contracts/delivery-calendar';
import {RECEIVING_GROUP_PACKING_JOIN_SQL,DIGITAL_RECEIVING_BASE_SQL} from '../receiving/receiving-quantity-query.js';

export type DeliveryDebtSummary={overdue:DeliverySummary;beforeSelected:DeliverySummary;quantityUnknownPoCount:number};
const empty=():DeliverySummary=>({poCount:0,orderedQty:0,packedQty:0,pendingQty:0,extraQty:0,knownOrderedQty:0,comparableOrderedQty:0,knownPackedQty:0,knownPendingQty:0,knownExtraQty:0,unknownQuantityPoCount:0,missingDuePoCount:0,overduePoCount:0,overduePendingQty:0});
/** Two scalar counters over already-authorized mothers, in the caller's same
 * repeatable-read transaction. No PO/history/photo/SLA-plan payload is loaded.
 * Original native receiving and cumulative packing grouping stays authoritative.
 */
export async function deliveryDebtSummary(db:PoolClient,orderIds:readonly string[],filters:DeliveryCalendarFilters,today:string,selectedDate:string,sourcingAllowed:boolean):Promise<DeliveryDebtSummary>{
 if(!orderIds.length)return {overdue:empty(),beforeSelected:empty(),quantityUnknownPoCount:0};
 const cutIds=(await db.query<{ids:string[]|null}>(`SELECT array_agg(DISTINCT map.child_id) AS ids FROM digital_production_child_lines map
  JOIN digital_production_po_lines p USING(production_order_id,line_id) WHERE map.module='cutting' AND map.production_order_id=ANY($1::uuid[])
  AND p.customer_warehouse_arrival_date<greatest($2::date,$3::date)`,[orderIds,today,selectedDate])).rows[0]?.ids??[];
 const rows=(await db.query<{bucket:string;po_count:string;ordered:string|null;packed:string|null;pending:string|null}>(`${DIGITAL_RECEIVING_BASE_SQL}, calendar_po AS (
  SELECT p.line_id,p.customer_warehouse_arrival_date AS due,
   (SELECT sum(size.quantity) FROM digital_production_po_sizes size WHERE size.line_id=p.line_id) AS demand,
   CASE WHEN cutting.verified OR (${NATIVE_EMPTY_PACKING_SCOPE_SQL}) THEN CASE WHEN packed.packing_revision_id IS NULL THEN 0 ELSE packed.packing_quantity END ELSE NULL END AS packed,
   CASE WHEN reminder.value->>'kind'='offset' AND jsonb_typeof(reminder.value->'days')='number' THEN
    CASE WHEN (reminder.value->>'days')::numeric BETWEEN 0 AND 365 AND trunc((reminder.value->>'days')::numeric)=(reminder.value->>'days')::numeric
     THEN (reminder.value->>'days')::numeric::integer ELSE NULL END ELSE NULL END AS reminder_days,
   EXISTS(SELECT 1 FROM digital_production_resource_lifecycle life WHERE ((life.resource_kind='order' AND life.resource_id=o.production_order_id) OR (life.resource_kind='source' AND life.resource_id=o.source_id)) AND life.state='cancelled')
    OR EXISTS(SELECT 1 FROM digital_order_closures closed WHERE closed.production_order_id=o.production_order_id) AS excluded
  FROM digital_production_po_lines p JOIN digital_production_orders o USING(production_order_id)
  LEFT JOIN LATERAL(SELECT array_agg(DISTINCT scope.child_id) FILTER(WHERE scope.child_id IS NOT NULL) AS ids,count(scope.child_id)=1 AND count(*)=1 AND bool_and(coalesce(scope.source_line_id=p.line_id,false)) AS verified FROM (${NATIVE_CUT_SCOPE_ROWS_SQL} WHERE po.line_id=p.line_id) scope) cutting ON true
  LEFT JOIN LATERAL(SELECT packing.packing_quantity,packing.packing_revision_id FROM (SELECT 'cut:'||cutting.ids[1]::text AS group_key) totals
   ${RECEIVING_GROUP_PACKING_JOIN_SQL}
   WHERE cardinality(cutting.ids)=1) packed ON true
  LEFT JOIN LATERAL(SELECT snapshot.parameters_json->'order_shipping_reminder'->'value' AS value FROM digital_sla_order_snapshots snapshot WHERE snapshot.production_order_id=p.production_order_id ORDER BY snapshot.revision DESC LIMIT 1) reminder ON true
  LEFT JOIN LATERAL(SELECT btrim(source.erp_order_no) AS value FROM digital_production_child_links link JOIN sourcing_cases source ON source.sourcing_case_id=link.child_id
   JOIN current_sourcing_cases current ON current.sourcing_case_id=source.sourcing_case_id WHERE $12::boolean AND link.module='sourcing' AND link.production_order_id=o.production_order_id AND source.deleted_at IS NULL
   AND btrim(source.erp_order_no)<>'' AND btrim(source.erp_order_no)!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   ORDER BY link.child_id LIMIT 1) business_no ON true
  WHERE o.production_order_id=ANY($5::uuid[]) AND p.customer_warehouse_arrival_date<greatest($6::date,$7::date)
   AND ($9::text IS NULL OR o.customer_code=$9)
   AND ($8='' OR EXISTS(SELECT 1 FROM unnest(ARRAY[o.design_style_no,p.po_number,o.customer_code,p.color,business_no.value]) searched(value) WHERE position(lower($8) IN lower(searched.value))>0))
 ), calendar_risk AS (
  SELECT *,CASE WHEN demand IS NULL OR packed IS NULL THEN 'unknown' WHEN packed>=demand THEN 'delivered' WHEN due<$6::date THEN 'overdue'
   WHEN reminder_days IS NULL THEN 'unknown' WHEN due<=$6::date+reminder_days THEN 'due_soon' ELSE 'pending' END AS risk
  FROM calendar_po WHERE $10='all' OR ($10='excluded' AND excluded) OR ($10='current' AND NOT excluded)
 ), calendar_buckets AS (
  SELECT fact.*,bucket.name FROM calendar_risk fact CROSS JOIN LATERAL(VALUES
   ('overdue',fact.due<$6::date AND fact.demand IS NOT NULL AND fact.packed IS NOT NULL AND fact.packed<fact.demand),
   ('before-selected',$7::date>$6::date AND fact.due>=$6::date AND fact.due<$7::date AND fact.demand IS NOT NULL AND fact.packed IS NOT NULL AND fact.packed<fact.demand),
   ('quantity-unknown',fact.demand IS NULL OR fact.packed IS NULL)) bucket(name,matches)
  WHERE bucket.matches AND ($11::text IS NULL OR fact.risk=$11)
 ) SELECT name AS bucket,count(*)::text AS po_count,sum(demand)::text AS ordered,sum(least(demand,packed))::text AS packed,sum(greatest(demand-packed,0))::text AS pending
  FROM calendar_buckets GROUP BY name`,['2000-01-01','2199-12-31','#',cutIds,orderIds,today,selectedDate,filters.search,filters.customer??null,filters.scope,filters.status??null,sourcingAllowed])).rows;
 const result:DeliveryDebtSummary={overdue:empty(),beforeSelected:empty(),quantityUnknownPoCount:0};
 for(const row of rows){
  if(row.bucket==='quantity-unknown'){result.quantityUnknownPoCount=Number(row.po_count);continue;}
  const count=Number(row.po_count),ordered=Number(row.ordered),packed=Number(row.packed),pending=Number(row.pending),isOverdue=row.bucket==='overdue';
  const summary:DeliverySummary={...empty(),poCount:count,orderedQty:ordered,packedQty:packed,pendingQty:pending,knownOrderedQty:ordered,comparableOrderedQty:ordered,knownPackedQty:packed,knownPendingQty:pending,overduePoCount:isOverdue?count:0,overduePendingQty:isOverdue?pending:0};
  if(isOverdue)result.overdue=summary;else if(row.bucket==='before-selected')result.beforeSelected=summary;
 }
 return result;
}
