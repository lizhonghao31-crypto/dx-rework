import {DigitalProductionAccessPolicy} from "./access-policy.js";
import type {Pool} from 'pg';
import type {DigitalTaskBlocker} from '@dx-rework/contracts/digital-production-tasks';
import {materialReadiness} from './development-material-readiness.js';

export async function developmentTaskBlockers(db:Pick<Pool,'query'>,task:{task_id:string;source_id:string;route_version:number;task_kind:string;state:string;assignee_id:string|null;required_role:string},canManage:boolean){
  const out:DigitalTaskBlocker[]=[];
  if(['completed','cancelled'].includes(task.state))return out;
  const add=(condition:string,name:string,missing:string,responsibleRole:string,action:string|null=null,evidenceId:string|null=null,verified=false)=>out.push({condition,name,missing,responsibleRole,action,evidenceId,verified});
  const unified=Boolean((await db.query("SELECT to_regclass('digital_development_round_arrangements') AS relation")).rows[0]?.relation);
  if(!task.assignee_id||unified&&!await new DigitalProductionAccessPolicy(db).activeRole(task.assignee_id,task.required_role))add('assignee','办理人',task.assignee_id?'原安排人员当前不可办理':'尚未安排办理人',task.required_role==='sample_designer'?'sample_designer':'development_clerk',canManage?'在本单总委派中安排有效人员':null);
  const conditions=(await db.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND stage='activation' AND NOT satisfied",[task.task_id])).rows;
  const names:Record<string,string>={handover_received:'前序实物交入',pattern_assignment_ready:'主管正式派工',washing_finished:'洗水完成'};
  for(const row of conditions){
    if(row.condition_key==='materials_ready')continue;
    if(unified&&row.condition_key==='pattern_assignment_ready'){
      const native=(await db.query(`SELECT o.status,r.round_type,r.category_id IS NOT NULL AS category_saved,r.price_version IS NOT NULL AND r.agreed_amount IS NOT NULL AND r.quantity IS NOT NULL AND r.unit_price IS NOT NULL AS price_saved FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id) JOIN pattern_room_rounds r ON r.round_id=o.current_round_id WHERE l.source_id=$1 AND o.deleted_at IS NULL`,[task.source_id])).rows[0];
      if(!native)add('execution_link','车板执行资料','尚未建立本单原执行记录','sample_designer','在本单开发资料补齐品类与执行价');
      else if(native.round_type==='rework')add('rework_execution','本轮返工执行','本轮返工执行归属或金额尚未确认','pattern_room_supervisor','在本单原执行记录核定返工金额并安排执行');
      else {
        if(!native.category_saved||!native.price_saved)add('execution_price','首次执行依据','品类或已冻结执行价资料不完整','sample_designer','核实本单原执行资料；文员不能填写或调整价格');
        if(task.assignee_id){const mapped=(await db.query("SELECT count(*)::int n FROM business_people WHERE app_user_id=$1 AND active AND person_type='internal'",[task.assignee_id])).rows[0].n;if(mapped!==1)add('execution_person','车板人员资料','所选人员没有唯一有效的执行身份','root_superuser','由Root核实人员资料后，在总委派页重新核对保存');}
        if(native.category_saved&&native.price_saved)add('execution_activation','首次车板衔接','本轮安排及上方实际前置齐备后自动启动，无需主管另点派工','development_clerk',canManage?'查看本单总委派与任务条件':null);
      }
      continue;
    }
    add(row.condition_key,names[row.condition_key]??'业务前置',row.condition_key==='pattern_assignment_ready'?'原打板执行单尚未完成主管正式派工':`${names[row.condition_key]??'业务前置'}尚未确认`,row.condition_key==='pattern_assignment_ready'?'技术主管':task.required_role);
  }
  const predecessors=(await db.query(`SELECT p.task_id,p.state,a.task_kind,a.required_role,
    (SELECT label FROM digital_production_deadline_policies WHERE node_key=p.node_key ORDER BY version DESC LIMIT 1) AS label
    FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id
    JOIN digital_production_task_access a ON a.task_id=p.task_id WHERE d.task_id=$1 AND p.state<>'completed'`,[task.task_id])).rows;
  for(const row of predecessors)add('predecessor',row.label,`${row.label}尚未完成`,row.required_role);
  if(['development_pattern','development_cutting','development_sewing'].includes(task.task_kind)&&(await db.query("SELECT to_regclass('digital_development_execution_facts') AS relation")).rows[0]?.relation){
    const ready=await materialReadiness(db,task.source_id,task.route_version);
    if(ready.documentMissing)add('development_document','本轮开发资料','尚无本轮可核验开发资料','设计师');
    for(const material of task.task_kind==='development_sewing'?ready.sewingMissing:ready.earlyMissing){
      add(`materials_ready:${material.materialId}`,material.name,material.missing.join('、'),material.earlyException?'设计师':'开发文员',null,material.evidenceId,material.verified);
    }
    for(const report of ready.quality)add('fabric_quality','面料停用／质量决定','建议停用尚未取得允许使用决定','供应链总监',null,report.id);
  }
  return out;
}
