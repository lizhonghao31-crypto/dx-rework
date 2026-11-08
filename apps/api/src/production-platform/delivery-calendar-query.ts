import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {DELIVERY_CALENDAR_VERSION,type DeliveryCalendarFilters,type DeliverySnapshot,type DeliveryReadBasis,type DeliveryYearResponse,type DeliveryMonthResponse,type DeliveryDayResponse,type DeliveryMissingResponse,type DeliveryListGroup,type DeliveryCoverage} from '@dx-rework/contracts/delivery-calendar';
import {deliveryPo,deliverySummary,deliveryDays,deliveryDayGroups,selectedDeliveryRows,hasDeliveryMissingEvidence} from '@dx-rework/domain/delivery-calendar';
import {addCalendarDays} from '@dx-rework/contracts/series-calendar';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {isRootActor} from '../access/business-authority.js';
import {acceptanceBusinessContext,acceptanceIncludesNative,acceptanceClockReaderEnabled,ContextBusinessClock,assertBusinessClockUnchanged,observedBusinessTime} from '../acceptance-clock/business-time.js';
import {assertIdentityActor} from './identity-service.js';
import {DigitalProductionAccessPolicy,isDigitalManagementReader,isDigitalTechnicalManager,digitalForbidden} from './access-policy.js';
import {AnalysisResultStore} from './analysis-result-store.js';
import {deliveryCalendarFacts} from './delivery-calendar-facts.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Exact original order technical-read grants. Current roles are revalidated by
// live() first; task/preparation/QC exceptions still use the original policy.
const basicReadSql="($1::boolean OR ($3::boolean AND o.created_by=$2) OR ($4::boolean AND o.primary_merchandiser_id=$2) OR ($5::boolean AND o.source_id IS NOT NULL))";
const basicReadParameters=(actor:TrustedActorContext)=>[isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor),actor.actorId,actor.actorRoles.includes('sample_designer'),actor.actorRoles.includes('order_merchandiser'),actor.actorRoles.includes('development_clerk')];
const excluded=(row:DeliverySnapshot['rows'][number])=>['cancelled','special_closed'].includes(row.scopeStatus);
const monthRange=(month:string)=>{const start=month+'-01',year=Number(month.slice(0,4)),m=Number(month.slice(5)),next=m===12?`${year+1}-01-01`:`${year}-${String(m+1).padStart(2,'0')}-01`;return {start,end:addCalendarDays(next,-1)};};
type BasisSnapshot=DeliverySnapshot&{snapshotId:string;createdAt:string;expiresAt:string;freshness:'current'|'query-snapshot'};
/** Lightweight current PO facts. No full per-order Journey, progress or SLA
 * projection occurs before paging; aggregate dates only after original scope.
 */
export class DeliveryCalendarQuery{
 private readonly store:AnalysisResultStore<DeliverySnapshot>;
 constructor(private readonly database:Pool){this.store=new AnalysisResultStore(database);}
 private async read<T>(work:(db:PoolClient)=>Promise<T>){const db=await this.database.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await work(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
 private async live(db:PoolClient,actor:TrustedActorContext){
  const policy=new DigitalProductionAccessPolicy(db),roles:string[]=[];
  for(const role of actor.actorRoles)if(role==='root_superuser'?isRootActor(actor)&&(await db.query('SELECT access_is_root_actor($1) AS allowed',[actor.actorId])).rows[0]?.allowed:await policy.activeRole(actor.actorId,role))roles.push(role);
  const currentCapabilities=new Set<string>((await db.query('SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])',[roles])).rows.map(row=>row.capability));
  const current={...actor,actorRoles:roles,authorizationCapabilities:roles.includes('root_superuser')?(actor.authorizationCapabilities??[]):(actor.authorizationCapabilities??[]).filter(capability=>currentCapabilities.has(capability))};assertIdentityActor(current);return current;
 }
 private async allowed(db:PoolClient,actor:TrustedActorContext,ids:string[]){
  if(!ids.length)return true;
  const rows=(await db.query<{production_order_id:string;direct:boolean}>(`SELECT o.production_order_id,coalesce(${basicReadSql},false) AS direct FROM digital_production_orders o WHERE o.production_order_id=ANY($6::uuid[])`,[...basicReadParameters(actor),ids])).rows;
  if(rows.length!==ids.length)return false;
  const policy=new DigitalProductionAccessPolicy(db);
  for(const row of rows)if(!await acceptanceIncludesNative(this.database,row.production_order_id,db)||!row.direct&&!await policy.allowed(actor,'order',row.production_order_id,'technical'))return false;
  return true;
 }
 private async permission(db:PoolClient,actor:TrustedActorContext,ids:string[]){const live=await this.live(db,actor);if(!await this.allowed(db,live,ids))digitalForbidden();return hash({actor:live.actorId,roles:[...live.actorRoles].sort(),capabilities:[...(live.authorizationCapabilities??[])].sort(),orders:[...ids].sort(),scene:acceptanceBusinessContext()?.scenarioId??null});}
 private async candidates(db:PoolClient,actor:TrustedActorContext,range:{from:string;to:string}){
  // Direct grants are the original technical-read predicates after live role
  // validation; the original policy rechecks task/preparation/QC exceptions.
  return (await db.query<{production_order_id:string;direct:boolean}>(`SELECT o.production_order_id,coalesce(${basicReadSql},false) AS direct FROM digital_production_orders o WHERE (${basicReadSql}
   OR EXISTS(SELECT 1 FROM digital_production_task_access a WHERE a.production_order_id=o.production_order_id AND a.assignee_id=$2)
   OR EXISTS(SELECT 1 FROM digital_bulk_dispatch d WHERE d.production_order_id=o.production_order_id AND d.warehouse_worker_id=$2)
   OR EXISTS(SELECT 1 FROM digital_preparation_responsibilities r WHERE ((r.resource_kind='order' AND r.resource_id=o.production_order_id) OR (r.resource_kind='source' AND r.resource_id=o.source_id)) AND (r.warehouse_worker_id=$2 OR r.color_confirmation_worker_id=$2))
   OR EXISTS(SELECT 1 FROM digital_qc_supervision_settings q WHERE q.production_order_id=o.production_order_id AND q.quality_lead_id=$2))
   AND EXISTS(SELECT 1 FROM digital_production_po_lines p WHERE p.production_order_id=o.production_order_id AND (p.customer_warehouse_arrival_date IS NULL OR p.customer_warehouse_arrival_date BETWEEN $6::date AND $7::date))
   ORDER BY o.production_order_id`,[...basicReadParameters(actor),range.from,range.to])).rows;
 }
 private async snapshot(actor:TrustedActorContext,filters:DeliveryCalendarFilters,coverage:DeliveryCoverage,snapshotId?:string):Promise<BasisSnapshot>{
  const key=hash({kind:DELIVERY_CALENDAR_VERSION,filters});
  if(snapshotId){const stored=await this.store.load(snapshotId,actor.actorId,key,payload=>this.read(db=>this.permission(db,actor,payload.permissionOrderIds)));if(stored.result.ruleVersion!==DELIVERY_CALENDAR_VERSION)throw new ApplicationError('DELIVERY_RESULT_EXPIRED','交付查询已失效，请刷新',409);const previous=stored.coverage;if(!previous||previous.kind!==coverage.kind||(coverage.kind==='day'?previous.kind!=='day'||previous.date!==coverage.date:previous.kind!=='period'||previous.from>coverage.from||previous.to<coverage.to))throw new ApplicationError('DELIVERY_RESULT_SCOPE','原查询未包含本次完整日期范围，请重新读取',409);const context=acceptanceBusinessContext();if(context&&(context.scenarioId!==stored.scenarioId||context.time.revision!==stored.clockRevision||context.time.now!==stored.asOf))throw new ApplicationError('DELIVERY_CONTEXT_CHANGED','业务观察时点已更新，请刷新交付查询',409);return {...stored,freshness:'query-snapshot'};}
  const observations:Array<{id:string;time:Awaited<ReturnType<ContextBusinessClock['read']>>}>=[];
  const value=await this.read(async db=>{
   const live=await this.live(db,actor),policy=new DigitalProductionAccessPolicy(db),ids:string[]=[];
   const candidateRange=coverage.kind==='period'?coverage:{from:'2000-01-01',to:'2199-12-31'};
   for(const row of await this.candidates(db,live,candidateRange))if(await acceptanceIncludesNative(this.database,row.production_order_id,db)&&(row.direct||await policy.allowed(live,'order',row.production_order_id,'technical')))ids.push(row.production_order_id);
   const wall=(await db.query<{at:Date}>('SELECT CURRENT_TIMESTAMP AS at')).rows[0]!.at;
   let observation=observedBusinessTime(()=>wall);
   if(acceptanceClockReaderEnabled(this.database)||acceptanceBusinessContext())for(const id of ids){const time=await new ContextBusinessClock(this.database,db).read({kind:'order',id},()=>wall);if(observations.length&&(time.scenarioId!==observation.scenarioId||time.now!==observation.now))throw new ApplicationError('DELIVERY_CONTEXT_CHANGED','不同业务时点不能合并为一份交付查询，请刷新',409);observation=time;observations.push({id,time});}
   const today=beijingCalendarDate(new Date(observation.now)),range=coverage.kind==='period'?coverage:{from:'2000-01-01',to:coverage.date>today?coverage.date:today},facts=await deliveryCalendarFacts(db,ids,range,isRootActor(live)||(live.authorizationCapabilities??[]).includes('sourcing:view')),rows=selectedDeliveryRows(facts.map(fact=>deliveryPo(fact,today)),{...filters,scope:'all'}).filter(row=>coverage.kind!=='day'||!row.effectiveDueDate||row.effectiveDueDate===coverage.date||row.pendingQty!==0);
   if(selectedDeliveryRows(rows,filters).length>5000)throw new ApplicationError('DELIVERY_RANGE_TOO_LARGE','本次交付查询超过5000个PO，请缩小客户或搜索范围',409);
   const permissionOrderIds=[...new Set(rows.map(row=>row.orderId))],permissionHash=await this.permission(db,live,permissionOrderIds),payload:DeliverySnapshot={result:{ruleVersion:DELIVERY_CALENDAR_VERSION},watermark:hash(rows),asOf:observation.now,asOfBusinessDate:today,clockRevision:observation.revision,scenarioId:observation.scenarioId,coverage,filters,rows,permissionOrderIds};
   return {payload,permissionHash};
  });
  for(const {id,time}of observations)await assertBusinessClockUnchanged(new ContextBusinessClock(this.database),{kind:'order',id},time);
  if(await this.read(db=>this.permission(db,actor,value.payload.permissionOrderIds))!==value.permissionHash)throw new ApplicationError('DELIVERY_PERMISSION_CHANGED','读取期间授权已变化，请刷新交付查询',409);
  return {...value.payload,...await this.store.save(actor.actorId,key,value.permissionHash,value.payload),freshness:'current'};
 }
 private selected(snapshot:BasisSnapshot){return selectedDeliveryRows(snapshot.rows,snapshot.filters);}
 private basis(snapshot:BasisSnapshot):DeliveryReadBasis{return {asOf:snapshot.asOf,asOfBusinessDate:snapshot.asOfBusinessDate,snapshotId:snapshot.snapshotId,createdAt:snapshot.createdAt,expiresAt:snapshot.expiresAt,freshness:snapshot.freshness,filterEcho:snapshot.filters,datePrecision:'date',dateRole:'effective_customer_shipping_date',quantityRole:'current_cumulative_packing_grouped_by_customer_due_date'};}
 async year(actor:TrustedActorContext,filters:DeliveryCalendarFilters,year:number,snapshotId?:string):Promise<DeliveryYearResponse>{
  const start=`${year}-01-01`,end=`${year}-12-31`,s=await this.snapshot(actor,filters,{kind:'period',from:start,to:end},snapshotId),visible=this.selected(s),days=deliveryDays(visible,start,end),rows=visible.filter(row=>row.effectiveDueDate&&row.effectiveDueDate>=start&&row.effectiveDueDate<=end),months=Array.from({length:12},(_,index)=>{const month=`${year}-${String(index+1).padStart(2,'0')}`;return {month,summary:deliverySummary(rows.filter(row=>row.effectiveDueDate!.startsWith(month))),days:days.filter(day=>day.date.startsWith(month))};});
  return {...this.basis(s),year,yearSummary:deliverySummary(rows),months,missingSummary:deliverySummary(visible.filter(row=>!row.effectiveDueDate||row.effectiveDueDate>=start&&row.effectiveDueDate<=end&&hasDeliveryMissingEvidence(row))),excludedSummary:deliverySummary(s.rows.filter(row=>excluded(row)&&row.effectiveDueDate!==null&&row.effectiveDueDate>=start&&row.effectiveDueDate<=end)),focusMonth:`${year}-${s.asOfBusinessDate.slice(5,7)}`,focusDays:days.filter(day=>day.date.slice(5,7)===s.asOfBusinessDate.slice(5,7)&&day.summary.poCount>0).sort((a,b)=>b.summary.knownPendingQty-a.summary.knownPendingQty||b.summary.knownOrderedQty-a.summary.knownOrderedQty||a.date.localeCompare(b.date)).slice(0,10)};
 }
 async month(actor:TrustedActorContext,filters:DeliveryCalendarFilters,month:string,snapshotId?:string):Promise<DeliveryMonthResponse>{const {start,end}=monthRange(month),s=await this.snapshot(actor,filters,{kind:'period',from:start,to:end},snapshotId),visible=this.selected(s),rows=visible.filter(row=>row.effectiveDueDate?.startsWith(month));return {...this.basis(s),yearMonth:month,monthSummary:deliverySummary(rows),days:deliveryDays(visible,start,end),missingSummary:deliverySummary(visible.filter(row=>!row.effectiveDueDate||row.effectiveDueDate.startsWith(month)&&hasDeliveryMissingEvidence(row))),excludedSummary:deliverySummary(s.rows.filter(row=>excluded(row)&&row.effectiveDueDate?.startsWith(month)))};}
 async day(actor:TrustedActorContext,filters:DeliveryCalendarFilters,date:string,page=1,pageSize=15,snapshotId?:string,group:DeliveryListGroup='day'):Promise<DeliveryDayResponse>{
  if(page>1&&!snapshotId)throw new ApplicationError('DELIVERY_RESULT_REQUIRED','请先读取当天完整统计，再按同一查询翻页',409);
  const s=await this.snapshot(actor,filters,{kind:'day',date},snapshotId),groups=deliveryDayGroups(this.selected(s),date,s.asOfBusinessDate),list=group==='overdue'?groups.overdue:group==='before-selected'?groups.beforeSelectedNotYetOverdue:groups.day;return {...this.basis(s),selectedDate:date,daySummary:deliverySummary(groups.day),listGroup:group,listSummary:deliverySummary(list),items:list.slice((page-1)*pageSize,page*pageSize),total:list.length,page,pageSize,overdueAsOfTodaySummary:deliverySummary(groups.overdue),pendingBeforeSelectedNotYetOverdueSummary:deliverySummary(groups.beforeSelectedNotYetOverdue),missingSummary:deliverySummary(groups.missing),dateChangeSummary:{poCount:groups.day.filter(row=>row.hasRecordedDueChange).length}};
 }
 async missing(actor:TrustedActorContext,filters:DeliveryCalendarFilters,period:{year?:number;month?:string},page=1,pageSize=15,snapshotId?:string):Promise<DeliveryMissingResponse>{
  if(page>1&&!snapshotId)throw new ApplicationError('DELIVERY_RESULT_REQUIRED','请先读取缺项完整统计，再按同一查询翻页',409);
  const bounds=period.month?monthRange(period.month):{start:period.year?`${period.year}-01-01`:'2000-01-01',end:period.year?`${period.year}-12-31`:'2199-12-31'},s=await this.snapshot(actor,filters,{kind:'period',from:bounds.start,to:bounds.end},snapshotId),prefix=period.month??(period.year?String(period.year):null),rows=this.selected(s).filter(row=>!row.effectiveDueDate||hasDeliveryMissingEvidence(row)&&(!prefix||row.effectiveDueDate.startsWith(prefix)));return {...this.basis(s),items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,missingSummary:deliverySummary(rows)};
 }
}
