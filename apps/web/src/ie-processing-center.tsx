import {lazy,useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Stack} from '@astryxdesign/core/Stack';
import {Table,type TableColumn} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {z} from 'zod';
import {formatBusinessDecimal} from '@dx-rework/contracts/business-display';
import {IeProcessingDirectorySchema,IeProcessingEntrySchema,IeProcessingQuerySchema,IeProcessingStateSchema,QuotationResourceSchema,QuotationRowInputSchema,
 UnifiedIeDirectoryPageSchema,UnifiedIeDirectoryQuerySchema,type UnifiedIeDirectoryEntry,type UnifiedIeDirectoryQuery,
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
import {OrderRushBadge} from './order-rush-badge.js';
import {QuotationBasisImage} from './quotation-basis-image.js';
import './quotation-basis.css';
import './ie-quotation-detail.css';
import {useForegroundWait} from './foreground-loading.js';
import {navigateInternalPage} from './internal-navigation.js';
import {loadReworkQueue} from './reporting/reporting-client.js';
import {useSubmissionFeedback} from './submission-feedback.js';
import {SubmissionRequestError} from './submission-validation.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {useLiveSearch} from './use-live-search.js';
import {parseUnifiedIeLocation,unifiedIeEntryKey,unifiedIeHref,unifiedIeListLabel,unifiedIeOriginalHref,unifiedIeStateLabel,type UnifiedIeLocation} from './ie-unified-directory-routes.js';
import {readUnifiedIeDirectory,type UnifiedDirectoryLoad} from './ie-unified-directory-source.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
const entryRoute='ui/ie-processing';
const unifiedPaths={directory:urls.pageUrl(entryRoute),reworkProcess:urls.pageUrl('ui/process-configuration'),
 reworkReporting:urls.pageUrl('ui/work-reporting')};
const processingQuoteLabel='外发加工报价';
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
 view:z.enum(['pending','history']).optional(),
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
function sourcingHref({channel, page, search, view, caseId, focus}:SourcingQuery){
 const params=new URLSearchParams({channel,page:String(page),search});
 if(view==='history')params.set('view',view);
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
 const unified=parseUnifiedIeLocation(target.searchParams);
 const href=parsed.success?reworkHref(parsed.data):unified&&!unified.detail?unifiedIeHref(unifiedPaths.directory,unified,{focus:unified.focus}):null;
 return href?<div className="dx-designer-astryx">
  <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style><Link href={href}>返回 IE 报价与核价中心</Link>
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
  return {sheet,canEdit:directoryEntry.canEditPrice,orderRush:directoryEntry.orderRush,basis:directoryEntry.basis,
   styleName:directoryEntry.styleName,round:directoryEntry.round,assigneeName:directoryEntry.assigneeName,
   state:directoryEntry.state,priceReview:directoryEntry.priceReview};
 },[base,resource,quoteId,rowId,target]);
 const read=useForegroundRead(resource.id,target,load);
 useForegroundWait(read.foregroundKey);
 const [draft,setDraft]=useState<string|null>(null),[busy,setBusy]=useState(false),[fieldError,setFieldError]=useState(''),[receipt,setReceipt]=useState<number|null>(null);
 const [resent,setResent]=useState(false);
 const saving=useRef(false),feedback=useSubmissionFeedback(setBusy);
 const sheet=read.value?.sheet,row=sheet?.rows.find(row=>row.rowId===rowId),canEdit=Boolean(read.value?.canEdit&&row?.canEditPrice);
 const basis=read.value?.basis,photo=basis?.styleImage;
 const review=read.value?.priceReview;
 const sizeColumns:TableColumn<NonNullable<typeof basis>['measurements'][number]>[]=basis?[
  {key:'name',header:`尺寸项（${basis.sizeUnit}）`},...basis.sizes.map((size,index)=>({key:`size-${index}`,header:size,renderCell:(measure:NonNullable<typeof basis>['measurements'][number])=>measure.values[index]||'—'})),
 ]:[];
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
 const resubmit=()=>{
  const requested=review?.resubmitFieldVersion;
  if(saving.current||busy||changed||feedback.uncertain||read.waiting||!canEdit||resent||!review?.canResubmit||!requested||!sheet)return;
  const key=createClientRequestId(),actor=sessionCacheVersion();
  const body={action:'resubmit',reviewId:review.reviewId,expectedFieldVersion:requested};
  void feedback.run(async()=>{
   if(actor!==sessionCacheVersion())throw new SubmissionRequestError('登录身份已变化，请回到原账号核对。','FORBIDDEN',403);
   saving.current=true;
   try{
    const reply=await digitalRequest<unknown>(`${base}/workbench-review`,'POST',body,key);
    const checked=z.object({resource:QuotationResourceSchema,quoteId:z.uuid(),version:z.number().int(),
     commandReceipt:z.object({action:z.literal('workbench-review:resubmit'),appliedVersion:z.number().int().positive()})}).safeParse(reply);
    if(actor!==sessionCacheVersion()||!checked.success||checked.data.quoteId!==quoteId||checked.data.resource.id!==resource.id
     ||checked.data.resource.kind!==resource.kind||checked.data.commandReceipt.appliedVersion<sheet.version
     ||checked.data.version<checked.data.commandReceipt.appliedVersion)throw Error('未收到本行重报的原命令回执。');
    feedback.confirmed();setResent(true);read.refreshSilently();
   }catch(reason){
    if(reason instanceof DigitalRequestError&&!reason.resultUnknown&&reason.status!==null)throw new SubmissionRequestError(reason.message,reason.code,reason.status);
    throw reason;
   }finally{saving.current=false;}
  });
 };
 return <section aria-label={processingQuoteLabel} className="ie-quotation-detail">
  <Link href={back}>返回报价列表</Link>
  {read.error&&<p role="alert">{receipt!==null?'报价已保存，重新读取失败。 ':''}{read.error.message} <Button label="重新读取报价" isDisabled={busy||feedback.uncertain} onClick={read.retry}/></p>}
  {sheet&&row&&<>
   <header className="ie-quotation-heading">
    <div><h2>{sheet.designStyleNo}<OrderRushBadge value={read.value?.orderRush}/>{read.value?.styleName&&<> · {read.value.styleName}</>}</h2>
     <p>{[sheet.customerCode??'未维护客户',`第 ${read.value!.round} 轮 · v${receipt??sheet.version}`,basis?`开发资料 v${basis.sourceVersion}`:'',
      `报价负责人 ${read.value?.assigneeName??'—'}`].filter(Boolean).join('　')}</p>
    </div><Badge label={review?(review.status==='resubmitted'||resent?'已重报，待复核':'退回重核'):stateNames[read.value!.state]}
     variant={review?'error':read.value!.state==='priced'?'success':'neutral'}/>
   </header>
   <div className="ie-quotation-sides">
   <section aria-label="本行核价依据" className="quotation-basis ie-quotation-card">
    <h3>本行核价依据</h3>
    <p>{[row.name,row.specification,row.unit].filter(Boolean).join(' · ')}</p>
    {basis?<>
    <div className="ie-quotation-basis-body">
     <div>{photo?<QuotationBasisImage key={photo.attachmentId} label="本版款图" href={urls.apiUrl(`digital-production/quotations/ie-processing/${quoteId}/${rowId}/style-image/${photo.attachmentId}?documentVersion=${photo.documentVersion}`)}/>:<p>本版未登记款图。</p>}</div>
     <dl><dt>开发类型</dt><dd>{basis.developmentType} · {basis.template}{basis.technicalVersion!==null&&` · 采用技术成果 v${basis.technicalVersion}`}</dd>
     <dt>制作要求</dt><dd>{basis.instructions||'—'}</dd><dt>工艺 / 洗水</dt><dd>{basis.craft} / {basis.washing}</dd>
     <dt>样衣数量</dt><dd>{basis.quantity??'—'}</dd><dt>PO</dt><dd>{basis.formalPoNos.join('、')||'—'}</dd>
     <dt>材料</dt><dd>{basis.materials.map(item=>[item.category,item.name,item.specification].filter(Boolean).join(' · ')).join('；')||'—'}</dd></dl>
    </div>
    {basis.measurements.length>0&&<div className="development-table-scroll"><Table columns={sizeColumns} data={basis.measurements} idKey={measure=>measure.name} aria-label="核价尺寸依据" density="compact"/></div>}
    </>:<p>本行没有关联可核的开发资料。</p>}
   </section>
   <section aria-label="填写加工单价" className="ie-quotation-card ie-quotation-price">
   <h3>填写加工单价</h3>
   {review&&<div aria-label="本行退回重核">
    <p>{review.status==='resubmitted'||resent?'已重报，待复核':'退回重核'} · {review.reason}</p>
    {review.status==='returned'&&!resent&&(review.canResubmit?<Button label="重报本行核价" isDisabled={busy||changed||feedback.uncertain||read.waiting} onClick={resubmit}/>
     :<p>请先保存本行的新单价，再重报。</p>)}
   </div>}
   <form onSubmit={event=>{event.preventDefault();save();}}>
    <Stack gap={2} maxWidth={480}>
     <TextInput label="加工单价" inputMode="decimal" placeholder="请输入加工单价" value={receipt!==null?price:draft??price}
      isDisabled={read.waiting||busy||feedback.uncertain||!canEdit||receipt!==null}
      onChange={value=>{setDraft(value);setFieldError('');}}
      {...(fieldError?{status:{type:'error',message:fieldError}}:{})}/>
     <span className="ie-quotation-unit">元 / 件</span>
     {canEdit&&receipt===null&&<div><Button type="submit" label="保存加工单价" variant="primary" isDisabled={!changed||busy||feedback.uncertain||read.waiting}/></div>}
    </Stack>
   </form>
   </section>
   </div>
  </>}
  {feedback.notice&&<p role="status">{feedback.notice}</p>}
  {feedback.uncertain&&<Button label="核对上次提交结果" isDisabled={busy} onClick={()=>void feedback.retry()}/>}
  {receipt!==null&&<p role="status">本行报价已保存 · v{receipt}</p>}
  {resent&&<p role="status">本行核价已重报，等待复核。</p>}
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
  {key:'style',header:'款号',renderCell:row=><><Link id={resultLinkId(row.quoteId)} href={centerHref(query,row)}>{row.styleNo}</Link><OrderRushBadge value={row.orderRush}/></>},
  {key:'customer',header:'客户',renderCell:row=>row.customerCode??'—'},
  {key:'version',header:'轮次／版本',renderCell:row=>`第 ${row.round} 轮 · v${row.version}`},
  {key:'assignee',header:'负责人',renderCell:row=>row.assigneeName??'待指派'},
  {key:'state',header:'状态',renderCell:row=>stateNames[row.state]},
 ];
 return <section aria-label={`${processingQuoteLabel}列表`}>
  <form id="ie-center-search" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onSubmit={event=>{event.preventDefault();if(!composing.current&&search.trim()!==query.search&&search.trim().length<=100)change({...query,page:1,search:search.trim()});}}>
   <TextInput label="搜索订单ID、款号、PO或客户" value={search} onChange={setSearch}
    onKeyDown={event=>{if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();}}/>
   <Button label="搜索" type="submit" isDisabled={search.trim().length>100||search.trim()===query.search}/>
   <Selector label="报价状态" value={query.state} options={Object.entries(stateNames).map(([value,label])=>({value,label}))}
    onChange={value=>{const state=IeProcessingStateSchema.safeParse(value);if(value==='all'||state.success)change({...query,page:1,state:state.success?state.data:'all'});}}/>
  </form>
  {read.error&&<p role="alert">{read.error.message} <Button label="重新读取报价列表" onClick={read.retry}/></p>}
  {read.value?.items.length?<div className="development-table-scroll"><Table columns={columns} data={read.value.items} idKey={identityKey} density="compact"/></div>:null}
  {read.value&&!read.value.items.length&&<p>{read.value.total?'本页没有已授权报价，请回到有效页。':`暂无该条件下的${processingQuoteLabel}。`}</p>}
  {read.value&&<AstryxPageControls page={query.page} total={read.value.total} pageSize={read.value.pageSize} label={`${processingQuoteLabel}分页`} onPageChange={page=>change({...query,page})}/>}
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
  {read.value&&<nav aria-label="返工核价与复核队列"><Stack direction="horizontal" gap={3} wrap="wrap" paddingBlockEnd={3}>{read.value.statuses.flatMap(({status,totalCount})=>Object.hasOwn(reworkQueues,status)
   ?[<Link key={status} href={reworkHref({...query,page:1,queue:status as ReworkQuery['queue'],focus:undefined})}
     hasUnderline={status===queue} aria-current={status===queue?'page':undefined}>{reworkQueues[status as ReworkQuery['queue']]} · {totalCount}</Link>]:[])}</Stack></nav>}
  {read.error&&<p role="alert">{read.error.message} <Button label="重新读取返工队列" onClick={read.retry}/></p>}
  {read.value&&!active&&<p>所选返工队列无权读取，请选择有权查看的队列。</p>}
  {active?.items.length?<div className="development-table-scroll"><Table columns={columns} data={active.items} idKey="reworkOrderId" density="compact"/></div>:null}
  {active&&!active.items.length&&<p>{active.totalCount?'本页没有返工单，请回到有效页。':'暂无该条件下的返工办理。'}</p>}
  {active&&<AstryxPageControls page={page} total={active.totalCount} pageSize={active.pageSize} label="返工核价分页" onPageChange={value=>change({...query,page:value})}/>}
 </section>;
}

function SourcingDirectory({query}:{query:SourcingQuery}){
 const [search,setSearch]=useState(query.search),composing=useRef(false);
 const {page,search:term,view}=query,history=view==='history';
 const load=useCallback(async(signal:AbortSignal)=>{
  const {readIeSourcingCases}=await import('./sourcing-workspace-page.js');
  const result=await readIeSourcingCases(page,term,history,signal);
  if(result.page!==page)throw Error('读取的外发核价页码有误，请重新读取。');
  return result;
 },[page,term,history]);
 const read=useForegroundRead('sourcing-ie',sourcingHref(query),load);
 useForegroundWait(read.foregroundKey);
 useDirectoryReturn(read.value!==null,query.focus);
 const change=(next:SourcingQuery)=>void navigateInternalPage(sourcingHref({...next,focus:undefined}));
 const columns:TableColumn<SourcingCaseSummary>[]=[
  {key:'styleNo',header:'款号'},
  {key:'erpOrderNo',header:'原业务单号',renderCell:row=><Link id={resultLinkId(row.sourcingCaseId)}
   href={sourcingHref({...query,caseId:row.sourcingCaseId,focus:undefined})}>{row.erpOrderNo}</Link>},
  {key:'version',header:'订单版次',renderCell:row=>`v${row.version}`},
  {key:'status',header:'当前办理',renderCell:row=>row.status==='pending_ie_quote'?'待 IE 核价':row.status==='pending_merchandiser_correction'?'等待跟单修改':'已提交 IE 核价'},
 ];
 return <section aria-label="外发加工核价列表">
  <form id="ie-center-search" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onSubmit={event=>{event.preventDefault();if(!composing.current&&search.trim()!==term&&search.trim().length<=100)change({...query,page:1,search:search.trim()});}}>
   <TextInput label="搜索外发款号或单号" value={search} onChange={setSearch}
    onKeyDown={event=>{if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();}}/>
   <Button label="搜索" type="submit" isDisabled={search.trim().length>100||search.trim()===term}/>
   <Selector label="外发核价范围" value={history?'history':'pending'} options={[{value:'pending',label:'待核价'},{value:'history',label:'已办理记录'}]}
    onChange={value=>{if(value==='history'||value==='pending')change({...query,page:1,view:value});}}/>
  </form>
  {read.error&&<p role="alert">{read.error.message} <Button label="重新读取外发核价" onClick={read.retry}/></p>}
  {read.value?.items.length?<div className="development-table-scroll"><Table columns={columns} data={read.value.items} idKey="sourcingCaseId" density="compact"/></div>:null}
  {read.value&&!read.value.items.length&&<p>{read.value.totalCount?'本页没有外发核价单，请回到有效页。':history?'暂无该条件下已办理的外发核价。':'暂无该条件下待核价的外发单。'}</p>}
  {read.value&&<AstryxPageControls page={page} total={read.value.totalCount} pageSize={read.value.pageSize} label="外发核价分页" onPageChange={value=>change({...query,page:value})}/>}
 </section>;
}

function UnifiedIeDirectory({location,readDirectory}:{location:UnifiedIeLocation;readDirectory:UnifiedDirectoryLoad}){
 const {kind,page,search,state='all'}=location;
 const query={kind,page,search,state};
 const [draft,setDraft]=useState(search);
 useEffect(()=>setDraft(search),[search]);
 const change=(next:UnifiedIeDirectoryQuery,replace=false)=>void navigateInternalPage(unifiedIeHref(unifiedPaths.directory,next),{replace});
 const live=useLiveSearch(draft.length<=100?draft:search,search,value=>change({...query,search:value,page:1},true));
 const key=unifiedIeHref(unifiedPaths.directory,query);
 const load=useCallback(async(signal:AbortSignal)=>{
  const result=UnifiedIeDirectoryPageSchema.parse(await readDirectory({kind,page,search,state},signal));
  if(result.page!==page||result.items.some(row=>kind!=='all'&&row.kind!==kind||state!=='all'&&row.state!==state))throw Error('读取的 IE 报价目录与当前选择不一致。');
  return result;
 },[kind,page,search,state,readDirectory]);
 const read=useForegroundRead('unified-ie',key,load);
 useForegroundWait(read.foregroundKey);
 useDirectoryReturn(read.value!==null,location.focus);
 const columns:TableColumn<UnifiedIeDirectoryEntry>[]=[
  {key:'orderId',header:'订单 ID／款号',renderCell:row=>{
   const href=unifiedIeOriginalHref(unifiedPaths,query,row),label=row.orderId??row.styleNo??'查看原记录';
   return href?<><Link id={resultLinkId(unifiedIeEntryKey(row))} href={href}>{label}</Link><OrderRushBadge value={row.orderRush}/></>:label;
  }},
  {key:'customerCode',header:'客户',renderCell:row=>row.customerCode??'—'},
  {key:'styleName',header:'款式（品名）',renderCell:row=><span className="ie-quotation-name">{row.styleName??'—'}</span>},
  {key:'kind',header:'报价类型',renderCell:row=>unifiedIeListLabel[row.kind]},
  {key:'pricing',header:'报价 / 单位',renderCell:row=>row.pricing?.kind==='multiple'?'多项价格':row.pricing?.kind==='single'
   ?<span title={`${row.pricing.amount} 元 / ${row.pricing.unit}`}>{formatBusinessDecimal(row.pricing.amount,1)} 元 / {row.pricing.unit}{row.state==='returned'?'（上次）':''}</span>:'—'},
  {key:'version',header:'轮次／版本',renderCell:row=>row.round===null?`v${row.version}`:`第 ${row.round} 轮 · v${row.version}`},
  {key:'assigneeName',header:'负责人',renderCell:row=>row.assigneeName??'—'},
  {key:'state',header:'状态',renderCell:row=><Badge label={unifiedIeStateLabel[row.state]} variant={row.state==='priced'?'success':row.state==='not_started'?'neutral':'error'}/>},
  {key:'nativeStatus',header:'当前办理',renderCell:row=>row.kind==='rework_review'&&Object.hasOwn(reworkQueues,row.nativeStatus)
   ?reworkQueues[row.nativeStatus as keyof typeof reworkQueues]:row.kind==='sourcing_review'&&row.nativeStatus==='pending_ie_quote'?'待核价':'—'},
 ];
 return <section aria-label="IE 报价与核价目录">
  <Stack id="ie-center-search" direction="horizontal" gap={3} wrap="wrap">
   <div onCompositionStart={live.onCompositionStart} onCompositionEnd={live.onCompositionEnd}>
    <TextInput label="搜索订单 ID、原款号、PO 或客户" value={draft} onChange={setDraft}
     {...(draft.length>100?{status:{type:'error',message:'请输入不超过 100 字的搜索内容'}}:{})}/>
   </div>
   <Selector label="报价状态" value={state} options={Object.entries(unifiedIeStateLabel).map(([value,label])=>({value,label}))}
    onChange={value=>{const next=UnifiedIeDirectoryQuerySchema.safeParse({kind,state:value,search,page:1});if(next.success&&next.data.state!==state)change(next.data);}}/>
   <Selector label="报价类型" value={kind} options={Object.entries(unifiedIeListLabel).map(([value,label])=>({value,label}))}
    onChange={value=>{const next=UnifiedIeDirectoryQuerySchema.safeParse({kind:value,state,search,page:1});if(next.success&&next.data.kind!==kind)change(next.data);}}/>
  </Stack>
  {read.error&&<p role="alert">{read.error.message} <Button label="重新读取目录" onClick={read.retry}/></p>}
  {read.value?.items.length?<div className="development-table-scroll"><Table columns={columns} data={read.value.items} idKey={unifiedIeEntryKey} density="compact"/></div>:null}
  {read.value&&!read.value.items.length&&<p>{read.value.total?'本页没有匹配记录，请回到有效页。':'没有匹配的已授权报价或核价记录。'}</p>}
  {read.value&&<AstryxPageControls page={page} total={read.value.total} pageSize={read.value.pageSize} label="IE 报价与核价分页"
   busy={read.waiting||live.pending||draft.length>100} onPageChange={next=>change({...query,page:next})}/>}
 </section>;
}

export function IeProcessingCenter({search}:{search:string}){
 const values=new URLSearchParams(search),query=IeProcessingQuerySchema.safeParse(Object.fromEntries([...values].filter(([key])=>['page','search','state'].includes(key))));
 const unified=parseUnifiedIeLocation(values);
 if(values.get('directory')==='unified'&&!unified)return <p role="alert">IE 报价目录链接无效。</p>;
 if(unified){
  const pick=unified.detail,back=unifiedIeHref(unifiedPaths.directory,unified,{focus:unified.focus});
  return <div className="development-workspace digital-production dx-designer-astryx">
   <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style><h1>IE 报价与核价中心</h1>
   {pick?.type==='processing_quote'?<ProcessingPriceDetail key={pick.rowId} selection={{resource:{kind:pick.resourceKind,id:pick.id},quoteId:pick.quoteId,rowId:pick.rowId}} back={back}/>
    :pick?.type==='sourcing_review'?<SourcingIeCenterDetail key={pick.caseId} sourcingCaseId={pick.caseId} back={back}/>
    :<UnifiedIeDirectory location={unified} readDirectory={readUnifiedIeDirectory}/>}
  </div>;
 }
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
  <nav aria-label="报价来源"><Stack direction="horizontal" gap={3} wrap="wrap">
   <Link href={urls.pageUrl(entryRoute)} hasUnderline={!channel} aria-current={!channel?'page':undefined}>{processingQuoteLabel}</Link>
   <Link href={sourcingHref({channel:'sourcing',search:'',page:1})} hasUnderline={Boolean(sourcing?.success)} aria-current={sourcing?.success?'page':undefined}>外发加工核价</Link>
   <Link href={reworkHref({channel:'rework',queue:'pending_ie_review',search:'',page:1})} hasUnderline={Boolean(rework?.success)} aria-current={rework?.success?'page':undefined}>返工核价与复核</Link>
  </Stack></nav>
  {invalid||!query.success||!focus.success?<p role="alert">报价列表或明细链接无效。 <Link href={urls.pageUrl(entryRoute)}>返回报价列表</Link></p>
   :rework?.success?<ReworkDirectory key={reworkHref(rework.data)} query={rework.data}/>
   :sourcing?.success?(sourcing.data.caseId
    ?<SourcingIeCenterDetail key={sourcing.data.caseId} sourcingCaseId={sourcing.data.caseId} back={sourcingHref({...sourcing.data,caseId:undefined,focus:sourcing.data.caseId})}/>
    :<SourcingDirectory key={sourcingHref(sourcing.data)} query={sourcing.data}/>)
   :detail&&selected.success?<ProcessingPriceDetail key={identityKey(selected.data)} selection={selected.data} back={centerHref(query.data,undefined,selected.data.quoteId)}/>
   :<ProcessingDirectory key={centerHref(query.data,undefined,focus.data)} query={query.data} focus={focus.data}/>}
 </div>;
}
