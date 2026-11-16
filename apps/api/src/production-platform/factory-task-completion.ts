import type {PoolClient} from 'pg';
import {factorySlaEvidence} from './factory-sla-evidence.js';
import {factoryCompletionOccurrence} from './factory-completion-occurrence.js';

type DB=Pick<PoolClient,'query'>;
type Task={task_id:string;task_kind:string;route_instance_id:string;production_order_id:string|null;state:string;completed_at:Date|null;completed_quality:string};
const kinds=['process_logistics','bulk_qc','warehouse_dispatch'];
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();

/** Workflow 1 recorded a whole-style handover, without the later physical
 * quantity ledger. Reuse that exact original contract, not invented v2 rows. */
export async function factoryCompletionSource(db:DB,orderId:string){
 const native=await factorySlaEvidence(db,orderId);if(native)return native;
 const route=(await db.query("SELECT r.* FROM digital_factory_routes r WHERE production_order_id=$1 AND coalesce((to_jsonb(r)->>'workflow_version')::int,1)=1",[orderId])).rows[0];
 if(!route)return null;
 const facts=(await db.query('SELECT * FROM digital_factory_facts WHERE preparation_id=$1 ORDER BY sequence',[route.preparation_id])).rows;
 const dispatch=facts.find(fact=>fact.kind==='仓库实际发厂');if(!dispatch)return null;
 const movement=facts.filter(fact=>fact.sequence<dispatch.sequence&&['工艺发出','工艺回仓'].includes(fact.kind)).at(-1);
 const checks=movement?.kind==='工艺回仓'?(await db.query(`SELECT DISTINCT ON(q.line_id) q.* FROM digital_factory_qc q
  JOIN digital_production_po_lines p ON p.line_id=q.line_id AND p.production_order_id=$1
  WHERE q.preparation_id=$2 AND q.return_fact_id=$3 ORDER BY q.line_id,q.sequence DESC`,[orderId,route.preparation_id,movement.fact_id])).rows:[];
 const lineCount=Number((await db.query('SELECT count(*)::int AS count FROM digital_production_po_lines WHERE production_order_id=$1',[orderId])).rows[0].count);
 const craftCovered=lineCount>0&&checks.length===lineCount&&checks.every(check=>check.result==='合格');
 const craftKey=route.secondary_craft==='无'?null:route.secondary_craft==='印花'?'bulk_printing':route.secondary_craft==='绣花'?'bulk_embroidery':'bulk_print_embroidery';
 const windows=[{kind:'warehouse_dispatch',complete:true,completedAt:iso(dispatch.occurred_at)}];
 if(craftKey){windows.push({kind:'process_logistics',complete:craftCovered,completedAt:movement?.kind==='工艺回仓'?iso(movement.occurred_at):null});
  windows.push({kind:'bulk_qc',complete:craftCovered,completedAt:craftCovered&&checks.every(check=>check.checked_at)?new Date(Math.max(...checks.map(check=>new Date(check.checked_at).getTime()))).toISOString():null});}
 return {preparationId:route.preparation_id as string,craftKey,facts:{warehouse_dispatch:{businessCompleted:true,batchCoverageComplete:true},...(craftKey?{[craftKey]:{businessCompleted:craftCovered,batchCoverageComplete:craftCovered},bulk_qc:{businessCompleted:craftCovered,batchCoverageComplete:craftCovered}}:{})},windows};
}

/** Read repair only for the original automatic closeout command. Never replaces
 * an explicit correction (including unknown), or mutates historical events.
 * Batch by original order; do not re-read a factory for every task instance. */
export async function attachFactoryTaskCompletions(db:DB,tasks:Task[]){
 const candidates=tasks.filter(task=>task.state==='completed'&&task.production_order_id&&kinds.includes(task.task_kind));
 if(!candidates.length)return;
 const origins=(await db.query(`SELECT e.task_id,e.payload,
  EXISTS(SELECT 1 FROM digital_production_task_events c WHERE c.task_id=e.task_id AND c.event_kind='time_corrected'
   AND c.corrects_event_id=e.event_id AND c.payload->>'originalKind'='completed') AS corrected
  FROM digital_production_tasks t JOIN LATERAL(SELECT e.* FROM digital_production_task_events e
   WHERE e.task_id=t.task_id AND e.event_kind='completed' ORDER BY e.recorded_at DESC,e.event_id DESC LIMIT 1)e ON true
  JOIN digital_factory_facts f ON f.fact_id::text=e.payload->>'factId' AND f.preparation_id=t.route_instance_id AND f.kind='仓库实际发厂'
  WHERE t.task_id=ANY($1::uuid[])`,[candidates.map(task=>task.task_id)])).rows;
 const legacy=candidates.filter(task=>origins.some(origin=>origin.task_id===task.task_id&&!origin.corrected&&origin.payload.actualSource!=='factory-scoped-occurrence-v1'));
 for(const orderId of new Set(legacy.map(task=>task.production_order_id!))){
  const source=await factoryCompletionSource(db,orderId);
  const own=legacy.filter(task=>task.production_order_id===orderId);
  const positions=source&&'craftSteps'in source?(await db.query('SELECT task_id,step_id FROM digital_timeline_task_positions WHERE task_id=ANY($1::uuid[])',[own.map(task=>task.task_id)])).rows:[];
  for(const task of own){
   const completion=factoryCompletionOccurrence(task,source,positions.find(position=>position.task_id===task.task_id)?.step_id);
   // The original automatic event proves this is a native closeout. Missing
   // or changed physical scope cannot fall back to its registration timestamp.
   task.completed_at=completion.kind==='known'?new Date(completion.at):null;
   if(completion.kind!=='known')task.completed_quality='缺失';
  }
 }
}
