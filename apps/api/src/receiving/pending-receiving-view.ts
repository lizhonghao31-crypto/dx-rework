import type {PoolClient} from 'pg';
import {pendingReceivingForAuthorizedOrders} from './pending-receiving-original-allocation.js';

type DB=Pick<PoolClient,'query'>;
type PendingRow=Awaited<ReturnType<typeof pendingReceivingForAuthorizedOrders>>[number];
type OrderIdentity={order_id:string;order_number:string|null;customer_code:string|null};

/** Existing caller must supply the authorized set, never an untrusted list
 * from a query parameter. Filtering and counting are over the same snapshot.
 * These are order allocations, not a copy of the receiving ledger. */
export async function pendingReceivingView(db:DB,authorizedOrderIds:readonly string[],input:{search:string;page:number;status:'open'|'all'|'collected'}){
 if(!authorizedOrderIds.length)return {total:0,page:input.page,items:[]};
 const {rows}=await db.query<OrderIdentity>(`SELECT o.production_order_id AS order_id,o.design_style_no AS order_number,o.customer_code
  FROM digital_production_orders o WHERE o.production_order_id=ANY($1::uuid[])
  AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle life WHERE life.state<>'active'
   AND (life.resource_kind='order' AND life.resource_id=o.production_order_id OR life.resource_kind='source' AND life.resource_id=o.source_id))
  AND NOT EXISTS(SELECT 1 FROM digital_order_closures close WHERE close.production_order_id=o.production_order_id)`,[authorizedOrderIds]);
 const orders=new Map(rows.map(row=>[row.order_id,row]));
 const scopes=await pendingReceivingForAuthorizedOrders(db,[...orders.keys()]);
 const query=input.search.trim().toLowerCase();
 const filtered=scopes.filter(row=>{
  if(input.status==='open'&&row.balance.status==='collected'||input.status==='collected'&&row.balance.status!=='collected')return false;
  const order=orders.get(row.identity.orderId)!;
  return !query||[order.order_number,order.customer_code,row.poNumber,row.supplierName,row.color].some(value=>value?.toLowerCase().includes(query));
 });
 const id=(row:PendingRow)=>JSON.stringify([row.identity.orderId,row.identity.productionId,row.factoryDecisionId,row.identity.lineId,row.identity.cuttingOrderId]);
 const firstSent=(row:PendingRow)=>row.balance.dispatches.map(fact=>fact.actualDispatchedAt).sort()[0]!;
 const sorted=filtered.sort((a,b)=>firstSent(b).localeCompare(firstSent(a))||id(a).localeCompare(id(b)));
 const page=sorted.slice((input.page-1)*15,input.page*15);
 const factoryDates=await readSelectedReturnDates(db,page);
 return {total:sorted.length,page:input.page,items:page.map(row=>{
  const order=orders.get(row.identity.orderId)!;
  const date=factoryDates.get(id(row));
  return {...row,id:id(row),orderNumber:order.order_number,customerCode:order.customer_code,
   actualFactoryDispatchAt:firstSent(row),expectedFactoryReturnDate:date??null};
 })};
}

/** A former factory must not display a replacement factory's date for the
 * same PO. Directly read the original execution's own effective date. */
async function readSelectedReturnDates(db:DB,scopes:readonly PendingRow[]){
 const result=new Map<string,string>();
 if(!scopes.length)return result;
 const ids=scopes.map(row=>[row.identity.orderId,row.identity.productionId,row.factoryDecisionId,row.identity.lineId,row.identity.cuttingOrderId]);
 const {rows}=await db.query<{key:string;date:string|null}>(`SELECT target.row::text AS key,p.delivery_date::text AS date
  FROM jsonb_array_elements($1::jsonb) AS target(row)
  JOIN digital_production_child_links link ON link.module='production' AND link.production_order_id::text=target.row->>0 AND link.child_id::text=target.row->>1
  JOIN sourcing_production_factory_orders p ON p.production_order_id=link.child_id AND p.factory_decision_id::text IS NOT DISTINCT FROM target.row->>2`,[JSON.stringify(ids)]);
 for(const row of rows)if(row.date)result.set(JSON.stringify(JSON.parse(row.key)),row.date);
 return result;
}
