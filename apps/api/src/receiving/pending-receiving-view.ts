import type {PoolClient} from 'pg';
import {pendingReceivingForAuthorizedOrders} from './pending-receiving-original-allocation.js';

type DB=Pick<PoolClient,'query'>;
type PendingRow=Awaited<ReturnType<typeof pendingReceivingForAuthorizedOrders>>[number];
type OrderIdentity={order_id:string;order_number:string|null;customer_code:string|null};

/** Existing caller must supply the authorized set, never an untrusted list
 * from a query parameter. Filtering and counting are over the same snapshot.
 * These are order allocations, not a copy of the receiving ledger. */
export async function pendingReceivingView(db:DB,authorizedOrderIds:readonly string[],input:{search:string;page:number;status:'open'|'all'|'collected'},focus?:string){
 if(!authorizedOrderIds.length)return {total:0,page:input.page,items:[]};
 const {rows}=await db.query<OrderIdentity>(`SELECT o.production_order_id AS order_id,o.design_style_no AS order_number,o.customer_code
  FROM digital_production_orders o WHERE o.production_order_id=ANY($1::uuid[])
  AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle life WHERE life.state<>'active'
   AND (life.resource_kind='order' AND life.resource_id=o.production_order_id OR life.resource_kind='source' AND life.resource_id=o.source_id))
  AND NOT EXISTS(SELECT 1 FROM digital_order_closures close WHERE close.production_order_id=o.production_order_id)`,[authorizedOrderIds]);
 const orders=new Map(rows.map(row=>[row.order_id,row]));
 const scopes=await pendingReceivingForAuthorizedOrders(db,[...orders.keys()]);
 const query=input.search.trim().toLowerCase();
 const id=(row:PendingRow)=>JSON.stringify([row.identity.orderId,row.identity.productionId,row.factoryDecisionId,row.identity.lineId,row.identity.cuttingOrderId]);
 const filtered=scopes.filter(row=>{
  if(focus!==undefined&&id(row)!==focus)return false;
  if(input.status==='open'&&row.balance.status==='collected'||input.status==='collected'&&row.balance.status!=='collected')return false;
  const order=orders.get(row.identity.orderId)!;
  return !query||[order.order_number,order.customer_code,row.poNumber,row.supplierName,row.color].some(value=>value?.toLowerCase().includes(query));
 });
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

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parsePendingReceivingIdentity(raw:string):[string,string,string|null,string,string]|null{
 if(raw.length>201)return null;
 try{
  const value:unknown=JSON.parse(raw);
  if(!Array.isArray(value)||value.length!==5||!value.every((part,i)=>i===2&&part===null||typeof part==='string'&&uuid.test(part)))return null;
  return value as [string,string,string|null,string,string];
 }catch{return null;}
}

export async function pendingReceivingSelection(db:DB,identity:NonNullable<ReturnType<typeof parsePendingReceivingIdentity>>){
 const [orderId,productionOrderId,factoryDecisionId,lineId,cuttingOrderId]=identity;
 const scope=(await pendingReceivingView(db,[orderId],{search:'',status:'open',page:1},JSON.stringify(identity))).items[0];
 if(!scope?.factoryShipmentRecorded||scope.balance.status==='unresolved'||scope.balance.remaining===null||scope.balance.remaining===0)return null;
 const original=(await db.query<{style_no:string;actual_cut_count:number;receiving_batch_id:string|null;document_quantity:number|null;batch_count:number}>(`SELECT
   c.formal_style_no AS style_no,c.actual_cut_count::int,original.receiving_batch_id,original.document_quantity,original.batch_count
   FROM current_cutting_style_options c LEFT JOIN LATERAL (
    SELECT count(*)::int AS batch_count,min(b.delivery_note_quantity)::int AS document_quantity,
      CASE WHEN count(*)=1 THEN min(b.receiving_batch_id::text)::uuid ELSE NULL END AS receiving_batch_id
    FROM receiving_batches b WHERE b.cutting_order_id=c.cutting_order_id AND b.deleted_at IS NULL
   ) original ON true WHERE c.cutting_order_id=$1`,[cuttingOrderId])).rows;
 if(original.length!==1||original[0]!.batch_count>1)return null;
 const row=original[0]!;
 return {orderId,productionOrderId,factoryDecisionId,lineId,cuttingOrderId,styleNo:row.style_no,
  receivingBatchId:row.receiving_batch_id,documentQuantity:row.document_quantity,actualCutCount:row.actual_cut_count,supplierName:scope.supplierName,poNumber:scope.poNumber,
  color:scope.color,remaining:scope.balance.remaining};
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
