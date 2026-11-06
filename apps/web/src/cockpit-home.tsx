import {forecastBasisLabels} from './cockpit-business-dates.js';
import {nodeTargetLabel,slaTargetLabel} from "./journey-sla-details.js";
import {type JourneyNode,type JourneyResult,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {StatusBadge} from "@dx-rework/ui";
import {BusinessTable,Pagination} from "@dx-rework/ui/production";
import {CockpitPhoto} from "./cockpit-photo-preview.js";
import {matchingPoDeliveryRisks,representativeCockpitNodes,type CockpitContext} from "./digital-journey-cockpit-model.js";
import {poDeliveryKindLabels,PoOrderSummary} from "./po-delivery-dates.js";
import type {PoDeliveryRisk} from "@dx-rework/contracts";
import "./cockpit-home.css";
import {CockpitBusinessProgress} from './cockpit-business-progress.js';
import {cockpitVisibleBlockers} from './cockpit-node-rows.js';

const stateLabels={completed:"整单已完成",overdue:"逾期",due_soon:"临期",active:"进行中",not_started:"未启动",cancelled:"已取消"};
function ActualProgress({order}:{order:OrderJourney}){
  if(order.businessProgress)return <CockpitBusinessProgress order={order} compact/>;
  const actual=order.display?.actualRatio;
  return <div className="cockpit-double-progress" aria-label={order.orderId?"全单进度":"开发进度"}>
    <div title={order.display?.actualLabel??"进度资料暂不可用"}><span>实际</span><i>{actual!==null&&actual!==undefined&&<b style={{width:`${Math.max(0,Math.min(1,actual))*100}%`}}/>}</i><small>{actual===undefined?"—":actual===null?"待核":order.display!.actualLabel}</small></div>
    {order.display?.awaitingClosure&&<small>节点已完成，待业务收口</small>}
  </div>;
}
function Task({node}:{node:JourneyNode}){
  const status=node.risks.includes("overdue")?"局部逾期":node.risks.includes("due_soon")?"即将到期":node.state==="blocked"?"受阻":node.state==="active"?"进行中":"等待前置";
  const blockers=cockpitVisibleBlockers(node).map(blocker=>blocker.label).join("；");
  const forecast=node.timing?`预计：${node.timing.forecast.at?slaTargetLabel(node.timing.forecast):node.timing.forecast.reasons[0]??'预计依据尚未齐全'} · ${forecastBasisLabels[node.timing.forecastBasis]}`:null;
  return <><span className="cockpit-home-task-heading"><strong>{node.label}{node.owner?.name?` · ${node.owner.name}`:""}</strong><StatusBadge tone={node.risks.includes("overdue")?"danger":node.risks.includes("due_soon")?"warning":node.state==="active"?"info":"neutral"}>{status}</StatusBadge></span>{node.expectedAt&&<small>原截止：{nodeTargetLabel(node)}</small>}{forecast&&<small className="cockpit-home-forecast" title={forecast}>{forecast}</small>}{blockers&&<small className="cockpit-home-blocker" title={blockers}>{blockers}</small>}</>;
}
function DeliveryRisk({risk}:{risk:PoDeliveryRisk}){const identity=`${risk.poNumber||'待补PO'} / ${risk.color}`;return <span className="cockpit-home-delivery-line"><span className="cockpit-home-risk-po" title={identity} tabIndex={0}>{identity}</span><span>{poDeliveryKindLabels[risk.kind]} <time>{risk.date}</time> · <StatusBadge tone={risk.risk==="overdue"?"danger":"warning"}>{risk.risk==="overdue"?"约定日期已过":"今天到期"}</StatusBadge></span></span>;}
export function CockpitHome({data,error,context,onChange}:{data:JourneyResult|null;error:string;context:CockpitContext;onChange:(patch:Partial<CockpitContext>,preserve?:boolean)=>void}){
  const enter=(order:OrderJourney,node?:JourneyNode)=>onChange({selected:order.id,...(node?{round:undefined,expanded:node.stage,focus:node.instanceId,row:undefined}:context.stage?{round:undefined,expanded:context.stage,focus:undefined,row:undefined}:{})},true);
  return <section className="dx-production-panel journey-orders cockpit-home" aria-label="订单列表" aria-busy={!data&&!error}>
    <div className="journey-section-title"><h2>订单总览</h2><span>{data?`共 ${data.total} 个订单`:"正在读取…"}</span>{data&&<span>统计基准：{new Date(data.asOf).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}</span>}</div>
    {data?.scopeCounts&&data.scopeCounts.cancelled>0&&<p className="journey-muted">已取消 {data.scopeCounts.cancelled} 单，不计入有效生产订单统计。</p>}
    <div className="cockpit-home-scroll" role="region" aria-label="订单列表，可横向滚动查看全部列" tabIndex={0}><BusinessTable>
      <colgroup><col style={{width:74}}/><col/><col/><col style={{width:'24%'}}/><col/><col/><col style={{width:100}}/></colgroup>
      <thead><tr><th>款图</th><th>款号 / 订单号</th><th>客户 / 类型</th><th>PO 与日期</th><th>当前任务 / 风险</th><th>{context.scope==="development"?"进度（开发）":"进度（全单）"}</th><th>整单状态</th></tr></thead>
      <tbody>{data?.items.map(order=>{
        const working=representativeCockpitNodes(order,context),node=working[0],display=order.display;
        const deliveryRisks=matchingPoDeliveryRisks(order,{...context,stage:undefined,node:undefined,state:undefined,kpi:"all"}).sort((a,b)=>(a.risk==="overdue"?0:1)-(b.risk==="overdue"?0:1)||a.date.localeCompare(b.date)||a.lineId.localeCompare(b.lineId)||a.kind.localeCompare(b.kind));
        return <tr key={order.id}>
          <td><CockpitPhoto src={order.styleImageUrl} label={order.designStyleNo} className="cockpit-home-photo"/></td>
          <td><button type="button" className="journey-order-select" onClick={()=>enter(order)}>{order.identity?.businessNumber??order.designStyleNo}</button>{!order.identity&&(order.orderNumbers.length>0||order.styleName)&&<small className="cockpit-home-identity-extra" tabIndex={0} title={[...order.orderNumbers,order.styleName].filter(Boolean).join(" · ")}>{[...order.orderNumbers,order.styleName].filter(Boolean).join(" · ")}</small>}<small>跟单：{order.merchandisers.map(person=>person.name??"姓名未登记").join(" / ")||"未指派"}</small></td>
          <td>{order.customer??"客户未登记"}<small>{order.orderId?"大货订单":"产品开发"}</small><small>订购量：{order.orderId?order.lines.length?order.lines.reduce((sum,line)=>sum+line.orderedQuantity,0).toLocaleString():"无可见数量":"未下单"}</small></td>
          <td><PoOrderSummary order={order} compact/></td>
          <td>{display?.mainState==="completed"&&node&&<small className="cockpit-closed-node-context">整单已收口 · 保留的原节点状态</small>}{node?<button type="button" className="cockpit-home-task" onClick={()=>enter(order,node)}><Task node={node}/>{working.length>1&&<small>另 {working.length-1} 项 · 查看全部</small>}</button>:<span>{display?.mainState==="completed"?"已完成":display?"尚无可见在办节点":"暂无法读取节点"}</span>}{deliveryRisks.length>0&&<div className="cockpit-home-delivery"><DeliveryRisk risk={deliveryRisks[0]!}/>{deliveryRisks.length>1&&<details><summary>另 {deliveryRisks.length-1} 项交期风险</summary>{deliveryRisks.slice(1).map(risk=><DeliveryRisk key={`${risk.lineId}:${risk.kind}`} risk={risk}/>)}</details>}</div>}</td>
          <td><ActualProgress order={order}/></td><td>{display?<span className={`cockpit-order-state is-${display.mainState}`}>{stateLabels[display.mainState]}</span>:<span>暂无法读取订单状态</span>}</td>
        </tr>;
      })}</tbody>
    </BusinessTable></div>
    {!data&&!error&&<p role="status">正在读取订单…</p>}{data?.items.length===0&&<p role="status">当前授权和筛选范围没有订单。</p>}
    <Pagination page={context.page} pageSize={15} total={data?.total??null} onPage={page=>onChange({page})}/>
  </section>;
}
