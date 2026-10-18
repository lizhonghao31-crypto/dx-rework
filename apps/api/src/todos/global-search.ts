import type { Pool } from 'pg';
import type { TodoResponse } from '@dx-rework/contracts';
import { todoSearchLabels } from './todo-search-labels.js';

type Item={kind:'database'|'provider';value:Record<string,unknown>};
export async function globalTodoSearch(database:Pool,contextSql:string,actorId:string,query:string,requestedPage:number,providers:readonly {module:string;todo:TodoResponse}[]) {
 const upper=query.toUpperCase();
 const matches=providers.filter(({module,todo})=>todo.recipientUserId===actorId&&todo.todoType!=='information'&&['pending','blocked_recipient'].includes(todo.status)&&todo.category!=='wage_month_close'&&[
   todoSearchLabels[module],todoSearchLabels[todo.category],todo.taskTitle,todo.orderContext?.styleNo,todo.orderContext?.supplierName,todo.orderContext?.merchandiserName,todo.orderContext?.orderNo,todo.orderContext?.reworkNo,
 ].some(value=>value?.toUpperCase().includes(upper))).map(({todo})=>todo);
 const result=await database.query<{total_count:string|number;total_pages:number;page:number;items:Item[]}>(`WITH todo_view AS (${contextSql}), candidates AS (
   SELECT todo_id,status_rank,due_at,created_at,'database'::text kind,to_jsonb(todo_view) value,1 priority
   FROM todo_view
   WHERE recipient_user_id=$1 AND todo_type<>'information' AND status IN ('pending','blocked_recipient')
     AND category<>'wage_month_close' AND (rework_status IS NULL OR rework_status<>'deleted') AND pattern_deleted_at IS NULL
     AND (strpos(upper(COALESCE(style_no,sourcing_style_no,'')),upper($2))>0
       OR strpos(upper(COALESCE(sample_style_no,pattern_style_no,'')),upper($2))>0
       OR strpos(upper(COALESCE(supplier_name_snapshot,'')),upper($2))>0
       OR strpos(upper(COALESCE(sample_code,pattern_order_no,'')),upper($2))>0
       OR strpos(upper(COALESCE(merchandiser_name,'')),upper($2))>0
       OR strpos(upper(concat_ws(' ',rework_no,order_no,sourcing_order_no)),upper($2))>0
       OR strpos(upper(COALESCE($5::jsonb->>category,'')),upper($2))>0
       OR strpos(upper(COALESCE($5::jsonb->>todo_module,'')),upper($2))>0)
   UNION ALL
   SELECT (item->>'todoId')::uuid,CASE item->>'status' WHEN 'pending' THEN 0 ELSE 1 END,
     NULLIF(item->>'dueAt','')::timestamptz,(item->>'createdAt')::timestamptz,'provider',item,0
   FROM jsonb_array_elements($3::jsonb) item
 ), unique_candidates AS (
   SELECT DISTINCT ON(todo_id) * FROM candidates ORDER BY todo_id,priority
 ), counts AS (SELECT count(*)::int total_count,ceil(count(*)::numeric/15)::int total_pages FROM unique_candidates), paging AS (
   SELECT *,CASE WHEN total_pages=0 THEN 1 ELSE LEAST($4::int,total_pages) END page FROM counts
 ), selected AS (
   SELECT * FROM unique_candidates ORDER BY status_rank,due_at ASC NULLS LAST,created_at DESC,todo_id DESC
   LIMIT 15 OFFSET ((SELECT page FROM paging)-1)*15
 ) SELECT total_count,total_pages,page,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind,'value',value) ORDER BY status_rank,due_at ASC NULLS LAST,created_at DESC,todo_id DESC) FROM selected),'[]'::jsonb) items
 FROM paging`,[actorId,query,JSON.stringify(matches),requestedPage,JSON.stringify(todoSearchLabels)]);
 return result.rows[0]??{total_count:0,total_pages:0,page:1,items:[]};
}
