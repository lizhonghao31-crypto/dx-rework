import type {Pool} from 'pg';
import type {DigitalTaskBlocker} from '@dx-rework/contracts/digital-production-tasks';
import {materialReadiness} from './development-material-readiness.js';

export async function developmentTaskBlockers(db:Pick<Pool,'query'>,task:{task_id:string;source_id:string;route_version:number;task_kind:string;state:string;assignee_id:string|null;required_role:string},canManage:boolean){
  const out:DigitalTaskBlocker[]=[];
  if(['completed','cancelled'].includes(task.state))return out;
  const add=(condition:string,name:string,missing:string,responsibleRole:string,action:string|null=null,evidenceId:string|null=null,verified=false)=>out.push({condition,name,missing,responsibleRole,action,evidenceId,verified});
  if(!task.assignee_id)add('assignee','办理人','尚未分派办理人','技术主管／开发文员',canManage?'分派办理人':null);
  const conditions=(await db.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND stage='activation' AND NOT satisfied",[task.task_id])).rows;
  const names:Record<string,string>={handover_received:'前序实物交入',pattern_assignment_ready:'主管正式派工',washing_finished:'洗水完成'};
  for(const row of conditions){
    if(row.condition_key==='materials_ready')continue;
    add(row.condition_key,names[row.condition_key]??'业务前置',row.condition_key==='pattern_assignment_ready'?'原打板执行单尚未完成主管正式派工':`${names[row.condition_key]??'业务前置'}尚未确认`,row.condition_key==='pattern_assignment_ready'?'技术主管':task.required_role);
  }
  const predecessors=(await db.query(`SELECT p.task_id,p.state,a.task_kind,a.required_role,
    (SELECT label FROM digital_production_deadline_policies WHERE node_key=p.node_key ORDER BY version DESC LIMIT 1) AS label
    FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id
    JOIN digital_production_task_access a ON a.task_id=p.task_id WHERE d.task_id=$1 AND p.state<>'completed'`,[task.task_id])).rows;
  for(const row of predecessors)add('predecessor',row.label,`${row.label}尚未完成`,row.required_role);
  if(['development_pattern','development_cutting','development_sewing'].includes(task.task_kind)&&(await db.query("SELECT to_regclass('digital_development_execution_facts') AS relation")).rows[0]?.relation){
    const ready=await materialReadiness(db,task.source_id,task.route_version);
    for(const material of task.task_kind==='development_sewing'?ready.sewingMissing:ready.earlyMissing){
      add(`materials_ready:${material.materialId}`,material.name,material.missing.join('、'),material.earlyException?'设计师':'开发文员',null,material.evidenceId,material.verified);
    }
    for(const report of ready.quality)add('fabric_quality','面料停用／质量决定','建议停用尚未取得允许使用决定','供应链总监',null,report.id);
  }
  return out;
}
