import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog,DialogHeader} from '@astryxdesign/core/Dialog';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Table} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {MerchandiserOrderResponseSchema,MerchandiserWorkActionFilterSchema,MerchandiserWorkKindSchema,MerchandiserWorkResponseSchema,type MerchandiserOrderResponse,type MerchandiserWorkResponse} from '@dx-rework/contracts';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import {todoDestination} from '@dx-rework/contracts/todo-destination';
import {createWebUrls} from '../url-contract.js';
import {designerAstryxCss} from './designer-astryx.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {useForegroundWait} from './foreground-loading.js';
import {ListPagination} from './list-pagination.js';
import {MerchandiserContractReturn} from './merchandiser-contract-return.js';
import {OrderRushBadge} from './order-rush-badge.js';
import {OriginalDocumentDirectory,originalDocumentHref} from './original-document-directory.js';
import {navigateInternalPage} from './internal-navigation.js';
import {ProductionReadinessPanel} from './production-readiness-panel.js';
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {DocumentGuardContext} from './use-digital-detail-navigation-guard.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {merchandiserWorkbenchPath,readMerchandiserWorkbenchRoute,type MerchandiserWorkbenchRoute} from './merchandiser-workbench-route.js';

const labels={preparation:'接资料与投料',commercial:'预算与制单',sourcing:'外发与合同',delivery:'生产与交付',exceptions:'差异处理及返工协同'} as const;
const states={mine:'待我办理',waiting:'等待其他岗位',returned:'退回要改',completed:'已办理'} as const;
const urls=createWebUrls(import.meta.env.BASE_URL);
type OpenAction={kind:'contract';caseId:string;documentId:string|null}|{kind:'investment';resource:{kind:'source'|'order';id:string}};
export function MerchandiserWorkbench({search}:{search:string}){
 const [route,setRoute]=useState(()=>readMerchandiserWorkbenchRoute(new URLSearchParams(search)));
 const change=useCallback((next:MerchandiserWorkbenchRoute)=>{
  const updated={...next,focus:undefined};
  window.history.replaceState(window.history.state,'',merchandiserWorkbenchPath(updated,urls.base));setRoute(updated);
 },[]);
 if(!route)return <p role="alert">跟单工作区筛选不正确，请从原入口重新进入。</p>;
 return <div className="dx-designer-astryx" lang="zh-CN"><style>{designerAstryxCss}</style><h1>跟单工作区</h1>
  {route.view==='orders'?<><Button label="返回跟单事项" variant="secondary" onClick={()=>change({...route,page:1,view:'work',documentOrder:undefined})}/>
   <OriginalMerchandiserOrders route={route} change={change}/></>:<CurrentMerchandiserActions route={route} change={change}/>}
 </div>;
}
function MerchandiserOriginalLink({route,rowId,target,label}:{route:MerchandiserWorkbenchRoute;rowId:string;target:string;label:string}){
 return <span data-merchandiser-original={rowId}><Link type="inherit" href={digitalChildDetailHref(target,
  merchandiserWorkbenchPath({...route,focus:rowId},urls.base),urls.base)}>{label}</Link></span>;
}
function useOriginalReturnFocus(focus:string|undefined,ready:boolean){
 const region=useRef<HTMLElement>(null),handled=useRef<string|null>(null);
 useEffect(()=>{
  if(!focus){handled.current=null;return;}
  if(!ready||handled.current===focus)return;
  const frame=requestAnimationFrame(()=>{
   const found=region.current?.querySelector<HTMLElement>(`[data-merchandiser-original="${CSS.escape(focus)}"] a`);
   const target=found??region.current?.querySelector<HTMLElement>('h2');
   if(!target)return;
   target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});handled.current=focus;
  });
  return()=>cancelAnimationFrame(frame);
 },[ready,focus]);
 return region;
}
/** A second view of original orders, not a fifth todo state and never a new
 * instruction/contract/receiving form. Each existing domain rechecks access. */
function OriginalMerchandiserOrders({route,change}:{route:MerchandiserWorkbenchRoute;change:(value:MerchandiserWorkbenchRoute)=>void}){
 const [search,setSearch]=useState(route.search),[retry,setRetry]=useState(0);
 const [result,setResult]=useState<{key:string;value:MerchandiserOrderResponse}|null>(null),[issue,setIssue]=useState<{key:string;message:string}|null>(null);
 useEffect(()=>{
  const value=search.trim();if(value===route.search||value.length>100)return;
  const marker=window.setTimeout(()=>change({...route,page:1,search:value,documentOrder:undefined}),250);
  return()=>window.clearTimeout(marker);
 },[search,route,change]);
 const params=new URLSearchParams({page:String(route.page),search:route.search}),path=urls.apiUrl('todos/merchandiser/orders?'+params),key=`${path}:${retry}`;
 const exact=result?.key===key?result.value:null,error=issue?.key===key?issue.message:'',busy=!exact&&!error;
 useForegroundWait(busy?`merchandiser-orders:${key}`:undefined);useInternalReturnScroll(Boolean(exact||error));
 useEffect(()=>{
  const abort=new AbortController();
  void feedbackFetch(path,{method:'GET',credentials:'include',cache:'no-store',signal:abort.signal})
   .then(response=>feedbackJson(response,'GET',value=>MerchandiserOrderResponseSchema.parse(value),message=>new Error(message)))
   .then(value=>{if(!abort.signal.aborted)setResult({key,value});})
   .catch(reason=>{if(!abort.signal.aborted)setIssue({key,message:reason instanceof Error?reason.message:'原授权订单读取失败'});});
  return()=>abort.abort();
 },[path,key]);
 const region=useOriginalReturnFocus(route.focus,Boolean(exact||error));
 const documents=route.documentOrder&&exact?.items.find(row=>row.id===route.documentOrder);
 const closeDocuments=()=>change({...route,documentOrder:undefined});
 return <section ref={region} aria-label="原授权订单"><h2 tabIndex={-1}>原授权订单</h2><TextInput label="搜索订单ID、PO、客户或工厂" value={search} onChange={setSearch}/>
  {error&&<p role="alert">{error} <Button label="重试读取" variant="secondary" onClick={()=>setRetry(value=>value+1)}/></p>}
  {exact&&(exact.items.length===0?<p>没有符合当前搜索及授权范围的原订单。</p>:<div className="development-table-scroll"><Table data={exact.items} idKey="id" density="balanced" columns={[
   {key:'orderNumber',header:'订单ID / 原款号',renderCell:row=><>{row.orderNumber??row.styleNo} <OrderRushBadge value={row.urgent}/></>},
   {key:'customer',header:'客户 / PO',renderCell:row=><>{row.customer}<small>{row.poNumbers.join('、')||'PO 待核'}</small></>},
   {key:'factories',header:'加工厂',renderCell:row=>row.factories.join('、')||'待核'},
   {key:'id',header:'操作',renderCell:row=><div className="pattern-actions"><MerchandiserOriginalLink route={{...route,documentOrder:undefined}} rowId={row.id}
     target={`/ui/digital-production?order=${row.id}`} label="打开原订单"/>
    <Button label="订单单据" variant="secondary" size="sm" onClick={()=>change({...route,documentOrder:row.id})}/></div>},
  ]}/></div>)}
  <ListPagination page={route.page} total={exact?.total??null} totalPages={exact?Math.max(1,Math.ceil(exact.total/15)):null} busy={busy}
   ariaLabel="原授权订单分页" onPageChange={page=>change({...route,page,documentOrder:undefined})}/>
  {documents&&<Dialog isOpen className="dx-designer-astryx" onOpenChange={open=>{if(!open)closeDocuments();}}>
   <style>{designerAstryxCss}</style><DialogHeader title="订单单据" onOpenChange={open=>{if(!open)closeDocuments();}}/>
   <p>{documents.orderNumber??documents.styleNo}</p>
   <OriginalDocumentDirectory key={documents.id} resource={{kind:'order',id:documents.id}} onSelect={reference=>{
    const href=originalDocumentHref(reference,merchandiserWorkbenchPath(route,urls.base),urls.base);if(href)void navigateInternalPage(href);
   }}/>
  </Dialog>}
 </section>;
}
function CurrentMerchandiserActions({route,change}:{route:MerchandiserWorkbenchRoute;change:(value:MerchandiserWorkbenchRoute)=>void}){
 const [search,setSearch]=useState(route.search),[retry,setRetry]=useState(0);
 const [action,setAction]=useState<OpenAction|null>(null),guards=useRef(new Set<()=>Promise<boolean>>());
 const listHeading=useRef<HTMLHeadingElement>(null),returnFocus=useRef<{button:HTMLButtonElement;scroll:number}|null>(null);
 const [data,setData]=useState<{key:string;value:MerchandiserWorkResponse}|null>(null),[issue,setIssue]=useState<{key:string;message:string}|null>(null);
 useEffect(()=>{
  const value=search.trim();if(value===route.search||value.length>100)return;
  const marker=window.setTimeout(()=>change({...route,page:1,search:value}),250);
  return()=>window.clearTimeout(marker);
 },[change,route,search]);
 const parameters=new URLSearchParams({page:String(route.page),search:route.search,state:route.state,...(route.kind?{kind:route.kind}:{})});
 const path=urls.apiUrl('todos/merchandiser/current?'+parameters),key=`${path}:${retry}`;
 const exact=data?.key===key?data.value:null,error=issue?.key===key?issue.message:'',busy=!exact&&!error;
 useForegroundWait(busy&&!action?`merchandiser:${key}`:undefined);useInternalReturnScroll(Boolean(exact||error));
 useEffect(()=>{
  if(action||busy||!returnFocus.current)return;
  const original=returnFocus.current;
  const frame=requestAnimationFrame(()=>{
   if(original.button.isConnected)original.button.focus({preventScroll:true});
   else listHeading.current?.focus({preventScroll:true});
   window.scrollTo(0,original.scroll);returnFocus.current=null;
  });
  return()=>cancelAnimationFrame(frame);
 },[action,busy]);
 useEffect(()=>{
  const abort=new AbortController();
  void feedbackFetch(path,{method:'GET',credentials:'include',cache:'no-store',signal:abort.signal})
   .then(response=>feedbackJson(response,'GET',value=>MerchandiserWorkResponseSchema.parse(value),message=>new Error(message)))
   .then(value=>{if(!abort.signal.aborted)setData({key,value});})
   .catch(reason=>{if(!abort.signal.aborted)setIssue({key,message:reason instanceof Error?reason.message:'原跟单任务读取失败'});});
  return()=>abort.abort();
 },[key,path]);
 const region=useOriginalReturnFocus(route.focus,Boolean(exact||error)&&!action);
 const open=(button:HTMLButtonElement,next:OpenAction)=>{returnFocus.current={button,scroll:window.scrollY};setAction(next);};
 const close=async()=>{for(const guard of guards.current)if(!await guard())return;setAction(null);};
 const saved=()=>setRetry(attempt=>attempt+1);
 return <>
  {action?.kind==='contract'&&<MerchandiserContractReturn key={`${action.caseId}:${action.documentId}`} caseId={action.caseId}
   requestedDocumentId={action.documentId} onClose={()=>setAction(null)} onSaved={saved}/>}
  {action?.kind==='investment'&&<DocumentGuardContext.Provider value={guards.current}><section aria-label="本单投面辅料">
   <h2>本单投面辅料</h2><Button label="返回跟单列表" variant="secondary" onClick={()=>void close()}/>
   <ProductionReadinessPanel key={`${action.resource.kind}:${action.resource.id}`} resource={action.resource} investmentOnly onChanged={saved}/>
  </section></DocumentGuardContext.Provider>}
  <section ref={region} hidden={Boolean(action)} aria-label={states[route.state]}><h2 ref={listHeading} tabIndex={-1}>{states[route.state]}</h2>
  <div className="pattern-actions"><Button label="查找原授权订单" variant="secondary" onClick={()=>change({...route,page:1,view:'orders'})}/>
   <TextInput label="搜索订单ID、PO、客户或工厂" value={search} onChange={setSearch}/>
   <Selector label="办理状态" value={route.state} options={Object.entries(states).map(([value,label])=>({value,label}))}
    onChange={value=>{const state=MerchandiserWorkActionFilterSchema.safeParse(value).data;if(state)change({...route,page:1,state});}}/>
   <Selector label="业务类型" value={route.kind??'all'} options={[{value:'all',label:'全部业务'},...Object.entries(labels).map(([value,label])=>({value,label}))]}
    onChange={value=>change({...route,page:1,kind:MerchandiserWorkKindSchema.safeParse(value).data})}/>
  </div>
  {error&&<p role="alert">{error} <Button label="重试读取" variant="secondary" onClick={()=>setRetry(value=>value+1)}/></p>}
  {exact&&(exact.items.length===0?<p>没有符合当前授权及筛选的原跟单事项。</p>:<div className="development-table-scroll"><Table data={exact.items} idKey="itemId" density="balanced" columns={[
   {key:'orderNumber',header:'订单ID',renderCell:row=><>{row.orderNumber??'待核'} <OrderRushBadge value={row.urgent}/></>},
   {key:'customer',header:'客户 / PO',renderCell:row=><>{row.customer??'客户待核'}<small>{row.poNumbers.join('、')||'PO 待核'}</small></>},
   {key:'factory',header:'加工厂',renderCell:row=>row.factory??'待核'},
   {key:'title',header:'当前事项',renderCell:row=><>{row.title}<small>{labels[row.kind]}</small></>},
   {key:'responsibleName',header:'负责人',renderCell:row=>row.responsibleName??'待核'},
   {key:'dueAt',header:'原期限',renderCell:row=>row.dueAt?new Date(row.dueAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'}):'未记录'},
   {key:'itemId',header:'操作',renderCell:row=>{
    const workRoute=row.route;
    if(row.state==='waiting'||row.state==='completed'){
     if(workRoute.routeName!=='digital_production_task'||!DigitalIdSchema.safeParse(workRoute.entityId).success)return <span>原任务范围待核</span>;
     const original=`/ui/digital-production?task=${encodeURIComponent(workRoute.entityId)}&taskView=read`;
     return <MerchandiserOriginalLink route={route} rowId={row.itemId} target={original} label="查看原任务"/>;
    }
    const inlineContract=workRoute.routeName==='sourcing_detail'&&workRoute.tab==='contract_return';
    const inlineInvestment=workRoute.routeName==='digital_source_material_investment'||workRoute.routeName==='digital_order_material_investment';
    if((inlineContract||inlineInvestment)&&!DigitalIdSchema.safeParse(workRoute.entityId).success)return <span>原办理范围待核</span>;
    if(inlineContract)return <Button label="办理本单回签" size="sm" variant="secondary" onClick={event=>open(event.currentTarget,
     {kind:'contract',caseId:workRoute.entityId,documentId:workRoute.contractReturn?.documentId??workRoute.transferContract?.documentId??null})}/>;
    if(inlineInvestment)return <Button label="办理本单投面辅料" size="sm" variant="secondary"
     onClick={event=>open(event.currentTarget,{kind:'investment',resource:{kind:workRoute.routeName==='digital_source_material_investment'?'source':'order',id:workRoute.entityId}})}/>;
    return <MerchandiserOriginalLink route={route} rowId={row.itemId} target={todoDestination(workRoute)} label="打开原办理"/>;
   }},
  ]}/></div>)}
  <ListPagination page={route.page} total={exact?.total??null} totalPages={exact?Math.max(1,Math.ceil(exact.total/15)):null} busy={busy}
   ariaLabel="跟单原任务分页" onPageChange={page=>change({...route,page})}/>
 </section></>;
}
