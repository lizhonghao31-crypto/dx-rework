import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {Table} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import type {WarehouseNativeTaskQuery} from '@dx-rework/contracts/production-readiness';
import {useEffect,useState} from 'react';
import {createWebUrls} from '../url-contract.js';
import {DigitalRequestError,digitalRequest} from './digital-production-api.js';
import {digitalTaskDisplayStatus} from './digital-workspace-copy.js';
import {useForegroundWait} from './foreground-loading.js';
import {ListPagination} from './list-pagination.js';
import {OrderRushBadge} from './order-rush-badge.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {TaskPlanTargets} from './task-plan-targets.js';
import {digitalChildDetailHref} from './digital-detail-route.js';

type NativePage={items:DigitalTask[];total:number;page:number};
const urls=createWebUrls(import.meta.env.BASE_URL);
const taskHref=(row:DigitalTask,returnTo:string,kind:WarehouseNativeTaskQuery['kind'])=>digitalChildDetailHref('/ui/digital-production?'+new URLSearchParams(kind==='craft'&&row.orderId&&row.state!=='completed'?{
 factory:row.orderId,factoryAction:'logistics',warehouseCraft:'1',
}:{
 task:row.taskId,taskView:row.canExecute&&row.state!=='completed'&&!row.paused?'handle':'read',
}),returnTo,urls.base);
const deadline=(row:DigitalTask)=>{
 if(!row.dueAt)return row.slaHours===null?'没有已确认期限':'期限待核';
 const end=new Date(Date.parse(row.dueAt)-(row.deadlineExclusive?1:0));
 return end.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'});
};

export function WarehouseNativeTaskTable({initial,onFilter,returnTo}:{
 initial:WarehouseNativeTaskQuery;onFilter:(query:WarehouseNativeTaskQuery)=>void;returnTo:string;
}){
 const [search,setSearch]=useState(initial.search),[version,setVersion]=useState(0);
 const [view,setView]=useState<{key:string;data:NativePage}|null>(null),[error,setError]=useState<{key:string;message:string}|null>(null);
 const parameter=new URLSearchParams({kind:initial.kind,status:initial.status,page:String(initial.page),search:initial.search}).toString();
 const key=parameter+':'+version;
 const exact=view?.key===key?view.data:null,failed=error?.key===key?error.message:'',busy=exact===null&&!failed;
 useInternalReturnScroll(Boolean(exact||failed));
 useForegroundWait(busy?`warehouse-native:${key}`:undefined);
 useEffect(()=>{
  const controller=new AbortController();
  void digitalRequest<NativePage>('warehouse/native-tasks?'+parameter,'GET',undefined,undefined,{signal:controller.signal})
   .then(data=>{if(!controller.signal.aborted)setView({key,data});})
   .catch(reason=>{if(!controller.signal.aborted)setError({key,message:reason instanceof DigitalRequestError&&reason.status===404
    ?'当前服务未开放原仓库任务列表。':reason instanceof Error?reason.message:'原仓库任务读取失败'});});
  return()=>controller.abort();
 },[key,parameter]);
 const apply=()=>onFilter({...initial,search:search.trim(),page:1});
 const shown=exact?.items??[];
 return <section aria-label={initial.kind==='preshrink'?'待预缩':initial.kind==='craft'?'原仓库工艺收发':'待发料及发厂'}>
  <form className="pattern-actions" onSubmit={event=>{event.preventDefault();apply();}}>
   <TextInput label="搜索订单ID或 PO" value={search} onChange={setSearch}/>
   <Button type="submit" label="搜索" isDisabled={search.trim().length>100}/>
   <Selector label="任务状态" value={initial.status} options={[{value:'open',label:'当前未完成'},{value:'completed',label:'已完成'}]}
    onChange={value=>onFilter({...initial,status:value==='completed'?'completed':'open',page:1})}/>
  </form>
  {failed&&<p role="alert">{failed} <Button type="button" label="重试读取" variant="secondary" onClick={()=>setVersion(v=>v+1)}/></p>}
  {exact&&!shown.length&&<p>{exact.total>0?'本页暂无仓库任务，可返回前一页。':'没有符合当前授权和筛选的原仓库任务。'}</p>}
  {shown.length>0&&<div className="development-table-scroll"><Table data={shown} idKey="taskId" density="balanced" columns={[
   {key:'identity',header:'订单ID / 客户',renderCell:row=><>{row.identity?.designStyleNo??'待核'} <OrderRushBadge value={row.orderRush}/>
    <small>{row.identity?.customerCode??'客户待核'}</small></>},
   {key:'label',header:'原任务'},
   {key:'assigneeName',header:'负责人',renderCell:row=>row.assigneeName??'待安排'},
   {key:'dueAt',header:'原计划 / 期限',renderCell:row=><>{deadline(row)}<TaskPlanTargets task={row}/></>},
   {key:'state',header:'状态',renderCell:row=>digitalTaskDisplayStatus(row,row.state==='completed')},
   {key:'taskId',header:'办理',renderCell:row=>{
    const href=taskHref(row,returnTo,initial.kind);
    return <div className="pattern-actions">
     {href&&<Link type="inherit" href={href}>{row.state==='completed'||!row.canExecute?'查看原任务':'进入原任务'}</Link>}
     {initial.kind==='dispatch'&&row.orderId&&
      <Link type="inherit" href={digitalChildDetailHref(`/ui/digital-production?bulk=${row.orderId}&warehouseMaterials=1`,returnTo,urls.base)}>本单发料</Link>}
    </div>;
   }},
  ]}/></div>}
  <ListPagination page={initial.page} total={exact?.total??null} totalPages={exact?Math.max(1,Math.ceil(exact.total/15)):null}
   busy={Boolean(busy)} ariaLabel="仓库原任务分页" onPageChange={page=>onFilter({...initial,page})}/>
 </section>;
}
