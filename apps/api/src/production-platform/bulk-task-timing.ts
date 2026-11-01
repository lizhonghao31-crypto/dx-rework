import {slaApplications,appliedSlaWindow} from './sla-applied-window.js';
import {bulkFabricFacts} from "./bulk-fabric-facts.js";
import type {PoolClient} from 'pg';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
/** Original business anchors, independent of task assignment/readiness. No receipt-input API. */
export async function bulkTaskTiming(db:Pick<PoolClient,'query'>,task:{task_id:string;production_order_id:string|null;task_kind:string;route_instance_id:string}){
 if(!task.production_order_id||!['bulk_pattern','warehouse_preshrink','bulk_cutting','bulk_cutting_external'].includes(task.task_kind))return null;
 const row=(await db.query(`SELECT p.preparation_id,p.supplement_of_preparation_id,coalesce(origin.sla_snapshot_id,p.sla_snapshot_id) AS sla_snapshot_id,coalesce(first_sheet.published_at,v.published_at) AS published_at,s.rule_version,s.parameters_json
   FROM digital_bulk_preparations p JOIN digital_instruction_versions v ON v.production_order_id=p.production_order_id AND v.version=p.instruction_version
   LEFT JOIN digital_bulk_preparations origin ON origin.preparation_id=p.clock_origin_preparation_id
   LEFT JOIN digital_instruction_versions first_sheet ON first_sheet.production_order_id=origin.production_order_id AND first_sheet.version=origin.instruction_version
   JOIN digital_sla_order_snapshots s ON s.snapshot_id=coalesce(origin.sla_snapshot_id,p.sla_snapshot_id) AND s.production_order_id=p.production_order_id
   WHERE p.preparation_id=$1 AND p.production_order_id=$2 AND p.workflow_version=2`,[task.route_instance_id,task.production_order_id])).rows[0];
 if(!row)return null;
 const applications=await slaApplications(db,task.production_order_id);
 const applied=appliedSlaWindow(validateDigitalSlaSnapshot({ruleVersion:row.rule_version,parameters:row.parameters_json}),task.task_kind,`task:${task.task_id}`,applications);
 const snapshot=applied.snapshot;
 const parameter=snapshot.parameters[task.task_kind]?.value,warning=snapshot.parameters.warning_ratio?.value;
 if(warning?.kind!=='ratio')throw new Error('Invalid frozen bulk warning ratio');
 const supplemental=task.task_kind==='bulk_pattern'&&Boolean(row.supplement_of_preparation_id);
 const configured=applications.some(a=>a.keys.includes(task.task_kind)&&!a.excluded.includes(`task:${task.task_id}`));
 const seconds=supplemental&&!configured?null:parameter?.kind==='duration'?parameter.minutes*60:null;
 // Fabric release and trustworthy cutting receipt must come from their own facts.
 // Until those adapters supply evidence, unknown is not preparation/dispatch time.
 let timeQuality='缺失';
 let enteredAt=task.task_kind==='bulk_pattern'?new Date(row.published_at).toISOString():null;
 if(enteredAt)timeQuality='现场登记';
 if(task.task_kind==='warehouse_preshrink'){
  const original=(await db.query("SELECT entered_at,sla_basis FROM digital_production_deadline_revisions WHERE task_id=$1 AND entered_at IS NOT NULL ORDER BY revision_id LIMIT 1",[task.task_id])).rows[0];
  const fabric=await bulkFabricFacts(db,task.production_order_id);
  enteredAt=original?new Date(original.entered_at).toISOString():fabric.usableAt;
  timeQuality=original?.sla_basis?.timeQuality??fabric.usableQuality;
 }
 return {snapshotId:applied.snapshotId??row.sla_snapshot_id,parameterKey:task.task_kind,enteredAt,timeQuality,seconds,warningRatio:warning.percent/100,
   basis:enteredAt?[...(supplemental?['supplement:original-completed-range-retained']:[]),`instruction:${task.production_order_id}:${row.preparation_id}:published`]:[]};
}
