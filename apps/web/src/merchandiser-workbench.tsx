import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Table} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {MerchandiserWorkActionFilterSchema,MerchandiserWorkKindSchema,MerchandiserWorkResponseSchema,type MerchandiserWorkResponse} from '@dx-rework/contracts';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import {todoDestination} from '@dx-rework/contracts/todo-destination';
import {createWebUrls} from '../url-contract.js';
import {designerAstryxCss} from './designer-astryx.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {useForegroundWait} from './foreground-loading.js';
import {ListPagination} from './list-pagination.js';
import {MerchandiserContractReturn} from './merchandiser-contract-return.js';
import {OrderRushBadge} from './order-rush-badge.js';
import {ProductionReadinessPanel} from './production-readiness-panel.js';
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {DocumentGuardContext} from './use-digital-detail-navigation-guard.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {merchandiserWorkbenchPath,readMerchandiserWorkbenchRoute,type MerchandiserWorkbenchRoute} from './merchandiser-workbench-route.js';

const labels={preparation:'接资料与投料',commercial:'预算与制单',sourcing:'外发与合同',delivery:'生产与交付',exceptions:'差异处理及返工协同'} as const;
const urls=createWebUrls(import.meta.env.BASE_URL);
type OpenAction={kind:'contract';caseId:string;documentId:string|null}|{kind:'investment';resource:{kind:'source'|'order';id:string}};
export function MerchandiserWorkbench({search}:{search:string}){
 const [route,setRoute]=useState(()=>readMerchandiserWorkbenchRoute(new URLSearchParams(search)));
 const change=useCallback((next:MerchandiserWorkbenchRoute)=>{
  window.history.replaceState(window.history.state,'',merchandiserWorkbenchPath(next,urls.base));setRoute(next);
 },[]);
 if(!route)return <p role="alert">跟单工作区筛选不正确，请从原入口重新进入。</p>;
 return <div className="dx-designer-astryx" lang="zh-CN"><style>{designerAstryxCss}</style><h1>跟单工作区</h1>
  <CurrentMerchandiserActions route={route} change={change}/>
 </div>;
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
 const returnTo=merchandiserWorkbenchPath(route,urls.base);
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
  <section hidden={Boolean(action)} aria-label={route.state==='returned'?'退回要改':'待我办理'}><h2 ref={listHeading} tabIndex={-1}>{route.state==='returned'?'退回要改':'待我办理'}</h2>
  <div className="pattern-actions"><TextInput label="搜索订单ID、PO、客户或工厂" value={search} onChange={setSearch}/>
   <Selector label="办理状态" value={route.state} options={[{value:'mine',label:'待我办理'},{value:'returned',label:'退回要改'}]}
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
   {key:'dueAt',header:'原期限',renderCell:row=>row.dueAt?new Date(row.dueAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'}):'未记录'},
   {key:'itemId',header:'操作',renderCell:row=>{
    const {route}=row;
    const inlineContract=route.routeName==='sourcing_detail'&&route.tab==='contract_return';
    const inlineInvestment=route.routeName==='digital_source_material_investment'||route.routeName==='digital_order_material_investment';
    if((inlineContract||inlineInvestment)&&!DigitalIdSchema.safeParse(route.entityId).success)return <span>原办理范围待核</span>;
    if(inlineContract)return <Button label="办理本单回签" size="sm" variant="secondary" onClick={event=>open(event.currentTarget,
     {kind:'contract',caseId:route.entityId,documentId:route.contractReturn?.documentId??route.transferContract?.documentId??null})}/>;
    if(inlineInvestment)return <Button label="办理本单投面辅料" size="sm" variant="secondary"
     onClick={event=>open(event.currentTarget,{kind:'investment',resource:{kind:route.routeName==='digital_source_material_investment'?'source':'order',id:route.entityId}})}/>;
    return <Link type="inherit" href={digitalChildDetailHref(todoDestination(row.route),returnTo,urls.base)}>打开原办理</Link>;
   }},
  ]}/></div>)}
  <ListPagination page={route.page} total={exact?.total??null} totalPages={exact?Math.max(1,Math.ceil(exact.total/15)):null} busy={busy}
   ariaLabel="跟单原任务分页" onPageChange={page=>change({...route,page})}/>
 </section></>;
}
