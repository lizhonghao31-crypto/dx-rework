import {useForegroundWait} from "../foreground-loading.js";
import {useForegroundRead} from "../use-foreground-read.js";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, KpiInstrument, StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback } from "react";

import { Header, Shell } from "../components.js";
import { loadManagementDashboard, reportingPageUrl } from "./reporting-client.js";
import { ManagementOrderCard } from "./management-order-card.js";
import "./reporting.css";


const nodeTarget = (node: string): string => ({
  N01: "ui/tasks?status=draft",
  N02: "ui/process-configuration?queue=pending_process_configuration",
  N03: "ui/process-configuration?queue=pending_ie_review",
  // Historical dashboard codes are kept by the reporting API for data
  // compatibility. Present them using the current visible workflow.
  "N02-R": "ui/process-configuration?queue=pending_task_assignment",
  N04: "ui/work-reporting?queue=in_progress",
  N05: "ui/work-reporting?queue=pending_order_review",
  N06: "ui/work-reporting?queue=pending_final_quantity_ie_review",
  "N05-A": "ui/work-reporting?queue=pending_quantity_adjustment_ie_review",
  N07: "ui/tasks?status=pending_responsibility_determination",
  N08: "ui/tasks?status=pending_owner_signature",
  N09: "ui/tasks?status=completed",
  N11: "ui/wages",
})[node] ?? "ui/tasks";

const nodePresentation = (node: string, label: string): { node: string; label: string } => ({
  "N02-R": { node: "N02", label: "分配工序 &工人 · 启动恢复" },
  N04: { node: "N04", label: "返工执行报数" },
  N05: { node: "N05", label: "尾部最终数量确认" },
  N06: { node: "N06", label: "IE 最终数量复核" },
  "N05-A": { node: "N05-A", label: "历史数量调整" },
  N07: { node: "N07", label: "责任判定" },
  N08: { node: "N08", label: "老板确认签字" },
  N09: { node: "N09", label: "返工业务完成" },
  N11: { node: "工资", label: "工资管理" },
})[node] ?? { node, label };

const NodeQueue = ({ items }: { items: ReadonlyArray<{ node: string; label: string; count: number }> }) => (
  <div className="queue workflow-dashboard-queue">
    {items.map((item) => {
      const visible = nodePresentation(item.node, item.label);
      return <a className="workflow-dashboard-node" href={reportingPageUrl(nodeTarget(item.node))} key={item.node}>
        <span>{visible.node} · {visible.label}</span>
        <StatusBadge tone={item.count > 0 ? "info" : "success"}>{formatBusinessDecimal(item.count)} 单</StatusBadge>
        <small>进入节点工作台 →</small>
      </a>;
    })}
  </div>
);

export function ManagementDashboardPage({ mode }: { mode: "management" | "site" }) {
  const load=useCallback((signal:AbortSignal)=>loadManagementDashboard(mode,signal),[mode]);
  const read=useForegroundRead("rework-dashboard",mode,load);
  useForegroundWait(read.foregroundKey);
  const ready=read.value;
  const management = ready?.mode === "management" ? ready : null;
  const site = ready?.mode === "site" ? ready : null;
  return (
    <Shell active={mode === "management" ? "总览" : "现场工作台"}>
      <Header
        title={mode === "management" ? "管理层共享座舱" : "现场返工工作台"}
        badge={ready ? `数据截至 ${new Date(ready.asOf).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" })}` : "实时读取"}
        action={ready?.availableActions.includes("export_reports") ? "报表中心" : "统一查询"}
        actionHref={ready?.availableActions.includes("export_reports") ? "/ui/reports" : "/ui/tasks"}
      />
      {read.waiting&&!ready&&<Surface className="reporting-state">加载中…</Surface>}
      {read.error&&<Surface className="reporting-state"><p role="alert">{read.error.message}</p><Button onClick={read.retry}>重试读取</Button></Surface>}
      {management && (
        <>
          <div className="kpis">
            <KpiInstrument label="未完结返工" value={formatBusinessDecimal(management.kpis.openOrders)} detail="进行中" tone="info" />
            <KpiInstrument label="本月已完成" value={formatBusinessDecimal(management.kpis.completedOrders)} detail={`${management.range.from} 至 ${management.range.to}`} tone="success" />
            <KpiInstrument label="逾期待办" value={formatBusinessDecimal(management.kpis.overdueTodos)} detail="待处理" tone="warning" />
            <KpiInstrument label="当前异常" value={formatBusinessDecimal(management.kpis.exceptionCount)} detail="待处理" tone="warning" />
          </div>
          <div className="reporting-dashboard-grid">
            <Surface>
              <div className="section-title"><div><h2>全流程节点</h2><p>点击任一节点直接进入当前停留订单，不再只是静态统计。</p></div></div>
              <NodeQueue items={management.nodeCounts} />
            </Surface>
            <Surface>
              <h2>金额总览</h2>
              <div className="reporting-financial-grid">
                {management.financial.wageTotal !== undefined ? <div><small>工资</small><strong>{formatBusinessCurrency(management.financial.wageTotal)}</strong></div> : null}
                <div><small>责任总额</small><strong>{formatBusinessCurrency(management.financial.responsibilityTotal)}</strong></div>
                <div><small>本厂承担</small><strong>{formatBusinessCurrency(management.financial.ownFactoryTotal)}</strong></div>
                <div><small>外部拟扣</small><strong>{formatBusinessCurrency(management.financial.externalProposed)}</strong></div>
                <div><small>累计实扣</small><strong>{formatBusinessCurrency(management.financial.externalDeducted)}</strong></div>
                <div><small>未扣差额</small><strong>{formatBusinessCurrency(management.financial.externalRemaining)}</strong></div>
              </div>
            </Surface>
          </div>
          <div className="reporting-dashboard-grid">
            <Surface>
              <div className="section-title"><h2>当前异常</h2>{management.availableActions.includes("export_reports") && <a href={reportingPageUrl("ui/reports?type=exceptions")}><Button>查看全部</Button></a>}</div>
              <div className="reporting-exceptions">{management.exceptions.map((item) => <a href={reportingPageUrl(item.deepLink)} key={`${item.exceptionType}:${item.entityId}`}><StatusBadge tone="warning">{item.exceptionType}</StatusBadge><span>{item.label}</span><small>{new Date(item.occurredAt).toLocaleString("zh-CN", { timeZone: "Asia/Singapore" })}</small></a>)}</div>
              {management.exceptions.length === 0 && <p>暂无异常。</p>}
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
            <KpiInstrument label="待配置工序" value={formatBusinessDecimal(site.kpis.pendingConfiguration)} detail="待处理" tone="info" />
            <KpiInstrument label="待启动恢复" value={formatBusinessDecimal(site.kpis.pendingAssignment)} detail="待处理" tone="info" />
            <KpiInstrument label="执行报数中" value={formatBusinessDecimal(site.kpis.inProgress)} detail="进行中" tone="success" />
            <KpiInstrument label="待最终数量确认 / IE 复核" value={formatBusinessDecimal(site.kpis.pendingOrderReview)} detail="待处理" tone="warning" />
            {site.kpis.pendingWageReview !== undefined ? <KpiInstrument label="待工资初核" value={formatBusinessDecimal(site.kpis.pendingWageReview)} detail="待处理" tone="info" /> : null}
            <KpiInstrument label="现场异常" value={formatBusinessDecimal(site.kpis.siteExceptions)} detail="待处理" tone="warning" />
          </div>
          <div className="reporting-dashboard-grid">
            <Surface><div className="section-title"><div><h2>今日行动队列</h2><p>点击节点进入当前订单工作台。</p></div></div><NodeQueue items={site.nodeCounts} /></Surface>
            <Surface><div className="section-title"><h2>现场返工</h2><a href={reportingPageUrl("ui/tasks")}><Button>查看全部</Button></a></div><div className="reporting-order-grid compact">{site.recentOrders.map((order) => <ManagementOrderCard order={order} key={order.reworkOrderId} />)}</div></Surface>
          </div>
        </>
      )}
    </Shell>
  );
}
