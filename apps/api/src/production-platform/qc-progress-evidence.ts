import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {qcProgressClock,type QcProgressClock} from '@dx-rework/contracts/qc-production-progress';
import {factoryProductionScopes,factoryProductionScopesForOrders} from './factory-production-facts.js';
type DB=Pick<Pool|PoolClient,'query'>;
const iso=(v:Date|string|null|undefined)=>v==null?null:new Date(v).toISOString();
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const factoryKey=(nativeId:string,decisionId:string|null)=>`${nativeId}:${decisionId??'original'}`;
type QcTask={task_id:string;assignee_id:string|null;state:string;assignee_name:string|null};
type FactoryScopes=Awaited<ReturnType<typeof factoryProductionScopes>>;
export async function qcExecutionScopes(db:DB,id:string){
 const task=(await db.query<QcTask>(`SELECT a.task_id,a.assignee_id,t.state,u.display_name AS assignee_name FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) LEFT JOIN app_users u ON u.id=a.assignee_id WHERE a.production_order_id=$1 AND a.task_kind='factory_production_qc' ORDER BY t.created_at DESC,t.task_id DESC LIMIT 1`,[id])).rows[0];
 return groupQcExecutions(id,await factoryProductionScopes(db,id),task);
}
function groupQcExecutions(id:string,scopes:FactoryScopes,task:QcTask|undefined){
 const groups=new Map<string,FactoryScopes>();
 for(const row of scopes){const key=factoryKey(row.production_order_id,row.factory_decision_id),rows=groups.get(key)??[];rows.push(row);groups.set(key,rows);}
 return [...groups.values()].map(rows=>({rows,task,scopeRevision:hash({orderId:id,nativeId:rows[0].production_order_id,factoryDecisionId:rows[0].factory_decision_id,sourcingDecisionId:rows[0].sourcing_decision_id,qcUserId:task?.assignee_id??null,lines:rows.map(r=>({lineId:r.line_id,position:Number(r.position),quantity:Number(r.quantity)}))})}));
}
export type QcObservationWindow={key:string;lineIds:string[];clock:QcProgressClock};
type DispatchFact={occurred_at:Date|null;payload:{supplierId:string;lines?:Array<{lineId:string;quantity:number}>}};
/** Each PO retains its own last effective observation; recording another PO is never a reset. */
function qcExecutionWindows(warehouse:readonly DispatchFact[],group:ReturnType<typeof groupQcExecutions>[number],tracking:Record<string,unknown>|undefined,records:Array<Record<string,unknown>>,asOf:string,finished:boolean){
 const first=group.rows[0],lineClocks=group.rows.map(line=>{
  const dispatch=warehouse.filter(f=>f.payload.supplierId===first.supplier_id&&f.occurred_at&&new Date(f.occurred_at)>=new Date(first.dispatched_at)
   &&(!Array.isArray(f.payload.lines)||f.payload.lines.some((part:{lineId:string;quantity:number})=>part.lineId===line.line_id&&part.quantity>0))).map(f=>iso(f.occurred_at)!).sort()[0]??null;
  const startedAt=tracking?.basis==='warehouse_dispatch'?dispatch:iso(tracking?.started_at as Date|null);
  const latest=records.filter(r=>r.kind==='progress'&&Date.parse(iso(r.collected_at as Date)??'')<=Date.parse(asOf)&&(r.observations as Array<{lineId:string;allocationQuantity:number}>).some(o=>o.lineId===line.line_id&&o.allocationQuantity>=Number(line.quantity)))
   .sort((a,b)=>Date.parse(iso(b.collected_at as Date)??'')-Date.parse(iso(a.collected_at as Date)??'')||Number(b.revision)-Number(a.revision))[0];
  return {lineId:line.line_id as string,clock:qcProgressClock({trackingId:tracking?.tracking_id as string??null,startedAt,latestProgressId:latest?.record_id as string??null,latestCollectedAt:iso(latest?.collected_at as Date|null),finished},asOf)};
 });
 const grouped=new Map<string,QcObservationWindow>();
 for(const part of lineClocks){const key=hash([tracking?.tracking_id??null,part.clock.windowKey,part.clock.anchor,part.clock.state==='unknown'?'unknown':null]);const existing=grouped.get(key);if(existing)existing.lineIds.push(part.lineId);else grouped.set(key,{key,lineIds:[part.lineId],clock:part.clock});}
 const windows=[...grouped.values()],known=lineClocks.map(p=>p.clock).filter(c=>c.state!=='unknown'),rank=(c:QcProgressClock)=>c.state==='escalated'?3:c.state==='due'?2:c.state==='not_due'?1:0;
 known.sort((a,b)=>rank(b)-rank(a)||(a.remindAt??'9999').localeCompare(b.remindAt??'9999'));
 const unknown=lineClocks.filter(p=>p.clock.state==='unknown').length;
 const fallback=qcProgressClock({trackingId:null,startedAt:null,latestProgressId:null,latestCollectedAt:null,finished},asOf);
 let clock=known[0]??fallback;
 if(unknown){clock=rank(clock)>=2?{...clock,reason:`另有${unknown}项PO缺可信监督起点，未伪造时间`}:{...fallback,reason:`${unknown}项PO尚无可信监督起点，已有PO的时间仍分别保留`};}
 return {lineClocks,windows,clock};
}

type QcEvidenceRead={orderId:string;asOf:string;closed?:boolean};
type Tracking=Record<string,unknown>&{tracking_id:string;native_production_id:string;factory_decision_id:string|null;
 started_at:Date;basis:'warehouse_dispatch'|'explicit_supervision'|'first_progress'};
type ProgressRecord=Record<string,unknown>&{tracking_id:string};
function pushFact<T>(map:Map<string,T[]>,key:string,fact:T){
 const group=map.get(key);if(group)group.push(fact);else map.set(key,[fact]);
}

/** Resolve physical evidence once per requested master and native execution.
 * Per-caller observation times and closure decisions are applied independently. */
export async function readQcExecutionEvidenceForOrders(db:DB,requests:readonly QcEvidenceRead[]){
 const orders=[...new Set(requests.map(request=>request.orderId))];
 const scopes=await factoryProductionScopesForOrders(db,orders);
 if(!scopes.size)return requests.map(()=>[]);
 const selected=[...scopes.keys()];
 const tasks=(await db.query<QcTask&{production_order_id:string}>(`SELECT DISTINCT ON(a.production_order_id) a.production_order_id,a.task_id,a.assignee_id,t.state,u.display_name AS assignee_name
  FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) LEFT JOIN app_users u ON u.id=a.assignee_id
  WHERE a.production_order_id=ANY($1::uuid[]) AND a.task_kind='factory_production_qc' ORDER BY a.production_order_id,t.created_at DESC,t.task_id DESC`,[selected])).rows;
 const byOrder=new Map(tasks.map(({production_order_id,...task})=>[production_order_id,task]));
 const groups=new Map(selected.map(id=>[id,groupQcExecutions(id,scopes.get(id)!,byOrder.get(id))]));
 const executions=[...groups.values()].flatMap(entries=>entries.map(entry=>entry.rows[0]));
 const tracking=(await db.query<Tracking>(`SELECT t.* FROM digital_qc_tracking_starts t
  JOIN (SELECT DISTINCT native_id,decision_id FROM unnest($1::uuid[],$2::uuid[]) AS k(native_id,decision_id)) k
   ON k.native_id=t.native_production_id AND k.decision_id IS NOT DISTINCT FROM t.factory_decision_id`,
 [executions.map(row=>row.production_order_id),executions.map(row=>row.factory_decision_id)])).rows;
 const trackingByKey=new Map(tracking.map(row=>[factoryKey(row.native_production_id,row.factory_decision_id),row]));
 const histories=new Map<string,ProgressRecord[]>();
 if(tracking.length){
  const records=(await db.query<ProgressRecord>('SELECT * FROM digital_qc_progress_records WHERE tracking_id=ANY($1::uuid[]) ORDER BY tracking_id,revision DESC',[tracking.map(row=>row.tracking_id)])).rows;
  for(const record of records)pushFact(histories,record.tracking_id,record);
 }
 const warehouse=new Map<string,DispatchFact[]>();
 const dispatch=(await db.query<DispatchFact&{production_order_id:string}>(`SELECT route.production_order_id,f.occurred_at,f.payload FROM digital_factory_facts f JOIN digital_factory_routes route USING(preparation_id)
  WHERE route.production_order_id=ANY($1::uuid[]) AND f.kind='仓库实际发厂' ORDER BY route.production_order_id,f.sequence`,[selected])).rows;
 for(const {production_order_id,...fact} of dispatch)pushFact(warehouse,production_order_id,fact);
 return requests.map(({orderId,asOf,closed})=>(groups.get(orderId)??[]).map(group=>{
  const first=group.rows[0],tracking=trackingByKey.get(factoryKey(first.production_order_id,first.factory_decision_id));
  const records=tracking?histories.get(tracking.tracking_id)??[]:[],finished=first.execution_status!=='in_production'||Boolean(closed);
  return {group,tracking,records,finished,...qcExecutionWindows(warehouse.get(orderId)??[],group,tracking,records,asOf,finished)};
 }));
}

/** Internal read projection; callers authorize order and output fields. */
export async function readQcExecutionEvidence(db:DB,id:string,asOf:string,closed=false){
 return (await readQcExecutionEvidenceForOrders(db,[{orderId:id,asOf,closed}]))[0]!;
}
