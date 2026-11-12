import {CockpitDate} from './cockpit-date.js';
import {cockpitScheduleReason} from './cockpit-fixed-schedule.js';
import {hasDateOnlyTarget,nodeTargetLabel,originalNodeDeadlineLabel} from './journey-sla-details.js';
import {useEffect,useState} from 'react';
import {type JourneyNode,type JourneyResult,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {StatusBadge} from '@dx-rework/ui';
import {BusinessTable,Pagination} from '@dx-rework/ui/production';
import {CockpitPhoto} from './cockpit-photo-preview.js';
import {cockpitQuery,representativeCockpitNodes,type CockpitContext} from './digital-journey-cockpit-model.js';
import {poDeliveryKindLabels,sortedCockpitPoLines} from './po-delivery-dates.js';
import {cockpitVisibleBlockers} from './cockpit-node-rows.js';
import {CockpitHomeProgress,cockpitReceiptGap} from './cockpit-home-progress.js';
import {CockpitHomeRisks,cockpitHomeRisks} from './cockpit-home-risks.js';
import './cockpit-home.css';
import './cockpit-home-r5.css';

const stateLabels={completed:'整单已完成',overdue:'逾期',due_soon:'临期',active:'进行中',not_started:'未启动',cancelled:'已取消'};
function Task({node,showBlocker=true}:{node:JourneyNode;showBlocker?:boolean}){
 const status=node.risks.includes('overdue')?'逾期':node.risks.includes('due_soon')?'临期':node.state==='blocked'?'受阻':node.state==='active'?'进行中':'等待前置';
 return <><strong>{node.label}</strong><small>{node.owner?.name??'负责人未指派'}</small><StatusBadge tone={node.risks.includes('overdue')?'danger':node.risks.includes('due_soon')?'warning':node.state==='active'?'info':'neutral'}>{status}</StatusBadge><small>截止 {node.fixedTargets?.length?originalNodeDeadlineLabel(node):node.nativeWindows?.length||hasDateOnlyTarget(node)?nodeTargetLabel(node):<CockpitDate value={node.expectedAt} precision={node.expectedPrecision} missing="—"/>}</small>{showBlocker&&cockpitVisibleBlockers(node).filter(blocker=>!blocker.key.startsWith('completion:')&&!blocker.label.startsWith('完成办理前')).slice(0,1).map(blocker=><small className="cockpit-home-blocker" key={blocker.key}>{blocker.label}</small>)}</>;
}
function HomePos({order,onOpen}:{order:OrderJourney;onOpen:()=>void}){
 const lines=sortedCockpitPoLines(order);
 return <div className="cockpit-home-pos">{lines.slice(0,2).map(line=><div key={line.id}><strong title={`${line.po||'PO待补'} / ${line.color} / ${line.orderedQuantity.toLocaleString()}件`} tabIndex={0}>{line.po||'PO待补'} / {line.color} / {line.orderedQuantity.toLocaleString()}件</strong><small>出货 <time>{order.poDeliveryDates?.find(date=>date.lineId===line.id)?.customerWarehouseArrivalDate??'—'}</time></small></div>)}{lines.length>2&&<button type="button" className="journey-text-action" onClick={onOpen}>另 {lines.length-2} 个PO，查看订单</button>}{!lines.length&&<span>—</span>}</div>;
}
export function CockpitHome({data,error,context,onChange}:{data:JourneyResult|null;error:string;context:CockpitContext;onChange:(patch:Partial<CockpitContext>,preserve?:boolean)=>void}){
 const query=cockpitQuery(context),[riskSelection,setRiskSelection]=useState<{id:string;query:string}|null>(null);
 const riskOrder=riskSelection?.query===query?data?.items.find(order=>order.id===riskSelection.id):undefined;
 useEffect(()=>{if(!riskOrder)setRiskSelection(null);},[riskOrder]);
 const enter=(order:OrderJourney,node?:JourneyNode)=>onChange({selected:order.id,...(node?{round:undefined,expanded:node.stage,focus:node.instanceId,row:undefined}:context.stage?{round:undefined,expanded:context.stage,focus:undefined,row:undefined}:{})},true);
 return <section className="dx-production-panel journey-orders cockpit-home" aria-label="订单列表" aria-busy={!data&&!error}>
  <div className="journey-section-title"><h2>订单总览</h2></div>
  <div className="cockpit-home-scroll" role="region" aria-label="订单列表，可横向滚动查看全部列" tabIndex={0}><BusinessTable>
   <colgroup><col style={{width:'7%'}}/><col style={{width:'17%'}}/><col style={{width:'12%'}}/><col style={{width:'19%'}}/><col style={{width:'15%'}}/><col style={{width:'21%'}}/><col style={{width:'9%'}}/></colgroup>
   <thead><tr><th>款图</th><th>订单 / 款名</th><th className="cockpit-home-quantity"><span>客户 / 类型</span><span>下单数量</span></th><th>PO 与日期</th><th>当前任务 / 风险</th><th>{context.scope==='development'?'进度（开发）':'进度（全单）'}</th><th>整单状态</th></tr></thead>
   <tbody>{data?.items.map(order=>{
    const display=order.display,closed=display?.mainState==='completed',node=closed?undefined:representativeCockpitNodes(order,context)[0],risks=cockpitHomeRisks(order,context),delivery=closed||node?undefined:risks.deliveries[0],gap=cockpitReceiptGap(order);
    const scheduleReason=cockpitScheduleReason(order);
    const other=risks.total-(node&&risks.nodes.some(row=>row.instanceId===node.instanceId)?1:0)-(delivery?1:0);
    return <tr key={order.id} data-order-id={order.id}>
     <td><CockpitPhoto src={order.styleImageUrl} label={order.designStyleNo} className="cockpit-home-photo"/></td>
     <td><button type="button" className="journey-order-select" data-cockpit-focus={`home-order:${order.id}`} onClick={()=>enter(order)}>{order.styleName||order.designStyleNo}</button>{order.styleName&&order.styleName!==order.designStyleNo&&<small className="cockpit-home-style" title={order.designStyleNo}>{order.designStyleNo}</small>}<small>{order.orderId?`订单ID：${order.identity?.businessNumber??'—'}`:'尚未下单'}</small><small className="cockpit-home-person" title={order.merchandisers.map(person=>person.name??'姓名未登记').join(' / ')}>跟单：{order.merchandisers.map(person=>person.name??'姓名未登记').join(' / ')||'未指派'}</small></td>
     <td className="cockpit-home-quantity"><div className="cockpit-home-client"><span className="cockpit-home-customer">{order.customer??'—'}</span><span className="cockpit-home-type">{order.orderId?'大货订单':'产品开发'}</span><strong aria-label="下单数量">{order.orderId&&order.lines.length?`${order.lines.reduce((sum,line)=>sum+line.orderedQuantity,0).toLocaleString()}件`:'—'}</strong></div></td>
     <td><HomePos order={order} onOpen={()=>enter(order)}/></td>
     <td>{node?<button type="button" className="cockpit-home-task" onClick={()=>enter(order,node)}><Task node={node} showBlocker={!gap?.gap}/></button>:<span>{closed?'已完成':display?'暂无在办节点':'—'}</span>}
      {delivery&&<div className="cockpit-home-delivery"><span title={`${delivery.poNumber||'PO待补'} / ${delivery.color}`}>{delivery.poNumber||'PO待补'} / {delivery.color}</span><span>{poDeliveryKindLabels[delivery.kind]} <time>{delivery.date}</time></span><StatusBadge tone={delivery.risk==='overdue'?'danger':'warning'}>{delivery.risk==='overdue'?'约定日期已过':'今天到期'}</StatusBadge></div>}
      {risks.total>0&&data&&<button type="button" className="journey-text-action cockpit-home-risk-trigger" aria-label={`查看${order.designStyleNo}的全部${risks.total}项风险`} onClick={()=>setRiskSelection({id:order.id,query})}>{other>0?`${node||delivery?'另':'查看'} ${other} 项风险`:'查看风险'}</button>}
      {gap&&gap.gap>0&&data&&<button type="button" className="cockpit-home-receipt-gap" onClick={()=>setRiskSelection({id:order.id,query})}>{gap.full?'':'可见范围'}欠收 {gap.gap.toLocaleString()}件</button>}
     </td>
     <td><CockpitHomeProgress order={order}/></td><td>{display?<span className={`cockpit-order-state is-${display.mainState}`}>{stateLabels[display.mainState]}</span>:<span>—</span>}{scheduleReason&&<small className={"cockpit-schedule-reason is-"+scheduleReason.tone} title={scheduleReason.text}>{scheduleReason.text}</small>}</td>
    </tr>;
   })}</tbody>
  </BusinessTable></div>
  {!data&&!error&&<p role="status">正在读取订单…</p>}{data?.items.length===0&&!data.freshness&&<p role="status">当前授权和筛选范围没有订单。</p>}
  {(!data?.freshness||data.freshness.detailsOnly)&&<Pagination page={context.page} pageSize={15} total={data?.total??null} onPage={page=>onChange({page})}/>}
  {riskOrder&&<CockpitHomeRisks order={riskOrder} context={context} onClose={()=>setRiskSelection(null)} onNode={node=>{setRiskSelection(null);enter(riskOrder,node);}} onOrder={()=>{setRiskSelection(null);enter(riskOrder);}}/>}
 </section>;
}
