import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
type DB=Pick<Pool|PoolClient,'query'>;
export const todoContentToken=(parts:unknown)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** Providers supply durable semantic content, never `asOf` or the fixed DTO version. */
export async function applyTodoReadState<T extends Pick<TodoResponse,'todoId'|'sourceAction'|'contentToken'|'unread'|'readAt'>>(db:DB,actor:TrustedActorContext,todos:T[]):Promise<T[]>{
 if(!todos.length)return todos;
 if(!(await db.query("SELECT to_regclass('todo_content_reads') AS relation")).rows[0]?.relation)return todos.map(todo=>{const next={...todo};delete next.contentToken;return next;});
 const taskIds=todos.filter(todo=>todo.sourceAction==='digital_task').map(todo=>todo.todoId);
 const taskTokens=new Map<string,string>();
 if(taskIds.length){
  const rows=(await db.query(`SELECT t.task_id,t.route_version,t.state,a.assignee_id,
    e.event_count FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    LEFT JOIN LATERAL(SELECT count(*)::text AS event_count FROM digital_production_task_events e WHERE e.task_id=t.task_id)e ON true WHERE t.task_id=ANY($1::uuid[])`,[taskIds])).rows;
  for(const row of rows)taskTokens.set(row.task_id,todoContentToken(['task',row.task_id,row.route_version,row.state,row.assignee_id,row.event_count]));
 }
 const tokens=todos.map(todo=>({...todo,...(taskTokens.has(todo.todoId)?{contentToken:taskTokens.get(todo.todoId)!}:{})}));
 const reads=(await db.query('SELECT todo_id,content_token,read_at FROM todo_content_reads WHERE recipient_id=$1 AND todo_id=ANY($2::uuid[])',[actor.actorId,tokens.filter(t=>t.contentToken).map(t=>t.todoId)])).rows;
 const at=new Map(reads.map(row=>[`${row.todo_id}:${row.content_token}`,new Date(row.read_at).toISOString()]));
 return tokens.map(todo=>{if(!todo.contentToken)return todo;const readAt=at.get(`${todo.todoId}:${todo.contentToken}`)??null;return{...todo,readAt,unread:readAt===null};});
}
