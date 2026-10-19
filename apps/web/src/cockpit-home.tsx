import type {JourneyNode,JourneyResult,OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {StatusBadge} from "@dx-rework/ui";
import {BusinessTable,Pagination} from "@dx-rework/ui/production";
import {CockpitPhoto} from "./cockpit-photo-preview.js";
import {representativeCockpitNodes,type CockpitContext} from "./digital-journey-cockpit-model.js";
import "./cockpit-home.css";

const stateLabels={completed:"整单已完成",overdue:"逾期",due_soon:"临期",active:"进行中",not_started:"未启动",cancelled:"已取消"};
function ActualProgress({order}:{order:OrderJourney}){
  const actual=order.display?.actualRatio;
  return <div className="cockpit-double-progress" aria-label="全单进度">
    <div title="时间规则待完善"><span>时间</span><i className="is-empty"/><small>待完善</small></div>
    <div title={order.display?.actualLabel??"进度资料暂不可用"}><span>实际</span><i>{actual!==null&&actual!==undefined&&<b style={{width:`${Math.max(0,Math.min(1,actual))*100}%`}}/>}</i><small>{actual===null||actual===undefined?"—":order.display!.actualLabel}</small></div>
    {order.display?.awaitingClosure&&<small>节点已完成，待业务收口</small>}
  </div>;
}
function Task({node}:{node:JourneyNode}){
  const status=node.risks.includes("overdue")?"局部逾期":node.risks.includes("due_soon")?"即将到期":node.state==="blocked"?"受阻":node.state==="active"?"进行中":"等待前置";
  return <><strong>{node.label}{node.owner?.name?` · ${node.owner.name}`:""}</strong><StatusBadge tone={node.risks.includes("overdue")?"danger":node.risks.includes("due_soon")?"warning":node.state==="active"?"info":"neutral"}>{status}</StatusBadge></>;
}
export function CockpitHome({data,error,context,onChange}:{data:JourneyResult|null;error:string;context:CockpitContext;onChange:(patch:Partial<CockpitContext>,preserve?:boolean)=>void}){
  const enter=(order:OrderJourney,node?:JourneyNode)=>onChange({selected:order.id,round:undefined,expanded:node?.stage,focus:node?.instanceId,row:undefined},true);
  return <section className="dx-production-panel journey-orders cockpit-home" aria-label="订单列表" aria-busy={!data&&!error}>
    <div className="journey-section-title"><h2>订单总览</h2><span>{data?`共 ${data.total} 个订单`:"正在读取…"}</span>{data&&<span>统计基准：{new Date(data.asOf).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}</span>}<span>时间规则待完善</span></div>
    {data?.scopeCounts&&data.scopeCounts.cancelled>0&&<p className="journey-muted">已取消 {data.scopeCounts.cancelled} 单，不计入有效生产订单统计。</p>}
    <div className="cockpit-home-scroll" role="region" aria-label="订单列表，可横向滚动查看全部列" tabIndex={0}><BusinessTable>
      <thead><tr><th>款图</th><th>款号 / 订单号</th><th>客户 / 类型</th><th>PO 与日期</th><th>当前任务 / 风险</th><th>进度（全单）</th><th>整单状态</th></tr></thead>
      <tbody>{data?.items.map(order=>{
        const working=representativeCockpitNodes(order),node=working[0],display=order.display,earliest=display?.earliestShipmentDate;
        const pos=(order.poDeliveryDates??[]).filter(line=>line.customerWarehouseArrivalDate===earliest);
        const po=pos[0]??order.poDeliveryDates?.[0];
        return <tr key={order.id}>
          <td><CockpitPhoto src={order.styleImageUrl} label={order.designStyleNo} className="cockpit-home-photo"/></td>
          <td><button type="button" className="journey-order-select" onClick={()=>enter(order)}>{order.designStyleNo}</button>{(order.orderNumbers.length>0||order.styleName)&&<small className="cockpit-home-identity-extra" tabIndex={0} title={[...order.orderNumbers,order.styleName].filter(Boolean).join(" · ")}>{[...order.orderNumbers,order.styleName].filter(Boolean).join(" · ")}</small>}<small>跟单：{order.merchandisers.map(person=>person.name??"姓名未登记").join(" / ")||"未指派"}</small></td>
          <td>{order.customer??"客户未登记"}<small>{order.orderId?"大货订单":"产品开发"}</small><small>订购量：{order.orderId?order.lines.length?order.lines.reduce((sum,line)=>sum+line.orderedQuantity,0).toLocaleString():"无可见数量":"未下单"}</small></td>
          <td><strong>{po?.poNumber??"PO 待补"}{order.lines.length>1?`，另 ${order.lines.length-1} 个 PO`:""}</strong><small>出货日期：<span>{earliest??"未登记"}</span></small><small>加工厂交货日：<span>{po?.factoryDeliveryDate??"尚未生效"}</span></small>{display?.missingShipmentDates? <small>有 {display.missingShipmentDates} 个 PO 出货日期待补</small>:null}</td>
          <td>{node?<button type="button" className="cockpit-home-task" onClick={()=>enter(order,node)}><Task node={node}/>{working.length>1&&<small>另 {working.length-1} 项 · 查看全部</small>}</button>:<span>{display?.mainState==="completed"?"已完成":display?"尚无可见在办节点":"暂无法读取节点"}</span>}</td>
          <td><ActualProgress order={order}/></td><td>{display?<span className={`cockpit-order-state is-${display.mainState}`}>{stateLabels[display.mainState]}</span>:<span>暂无法读取订单状态</span>}</td>
        </tr>;
      })}</tbody>
    </BusinessTable></div>
    {!data&&!error&&<p role="status">正在读取订单…</p>}{data?.items.length===0&&<p role="status">当前授权和筛选范围没有订单。</p>}
    <Pagination page={context.page} pageSize={15} total={data?.total??null} onPage={page=>onChange({page})}/>
  </section>;
}
