import {WorkAnalysisQuerySchema,WorkflowAnalysisResponseSchema,type WorkflowAnalysisResponse} from '@dx-rework/contracts';
import type {Pool} from 'pg';
import {ApplicationError} from '../platform/errors.js';
export const REWORK_FLOW_SQL=`WITH changes AS (
 SELECT event_id::text id,entity_id,before_state->>'status' previous,after_state->>'status' next,action,created_at,
 lead(created_at) OVER(PARTITION BY entity_id ORDER BY created_at,event_id) left_at
 FROM operation_events WHERE entity_type='rework_order' AND action LIKE 'rework.%'
 AND after_state->>'status' IS NOT NULL AND before_state->>'status' IS DISTINCT FROM after_state->>'status'
) SELECT r.rework_order_id::text id,'rework' kind,COALESCE(r.rework_no,r.rework_order_id::text) label,r.status,false AS "independentFinance",
 (SELECT created_at FROM changes e WHERE e.entity_id=r.rework_order_id::text AND e.next=r.status AND e.left_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) AS "enteredAt",
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.event_id::text,'from',e.before_state->>'status','to',e.after_state->>'status','action',e.action,'changesNode',change.id IS NOT NULL,'enteredAt',e.created_at,'leftAt',change.left_at) ORDER BY e.created_at,e.event_id) FROM operation_events e LEFT JOIN changes change ON change.id=e.event_id::text WHERE e.entity_type='rework_order' AND e.entity_id=r.rework_order_id::text AND e.action LIKE 'rework.%'),'[]'::jsonb) history
 FROM rework_orders r WHERE r.status NOT IN ('deleted','cancelled') AND ($1='' OR r.rework_no ILIKE '%'||$1||'%' OR r.style_no ILIKE '%'||$1||'%')
 AND ($2::date IS NULL OR r.created_at >= $2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND ($3::date IS NULL OR r.created_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`;
export const SOURCING_FLOW_SQL=`WITH changes AS (
 SELECT t.*,lead(transitioned_at) OVER(PARTITION BY sourcing_case_id ORDER BY sequence) left_at
 FROM sourcing_case_transitions t WHERE t.from_status IS DISTINCT FROM t.to_status
) SELECT c.sourcing_case_id::text id,'sourcing' kind,c.erp_order_no label,c.status,c.status='pending_finance_reconciliation' AS "independentFinance",
 (SELECT transitioned_at FROM changes t WHERE t.sourcing_case_id=c.sourcing_case_id AND t.to_status=c.status AND t.left_at IS NULL ORDER BY sequence DESC LIMIT 1) AS "enteredAt",
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.sourcing_transition_id::text,'from',t.from_status,'to',t.to_status,'action',t.business_action,'changesNode',t.from_status IS DISTINCT FROM t.to_status,'enteredAt',t.transitioned_at,'leftAt',change.left_at) ORDER BY t.sequence)
 FROM sourcing_case_transitions t LEFT JOIN changes change USING(sourcing_transition_id) WHERE t.sourcing_case_id=c.sourcing_case_id AND t.business_action NOT LIKE 'factory_change_%' AND COALESCE(t.from_status,'') NOT LIKE '%factory_change%' AND t.to_status NOT LIKE '%factory_change%'),'[]'::jsonb) || COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.event_id::text,'from',NULL,'to',NULL,'action',e.action,'changesNode',false,'enteredAt',e.created_at,'leftAt',NULL) ORDER BY e.created_at,e.event_id) FROM operation_events e WHERE e.entity_type='sourcing_case' AND e.entity_id=c.sourcing_case_id::text AND e.action='sourcing.attachments.supplement'),'[]'::jsonb) history
 FROM current_sourcing_cases c WHERE c.status NOT LIKE '%factory_change%'
 AND ($1='' OR c.erp_order_no ILIKE '%'||$1||'%' OR c.style_no ILIKE '%'||$1||'%')
 AND ($2::date IS NULL OR c.created_at >= $2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND ($3::date IS NULL OR c.created_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`;
const iso=(v:Date|string|null)=>v===null?null:new Date(v).toISOString();
export async function readWorkflowAnalysis(db:Pool,input:unknown,includeSourcing:boolean):Promise<WorkflowAnalysisResponse>{
 const parsed=WorkAnalysisQuerySchema.safeParse(input);if(!parsed.success||!['all','rework','sourcing','finance','waiting','closed'].includes(parsed.data.group))throw new ApplicationError('VALIDATION_ERROR','流程筛选无效',400);
 const filters=parsed.data,client=await db.connect();
 try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const clock=await client.query<{now:Date}>('SELECT CURRENT_TIMESTAMP now');
 const args=[filters.q,filters.from??null,filters.to??null];
 const rows=(await client.query<WorkflowAnalysisResponse['items'][number]>(REWORK_FLOW_SQL,args)).rows;
 if(includeSourcing)rows.push(...(await client.query<WorkflowAnalysisResponse['items'][number]>(SOURCING_FLOW_SQL,args)).rows);
 const closed=(r:typeof rows[number])=>['completed','closed','cancelled'].includes(r.status);
 const all=rows.filter(r=>filters.group==='all'||(filters.group==='finance'?r.independentFinance:filters.group==='waiting'?!closed(r)&&!r.independentFinance:filters.group==='closed'?closed(r):r.kind===filters.group)).map(r=>({...r,enteredAt:iso(r.enteredAt),history:r.history.map(h=>({...h,enteredAt:iso(h.enteredAt),leftAt:iso(h.leftAt)})).sort((a,b)=>(a.enteredAt??'').localeCompare(b.enteredAt??'')||a.id.localeCompare(b.id))})).sort((a,b)=>(a.enteredAt??'9999').localeCompare(b.enteredAt??'9999')||a.id.localeCompare(b.id));
 const groups=new Map<string,{key:string;count:number;missingEntryCount:number}>();for(const r of all){const key=`${r.kind}:${r.status}`;const g=groups.get(key)??{key,count:0,missingEntryCount:0};g.count++;if(r.enteredAt===null)g.missingEntryCount++;groups.set(key,g);}
 await client.query('COMMIT');return WorkflowAnalysisResponseSchema.parse({asOf:clock.rows[0]!.now.toISOString(),filters,total:all.length,missingEntryCount:all.filter(r=>r.enteredAt===null).length,groups:[...groups.values()].sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key)),items:all.slice((filters.page-1)*15,filters.page*15)});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
