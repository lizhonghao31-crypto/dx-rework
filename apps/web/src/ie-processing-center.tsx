import {lazy,useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Table,type TableColumn} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {z} from 'zod';
import {IeProcessingDirectorySchema,IeProcessingEntrySchema,IeProcessingQuerySchema,IeProcessingStateSchema,QuotationResourceSchema,QuotationRowInputSchema,
 type IeProcessingEntry,type IeProcessingQuery} from '@dx-rework/contracts/digital-quotation';
import type {ManagementReworkRow} from '@dx-rework/contracts/reporting';
import type {SourcingCaseSummary} from '@dx-rework/contracts';
import {createWebUrls} from '../url-contract.js';
import {AstryxPageControls} from './astryx-page-controls.js';
import {sessionCacheVersion} from './auth-session.js';
import {createClientRequestId} from './client-request-id.js';
import {designerAstryxCss} from './designer-astryx.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {quotationRequest} from './digital-quotation-panel.js';
import {useForegroundWait} from './foreground-loading.js';
import {navigateInternalPage} from './internal-navigation.js';
import {loadReworkQueue} from './reporting/reporting-client.js';
import {useSubmissionFeedback} from './submission-feedback.js';
import {SubmissionRequestError} from './submission-validation.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
const entryRoute='ui/ie-processing';
const entryIdentity=z.object({resource:QuotationResourceSchema,quoteId:z.string().uuid(),rowId:z.string().uuid()});
const stateNames={all:'全部状态',needs_assignment:'待指派',waiting:'等待业务前置',awaiting_price:'待核价',priced:'已核价'};
const detailKeys=['kind','id','quoteId','rowId'] as const;
const reworkQueueKeys=['pending_ie_review','pending_final_quantity_ie_review','pending_quantity_adjustment_ie_review'] as const;
const reworkQueues={pending_ie_review:'工序核价',pending_final_quantity_ie_review:'最终数量复核',pending_quantity_adjustment_ie_review:'异常数量复核'};
const returnFocus=z.string().uuid().optional();
const reworkQuery=z.object({channel:z.literal('rework'),queue:z.enum(reworkQueueKeys).default('pending_ie_review'),
 search:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).max(100_000).default(1),focus:returnFocus}).strict();
type ReworkQuery=z.infer<typeof reworkQuery>;
const sourcingQuery=z.object({
 channel:z.literal('sourcing'),
 search:z.string().trim().max(100).default(''),
 page:z.coerce.number().int().min(1).max(100_000).default(1),
 caseId:z.string().uuid().optional(),
 focus:returnFocus,
}).strict();
type SourcingQuery=z.infer<typeof sourcingQuery>;
const SourcingIeCenterDetail=lazy(()=>import('./sourcing-workspace-page.js').then(module=>({default:module.SourcingIeCenterDetail})));
const identityKey=(identity:z.infer<typeof entryIdentity>)=>`${identity.resource.kind}:${identity.resource.id}:${identity.quoteId}:${identity.rowId}`;
function centerHref(query:IeProcessingQuery,selected?:z.infer<typeof entryIdentity>,focus?:string){
 const entries=new URLSearchParams({page:String(query.page),search:query.search,state:query.state,
  ...(selected?{kind:selected.resource.kind,id:selected.resource.id,quoteId:selected.quoteId,rowId:selected.rowId}:{})});
 if(focus)entries.set('focus',focus);
 return urls.pageUrl(`${entryRoute}?${entries}`);
}
function reworkHref({channel,queue,page,search,focus}:ReworkQuery){
 const params=new URLSearchParams({channel,queue,page:String(page),search});
 if(focus)params.set('focus',focus);
 return urls.pageUrl(`${entryRoute}?${params}`);
}
function sourcingHref({channel, page, search, caseId, focus}:SourcingQuery){
 const params=new URLSearchParams({channel,page:String(page),search});
 if(caseId)params.set('caseId',caseId);
 if(focus)params.set('focus',focus);
 return urls.pageUrl(`${entryRoute}?${params}`);
}
const resultLinkId=(id:string)=>`ie-center-work-${id}`;

function useDirectoryReturn(ready:boolean,focus?:string){
 const initial=useRef(focus);
 useInternalReturnScroll(ready);
 useEffect(()=>{
  if(!ready||!initial.current)return;
  const id=initial.current;
  const frame=requestAnimationFrame(()=>{
   initial.current=undefined;
   if(document.activeElement!==document.body)return;
   const link=document.getElementById(resultLinkId(id));
   (link??document.getElementById('ie-center-search')?.querySelector('input'))?.focus({preventScroll:true});
   link?.scrollIntoView({block:'nearest'});
  });
  return ()=>cancelAnimationFrame(frame);
 },[ready]);
}

export function IeReworkReturn(){
 const search=new URLSearchParams(location.search),back=search.get('ieReturn');
 if(!back||search.getAll('ieReturn').length!==1||!back.startsWith('/')||back.startsWith('//'))return null;
 const target=new URL(back,location.origin);
 if(target.origin!==location.origin||target.pathname!==urls.pageUrl(entryRoute)||target.hash)return null;
 if([...target.searchParams.keys()].some(key=>target.searchParams.getAll(key).length!==1))return null;
 const parsed=reworkQuery.safeParse(Object.fromEntries(target.searchParams));
 return parsed.success?<div className="dx-designer-astryx">
  <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style><Link href={reworkHref(parsed.data)}>返回 IE 报价与核价中心</Link>
 </div>:null;
}

function ProcessingPriceDetail({selection,back}:{selection:z.infer<typeof entryIdentity>;back:string}){
 const {resource,quoteId,rowId}=selection,base=`${resource.kind==='source'?'sources':'orders'}/${resource.id}/quotation`;
 const target=identityKey(selection);
 const load=useCallback(async(signal:AbortSignal)=>{
  const directoryEntry=IeProcessingEntrySchema.parse(await digitalRequest(`quotations/ie-processing/${quoteId}/${rowId}`,'GET',undefined,undefined,{signal}));
  if(identityKey(directoryEntry)!==target)throw Error('当前账号无法查看所选报价行，请返回列表重新选择。');
  const sheet=await quotationRequest(base,resource);
  if(sheet.version!==directoryEntry.version||sheet.quoteId!==quoteId||!sheet.rows.some(row=>row.rowId===rowId))throw Error('报价行已更新，请重新读取。');
  return {sheet,canEdit:directoryEntry.canEditPrice};
 },[base,resource,quoteId,rowId,target]);
 const read=useForegroundRead(resource.id,target,load);
 useForegroundWait(read.foregroundKey);
 const [draft,setDraft]=useState<string|null>(null),[busy,setBusy]=useState(false),[fieldError,setFieldError]=useState(''),[receipt,setReceipt]=useState<number|null>(null);
 const saving=useRef(false),feedback=useSubmissionFeedback(setBusy);
 const sheet=read.value?.sheet,row=sheet?.rows.find(row=>row.rowId===rowId),canEdit=Boolean(read.value?.canEdit&&row?.canEditPrice);
 const price=receipt===null?(row?.unitPrice??''):(draft??row?.unitPrice??'');
 const changed=draft!==null&&draft!==(row?.unitPrice??'')&&receipt===null;
 useDigitalDetailNavigationGuard(changed||feedback.uncertain,busy,saving,'本行报价仍有未保存内容或待核回执，确定离开？');
 const save=()=>{
  if(saving.current||feedback.uncertain||!sheet||!canEdit||read.waiting||!changed)return;
  const parsed=QuotationRowInputSchema.safeParse({expectedVersion:sheet.version,unitPrice:draft!.trim()});
  if(!parsed.success){setFieldError(parsed.error.issues[0]?.message??'请核对本行单价。');return;}
  const key=createClientRequestId(),actor=sessionCacheVersion();
  void feedback.run(async()=>{
   if(actor!==sessionCacheVersion())throw new SubmissionRequestError('登录身份已变化，请回到原账号核对。','FORBIDDEN',403);
   saving.current=true;
   try{
    const next=await quotationRequest(`${base}/rows/${rowId}`,resource,'POST',parsed.data,key);
    if(actor!==sessionCacheVersion())throw Error('登录身份已变化，原回执待核。');
    if(next.quoteId!==quoteId||!next.rows.some(item=>item.rowId===rowId))throw Error('未收到所选报价行的回执。');
    feedback.confirmed();setReceipt(next.commandReceipt!.appliedVersion);read.refreshSilently();
   }catch(reason){
    if(reason instanceof DigitalRequestError&&!reason.resultUnknown&&reason.status!==null)throw new SubmissionRequestError(reason.message,reason.code,reason.status);
    throw reason;
   }finally{saving.current=false;}
  });
 };
 return <section aria-label="产品加工报价">
  <Link href={back}>返回报价列表</Link>
  {read.error&&<p role="alert">{read.error.message} <Button label="重新读取报价" isDisabled={busy||feedback.uncertain} onClick={read.retry}/></p>}
  {sheet&&row&&<>
   <h2>{sheet.designStyleNo} · 产品加工报价</h2><p>{[sheet.customerCode??'未维护客户',`报价 v${receipt??sheet.version}`,row.name,row.specification,row.unit].filter(Boolean).join(' · ')}</p>
   <form onSubmit={event=>{event.preventDefault();save();}}>
    <TextInput label="加工单价" inputMode="decimal" value={receipt!==null?price:draft??price}
     isDisabled={read.waiting||busy||feedback.uncertain||!canEdit||receipt!==null}
     onChange={value=>{setDraft(value);setFieldError('');}}
     {...(fieldError?{status:{type:'error',message:fieldError}}:{})}/>
    {canEdit&&receipt===null&&<Button type="submit" label="保存加工单价" variant="primary" isDisabled={!changed||busy||feedback.uncertain||read.waiting}/>}
   </form>
  </>}
  {feedback.notice&&<p role="status">{feedback.notice}</p>}
  {feedback.uncertain&&<Button label="核对上次提交结果" isDisabled={busy} onClick={()=>void feedback.retry()}/>}
  {receipt!==null&&<p role="status">本行报价已保存 · v{receipt}</p>}
 </section>;
}

function ProcessingDirectory({query,focus}:{query:IeProcessingQuery;focus?:string|undefined}){
 const [search,setSearch]=useState(query.search),composing=useRef(false);
 const params=new URLSearchParams({page:String(query.page),search:query.search,state:query.state});
 const key=params.toString();
 const load=useCallback(async(signal:AbortSignal)=>{
  const result=IeProcessingDirectorySchema.parse(await digitalRequest(`quotations/ie-processing?${key}`,'GET',undefined,undefined,{signal}));
  if(result.page!==query.page)throw Error('读取的报价页码有误，请重新读取。');
  return result;
 },[key,query.page]);
 const read=useForegroundRead('product-ie',key,load);
 useForegroundWait(read.foregroundKey);
 useDirectoryReturn(read.value!==null,focus);
 const change=(next:IeProcessingQuery)=>void navigateInternalPage(centerHref(next));
 const columns:TableColumn<IeProcessingEntry>[]=[
  {key:'style',header:'款号',renderCell:row=><Link id={resultLinkId(row.quoteId)} href={centerHref(query,row)}>{row.styleNo}</Link>},
  {key:'customer',header:'客户',renderCell:row=>row.customerCode??'—'},
  {key:'version',header:'轮次／版本',renderCell:row=>`第 ${row.round} 轮 · v${row.version}`},
  {key:'assignee',header:'负责人',renderCell:row=>row.assigneeName??'待指派'},
  {key:'state',header:'状态',renderCell:row=>stateNames[row.state]},
 ];
 return <section aria-label="产品加工报价列表">
  <form id="ie-center-search" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onSubmit={event=>{event.preventDefault();if(!composing.current&&search.trim()!==query.search&&search.trim().length<=100)change({...query,page:1,search:search.trim()});}}>
   <TextInput label="搜索款号或客户" value={search} onChange={setSearch}
    onKeyDown={event=>{if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();}}/>
   <Button label="搜索" type="submit" isDisabled={search.trim().length>100||search.trim()===query.search}/>
   <Selector label="报价状态" value={query.state} options={Object.entries(stateNames).map(([value,label])=>({value,label}))}
    onChange={value=>{const state=IeProcessingStateSchema.safeParse(value);if(value==='all'||state.success)change({...query,page:1,state:state.success?state.data:'all'});}}/>
  </form>
  {read.error&&<p role="alert">{read.error.message} <Button label="重新读取报价列表" onClick={read.retry}/></p>}
  {read.value?.items.length?<div className="development-table-scroll"><Table columns={columns} data={read.value.items} idKey={identityKey} density="compact"/></div>:null}
  {read.value&&!read.value.items.length&&<p>{read.value.total?'本页没有已授权报价，请回到有效页。':'暂无该条件下的产品加工报价。'}</p>}
  {read.value&&<AstryxPageControls page={query.page} total={read.value.total} pageSize={read.value.pageSize} label="产品加工报价分页" onPageChange={page=>change({...query,page})}/>}
 </section>;
}

function ReworkDirectory({query}:{query:ReworkQuery}){
 const [search,setSearch]=useState(query.search),composing=useRef(false),key=reworkHref(query);
 const {queue,page,search:term}=query;
 const load=useCallback((signal:AbortSignal)=>loadReworkQueue({status:queue,statuses:reworkQueueKeys.join(','),page:String(page),limit:'15',q:term},signal),[queue,page,term]);
 const read=useForegroundRead('rework-ie',key,load);
 useForegroundWait(read.foregroundKey);
 const change=(next:ReworkQuery)=>void navigateInternalPage(reworkHref({...next,focus:undefined}));
 const active=read.value?.selected===queue&&read.value.page.page===page?read.value.page:null;
 useDirectoryReturn(active!==null,query.focus);
 const open=(row:ManagementReworkRow)=>urls.pageUrl(`ui/${queue==='pending_ie_review'?'process-configuration':'work-reporting'}?${new URLSearchParams({
  rework:row.reworkOrderId,ieReturn:reworkHref({...query,focus:row.reworkOrderId})})}`);
 const columns:TableColumn<ManagementReworkRow>[]=[
  {key:'styleNo',header:'款号',renderCell:row=>row.styleNo??'—'},
  {key:'reworkNo',header:'原业务单号',renderCell:row=><Link id={resultLinkId(row.reworkOrderId)} href={open(row)}>{row.reworkNo??row.orderNo??'打开原返工单'}</Link>},
  {key:'nodeLabel',header:'当前办理'},
  {key:'overdue',header:'时效',renderCell:row=>row.overdue?'已逾期':'—'},
 ];
 return <section aria-label="IE 返工核价与复核">
  <form id="ie-center-search" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onSubmit={event=>{event.preventDefault();if(!composing.current&&search.trim()!==query.search&&search.trim().length<=100)change({...query,page:1,search:search.trim()});}}>
   <TextInput label="搜索款号或原业务单号" value={search} onChange={setSearch}
    onKeyDown={event=>{if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();}}/>
   <Button label="搜索" type="submit" isDisabled={search.trim().length>100||search.trim()===query.search}/>
  </form>
  {read.value&&<nav aria-label="返工核价与复核队列">{read.value.statuses.flatMap(({status,totalCount})=>Object.hasOwn(reworkQueues,status)
   ?[<Link key={status} href={reworkHref({...query,page:1,queue:status as ReworkQuery['queue'],focus:undefined})}
     aria-current={status===queue?'page':undefined}>{reworkQueues[status as ReworkQuery['queue']]} · {totalCount}</Link>]:[])}</nav>}
  {read.error&&<p role="alert">{read.error.message} <Button label="重新读取返工队列" onClick={read.retry}/></p>}
  {read.value&&!active&&<p>所选返工队列无权读取，请选择有权查看的队列。</p>}
  {active?.items.length?<div className="development-table-scroll"><Table columns={columns} data={active.items} idKey="reworkOrderId" density="compact"/></div>:null}
  {active&&!active.items.length&&<p>{active.totalCount?'本页没有返工单，请回到有效页。':'暂无该条件下的返工办理。'}</p>}
  {active&&<AstryxPageControls page={page} total={active.totalCount} pageSize={active.pageSize} label="返工核价分页" onPageChange={value=>change({...query,page:value})}/>}
 </section>;
}

function SourcingDirectory({query}:{query:SourcingQuery}){
 const [search,setSearch]=useState(query.search),composing=useRef(false);
 const {page,search:term}=query;
 const load=useCallback(async(signal:AbortSignal)=>{
  const {readPendingIeSourcingCases}=await import('./sourcing-workspace-page.js');
  const result=await readPendingIeSourcingCases(page,term,signal);
  if(result.page!==page)throw Error('读取的外发核价页码有误，请重新读取。');
  return result;
 },[page,term]);
 const read=useForegroundRead('sourcing-ie',sourcingHref(query),load);
 useForegroundWait(read.foregroundKey);
 useDirectoryReturn(read.value!==null,query.focus);
 const change=(next:SourcingQuery)=>void navigateInternalPage(sourcingHref({...next,focus:undefined}));
 const columns:TableColumn<SourcingCaseSummary>[]=[
  {key:'styleNo',header:'款号'},
  {key:'erpOrderNo',header:'原业务单号',renderCell:row=><Link id={resultLinkId(row.sourcingCaseId)}
   href={sourcingHref({...query,caseId:row.sourcingCaseId,focus:undefined})}>{row.erpOrderNo}</Link>},
  {key:'version',header:'订单版次',renderCell:row=>`v${row.version}`},
  {key:'status',header:'当前办理',renderCell:()=> '待 IE 核价'},
 ];
 return <section aria-label="外发加工核价列表">
  <form id="ie-center-search" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onSubmit={event=>{event.preventDefault();if(!composing.current&&search.trim()!==term&&search.trim().length<=100)change({...query,page:1,search:search.trim()});}}>
   <TextInput label="搜索外发款号或单号" value={search} onChange={setSearch}
    onKeyDown={event=>{if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();}}/>
   <Button label="搜索" type="submit" isDisabled={search.trim().length>100||search.trim()===term}/>
  </form>
  {read.error&&<p role="alert">{read.error.message} <Button label="重新读取外发核价" onClick={read.retry}/></p>}
  {read.value?.items.length?<div className="development-table-scroll"><Table columns={columns} data={read.value.items} idKey="sourcingCaseId" density="compact"/></div>:null}
  {read.value&&!read.value.items.length&&<p>{read.value.totalCount?'本页没有外发核价单，请回到有效页。':'暂无该条件下待核价的外发单。'}</p>}
  {read.value&&<AstryxPageControls page={page} total={read.value.totalCount} pageSize={read.value.pageSize} label="外发核价分页" onPageChange={value=>change({...query,page:value})}/>}
 </section>;
}

export function IeProcessingCenter({search}:{search:string}){
 const values=new URLSearchParams(search),query=IeProcessingQuerySchema.safeParse(Object.fromEntries([...values].filter(([key])=>['page','search','state'].includes(key))));
 const selected=entryIdentity.safeParse({resource:{kind:values.get('kind'),id:values.get('id')},quoteId:values.get('quoteId'),rowId:values.get('rowId')});
 const detail=detailKeys.some(key=>values.has(key));
 const channel=values.get('channel');
 const focus=returnFocus.safeParse(values.get('focus')??undefined);
 const rework=channel==='rework'?reworkQuery.safeParse(Object.fromEntries(values)):null;
 const sourcing=channel==='sourcing'?sourcingQuery.safeParse(Object.fromEntries(values)):null;
 const invalid=[...new Set(values.keys())].some(key=>values.getAll(key).length!==1)
  ||values.has('channel')&&!rework&&!sourcing||Boolean(rework&&!rework.success)||Boolean(sourcing&&!sourcing.success)
  ||!query.success||detail&&!selected.success;
 return <div className="development-workspace digital-production dx-designer-astryx">
  <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style><h1>IE 报价与核价中心</h1>
  <nav aria-label="报价来源">
   <Link href={urls.pageUrl(entryRoute)} aria-current={!channel?'page':undefined}>产品加工报价</Link>
   <Link href={sourcingHref({channel:'sourcing',search:'',page:1})} aria-current={sourcing?.success?'page':undefined}>外发加工核价</Link>
   <Link href={reworkHref({channel:'rework',queue:'pending_ie_review',search:'',page:1})} aria-current={rework?.success?'page':undefined}>返工核价与复核</Link>
  </nav>
  {invalid||!query.success||!focus.success?<p role="alert">报价列表或明细链接无效。 <Link href={urls.pageUrl(entryRoute)}>返回报价列表</Link></p>
   :rework?.success?<ReworkDirectory key={reworkHref(rework.data)} query={rework.data}/>
   :sourcing?.success?(sourcing.data.caseId
    ?<SourcingIeCenterDetail key={sourcing.data.caseId} sourcingCaseId={sourcing.data.caseId} back={sourcingHref({...sourcing.data,caseId:undefined,focus:sourcing.data.caseId})}/>
    :<SourcingDirectory key={sourcingHref(sourcing.data)} query={sourcing.data}/>)
   :detail&&selected.success?<ProcessingPriceDetail key={identityKey(selected.data)} selection={selected.data} back={centerHref(query.data,undefined,selected.data.quoteId)}/>
   :<ProcessingDirectory key={centerHref(query.data,undefined,focus.data)} query={query.data} focus={focus.data}/>}
 </div>;
}
