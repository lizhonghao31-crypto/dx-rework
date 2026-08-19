import type { ManagementReworkRow } from "@dx-rework/contracts/reporting";
import { StatusBadge, Surface } from "@dx-rework/ui";

import { reportingPageUrl } from "./reporting-client.js";

const age = (seconds: number): string => {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
};

export function ManagementOrderCard({
  order,
  canDelete = false,
  deleting = false,
  onDelete,
}: {
  order: ManagementReworkRow;
  canDelete?: boolean;
  deleting?: boolean;
  onDelete?: (order: ManagementReworkRow) => void;
}) {
  const tone = order.status === "cancelled"
    ? "danger"
    : order.exceptionCount > 0
      ? "danger"
      : order.overdue
        ? "warning"
        : order.status === "completed"
          ? "success"
          : "info";
  const terminal = order.status === "completed" || order.status === "cancelled";
  const activityMessage = order.status === "cancelled"
    ? "已退出在途、逾期和当前异常统计"
    : order.exceptionCount > 0
      ? `${order.status === "completed" ? "生产返工已结束 · " : ""}${order.exceptionCount} 项后续异常`
      : order.overdue
        ? `${order.status === "completed" ? "生产返工已结束 · " : ""}存在逾期后续事项`
        : order.status === "completed"
          ? "生产返工流程已结束；独立的外部扣款后续仍按实际状态统计"
          : "无当前异常";
  return <Surface className="reporting-order-card">
    <a className="reporting-order-card__main" href={reportingPageUrl(order.deepLink)}>
        <div className="reporting-order-card__heading">
          <div>
            <strong>{order.styleNo ?? "款号未填写"}</strong>
            <small>{order.reworkNo ?? "返工单"}</small>
          </div>
          <StatusBadge tone={tone}>{order.nodeLabel}</StatusBadge>
        </div>
        <dl>
          <div><dt>{terminal ? "流程状态" : "节点停留"}</dt><dd>{order.status === "cancelled" ? "已取消 · 停止计时" : order.status === "completed" ? "已完成 · 停止计时" : age(order.agingSeconds)}</dd></div>
          <div><dt>工资</dt><dd>¥{order.wageAmount}</dd></div>
          <div><dt>责任</dt><dd>¥{order.responsibilityAmount}</dd></div>
          <div><dt>外部差额</dt><dd>¥{order.externalRemainingAmount}</dd></div>
          <div><dt>附件</dt><dd>{order.attachmentCount > 0 ? `${order.attachmentCount} 份 · 点击订单查阅` : "无附件"}</dd></div>
        </dl>
        <small className="reporting-order-card__activity">{activityMessage}</small>
    </a>
    {canDelete && onDelete ? <button
      type="button"
      className="reporting-order-delete"
      aria-label={`删除返工单 ${order.reworkNo ?? order.styleNo ?? "此订单"}`}
      title="删除返工单"
      disabled={deleting}
      onClick={() => onDelete(order)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-9 0 1 13h10l1-13" /></svg>
    </button> : null}
  </Surface>;
}
