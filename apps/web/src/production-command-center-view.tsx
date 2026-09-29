import type { CSSProperties, ReactNode } from "react";
import "./production-command-center-view.css";

export type CommandRisk = "normal" | "attention" | "high" | "overdue" | "unknown";

export type CommandOrder = Readonly<{
  orderNo: string;
  styleNo: string;
  customer: string;
  category: string;
  merchandiser: string;
  designer: string;
  quantity: string;
  deliveryDate: string;
  currentStage: string;
  nodeEnteredAt: string;
  nodeLimit: string;
  nodeDeadline: string;
  nodeRemaining: string;
  nodeRisk: CommandRisk;
  overallRisk: CommandRisk;
  overallRiskText: string;
  reason: string;
  orderType?: string;
  progress?: number;
  styleName?: string;
}>;

export type CommandSummary = Readonly<{
  active: number;
  dueSoon: number;
  highRisk: number;
  overdue: number;
  normal?: number;
  completed?: number;
}>;

type Props = Readonly<{
  summary: CommandSummary;
  orders: readonly CommandOrder[];
  selectedOrderNo: string;
}>;

const riskLabel: Record<CommandRisk, string> = {
  normal: "正常",
  attention: "即将到期",
  high: "高风险",
  overdue: "已超时",
  unknown: "待确认",
};

const RiskBadge = ({ level, children }: { level: CommandRisk; children?: ReactNode }) => (
  <span className={`command-risk command-risk--${level}`}>{children ?? riskLabel[level]}</span>
);

const sideNavigation = ["首页", "生产管理座舱", "开发管理", "大货生产", "实时生产看板", "回货质检", "人员/绩效", "报表中心", "基础资料", "系统设置"] as const;
const detailTabs = ["生产进度", "单据信息", "面辅料", "工艺要求", "尺寸表", "生产记录", "质检记录", "客户评语", "变更记录"] as const;
const flow = [
  ["订单创建", "done"],
  ["设计确认", "done"],
  ["预算确认", "done"],
  ["制单", "done"],
  ["纸样&唛架", "done"],
  ["仓库预缩", "done"],
  ["裁床开裁", "current"],
  ["二次工艺", "future"],
  ["发加工", "future"],
  ["回货质检", "future"],
  ["完成", "future"],
] as const;

const progressFor = (order: CommandOrder, index: number) => order.progress ?? [60, 30, 40, 10][index % 4] ?? 0;

export function ProductionCommandCenterView({ summary, orders, selectedOrderNo }: Props) {
  const selected = orders.find(order => order.orderNo === selectedOrderNo) ?? orders[0];
  if (!selected) return null;
  const selectedIndex = Math.max(0, orders.findIndex(order => order.orderNo === selected.orderNo));
  const selectedProgress = progressFor(selected, selectedIndex);
  const normalCount = summary.normal ?? Math.max(summary.active - summary.dueSoon - summary.overdue, 0);
  const completedCount = summary.completed ?? 0;
  const pendingConfirmationCount = orders.filter(order => order.nodeRisk === "unknown").length;
  const progressStyle = { "--command-progress": `${selectedProgress}%` } as CSSProperties;

  return (
    <div className="production-command-shell">
      <aside className="production-command-sidebar" aria-label="生产管理导航">
        <div className="production-command-brand">
          <strong>DX</strong>
          <span>达兴服装<small>数字生产平台</small></span>
        </div>
        <nav>
          {sideNavigation.map((label, index) => (
            <a key={label} className={label === "生产管理座舱" ? "is-active" : undefined} href={`#side-${index}`}>
              <span className="production-command-nav-icon" aria-hidden="true"><i /></span>
              {label}
            </a>
          ))}
        </nav>
        <div className="production-command-sidebar-footer">
          <span>用数据连接设计</span>
          <span>用数字驱动生产</span>
          <small>FROM DESIGN<br />TO DELIVERY</small>
        </div>
      </aside>

      <section className="production-command-workspace">
        <header className="production-command-topbar">
          <div className="production-command-userbar">
            <span className="production-command-search-icon" aria-hidden="true" />
            <span className="production-command-bell" aria-hidden="true"><i /><b>12</b></span>
            <span className="production-command-avatar">L</span>
            <span><strong>{selected.designer}</strong><small>设计师</small></span>
            <span aria-hidden="true">⌄</span>
          </div>
        </header>

        <main className="production-command-main">
          <section className="production-command-overview-row">
            <div className="production-command-welcome">
              <h1>早上好，{selected.designer}！</h1>
              <p>今天是 2026年9月29日</p>
            </div>
            <div className="production-command-summary" aria-label="订单风险摘要">
              <article><span>全部订单</span><strong>{summary.active}</strong><small>当前监控</small></article>
              <article><span>正常进行</span><strong>{normalCount}</strong><small>节点正常</small></article>
              <article><span>即将到期</span><strong>{summary.dueSoon}</strong><small>24小时内</small></article>
              <article><span>已超时</span><strong>{summary.overdue}</strong><small>节点期限已过</small></article>
              <article><span>已完成</span><strong>{completedCount}</strong><small>当前批次</small></article>
            </div>
            <aside className="production-command-today-alerts">
              <h2>▲ 今日待处理</h2>
              <ul>
                <li><span>超时任务</span><strong>{summary.overdue}</strong></li>
                <li><span>即将到期（24小时内）</span><strong>{summary.dueSoon}</strong></li>
                <li><span>高风险订单</span><strong>{summary.highRisk}</strong></li>
                <li><span>待确认节点</span><strong>{pendingConfirmationCount}</strong></li>
              </ul>
            </aside>
          </section>

          <section className="production-command-card production-command-orders-card">
            <div className="production-command-order-tabs">
              {["全部订单", "开发打样", "待确认下单", "大货生产", "回货质检", "已完成"].map((label, index) => (
                <button key={label} className={index === 0 ? "is-active" : undefined} type="button">{label}{index === 0 ? `（${summary.active}）` : ""}</button>
              ))}
            </div>
            <div className="production-command-toolbar">
              <input aria-label="搜索订单" placeholder="搜索款号 / 客户 / 订单号 / 款名" />
              <select aria-label="客户筛选" defaultValue="all"><option value="all">客户</option></select>
              <select aria-label="订单类型筛选" defaultValue="all"><option value="all">订单类型</option></select>
              <select aria-label="节点筛选" defaultValue="all"><option value="all">当前节点</option></select>
              <select aria-label="风险筛选" defaultValue="all"><option value="all">风险状态</option></select>
              <select aria-label="交货时间筛选" defaultValue="all"><option value="all">交货时间</option></select>
              <button className="production-command-more-filter" type="button"><span className="production-command-filter-icon" aria-hidden="true" />更多筛选</button>
              <button className="production-command-new-order" type="button">＋ 新建订单</button>
              <button className="production-command-more-button" type="button">•••</button>
            </div>

            <div className="production-command-table-wrap">
              <table className="production-command-table">
                <thead><tr>
                  <th><input aria-label="全选" type="checkbox" /></th><th>订单号</th><th>设计款号</th><th>款名</th><th>客户</th><th>类型</th><th>下单总数</th><th>交货日期</th><th>当前节点</th><th>进度</th><th>完成期限</th><th>状态</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {orders.map((order, index) => {
                    const progress = progressFor(order, index);
                    return <tr key={order.orderNo} className={order.orderNo === selected.orderNo ? "is-selected" : undefined}>
                      <td><input aria-label={`选择${order.orderNo}`} type="checkbox" /></td>
                      <td><div className="production-command-order-cell"><span className="production-command-mini-garment" aria-hidden="true"><i /></span><strong>{order.orderNo}</strong></div></td>
                      <td>{order.styleNo}</td>
                      <td>{order.styleName ?? order.category}</td>
                      <td>{order.customer}</td>
                      <td>{order.orderType ?? "大货"}</td>
                      <td>{order.quantity}</td>
                      <td>{order.deliveryDate}</td>
                      <td><span className="production-command-stage-mark" aria-hidden="true" />{order.currentStage}</td>
                      <td><div className={`production-command-progress production-command-progress--${order.nodeRisk}`}><i style={{ width: `${progress}%` }} /><span>{progress}%</span></div></td>
                      <td>{order.nodeDeadline}</td>
                      <td><RiskBadge level={order.nodeRisk} /></td>
                      <td><button className="production-command-row-menu" type="button">•••</button></td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="production-command-detail-grid">
            <article className="production-command-card production-command-detail">
              <div className="production-command-detail-heading">
                <div className="production-command-thumbnail" aria-label="款图占位"><span className="production-command-garment-illustration" aria-hidden="true" /></div>
                <div className="production-command-detail-title">
                  <div className="production-command-title-row">
                    <h2>{selected.styleNo}</h2>
                    <span className="production-command-type-tag">{selected.orderType ?? "大货订单"}</span>
                    <span className="production-command-running-tag">生产中</span>
                  </div>
                  <div className="production-command-detail-facts-grid">
                    <span>客户：<strong>{selected.customer}</strong></span>
                    <span>下单总数：<strong>{selected.quantity}</strong></span>
                    <span>款式类型：<strong>{selected.category}</strong></span>
                    <span>款名：<strong>{selected.styleName ?? selected.category}</strong></span>
                    <span>交货日期：<strong>{selected.deliveryDate}</strong></span>
                    <span>面料类型：<strong>针织</strong></span>
                    <span>设计款号：<strong>{selected.styleNo}</strong></span>
                    <span>跟单员：<strong>{selected.merchandiser}</strong></span>
                    <span>加工工序：<strong>裁剪/车缝/尾部</strong></span>
                  </div>
                </div>
                <div className="production-command-detail-actions">
                  <button type="button">查看单据⌄</button><button type="button">编辑</button><button type="button">更多⌄</button>
                </div>
              </div>

              <nav className="production-command-detail-tabs" aria-label="订单详情导航">
                {detailTabs.map((label, index) => <button key={label} className={index === 0 ? "is-active" : undefined} type="button">{label}</button>)}
              </nav>

              <div className="production-command-timeline" aria-label="生产流程">
                {flow.map(([label, state], index) => (
                  <div key={label} className={`production-command-timeline-item is-${state}`}>
                    <span className="production-command-step">{state === "done" ? "✓" : index + 1}</span>
                    <strong>{label}</strong>
                    <small>{state === "done" ? "已完成" : state === "current" ? "进行中" : "待开始"}</small>
                  </div>
                ))}
              </div>

              <div className="production-command-current-node">
                <div className="production-command-current-node-title"><strong>当前节点详情：{selected.currentStage}</strong><span>节点风险与整单交付风险分别判断</span></div>
                <div className="production-command-current-node-body">
                  <dl>
                    <div><dt>负责人</dt><dd>{selected.merchandiser}</dd></div>
                    <div><dt>进入时间</dt><dd>{selected.nodeEnteredAt}</dd></div>
                    <div><dt>标准时限</dt><dd>{selected.nodeLimit}</dd></div>
                    <div><dt>完成期限</dt><dd>{selected.nodeDeadline}</dd></div>
                    <div><dt>剩余时间</dt><dd><RiskBadge level={selected.nodeRisk}>{selected.nodeRemaining}</RiskBadge></dd></div>
                  </dl>
                  <div className="production-command-current-node-copy">
                    <p><strong>任务说明：</strong>{selected.reason}</p>
                    <p><strong>关联文件：</strong>生产工艺单.pdf</p>
                    <p><strong>上游完成：</strong>纸样 & 唛架</p>
                    <small>未进入的后续节点不提前倒计时。</small>
                  </div>
                  <div className="production-command-current-node-actions"><button className="is-primary" type="button">完成节点</button><button type="button">异常处理</button></div>
                </div>
              </div>
            </article>

            <aside className="production-command-detail-aside">
              <section className="production-command-card production-command-progress-card">
                <h2>订单进度总览</h2>
                <div className="production-command-progress-overview">
                  <div className="production-command-progress-ring" style={progressStyle}><strong>{selectedProgress}%</strong><small>整体进度</small></div>
                  <ul><li><i className="is-done" />已完成 <strong>6</strong></li><li><i className="is-current" />进行中 <strong>1</strong></li><li><i />待开始 <strong>4</strong></li></ul>
                </div>
              </section>

              <section className="production-command-card production-command-risk-list">
                <div className="production-command-aside-heading"><h2>风险提示</h2><button type="button">查看全部 ›</button></div>
                <ul>
                  {orders.slice(0, 4).map(order => <li key={order.orderNo}><i className={`risk-dot risk-dot--${order.nodeRisk}`} /><span><strong>{order.currentStage}</strong><small>{order.nodeRemaining}</small></span></li>)}
                </ul>
                <div className="production-command-overall-risk"><span>整单交付风险</span><RiskBadge level={selected.overallRisk}>{selected.overallRiskText}</RiskBadge></div>
              </section>

              <section className="production-command-card production-command-people-card">
                <div className="production-command-aside-heading"><h2>相关人员</h2><button type="button">更多 ›</button></div>
                <div className="production-command-people">
                  <span><b>设</b><small>设计师<br /><strong>{selected.designer}</strong></small></span>
                  <span><b>跟</b><small>跟单员<br /><strong>{selected.merchandiser}</strong></small></span>
                  <span><b>技</b><small>技术部<br /><strong>李柘恒</strong></small></span>
                </div>
              </section>
            </aside>
          </section>
        </main>
      </section>
    </div>
  );
}
