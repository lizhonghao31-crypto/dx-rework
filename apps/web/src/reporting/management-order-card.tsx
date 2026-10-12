import type { ManagementReworkRow } from "@dx-rework/contracts/reporting";
import { StatusBadge, Surface } from "@dx-rework/ui";

import { fixedBusinessCurrency as currency } from "../fixed-business-currency.js";
import { reportingPageUrl } from "./reporting-client.js";

const age = (seconds: number): string => {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
};

const deductionStatusLabel: Record<ManagementReworkRow["deductionStatus"], string> = {
  not_started: "未开始",
  not_deducted: "未扣款",
  completed: "扣款完成",
};

export function ManagementOrderCard({
  order,
  canDelete = false,
  deleting = false,
  onDelete,
  statusBesideStyle = false,
}: {
  order: ManagementReworkRow;
  canDelete?: boolean;
  deleting?: boolean;
  onDelete?: (order: ManagementReworkRow) => void;
  statusBesideStyle?: boolean;
}) {
  const tone = order.status === "cancelled"
    ? "danger"
    : order.status === "completed"
      ? "success"
      : order.exceptionCount > 0
        ? "danger"
        : order.overdue
          ? "warning"
          : "info";
  const terminal = order.status === "completed" || order.status === "cancelled";
  const activityMessage = order.status === "cancelled"
    ? "已退出在途、逾期和当前异常统计"
    : order.exceptionCount > 0
      ? `${order.exceptionCount} 项当前异常`
      : order.overdue
        ? "存在逾期事项"
        : "无当前异常";
  return <Surface className="reporting-order-card">
    <a
      className={`reporting-order-card__main${order.status === "completed" ? " is-completed" : ""}`}
      href={reportingPageUrl(order.deepLink)}
    >
        <div className="reporting-order-card__heading">
          <div>
            {statusBesideStyle ? <div className="reporting-order-card__title-line"><strong>{order.styleNo ?? "款号未填写"}</strong><StatusBadge tone={tone}>{order.nodeLabel}</StatusBadge></div> : <strong>{order.styleNo ?? "款号未填写"}</strong>}
            <small>{order.reworkNo ?? "返工单"} · {order.reworkKind === "inhouse_finishing" ? "本厂做尾" : "QC返工"}</small>
          </div>
          {!statusBesideStyle && <StatusBadge tone={tone}>{order.nodeLabel}</StatusBadge>}
        </div>
        <dl>
          <div className="rework-card-fact rework-card-fact--state"><dt>{terminal ? "流程状态" : "节点停留"}</dt><dd>{order.status === "cancelled" ? "已取消 · 停止计时" : order.status === "completed" ? "已完成 · 停止计时" : age(order.agingSeconds)}</dd></div>
          {order.wageAmount !== undefined ? <div className="rework-card-fact rework-card-fact--wage"><dt>工资</dt><dd>{currency(order.wageAmount)}</dd></div> : null}
          {order.reworkKind !== "inhouse_finishing" ? <div className="rework-card-fact rework-card-fact--responsibility"><dt>责任</dt><dd>{currency(order.responsibilityAmount)}</dd></div> : null}
          {order.reworkKind !== "inhouse_finishing" ? <div className="rework-card-fact rework-card-fact--external"><dt>外部差额</dt><dd>{currency(order.externalRemainingAmount)}</dd></div> : null}
          {order.reworkKind !== "inhouse_finishing" ? <div className="rework-card-fact rework-card-fact--deduction"><dt>扣款状态</dt><dd>{deductionStatusLabel[order.deductionStatus]}</dd></div> : null}
        </dl>
        {order.status === "completed" ? null : <small className="reporting-order-card__activity">{activityMessage}</small>}
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
