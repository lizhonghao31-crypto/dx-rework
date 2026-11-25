import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Table} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {MerchandiserWorkKindSchema,MerchandiserWorkResponseSchema,type MerchandiserWorkResponse} from '@dx-rework/contracts';
import {todoDestination} from '@dx-rework/contracts/todo-destination';
import {createWebUrls} from '../url-contract.js';
import {designerAstryxCss} from './designer-astryx.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {useForegroundWait} from './foreground-loading.js';
import {ListPagination} from './list-pagination.js';
import {MerchandiserContractReturn} from './merchandiser-contract-return.js';
import {OrderRushBadge} from './order-rush-badge.js';
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {merchandiserWorkbenchPath,readMerchandiserWorkbenchRoute,type MerchandiserWorkbenchRoute} from './merchandiser-workbench-route.js';

const labels={preparation:'接资料与投料',commercial:'预算与制单',sourcing:'外发与合同',delivery:'生产与交付',exceptions:'差异处理及返工协同'} as const;
const urls=createWebUrls(import.meta.env.BASE_URL);
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
 const [contract,setContract]=useState<{caseId:string;documentId:string|null}|null>(null);
 const listHeading=useRef<HTMLHeadingElement>(null),returnFocus=useRef<{button:HTMLButtonElement;scroll:number}|null>(null);
 const [data,setData]=useState<{key:string;value:MerchandiserWorkResponse}|null>(null),[issue,setIssue]=useState<{key:string;message:string}|null>(null);
 useEffect(()=>{
  const value=search.trim();if(value===route.search||value.length>100)return;
  const marker=window.setTimeout(()=>change({...route,page:1,search:value}),250);
  return()=>window.clearTimeout(marker);
 },[change,route,search]);
 const parameters=new URLSearchParams({page:String(route.page),search:route.search,...(route.kind?{kind:route.kind}:{})});
 const path=urls.apiUrl('todos/merchandiser/current?'+parameters),key=`${path}:${retry}`;
 const exact=data?.key===key?data.value:null,error=issue?.key===key?issue.message:'',busy=!exact&&!error;
 useForegroundWait(busy&&!contract?`merchandiser:${key}`:undefined);useInternalReturnScroll(Boolean(exact||error));
 useEffect(()=>{
  if(contract||busy||!returnFocus.current)return;
  const original=returnFocus.current;
  const frame=requestAnimationFrame(()=>{
   if(original.button.isConnected)original.button.focus({preventScroll:true});
   else listHeading.current?.focus({preventScroll:true});
   window.scrollTo(0,original.scroll);returnFocus.current=null;
  });
  return()=>cancelAnimationFrame(frame);
 },[contract,busy]);
 useEffect(()=>{
  const abort=new AbortController();
  void feedbackFetch(path,{method:'GET',credentials:'include',cache:'no-store',signal:abort.signal})
   .then(response=>feedbackJson(response,'GET',value=>MerchandiserWorkResponseSchema.parse(value),message=>new Error(message)))
   .then(value=>{if(!abort.signal.aborted)setData({key,value});})
   .catch(reason=>{if(!abort.signal.aborted)setIssue({key,message:reason instanceof Error?reason.message:'原跟单任务读取失败'});});
  return()=>abort.abort();
 },[key,path]);
 const returnTo=merchandiserWorkbenchPath(route,urls.base);
 return <>
  {contract&&<MerchandiserContractReturn key={`${contract.caseId}:${contract.documentId}`} caseId={contract.caseId}
   requestedDocumentId={contract.documentId} onClose={()=>setContract(null)} onSaved={()=>setRetry(attempt=>attempt+1)}/>}
  <section hidden={Boolean(contract)} aria-label="待我办理"><h2 ref={listHeading} tabIndex={-1}>待我办理</h2>
  <div className="pattern-actions"><TextInput label="搜索订单ID、PO、客户或工厂" value={search} onChange={setSearch}/>
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
   {key:'itemId',header:'操作',renderCell:row=>row.route.routeName==='sourcing_detail'&&row.route.tab==='contract_return'?
    <Button label="办理本单回签" size="sm" variant="secondary" onClick={event=>{
     returnFocus.current={button:event.currentTarget,scroll:window.scrollY};
     setContract({caseId:row.route.entityId,documentId:row.route.contractReturn?.documentId??row.route.transferContract?.documentId??null});
    }}/>:<Link type="inherit" href={digitalChildDetailHref(todoDestination(row.route),returnTo,urls.base)}>打开原办理</Link>},
  ]}/></div>)}
  <ListPagination page={route.page} total={exact?.total??null} totalPages={exact?Math.max(1,Math.ceil(exact.total/15)):null} busy={busy}
   ariaLabel="跟单原任务分页" onPageChange={page=>change({...route,page})}/>
 </section></>;
}
