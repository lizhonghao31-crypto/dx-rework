import {QuoteAnalysisResponseSchema,WorkAnalysisQuerySchema,type QuoteAnalysisResponse} from '@dx-rework/contracts';
import type {Pool} from 'pg';
import {ApplicationError} from '../platform/errors.js';

// All monetary columns are explicitly converted to text; no JS floating arithmetic.
export const QUOTE_ANALYSIS_SQL=`SELECT c.sourcing_case_id::text id,c.erp_order_no AS "orderNo",c.deleted_at IS NOT NULL archived,
 jsonb_build_object('id',c.sourcing_case_id::text,'version',1,'recordedAt',c.created_at,'lines',COALESCE((
 SELECT jsonb_agg(jsonb_build_object('position',l.position,'styleNo',l.style_no,'color',l.color,'quantity',l.quantity::text,'unitPrice',l.external_unit_price::text) ORDER BY l.position)
 FROM sourcing_case_lines l WHERE l.sourcing_case_id=c.sourcing_case_id),'[]'::jsonb)) initial,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.sourcing_ie_quote_id::text,'version',q.quote_version,'recordedAt',q.quoted_at,'lines',COALESCE((
 SELECT jsonb_agg(jsonb_build_object('position',l.position,'styleNo',src.style_no,'color',src.color,'quantity',l.quantity::text,'unitPrice',l.unit_price::text) ORDER BY l.position)
 FROM sourcing_ie_quote_lines l LEFT JOIN sourcing_case_lines src ON src.sourcing_case_id=q.sourcing_case_id AND src.position=l.position
 WHERE l.sourcing_ie_quote_id=q.sourcing_ie_quote_id),'[]'::jsonb)) ORDER BY q.quote_version)
 FROM sourcing_ie_quotes q WHERE q.sourcing_case_id=c.sourcing_case_id),'[]'::jsonb) ie,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.sourcing_approval_snapshot_id::text,'version',s.decision_version,'recordedAt',s.approved_at,'lines',COALESCE((
 SELECT jsonb_agg(jsonb_build_object('position',l.position,'styleNo',l.style_no,'color',l.color,'quantity',l.quantity::text,'unitPrice',l.unit_price::text) ORDER BY l.position)
 FROM sourcing_approval_snapshot_lines l WHERE l.sourcing_approval_snapshot_id=s.sourcing_approval_snapshot_id),'[]'::jsonb)) ORDER BY s.decision_version)
 FROM sourcing_approval_snapshots s JOIN sourcing_decisions d ON d.sourcing_decision_id=s.sourcing_decision_id
 WHERE s.sourcing_case_id=c.sourcing_case_id AND d.source_type IN ('initial','management_revision')),'[]'::jsonb) approved
 FROM sourcing_cases c WHERE ($1='' OR c.erp_order_no ILIKE '%'||$1||'%' OR EXISTS(SELECT 1 FROM sourcing_case_lines l WHERE l.sourcing_case_id=c.sourcing_case_id AND l.style_no ILIKE '%'||$1||'%'))
 AND ($2::date IS NULL OR c.created_at >= $2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND ($3::date IS NULL OR c.created_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
 ORDER BY c.created_at DESC,c.sourcing_case_id`;
const iso=(v:string|null)=>v===null?null:new Date(v).toISOString();
export async function readQuoteAnalysis(db:Pool,input:unknown):Promise<QuoteAnalysisResponse> {
 const parsed=WorkAnalysisQuerySchema.safeParse(input);if(!parsed.success||parsed.data.group!=='all')throw new ApplicationError('VALIDATION_ERROR','报价筛选无效',400);
 const filters=parsed.data,client=await db.connect();
 try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const clock=await client.query<{now:Date}>('SELECT CURRENT_TIMESTAMP now');
 const result=await client.query<QuoteAnalysisResponse['items'][number]>(QUOTE_ANALYSIS_SQL,[filters.q,filters.from??null,filters.to??null]);
 const all=result.rows.map(row=>({...row,initial:{...row.initial,recordedAt:iso(row.initial.recordedAt)},ie:row.ie.map(s=>({...s,recordedAt:iso(s.recordedAt)})),approved:row.approved.map(s=>({...s,recordedAt:iso(s.recordedAt)}))}));
 await client.query('COMMIT');return QuoteAnalysisResponseSchema.parse({asOf:clock.rows[0]!.now.toISOString(),filters,total:all.length,missingInitialCount:all.filter(r=>!r.initial.lines.length||r.initial.lines.some(l=>l.unitPrice===null)).length,items:all.slice((filters.page-1)*15,filters.page*15)});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
