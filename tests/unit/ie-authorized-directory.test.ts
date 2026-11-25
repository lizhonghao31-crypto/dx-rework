import type {Pool} from 'pg';
import {describe,expect,it,vi} from 'vitest';
import {readAuthorizedIeDirectoryPage,type IeAuthorizedCandidates} from '../../apps/api/src/production-platform/ie-authorized-directory.js';
import {readIntegratedIeDirectory} from '../../apps/api/src/production-platform/ie-directory-reader.js';
import {mayReadSourcing,sourcingIeCandidates} from '../../apps/api/src/sourcing/sourcing-ie-directory.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {type UnifiedIeDirectoryEntry} from '@dx-rework/contracts/digital-quotation';
import {parseUnifiedIeLocation,unifiedIeEntryKey,unifiedIeOriginalHref} from '../../apps/web/src/ie-unified-directory-routes.js';

const id='1a000000-0000-4000-8000-000000000001';
const actor=(authorizationCapability:string,authorizationCapabilities:string[],actorRoles=['ie_reviewer']):TrustedActorContext=>
 ({actorId:id,requestId:'TEST-ie-directory',authorizationCapability,authorizationCapabilities,actorRoles});
const domain=(label:string)=>vi.fn(({bind,search}:Parameters<NonNullable<IeAuthorizedCandidates['processing_quote']>>[0])=>
 `SELECT object_id,entry_id,resource_id,order_id,style_no,customer_code,version,round,native_status,sort_at,state,assignee_name,pricing FROM fixture
   WHERE category=${bind(label)} AND style_no=${search}::text`);

describe('authorized IE directory database composition',()=>{
 it('binds only authorized inputs then globally paginates the three filtered collections in a stable order',async()=>{
  const processing=domain('processing'),sourcing=domain('sourcing'),rework=domain('rework');
  const query=vi.fn().mockResolvedValue({rows:[{total:16,items:[]}]});
  const result=await readAuthorizedIeDirectoryPage({query},{kind:'all',page:3,search:'款号-A',state:'returned'},
   {processing_quote:processing,sourcing_review:sourcing,rework_review:rework});
  expect(query).toHaveBeenCalledOnce();
  const [statement,parameters]=query.mock.calls[0]!;
  expect(parameters).toEqual(['款号-A','processing','sourcing','rework',30,'returned']);
  expect(statement).not.toContain('款号-A');
  expect(statement.match(/UNION ALL/g)).toHaveLength(2);
  expect(statement.match(/LIMIT/g)).toHaveLength(1);
  expect(statement).toContain('FROM authorized ORDER BY sort_at DESC,kind,object_id,entry_id LIMIT 15 OFFSET $5');
  expect(statement).toContain('SELECT * FROM candidates WHERE $6::text=\'all\' OR state=$6::text');
  expect(statement).toContain('SELECT count(*)::int FROM authorized');
  expect(result).toEqual({page:3,pageSize:15,total:16,items:[]});
 });

 it('does not query other domains when a filter chooses the authorized category',async()=>{
  const never=domain('never'),chosen=domain('chosen');
  const query=vi.fn().mockResolvedValue({rows:[{total:0,items:[]}]});
  await readAuthorizedIeDirectoryPage({query},{kind:'sourcing_review',page:1,search:'ABC'},
   {processing_quote:never,sourcing_review:chosen,rework_review:never});
  expect(chosen).toHaveBeenCalledOnce();expect(never).not.toHaveBeenCalled();
  expect(query.mock.calls[0]![1]).toEqual(['ABC','chosen',0,'all']);
 });

 it('uses original sourcing capability with history scoped to the actual quoting user',()=>{
  expect(sourcingIeCandidates(actor('sourcing:view',[]))).toBeUndefined();
  expect(mayReadSourcing(actor('other',['sourcing:view']))).toBe(false);
  const candidate=sourcingIeCandidates(actor('sourcing:view',['sourcing:view']))!;
  const values:unknown[]=[];
  const text=candidate({search:'$1',bind:value=>{values.push(value);return `$${values.length+1}`;}});
  expect(values).toEqual([id,false]);
  expect(text).toContain('history_quote.quoted_by=$2::uuid');
  expect(text).toContain('current_sourcing_case_lines');
  expect(text).not.toContain('digital_production_orders');
 });

 it('keeps only the old related-order scope, not product IE or sourcing, when that is the actual capability',async()=>{
  const query=vi.fn().mockImplementation(async (sql:string)=>({rows:sql.startsWith('WITH candidates')?[{total:0,items:[]}]:[]}));
  const release=vi.fn(),db={query,release};
  const pool={connect:vi.fn().mockResolvedValue(db)} as unknown as Pool;
  const related=actor('report:view',['rework:related_orders:view'],['order_merchandiser']);
  await readIntegratedIeDirectory(pool,{processing:related,sourcing:null,rework:related},{kind:'all',search:'款号',page:1});
  expect(query.mock.calls[0]).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY']);
  expect(query).toHaveBeenCalledWith('SELECT access_authorized_actor_roles($1,$2)',[id,'rework:related_orders:view']);
  const [statement,values]=query.mock.calls.find(([sql])=>sql.startsWith('WITH candidates'))!;
  expect(statement).toContain('related_supply.embroidery_merchandiser_user_id=');
  expect(statement).not.toContain('digital_quotation_documents');
  expect(statement).not.toContain('current_sourcing_cases');
  expect(values).toContainEqual(['pending_ie_review','pending_final_quantity_ie_review','pending_quantity_adjustment_ie_review']);
  expect(query).toHaveBeenLastCalledWith('COMMIT');expect(release).toHaveBeenCalledOnce();
 });

 it('does not present a database authorization failure as an empty category',async()=>{
  const error=Object.assign(new Error('permission denied for function access_authorized_actor_roles'),{code:'42501'});
  const query=vi.fn().mockImplementation(async (sql:string)=>{
   if(sql.startsWith('SELECT access_authorized_actor_roles'))throw error;
   return {rows:[]};
  });
  const release=vi.fn(),pool={connect:async()=>({query,release})} as unknown as Pool;
  const reporting=actor('report:view',['report:view'],['production_management']);
  await expect(readIntegratedIeDirectory(pool,{processing:reporting,sourcing:null,rework:reporting},
   {kind:'rework_review',search:'',page:1})).rejects.toBe(error);
  expect(query).toHaveBeenLastCalledWith('ROLLBACK');expect(release).toHaveBeenCalledOnce();
 });
});

describe('original workbench routes from the unified IE directory',()=>{
 const rowId='1a000000-0000-4000-8000-000000000002',resourceId='1a000000-0000-4000-8000-000000000003';
 const row:UnifiedIeDirectoryEntry={kind:'processing_quote',objectId:id,entryId:rowId,resourceId,orderId:null,styleNo:'TEST Style',
  customerCode:'PD',version:4,round:2,nativeStatus:'active',state:'returned',sortAt:'2026-11-20T12:00:00Z'};
 const paths={directory:'/acceptance/ui/ie-processing',reworkProcess:'/acceptance/ui/process-configuration',reworkReporting:'/acceptance/ui/work-reporting'};
 const filters={kind:'all',search:'款号 2',state:'returned',page:2} as const;
 const url=(value:string)=>new URL(value,'https://localhost');
 it('reuses the selected original quotation row and sourced case with their filtered return context',()=>{
  const product=url(unifiedIeOriginalHref(paths,filters,row)!);
  expect(product.pathname).toBe(paths.directory);
  expect(parseUnifiedIeLocation(product.searchParams)).toMatchObject({...filters,focus:unifiedIeEntryKey(row),
   detail:{type:'processing_quote',quoteId:id,rowId,id:resourceId,resourceKind:'source'}});
  const other={...row,kind:'sourcing_review' as const,resourceId:id,entryId:id};
  expect(parseUnifiedIeLocation(url(unifiedIeOriginalHref(paths,filters,other)!).searchParams)).toMatchObject({...filters,
   focus:unifiedIeEntryKey(other),detail:{type:'sourcing_review',caseId:id}});
 });
 it('returns directly to the original authorized rework surface with exact row, page and search',()=>{
  for(const [state,expected] of [['pending_ie_review',paths.reworkProcess],['pending_final_quantity_ie_review',paths.reworkReporting]]){
   const rework={...row,kind:'rework_review' as const,entryId:id,resourceId:id,nativeStatus:state!};
   const target=url(unifiedIeOriginalHref(paths,filters,rework)!);
   expect(target.pathname).toBe(expected);expect(target.searchParams.get('rework')).toBe(id);
   const back=url(target.searchParams.get('ieReturn')!);
   expect(back.pathname).toBe(paths.directory);
   expect(parseUnifiedIeLocation(back.searchParams)).toMatchObject({...filters,focus:unifiedIeEntryKey(rework)});
  }
  expect(unifiedIeOriginalHref(paths,filters,{...row,kind:'rework_review',nativeStatus:'completed'})).toBeNull();
  expect(parseUnifiedIeLocation(new URLSearchParams('directory=unified&page=2&page=1'))).toBeNull();
 });
});
