import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {qcProgressClock,type QcProgressClock} from '@dx-rework/contracts/qc-production-progress';
import {factoryProductionScopes} from './factory-production-facts.js';
type DB=Pick<Pool|PoolClient,'query'>;
const iso=(v:Date|string|null|undefined)=>v==null?null:new Date(v).toISOString();
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function qcExecutionScopes(db:DB,id:string){
 const task=(await db.query(`SELECT a.task_id,a.assignee_id,t.state,u.display_name AS assignee_name FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) LEFT JOIN app_users u ON u.id=a.assignee_id WHERE a.production_order_id=$1 AND a.task_kind='factory_production_qc' ORDER BY t.created_at DESC,t.task_id DESC LIMIT 1`,[id])).rows[0];
 const scopes=await factoryProductionScopes(db,id),groups=new Map<string,typeof scopes>();
 for(const row of scopes){const key=row.factory_decision_id??'original',rows=groups.get(key)??[];rows.push(row);groups.set(key,rows);}
 return [...groups.values()].map(rows=>({rows,task,scopeRevision:hash({orderId:id,nativeId:rows[0].production_order_id,factoryDecisionId:rows[0].factory_decision_id,sourcingDecisionId:rows[0].sourcing_decision_id,qcUserId:task?.assignee_id??null,lines:rows.map(r=>({lineId:r.line_id,position:Number(r.position),quantity:Number(r.quantity)}))})}));
}
export type QcObservationWindow={key:string;lineIds:string[];clock:QcProgressClock};
/** Each PO retains its own last effective observation; recording another PO is never a reset. */
export async function qcExecutionWindows(db:DB,id:string,group:Awaited<ReturnType<typeof qcExecutionScopes>>[number],tracking:Record<string,unknown>|undefined,records:Array<Record<string,unknown>>,asOf:string,finished:boolean){
 const warehouse=(await db.query(`SELECT f.* FROM digital_factory_facts f JOIN digital_factory_routes route USING(preparation_id) WHERE route.production_order_id=$1 AND f.kind='仓库实际发厂' ORDER BY sequence`,[id])).rows;
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

/** Internal read projection; callers authorize order/recipient before returning any data. */
export async function readQcExecutionEvidence(db:DB,id:string,asOf:string,closed=false){
 const result=[];
 for(const group of await qcExecutionScopes(db,id)){
  const first=group.rows[0],tracking=(await db.query('SELECT * FROM digital_qc_tracking_starts WHERE native_production_id=$1 AND factory_decision_id IS NOT DISTINCT FROM $2::uuid',[first.production_order_id,first.factory_decision_id])).rows[0];
  const records=tracking?(await db.query('SELECT * FROM digital_qc_progress_records WHERE tracking_id=$1 ORDER BY revision DESC',[tracking.tracking_id])).rows:[];
  const finished=first.execution_status!=='in_production'||closed;
  result.push({group,tracking,records,finished,...await qcExecutionWindows(db,id,group,tracking,records,asOf,finished)});
 }
 return result;
}
