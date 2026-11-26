import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Table} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {useEffect,useState} from 'react';
import type {WarehouseReceiptListItem,WarehouseReceiptPage} from '@dx-rework/contracts/production-readiness';
import {createWebUrls} from '../url-contract.js';
import {DigitalRequestError,digitalRequest} from './digital-production-api.js';
import {designerAstryxCss} from './designer-astryx.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {useForegroundWait} from './foreground-loading.js';
import {ListPagination} from './list-pagination.js';
import {OrderRushBadge} from './order-rush-badge.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {readWarehouseWorkbenchRoute,warehouseWorkbenchPath,type WarehouseWorkbenchRoute} from './warehouse-workbench-route.js';
import {WarehouseNativeTaskTable} from './warehouse-native-task-table.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
const digit=(amount:string|null,unit:string)=>amount===null?'待核':`${amount} ${unit}`;
function receiptQuantitySign(value:string|null|undefined){
 if(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value))return null;
 return /[1-9]/.test(value)?1:0;
}
export function warehouseReceiptStatus({invested,received,balance}:Pick<WarehouseReceiptListItem,'invested'|'received'|'balance'>){
 const actual=received?.unit===invested.unit?receiptQuantitySign(received.quantity):null;
 if(actual===null)return '实收待核';
 if(actual===0)return '实收为零';

 const remaining=receiptQuantitySign(balance.procurementRemaining),excess=receiptQuantitySign(balance.excessReceived);
 if(balance.unit!==invested.unit||remaining===null||excess===null)return '实收待核';
 if(excess>0)return '实收有差异';
 return remaining===0?'采购已收足':'部分收料';
}
const receiptLink=(item:WarehouseReceiptListItem,back:string)=>{
 const name=item.resource.kind==='source'?'materialSource':'materialOrder';
 const query=new URLSearchParams({[name]:item.resource.id,warehouseReceipt:'1',warehouseMaterial:item.materialId,
  warehouseScope:item.scopeRef,warehouseKind:item.kind,...(item.lineId?{warehouseLine:item.lineId}:{})});
 return digitalChildDetailHref('/ui/digital-production?'+query,back,urls.base);
};
function Receipts({route,change,back}:{route:WarehouseWorkbenchRoute;change:(next:WarehouseWorkbenchRoute)=>void;back:string}){
 const [search,setSearch]=useState(route.search),[retry,setRetry]=useState(0);
 const [data,setData]=useState<{key:string;value:WarehouseReceiptPage}|null>(null),
  [error,setError]=useState<{key:string;message:string}|null>(null);
 const path='warehouse/receipts?'+new URLSearchParams({page:String(route.page),search:route.search,status:route.status});
 const key=path+':'+retry,exact=data?.key===key?data.value:null,warning=error?.key===key?error.message:'',pending=exact===null&&!warning;
 useForegroundWait(pending?key:undefined);
 useInternalReturnScroll(Boolean(exact||warning));
 useEffect(()=>{
  const controller=new AbortController();
  void digitalRequest<WarehouseReceiptPage>(path,'GET',undefined,undefined,{signal:controller.signal})
   .then(value=>{if(!controller.signal.aborted)setData({key,value});})
   .catch(reason=>{if(!controller.signal.aborted)setError({key,message:reason instanceof DigitalRequestError&&reason.status===404
    ?'当前服务未开放仓库收料列表。':reason instanceof Error?reason.message:'待收料读取失败'});});
  return()=>controller.abort();
 },[key,path]);
 return <section aria-label="待收料">
  <form className="pattern-actions" onSubmit={event=>{event.preventDefault();change({...route,page:1,search:search.trim()});}}>
   <TextInput label="搜索订单ID、PO 或物料" value={search} onChange={setSearch}/>
   <Button type="submit" label="搜索" isDisabled={search.trim().length>100}/>
   <Selector label="收料状态" value={route.status} options={[{value:'open',label:'当前待收'},{value:'completed',label:'采购收足'}]}
    onChange={value=>change({...route,status:value==='completed'?'completed':'open',page:1})}/>
  </form>
  {warning&&<p role="alert">{warning} <Button type="button" label="重试读取" variant="secondary" onClick={()=>setRetry(value=>value+1)}/></p>}
  {exact&&(!exact.items.length?<p>{exact.total?'本页暂无收料事项，可返回前一页。':'没有符合授权及筛选的收料事项。'}</p>:
   <div className="development-table-scroll"><Table data={exact.items} idKey="id" density="balanced" columns={[
    {key:'orderNumber',header:'订单ID / 款号 / 客户',renderCell:row=><>{row.issuedOrderNumber??(row.orderNumber?`款号 ${row.orderNumber}`:'订单ID待核')} <OrderRushBadge value={row.orderRush}/><small>{row.customerCode??'客户待核'}</small></>},
    {key:'poNumber',header:'PO',renderCell:row=>row.poNumber??(row.lineId?'PO待核':'共享物料')},
    {key:'name',header:'原收料任务',renderCell:row=><>{row.name}<small>{row.supplier??'供应方待核'}</small></>},
    {key:'invested',header:'投料 / 实收 / 待收',renderCell:row=><>{digit(row.invested.quantity,row.invested.unit)} / {digit(row.received?.quantity??null,row.invested.unit)} / {digit(row.balance.procurementRemaining,row.invested.unit)}</>},
    {key:'assigneeName',header:'负责人',renderCell:row=>row.assigneeName??'待安排'},
    {key:'balance',header:'状态',renderCell:warehouseReceiptStatus},
    {key:'id',header:'办理',renderCell:row=><div className="pattern-actions">
     <Link type="inherit" href={receiptLink(row,back)}>{route.status==='completed'?'查看原收料与订正':'实际收料'}</Link>
     {row.resource.kind==='order'&&row.received&&Number(row.received.quantity)>0&&
      <Link type="inherit" href={digitalChildDetailHref(`/ui/digital-production?bulk=${row.resource.id}&warehouseMaterials=1`,back,urls.base)}>本单发料</Link>}
    </div>},
   ]}/></div>)}
  <ListPagination page={route.page} total={exact?.total??null} totalPages={exact?Math.max(1,Math.ceil(exact.total/15)):null}
   ariaLabel="仓库待收料分页" busy={Boolean(pending)} onPageChange={page=>change({...route,page})}/>
 </section>;
}
export function WarehouseCenter(){
 const [route,setRoute]=useState(()=>readWarehouseWorkbenchRoute(new URLSearchParams(window.location.search)));
 if(!route)return <p role="alert">仓库中心筛选不正确，请从原入口重新进入。</p>;
 const back=warehouseWorkbenchPath(route,urls.base);
 const change=(next:WarehouseWorkbenchRoute)=>{
  window.history.replaceState(window.history.state,'',warehouseWorkbenchPath(next,urls.base));setRoute(next);
 };
 const sections=[['receive','待收料'],['preshrink','待预缩'],['craft','工艺收发'],['dispatch','待发料及发厂']] as const;
 return <div className="dx-designer-astryx" lang="zh-CN">
  <style>{designerAstryxCss}</style>
  <h1>仓库中心</h1>
  <nav className="pattern-actions" aria-label="仓库业务范围">
   {sections.map(([key,label])=><Button key={key} type="button" aria-pressed={route.tab===key}
    variant={route.tab===key?'primary':'secondary'} label={label}
    onClick={()=>{if(route.tab!==key)change({...route,tab:key,search:'',page:1,status:'open'});}}/>)}
  </nav>
  {route.tab==='receive'?<Receipts key="receive" route={route} change={change} back={back}/>:
   <WarehouseNativeTaskTable key={route.tab} initial={{kind:route.tab,status:route.status,page:route.page,search:route.search}}
    onFilter={query=>change({...route,page:query.page,status:query.status,search:query.search})} returnTo={back}/>}
 </div>;
}
