import {useEffect,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Table} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import type {QualityDirectoryItem} from '@dx-rework/contracts/production-readiness';
import {digitalRequest} from './digital-production-api.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {useForegroundWait} from './foreground-loading.js';
import {ListPagination} from './list-pagination.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {qualityWorkbenchPath,type QualityWorkbenchRoute} from './quality-workbench-route.js';
type Page={page:number;total:number;items:QualityDirectoryItem[]};
function qualityEntry(row:QualityDirectoryItem,route:QualityWorkbenchRoute){
 const {source}=row,base=import.meta.env.BASE_URL;
 const params=new URLSearchParams(source.kind==='craft'?{factory:row.orderId,factoryAction:'qc',qualityReturn:source.returnFactId,
  qualityStep:source.stepRef??'original',qualityTask:source.taskId,line:source.lineId}:source.kind==='garment'?
  {closure:row.orderId,qualityReceipt:source.receiptId,qualityQuantityVersion:source.quantityVersion}:
  {factory:row.orderId,factoryAction:'productionQc',qualityProduction:source.productionId,qualityDecision:source.factoryDecisionId??'original',line:source.lineId});
 return digitalChildDetailHref('/ui/digital-production?'+params,qualityWorkbenchPath(route,base),base);
}
export function QualityDirectoryTable({route,update}:{route:QualityWorkbenchRoute;update:(next:QualityWorkbenchRoute)=>void}){
 const [search,setSearch]=useState(route.search),[retry,setRetry]=useState(0);
 const [data,setData]=useState<{key:string;page:Page}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null);
 const path=`quality/directory/${route.kind}?`+new URLSearchParams({page:String(route.page),status:route.status,search:route.search});
 const key=path+':'+retry,exact=data?.key===key?data.page:null,error=failure?.key===key?failure.message:'',pending=!exact&&!error;
 useForegroundWait(pending?key:undefined);
 useInternalReturnScroll(Boolean(exact||error));
 useEffect(()=>{
  const abort=new AbortController();
  void digitalRequest<Page>(path,'GET',undefined,undefined,{signal:abort.signal}).then(page=>{
   if(!abort.signal.aborted)setData({key,page});
  }).catch(reason=>{if(!abort.signal.aborted)setFailure({key,message:reason instanceof Error?reason.message:'无法读取原加工检查'});});
  return()=>abort.abort();
 },[path,key]);
 return <section aria-label={route.kind==='craft'?'工艺回仓质检原任务':route.kind==='garment'?'成衣到仓检查清单':'在厂加工检查清单'}>
  <form className="pattern-actions" onSubmit={e=>{e.preventDefault();if(search.trim().length<=100)update({...route,search:search.trim(),page:1});}}>
   <TextInput label="搜索订单ID、PO、客户或加工厂" value={search} onChange={setSearch}/>
   <Button type="submit" label="搜索" isDisabled={search.trim().length>100}/>
   {route.kind!=='craft'&&<Selector label="检查类型" value={route.kind} options={[{value:'factory',label:'在厂加工检查'},{value:'garment',label:'成衣到仓检查'}]}
    onChange={value=>{if(value==='factory'||value==='garment')update({...route,kind:value,page:1});}}/>}
   <Selector label="检查状态" value={route.status} options={[{value:'open',label:'待检查'},{value:'completed',label:'已检查'}]}
    onChange={value=>update({...route,status:value==='completed'?'completed':'open',page:1})}/>
  </form>
  {error&&<p role="alert">{error} <Button label="重试读取" variant="secondary" onClick={()=>setRetry(value=>value+1)}/></p>}
  {exact&&(exact.items.length===0?<p>没有符合当前授权和筛选的检查。</p>:<div className="development-table-scroll"><Table data={exact.items} idKey="id" density="balanced" columns={[
   {key:'designStyleNo',header:'订单ID / 客户',renderCell:row=><>{row.designStyleNo??'待核'}<small>{row.customerCode??'客户待核'}</small></>},
   {key:'poNumber',header:'PO / 加工厂',renderCell:row=><>{row.poNumber??'待核'}<small>{row.supplierName??'加工厂待核'}</small></>},
   {key:'quantity',header:'本批数量 / 有效合格',renderCell:row=>{const unit=row.source.kind==='craft'?'片':'件';
     return <>{row.quantity} {unit} / {row.qualifiedQuantity===null?'待核':`${row.qualifiedQuantity} ${unit}`}</>;}},
   {key:'dueAt',header:'原期限',renderCell:row=>row.dueAt?new Date(row.dueAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'}):'期限待核'},
   {key:'result',header:'结果',renderCell:row=>!row.inspected?'待检查':row.result==='problem'?'有质量问题':row.result==='passed'?'本批检查合格':'已检查，结论待核'},
   {key:'id',header:'办理',renderCell:row=><Link type="inherit" href={qualityEntry(row,route)}>{row.inspected?'查看原检查':'办理本批检查'}</Link>},
  ]}/></div>)}
  <ListPagination page={route.page} total={exact?.total??null} totalPages={exact?Math.max(1,Math.ceil(exact.total/15)):null} busy={pending}
   ariaLabel="加工检查分页" onPageChange={page=>update({...route,page})}/>
 </section>;
}
