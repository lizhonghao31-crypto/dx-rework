import {packingActualTime} from '@dx-rework/contracts';
import type {PoolClient} from 'pg';
import type {DeliveryPoFact,DeliveryScope} from '@dx-rework/contracts/delivery-calendar';
import {readNativePackingHeads,digitalReceivingBaseSql} from '../receiving/receiving-quantity-query.js';
import {readNativeReceiptExceptions} from '../receiving/native-receipt-qualification.js';
import {journeyCutScopesForOrders,NATIVE_EMPTY_PACKING_SCOPE_SQL} from './journey-cut-scopes.js';
import {effectivePackingQuantity,readPackingQualityCoverage} from './packing-quality-coverage.js';

type PoRow={packing_absence_proven:boolean;line_id:string;production_order_id:string;source_id:string|null;design_style_no:string;po_number:string|null;color:string;customer_code:string;product_group:string;quantity:string|null;customer_date:string|null;factory_date:string|null;customer_date_version:number;cutting_ids:string[]|null;cancelled:boolean;paused:boolean;closed:boolean};
const quantity=(value:unknown):number|null=>{if(value===null||value===undefined)return null;const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;};
const businessNumber=(value:unknown):string|null=>{if(typeof value!=='string')return null;const text=value.trim();return text&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)?text:null;};
/** Only already-authorized mothers enter this reader. Batch reads consume
 * original PO sizes, native cumulative packing and immutable customer date/SLA
 * snapshots; no Journey, task/SLA recalculation, factory share allocation or write.
 */
export async function deliveryCalendarFacts(db:PoolClient,orderIds:string[],range:{from:string;to:string},sourcingAllowed=false):Promise<DeliveryPoFact[]>{
 if(!orderIds.length)return [];
 const rows=(await db.query<PoRow>(`SELECT (${NATIVE_EMPTY_PACKING_SCOPE_SQL}) AS packing_absence_proven,p.line_id,p.production_order_id,o.source_id,o.design_style_no,p.po_number,p.color,o.customer_code,o.product_group,
  (SELECT sum(size.quantity)::text FROM digital_production_po_sizes size WHERE size.line_id=p.line_id) AS quantity,
  p.customer_warehouse_arrival_date::text AS customer_date,p.factory_delivery_date::text AS factory_date,p.customer_date_version,
  (SELECT array_agg(DISTINCT child.child_id ORDER BY child.child_id) FROM digital_production_child_lines child WHERE child.production_order_id=p.production_order_id AND child.line_id=p.line_id AND child.module='cutting') AS cutting_ids,
  EXISTS(SELECT 1 FROM digital_production_resource_lifecycle life WHERE ((life.resource_kind='order' AND life.resource_id=o.production_order_id) OR (life.resource_kind='source' AND life.resource_id=o.source_id)) AND life.state='cancelled') AS cancelled,
  EXISTS(SELECT 1 FROM digital_production_resource_lifecycle life WHERE ((life.resource_kind='order' AND life.resource_id=o.production_order_id) OR (life.resource_kind='source' AND life.resource_id=o.source_id)) AND life.state='paused') AS paused,
  EXISTS(SELECT 1 FROM digital_order_closures closure WHERE closure.production_order_id=o.production_order_id) AS closed
  FROM digital_production_po_lines p JOIN digital_production_orders o USING(production_order_id)
  WHERE o.production_order_id=ANY($1::uuid[]) AND (p.customer_warehouse_arrival_date IS NULL OR p.customer_warehouse_arrival_date BETWEEN $2::date AND $3::date)
  ORDER BY o.production_order_id,p.position,p.line_id`,[orderIds,range.from,range.to])).rows;
 if(!rows.length)return [];
 const selectedOrders=[...new Set(rows.map(row=>row.production_order_id))];
 const cutScopes=new Map((await journeyCutScopesForOrders(db,selectedOrders,rows.map(row=>row.line_id))).map(scope=>[scope.lineId,scope]));
 const cutIds=[...new Set(rows.flatMap(row=>cutScopes.get(row.line_id)?.status==='verified'?row.cutting_ids??[]:[]))];
 const exceptions=await readNativeReceiptExceptions(db,{orderIds:selectedOrders});
 const excluded=[...new Set(exceptions.map(row=>row.receiptId))],pendingLines=new Set(exceptions.map(row=>row.lineId));
 // This is the original closure/receiving grouping and latest action batch,
 // including corrections/deletion and one cumulative packing across factories.
 const packing=await readNativePackingHeads(db,cutIds);
 const receivingTotals=cutIds.length?(await db.query(`${digitalReceivingBaseSql('$5')}
  SELECT group_key,current_actual_quantity FROM style_totals`,['2000-01-01','2199-12-31','#',cutIds,excluded])).rows:[];
 const quality=await readPackingQualityCoverage(db,selectedOrders,excluded);
 const history=(await db.query(`SELECT line_id,version,change_id,new_date::text,old_date::text,source FROM digital_po_date_changes WHERE line_id=ANY($1::uuid[]) AND date_kind='customer' ORDER BY line_id,version`,[rows.map(row=>row.line_id)])).rows;
 const policies=(await db.query(`SELECT DISTINCT ON(production_order_id) production_order_id,snapshot_id,revision,parameters_json FROM digital_sla_order_snapshots WHERE production_order_id=ANY($1::uuid[]) ORDER BY production_order_id,revision DESC`,[selectedOrders])).rows;
 // Business order numbers have the same field permission as the original
 // Journey. A design style number or internal UUID must never impersonate one.
 const numbers=sourcingAllowed?(await db.query(`SELECT DISTINCT ON(link.production_order_id) link.production_order_id,source.erp_order_no
  FROM digital_production_child_links link JOIN sourcing_cases source ON source.sourcing_case_id=link.child_id
  JOIN current_sourcing_cases current ON current.sourcing_case_id=source.sourcing_case_id
  WHERE link.module='sourcing' AND link.production_order_id=ANY($1::uuid[]) AND source.deleted_at IS NULL
  ORDER BY link.production_order_id,link.child_id`,[selectedOrders])).rows:[];
 // Native sourcing creation historically puts its internal UUID in erp_order_no.
 // The field name alone is not evidence of a human business number.
 const byNumber=new Map(numbers.map(row=>[row.production_order_id,businessNumber(row.erp_order_no)]));
 const byPacking=new Map(packing.map(row=>[row.group_key,row])),byReceiving=new Map(receivingTotals.map(row=>[row.group_key,row])),byPolicy=new Map(policies.map(row=>[row.production_order_id,row])),byLine=new Map<string,typeof history>();
 for(const item of history){const list=byLine.get(item.line_id)??[];list.push(item);byLine.set(item.line_id,list);}
 return rows.map(row=>{
  const cuts=row.cutting_ids??[],verified=cutScopes.get(row.line_id)?.status==='verified',packed=verified?byPacking.get('cut:'+cuts[0]):null,policy=byPolicy.get(row.production_order_id),dueHistory=byLine.get(row.line_id)??[],original=dueHistory.find(change=>change.version===1&&change.source==='initial_po'),effective=dueHistory.find(change=>change.version===row.customer_date_version&&change.new_date===row.customer_date),reasons:string[]=[];
  // A complete native cut/PO identity and this authorized group query prove
  // absence. No row is inserted and missing/ambiguous references remain unknown.
  const orderedQty=quantity(row.quantity),rawPackedQty=packed?.packing_revision_id==null&&(verified||row.packing_absence_proven)?0:quantity(packed?.packing_quantity);
  const covered=quality.get(row.line_id)??null,nativeReceived=quantity(byReceiving.get('cut:'+cuts[0])?.current_actual_quantity)??0;
  const effectivePackedQty=effectivePackingQuantity(rawPackedQty,nativeReceived,covered);
  if(pendingLines.has(row.line_id))reasons.push('有原收货登记仍待核对，未计入正式实收或有效装箱覆盖');
  if(rawPackedQty!==null&&effectivePackedQty===null)reasons.push('原装箱累计的有效合格覆盖待核对，不推定已交数量');
  if(orderedQty===null)reasons.push('本PO有效需求数量待核');if(rawPackedQty===null)reasons.push(cuts.length>1?'本PO有多个开裁关联，装箱范围待核':'本PO尚无可核有效装箱累计');if(!row.customer_date)reasons.push('本PO尚无有效客户出货交期');
  const reminder=policy?.parameters_json?.order_shipping_reminder?.value,reminderDays=reminder?.kind==='offset'&&Number.isInteger(reminder.days)&&reminder.days>=0&&reminder.days<=365?reminder.days as number:null;
  if(reminderDays===null)reasons.push('本单交付临期窗口尚未核实');
  const scopeStatus:DeliveryScope=row.cancelled?'cancelled':row.closed?'special_closed':row.paused?'paused':'active';
  return {orderId:row.production_order_id,lineId:row.line_id,businessOrderNo:byNumber.get(row.production_order_id)||null,designStyleNo:row.design_style_no,po:row.po_number,color:row.color,customer:row.customer_code,productType:row.product_group,orderedQty,rawPackedQty,effectivePackedQty,packingRevision:packed?.packing_revision_id??null,...(packed?.packing_actual_time?{packingActualTime:packingActualTime(packed.packing_actual_time)}:{}),effectiveDueDate:row.customer_date,originalDueDate:original?.new_date??null,factoryDueDate:row.factory_date,dueRevision:row.customer_date_version,dueHistoryRef:effective?.change_id??null,hasRecordedDueChange:dueHistory.some(change=>change.old_date!==null&&change.old_date!==change.new_date),reminderDays,scopeStatus,sourceRefs:[`order:${row.production_order_id}`,`po:${row.line_id}:quantity`,...packed?.packing_revision_id?[`packing:${packed.packing_revision_id}`]:[],...effective?[`customer-date:${effective.change_id}`]:[],...policy?[`sla-order-snapshot:${policy.snapshot_id}`]:[]],unknownReasons:reasons};
 });
}
