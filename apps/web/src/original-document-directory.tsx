import {useCallback,useEffect,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog,DialogHeader} from '@astryxdesign/core/Dialog';
import {TextInput} from '@astryxdesign/core/TextInput';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import {registerSessionInvalidator} from './auth-session.js';
import {digitalRequest} from './digital-production-api.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {designerAstryxCss} from './designer-astryx.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {DevelopmentOriginalVersions} from './development-original-versions.js';
import {ListPagination} from './list-pagination.js';
import {useDebouncedValue} from './use-debounced-value.js';

export type OriginalResource={kind:'source'|'order';id:string};
export type OriginalDocumentRef=
 |{kind:'development';sourceId:string;roundNumber:number;documentVersion:number}
 |{kind:'budget';orderId:string;version:number}
 |{kind:'instruction';orderId:string;version:number}
 |{kind:'quotation';resource:OriginalResource;quoteId:string;version:number};
type Reference={state:'available';id:string}|{state:'unavailable'|'not_applicable'|'missing'|'draft'};
type Directory=Record<'development'|'budget'|'instruction',Reference>;
const names={budget:'成本预算表',instruction:'大货制单',quotation:'客户报价'};

export function originalDocumentHref(ref:OriginalDocumentRef,returnTo:string|null,base:string){
 const query=ref.kind==='development'?{development:ref.sourceId,round:String(ref.roundNumber),developmentDocumentVersion:String(ref.documentVersion)}
  :ref.kind==='quotation'?{[ref.resource.kind==='source'?'quotationSource':'quotationOrder']:ref.resource.id,quoteVersion:String(ref.version),quoteId:ref.quoteId}
   :{[ref.kind]:ref.orderId,[ref.kind+'Version']:String(ref.version),originalDocument:ref.kind};
 return digitalChildDetailHref('/ui/digital-production?'+new URLSearchParams(query),returnTo,base);
}

function PublishedGroup({kind,resource,search,onSelect,onReady,page,onPage:setPage}:{kind:keyof typeof names;resource:OriginalResource;search:string;onSelect(ref:OriginalDocumentRef):void;onReady(ready:boolean):void;page:number;onPage(page:number):void}){
 const q=useDebouncedValue(search.trim(),250),[attempt,setAttempt]=useState(0);
 const [result,setResult]=useState<{key:string;value:{id:string;quoteId?:string|null;total:number;page:number;pageSize:number;items:Array<{version:number;publishedAt:string|null}>}}|null>(null),[failure,setFailure]=useState<{key:string;error:unknown}|null>(null);
 const key=JSON.stringify([kind,resource.kind,resource.id,q,page,attempt]),applied=q===search.trim();
 useEffect(()=>registerSessionInvalidator(()=>{setResult(null);setFailure(null);setAttempt(value=>value+1);}),[]);
 useEffect(()=>{
  if(!applied)return;
  const abort=new AbortController();setFailure(null);
  const path=kind==='quotation'?`${resource.kind==='source'?'sources':'orders'}/${resource.id}/quotation/confirmed-versions`:`orders/${resource.id}/${kind}/published-versions`;
  void digitalRequest<NonNullable<typeof result>['value']>(path+'?'+new URLSearchParams({q,page:String(page)}),'GET',undefined,undefined,{signal:abort.signal})
   .then(value=>{if(abort.signal.aborted)return;if(value.id!==resource.id||value.page!==page||value.pageSize!==15||!Number.isSafeInteger(value.total)||value.total<0||!Array.isArray(value.items)||value.items.some(item=>!Number.isSafeInteger(item.version)||item.version<1)||kind==='quotation'&&value.items.length>0&&!DigitalIdSchema.safeParse(value.quoteId).success)throw Error('原单目录身份或版本不符，未读取其它记录');setResult({key,value});})
   .catch(error=>{if(!abort.signal.aborted){setResult(null);setFailure({key,error});}});
  return()=>abort.abort();
 },[kind,resource.kind,resource.id,q,page,applied,key]);
 const current=applied&&result?.key===key?result.value:null,error=failure?.key===key?failure.error:null;
 useEffect(()=>{onReady(Boolean(current||error));return()=>onReady(false);},[current,error,onReady]);
 return <section aria-label={names[kind]+'原版本'}><h2>{names[kind]}</h2>
  {!current&&!error&&<p role="status">正在读取授权版本…</p>}
  {error?<DigitalReadFailure error={error} onRetry={()=>setAttempt(value=>value+1)} retryLabel={'重读'+names[kind]+'目录'}/>:null}
  {current&&(current.items.length?<ul>{current.items.map(item=><li key={item.version}><Button label={`${names[kind]} · ${kind==='quotation'?'已确认':'已发布'}版本 ${item.version}`} onClick={()=>onSelect(kind==='quotation'?{kind,resource,quoteId:current.quoteId!,version:item.version}:{kind,orderId:resource.id,version:item.version})}/></li>)}</ul>:<p>{current.total?'本页没有记录，请返回有效页码。':'当前授权范围没有匹配的已保存版本。'}</p>)}
  {current&&(current.total>current.pageSize||page>1)&&<ListPagination page={page}
    totalPages={Math.max(1,Math.ceil(current.total/current.pageSize))} total={current.total}
    onPageChange={setPage} ariaLabel={names[kind]+'版本分页'}/>}
 </section>;
}

/** One original relationship read followed by metadata-only domain readers.
 * Each domain retains its own authorization; no body or attachment prefetch.
 */
export function OriginalDocumentDirectory({resource,onSelect,onReady,rememberInUrl=false,activeKind}:{
 resource:OriginalResource;onSelect(ref:OriginalDocumentRef):void;onReady?:((ready:boolean)=>void)|undefined;rememberInUrl?:boolean;
 activeKind?:OriginalDocumentRef['kind']|null;
}){
 const [directory,setDirectory]=useState<Directory|null>(null),[error,setError]=useState<unknown>(null),[attempt,setAttempt]=useState(0),[search,setSearch]=useState(()=>rememberInUrl?(new URLSearchParams(location.search).get('originalSearch')??'').slice(0,100):'');
 const [pages,setPages]=useState<Record<string,number>>(()=>Object.fromEntries(['development','budget','instruction','quotation'].map(kind=>{const raw=rememberInUrl?new URLSearchParams(location.search).get('original'+kind+'Page'):null;return [kind,raw&&/^[1-9]\d*$/.test(raw)&&Number(raw)<=1_000_000?Number(raw):1];})));
 const [ready,setReady]=useState<Record<string,boolean>>({});
 const [readDemanded,setReadDemanded]=useState(activeKind!==null);
 useEffect(()=>{if(activeKind!==null)setReadDemanded(true);},[activeKind]);
 const mark=useCallback((kind:string,value:boolean)=>setReady(prior=>prior[kind]===value?prior:{...prior,[kind]:value}),[]);
 const [marks]=useState(()=>({development:(v:boolean)=>mark('development',v),budget:(v:boolean)=>mark('budget',v),instruction:(v:boolean)=>mark('instruction',v),quotation:(v:boolean)=>mark('quotation',v)}));
 const [paging]=useState(()=>Object.fromEntries(['development','budget','instruction','quotation'].map(kind=>[kind,(value:number)=>setPages(prior=>({...prior,[kind]:value}))])) as Record<string,(value:number)=>void>);
 useEffect(()=>{
  if(!rememberInUrl)return;
  const target=new URL(location.href);if(target.searchParams.get('workspace')!=='designer'||target.searchParams.get('development')!==resource.id||target.searchParams.get('area')!=='records')return;
  if(search)target.searchParams.set('originalSearch',search);else target.searchParams.delete('originalSearch');
  for(const [kind,page] of Object.entries(pages)){if(page>1)target.searchParams.set('original'+kind+'Page',String(page));else target.searchParams.delete('original'+kind+'Page');}
  history.replaceState(history.state,'',target);
 },[search,pages,rememberInUrl,resource.id]);
 useEffect(()=>registerSessionInvalidator(()=>{setDirectory(null);setError(null);setReady({});setAttempt(value=>value+1);}),[]);
 useEffect(()=>{
  if(!readDemanded)return;
  const abort=new AbortController();setDirectory(null);setError(null);setReady({});
  void digitalRequest<Directory>(`document-directory/${resource.kind}/${resource.id}`,'GET',undefined,undefined,{signal:abort.signal}).then(value=>{
   if(abort.signal.aborted)return;
   if(['development','budget','instruction'].some(kind=>{const ref=value[kind as keyof Directory];return !ref||!['available','unavailable','not_applicable','missing','draft'].includes(ref.state)||ref.state==='available'&&!DigitalIdSchema.safeParse(ref.id).success;}))throw Error('原单关联目录不完整');
   setDirectory(value);
  }).catch(reason=>{if(!abort.signal.aborted)setError(reason);});return()=>abort.abort();
 },[resource.kind,resource.id,attempt,readDemanded]);
 const selected=(kind:OriginalDocumentRef['kind'])=>activeKind===undefined||activeKind===kind;
 const complete=activeKind===null||Boolean(error)||Boolean(directory&&(!selected('quotation')||ready.quotation)&&
  (['development','budget','instruction'] as const).every(kind=>!selected(kind)||directory[kind].state!=='available'||ready[kind]));
 useEffect(()=>{onReady?.(complete);return()=>onReady?.(false);},[complete,onReady]);
 if(activeKind===null)return null;
 return <section aria-label="本单原单据目录"><TextInput label="搜索原单与版本" value={search} onChange={value=>{setSearch(value);setPages({development:1,budget:1,instruction:1,quotation:1});}} ref={input=>{if(input)input.maxLength=100;}}/>
  {error?<DigitalReadFailure error={error} onRetry={()=>setAttempt(value=>value+1)} retryLabel="重新读取原单关联"/>:!directory?<p role="status">正在核对原单关联和权限…</p>:<>
   {selected('development')&&(directory.development.state==='available'?<DevelopmentOriginalVersions sourceId={directory.development.id} searchQuery={search} page={pages.development!} onPage={paging.development} onSelect={ref=>onSelect({kind:'development',sourceId:(directory.development as {id:string}).id,...ref})} onReady={marks.development}/>:<p>开发资料：{directory.development.state==='unavailable'?'不可查看':'没有可查看的关联来源'}</p>)}
   {(['budget','instruction'] as const).filter(selected).map(kind=>directory[kind].state==='available'?<PublishedGroup key={kind} kind={kind} resource={{kind:'order',id:directory[kind].id}} search={search} onSelect={onSelect} onReady={marks[kind]} page={pages[kind]!} onPage={paging[kind]!}/>:<p key={kind}>{names[kind]}：{directory[kind].state==='unavailable'?'不可查看':'没有可查看的正式订单关联'}</p>)}
   {selected('quotation')&&<PublishedGroup kind="quotation" resource={resource} search={search} onSelect={onSelect} onReady={marks.quotation} page={pages.quotation!} onPage={paging.quotation!}/>}
  </>}
 </section>;
}

export function OriginalDocumentSwitcher({resource,onSelect,onClose}:{resource:OriginalResource;onSelect(ref:OriginalDocumentRef):void;onClose():void}){
 return <Dialog isOpen className="dx-designer-astryx" onOpenChange={open=>{if(!open)onClose();}}><style>{designerAstryxCss}</style><DialogHeader title="切换单据" onOpenChange={open=>{if(!open)onClose();}}/><OriginalDocumentDirectory resource={resource} onSelect={onSelect}/><Button label="取消切换" onClick={onClose}/></Dialog>;
}
