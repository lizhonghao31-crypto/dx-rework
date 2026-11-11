import {DIGITAL_SLA_PARAMETERS} from "@dx-rework/contracts/digital-sla";
import type {Pool} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import {digitalTaskTiming} from '@dx-rework/domain/digital-task-deadline';
import {ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {sourcingAppliedDeadlineSql} from '../production-platform/sla-sourcing-deadline-sql.js';

/** A missing batch deadline is not an unlimited rule. Parameter kinds are code-owned,
 * immutable within the captured SLA rule version; settings only change their values. */
export function explicitlyUnlimitedSla(basis:unknown):boolean {
 if(!basis||typeof basis!=='object'||Array.isArray(basis))return false;
 const value=basis as {seconds?:unknown;parameterKey?:unknown};
 return value.seconds===null&&typeof value.parameterKey==='string'
  &&DIGITAL_SLA_PARAMETERS.some(p=>p.key===value.parameterKey&&p.defaultValue.kind==='unlimited');
}
export function todoSlaTiming(input:{dueAt:string|null;warningAt:string|null;enteredAt:string|null;exclusive?:boolean;unlimited?:boolean;asOf:string}):NonNullable<TodoResponse['timing']>{
 const {state,elapsedSeconds}=digitalTaskTiming({slaHours:null,enteredAt:input.enteredAt,completedAt:null,terminal:false,dueAt:input.dueAt,warningAt:input.warningAt,deadlineExclusive:input.exclusive??false},new Date(input.asOf));
 const status=input.unlimited?'unlimited':!input.dueAt||state==='unknown'?'unknown':state==='overdue'?'overdue':state==='attention'?'warning':input.warningAt?'normal':'unknown';
 return {status,elapsedSeconds,asOf:input.asOf,warningAt:input.warningAt,exclusive:input.exclusive??false,reason:input.unlimited?null:!input.dueAt?'未有可信截止时间，仍按原业务条件办理':status==='unknown'?'已有截止时间，缺少临期起点或比例；已知逾期仍统计':status==='overdue'?'原节点截止已过，进入原办理页处理':status==='warning'?'原节点即将到期，进入原办理页处理':null};
}
/** Enrich only already-authorized personal responses. Never read a whole mother's facts for a worker. */
export async function sourcingTodoPresentation(database:Pool,todos:TodoResponse[]):Promise<TodoResponse[]>{
 const relevant=todos.filter(t=>['pending','blocked_recipient'].includes(t.status)&&t.entityType==='sourcing_case'&&['sourcing_ie_quote','sourcing_management_decision','sourcing_owner_approval'].includes(t.category));
 if(!relevant.length)return todos;
 if(!(await database.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation)return todos;
 const rows=(await database.query(`SELECT t.todo_id,t.due_at,link.production_order_id,creation.after_state->'slaTiming'->>'snapshotId' AS snapshot_id,creation.after_state->'slaTiming'->'orderTime' AS order_time,
   snapshot.parameters_json,${sourcingAppliedDeadlineSql('t')} AS applied
  FROM rework_todos t LEFT JOIN operation_events creation ON creation.event_id=t.created_operation_event_id AND creation.action='todo.create'
  LEFT JOIN digital_production_child_links link ON link.module='sourcing' AND link.child_id::text=t.entity_id
  LEFT JOIN digital_sla_order_snapshots snapshot ON snapshot.snapshot_id::text=creation.after_state->'slaTiming'->>'snapshotId' AND snapshot.production_order_id=link.production_order_id
  WHERE t.todo_id=ANY($1::uuid[]) AND t.recipient_user_id=$2 AND t.status IN ('pending','blocked_recipient')`,[relevant.map(t=>t.todoId),relevant[0]!.recipientUserId])).rows;
 const byId=new Map(rows.map(r=>[r.todo_id,r]));
 return Promise.all(todos.map(async todo=>{const row=byId.get(todo.todoId);if(!row?.production_order_id||!row.snapshot_id&&!row.applied)return todo;
  const key=({sourcing_ie_quote:'sourcing_ie',sourcing_management_decision:'sourcing_selection',sourcing_owner_approval:'sourcing_approval'} as Record<string,string>)[todo.category]!;
  const minutes=row.parameters_json?.[key]?.value?.minutes,ratio=row.applied?.warningPercent??row.parameters_json?.warning_ratio?.value?.percent;
  if(row.order_time?.version===1){const time=await new ContextBusinessClock(database).read({kind:'order',id:row.production_order_id}),dueAt=row.due_at?new Date(row.due_at).toISOString():null;
   return {...todo,dueAt,timing:todoSlaTiming({dueAt,warningAt:row.order_time.warningAt,enteredAt:row.order_time.enteredAt,asOf:time.now})};
  }
  const originalDue=row.due_at?new Date(row.due_at).getTime():null;
  const start=originalDue!==null&&Number.isFinite(minutes)?originalDue-minutes*60000:null;
  const dueAt=row.applied?(row.applied.dueAt?new Date(row.applied.dueAt).toISOString():null):todo.dueAt;
  const warningAt=start!==null&&dueAt&&Number.isFinite(ratio)?new Date(start+(Date.parse(dueAt)-start)*ratio/100).toISOString():null;
  const time=await new ContextBusinessClock(database).read({kind:'order',id:row.production_order_id});
  return {...todo,dueAt,timing:todoSlaTiming({dueAt,warningAt,enteredAt:start===null?null:new Date(start).toISOString(),asOf:time.now})};
 }));
}
