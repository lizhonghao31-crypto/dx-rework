import {DEVELOPMENT_ARRANGEABLE_KINDS} from "@dx-rework/contracts/development-arrangement";
import {DigitalProductionAccessPolicy} from "./access-policy.js";
import type {Pool} from 'pg';
import {digitalConditionGuidance,type DigitalTaskBlocker} from '@dx-rework/contracts/digital-production-tasks';
import {materialReadiness} from './development-material-readiness.js';

export function taskAssigneeBlocker(task:{source_id:string|null;task_kind:string;assignee_id:string|null},planned:boolean):DigitalTaskBlocker {
  return {condition:'assignee',name:'办理人',missing:task.assignee_id?'原安排人员当前不可办理':'尚未安排办理人',responsibleRole:task.source_id||task.task_kind==='bulk_pattern'?'development_clerk':'production_management',action:planned?'请开发文员在本单总委派安排有效人员；技术主管可接管':task.source_id?'请开发文员或技术主管在本任务当前办理页核对有效人员安排':task.task_kind==='bulk_pattern'?'请开发文员在本单产前准备「预派与交付」安排有效纸样师':'请供应链总监在本任务当前办理页改派有效人员；主跟单跟进实际工序',evidenceId:null,verified:true};
}

export async function patternExecutionBlockers(db:Pick<Pool,'query'>,task:{source_id:string|null;assignee_id:string|null},canManage:boolean){
  const out:DigitalTaskBlocker[]=[];
  const add=(condition:string,name:string,missing:string,responsibleRole:string,action:string|null=null)=>out.push({condition,name,missing,responsibleRole,action,evidenceId:null,verified:false});
      const native=(await db.query(`SELECT o.status,r.round_type,r.category_id IS NOT NULL AS category_saved,r.price_version IS NOT NULL AND r.agreed_amount IS NOT NULL AND r.quantity IS NOT NULL AND r.unit_price IS NOT NULL AS price_saved FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id) JOIN pattern_room_rounds r ON r.round_id=o.current_round_id WHERE l.source_id=$1 AND o.deleted_at IS NULL`,[task.source_id])).rows[0];
      if(!native)add('execution_link','车板执行资料','尚未建立本单原执行记录','sample_designer','在本单开发资料补齐品类与执行价');
      else if(native.round_type==='rework')add('rework_execution','本轮返工执行','本轮返工执行归属或金额尚未确认','pattern_room_supervisor','在本单原执行记录核定返工金额并安排执行');
      else {
        if(!native.category_saved||!native.price_saved)add('execution_price','首次执行依据','品类或已冻结执行价资料不完整','sample_designer','核实本单原执行资料；文员不能填写或调整价格');
        let validPerson=false;if(task.assignee_id){const mapped=(await db.query("SELECT count(*)::int n FROM business_people WHERE app_user_id=$1 AND active AND person_type='internal'",[task.assignee_id])).rows[0].n;validPerson=mapped===1;if(!validPerson)add('execution_person','车板人员资料','所选人员没有唯一有效的执行身份','root_superuser','由Root核实人员资料后，在总委派页重新核对保存');}
        if(native.category_saved&&native.price_saved&&validPerson)add('execution_activation','首次车板衔接','本轮安排及上方实际前置齐备后自动启动，无需主管另点派工','development_clerk',canManage?'查看本单总委派与任务条件':null);
      }
  return out;
}

export async function developmentTaskBlockers(db:Pick<Pool,'query'>,task:{task_id:string;source_id:string|null;route_version:number;task_kind:string;state:string;assignee_id:string|null;required_role:string},canManage:boolean,includeCompletion=false){
  const out:DigitalTaskBlocker[]=[];
  if(['completed','cancelled'].includes(task.state))return out;
  const add=(condition:string,name:string,missing:string,responsibleRole:string,action:string|null=null,evidenceId:string|null=null,verified=false)=>out.push({condition,name,missing,responsibleRole,action,evidenceId,verified});
  const unified=Boolean((await db.query("SELECT to_regclass('digital_development_round_arrangements') AS relation")).rows[0]?.relation);
  const planned=task.source_id&&unified&&(DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(task.task_kind);
  if(!task.assignee_id||!await new DigitalProductionAccessPolicy(db).activeRole(task.assignee_id,task.required_role))out.push(taskAssigneeBlocker(task,Boolean(planned)));
  const conditions=(await db.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND (stage='activation' OR $2) AND NOT satisfied",[task.task_id,includeCompletion])).rows;
  for(const row of conditions){
    if(row.condition_key==='materials_ready'&&task.source_id&&['development_pattern','development_cutting','development_sewing'].includes(task.task_kind))continue;
    if(task.source_id&&unified&&row.condition_key==='pattern_assignment_ready'){
      out.push(...await patternExecutionBlockers(db,task,canManage));
      continue;
    }
    out.push({condition:row.condition_key,...digitalConditionGuidance(row.condition_key,task.required_role),evidenceId:null,verified:true});
  }
  const predecessors=(await db.query(`SELECT p.task_id,p.state,a.task_kind,a.required_role,
    (SELECT label FROM digital_production_deadline_policies WHERE node_key=p.node_key ORDER BY version DESC LIMIT 1) AS label
    FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id
    JOIN digital_production_task_access a ON a.task_id=p.task_id WHERE d.task_id=$1 AND p.state<>'completed' AND a.task_kind<>'factory_material_count'`,[task.task_id])).rows;
  for(const row of predecessors)add('predecessor',row.label??'上游工序',`${row.label??'上游工序'}${row.state==='cancelled'?'已取消，不能作为完成依据':'尚未完成'}`,row.required_role,`请该岗位从「我的待办」办理本单${row.label??'上游任务'}；已取消的上游由本单管理人员核对当前轮次`);
  if(task.source_id&&['development_pattern','development_cutting','development_sewing'].includes(task.task_kind)&&(await db.query("SELECT to_regclass('digital_development_execution_facts') AS relation")).rows[0]?.relation){
    const ready=await materialReadiness(db,task.source_id,task.route_version);
    if(ready.documentMissing)add('development_document','本轮开发资料','尚无本轮可核验开发资料','sample_designer','请设计师在本单开发资料核对当前轮次并发布有效资料');
    for(const material of task.task_kind==='development_sewing'?ready.sewingMissing:ready.earlyMissing){
      add(`materials_ready:${material.materialId}`,material.name,material.missing.join('、'),material.earlyException?'sample_designer':'development_clerk',material.earlyException?'请设计师在本单材料记录跟进到料，文员在核料／复核任务核对实际可用情况':'请开发文员在本单核料／复核任务逐项处理上述缺项',material.evidenceId,material.verified);
    }
    for(const report of ready.quality)add('fabric_quality','面料停用／质量决定','建议停用尚未取得允许使用决定','production_management','请供应链总监在本单核料／开发办理页「问题面料报告与决定」明确允许使用或停止使用；到货不能解除质量阻断',report.id);
  }
  return out;
}
