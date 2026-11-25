import {useEffect,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Table} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {createWebUrls} from '../url-contract.js';
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {useForegroundWait} from './foreground-loading.js';
import {ListPagination} from './list-pagination.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {designerAstryxCss} from './designer-astryx.js';

type Filter='open'|'all'|'collected';
type Row={id:string;orderNumber:string|null;customerCode:string|null;supplierName:string|null;poNumber:string|null;color:string|null;
 actualFactoryDispatchAt:string;expectedFactoryReturnDate:string|null;expectedQuantity:number|null;factoryShipmentRecorded:boolean;
 balance:{status:'pending'|'collected'|'unresolved'|'over_received';received:number|null;remaining:number|null;
  difference:number|null;dispatches:ReadonlyArray<{factId:string}>}};
type Page={items:Row[];page:number;total:number};
const urls=createWebUrls(import.meta.env.BASE_URL);
const quantity=(value:number|null)=>value===null?'待核':`${value.toLocaleString('zh-CN')} 件`;
const date=(at:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const filters=[{value:'open',label:'未收足'},{value:'collected',label:'已收足'},{value:'all',label:'全部'}];
const returnMemory='dx:receiving-pending:return';

export function PendingReceivingBoard(){
 const params=new URLSearchParams(window.location.search),last=params.get('status');
 const [draft,setDraft]=useState(params.get('q')??''),[search,setSearch]=useState(draft),[status,setStatus]=useState<Filter>(last==='all'||last==='collected'?last:'open');
 const [page,setPage]=useState(Math.max(1,Number.parseInt(params.get('page')??'1',10)||1)),[revision,retry]=useState(0);
 const [snapshot,save]=useState<{key:string;data:Page|null;error:string}|null>(null);
 const filter=new URLSearchParams({page:String(page),q:search,status}).toString(),key=`${filter}:${revision}`;
 const pending=snapshot?.key!==key,visible=pending?null:snapshot;
 useForegroundWait(pending?`receiving-pending:${key}`:undefined);
 useInternalReturnScroll(!pending);
 useEffect(()=>{
  const abort=new AbortController();
  void feedbackFetch(urls.apiUrl(`receiving/pending?${filter}`),{credentials:'include',signal:abort.signal})
   .then(response=>feedbackJson(response,'GET',value=>value as Page))
   .then(data=>{if(!abort.signal.aborted)save({key,data,error:''});})
   .catch(error=>{if(!abort.signal.aborted)save({key,data:null,error:error instanceof Error?error.message:'无法读取待收货'});});
  return()=>abort.abort();
 },[filter,key]);
 const boardPath=urls.pageUrl(`/ui/orders?view=pending&${filter}`);
 useEffect(()=>{window.history.replaceState(window.history.state,'',boardPath);},[boardPath]);
 useEffect(()=>{
  if(!visible?.data)return;
  try{
   const saved=JSON.parse(sessionStorage.getItem(returnMemory)??'null') as {path?:string;id?:string;top?:number}|null;
   if(saved?.path!==boardPath||typeof saved.id!=='string'||typeof saved.top!=='number'||!Number.isFinite(saved.top))return;
   const {id,top}=saved;
   const frame=window.requestAnimationFrame(()=>{
    const link=document.querySelector<HTMLElement>(`[data-receiving-return="${CSS.escape(id)}"] a`);
    const fallback=document.getElementById('pending-receiving-heading');
    (link??fallback)?.focus({preventScroll:true});
    if(link)window.scrollTo({top,left:0});
    sessionStorage.removeItem(returnMemory);
   });
   return()=>window.cancelAnimationFrame(frame);
  }catch{return;}
 },[boardPath,visible?.data]);
 return <main className="order-board-page dx-designer-astryx" aria-label="待收货" lang="zh-CN" style={{gridTemplateColumns:'minmax(0,1fr)'}}>
  <style>{designerAstryxCss}</style>
  <header className="order-board-header"><h1 id="pending-receiving-heading" tabIndex={-1}>待收货</h1><Link type="inherit" href={urls.pageUrl('/ui/orders')}>返回订单回货</Link></header>
  <form className="pattern-actions" onSubmit={event=>{event.preventDefault();setPage(1);setSearch(draft.trim());}}>
   <TextInput label="订单ID、PO 或工厂" value={draft} onChange={setDraft}/>
   <Button label="搜索" type="submit" isDisabled={draft.trim().length>100}/>
   <Selector label="待收状态" options={filters} value={status} onChange={value=>{setStatus(value==='all'||value==='collected'?value:'open');setPage(1);}}/>
  </form>
  {visible?.error&&<p role="alert">{visible.error} <Button label="重新读取" onClick={()=>retry(v=>v+1)}/></p>}
  {visible?.data&&!visible.data.items.length&&<p>{visible.data.total?'此页暂无待收货记录。':'当前筛选下没有可核实的待收货范围。'}</p>}
  {visible?.data?.items.length?<div className="development-table-scroll" role="region" aria-label="原待收范围" tabIndex={0} style={{minWidth:0,overflowX:'auto'}}><Table data={visible.data.items} idKey="id" density="balanced" columns={[
   {key:'orderNumber',header:'订单ID / 客户',renderCell:row=><>{row.orderNumber??'待核'} · {row.customerCode??'待核'}</>},
   {key:'supplierName',header:'工厂',renderCell:row=>row.supplierName??'待核'},
   {key:'poNumber',header:'PO / 款色',renderCell:row=><>{row.poNumber??'待核'} · {row.color??'待核'}</>},
   {key:'actualFactoryDispatchAt',header:'实际发厂 / 预计回货',renderCell:row=><>{date(row.actualFactoryDispatchAt)} · {row.expectedFactoryReturnDate??'待核'}</>},
   {key:'expectedQuantity',header:'应回 / 已收 / 待收',renderCell:row=><>{quantity(row.expectedQuantity)} / {quantity(row.balance.received)} / {quantity(row.balance.remaining)}</>},
   {key:'balance',header:'状态',renderCell:row=>row.balance.status==='unresolved'?'范围待核':row.balance.status==='collected'?'已收足':row.balance.status==='over_received'?`超收 ${quantity(row.balance.difference)}`:row.factoryShipmentRecorded?'待收货':'加工中／待回'},
   {key:'id',header:'操作',renderCell:row=>{
    if(row.balance.status!=='pending'||!row.factoryShipmentRecorded)return '—';
    const href=urls.pageUrl('/ui/receiving?'+new URLSearchParams({pendingAllocation:row.id,returnTo:boardPath}));
    return <span data-receiving-return={row.id}><Link type="inherit" href={href} onClick={()=>{
     try{sessionStorage.setItem(returnMemory,JSON.stringify({path:boardPath,id:row.id,top:window.scrollY}));}catch{/* return URL still preserves filters */}
    }}>收货</Link></span>;
   }},
  ]}/></div>:null}
  <ListPagination page={page} total={visible?.data?.total??null} totalPages={visible?.data?Math.max(1,Math.ceil(visible.data.total/15)):null}
   busy={pending} ariaLabel="待收货分页" onPageChange={setPage}/>
 </main>;
}
