import {Link} from '@astryxdesign/core/Link';
import {useEffect,useState,type ReactNode} from 'react';
import {Button} from '@dx-rework/ui';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import type {DevelopmentWorkspaceHandling,DevelopmentWorkspaceItem} from '@dx-rework/contracts/digital-development-workspace';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {createWebUrls} from '../url-contract.js';
import {CockpitOperationLog} from './cockpit-operation-log.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {DevelopmentCustomerConfirmation,DevelopmentExecutionBody,useDevelopmentExecution} from './digital-development-execution-panel.js';
import {journeyDocumentGroups} from './digital-journey-cockpit-model.js';
import {digitalRequest} from './digital-production-api.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {DigitalQuotationPanel} from './digital-quotation-panel.js';
import {DESIGNER_ORDER_AREAS,type DesignerOrderArea} from './digital-workspace-navigation.js';
import {ProductionReadinessPanel} from './production-readiness-panel.js';
import {todoRouteHref} from './todo-route-link.js';
import {OriginalDocumentDirectory,originalDocumentHref,type OriginalDocumentRef} from './original-document-directory.js';
import {navigateInternalPage} from './internal-navigation.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';

const labels:Record<DesignerOrderArea,string>={document:'版单资料',development:'开发办理',customer:'客户与报价',handover:'交接与协同',records:'订单相关单据',history:'操作记录'};
const labelsId=(area:DesignerOrderArea)=>`designer-order-${area}`;
const urls=createWebUrls(import.meta.env.BASE_URL);

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
  {handling.items.length>limit&&<Button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起办理事项':`展开其余 ${handling.items.length-limit} 项`}</Button>}
  {!handling.complete&&<small>部分事项尚未核对</small>}
 </div>;
}

export function DesignerOrderWorkbench({sourceId,round,item,sheet,image,document,confirmation,onClose,onChanged}:{sourceId:string;round?:number|undefined;item?:DevelopmentWorkspaceItem|undefined;sheet?:DevelopmentSheet|undefined;image?:ReactNode;document:ReactNode;confirmation:ReactNode;onClose:()=>void;onChanged:()=>void}){
 const [opened,setOpened]=useState(()=>{
  const area=new URLSearchParams(window.location.search).get('area');
  return DESIGNER_ORDER_AREAS.filter(key=>key==='document'||key===area);
 });
 const [focus,setFocus]=useState<DesignerOrderArea|null>(()=>opened[1]??null);
 const [recordRefresh,setRecordRefresh]=useState(0);
 const [records,setRecords]=useState<OrderJourney|null>(null),[recordError,setRecordError]=useState<Error|null>(null);
 const [originalVersionsReady,setOriginalVersionsReady]=useState(false);
 const recordOpened=opened.includes('records')||opened.includes('history');
 const reloadRecords=()=>setRecordRefresh(value=>value+1);
 const changed=()=>{reloadRecords();onChanged();};
 useEffect(()=>{
  if(!recordOpened||sheet?.sourceId!==sourceId)return;
  const controller=new AbortController();setRecordError(null);
  void digitalRequest<OrderJourney>(`journeys/${sourceId}${round?`?round=${round}`:''}`,'GET',undefined,undefined,{signal:controller.signal})
   .then(value=>{if(!controller.signal.aborted)setRecords(value);})
   .catch(reason=>{if(!controller.signal.aborted){setRecords(null);setRecordError(reason);}});
  return()=>controller.abort();
 },[sourceId,round,recordOpened,recordRefresh,sheet?.sourceId]);
 useEffect(()=>{
  if(!focus)return;
  if(!sheet||recordOpened&&!records||opened.includes('records')&&!originalVersionsReady)return;
  const saved=window.history.state?.dxInternalRestoreScroll;
  if(saved?.path===window.location.pathname+window.location.search){setFocus(null);return;}
  const frame=requestAnimationFrame(()=>{
   const heading=window.document.getElementById(labelsId(focus));
   heading?.scrollIntoView({block:'start'});heading?.focus({preventScroll:true});setFocus(null);
  });
  return()=>cancelAnimationFrame(frame);
 },[focus,sheet,recordOpened,records,opened,originalVersionsReady]);
 // Restore after the actual directory rows have rendered, rather than against
 // its shorter loading state and then letting browser scroll anchoring move it.
 useInternalReturnScroll(Boolean(sheet)&&(!recordOpened||Boolean(records))&&(!opened.includes('records')||originalVersionsReady));

 const sourceQuery=(area:DesignerOrderArea)=>{
  const target=new URL(window.location.href);target.searchParams.set('area',area);return target.pathname+target.search;
 };
 const open=(area:DesignerOrderArea,jump=false)=>{
  setOpened(current=>current.includes(area)?current:[...current,area]);
  window.history.replaceState(window.history.state,'',sourceQuery(area));
  if(jump)setFocus(area);
 };
 const region=(area:DesignerOrderArea,content:ReactNode)=><section key={area} className="dx-production-panel designer-order-area" aria-labelledby={labelsId(area)}>
  <h2 tabIndex={-1} id={labelsId(area)}>{labels[area]}</h2>
  {opened.includes(area)?content:<Button type="button" onClick={()=>open(area,true)}>查看{labels[area]}</Button>}
 </section>;

 const journey=item?.journey;
 const current=sheet?.status==='published'&&(sheet.roundNumber??1)===(sheet.latestRoundNumber??1);
 const exactRecords=records?.selectedRound===round||!round?records:null;
 const actions=opened.includes('development')||opened.includes('customer');
 const readResult=(render:(value:OrderJourney)=>ReactNode)=>recordError
  ?<DigitalReadFailure error={recordError} onRetry={reloadRecords} retryLabel="重试读取原记录"/>
  :exactRecords?render(exactRecords):<p role="status">正在读取本单授权记录…</p>;

 return <div className="designer-order-workbench">
  <header className="dx-production-panel designer-order-identity">
   <Button onClick={onClose}>返回来源</Button>
   <h1>本单资料</h1>
   <div className="designer-order-summary">{image}<div>
    <h2>{journey?.designStyleNo??sheet?.designStyleNo??'正在读取订单'}</h2>
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
   {journey?.orderId&&journey.lines.length>0&&<div className="development-table-scroll" role="region" aria-label="逐 PO 数量与交期" tabIndex={0}><table>
    <thead><tr><th>PO</th><th>颜色</th><th>数量</th><th>客户交期</th></tr></thead>
    <tbody>{journey.lines.map(line=><tr key={line.id}><td>{line.po??'未登记'}</td><td>{line.color}</td><td>{line.orderedQuantity.toLocaleString()}</td><td>{journey.poDeliveryDates?.find(date=>date.lineId===line.id)?.customerWarehouseArrivalDate??'未登记'}</td></tr>)}</tbody>
   </table></div>}
  </header>
  {item?.handling&&<section className="dx-production-panel designer-order-area" aria-label="当前办理">
   <h2>当前办理</h2><DesignerHandlingItems handling={item.handling} hrefFor={route=>digitalChildDetailHref(route,sourceQuery('development'),urls.base)}/>
  </section>}
  <nav className="designer-order-sections" aria-label="本单区域">
   {DESIGNER_ORDER_AREAS.map(area=><Link key={area} type="inherit" href={`#${labelsId(area)}`} onClick={event=>{
    if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    event.preventDefault();open(area,true);
   }}>{labels[area]}</Link>)}
  </nav>
  {region('document',document)}
  {current&&actions?<CurrentDevelopmentAreas sourceId={sourceId} revision={sheet?.materialEvents.length??0} changed={changed} development={content=>region('development',content)} customer={content=>region('customer',content)} customerOpen={opened.includes('customer')} confirmation={confirmation}/>
   :<>{region('development',<p>当前轮次请从版单资料查看原办理记录。</p>)}{region('customer',<p>请切换到当前已发布轮次办理客户意见或报价。</p>)}</>}
  {region('handover',current&&sheet?<ProductionReadinessPanel resource={{kind:'source',id:sourceId}} sourceDocumentVersion={sheet.version} focusKind="design_handover" onChanged={changed}/>:<p>请从当前有效资料查看原交接方式。</p>)}
  {region('records',readResult(journey=>{
   const entries=journeyDocumentGroups(journey).flatMap(group=>group.entries).filter(entry=>entry.record.url&&entry.record.mode==='read'&&!['task','development','budget','instruction','quotation'].includes(entry.record.domain));
   const openOriginal=(ref:OriginalDocumentRef)=>{
    const href=originalDocumentHref(ref,sourceQuery('records'),urls.base);if(href)void navigateInternalPage(href);
   };
   return <><OriginalDocumentDirectory resource={{kind:'source',id:sourceId}} onSelect={openOriginal} onReady={setOriginalVersionsReady} rememberInUrl/>{entries.length?<ul>{entries.map(entry=>{
    const link=digitalChildDetailHref(entry.record.url!,sourceQuery('records'),urls.base);
    return link?<li key={entry.key}><Link type="inherit" href={link}>{entry.label}</Link></li>:null;
   })}</ul>:<p>当前范围没有其它可查看的关联单据。</p>}</>;
  }))}
  {region('history',readResult(journey=><CockpitOperationLog order={journey} embedded/>))}
 </div>;
}

function CurrentDevelopmentAreas({sourceId,revision,changed,development,customer,customerOpen,confirmation}:{sourceId:string;revision:number;changed:()=>void;development:(content:ReactNode)=>ReactNode;customer:(content:ReactNode)=>ReactNode;customerOpen:boolean;confirmation:ReactNode}){
 const controller=useDevelopmentExecution({sourceId,materialRevision:revision,onChanged:changed});
 const state=controller.state;
 const canComment=state?.technical?.enrolled?state.technical.canRecordComment:state?.sheet.canEdit&&state.routeFacts.some(fact=>fact.kind==='最终设计确认'&&!state.routeFacts.some(item=>item.kind==='客户样板确认'&&item.routeVersion===fact.routeVersion));
 return <>{development(<DevelopmentExecutionBody sourceId={sourceId} controller={controller} separateCustomer/>)}
  {customer(<>{confirmation}{customerOpen&&<>
   {controller.readError?<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} retryLabel="重试读取客户意见"/>
    :canComment?<details><summary>录客户意见</summary><DevelopmentCustomerConfirmation controller={controller}/>{controller.writeError&&<p role="alert">{controller.writeError}</p>}</details>
    :!state?<p role="status">正在核对办理资格…</p>:null}
   <QuotationSection sourceId={sourceId} onChanged={changed}/></>}</>)}
 </>;
}

function QuotationSection({sourceId,onChanged}:{sourceId:string;onChanged:()=>void}){
 const [opened,setOpened]=useState(false);
 return <details onToggle={event=>{if(event.currentTarget.open)setOpened(true);}}><summary>客户报价协作</summary>
  {opened&&<DigitalQuotationPanel resource={{kind:'source',id:sourceId}} onChanged={onChanged}/>}
 </details>;
}
