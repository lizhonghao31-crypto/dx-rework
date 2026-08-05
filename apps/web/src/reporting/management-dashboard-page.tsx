import type { ManagementDashboardResponse, SiteDashboardResponse } from "@dx-rework/contracts/reporting";
import { Button, KpiInstrument, StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { Header, Shell } from "../components.js";
import { loadManagementDashboard, reportingPageUrl } from "./reporting-client.js";
import { ManagementOrderCard } from "./management-order-card.js";
import "./reporting.css";

type State =
  | { kind: "loading" }
  | { kind: "ready"; value: ManagementDashboardResponse | SiteDashboardResponse }
  | { kind: "unavailable"; message: string };

export function ManagementDashboardPage({ mode }: { mode: "management" | "site" }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const busy = useRef(false);
  const mounted = useRef(true);
  const hasReady = useRef(false);
  const load = useCallback(async (initial = false) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const value = await loadManagementDashboard(mode);
      if (mounted.current) {
        hasReady.current = true;
        setState({ kind: "ready", value });
      }
    } catch (error: unknown) {
      if (mounted.current && (initial || !hasReady.current)) {
        setState({ kind: "unavailable", message: error instanceof Error ? error.message : "Dashboard 加载失败" });
      }
    } finally {
      busy.current = false;
    }
  }, [mode]);

  useEffect(() => {
    mounted.current = true;
    void load(true);
    const timer = window.setInterval(() => void load(), 15_000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [load]);

  const ready = state.kind === "ready" ? state.value : null;
  const management = ready?.mode === "management" ? ready : null;
  const site = ready?.mode === "site" ? ready : null;
  return (
    <Shell active={mode === "management" ? "总览" : "现场工作台"}>
      <Header
        title={mode === "management" ? "管理层共享座舱" : "李同生 · 现场返工工作台"}
        subtitle={mode === "management" ? "李总、伍总、张文豪查看相同业务事实；操作按钮按 capability 开放" : "聚焦工序、分工、上数、整单审核、数量调整和工资初核"}
        badge={ready ? `数据截至 ${new Date(ready.asOf).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" })}` : "实时读取"}
        action={ready?.availableActions.includes("export_reports") ? "报表中心" : "统一查询"}
        actionHref={ready?.availableActions.includes("export_reports") ? "/ui/reports" : "/ui/tasks"}
      />
      {state.kind === "loading" && <Surface className="reporting-state">正在加载真实 Dashboard…</Surface>}
      {state.kind === "unavailable" && <Surface className="reporting-state">{state.message}</Surface>}
      {management && (
        <>
          <div className="kpis">
            <KpiInstrument label="未完结返工" value={management.kpis.openOrders} detail="排除已完成与取消" tone="info" />
            <KpiInstrument label="本月已完成" value={management.kpis.completedOrders} detail={`${management.range.from} 至 ${management.range.to}`} tone="success" />
            <KpiInstrument label="逾期待办" value={management.kpis.overdueTodos} detail="按数据库 due_at" tone="warning" />
            <KpiInstrument label="当前异常" value={management.kpis.exceptionCount} detail="阻断、投递失败、扣款逾期" tone="warning" />
          </div>
          <div className="reporting-dashboard-grid">
            <Surface>
              <div className="section-title"><div><h2>全流程节点</h2><p>只统计当前状态，不重复计算历史版本。</p></div><StatusBadge tone="info">15 秒刷新</StatusBadge></div>
              <div className="queue">{management.nodeCounts.map((item) => <div key={item.node}><span>{item.node} · {item.label}</span><StatusBadge tone={item.count > 0 ? "info" : "success"}>{item.count} 单</StatusBadge></div>)}</div>
            </Surface>
            <Surface>
              <h2>金额总览</h2>
              <div className="reporting-financial-grid">
                <div><small>工资</small><strong>¥{management.financial.wageTotal}</strong></div>
                <div><small>责任总额</small><strong>¥{management.financial.responsibilityTotal}</strong></div>
                <div><small>本厂承担</small><strong>¥{management.financial.ownFactoryTotal}</strong></div>
                <div><small>外部拟扣</small><strong>¥{management.financial.externalProposed}</strong></div>
                <div><small>累计实扣</small><strong>¥{management.financial.externalDeducted}</strong></div>
                <div><small>未扣差额</small><strong>¥{management.financial.externalRemaining}</strong></div>
              </div>
            </Surface>
          </div>
          <div className="reporting-dashboard-grid">
            <Surface>
              <div className="section-title"><h2>当前异常</h2>{management.availableActions.includes("export_reports") && <a href={reportingPageUrl("ui/reports?type=exceptions")}><Button>查看全部</Button></a>}</div>
              <div className="reporting-exceptions">{management.exceptions.map((item) => <a href={reportingPageUrl(item.deepLink)} key={`${item.exceptionType}:${item.entityId}`}><StatusBadge tone="warning">{item.exceptionType}</StatusBadge><span>{item.label}</span><small>{new Date(item.occurredAt).toLocaleString("zh-CN", { timeZone: "Asia/Singapore" })}</small></a>)}</div>
              {management.exceptions.length === 0 && <p>当前没有阻断、投递失败或逾期事项。</p>}
            </Surface>
            <Surface>
              <div className="section-title"><h2>最近返工</h2><a href={reportingPageUrl("ui/tasks")}><Button>统一查询</Button></a></div>
              <div className="reporting-order-grid compact">{management.recentOrders.map((order) => <ManagementOrderCard order={order} key={order.reworkOrderId} />)}</div>
            </Surface>
          </div>
        </>
      )}
      {site && (
        <>
          <div className="kpis">
            <KpiInstrument label="待配置工序" value={site.kpis.pendingConfiguration} detail="现场下一步" tone="info" />
            <KpiInstrument label="待分工" value={site.kpis.pendingAssignment} detail="含成员快照" tone="info" />
            <KpiInstrument label="上数中" value={site.kpis.inProgress} detail="有效上数实时汇总" tone="success" />
            <KpiInstrument label="待整单审核" value={site.kpis.pendingOrderReview} detail="含数量调整复核" tone="warning" />
            <KpiInstrument label="待工资初核" value={site.kpis.pendingWageReview} detail="N10-A" tone="info" />
            <KpiInstrument label="现场异常" value={site.kpis.siteExceptions} detail="不混入老板终审" tone="warning" />
          </div>
          <div className="reporting-dashboard-grid">
            <Surface><h2>今日行动队列</h2><div className="queue">{site.nodeCounts.map((item) => <div key={item.node}><span>{item.node} · {item.label}</span><StatusBadge tone="info">{item.count} 单</StatusBadge></div>)}</div></Surface>
            <Surface><div className="section-title"><h2>现场返工</h2><a href={reportingPageUrl("ui/tasks")}><Button>查看全部</Button></a></div><div className="reporting-order-grid compact">{site.recentOrders.map((order) => <ManagementOrderCard order={order} key={order.reworkOrderId} />)}</div></Surface>
          </div>
        </>
      )}
    </Shell>
  );
}
