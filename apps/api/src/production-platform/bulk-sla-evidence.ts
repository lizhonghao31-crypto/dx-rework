import type {PoolClient} from 'pg';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {bulkFabricFacts} from './bulk-fabric-facts.js';
import {bulkTaskTiming} from './bulk-task-timing.js';
/** Read native facts only. No new SLA fact copy and no guessed cutter receipt. */
export async function bulkSlaEvidence(db:Pick<PoolClient,'query'>,orderId:string){
 const result:Record<string,SlaNodeFact>={};
 if(!(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation)return result;
 const fabric=await bulkFabricFacts(db,orderId);
 if(fabric.report){
  const row=(await db.query('SELECT rule_version,parameters_json FROM digital_sla_order_snapshots WHERE snapshot_id::text=$1 AND production_order_id=$2',[fabric.report.snapshotId??null,orderId])).rows[0];
  const value=row?validateDigitalSlaSnapshot({ruleVersion:row.rule_version,parameters:row.parameters_json}).parameters.fabric_inspection?.value:null;
  result.fabric_inspection={evidence:`task-event:${fabric.report.reportId}`,businessCompleted:fabric.report.result!==null,
   ...(fabric.report.arrivedAt?{startedAt:fabric.report.arrivedAt}:{}),...(fabric.report.inspectedAt?{completedAt:fabric.report.inspectedAt}:{}),
   ...(value?.kind==='duration'?{standardMinutes:value.minutes}:{})};
 }
 const prep=(await db.query(`SELECT p.*,v.published_at FROM digital_bulk_preparations p
   JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version
   JOIN digital_instruction_versions v ON v.production_order_id=p.production_order_id AND v.version=p.instruction_version
   WHERE p.production_order_id=$1 AND p.workflow_version=2 ORDER BY p.created_at DESC LIMIT 1`,[orderId])).rows[0];
 if(!prep)return result;
 result.production_sheet={evidence:`instruction:${orderId}:${prep.instruction_version}`,businessCompleted:true,completedAt:new Date(prep.published_at).toISOString()};
 const tasks=(await db.query(`SELECT t.*,a.task_kind,a.production_order_id FROM digital_production_tasks t
   JOIN digital_production_task_access a USING(task_id) WHERE t.route_instance_id=$1 AND a.production_order_id=$2 AND t.state<>'cancelled'`,[prep.preparation_id,orderId])).rows;
 for(const task of tasks){
  const timing=await bulkTaskTiming(db,task);if(!timing)continue;
  result[task.task_kind]={evidence:`task:${task.task_id}`,businessCompleted:task.state==='completed',
   ...(timing.enteredAt?{startedAt:timing.enteredAt}:{}),...(task.completed_at?{completedAt:new Date(task.completed_at).toISOString()}:{}),
   ...(timing.seconds!==null?{standardMinutes:timing.seconds/60}:{}),
   ...(task.task_kind==='warehouse_preshrink'&&!fabric.usable&&task.state!=='completed'?{waitingFor:{reason:'验布尚未合格或获准使用，预缩仍等待',source:`order:${orderId}:fabric`}}:{})};
 }
 return result;
}
