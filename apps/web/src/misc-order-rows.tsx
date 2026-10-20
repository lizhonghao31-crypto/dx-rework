import {BusinessTable,StatusBadge} from "@dx-rework/ui/production";
import {PATTERN_ORDER_STATUS_LABELS,type PatternOrderSummary} from "@dx-rework/contracts/pattern-orders";
import {PatternOrderDelete} from "./pattern-order-delete.js";
import {patternTime} from "./pattern-order-client.js";

export function MiscOrderRows({items,href,canDelete,busy,onDeleted}:{items:PatternOrderSummary[];href:(id:string)=>string;canDelete:boolean;busy:boolean;onDeleted:(id:string)=>void}){
 return <div className="misc-record-table" role="region" tabIndex={0} aria-label="杂事记录，可横向滚动查看完整字段"><BusinessTable><thead><tr><th>任务名称 / 编号</th><th>关联款号</th><th>状态</th><th>申请人</th><th>执行人</th><th>要求完成</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{items.map(order=><tr key={order.orderId}>
  <td className="misc-task-identity"><a href={href(order.orderId)}><strong>{order.taskName}</strong></a><small>{order.orderNo}</small></td>
  <td>{order.styleNo||"不关联订单"}</td><td><StatusBadge tone={order.status==="cancelled"?"danger":order.status==="completed"?"success":"info"}>{PATTERN_ORDER_STATUS_LABELS[order.status]}</StatusBadge></td>
  <td>{order.creatorName}</td><td>{order.currentWorkerName??"待分配"}</td><td className="misc-record-date">{order.requiredDate??"未登记"}</td><td className="misc-record-date">{patternTime(order.submittedAt)}</td>
  <td><div className="misc-record-actions"><a href={href(order.orderId)}>查看</a>{canDelete&&<PatternOrderDelete orderId={order.orderId} version={order.version} label={order.orderNo} disabled={busy} onDeleted={()=>onDeleted(order.orderId)}/>}</div></td>
 </tr>)}</tbody></BusinessTable></div>;
}
