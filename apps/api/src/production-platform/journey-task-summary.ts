import type {Pool,PoolClient} from 'pg';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {developmentRoute} from './development-route.js';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
const excluded=new Set(['development_material_supply','development_craft_dispatch','development_sewing_transfer','development_washing_dispatch']);
const iso=(value:Date|string|null|undefined)=>value==null?null:new Date(value).toISOString();
/** Internal read-only selection facts. Never returned as an executable task DTO. */
export async function journeyTaskSummaries(db:Pick<Pool|PoolClient,'query'>,ids:string[]):Promise<Map<string,DigitalTask>>{
 if(!ids.length)return new Map();
 const rows=(await db.query(`SELECT t.*,a.source_id,a.production_order_id,a.task_kind,a.assignee_id,a.required_role,
   owner.display_name AS assignee_name,life.state='paused' AS paused,
   effective.due_at,effective.warning_at,coalesce(effective.version,policy.version) AS policy_version,
   CASE WHEN effective.version IS NOT NULL THEN effective.sla_seconds ELSE policy.sla_seconds END AS sla_seconds,
   coalesce(effective.label,policy.label) AS label,route.tasks AS route_tasks,
   document.document AS published_document,revision.route_nodes
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
  WHERE t.task_id=ANY($1::uuid[])`,[ids])).rows;
 return new Map(rows.map(row=>{
  const routeRows=row.route_tasks??[];
  const declared=row.published_document?(row.route_version===1?['development_materials',...developmentRoute(row.published_document as DevelopmentDocument)]:row.route_nodes??[]):null;
  const business=declared?.filter((key:string)=>!excluded.has(key));
  const routeProgress=business?{applicable:business.length,completed:business.filter((key:string)=>routeRows.some((task:{node:string;state:string})=>task.node===key&&task.state==='completed')).length,cancelled:business.filter((key:string)=>routeRows.some((task:{node:string;state:string})=>task.node===key&&task.state==='cancelled')&&!routeRows.some((task:{node:string;state:string})=>task.node===key&&task.state==='completed')).length}:{applicable:routeRows.filter((task:{key:string})=>!excluded.has(task.key)).length,completed:routeRows.filter((task:{key:string;state:string})=>!excluded.has(task.key)&&task.state==='completed').length,cancelled:routeRows.filter((task:{key:string;state:string})=>!excluded.has(task.key)&&task.state==='cancelled').length};
  const value:DigitalTask={identity:null,priority:'normal',taskId:row.task_id,orderId:row.production_order_id,sourceId:row.source_id,taskKind:row.task_kind,label:row.label,routeProgress,
   assigneeName:row.assignee_name??null,requiredRole:row.required_role,hasHandover:false,canManage:false,canControl:false,canCorrect:false,assigneeId:row.assignee_id,
   state:row.state,routeVersion:row.route_version,occurrence:row.occurrence,enteredAt:iso(row.entered_at),recordedAt:iso(row.created_at)!,completedAt:iso(row.completed_at),paused:Boolean(row.paused),dueAt:iso(row.due_at),warningAt:iso(row.warning_at),slaHours:row.sla_seconds===null?null:Number(row.sla_seconds)/3600,policyVersion:row.policy_version,timeQuality:row.entered_quality,blockedReason:row.blocked_reason,canExecute:false};
  return [value.taskId,value];
 }));
}
