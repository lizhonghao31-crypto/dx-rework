import { StatusBadge, Surface } from "@dx-rework/ui";
import { PATTERN_ORDER_STATUS_LABELS, type PatternOrderSummary } from "@dx-rework/contracts/pattern-orders";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { PatternOrderDelete } from "./pattern-order-delete.js";
import { patternTime } from "./pattern-order-client.js";

// Keep the live ManagementOrderCard DOM and CSS contract. Only business fields differ.
// App already loads the rework styles; do not change their global cascade order here.
export function PatternOrderCard({ order, href, canDelete, busy, onDeleted, compact=false }: {
  compact?:boolean; order: PatternOrderSummary; href: string; canDelete: boolean; busy: boolean; onDeleted(): void;
}) {
  const tone = order.status === "cancelled" ? "danger" : order.status === "completed" ? "success" : "info";
  if(compact)return <article className="pattern-compact-record"><a href={href}><strong>{order.kind==='misc'?order.taskName:order.styleNo}</strong><small>{order.orderNo}</small><span>关联款号：{order.kind==='misc'?order.styleNo||'不关联订单':'历史独立打板'}</span><StatusBadge tone={tone}>{PATTERN_ORDER_STATUS_LABELS[order.status]}</StatusBadge><span>申请人：{order.creatorName}</span><span>执行人：{order.currentWorkerName??'待分配'}</span><span>要求完成：{order.requiredDate??'未登记'}</span><span className="pattern-task-action">查看</span></a>{canDelete&&<PatternOrderDelete orderId={order.orderId} version={order.version} label={order.orderNo} disabled={busy} onDeleted={onDeleted}/>}</article>;
  return <Surface className="reporting-order-card">
    <a className="reporting-order-card__main" href={href}>
      <div className="reporting-order-card__heading">
        <div><strong>{order.kind === "misc" ? order.taskName : order.styleNo}</strong><small>{order.orderNo}</small></div>
        <StatusBadge tone={tone}>{PATTERN_ORDER_STATUS_LABELS[order.status]}</StatusBadge>
      </div>
      <dl>
        <div><dt>类型</dt><dd>{order.kind === "misc" ? "杂事" : "打板"}</dd></div>
        <div><dt>创建人</dt><dd>{order.creatorName}</dd></div>
        <div><dt>当前师傅</dt><dd>{order.currentWorkerName ?? (order.status === "pending_assignment" ? "待分配" : "—")}</dd></div>
        <div><dt>要求完成</dt><dd>{order.requiredDate ?? "—"}</dd></div>
        <div><dt>返工</dt><dd>{formatBusinessDecimal(order.reworkCount)} 次</dd></div>
      </dl>
      <small className="reporting-order-card__activity">提交时间<br />{patternTime(order.submittedAt)}</small>
    </a>
    {canDelete && <PatternOrderDelete orderId={order.orderId} version={order.version} label={order.orderNo} disabled={busy} onDeleted={onDeleted} />}
  </Surface>;
}
