import {preparationAdoption} from './preparation-material-repository.js';
import {preparationWindow} from './production-readiness-repository.js';
import type {PoolClient} from 'pg';
import type {SlaNodeFact,SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {readBulkPreshrinkRequirement,type BulkPreshrinkRequirement} from './bulk-preshrink-requirement.js';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {bulkFabricFacts} from './bulk-fabric-facts.js';
import {bulkTaskTiming} from './bulk-task-timing.js';
/** Read native facts only. No new SLA fact copy and no guessed cutter receipt. */
export async function bulkSlaEvidence(db:Pick<PoolClient,'query'>,orderId:string){
 const result:Record<string,SlaNodeFact>={};
 if(!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return {facts:result,preshrink:null};
 const fabric=await bulkFabricFacts(db,orderId);
 if(fabric.report){
  const row=(await db.query('SELECT rule_version,parameters_json FROM digital_sla_order_snapshots WHERE snapshot_id::text=$1 AND production_order_id=$2',[fabric.report.snapshotId??null,orderId])).rows[0];
  const value=row?validateDigitalSlaSnapshot({ruleVersion:row.rule_version,parameters:row.parameters_json}).parameters.fabric_inspection?.value:null;
  result.fabric_inspection={evidence:`task-event:${fabric.report.reportId}`,businessCompleted:fabric.report.result!==null,
   ...(fabric.report.arrivedAt?{startedAt:fabric.report.arrivedAt}:{}),...(fabric.report.inspectedAt?{completedAt:fabric.report.inspectedAt}:{}),
   ...(value?.kind==='duration'?{standardMinutes:value.minutes}:{})};
 }
 const basis=(await db.query(`SELECT p.*,v.published_at,v.document FROM digital_instruction_documents d
   JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version
   LEFT JOIN digital_bulk_preparations p ON p.production_order_id=v.production_order_id AND p.instruction_version=v.version AND p.source_round=v.source_round
   WHERE d.production_order_id=$1`,[orderId])).rows[0];
 const preshrink=(await readBulkPreshrinkRequirement(db,basis?.preparation_id?basis:null,basis?.document)).requirement;
 const prep=basis?.workflow_version===2?basis:null;
 const adoption=await preparationAdoption(db,{kind:'order',id:orderId});
 const retainLegacy=Boolean(adoption?.standards.retainedInstructionVersion&&prep?.instruction_version<=adoption.standards.retainedInstructionVersion);
 if(adoption&&!retainLegacy){const window=await preparationWindow(db,orderId,'final');
  const completion=(await db.query("SELECT occurred_at FROM digital_preparation_instruction_events WHERE production_order_id=$1 AND kind='published' ORDER BY instruction_version LIMIT 1",[orderId])).rows[0];
  result.production_sheet={evidence:`preparation-window:${orderId}:final`,businessCompleted:Boolean(completion),standardMinutes:adoption.standards.finalMinutes,
   ...(window.startedAt?{startedAt:window.startedAt}:{}),...(completion?{completedAt:new Date(completion.occurred_at).toISOString()}:{})};}
 if(!prep)return {facts:result,preshrink};
 if(!adoption||retainLegacy)result.production_sheet={evidence:`instruction:${orderId}:${prep.instruction_version}`,businessCompleted:true,completedAt:new Date(prep.published_at).toISOString()};
 const tasks=(await db.query(`SELECT t.*,a.task_kind,a.production_order_id FROM digital_production_tasks t
   JOIN digital_production_task_access a USING(task_id) WHERE t.route_instance_id=$1 AND a.production_order_id=$2 AND t.state<>'cancelled'`,[prep.preparation_id,orderId])).rows;
 for(const task of tasks){
  const timing=await bulkTaskTiming(db,task);if(!timing)continue;
  const planNode=task.task_kind==='bulk_cutting_external'?'bulk_cutting':task.task_kind;
  result[planNode]={evidence:`task:${task.task_id}`,businessCompleted:task.state==='completed',
   ...(timing.enteredAt?{startedAt:timing.enteredAt}:{}),...(task.completed_at?{completedAt:new Date(task.completed_at).toISOString()}:{}),
   standardWarningPercent:timing.warningRatio*100,standardMinutes:timing.seconds!==null?timing.seconds/60:null,
   ...(task.task_kind==='warehouse_preshrink'&&!fabric.usable&&task.state!=='completed'?{waitingFor:{reason:'验布尚未合格或获准使用，预缩仍等待',source:`order:${orderId}:fabric`}}:{})};
 }
 return {facts:result,preshrink};
}

/** Applicability is a read projection; the frozen plan and actual task clocks stay intact. */
export function bulkEvaluationPlan(plan:SlaPlan,preshrink:BulkPreshrinkRequirement|null,facts:Record<string,SlaNodeFact>):SlaPlan{
 // A real completed preshrink remains a historical fact, even if its time is unknown.
 if(preshrink!=='无需预缩'||facts.warehouse_preshrink?.businessCompleted||facts.warehouse_preshrink?.completedAt)return plan;
 const result=structuredClone(plan);
 for(const node of result.nodes){
  if(node.id==='warehouse_preshrink')node.applicable='no';
  if(node.id==='bulk_cutting')node.dependsOn=[...new Set(node.dependsOn.map(id=>id==='warehouse_preshrink'?'fabric_inspection':id))];
 }
 return result;
}
