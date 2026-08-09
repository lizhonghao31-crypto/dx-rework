import type { ManagementReworkRow } from "@dx-rework/contracts/reporting";
import { StatusBadge, Surface } from "@dx-rework/ui";

import { reportingPageUrl } from "./reporting-client.js";

const age = (seconds: number): string => {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
};

export function ManagementOrderCard({ order }: { order: ManagementReworkRow }) {
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
  return (
    <a className="reporting-order-link" href={reportingPageUrl(order.deepLink)}>
      <Surface className="reporting-order-card">
        <div className="reporting-order-card__heading">
          <div>
            <strong>{order.reworkNo ?? "返工单"}</strong>
            <small>{order.styleNo ?? "款号未填写"} · {order.orderNo ?? "订单号未填写"}</small>
          </div>
          <StatusBadge tone={tone}>{order.nodeLabel}</StatusBadge>
        </div>
        <dl>
          <div><dt>{terminal ? "流程状态" : "节点停留"}</dt><dd>{order.status === "cancelled" ? "已取消 · 停止计时" : order.status === "completed" ? "已完成 · 停止计时" : age(order.agingSeconds)}</dd></div>
          <div><dt>工资</dt><dd>¥{order.wageAmount}</dd></div>
          <div><dt>责任</dt><dd>¥{order.responsibilityAmount}</dd></div>
          <div><dt>外部差额</dt><dd>¥{order.externalRemainingAmount}</dd></div>
        </dl>
        <small>{activityMessage}</small>
      </Surface>
    </a>
  );
}
