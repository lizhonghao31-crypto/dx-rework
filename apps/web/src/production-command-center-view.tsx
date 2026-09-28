import type { ReactNode } from "react";
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
}>;

export type CommandSummary = Readonly<{
  active: number;
  dueSoon: number;
  highRisk: number;
  overdue: number;
}>;

type Props = Readonly<{
  summary: CommandSummary;
  orders: readonly CommandOrder[];
  selectedOrderNo: string;
}>;

const riskLabel: Record<CommandRisk, string> = {
  normal: "正常",
  attention: "临期",
  high: "高风险",
  overdue: "已超时",
  unknown: "待确认",
};

const RiskBadge = ({ level, children }: { level: CommandRisk; children?: ReactNode }) => (
  <span className={`command-risk command-risk--${level}`}>{children ?? riskLabel[level]}</span>
);

const timeline = [
  ["开发", "已完成"],
  ["预算/选厂", "已完成"],
  ["制单/纸样", "已完成"],
  ["开裁", "进行中"],
  ["二次工艺", "待前序"],
  ["发厂/生产", "待前序"],
  ["回货/质量", "待前序"],
] as const;

export function ProductionCommandCenterView({ summary, orders, selectedOrderNo }: Props) {
  const selected = orders.find(order => order.orderNo === selectedOrderNo) ?? orders[0];
  if (!selected) return null;

  return (
    <div className="production-command-shell">
      <aside className="production-command-sidebar" aria-label="生产管理导航">
        <div className="production-command-brand">达兴数字生产</div>
        <nav>
          <a className="is-active" href="#overview">生产管理座舱</a>
          <a href="#development">开发管理</a>
          <a href="#pattern">板房管理</a>
          <a href="#sourcing">预算与选厂</a>
          <a href="#cutting">订单开裁</a>
          <a href="#production">实时生产</a>
          <a href="#receiving">回货与质量</a>
        </nav>
      </aside>

      <main className="production-command-main">
        <header className="production-command-header">
          <div>
            <h1>生产管理座舱</h1>
            <p>跨阶段查看订单进度、节点完成期限与交付风险</p>
          </div>
          <div className="production-command-header-actions">
            <button type="button">刷新</button>
            <button className="is-primary" type="button">新建订单</button>
          </div>
        </header>

        <section className="production-command-summary" aria-label="订单风险摘要">
          <article><span>在途订单</span><strong>{summary.active}</strong><small>全部新流程订单</small></article>
          <article><span>24h内节点到期</span><strong>{summary.dueSoon}</strong><small>需要提前关注</small></article>
          <article><span>高风险</span><strong>{summary.highRisk}</strong><small>预计影响交付</small></article>
          <article><span>已超时</span><strong>{summary.overdue}</strong><small>节点期限已过</small></article>
        </section>

        <section className="production-command-toolbar">
          <input aria-label="搜索订单" placeholder="搜索订单 / 款号 / 客户" />
          <select aria-label="风险筛选" defaultValue="all">
            <option value="all">全部风险</option>
            <option value="attention">临期</option>
            <option value="high">高风险</option>
            <option value="overdue">已超时</option>
          </select>
          <select aria-label="阶段筛选" defaultValue="all">
            <option value="all">全部阶段</option>
            <option value="development">开发</option>
            <option value="preproduction">产前</option>
            <option value="production">生产</option>
          </select>
        </section>

        <section className="production-command-card production-command-table-wrap">
          <table className="production-command-table">
            <thead>
              <tr>
                <th>订单 / 客户</th>
                <th>当前节点</th>
                <th>进入时间</th>
                <th>标准时限</th>
                <th>完成期限</th>
                <th>剩余 / 超时</th>
                <th>整单风险</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(order => (
                <tr key={order.orderNo} className={order.orderNo === selected.orderNo ? "is-selected" : undefined}>
                  <td><strong>{order.orderNo}</strong><span>{order.styleNo} · {order.customer}</span></td>
                  <td><strong>{order.currentStage}</strong><span>{order.merchandiser}</span></td>
                  <td>{order.nodeEnteredAt}</td>
                  <td>{order.nodeLimit}</td>
                  <td><strong>{order.nodeDeadline}</strong></td>
                  <td><RiskBadge level={order.nodeRisk}>{order.nodeRemaining}</RiskBadge></td>
                  <td><RiskBadge level={order.overallRisk}>{order.overallRiskText}</RiskBadge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="production-command-detail-grid">
          <article className="production-command-card production-command-detail">
            <div className="production-command-detail-heading">
              <div className="production-command-thumbnail" aria-label="款图占位">款图</div>
              <div>
                <div className="production-command-title-row">
                  <h2>{selected.styleNo}</h2>
                  <RiskBadge level={selected.overallRisk}>{selected.overallRiskText}</RiskBadge>
                </div>
                <p>{selected.customer} · {selected.category} · {selected.quantity}</p>
                <div className="production-command-facts">
                  <span>设计师 <strong>{selected.designer}</strong></span>
                  <span>跟单 <strong>{selected.merchandiser}</strong></span>
                  <span>正式货期 <strong>{selected.deliveryDate}</strong></span>
                </div>
              </div>
            </div>

            <div className="production-command-node-deadline">
              <div><span>当前节点</span><strong>{selected.currentStage}</strong></div>
              <div><span>进入时间</span><strong>{selected.nodeEnteredAt}</strong></div>
              <div><span>标准时限</span><strong>{selected.nodeLimit}</strong></div>
              <div><span>完成期限</span><strong>{selected.nodeDeadline}</strong></div>
              <div><span>剩余 / 超时</span><RiskBadge level={selected.nodeRisk}>{selected.nodeRemaining}</RiskBadge></div>
            </div>

            <div className="production-command-timeline" aria-label="生产流程">
              {timeline.map(([label, status], index) => (
                <div key={label} className={`production-command-timeline-item ${status === "已完成" ? "is-done" : status === "进行中" ? "is-current" : ""}`}>
                  <span className="production-command-step">{index + 1}</span>
                  <strong>{label}</strong>
                  <small>{status}</small>
                </div>
              ))}
            </div>
          </article>

          <aside className="production-command-card production-command-risk-panel">
            <div className="production-command-risk-heading">
              <div>
                <span>整单交付风险</span>
                <RiskBadge level={selected.overallRisk}>{selected.overallRiskText}</RiskBadge>
              </div>
              <button type="button">去处理</button>
            </div>
            <dl>
              <div><dt>风险原因</dt><dd>{selected.reason}</dd></div>
              <div><dt>当前节点期限</dt><dd>{selected.nodeDeadline}</dd></div>
              <div><dt>节点状态</dt><dd>{riskLabel[selected.nodeRisk]}</dd></div>
              <div><dt>正式货期</dt><dd>{selected.deliveryDate}</dd></div>
            </dl>
            <div className="production-command-risk-note">
              节点风险与整单交付风险分别判断；未进入的后续节点不提前倒计时。
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
