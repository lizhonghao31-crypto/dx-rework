import {cockpitScopeProgress,CockpitScopeForecast} from './cockpit-fixed-schedule.js';
import { customerPoDateLabel } from "./digital-workspace-copy.js";
import { earliestFactoryPo,poDateSummary,type PoDeliveryDate,type PoDeliveryRisk } from "@dx-rework/contracts";
import type {OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {digitalPoKey} from '@dx-rework/contracts/digital-production';
import "./po-delivery-dates.css";

export const poDeliveryKindLabels={factory:"加工厂交货日",customer:customerPoDateLabel,sample:"船样目标日"};
const poNaturalOrder=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
export function sortedCockpitPoLines(order:OrderJourney){
 const dates=new Map(order.poDeliveryDates?.map(line=>[line.lineId,line.customerWarehouseArrivalDate]));
 return [...order.lines].sort((a,b)=>(dates.get(a.id)||'\uffff').localeCompare(dates.get(b.id)||'\uffff')||poNaturalOrder.compare(a.po??'',b.po??'')||a.id.localeCompare(b.id));
}
/** Two independent date summaries; a customer-first PO never supplies a made-up factory pairing. */
export function PoOrderSummary({order,compact=false}:{order:OrderJourney;compact?:boolean}){
 const lines=sortedCockpitPoLines(order),dates=(order.poDeliveryDates??[]).filter(date=>lines.some(line=>line.id===date.lineId));
 const earliest=(kind:'customerWarehouseArrivalDate'|'factoryDeliveryDate',withPo=true)=>{
  const at=dates.map(date=>date[kind]).filter((value):value is string=>Boolean(value)).sort()[0];
  return at?at+(withPo?` · ${dates.filter(date=>date[kind]===at).map(date=>date.poNumber||'PO待补').join('、')}`:''):null;
 };
 const row=(line:OrderJourney['lines'][number])=><div key={line.id}><strong tabIndex={compact?0:undefined} title={compact?`${line.po||'PO待补'} · ${line.color}`:undefined}>{line.po||'PO待补'} · {line.color}</strong><small>{line.orderedQuantity.toLocaleString()}件 · {compact?'出货':customerPoDateLabel} {dates.find(date=>date.lineId===line.id)?.customerWarehouseArrivalDate??'未登记'}</small></div>;
 return <div className={'cockpit-po-summary'+(compact?' is-compact':'')}>{lines.slice(0,2).map(row)}{lines.length>2&&(compact?<small>另{lines.length-2}个PO，进入订单查看</small>:<details data-cockpit-disclosure="po-extra"><summary>查看其余{lines.length-2}个PO</summary>{lines.slice(2).map(row)}</details>)}{!lines.length&&<strong>PO关联待核</strong>}
  {!compact&&<small>最早{customerPoDateLabel}：{earliest('customerWarehouseArrivalDate')??(order.display?.earliestShipmentDate?`${order.display.earliestShipmentDate}（原整单摘要，PO关联待核）`:'未登记')}</small>}<small>最早加工厂交货日：{earliest('factoryDeliveryDate',!compact)??'未登记'}</small>
  {compact&&!earliest('customerWarehouseArrivalDate')&&order.display?.earliestShipmentDate&&<small>{customerPoDateLabel}：{order.display.earliestShipmentDate}（原整单摘要）</small>}
  {lines.some(line=>!dates.find(date=>date.lineId===line.id)?.customerWarehouseArrivalDate)&&<small>另有{lines.filter(line=>!dates.find(date=>date.lineId===line.id)?.customerWarehouseArrivalDate).length}个PO出货日期待补</small>}
 </div>;
}
export function PoDateSummary({lines,legacy}:{lines:readonly PoDeliveryDate[]|undefined;legacy?:string|null}) {
  if(lines===undefined)return <span>加工厂交货日：{legacy||"未登记"}</span>;
  return <span className="po-date-summary"><span>{customerPoDateLabel}：{poDateSummary(lines.map(line=>line.customerWarehouseArrivalDate))}</span><span>加工厂交货日：{poDateSummary(lines.map(line=>line.factoryDeliveryDate))}</span></span>;
}
export function PoDeadline({lines,finished=false}:{lines:readonly PoDeliveryDate[]|undefined;finished?:boolean}) {
  const earliest=!finished&&lines?earliestFactoryPo(lines):null;
  return earliest?<small className="po-deadline">最早 PO 交期：{earliest.lines.map(line=>`${line.poNumber||"待补 PO"} / ${line.color}`).join("、")} · 加工厂交货日 {earliest.date}</small>:null;
}
export function PoDateRisks({risks}:{risks:readonly PoDeliveryRisk[]|undefined}) {
  return <>{risks?.map(risk=><span className="po-date-risk" key={`${risk.lineId}:${risk.kind}`}>{risk.poNumber||"待补 PO"} / {risk.color} · {poDeliveryKindLabels[risk.kind]} {risk.date} · {risk.risk==='overdue'?"约定日期已过":"今天到期"}</span>)}</>;
}
export function PoDateDetails({lines,finished=false}:{lines:readonly PoDeliveryDate[]|undefined;finished?:boolean}) {
  if(!lines?.length)return null;
  return <details className="po-date-details"><summary>逐 PO 双交期与船样目标（{lines.length}）</summary><PoDeadline lines={lines} finished={finished}/><div className="po-date-scroll" tabIndex={0} aria-label="逐 PO 交期明细"><table><thead><tr><th>PO / 颜色</th><th>{customerPoDateLabel}</th><th>加工厂交货日</th><th>船样目标日</th></tr></thead><tbody>{lines.map(line=><tr key={line.lineId} id={`po-date-${line.lineId}`}><td>{line.poNumber||"待补 PO"} / {line.color}</td><td>{line.customerWarehouseArrivalDate||"未登记"}</td><td>{line.factoryDeliveryDate||"未登记"}</td><td>{line.sampleTargetDate||"客户日期待补"}</td></tr>)}</tbody></table></div></details>;
}

export function PoOrderFacts({order}:{order:OrderJourney}) {
  if(!order.orderId)return null;
  return <div className="po-date-scroll journey-po-order-facts" tabIndex={0} aria-label="实际下单与逐PO交期"><table><thead><tr><th>PO / 款号</th><th>颜色</th><th>下单数量</th><th>{customerPoDateLabel}</th><th>加工厂交货日</th>{order.fixedSchedule&&<th>进度余量</th>}</tr></thead><tbody>{sortedCockpitPoLines(order).map(line=>{const dates=order.poDeliveryDates?.find(item=>item.lineId===line.id),po=line.po||'待补PO',style=line.formalStyleNo||line.temporaryStyleNo||order.designStyleNo;return <tr key={line.id} id={`po-date-${line.id}`}><td data-label="PO / 款号">{po}{digitalPoKey(po)!==digitalPoKey(style)&&` / ${style}`}</td><td data-label="颜色">{line.color}</td><td data-label="下单数量">{line.orderedQuantity.toLocaleString()}</td><td data-label={customerPoDateLabel}>{dates?.customerWarehouseArrivalDate||"未登记"}</td><td data-label="加工厂交货日">{dates?.factoryDeliveryDate||"未登记"}</td>{order.fixedSchedule&&<td data-label="进度余量" title={"数据时点："+order.fixedSchedule.asOf}>{(()=>{const value=cockpitScopeProgress(order.fixedSchedule?.scopes.find(scope=>scope.lineId===line.id));return <><span className={"cockpit-target-difference is-"+value.tone}>{value.text}</span><CockpitScopeForecast scope={order.fixedSchedule?.scopes.find(scope=>scope.lineId===line.id)}/></>;})()}</td>}</tr>;})}</tbody></table></div>;
}
