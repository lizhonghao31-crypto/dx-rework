import { StatusBadge, Surface } from "@dx-rework/ui";
import { PATTERN_ORDER_STATUS_LABELS, type PatternOrderSummary } from "@dx-rework/contracts/pattern-orders";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { PatternOrderDelete } from "./pattern-order-delete.js";
import { patternTime } from "./pattern-order-client.js";

// Keep the live ManagementOrderCard DOM and CSS contract. Only business fields differ.
// App already loads the rework styles; do not change their global cascade order here.
export function PatternOrderCard({ order, href, canDelete, busy, onDeleted }: {
  order: PatternOrderSummary; href: string; canDelete: boolean; busy: boolean; onDeleted(): void;
}) {
  const tone = order.status === "cancelled" ? "danger" : order.status === "completed" ? "success" : "info";
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
