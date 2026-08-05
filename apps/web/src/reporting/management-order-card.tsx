import type { ManagementReworkRow } from "@dx-rework/contracts/reporting";
import { StatusBadge, Surface } from "@dx-rework/ui";

import { reportingPageUrl } from "./reporting-client.js";

const age = (seconds: number): string => {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
};

export function ManagementOrderCard({ order }: { order: ManagementReworkRow }) {
  const tone = order.exceptionCount > 0 ? "danger" : order.overdue ? "warning" : order.status === "completed" ? "success" : "info";
  return (
    <a className="reporting-order-link" href={reportingPageUrl(order.deepLink)}>
      <Surface className="reporting-order-card">
        <div className="reporting-order-card__heading">
          <div>
            <strong>{order.reworkNo ?? order.reworkOrderId}</strong>
            <small>{order.styleNo ?? "款号未填写"} · {order.orderNo ?? "订单号未填写"}</small>
          </div>
          <StatusBadge tone={tone}>{order.nodeLabel}</StatusBadge>
        </div>
        <dl>
          <div><dt>节点停留</dt><dd>{age(order.agingSeconds)}</dd></div>
          <div><dt>工资</dt><dd>¥{order.wageAmount}</dd></div>
          <div><dt>责任</dt><dd>¥{order.responsibilityAmount}</dd></div>
          <div><dt>外部差额</dt><dd>¥{order.externalRemainingAmount}</dd></div>
        </dl>
        <small>{order.exceptionCount > 0 ? `${order.exceptionCount} 项异常` : order.overdue ? "存在逾期事项" : "无当前异常"}</small>
      </Surface>
    </a>
  );
}
