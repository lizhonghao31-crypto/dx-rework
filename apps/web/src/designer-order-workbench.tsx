import {RevisionCommentIntentContext,type RevisionCommentIntent} from './development-revision-comment-intent.js';
import {Link} from '@astryxdesign/core/Link';
import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {Table} from '@astryxdesign/core/Table';
import type {DevelopmentSheet,DevelopmentWorkbenchBasics,SaveDevelopmentWorkbenchBasics} from '@dx-rework/contracts/digital-development';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {DESIGNER_WORKBENCH_TASK_KINDS,type DevelopmentWorkspaceHandling,type DevelopmentWorkspaceItem} from '@dx-rework/contracts/digital-development-workspace';
import type {JourneyRecord,JourneyStageKey,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {createWebUrls} from '../url-contract.js';
import {CockpitOperationLog} from './cockpit-operation-log.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {DevelopmentCustomerConfirmation,useDevelopmentExecution} from './digital-development-execution-panel.js';
import {DevelopmentSampleHandoverPanel} from './development-sample-handover.js';
import {journeyRecordIdentity} from './digital-journey-cockpit-model.js';
import {digitalRequest} from './digital-production-api.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {DigitalQuotationPanel} from './digital-quotation-panel.js';
import {DesignerRelatedOriginals} from './designer-related-originals.js';
import {DESIGNER_ORDER_AREAS,type DesignerOrderArea} from './digital-workspace-navigation.js';
import {ProductionReadinessPanel} from './production-readiness-panel.js';
import {todoRouteHref} from './todo-route-link.js';
import {originalDocumentHref,type OriginalDocumentRef} from './original-document-directory.js';
import {navigateInternalPage} from './internal-navigation.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {OrderRushBadge} from './order-rush-badge.js';
import {createClientRequestId} from './client-request-id.js';

type VisibleArea=Exclude<DesignerOrderArea,'development'>|'quotation'|'shipping';
const labels:Record<VisibleArea,string>={document:'版单资料',handover:'交资料',customer:'客户意见',quotation:'报价',shipping:'样衣寄出',records:'订单单据',history:'操作记录'};
const labelsId=(area:VisibleArea)=>`designer-order-${area}`;
const urls=createWebUrls(import.meta.env.BASE_URL);
function designerCanExecute(task:DigitalTask,actorId:string|undefined){
 return Boolean(actorId&&task.assigneeId===actorId&&task.requiredRole==='sample_designer'&&
  DESIGNER_WORKBENCH_TASK_KINDS.has(task.taskKind)&&task.canExecute&&task.state==='ready'&&!task.paused);
}

const versionedDocuments=new Set(['development','budget','instruction','quotation']);
function originalRecordHref(record:JourneyRecord,returnTo:string){
 if(record.mode!=='read'||!record.url)return '';
 let href=digitalChildDetailHref(record.url,returnTo,urls.base);
 if(href&&record.domain==='task'){
  const target=new URL(href,'https://workbench.invalid');
  if(target.searchParams.get('task')!==record.id)return '';
  target.searchParams.set('taskView','read');href=target.pathname+target.search;
 }
 return href;
}

function RelatedWorkbenchDocuments({journey,stage,returnTo}:{journey:OrderJourney;stage:JourneyStageKey;returnTo:string}){
 const seen=new Set<string>();
 const entries=(records:Array<{record:JourneyRecord;label:string}>)=>records.flatMap(({record,label})=>{
  if(versionedDocuments.has(record.domain))return [];
  const href=originalRecordHref(record,returnTo),key=journeyRecordIdentity(record);
  if(!href||seen.has(key))return [];
  seen.add(key);return [{href,key,label}];
 });
 const local=entries((journey.stages.find(item=>item.key===stage)?.nodes??[]).flatMap(node=>node.records.map(record=>({record,
   label:[node.subject||node.label,node.round?`第 ${node.round} 轮`:null,journey.lines.find(line=>line.id===record.lineId)?.po].filter(Boolean).join(' · '),
  }))));
 const attached=stage==='creation'?entries(journey.links.map(record=>({record,label:record.domain==='production'?'实时生产看板':record.domain==='sourcing'?'外发原单':'查看关联原记录'}))):[];
 return local.length||attached.length?<ul aria-label="本阶段关联原记录">{[...local,...attached].map(item=><li key={item.key}>
   <Link type="inherit" href={item.href}>{item.label}</Link>
  </li>)}</ul>:<p>当前范围没有其它可查看的关联单据。</p>;
}

export function DesignerHandlingItems({handling,hrefFor,limit=Infinity}:{handling:DevelopmentWorkspaceHandling;hrefFor:(href:string)=>string;limit?:number}){
 const [expanded,setExpanded]=useState(false);
 const shown=expanded?handling.items:handling.items.slice(0,limit);
 const labels={mine:'轮到我',waiting:'等别人',returned:'退回要改'};
 return <div className="designer-current-actions">
  {shown.length?<ul>{shown.map(action=>{
   const target=new URL(todoRouteHref(action.route),'https://workbench.invalid');
   if(action.kind==='waiting')target.searchParams.set('taskView','read');
   const href=hrefFor(target.pathname+target.search);
   const description=<>{labels[action.kind]} · {action.label}{action.ownerName?`（${action.ownerName}）`:''}</>;
   return <li key={action.id}>{href?<Link type="inherit" href={href}>{description}</Link>:description}{action.reason&&<small>{action.reason}</small>}</li>;
  })}</ul>:<span>{handling.complete?'当前没有需要你办理的事项':'暂无已核实的当前任务'}</span>}
  {handling.items.length>limit&&<Button label={expanded?'收起办理事项':`展开其余 ${handling.items.length-limit} 项`} size="sm"
   aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}/>}
  {!handling.complete&&<small>部分事项尚未核对</small>}
 </div>;
}

function WorkbenchBasics({sheet,onSaved}:{sheet:DevelopmentSheet;onSaved:(value:DevelopmentWorkbenchBasics)=>void}){
 const [open,setOpen]=useState(false),[brand,setBrand]=useState(''),[referenceNote,setReferenceNote]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);
 const writing=useRef(false),operation=useRef<{payload:string;key:string}|null>(null),titleId=useId();
 const record=sheet.workbenchBasics??sheet.document?.workbenchSheet;
 const start=()=>{if(!record)return;setBrand(record.brand);setReferenceNote(record.referenceNote);setError('');setOpen(true);};
 const save=async()=>{
  if(writing.current)return;
  if(brand.trim().length>100||referenceNote.trim().length>100){setError('品牌和参考款说明各最多100个字符。');return;}
  const input:SaveDevelopmentWorkbenchBasics={brand,referenceNote,roundNumber:sheet.roundNumber??1,
   documentVersion:sheet.version,expectedRevision:sheet.workbenchBasics?.revision??0},payload=JSON.stringify(input);
  if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
  writing.current=true;setBusy(true);setError('');
  try{
   const saved=await digitalRequest<DevelopmentWorkbenchBasics>(`sources/${sheet.sourceId}/development/workbench-basics`,'PUT',input,operation.current.key);
   operation.current=null;onSaved(saved);setOpen(false);
  }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
  finally{writing.current=false;setBusy(false);}
 };
 return <>
  <Button type="button" size="sm" label="编辑基础信息" onClick={start}/>
  <Dialog isOpen={open} className="dx-designer-astryx" purpose="form" aria-labelledby={titleId}
   onOpenChange={value=>{if(!writing.current)setOpen(value);}} width="min(32rem, calc(100vw - 2rem))">
   <form className="development-technical-editor" onSubmit={event=>{event.preventDefault();void save();}}>
    <h2 id={titleId}>编辑基础信息</h2>
    <TextInput label="品牌" value={brand} onChange={setBrand} isDisabled={busy}/>
    <TextInput label="参考款 / 版型说明" value={referenceNote} onChange={setReferenceNote} isDisabled={busy}/>
    <p>客户、跟单、交期和已发布版单仍使用原更正或修订入口。</p>
    {error&&<p role="alert">{error}</p>}
    <div className="development-technical-actions">
     <Button type="button" variant="secondary" label="取消" isDisabled={busy} onClick={()=>setOpen(false)}/>
     <Button type="submit" variant="primary" label="保存基础信息" isDisabled={busy}/>
    </div>
   </form>
  </Dialog>
 </>;
}

export function DesignerOrderWorkbench({sourceId,round,actorId,item,sheet,image,document,confirmation,onClose,onChanged}:{sourceId:string;round?:number|undefined;actorId?:string|undefined;item?:DevelopmentWorkspaceItem|undefined;sheet?:DevelopmentSheet|undefined;image?:ReactNode;document:ReactNode;confirmation:ReactNode;onClose:()=>void;onChanged:()=>void}){
 const [focus,setFocus]=useState<VisibleArea|null>(()=>{
  const area=new URLSearchParams(window.location.search).get('area');
  const prior=DESIGNER_ORDER_AREAS.find(key=>key===area);
  return prior==='development'?'document':prior??null;
 });
 const [commentIntent,setCommentIntent]=useState<RevisionCommentIntent|null>(null);
 const [recordRefresh,setRecordRefresh]=useState(0);
 const [savedBasics,setSavedBasics]=useState<{version:number;round:number;value:DevelopmentWorkbenchBasics}|null>(null);
 const [records,setRecords]=useState<OrderJourney|null>(null),[recordError,setRecordError]=useState<Error|null>(null);
 const [originalVersionsReady,setOriginalVersionsReady]=useState(false);
 const [handoverReady,setHandoverReady]=useState(false);
 const current=sheet?.status==='published'&&(sheet.roundNumber??1)===(sheet.latestRoundNumber??1);
 const reloadRecords=()=>setRecordRefresh(value=>value+1);
 const changed=()=>{reloadRecords();onChanged();};
 useEffect(()=>{
  if(sheet?.sourceId!==sourceId)return;
  const controller=new AbortController();setRecordError(null);
  void digitalRequest<OrderJourney>(`journeys/${sourceId}${round?`?round=${round}`:''}`,'GET',undefined,undefined,{signal:controller.signal})
   .then(value=>{if(!controller.signal.aborted)setRecords(value);})
   .catch(reason=>{if(!controller.signal.aborted){setRecords(null);setRecordError(reason);}});
  return()=>controller.abort();
 },[sourceId,round,recordRefresh,sheet?.sourceId]);
 useEffect(()=>{
  if(!focus)return;
  if(!sheet||focus==='history'&&!records&&!recordError||focus==='records'&&!recordError&&(!records||!originalVersionsReady))return;
  const saved=window.history.state?.dxInternalRestoreScroll;
  if(saved?.path===window.location.pathname+window.location.search){setFocus(null);return;}
  const frame=requestAnimationFrame(()=>{
   const heading=window.document.getElementById(labelsId(focus));
   heading?.scrollIntoView({block:'start'});heading?.focus({preventScroll:true});setFocus(null);
  });
  return()=>cancelAnimationFrame(frame);
 },[focus,sheet,records,recordError,originalVersionsReady]);
 // Restore after the actual directory rows have rendered, rather than against
 // its shorter loading state and then letting browser scroll anchoring move it.
 const returningToRecords=new URLSearchParams(window.location.search).get('area')==='records';
 useInternalReturnScroll(Boolean(sheet)&&(!current||handoverReady)&&Boolean(records||recordError)&&(!returningToRecords||Boolean(recordError)||originalVersionsReady));

 const sourceQuery=(area:DesignerOrderArea)=>{
  const target=new URL(window.location.href);target.searchParams.set('area',area);return target.pathname+target.search;
 };
 const region=(area:VisibleArea,content:ReactNode)=><section key={area} className="dx-production-panel designer-order-area" aria-labelledby={labelsId(area)}>
  <h2 tabIndex={-1} id={labelsId(area)}>{labels[area]}</h2>
  {content}
 </section>;

 const journey=item?.journey;
 const exactRecords=records?.sourceId===sourceId&&(!round||records.selectedRound===round)?records:null;
 const orderDate=exactRecords?.cockpitCreationDetails?.find(entry=>entry.subject==='order')?.at;
 const scopedBasics=sheet&&savedBasics?.version===sheet.version&&savedBasics.round===(sheet.roundNumber??1)&&
   savedBasics.value.revision>(sheet.workbenchBasics?.revision??0)?savedBasics.value:sheet?.workbenchBasics;
 const basicFields=scopedBasics??sheet?.document?.workbenchSheet;
 const canEditBasics=sheet?.workbenchBasicsEditable&&sheet.document?.workbenchSheet&&
   (current||Boolean(sheet.preorderPublication&&(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)));
 const readResult=(render:(value:OrderJourney)=>ReactNode)=>recordError
  ?<DigitalReadFailure error={recordError} onRetry={reloadRecords} retryLabel="重试读取原记录"/>
  :exactRecords?render(exactRecords):<p role="status">正在读取本单授权记录…</p>;

 return <RevisionCommentIntentContext.Provider value={{target:commentIntent,start:setCommentIntent,
  clear:intent=>setCommentIntent(current=>current===intent?null:current)}}>
  <div className="designer-order-workbench">
  <header className="dx-production-panel designer-order-identity">
   <Button label="返回来源" size="sm" onClick={onClose}/>
   <h1>本单资料</h1>
   <div className="designer-order-summary">{image}<div>
    <h2>{journey?.designStyleNo??sheet?.designStyleNo??'正在读取订单'} <OrderRushBadge value={sheet?sheet.orderRush:item?.orderRush}/></h2>
    {canEditBasics&&<WorkbenchBasics sheet={{...sheet,...(scopedBasics?{workbenchBasics:scopedBasics}:{})}}
     onSaved={value=>{setSavedBasics({version:sheet.version,round:sheet.roundNumber??1,value});reloadRecords();}}/>}
    <dl><div><dt>订单ID</dt><dd>{sheet?.numberedIdentity?.orderNumber??journey?.identity?.businessNumber??'—'}</dd></div>
     <div><dt>客户</dt><dd>{journey?.customer??sheet?.customerCode??'—'}</dd></div>
     <div><dt>设计师</dt><dd>{journey?.designer??sheet?.designerName??'—'}</dd></div>
     <div><dt>跟单</dt><dd>{journey?.merchandisers.map(person=>person.name??'姓名未登记').join('、')||'—'}</dd></div>
     <div><dt>下单日期</dt><dd>{orderDate?beijingCalendarDate(new Date(orderDate)):'—'}</dd></div>
     <div><dt>性别</dt><dd>{sheet?.document?.workbenchSheet?.gender??'—'}</dd></div>
     <div><dt>板类</dt><dd>{sheet?.document?.workbenchSheet?.boardType??'—'}</dd></div>
     <div><dt>打板类型</dt><dd>{sheet?.developmentType??journey?.developmentType??'—'}</dd></div>
     <div><dt>服装模板</dt><dd>{sheet?.document?.template??'—'}</dd></div>
     <div><dt>销售年份</dt><dd>{sheet?.numberedSales?.year??'—'}</dd></div>
     <div><dt>销售系列</dt><dd>{sheet?.numberedSales?.series??'—'}</dd></div>
     <div><dt>品牌</dt><dd>{basicFields?.brand||'—'}</dd></div>
     <div><dt>参考款 / 版型说明</dt><dd>{basicFields?.referenceNote||'—'}</dd></div>
     <div><dt>开发资料</dt><dd>{sheet?`第 ${sheet.roundNumber??1} 轮 · v${sheet.version}`:'—'}</dd></div>
     <div><dt>采用资料</dt><dd>{journey?.adoptedRound?`开发第 ${journey.adoptedRound} 轮`:'—'}{journey?.instructionVersion?` · 制单 v${journey.instructionVersion}`:''}</dd></div>
     <div><dt>正式订单</dt><dd>{journey?.orderId?journey.orderNumbers.join('、')||'已确认下单':journey?'尚未确认下单':'—'}</dd></div>
    </dl>
   </div></div>
   {journey?.orderId&&journey.lines.length>0&&<div className="development-table-scroll" role="region" aria-label="逐 PO 数量与交期" tabIndex={0}>
    <Table data={journey.lines} idKey="id" density="balanced" columns={[
     {key:'po',header:'PO',renderCell:line=>line.po??'未登记'},
     {key:'color',header:'颜色'},
     {key:'orderedQuantity',header:'数量',renderCell:line=>line.orderedQuantity.toLocaleString()},
     {key:'deliveryDate',header:'客户交期',renderCell:line=>journey.poDeliveryDates?.find(date=>date.lineId===line.id)?.customerWarehouseArrivalDate??'未登记'},
    ]}/>
   </div>}
  </header>
  {region('document',document)}
  {region('handover',current?<><DevelopmentSampleHandoverPanel sourceId={sourceId} round={sheet.roundNumber??1} documentVersion={sheet.version}
    refreshRevision={recordRefresh} onReady={setHandoverReady}/>
    <ProductionReadinessPanel resource={{kind:'source',id:sourceId}} sourceDocumentVersion={sheet.version} designHandoverOnly onChanged={changed}/>
   </>:<p>请从当前有效资料查看原交接方式。</p>)}
  {current?<CurrentDevelopmentAreas key={`${sourceId}:${sheet.roundNumber??1}`} sourceId={sourceId} actorId={actorId} revision={sheet.materialEvents.length} changed={changed}
    region={region} sheet={sheet} returnToHandover={sourceQuery('handover')} confirmation={confirmation}/>
   :<>{region('customer',sheet?.preorderPublication&&confirmation?confirmation:<p>请切换到当前已发布轮次办理客户意见。</p>)}
     {region('quotation',<p>请从当前有权报价或订单单据查看原版本。</p>)}
     {region('shipping',<p>请从当前轮次查看原寄样记录。</p>)}</>}
  {region('records',readResult(journey=>{
   const openOriginal=(ref:OriginalDocumentRef)=>{
    const href=originalDocumentHref(ref,sourceQuery('records'),urls.base);if(href)void navigateInternalPage(href);
   };
   return <DesignerRelatedOriginals key={`${sourceId}:${round??'current'}`} order={journey} materials={sheet?.document?.materials??[]}
    returnTo={sourceQuery('records')} onOriginal={openOriginal} onReady={setOriginalVersionsReady}
    relatedOriginals={(stage,returnTo)=><RelatedWorkbenchDocuments journey={journey} stage={stage} returnTo={returnTo}/>}/>;
  }))}
  {region('history',readResult(journey=><CockpitOperationLog order={journey} embedded/>))}
 </div></RevisionCommentIntentContext.Provider>;
}

function CurrentDevelopmentAreas({sourceId,actorId,revision,changed,region,sheet,returnToHandover,confirmation}:{
 sourceId:string;actorId:string|undefined;revision:number;changed:()=>void;region:(area:VisibleArea,content:ReactNode)=>ReactNode;
 sheet:DevelopmentSheet;returnToHandover:string;confirmation:ReactNode;
}){
 const controller=useDevelopmentExecution({sourceId,materialRevision:revision,onChanged:changed});
 const state=controller.state;
 const round=sheet.roundNumber??1;
 const tasks=state?.sheet.sourceId===sourceId&&state.sheet.roundNumber===sheet.roundNumber
  ?state.tasks.filter(task=>task.sourceId===sourceId&&task.routeVersion===round):[];
 const shipping=tasks.find(task=>task.taskKind==='development_shipping'&&designerCanExecute(task,actorId));
 const shippingHref=shipping?digitalChildDetailHref('/ui/digital-production?'+new URLSearchParams({task:shipping.taskId,taskView:'handle'}),returnToHandover,urls.base):'';
 return <>{region('customer',<>{confirmation}
   {controller.readError?<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} retryLabel="重试读取客户意见"/>:null}
   {state?.sheet.sourceId===sourceId?<DevelopmentCustomerConfirmation controller={controller} direct/>
    :!controller.readError?<p role="status">正在核对办理资格…</p>:null}
   {controller.writeError&&<p role="alert">{controller.writeError}</p>}</>)}
  {region('quotation',<DigitalQuotationPanel resource={{kind:'source',id:sourceId}} designerWorkbench={{actorId}} onChanged={changed}/>)}
  {region('shipping',shippingHref?<Link type="inherit" href={shippingHref}>打开原寄样任务</Link>:controller.readError
     ?<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} retryLabel="重试读取寄样任务"/>
     :state?<p>本轮没有当前可由本人办理的寄样任务。</p>:<p role="status">正在核对寄样资格…</p>)}
 </>;
}
