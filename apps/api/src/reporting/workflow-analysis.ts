import {WorkflowAnalysisQuerySchema,type WorkflowAnalysisResponse} from '@dx-rework/contracts';
import type {Pool} from 'pg';
import {workflowAnalysisResult} from './workflow-analysis-model.js';
import {ApplicationError} from '../platform/errors.js';
type ReworkDetail = 'summary'|'history'|'full';
function reworkFlowSql(detail:ReworkDetail){
 return `WITH snapshots AS (
 SELECT e.event_id,e.entity_id,e.action,e.actor_id,e.created_at,COALESCE(before_state->>'status',lag(after_state->>'status') OVER(PARTITION BY entity_id ORDER BY created_at,event_id)) previous,
 after_state->>'status' AS next
 FROM operation_events e WHERE entity_type='rework_order' AND action LIKE 'rework.%' AND after_state->>'status' IS NOT NULL AND ($5::uuid[] IS NULL OR e.entity_id=ANY($5::uuid[]::text[]))
), changes AS (
 SELECT event_id::text id,entity_id,previous,next,action,actor_id,created_at,
 lead(created_at) OVER(PARTITION BY entity_id ORDER BY created_at,event_id) left_at
 FROM snapshots WHERE previous IS DISTINCT FROM next AND (previous IS NOT NULL OR action='rework.draft.create')
) SELECT r.rework_order_id::text id,'rework' kind,COALESCE(r.rework_no,r.rework_order_id::text) AS label,r.status,
 r.created_at AS "createdAt",r.style_no AS "styleNo",r.order_no AS "orderNo",false AS "independentFinance",
 (SELECT created_at FROM changes e WHERE e.entity_id=r.rework_order_id::text AND e.next=r.status AND e.left_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) AS "enteredAt",
${detail==='full'?
 ` (SELECT u.display_name FROM changes e LEFT JOIN app_users u ON u.id=e.actor_id WHERE e.entity_id=r.rework_order_id::text AND e.next=r.status AND e.left_at IS NULL ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS "submitterName",
 COALESCE((SELECT jsonb_agg(DISTINCT u.display_name) FROM rework_todos t JOIN app_users u ON u.id=t.recipient_user_id
 WHERE t.status='pending' AND t.todo_type='business_action' AND (t.route_descriptor->>'reworkOrderId'=r.rework_order_id::text OR (t.entity_type='rework_order' AND t.entity_id=r.rework_order_id::text))),'[]'::jsonb) handlers,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('taskId',t.work_task_id,'processName',i.process_name,
 'people',COALESCE((SELECT jsonb_agg(m.display_name_snapshot ORDER BY m.display_name_snapshot) FROM rework_work_task_members m WHERE m.work_task_id=t.work_task_id),'[]'::jsonb),
 'reports',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.work_report_id,'quantity',w.actual_quantity::text,'at',w.completed_at,'actorName',u.display_name,
 'rejected',EXISTS(SELECT 1 FROM rework_work_report_rejections rejected WHERE rejected.work_report_id=w.work_report_id)) ORDER BY w.completed_at,w.work_report_id)
 FROM rework_work_reports w LEFT JOIN app_users u ON u.id=w.submitted_by WHERE w.work_task_id=t.work_task_id),'[]'::jsonb)) ORDER BY i.position,t.work_task_id)
 FROM rework_work_tasks t JOIN rework_process_configuration_items i ON i.configuration_item_id=t.configuration_item_id WHERE t.rework_order_id=r.rework_order_id AND t.status='active'),'[]'::jsonb) execution,`:"NULL::text AS \"submitterName\",'[]'::jsonb handlers,'[]'::jsonb execution,"}
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.event_id::text,'from',COALESCE(change.previous,e.before_state->>'status'),'to',e.after_state->>'status','action',e.action,
 'changesNode',change.id IS NOT NULL,'enteredAt',e.created_at,'leftAt',change.left_at,
 ${detail==='summary'?"":"'actorName',u.display_name,'reason',e.reason,"}
 'returned',e.action ~ '(reject|return)' OR COALESCE(e.after_state->>'decision','')='rejected' OR COALESCE(e.after_state->>'rejected','')='true') ORDER BY e.created_at,e.event_id)
 FROM operation_events e LEFT JOIN changes change ON change.id=e.event_id::text
 ${detail==='summary'?'':'LEFT JOIN app_users u ON u.id=e.actor_id'}
 WHERE e.entity_type='rework_order' AND e.entity_id=r.rework_order_id::text AND e.action LIKE 'rework.%'),'[]'::jsonb) history
 FROM rework_orders r WHERE ($5::uuid[] IS NULL OR r.rework_order_id=ANY($5::uuid[])) AND ($4='period_end' OR r.status NOT IN ('deleted','cancelled')) AND (
 $1='' OR r.rework_no ILIKE '%'||$1||'%' OR r.style_no ILIKE '%'||$1||'%' OR r.order_no ILIKE '%'||$1||'%'
 OR EXISTS(SELECT 1 FROM operation_events e JOIN app_users u ON u.id=e.actor_id WHERE e.entity_type='rework_order' AND e.entity_id=r.rework_order_id::text AND u.display_name ILIKE '%'||$1||'%')
 OR EXISTS(SELECT 1 FROM rework_todos t JOIN app_users u ON u.id=t.recipient_user_id WHERE t.status='pending' AND t.todo_type='business_action' AND (t.route_descriptor->>'reworkOrderId'=r.rework_order_id::text OR (t.entity_type='rework_order' AND t.entity_id=r.rework_order_id::text)) AND u.display_name ILIKE '%'||$1||'%')
 OR EXISTS(SELECT 1 FROM app_users u WHERE u.id=r.merchandiser_user_id AND u.display_name ILIKE '%'||$1||'%')
 OR EXISTS(SELECT 1 FROM rework_work_tasks t JOIN rework_work_task_members m USING(work_task_id) WHERE t.rework_order_id=r.rework_order_id AND m.display_name_snapshot ILIKE '%'||$1||'%')
 OR EXISTS(SELECT 1 FROM supplier_catalog_versions v WHERE v.supplier_id=r.processing_factory_supplier_id AND v.version=r.processing_factory_supplier_version AND v.supplier_name ILIKE '%'||$1||'%')
 OR EXISTS(SELECT 1 FROM rework_order_supply_context c JOIN supplier_catalog_versions v ON (v.supplier_id,v.version) IN ((c.washing_supplier_id,c.washing_supplier_version),(c.embroidery_supplier_id,c.embroidery_supplier_version),(c.fabric_supplier_id,c.fabric_supplier_version)) WHERE c.rework_order_id=r.rework_order_id AND v.supplier_name ILIKE '%'||$1||'%')
 OR EXISTS(SELECT 1 FROM rework_external_responsibility_cases c WHERE c.rework_order_id=r.rework_order_id AND c.supplier_name_snapshot ILIKE '%'||$1||'%'))
 AND (($4='period_end' AND ($3::date IS NULL OR r.created_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) OR
      ($4='current' AND ($2::date IS NULL OR r.created_at >= $2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND ($3::date IS NULL OR r.created_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')))`;
}
export const SOURCING_FLOW_SQL=`WITH changes AS (
 SELECT t.*,lead(transitioned_at) OVER(PARTITION BY sourcing_case_id ORDER BY sequence) left_at
 FROM sourcing_case_transitions t WHERE t.from_status IS DISTINCT FROM t.to_status AND t.business_action NOT LIKE 'factory_change_%' AND COALESCE(t.from_status,'') NOT LIKE '%factory_change%' AND t.to_status NOT LIKE '%factory_change%'
) SELECT c.sourcing_case_id::text id,'sourcing' kind,c.erp_order_no AS label,c.status,c.created_at AS "createdAt",c.status='pending_finance_reconciliation' AS "independentFinance",
 (SELECT transitioned_at FROM changes t WHERE t.sourcing_case_id=c.sourcing_case_id AND t.to_status=c.status AND t.left_at IS NULL ORDER BY sequence DESC LIMIT 1) AS "enteredAt",
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.sourcing_transition_id::text,'from',t.from_status,'to',t.to_status,'action',t.business_action,'changesNode',t.from_status IS DISTINCT FROM t.to_status,'enteredAt',t.transitioned_at,'leftAt',change.left_at) ORDER BY t.sequence)
 FROM sourcing_case_transitions t LEFT JOIN changes change USING(sourcing_transition_id) WHERE t.sourcing_case_id=c.sourcing_case_id AND t.business_action NOT LIKE 'factory_change_%' AND COALESCE(t.from_status,'') NOT LIKE '%factory_change%' AND t.to_status NOT LIKE '%factory_change%'),'[]'::jsonb) || COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.event_id::text,'from',NULL,'to',NULL,'action',e.action,'changesNode',false,'enteredAt',e.created_at,'leftAt',NULL) ORDER BY e.created_at,e.event_id) FROM operation_events e WHERE e.entity_type='sourcing_case' AND e.entity_id=c.sourcing_case_id::text AND e.action='sourcing.attachments.supplement'),'[]'::jsonb) history
 FROM current_sourcing_cases c WHERE c.status NOT LIKE '%factory_change%'
 AND ($1='' OR c.erp_order_no ILIKE '%'||$1||'%' OR c.style_no ILIKE '%'||$1||'%')
 AND (($4='period_end' AND ($3::date IS NULL OR c.created_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) OR
      ($4='current' AND ($2::date IS NULL OR c.created_at >= $2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND ($3::date IS NULL OR c.created_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')))`;
const iso=(v:Date|string|null)=>v===null?null:new Date(v).toISOString();
type FlowRow=WorkflowAnalysisResponse['items'][number];

function normalizeFlow(row:FlowRow):FlowRow{
 return {...row,createdAt:iso(row.createdAt),enteredAt:iso(row.enteredAt),handlers:row.handlers??[],execution:(row.execution??[]).map(task=>({...task,reports:task.reports.map(report=>({...report,at:iso(report.at)}))})),
  roundtripCount:row.history.filter(event=>event.returned||/(reject|return)/.test(event.action)).length,
  history:row.history.map(event=>({...event,enteredAt:iso(event.enteredAt),leftAt:iso(event.leftAt)})).sort((a,b)=>(a.enteredAt??'').localeCompare(b.enteredAt??'')||a.id.localeCompare(b.id))};
}
export async function readWorkflowAnalysis(db:Pool,input:unknown,includeSourcing:boolean):Promise<WorkflowAnalysisResponse>{
 const parsed=WorkflowAnalysisQuerySchema.safeParse(input);
 if(!parsed.success||!['all','rework','sourcing','finance','waiting','closed'].includes(parsed.data.group))throw new ApplicationError('VALIDATION_ERROR','流程筛选无效',400);
 const filters=parsed.data,client=await db.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const clock=await client.query<{now:Date}>('SELECT CURRENT_TIMESTAMP now');
  const args=[filters.q,filters.from??null,filters.to??null,filters.snapshot];
  const rows=(await client.query<FlowRow>(reworkFlowSql('summary'),[...args,null])).rows;
  if(includeSourcing&&filters.group!=='rework')rows.push(...(await client.query<FlowRow>(SOURCING_FLOW_SQL,args)).rows);
  const result=workflowAnalysisResult(rows.map(normalizeFlow),filters,clock.rows[0]!.now.toISOString());
  const selected=result.items.filter(row=>row.kind==='rework').map(row=>row.id);
  if(selected.length){
   const historical=filters.snapshot==='period_end'&&filters.group==='rework'&&Boolean(filters.from&&filters.to);
   const detail=(await client.query<FlowRow>(reworkFlowSql(historical?'history':'full'),[...args,selected])).rows.map(normalizeFlow);
   const page=new Map(detail.map(row=>[row.id,row]));
   result.items=result.items.map(row=>{
    if(row.kind!=='rework')return row;
    const original=page.get(row.id);
    if(!original)throw new ApplicationError('CONFLICT','原返工单资料读取未完成，请重试',409);
    const history=new Map(original.history.map(event=>[event.id,event]));
    return {...row,
     submitterName:historical?row.submitterName:original.submitterName,
     handlers:historical?row.handlers:original.handlers,
     execution:historical?row.execution:original.execution,
     history:row.history.map(event=>({...event,actorName:history.get(event.id)?.actorName??null,reason:history.get(event.id)?.reason??null})),
    };
   });
  }
  await client.query('COMMIT');
  return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
