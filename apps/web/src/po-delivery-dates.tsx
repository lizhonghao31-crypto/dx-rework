import { earliestFactoryPo,poDateSummary,type PoDeliveryDate,type PoDeliveryRisk } from "@dx-rework/contracts";
import type {OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import "./po-delivery-dates.css";

export const poDeliveryKindLabels={factory:"加工厂交货日",customer:"客户仓到货日",sample:"船样目标日"};
export function PoDateSummary({lines,legacy}:{lines:readonly PoDeliveryDate[]|undefined;legacy?:string|null}) {
  if(lines===undefined)return <span>加工厂交货日：{legacy||"未登记"}</span>;
  return <span className="po-date-summary"><span>客户仓到货日：{poDateSummary(lines.map(line=>line.customerWarehouseArrivalDate))}</span><span>加工厂交货日：{poDateSummary(lines.map(line=>line.factoryDeliveryDate))}</span></span>;
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
  return <details className="po-date-details"><summary>逐 PO 双交期与船样目标（{lines.length}）</summary><PoDeadline lines={lines} finished={finished}/><div className="po-date-scroll" tabIndex={0} aria-label="逐 PO 交期明细"><table><thead><tr><th>PO / 颜色</th><th>客户仓到货日</th><th>加工厂交货日</th><th>船样目标日</th></tr></thead><tbody>{lines.map(line=><tr key={line.lineId} id={`po-date-${line.lineId}`}><td>{line.poNumber||"待补 PO"} / {line.color}</td><td>{line.customerWarehouseArrivalDate||"未登记"}</td><td>{line.factoryDeliveryDate||"未登记"}</td><td>{line.sampleTargetDate||"客户日期待补"}</td></tr>)}</tbody></table></div></details>;
}

export function PoOrderFacts({order}:{order:OrderJourney}) {
  if(!order.orderId)return null;
  return <div className="po-date-scroll" tabIndex={0} aria-label="实际下单与逐PO交期"><table><thead><tr><th>PO / 款号</th><th>颜色</th><th>下单数量</th><th>客户仓到货日</th><th>加工厂交货日</th></tr></thead><tbody>{order.lines.map(line=>{const dates=order.poDeliveryDates?.find(item=>item.lineId===line.id);return <tr key={line.id} id={`po-date-${line.id}`}><td>{line.po||"待补PO"} / {line.formalStyleNo||line.temporaryStyleNo||order.designStyleNo}</td><td>{line.color}</td><td>{line.orderedQuantity.toLocaleString()}</td><td>{dates?.customerWarehouseArrivalDate||"未登记"}</td><td>{dates?.factoryDeliveryDate||"未登记"}</td></tr>;})}</tbody></table></div>;
}
