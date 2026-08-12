import type { ManagementReworkPage, ManagementReworkRow } from "@dx-rework/contracts/reporting";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { Header, Shell } from "../components.js";
import { loadReworkOrders, reportingPageUrl } from "./reporting-client.js";
import "./reporting.css";

type WorkflowStatus = Extract<
  ManagementReworkRow["status"],
  | "pending_process_configuration"
  | "pending_ie_review"
  | "pending_task_assignment"
  | "in_progress"
  | "pending_order_review"
  | "pending_quantity_adjustment_ie_review"
>;

type QueueMeta = Readonly<{
  node: string;
  label: string;
  owner: string;
  action: string;
  next: string;
}>;

const queueMeta: Record<WorkflowStatus, QueueMeta> = {
  pending_process_configuration: {
    node: "N02",
    label: "待配置工序",
    owner: "尾部主管",
    action: "配置返工工序、计划数量、计价单位和单价",
    next: "提交后流转到 N03 · 待 IE 审核",
  },
  pending_ie_review: {
    node: "N03",
    label: "待 IE 审核",
    owner: "IE",
    action: "审核工序、计划数量、单位和单价",
    next: "通过后流转到 N04 · 待分配人员；驳回则退回 N02",
  },
  pending_task_assignment: {
    node: "N04",
    label: "待分配人员",
    owner: "尾部主管",
    action: "把已生效工序分配给实际返工人员",
    next: "首个任务建立后流转到 N05 · 返工执行中",
  },
  in_progress: {
    node: "N05",
    label: "返工执行中",
    owner: "工人 / 已授权代录人",
    action: "按实际完成进度登记本次完成数量",
    next: "全部工序完成后自动流转到 N06 · 待整单审核",
  },
  pending_order_review: {
    node: "N06",
    label: "待整单审核",
    owner: "尾部主管",
    action: "核对全部有效完成记录，确认本单返工已全部完成",
    next: "确认后流转到 N07 · 待责任判定",
  },
  pending_quantity_adjustment_ie_review: {
    node: "N06-A",
    label: "数量调整待复核",
    owner: "订单跟单 / IE",
    action: "处理异常数量调整，不影响正常完成登记主流程",
    next: "通过后回到返工执行补齐；拒绝则保留原计划",
  },
};

const actionHref = (order: ManagementReworkRow): string => {
  if (order.status === "pending_process_configuration" || order.status === "pending_ie_review") {
    return `/ui/process-configuration?rework=${order.reworkOrderId}`;
  }
  return `/ui/work-reporting?rework=${order.reworkOrderId}`;
};

const age = (seconds: number): string => {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; pages: Partial<Record<WorkflowStatus, ManagementReworkPage>>; available: WorkflowStatus[] }
  | { kind: "unavailable"; message: string };

export function WorkflowQueuePage({
  active,
  title,
  statuses,
}: {
  active: string;
  title: string;
  statuses: readonly WorkflowStatus[];
}) {
  const initial = useMemo(() => new URLSearchParams(window.location.search), []);
  const requested = initial.get("queue") as WorkflowStatus | null;
  const [selected, setSelected] = useState<WorkflowStatus>(
    requested && statuses.includes(requested) ? requested : statuses[0]!,
  );
  const [q, setQ] = useState("");
  const [overdue, setOverdue] = useState("");
  const [exception, setException] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const baseFilters = useMemo(() => ({
    q: q.trim() || undefined,
    overdue: overdue || undefined,
    exception: exception || undefined,
    from: from || undefined,
    to: to || undefined,
    limit: "100",
  }), [q, overdue, exception, from, to]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setState({ kind: "loading" });
      void Promise.allSettled(
        statuses.map(async (status) => [
          status,
          await loadReworkOrders({ ...baseFilters, status }, controller.signal),
        ] as const),
      ).then((results) => {
        if (controller.signal.aborted) return;
        const pages: Partial<Record<WorkflowStatus, ManagementReworkPage>> = {};
        const available: WorkflowStatus[] = [];
        const errors: string[] = [];
        for (const result of results) {
          if (result.status === "fulfilled") {
            const [status, page] = result.value;
            pages[status] = page;
            available.push(status);
          } else {
            errors.push(result.reason instanceof Error ? result.reason.message : "节点队列读取失败");
          }
        }
        if (available.length === 0) {
          setState({ kind: "unavailable", message: errors[0] ?? "当前账号没有可进入的节点队列" });
          return;
        }
        setState({ kind: "ready", pages, available });
        setSelected((current) => available.includes(current) ? current : available[0]!);
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [baseFilters, refresh, statuses]);

  const selectStatus = (status: WorkflowStatus) => {
    setSelected(status);
    const url = new URL(window.location.href);
    url.searchParams.set("queue", status);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const ready = state.kind === "ready" ? state : null;
  const page = ready?.pages[selected];
  const items = page?.items ?? [];
  const meta = queueMeta[selected];
  const canUseUnifiedQuery = ready?.available.some((status) => ready.pages[status]?.canViewReports === true) === true;

  return (
    <Shell active={active}>
      <Header
        title={title}
        subtitle="订单按真实当前状态进入对应节点；处理完成后自动离开本节点并流转到下一节点"
        badge={ready ? `${items.length}${page?.nextCursor ? "+" : ""} 单当前结果` : "实时节点队列"}
        {...(canUseUnifiedQuery ? { action: "返工统一查询", actionHref: "/ui/tasks" } : {})}
      />

      {state.kind === "unavailable" && <Surface className="reporting-state">{state.message}</Surface>}

      {ready && (
        <>
          <Surface className="workflow-queue-tabs">
            {ready.available.map((status) => {
              const statusPage = ready.pages[status];
              return (
                <Button
                  key={status}
                  {...(selected === status ? { variant: "primary" as const } : {})}
                  onClick={() => selectStatus(status)}
                >
                  {queueMeta[status].node} · {queueMeta[status].label} · {statusPage?.items.length ?? 0}{statusPage?.nextCursor ? "+" : ""} 单
                </Button>
              );
            })}
          </Surface>

          <Surface className="workflow-queue-guide">
            <div><small>谁来处理</small><strong>{meta.owner}</strong></div>
            <div><small>当前要做什么</small><strong>{meta.action}</strong></div>
            <div><small>完成后去哪里</small><strong>{meta.next}</strong></div>
          </Surface>

          <Surface className="reporting-filters workflow-queue-filters">
            <InsetField
              label="搜索当前节点订单"
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="单号 / 款号 / 订单 / 人员 / 供应商"
            />
            <label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
            <label>逾期<select value={overdue} onChange={(event) => setOverdue(event.target.value)}><option value="">全部</option><option value="true">仅逾期</option><option value="false">未逾期</option></select></label>
            <label>异常<select value={exception} onChange={(event) => setException(event.target.value)}><option value="">全部</option><option value="true">仅异常</option><option value="false">无异常</option></select></label>
            <Button onClick={() => setRefresh((value) => value + 1)}>立即刷新</Button>
          </Surface>

          {items.length === 0 ? (
            <Surface className="reporting-state">
              当前没有停留在 {meta.node} · {meta.label} 的订单。订单只有进入这个真实节点后才会出现在这里。
            </Surface>
          ) : (
            <div className="reporting-order-grid workflow-order-grid">
              {items.map((order) => (
                <a className="reporting-order-link" href={reportingPageUrl(actionHref(order))} key={order.reworkOrderId}>
                  <Surface className="reporting-order-card workflow-order-card">
                    <div className="reporting-order-card__heading">
                      <div>
                        <strong>{order.reworkNo ?? "返工单"}</strong>
                        <small>{order.styleNo ?? "款号未填写"} · {order.orderNo ?? "订单号未填写"}</small>
                      </div>
                      <StatusBadge tone={order.overdue ? "warning" : order.exceptionCount > 0 ? "danger" : "info"}>{order.node} · {order.nodeLabel}</StatusBadge>
                    </div>
                    <dl>
                      <div><dt>当前节点停留</dt><dd>{age(order.agingSeconds)}</dd></div>
                      <div><dt>返工数量</dt><dd>{order.plannedQuantity ?? "—"}</dd></div>
                      <div><dt>最近更新</dt><dd>{new Date(order.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</dd></div>
                      <div><dt>当前异常</dt><dd>{order.exceptionCount ? `${order.exceptionCount} 项` : "无"}</dd></div>
                    </dl>
                    <div className="workflow-order-card__action"><strong>进入当前节点处理 →</strong></div>
                  </Surface>
                </a>
              ))}
            </div>
          )}
        </>
      )}

      {state.kind === "loading" && <Surface className="reporting-state">正在读取当前节点订单…</Surface>}
    </Shell>
  );
}
