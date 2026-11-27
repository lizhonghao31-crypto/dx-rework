import {DevelopmentFeedbackHistory} from './development-technical-workspace.js';
import {DevelopmentEntryAction,DevelopmentEntryDate,DevelopmentEntryText} from './development-entry-controls.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {RevisionCommentIntentContext,type RevisionCommentIntent} from './development-revision-comment-intent.js';
import {Link} from '@astryxdesign/core/Link';
import {useEffect,useState,type ReactNode} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Table} from '@astryxdesign/core/Table';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {DESIGNER_WORKBENCH_TASK_KINDS,type DevelopmentWorkspaceHandling,type DevelopmentWorkspaceItem} from '@dx-rework/contracts/digital-development-workspace';
import type {JourneyRecord,JourneyStageKey,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {createWebUrls} from '../url-contract.js';
import {CockpitOperationLog} from './cockpit-operation-log.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {DevelopmentCustomerConfirmation,useDevelopmentExecution} from './digital-development-execution-panel.js';
import {DevelopmentSampleHandoverPanel} from './development-sample-handover.js';
import {developmentShippingLabel,developmentShippingTone} from './development-shipping-display.js';
import {journeyRecordIdentity} from './digital-journey-cockpit-model.js';
import {digitalRequest} from './digital-production-api.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {DigitalQuotationPanel,type QuotationWorkbenchHeadline} from './digital-quotation-panel.js';
import {DESIGNER_QUOTATION_STATUS_DISPLAY} from '@dx-rework/contracts/digital-quotation';
import {DesignerRelatedOriginals} from './designer-related-originals.js';
import {DESIGNER_ORDER_AREAS,type DesignerOrderArea} from './digital-workspace-navigation.js';
import {ProductionReadinessPanel} from './production-readiness-panel.js';
import {todoRouteHref} from './todo-route-link.js';
import {originalDocumentHref,type OriginalDocumentRef} from './original-document-directory.js';
import {navigateInternalPage} from './internal-navigation.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {OrderRushBadge} from './order-rush-badge.js';

type VisibleArea=Exclude<DesignerOrderArea,'development'>|'quotation'|'shipping';
const labels:Record<VisibleArea,string>={document:'开发单资料',handover:'交资料',customer:'客户评语',quotation:'对客户报价表',shipping:'样衣寄出',records:'订单单据',history:'操作记录'};
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

export function DesignerHandlingItems({handling,hrefFor,limit=Infinity,showReturnDetails=false}:{handling:DevelopmentWorkspaceHandling;hrefFor:(href:string)=>string;limit?:number;showReturnDetails?:boolean}){
 const [expanded,setExpanded]=useState(false);
 const shown=expanded?handling.items:handling.items.slice(0,limit);
 const labels={mine:'轮到我',waiting:'等别人',returned:'退回要改'};
 return <div className="designer-current-actions">
  {shown.length?<ul>{shown.map(action=>{
   const target=new URL(todoRouteHref(action.route),'https://workbench.invalid');
   if(action.kind==='waiting')target.searchParams.set('taskView','read');
   const href=hrefFor(target.pathname+target.search);
   const description=<>{labels[action.kind]} · {action.label}{action.ownerName?`（${action.ownerName}）`:''}</>;
   return <li key={action.id}>{href?<Link type="inherit" href={href}>{description}{showReturnDetails&&action.kind==='returned'&&<> · 查看退回详情</>}</Link>:description}{action.reason&&<small>{action.reason}</small>}</li>;
  })}</ul>:<span>{handling.complete?'当前没有需要你办理的事项':'暂无已核实的当前任务'}</span>}
  {handling.items.length>limit&&<Button label={expanded?'收起办理事项':`展开其余 ${handling.items.length-limit} 项`} size="sm"
   aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}/>}
  {!handling.complete&&<small>部分事项尚未核对</small>}
 </div>;
}

export function DesignerOrderWorkbench({sourceId,round,actorId,item,sheet,image,document,confirmation,onClose,onChanged}:{sourceId:string;round?:number|undefined;actorId?:string|undefined;item?:DevelopmentWorkspaceItem|undefined;sheet?:DevelopmentSheet|undefined;image?:ReactNode;document:ReactNode;confirmation:ReactNode;onClose:()=>void;onChanged:()=>void}){
 const [focus,setFocus]=useState<VisibleArea|null>(()=>{
  const area=new URLSearchParams(window.location.search).get('area');
  const prior=DESIGNER_ORDER_AREAS.find(key=>key===area);
  return prior==='development'?'document':prior??null;
 });
 const [openAreas,setOpenAreas]=useState<Set<VisibleArea>>(()=>new Set<VisibleArea>(focus?['document',focus]:['document']));
 const setAreaOpen=(area:VisibleArea,open:boolean)=>setOpenAreas(current=>{
  if(current.has(area)===open)return current;
  const next=new Set(current);if(open)next.add(area);else next.delete(area);return next;
 });
 const [commentIntent,setCommentIntent]=useState<RevisionCommentIntent|null>(null);
 const [recordRefresh,setRecordRefresh]=useState(0);
 const [records,setRecords]=useState<OrderJourney|null>(null),[recordError,setRecordError]=useState<Error|null>(null);
 const [originalVersionsReady,setOriginalVersionsReady]=useState(false);
 const [handoverReady,setHandoverReady]=useState(false);
 const [handoverProgress,setHandoverProgress]=useState<'complete'|'pending'|'unknown'|'failed'>('unknown');
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
 },[sourceId,round,recordRefresh,sheet?.sourceId,sheet?.version]);
 useEffect(()=>{
  if(!focus)return;
  if(!sheet||focus==='history'&&!records&&!recordError||focus==='records'&&!recordError&&(!records||!originalVersionsReady))return;
  const summary=window.document.getElementById(labelsId(focus));
  if(!summary)return;
  if(!openAreas.has(focus)){setAreaOpen(focus,true);return;}
  const saved=window.history.state?.dxInternalRestoreScroll;
  if(saved?.path===window.location.pathname+window.location.search){setFocus(null);return;}
  const frame=requestAnimationFrame(()=>{
   const heading=window.document.getElementById(labelsId(focus));
   heading?.scrollIntoView({block:'start'});heading?.focus({preventScroll:true});setFocus(null);
  });
  return()=>cancelAnimationFrame(frame);
 },[focus,sheet,records,recordError,originalVersionsReady,openAreas]);
 // Restore after the actual directory rows have rendered, rather than against
 // its shorter loading state and then letting browser scroll anchoring move it.
 const returningToRecords=new URLSearchParams(window.location.search).get('area')==='records';
 useInternalReturnScroll(Boolean(sheet)&&(!current||handoverReady)&&Boolean(records||recordError)&&(!returningToRecords||Boolean(recordError)||originalVersionsReady));

 const sourceQuery=(area:DesignerOrderArea)=>{
  const target=new URL(window.location.href);target.searchParams.set('area',area);return target.pathname+target.search;
 };
 const region=(area:VisibleArea,content:ReactNode,status?:{label:string;tone?:string})=><details key={area} open={openAreas.has(area)}
  className="dx-production-panel designer-order-area" role="region" aria-labelledby={`${labelsId(area)}-heading`}>
  <summary id={labelsId(area)} onClick={event=>{event.preventDefault();setAreaOpen(area,!openAreas.has(area));}}>
   <h2 id={`${labelsId(area)}-heading`}>{labels[area]}</h2>
   <span className="designer-order-area-status" data-tone={status?.tone}>
    {status?.label??(area==='document'&&sheet?`第 ${sheet.roundNumber??1} 轮 · v${sheet.version}`:area==='quotation'?'待核对':null)}
   </span>
  </summary>
  <div className="designer-order-area-content">{content}</div>
 </details>;

 const journey=item?.journey;
 const exactRecords=records?.sourceId===sourceId&&(!round||records.selectedRound===round)?records:null;
 const orderDate=exactRecords?.cockpitCreationDetails?.find(entry=>entry.subject==='order')?.at;
 const basicFields=sheet?.workbenchBasics??sheet?.document?.workbenchSheet;
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
    <h2>{sheet?.document?.workbenchSheet?.styleName?.trim()||'款式（品名）未登记'} <OrderRushBadge value={sheet?sheet.orderRush:item?.orderRush}/></h2>
    <p>款号 {journey?.designStyleNo??sheet?.designStyleNo??'待核对'}{sheet?.temporaryStyleNo?` · 代用款号 ${sheet.temporaryStyleNo}`:''}</p>
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
  {current&&item?.handling?.items.length?<section className="dx-production-panel designer-order-current" aria-label="当前待办理">
   <h2>当前待办理</h2><DesignerHandlingItems handling={item.handling} showReturnDetails hrefFor={href=>digitalChildDetailHref(href,sourceQuery('document'),urls.base)}/>
  </section>:null}
  {region('document',document)}
  {region('handover',current?<><DevelopmentSampleHandoverPanel sourceId={sourceId} round={sheet.roundNumber??1} documentVersion={sheet.version}
    refreshRevision={recordRefresh} onReady={setHandoverReady} onProgress={setHandoverProgress}/>
    <ProductionReadinessPanel resource={{kind:'source',id:sourceId}} sourceDocumentVersion={sheet.version} designHandoverOnly embeddedDesignHandover
     handoverSubmitLabel="保存原交接记录" onChanged={changed}/>
   </>:<p>请从当前有效资料查看原交接方式。</p>,{label:({complete:'完成',pending:'未完成',unknown:'待核对',failed:'读取失败'})[handoverProgress],tone:handoverProgress==='complete'?'success':handoverProgress==='pending'?'warning':'neutral'})}
  {current?<CurrentDevelopmentAreas key={`${sourceId}:${sheet.roundNumber??1}`} sourceId={sourceId} actorId={actorId} revision={sheet.materialEvents.length} changed={changed}
    region={region} sheet={sheet} confirmation={confirmation}/>
   :<>{region('customer',sheet?.preorderPublication&&confirmation?confirmation:sheet?.status==='published'?
     <><p>历史轮次只读。办理客户评语请切换到当前已发布轮次。</p>
      <DevelopmentFeedbackHistory key={`${sourceId}:${sheet.roundNumber??1}`} sourceId={sourceId} roundNumber={sheet.roundNumber??1}/></>:
     <p>请切换到当前已发布轮次办理客户评语。</p>)}
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

function CurrentDevelopmentAreas({sourceId,actorId,revision,changed,region,sheet,confirmation}:{
 sourceId:string;actorId:string|undefined;revision:number;changed:()=>void;region:(area:VisibleArea,content:ReactNode,status?:{label:string;tone?:string})=>ReactNode;
 sheet:DevelopmentSheet;confirmation:ReactNode;
}){
 const controller=useDevelopmentExecution({sourceId,materialRevision:revision,onChanged:changed});
 const state=controller.state;
 const round=sheet.roundNumber??1;
 const [quoteHeadline,setQuoteHeadline]=useState<QuotationWorkbenchHeadline|null>(null);
 const selectedQuoteHeadline=quoteHeadline?.resource.kind==='source'&&quoteHeadline.resource.id===sourceId&&
  (quoteHeadline.roundNumber===null||quoteHeadline.roundNumber===round)?quoteHeadline.state:'unverified';
 const currentExecution=state?.sheet.sourceId===sourceId&&state.sheet.roundNumber===sheet.roundNumber?state:null;
 const shippingTasks=currentExecution?.tasks.filter(task=>task.sourceId===sourceId&&task.routeVersion===round&&task.taskKind==='development_shipping')??[];
 const shipping=shippingTasks.filter(task=>task.state!=='cancelled').at(-1);
 const shippedTasks=new Set(shippingTasks.filter(task=>task.state==='completed').map(task=>task.taskId));
 const shippingFacts=currentExecution?.routeFacts.filter(item=>item.taskId&&shippedTasks.has(item.taskId)&&item.routeVersion===round&&item.kind==='寄出'
  &&item.payload.sentDate&&item.payload.trackingNo)??[];
 const shippingState=currentExecution?.shippingDisplay?.state??'unknown';
 const canShip=shippingState==='ready'&&Boolean(shipping&&designerCanExecute(shipping,actorId));
 const shippingStatus=controller.readError?{label:'读取失败'}:{label:developmentShippingLabel[shippingState],tone:developmentShippingTone(shippingState)};
 const technical=state?.technical,finalComment=technical?.comments.find(item=>item.isFinal);
 const customerStatus=controller.readError?{label:'读取失败'}:!technical?.enrolled?{label:'待核对'}:
  !finalComment?{label:'待最终批复'}:finalComment.decision==='changes_required'?{label:'客户要求修改',tone:'danger'}:
  technical.effective?.state==='effective'?{label:'已认可 · 已复核',tone:'success'}:technical.effective?.state==='pending_review'?
   {label:'已认可 · 待尺寸复核',tone:'warning'}:{label:'最终批复已登记 · 技术依据待核'};
 return <>{region('customer',<>{confirmation}
   {controller.readError?<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} retryLabel="重试读取客户意见"/>:null}
   {state?.sheet.sourceId===sourceId?<DevelopmentCustomerConfirmation controller={controller} direct/>
    :!controller.readError?<p role="status">正在核对办理资格…</p>:null}
   {controller.writeError&&<p role="alert">{controller.writeError}</p>}</>,customerStatus)}
  {region('quotation',<DigitalQuotationPanel resource={{kind:'source',id:sourceId}} designerWorkbench={{actorId,roundNumber:round,onHeadline:setQuoteHeadline}} onChanged={changed}/>,DESIGNER_QUOTATION_STATUS_DISPLAY[selectedQuoteHeadline])}
  {region('shipping',controller.readError?
    <DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} retryLabel="重试读取寄样任务"/>:
    <>{shippingState!=='sent'&&(shipping&&canShip?<DesignerShippingForm key={shipping.taskId} taskId={shipping.taskId} controller={controller}/>:
    <p>{shippingState==='ready'?'已安排本轮寄样，当前仅可查看。':shippingState==='wait_design'?'待本轮最终设计确认完成后，再按原路线办理寄样。':
      shippingState==='wait_tail'?'待本轮尾查完成后继续。':shippingState==='not_applicable'?'按本轮原制作路线不适用寄样。':
      shippingState==='unassigned'?'寄样任务待原有权岗位分派。':shippingState==='paused'?'本轮寄样已暂停。':
      shippingState==='cancelled'?'本轮寄样已取消。':'尚未核到本轮可用的寄样记录，请沿原任务核对。'}
      {shippingState==='ready'&&shipping?.assigneeName&&<> 负责人 · {shipping.assigneeName}</>}</p>)}
    {shippingFacts.map(fact=><dl key={fact.factId} className="development-basic-grid"><div><dt>适用轮次</dt><dd>第 {round} 轮</dd></div>
      <div><dt>实际寄出日期</dt><dd>{fact.payload.sentDate}</dd></div><div><dt>快递号</dt><dd>{fact.payload.trackingNo}</dd></div>
      <div><dt>登记人</dt><dd>{fact.shippingActor||'未登记'}</dd></div></dl>)}</>,shippingStatus)}
 </>;
}

function DesignerShippingForm({taskId,controller}:{taskId:string;controller:ReturnType<typeof useDevelopmentExecution>}){
 const [date,setDate]=useState(''),[tracking,setTracking]=useState(''),[note,setNote]=useState('');
 const {busy,uncertainWrite,committedWrite,writeError}=controller;
 useDigitalDetailNavigationGuard(Boolean(date||tracking||note)||uncertainWrite,busy,controller.writing,
  '本轮寄样内容尚未保存或确认，确定离开吗？');
 const submit=()=>controller.run('route',{taskId,result:'通过',sentDate:date,trackingNo:tracking.trim(),note,
  nextAssigneeId:null,craftExecution:null});
 const disabled=busy||uncertainWrite;
 return <form onSubmit={event=>{event.preventDefault();if(!busy&&date&&tracking.trim())void submit();}}>
  <div className="development-basic-grid"><DevelopmentEntryDate label="实际寄出日期" visibleLabel isRequired value={date}
    isDisabled={disabled} onChange={value=>setDate(value??'')}/>
   <DevelopmentEntryText label="快递号" visibleLabel isRequired value={tracking} maxLength={100} isDisabled={disabled} onChange={setTracking}/>
   <DevelopmentEntryText label="备注" visibleLabel value={note} maxLength={2000} isDisabled={disabled} onChange={setNote}/>
  </div>
  {writeError&&<p role="alert">{writeError}</p>}
  {uncertainWrite&&committedWrite?<DevelopmentEntryAction type="button" disabled={busy} onClick={()=>void controller.recheck()}>重新读取已保存寄样</DevelopmentEntryAction>:
   <DevelopmentEntryAction type="submit" variant="primary" disabled={busy||!date||!tracking.trim()}>{uncertainWrite?'用原内容核对寄样结果':'记录寄出'}</DevelopmentEntryAction>}
 </form>;
}
