import type {Pool,PoolClient} from 'pg';
import type {SlaNodeFact,SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
type DB=Pick<Pool|PoolClient,'query'>;
/** special_process_type describes an extra process, not the whole order. Only worker items define this execution window. */
export async function nativeReworkExecutionRows(db:DB,reworkIds:string[],orderId:string|null=null){
 if(!reworkIds.length)return [];
 return (await db.query(`SELECT r.rework_order_id,r.status,r.special_process_type,
  start.event_id AS start_event_id,start.created_at AS started_at,snapshot.snapshot_id,snapshot.rule_version,snapshot.parameters_json,
  count(DISTINCT item.configuration_item_id)::int AS item_count,count(DISTINCT task.configuration_item_id)::int AS assigned_items,
  count(DISTINCT task.work_task_id)::int AS task_count,count(DISTINCT report.work_task_id)::int AS completed_tasks,max(report.completed_at) AS completed_at
  FROM rework_orders r
  LEFT JOIN LATERAL(SELECT event_id,created_at FROM operation_events WHERE entity_type='rework_order' AND entity_id=r.rework_order_id::text
   AND action='rework.work_task.assignment_confirm' ORDER BY created_at DESC,event_id DESC LIMIT 1) start ON true
  LEFT JOIN LATERAL(SELECT snapshot_id,rule_version,parameters_json FROM digital_sla_order_snapshots WHERE production_order_id=$2 AND created_at<=start.created_at ORDER BY revision DESC LIMIT 1) snapshot ON true
  LEFT JOIN rework_process_configurations configuration ON configuration.rework_order_id=r.rework_order_id AND configuration.status='approved'
  LEFT JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id AND item.execution_kind='worker'
  LEFT JOIN rework_work_tasks task ON task.configuration_item_id=item.configuration_item_id AND task.status='active'
  LEFT JOIN rework_work_reports report ON report.work_task_id=task.work_task_id AND report.status='submitted' AND report.completed_at>=start.created_at
   AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
  WHERE r.rework_order_id=ANY($1::uuid[]) AND r.status NOT IN ('deleted','cancelled')
  GROUP BY r.rework_order_id,r.status,r.special_process_type,start.event_id,start.created_at,snapshot.snapshot_id,snapshot.rule_version,snapshot.parameters_json HAVING count(DISTINCT item.configuration_item_id)>0`,[reworkIds,orderId])).rows;
}
export async function reworkSlaEvidence(db:DB,orderId:string){
 const links=(await db.query("SELECT child_id,line_id FROM digital_production_child_lines WHERE module='rework' AND production_order_id=$1",[orderId])).rows;
 const native=await nativeReworkExecutionRows(db,links.map(l=>l.child_id),orderId);
 const rows=links.flatMap(l=>native.filter(r=>r.rework_order_id===l.child_id).map(r=>({...r,line_id:l.line_id})));
 const windows=rows.map(r=>{
  const frozen=r.snapshot_id?validateDigitalSlaSnapshot({ruleVersion:r.rule_version,parameters:r.parameters_json}):null;
  const parameter=frozen?.parameters.garment_rework?.value,warning=frozen?.parameters.warning_ratio?.value;
  const minutes=parameter?.kind==='duration'?parameter.minutes:null;
  const startedAt=r.started_at?new Date(r.started_at).toISOString():null;
  const complete=!!startedAt&&r.item_count>0&&r.item_count===r.assigned_items&&r.task_count>0&&r.task_count===r.completed_tasks;
  return {lineId:r.line_id as string,reworkId:r.rework_order_id as string,startedAt,completedAt:complete&&r.completed_at?new Date(r.completed_at).toISOString():null,complete,
   deadline:startedAt&&minutes!==null?new Date(Date.parse(startedAt)+minutes*60000).toISOString():null,warningAt:startedAt&&minutes!==null&&warning?.kind==='ratio'?new Date(Date.parse(startedAt)+minutes*60000*warning.percent/100).toISOString():null,
   evidence:`rework:${r.rework_order_id}:assignment:${r.start_event_id??'unknown'}:effective-worker-reports`,snapshotId:r.snapshot_id??null};
 });
 const facts:Record<string,SlaNodeFact>={};
 for(const lineId of new Set(windows.map(w=>w.lineId))){const parts=windows.filter(w=>w.lineId===lineId),done=parts.every(w=>w.complete);
  facts[`garment_rework:${lineId}`]={businessCompleted:done,batchCoverageComplete:parts.every(w=>!!w.startedAt),batchWindows:parts,evidence:parts.map(w=>w.evidence).join(','),
   ...(parts.every(w=>w.startedAt)?{startedAt:new Date(Math.min(...parts.map(w=>Date.parse(w.startedAt!)))).toISOString()}:{}),
   ...(done&&parts.every(w=>w.completedAt)?{completedAt:new Date(Math.max(...parts.map(w=>Date.parse(w.completedAt!)))).toISOString()}:{}),};
 }
 return {facts,windows};
}
export function reworkEvaluationPlan(plan:SlaPlan,facts:Record<string,SlaNodeFact>){
 const copy=structuredClone(plan);
 for(const node of copy.nodes)if(node.id.startsWith('garment_rework:')){
  node.applicable=facts[node.id]?'yes':'no';
  const packing=copy.nodes.find(n=>n.id===node.id.replace('garment_rework:','garment_packing:'));
  if(facts[node.id]&&packing&&!packing.dependsOn.includes(node.id))packing.dependsOn.push(node.id);
 }
 return copy;
}
