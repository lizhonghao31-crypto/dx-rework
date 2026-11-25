import {Link} from '@astryxdesign/core/Link';
import {useEffect,useState,type ReactNode} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Table} from '@astryxdesign/core/Table';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {DESIGNER_WORKBENCH_TASK_KINDS,type DevelopmentWorkspaceHandling,type DevelopmentWorkspaceItem} from '@dx-rework/contracts/digital-development-workspace';
import type {JourneyNode,JourneyRecord,JourneyStageKey,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {createWebUrls} from '../url-contract.js';
import {CockpitOperationLog} from './cockpit-operation-log.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {DevelopmentCustomerConfirmation,useDevelopmentExecution} from './digital-development-execution-panel.js';
import {DevelopmentSampleHandoverPanel} from './development-sample-handover.js';
import {journeyRecordIdentity,journeyStateLabels} from './digital-journey-cockpit-model.js';
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
import {digitalTaskDisplayStatus} from './digital-workspace-copy.js';
import {OrderRushBadge} from './order-rush-badge.js';

const labels:Record<DesignerOrderArea,string>={document:'版单资料',development:'开发进度',customer:'客户与报价',handover:'交接与寄样',records:'订单单据',history:'操作记录'};
const labelsId=(area:DesignerOrderArea)=>`designer-order-${area}`;
const urls=createWebUrls(import.meta.env.BASE_URL);
function designerCanExecute(task:DigitalTask,actorId:string|undefined){
 return Boolean(actorId&&task.assigneeId===actorId&&task.requiredRole==='sample_designer'&&
  DESIGNER_WORKBENCH_TASK_KINDS.has(task.taskKind)&&task.canExecute&&task.state==='ready'&&!task.paused);
}

function displayMoment(value:string|null|undefined,precision?:'instant'|'date'|'missing'|'unavailable'){
 if(!value||precision==='missing'||precision==='unavailable')return '待核';
 if(precision==='date')return value;
 const date=new Date(value);
 return Number.isNaN(date.getTime())?'待核':date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
}
function currentDevelopmentNodes(journey:OrderJourney|null,round:number){
 const development=journey?.stages.find(stage=>stage.key==='development');
 return (development?.nodes??[]).filter(node=>!node.planningOnly&&node.round===round&&node.unavailableReason!=='permission');
}
function taskMatches(node:JourneyNode,task:DigitalTask){
 return node.instanceId===task.taskId||node.records.some(record=>record.domain==='task'&&record.id===task.taskId);
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

export function DesignerOrderWorkbench({sourceId,round,actorId,item,sheet,image,document,confirmation,onClose,onChanged}:{sourceId:string;round?:number|undefined;actorId?:string|undefined;item?:DevelopmentWorkspaceItem|undefined;sheet?:DevelopmentSheet|undefined;image?:ReactNode;document:ReactNode;confirmation:ReactNode;onClose:()=>void;onChanged:()=>void}){
 const [focus,setFocus]=useState<DesignerOrderArea|null>(()=>{
  const area=new URLSearchParams(window.location.search).get('area');
  return DESIGNER_ORDER_AREAS.find(key=>key===area)??null;
 });
 const [recordRefresh,setRecordRefresh]=useState(0);
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
 const open=(area:DesignerOrderArea)=>{
  window.history.replaceState(window.history.state,'',sourceQuery(area));
  setFocus(area);
 };
 const region=(area:DesignerOrderArea,content:ReactNode)=><section key={area} className="dx-production-panel designer-order-area" aria-labelledby={labelsId(area)}>
  <h2 tabIndex={-1} id={labelsId(area)}>{labels[area]}</h2>
  {content}
 </section>;

 const journey=item?.journey;
 const exactRecords=records?.sourceId===sourceId&&(!round||records.selectedRound===round)?records:null;
 const readResult=(render:(value:OrderJourney)=>ReactNode)=>recordError
  ?<DigitalReadFailure error={recordError} onRetry={reloadRecords} retryLabel="重试读取原记录"/>
  :exactRecords?render(exactRecords):<p role="status">正在读取本单授权记录…</p>;

 return <div className="designer-order-workbench">
  <header className="dx-production-panel designer-order-identity">
   <Button label="返回来源" size="sm" onClick={onClose}/>
   <h1>本单资料</h1>
   <div className="designer-order-summary">{image}<div>
    <h2>{journey?.designStyleNo??sheet?.designStyleNo??'正在读取订单'} <OrderRushBadge value={sheet?sheet.orderRush:item?.orderRush}/></h2>
    <dl><div><dt>款名</dt><dd>{journey?.styleName??'—'}</dd></div><div><dt>客户</dt><dd>{journey?.customer??sheet?.customerCode??'—'}</dd></div>
     <div><dt>设计师</dt><dd>{journey?.designer??sheet?.designerName??'—'}</dd></div>
     <div><dt>跟单</dt><dd>{journey?.merchandisers.map(person=>person.name??'姓名未登记').join('、')||'—'}</dd></div>
     <div><dt>开发类型</dt><dd>{sheet?.developmentType??journey?.developmentType??'—'}</dd></div>
     <div><dt>服装模板</dt><dd>{sheet?.document?.template??'—'}</dd></div>
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
  {current&&<section className="dx-production-panel designer-order-area" aria-label="交资料">
   <h2>交资料</h2><DevelopmentSampleHandoverPanel sourceId={sourceId} round={sheet.roundNumber??1} documentVersion={sheet.version}
    refreshRevision={recordRefresh} onReady={setHandoverReady}/>
  </section>}
  {item?.handling&&<section className="dx-production-panel designer-order-area" aria-label="当前办理">
   <h2>当前办理</h2><DesignerHandlingItems handling={item.handling} hrefFor={route=>digitalChildDetailHref(route,sourceQuery('development'),urls.base)}/>
  </section>}
  <nav className="designer-order-sections" aria-label="本单区域">
   {DESIGNER_ORDER_AREAS.map(area=><Link key={area} type="inherit" href={`#${labelsId(area)}`} onClick={event=>{
    if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    event.preventDefault();open(area);
   }}>{labels[area]}</Link>)}
  </nav>
  {region('document',document)}
  {current?<CurrentDevelopmentAreas sourceId={sourceId} actorId={actorId} revision={sheet?.materialEvents.length??0} changed={changed}
    development={content=>region('development',content)} customer={content=>region('customer',content)}
    handover={content=>region('handover',content)} sheet={sheet} journey={exactRecords}
    timelineError={recordError} retryTimeline={reloadRecords} returnTo={sourceQuery('development')}
    returnToHandover={sourceQuery('handover')} confirmation={confirmation}/>
   :<>{region('development',<p>当前轮次请从版单资料查看原办理记录。</p>)}{region('customer',sheet?.preorderPublication&&confirmation?confirmation:<p>请切换到当前已发布轮次办理客户意见或报价。</p>)}
     {region('handover',<p>请从当前有效资料查看原交接方式。</p>)}</>}
  {region('records',readResult(journey=>{
   const openOriginal=(ref:OriginalDocumentRef)=>{
    const href=originalDocumentHref(ref,sourceQuery('records'),urls.base);if(href)void navigateInternalPage(href);
   };
   return <DesignerRelatedOriginals key={`${sourceId}:${round??'current'}`} order={journey} materials={sheet?.document?.materials??[]}
    returnTo={sourceQuery('records')} onOriginal={openOriginal} onReady={setOriginalVersionsReady}
    relatedOriginals={(stage,returnTo)=><RelatedWorkbenchDocuments journey={journey} stage={stage} returnTo={returnTo}/>}/>;
  }))}
  {region('history',readResult(journey=><CockpitOperationLog order={journey} embedded/>))}
 </div>;
}

function DevelopmentProgress({tasks,journey,round,actorId,returnTo}:{tasks:DigitalTask[];journey:OrderJourney|null;round:number;actorId:string|undefined;returnTo:string}){
 const nodes=currentDevelopmentNodes(journey,round);
 const taskLink=(task:DigitalTask,handle:boolean)=>digitalChildDetailHref(
  '/ui/digital-production?'+new URLSearchParams({task:task.taskId,taskView:handle?'handle':'read'}),returnTo,urls.base);
 const unmatched=nodes.filter(node=>!tasks.some(task=>taskMatches(node,task)));
 if(!tasks.length&&!nodes.length)return <p>本轮暂无已核实的流程节点。</p>;
 return <ul className="designer-current-actions" aria-label="本轮开发节点">
  {tasks.map(task=>{
   const matched=nodes.filter(node=>taskMatches(node,task)),node=matched.length===1?matched[0]:undefined;
   const own=designerCanExecute(task,actorId)&&task.taskKind!=='development_shipping';
   const actual=task.actualCompletion;
   const actualTime=actual?(actual.precision==='unknown'?'待核':displayMoment(actual.date??actual.at,actual.precision))
     :node?displayMoment(node.actualDate??node.actualAt,node.actualDate?'date':undefined):'待核';
   return <li key={task.taskId}><details><summary>{task.label} · {digitalTaskDisplayStatus(task)} · {task.assigneeName??'待核'}</summary>
    <p>预计 {displayMoment(node?.expectedAt,node?.expectedPrecision)} · 实际 {actualTime}{(actual?.quality??node?.actualQuality)==='unverified'?'（未核实）':''}</p>
    {(task.blockedReason||node?.blockers[0]?.label)&&<p>{task.blockedReason||node?.blockers[0]?.label}</p>}
    <Link type="inherit" href={taskLink(task,false)}>查看原任务</Link>
    {own&&<> · <Link type="inherit" href={taskLink(task,true)}>打开本人的办理</Link></>}
   </details></li>;
  })}
  {unmatched.map(node=><li key={node.instanceId}><details><summary>{node.label} · {journeyStateLabels[node.state]} · {node.owner?.name??'待核'}</summary>
   <p>预计 {displayMoment(node.expectedAt,node.expectedPrecision)} · 实际 {displayMoment(node.actualDate??node.actualAt,node.actualDate?'date':undefined)}</p>
   {node.blockers[0]&&<p>{node.blockers[0].label}</p>}
   {node.records.flatMap(record=>{
    const href=originalRecordHref(record,returnTo);
    return href?[<Link key={`${record.domain}:${record.id}:${record.version}`} type="inherit" href={href}>查看原记录</Link>]:[];
   })}
  </details></li>)}
 </ul>;
}

function CurrentDevelopmentAreas({sourceId,actorId,revision,changed,development,customer,handover,sheet,journey,timelineError,retryTimeline,returnTo,returnToHandover,confirmation}:{
 sourceId:string;actorId:string|undefined;revision:number;changed:()=>void;development:(content:ReactNode)=>ReactNode;customer:(content:ReactNode)=>ReactNode;
 handover:(content:ReactNode)=>ReactNode;sheet:DevelopmentSheet;journey:OrderJourney|null;timelineError:Error|null;retryTimeline:()=>void;
 returnTo:string;returnToHandover:string;confirmation:ReactNode;
}){
 const controller=useDevelopmentExecution({sourceId,materialRevision:revision,onChanged:changed});
 const state=controller.state;
 const round=sheet.roundNumber??1;
 const tasks=state?.sheet.sourceId===sourceId&&state.sheet.roundNumber===sheet.roundNumber
  ?state.tasks.filter(task=>task.sourceId===sourceId&&task.routeVersion===round):[];
 const shipping=tasks.find(task=>task.taskKind==='development_shipping'&&designerCanExecute(task,actorId));
 const shippingHref=shipping?digitalChildDetailHref('/ui/digital-production?'+new URLSearchParams({task:shipping.taskId,taskView:'handle'}),returnToHandover,urls.base):'';
 return <>{development(<>
   {controller.readError?<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} retryLabel="重试读取原任务"/>:
    !state?<p role="status">正在读取本轮任务…</p>:<DevelopmentProgress tasks={tasks} journey={journey} round={round} actorId={actorId} returnTo={returnTo}/>}
   {timelineError&&<DigitalReadFailure error={timelineError} onRetry={retryTimeline} retryLabel="重试读取节点日期"/>}
  </>)}
  {customer(<>{confirmation}
   {controller.readError?<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} retryLabel="重试读取客户意见"/>
    :state?<DevelopmentCustomerConfirmation controller={controller} direct/>
    :<p role="status">正在核对办理资格…</p>}
   {controller.writeError&&<p role="alert">{controller.writeError}</p>}
   <DigitalQuotationPanel resource={{kind:'source',id:sourceId}} designerWorkbench={{actorId}} onChanged={changed}/></>)}
  {handover(<>
   <ProductionReadinessPanel resource={{kind:'source',id:sourceId}} sourceDocumentVersion={sheet.version} designHandoverOnly onChanged={changed}/>
   <section aria-label="寄样"><h3>寄样</h3>
    {shippingHref?<Link type="inherit" href={shippingHref}>打开原寄样任务</Link>:controller.readError
     ?<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} retryLabel="重试读取寄样任务"/>
     :state?<p>本轮没有当前可由本人办理的寄样任务。</p>:<p role="status">正在核对本轮寄样任务…</p>}
   </section>
  </>)}
 </>;
}
