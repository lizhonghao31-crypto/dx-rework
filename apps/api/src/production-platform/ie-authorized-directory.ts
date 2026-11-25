import type {PoolClient} from 'pg';
import type {UnifiedIeDirectoryEntry,UnifiedIeDirectoryQuery} from '@dx-rework/contracts/digital-quotation';

export const ieDirectoryKinds=['processing_quote','sourcing_review','rework_review'] as const;
export type IeDirectoryKind=(typeof ieDirectoryKinds)[number];
type CandidateSql=Readonly<{bind:(value:unknown)=>string;search:string}>;

/** Domain adapters supply authorized, filtered rows without a LIMIT. An absent adapter is not a failed read. */
export type IeAuthorizedCandidates=Partial<Record<IeDirectoryKind,(sql:CandidateSql)=>string>>;
export type IeDirectoryPageInput=Readonly<UnifiedIeDirectoryQuery>;
const pageSize=15;

/** All active adapters, totals and the actual page are read in one statement on the caller's authorized snapshot. */
export async function readAuthorizedIeDirectoryPage(db:Pick<PoolClient,'query'>,input:IeDirectoryPageInput,authorized:IeAuthorizedCandidates){
 const values:unknown[]=[];
 const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
 const selected=ieDirectoryKinds.filter(kind=>(input.kind==='all'||kind===input.kind)&&authorized[kind]!==undefined);
 if(!selected.length)return {page:input.page,pageSize,total:0,items:[] as UnifiedIeDirectoryEntry[]};
 const search=bind(input.search);
 const candidates=selected.map(kind=>`SELECT '${kind}'::text AS kind,object_id,entry_id,resource_id,order_id,style_no,customer_code,
  version,round,native_status,sort_at,state,assignee_name,pricing FROM (${authorized[kind]!({bind,search})}) source`).join('\nUNION ALL\n');
 const sorted='sort_at DESC,kind,object_id,entry_id';
 const offset=bind((input.page-1)*pageSize),state=bind(input.state??'all');
 const {rows:[result]}=await db.query<{total:number;items:UnifiedIeDirectoryEntry[]}>(`WITH candidates AS (
  ${candidates}
 ), authorized AS MATERIALIZED (
  SELECT * FROM candidates WHERE ${state}::text='all' OR state=${state}::text
 ), page AS (
  SELECT * FROM authorized ORDER BY ${sorted} LIMIT ${pageSize} OFFSET ${offset}
 ) SELECT (SELECT count(*)::int FROM authorized) AS total,
  coalesce((SELECT json_agg(json_build_object('kind',kind,'objectId',object_id,'entryId',entry_id,'resourceId',resource_id,'orderId',order_id,
    'styleNo',style_no,'customerCode',customer_code,'version',version,'round',round,'nativeStatus',native_status,'state',state,'sortAt',sort_at,
    'assigneeName',assignee_name,'pricing',pricing)
    ORDER BY ${sorted}) FROM page),'[]'::json) AS items`,values);
 if(!result)throw new Error('IE directory did not return its authorized total');
 return {page:input.page,pageSize,total:result.total,items:result.items};
}
