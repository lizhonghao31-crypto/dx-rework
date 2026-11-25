import type {PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {developmentNativeReadySql,developmentReadyCorrectionSql,developmentResponsibilityProofSql} from './development-responsibility-window.js';
import {readTaskAccessForPage} from './journey-selection-access.js';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import type {FixedTaskPosition} from './fixed-task-targets.js';

export const taskWithParentsSql=`SELECT t.*,a.production_order_id,a.source_id,a.task_kind,a.assignee_id,a.required_role,${developmentReadyCorrectionSql('t.task_id')} AS ready_correction,
 coalesce((to_jsonb(o)->>'order_time_managed')::boolean,(to_jsonb(s)->>'order_time_managed')::boolean,false) AS order_time_managed,
 (to_jsonb(s)->>'workbench_generated_number')::boolean AS workbench_generated_number
 FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
 LEFT JOIN digital_production_orders o ON o.production_order_id=a.production_order_id
 LEFT JOIN digital_production_sources s ON s.source_id=a.source_id`;

export const effectiveTaskDeadlineSql=`r.entered_at,r.warning_at,r.due_at,p.version,
 CASE WHEN NULLIF(to_jsonb(r)->'sla_basis','null'::jsonb) IS NOT NULL THEN (to_jsonb(r)->'sla_basis'->>'seconds')::numeric ELSE p.sla_seconds END AS sla_seconds,
 to_jsonb(r)->'sla_basis' AS sla_basis,to_jsonb(r)->>'deadline_kind' AS timing_mode,p.label,
 ${developmentResponsibilityProofSql('a',"to_jsonb(r)->'sla_basis'")} AS responsibility_proof,
 ${developmentNativeReadySql('r.task_id',"to_jsonb(r)->'sla_basis'")} AS native_readiness
 FROM digital_production_deadline_revisions r
 JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version
 JOIN app_users u ON u.id=r.changed_by JOIN digital_production_task_access a ON a.task_id=r.task_id`;

type TaskCondition={task_id:string;condition_key:string;stage:string;satisfied:boolean};
type TaskPredecessor={downstream_task_id:string;task_id:string;state:string;task_kind:string;required_role:string;label:string|null};
type TaskCompletion={task_id:string;actor_id:string;actor_name:string;recorded_at:Date};
type TaskAssignment={entity_id:string;created_at:Date;actor_id:string|null;before_state:{assigneeId?:string|null}|null;after_state:{assigneeId?:string|null}|null};

function byTask<T extends {task_id:string}>(rows:readonly T[]){return new Map(rows.map(row=>[row.task_id,row]));}
function group<T>(rows:readonly T[],key:(row:T)=>string){
 const groups=new Map<string,T[]>();
 for(const row of rows){const id=key(row),entries=groups.get(id);if(entries)entries.push(row);else groups.set(id,[row]);}
 return groups;
}

/** This context is read and consumed on the exact page's client. Missing facts
 * and a prepared empty group have different meanings. No reuse across people,
 * transactions or write commands. */
export async function readTaskPageFacts(db:PoolClient,actor:TrustedActorContext,taskIds:readonly string[]){
 const authorization=await readTaskAccessForPage(db,actor,taskIds);
 const ids=[...authorization].filter(([,capabilities])=>capabilities.technical).map(([id])=>id);
 if(!ids.length)return {authorization,tasks:new Map(),deadlines:new Map(),conditions:new Map<string,TaskCondition[]>(),predecessors:new Map<string,TaskPredecessor[]>(),priorities:new Map<string,string>(),positions:new Map<string,FixedTaskPosition>()};
 const tasks=byTask((await db.query(`${taskWithParentsSql} WHERE t.task_id=ANY($1::uuid[])`,[ids])).rows);
 const deadlines=byTask((await db.query(`SELECT DISTINCT ON(r.task_id) r.task_id,${effectiveTaskDeadlineSql}
  WHERE r.task_id=ANY($1::uuid[]) ORDER BY r.task_id,r.revision_id DESC`,[ids])).rows);
 const conditions=(await db.query<TaskCondition>(`SELECT task_id,condition_key,stage,satisfied FROM digital_production_task_conditions
  WHERE task_id=ANY($1::uuid[])`,[ids])).rows;
 const predecessors=(await db.query<TaskPredecessor>(`SELECT d.task_id AS downstream_task_id,p.task_id,p.state,a.task_kind,a.required_role,
   (SELECT label FROM digital_production_deadline_policies WHERE node_key=p.node_key ORDER BY version DESC LIMIT 1) AS label
  FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id
  JOIN digital_production_task_access a ON a.task_id=p.task_id
  WHERE d.task_id=ANY($1::uuid[]) AND p.state<>'completed' AND a.task_kind<>'factory_material_count'`,[ids])).rows;
 const priorityRows=(await db.query<{task_id:string;priority:string}>(`SELECT DISTINCT ON(task_id) task_id,payload->>'priority' AS priority FROM digital_production_task_events
  WHERE task_id=ANY($1::uuid[]) AND event_kind='priority_changed' ORDER BY task_id,recorded_at DESC,event_id DESC`,[ids])).rows;
 const positions=await new FixedTimelineAdoptionRepository(db).available()?byTask((await db.query<FixedTaskPosition&{task_id:string}>(`SELECT task_id,adoption_id,route_ref,route_version,route_position,step_id,phase
  FROM digital_timeline_task_positions WHERE task_id=ANY($1::uuid[])`,[ids])).rows):new Map<string,FixedTaskPosition>();
 return {authorization,tasks,deadlines,positions,conditions:group(conditions,row=>row.task_id),predecessors:group(predecessors,row=>row.downstream_task_id),priorities:new Map(priorityRows.map(row=>[row.task_id,row.priority]))};
}

export async function readTaskPageHistory(db:PoolClient,ids:readonly string[]){
 if(!ids.length)return {completions:new Map<string,TaskCompletion>(),assignments:new Map<string,TaskAssignment[]>()};
 const completions=(await db.query<TaskCompletion>(`SELECT DISTINCT ON(e.task_id) e.task_id,e.actor_id,u.display_name AS actor_name,e.recorded_at
  FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
  WHERE e.task_id=ANY($1::uuid[]) AND e.event_kind='completed' ORDER BY e.task_id,e.recorded_at DESC,e.event_id DESC`,[ids])).rows;
 const assignments=(await db.query<TaskAssignment>(`SELECT entity_id,created_at,actor_id,before_state,after_state FROM audit_events
  WHERE entity_type='digital_task' AND entity_id=ANY($1::text[]) AND action='digital_task_reassigned'
  ORDER BY entity_id,created_at,id`,[ids])).rows;
 return {completions:byTask(completions),assignments:group(assignments,row=>row.entity_id)};
}
