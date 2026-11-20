import {useState} from 'react';
import {JOURNEY_COVERAGE_KEYS,type JourneyCoverage,type JourneyResult} from '@dx-rework/contracts/digital-production-journey';
import {Button} from '@dx-rework/ui';
import {Pagination} from '@dx-rework/ui/production';
import {CockpitHomeDialog} from './cockpit-home-dialog.js';
import {useCockpitReads,cockpitAvailabilityMessage} from './cockpit-reads.js';
import {CockpitRetryUpdates} from './cockpit-retry-updates.js';
import type {CockpitContext} from './digital-journey-cockpit-model.js';

export const cockpitCoverageLabels:Record<JourneyCoverage['key'],string>={customer_date:'客户出货日待补充',factory_date:'工厂交货日待补充',fabric_date:'预计到布日待补充',cutting_time:'实际收布时间待确认',plan:'时效计划待补充',scope:'整单时效查看受限',fact_time:'已登记时间待核对'};

function CoverageOrders({context,category,onOpen,onBack}:{context:CockpitContext;category:JourneyCoverage['key'];onOpen:(id:string)=>void;onBack:()=>void}){
 const [page,setPage]=useState(1),[refresh,setRefresh]=useState(0);
 const query={...context,selected:undefined,round:undefined,kpi:context.kpi,missing:category,page};
 const reads=useCockpitReads(query,refresh),data=reads.data,actual=reads.applied??query,busy=['preparing','loading','identity'].includes(reads.listPhase);
 return <div className="cockpit-coverage-orders" aria-busy={busy}>
  <div className="cockpit-coverage-heading"><Button type="button" variant="secondary" onClick={onBack}>返回分类</Button><h3>{cockpitCoverageLabels[category]}</h3><span>{data?.total!==null&&data?`共 ${data.total} 单`:'—'}</span></div>
  {data?.freshness&&<p role={data.freshness.failed?'alert':'status'}>{cockpitAvailabilityMessage(data)}</p>}
  {data?.freshness?.retryIds?.length?<CockpitRetryUpdates key={data.freshness.retryIds.join(',')} ids={data.freshness.retryIds} onUpdated={()=>setRefresh(value=>value+1)}/>:null}
  {busy&&<p role="status">正在读取订单…{data&&'暂时保留上次结果。'}</p>}
  {reads.listError&&<div role="alert"><p>{reads.listError}{data&&'。以下是上次读取的订单。'}</p><Button type="button" variant="secondary" onClick={()=>setRefresh(value=>value+1)}>重新读取</Button></div>}
  {data&&<><ul className="cockpit-coverage-order-list">{data.items.map(order=><li key={order.id}><button type="button" disabled={busy} onClick={()=>onOpen(order.id)}><strong>{order.designStyleNo}</strong><span>{order.customer??'—'}</span><span>订单ID：{order.identity?.businessNumber??'—'}</span><span>{order.lines.map(line=>line.po||'PO待补').join('、')||'—'}</span></button></li>)}</ul>{!data.items.length&&!busy&&!data.freshness&&<p role="status">当前条件下没有对应订单。</p>}{!data.freshness&&<Pagination page={actual.page} pageSize={15} total={data.total} onPage={setPage}/>}</>}
 </div>;
}

export function CockpitTimingCoverage({data,context,onClose,onOpen}:{data:JourneyResult;context:CockpitContext;onClose:()=>void;onOpen:(id:string)=>void}){
 const [category,setCategory]=useState<JourneyCoverage['key']|null>(null);
 return <CockpitHomeDialog title="待补资料" onClose={onClose}>
  {category?<CoverageOrders key={category} context={context} category={category} onOpen={onOpen} onBack={()=>setCategory(null)}/>:<ul className="cockpit-coverage-categories">{JOURNEY_COVERAGE_KEYS.map(key=>{
   const count=data.supervision?data.supervision.coverage.find(row=>row.key===key)?.orders??0:null;
   return <li key={key}><button type="button" disabled={count===null||count===0} onClick={()=>setCategory(key)}><span>{cockpitCoverageLabels[key]}</span><strong>{count===null?'—':`${count} 单`}</strong><span aria-hidden>›</span></button></li>;
  })}</ul>}
 </CockpitHomeDialog>;
}
