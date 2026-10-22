import type {Pool,PoolClient} from 'pg';
import {taskAssigneeBlocker,patternExecutionBlockers} from './development-task-blockers.js';
import {DEVELOPMENT_ARRANGEABLE_KINDS} from '@dx-rework/contracts/development-arrangement';
import {digitalConditionGuidance,type DigitalTaskBlocker} from '@dx-rework/contracts/digital-production-tasks';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {developmentRoute} from './development-route.js';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
const excluded=new Set(['development_material_supply','development_craft_dispatch','development_sewing_transfer','development_washing_dispatch']);
const iso=(value:Date|string|null|undefined)=>value==null?null:new Date(value).toISOString();
/** Internal read-only selection facts. Never returned as an executable task DTO. */
type SummaryTask=DigitalTask&{completionKeys:string[];completion:{actor_id:string;actor_name:string;recorded_at:string}|null;laterOwner:{assigneeId:string|null}|null;previousOwnerName:string|null};
export async function journeyTaskSummaries(db:Pick<Pool|PoolClient,'query'>,ids:string[]):Promise<Map<string,SummaryTask>>{
 if(!ids.length)return new Map();
 const rows=(await db.query(`SELECT t.*,a.source_id,a.production_order_id,a.task_kind,a.assignee_id,a.required_role,
   owner.display_name AS assignee_name,life.state='paused' AS paused,
   effective.due_at,effective.warning_at,coalesce(effective.version,policy.version) AS policy_version,
   CASE WHEN effective.version IS NOT NULL THEN effective.sla_seconds ELSE policy.sla_seconds END AS sla_seconds,
   coalesce(effective.label,policy.label) AS label,route.tasks AS route_tasks,
   document.document AS published_document,revision.route_nodes,
   coalesce(conditions.activation,ARRAY[]::text[]) AS condition_keys,
   coalesce(conditions.completion,ARRAY[]::text[]) AS completion_keys,
   coalesce(predecessors.facts,'[]'::jsonb) AS predecessors,
   EXISTS(SELECT 1 FROM app_users eligible JOIN user_role_assignments assigned ON assigned.user_id=eligible.id
     JOIN business_roles role ON role.role_code=assigned.role_code AND role.enabled
     WHERE eligible.id=a.assignee_id AND eligible.enabled AND NOT coalesce((to_jsonb(eligible)->>'manual_access_disabled')::boolean,false)
       AND assigned.revoked_at IS NULL AND (assigned.role_code=a.required_role OR a.required_role='warehouse_receiver' AND assigned.role_code='warehouse_supervisor')
       AND EXISTS(SELECT 1 FROM identity_mappings identity WHERE identity.user_id=eligible.id AND identity.active AND identity.employed)) AS assignee_active,
   completion.event AS completion,later.before_state AS later_owner,previous_owner.display_name AS previous_owner_name
  FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  LEFT JOIN app_users owner ON owner.id=a.assignee_id
  LEFT JOIN digital_production_resource_lifecycle life ON life.resource_kind=CASE WHEN a.production_order_id IS NULL THEN 'source' ELSE 'order' END AND life.resource_id=coalesce(a.production_order_id,a.source_id)
  LEFT JOIN LATERAL(SELECT r.due_at,r.warning_at,p.version,p.sla_seconds,p.label FROM digital_production_deadline_revisions r
    JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version JOIN app_users u ON u.id=r.changed_by
    WHERE r.task_id=t.task_id ORDER BY r.revision_id DESC LIMIT 1)effective ON true
  LEFT JOIN LATERAL(SELECT version,sla_seconds,label FROM digital_production_deadline_policies WHERE node_key=a.task_kind ORDER BY version DESC LIMIT 1)policy ON true
  LEFT JOIN LATERAL(SELECT json_agg(json_build_object('node',CASE WHEN node_key='development_material_recheck' THEN 'development_materials' ELSE node_key END,'key',node_key,'state',state)) AS tasks
    FROM digital_production_tasks prior WHERE prior.route_instance_id=t.route_instance_id
    AND NOT EXISTS(SELECT 1 FROM digital_production_task_events event WHERE event.task_id=prior.task_id AND event.event_kind='material_returned'))route ON true
  LEFT JOIN digital_development_documents document ON document.source_id=a.source_id AND document.status='published'
  LEFT JOIN digital_development_rounds revision ON revision.source_id=a.source_id AND revision.round_number=t.route_version
  LEFT JOIN LATERAL(SELECT array_agg(condition_key ORDER BY condition_key) FILTER(WHERE stage='activation') AS activation,
    array_agg(condition_key ORDER BY condition_key) FILTER(WHERE stage='completion') AS completion FROM digital_production_task_conditions WHERE task_id=t.task_id AND NOT satisfied)conditions ON true
  LEFT JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('name',coalesce(label.label,prior.node_key),'state',prior.state,'role',access.required_role)) AS facts
    FROM digital_production_task_dependencies dependency JOIN digital_production_tasks prior ON prior.task_id=dependency.predecessor_id
    JOIN digital_production_task_access access ON access.task_id=prior.task_id
    LEFT JOIN LATERAL(SELECT label FROM digital_production_deadline_policies WHERE node_key=prior.node_key ORDER BY version DESC LIMIT 1)label ON true
    WHERE dependency.task_id=t.task_id AND prior.state<>'completed')predecessors ON true
  LEFT JOIN LATERAL(SELECT jsonb_build_object('actor_id',e.actor_id,'actor_name',u.display_name,'recorded_at',e.recorded_at) AS event,e.recorded_at
    FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id WHERE e.task_id=t.task_id AND e.event_kind='completed' ORDER BY e.recorded_at DESC,e.event_id DESC LIMIT 1)completion ON true
  -- Rich projection compares JS Dates, which retain milliseconds only.
  LEFT JOIN LATERAL(SELECT before_state FROM audit_events WHERE entity_type='digital_task' AND entity_id=t.task_id::text AND action='digital_task_reassigned' AND date_trunc('milliseconds',created_at)>date_trunc('milliseconds',completion.recorded_at) ORDER BY created_at,id LIMIT 1)later ON true
  LEFT JOIN app_users previous_owner ON previous_owner.id=(later.before_state->>'assigneeId')::uuid
  WHERE t.task_id=ANY($1::uuid[])`,[ids])).rows;
 const result=new Map<string,SummaryTask>();
 for(const row of rows){
  const routeRows=row.route_tasks??[];
  const declared=row.published_document?(row.route_version===1?['development_materials',...developmentRoute(row.published_document as DevelopmentDocument)]:row.route_nodes??[]):null;
  const business=declared?.filter((key:string)=>!excluded.has(key));
  const routeProgress=business?{applicable:business.length,completed:business.filter((key:string)=>routeRows.some((task:{node:string;state:string})=>task.node===key&&task.state==='completed')).length,cancelled:business.filter((key:string)=>routeRows.some((task:{node:string;state:string})=>task.node===key&&task.state==='cancelled')&&!routeRows.some((task:{node:string;state:string})=>task.node===key&&task.state==='completed')).length}:{applicable:routeRows.filter((task:{key:string})=>!excluded.has(task.key)).length,completed:routeRows.filter((task:{key:string;state:string})=>!excluded.has(task.key)&&task.state==='completed').length,cancelled:routeRows.filter((task:{key:string;state:string})=>!excluded.has(task.key)&&task.state==='cancelled').length};
  const unmet:DigitalTaskBlocker[]=[];
  if(!['completed','cancelled'].includes(row.state)){
   if(!row.assignee_active)unmet.push(taskAssigneeBlocker(row,Boolean(row.source_id&&(DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(row.task_kind))));
   for(const key of row.condition_keys){
    if(key==='pattern_assignment_ready'&&row.source_id)unmet.push(...await patternExecutionBlockers(db,row,false));
    else unmet.push({condition:key,...digitalConditionGuidance(key,row.required_role),evidenceId:null,verified:true});
   }
   for(const prior of row.predecessors)unmet.push({condition:'predecessor',name:prior.name,missing:prior.name+(prior.state==='cancelled'?'已取消，不能作为完成依据':'尚未完成'),responsibleRole:prior.role,action:`请该岗位从「我的待办」办理本单${prior.name}；已取消的上游由本单管理人员核对当前轮次`,evidenceId:null,verified:true});
  }
  const value:SummaryTask={unmetConditions:unmet,completionKeys:row.completion_keys,completion:row.completion,laterOwner:row.later_owner,previousOwnerName:row.previous_owner_name,identity:null,priority:'normal',taskId:row.task_id,orderId:row.production_order_id,sourceId:row.source_id,taskKind:row.task_kind,label:row.label,routeProgress,
   assigneeName:row.assignee_name??null,requiredRole:row.required_role,hasHandover:false,canManage:false,canControl:false,canCorrect:false,assigneeId:row.assignee_id,
   state:row.state,routeVersion:row.route_version,occurrence:row.occurrence,enteredAt:iso(row.entered_at),recordedAt:iso(row.created_at)!,completedAt:iso(row.completed_at),paused:Boolean(row.paused),dueAt:iso(row.due_at),warningAt:iso(row.warning_at),slaHours:row.sla_seconds===null?null:Number(row.sla_seconds)/3600,policyVersion:row.policy_version,timeQuality:row.entered_quality,blockedReason:row.blocked_reason,canExecute:false};
  result.set(value.taskId,value);
 }
 return result;
}
