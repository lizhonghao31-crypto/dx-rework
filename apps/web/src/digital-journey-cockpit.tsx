import { useEffect, useState, type ReactNode } from "react";
import { Button, StatusBadge, type Tone } from "@dx-rework/ui";
import { ActivityLog, BusinessTable, DocumentList, FilterBar, FlowStageCard, KpiCard, NodeTable, PageHeader, Pagination, RiskPanel } from "@dx-rework/ui/production";
import { JOURNEY_NODES, JOURNEY_STAGES, type JourneyNode, type JourneyRecord, type JourneyResult, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { createWebUrls } from "../url-contract.js";
import { journeyRiskLabels, journeyStateLabels, journeyRecordHref, journeyTime, matchingNodes, nodeStatus, orderStatus, stageStatus, stageTimes, type CockpitContext } from "./digital-journey-cockpit-model.js";
import "./digital-journey-cockpit.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
const tone = (state: string): Tone => state === "blocked" || state === "overdue" ? "danger" : state === "completed" || state === "inherited" ? "success" : state === "active" || state === "due_soon" ? "info" : "neutral";
const nodeTone = (node: JourneyNode): Tone => node.risks.includes("overdue") || node.completionResult === "late" ? "danger" : tone(node.state);
const who = (person: JourneyNode["owner"]) => person?.name ?? person?.id ?? "未指派";
const quantity = (order: OrderJourney) => !order.orderId ? "未下单" : order.lines.length ? order.lines.reduce((sum, line) => sum + line.orderedQuantity, 0).toLocaleString() : "无可见订购量";
const kpis = [
  { key: "all", label: "全部订单", field: "all", detail: "当前授权范围", tone: "info" },
  { key: "active", label: "进行中", field: "active", detail: "有在办或待前置节点", tone: "info" },
  { key: "due_soon", label: "即将到期", field: "dueSoon", detail: "按原节点临期阈值", tone: "warning" },
  { key: "overdue", label: "已超时", field: "overdue", detail: "未完成节点已逾期", tone: "danger" },
  { key: "blocked", label: "受阻", field: "blocked", detail: "原业务阻断待处理", tone: "danger" },
  { key: "completed", label: "已完成", field: "completed", detail: "原装箱或特殊结案完成", tone: "success" },
] as const;

function RecordLink({ record, context, children }: { record: JourneyRecord; context: CockpitContext; children?: ReactNode }) {
  const href = record.url ? journeyRecordHref(record.url, context) : "";
  return href ? <a href={urls.pageUrl(href)}>{children ?? (record.mode === "handle" ? "进入原办理" : "查看原记录")}</a> : <span className="journey-muted">原记录不可用</span>;
}
function CockpitFilters({ context, data, onChange }: { context: CockpitContext; data: JourneyResult | null; onChange: (patch: Partial<CockpitContext>) => void }) {
  const [more, setMore] = useState(Boolean(context.stage || context.node || context.state || context.risk || context.startDate || context.endDate));
  const [draft, setDraft] = useState(context);
  useEffect(() => setDraft(context), [context]);
  const field = (key: keyof CockpitContext, value: string) => setDraft(current => ({ ...current, [key]: key === "search" ? value : value || undefined }));
  return <FilterBar className="journey-filters" onSubmit={event => { event.preventDefault(); onChange(draft); }}>
    <label className="journey-search">综合搜索<input maxLength={100} aria-label="综合搜索" placeholder="款号、款名、客户、PO、跟单" value={draft.search} onChange={event => field("search", event.target.value)} /></label>
    <label>客户<select aria-label="客户" value={draft.customer ?? ""} onChange={event => field("customer", event.target.value)}><option value="">全部客户</option>{data?.facets?.customers.map(value => <option key={value}>{value}</option>)}</select></label>
    <label>跟单<select aria-label="跟单" value={draft.merchandiserId ?? ""} onChange={event => field("merchandiserId", event.target.value)}><option value="">主 / 第二跟单</option>{data?.facets?.merchandisers.map(person => <option value={person.id} key={person.id}>{person.name ?? person.id}</option>)}</select></label>
    <label>品类 / 款式<select aria-label="品类 / 款式" value={draft.category ?? ""} onChange={event => field("category", event.target.value)}><option value="">全部品类</option>{data?.facets?.categories.map(value => <option key={value}>{value}</option>)}</select></label>
    <Button type="submit">查询</Button><Button type="button" variant="secondary" onClick={() => setMore(!more)} aria-expanded={more}>更多筛选</Button>
    <Button type="button" variant="secondary" onClick={() => onChange({ page: 1, search: "", kpi: "all", customer: undefined, merchandiserId: undefined, category: undefined, stage: undefined, node: undefined, state: undefined, risk: undefined, startDate: undefined, endDate: undefined })}>重置筛选</Button>
    {more && <div className="journey-more-filters">
      <label>大流程<select aria-label="大流程" value={draft.stage ?? ""} onChange={event => field("stage", event.target.value)}><option value="">全部流程</option>{JOURNEY_STAGES.map(stage => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label>
      <label>小流程<select aria-label="小流程" value={draft.node ?? ""} onChange={event => field("node", event.target.value)}><option value="">全部节点</option>{JOURNEY_NODES.map(node => <option key={node.key} value={node.key}>{node.label}</option>)}</select></label>
      <label>业务状态<select aria-label="业务状态" value={draft.state ?? ""} onChange={event => field("state", event.target.value)}><option value="">全部状态</option>{Object.entries(journeyStateLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>风险<select aria-label="风险" value={draft.risk ?? ""} onChange={event => field("risk", event.target.value)}><option value="">全部风险</option>{Object.entries(journeyRiskLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>创建开始日期<input type="date" value={draft.startDate ?? ""} onChange={event => field("startDate", event.target.value)} /></label>
      <label>创建结束日期<input type="date" value={draft.endDate ?? ""} onChange={event => field("endDate", event.target.value)} /></label>
    </div>}
  </FilterBar>;
}
function NodeRows({ nodes, context, asOf }: { nodes: JourneyNode[]; context: CockpitContext; asOf: string | undefined }) {
  return <NodeTable className="journey-node-table"><thead><tr><th>小流程 / 轮次</th><th>负责人 / 实际操作者</th><th>状态 / 前置</th><th>预计完成时间</th><th>实际完成时间</th><th>原记录</th></tr></thead><tbody>{nodes.map(node => <tr id={"journey-node-" + node.instanceId} key={node.instanceId} className={context.focus === node.instanceId ? "is-focused" : undefined}>
    <td><strong>{node.label}</strong>{node.subject && <small>{node.subject}</small>}<small>{node.round ? "第 " + node.round + " 轮" : "—"}{node.occurrence ? " · 第 " + node.occurrence + " 次" : ""}{!node.current ? " · 历史" : ""}</small></td>
    <td>{who(node.owner)}{node.operator && <small>实际：{who(node.operator)}</small>}</td>
    <td><StatusBadge tone={nodeTone(node)}>{nodeStatus(node, asOf)}</StatusBadge>{node.blockers.map((blocker, index) => <small key={blocker.key + index}>{blocker.label}</small>)}{node.inheritedFrom && <small>原任务：{node.inheritedFrom.taskId}</small>}</td>
    <td className={node.risks.includes("overdue") ? "journey-overdue" : undefined}>{node.state === "not_applicable" ? "不适用" : node.state === "unavailable" ? "无可见时间" : journeyTime(node.expectedAt, node.expectedPrecision)}<small>{node.state === "not_applicable" ? "不适用路线" : node.state === "unavailable" ? "无可见计时事实" : node.expectedKind === "plan" ? "原计划 · 尚未启动 SLA" : node.sla === "running" ? "原 SLA 正在计时" : node.sla === "finished" ? "原 SLA 已结束" : node.sla === "not_started" ? "尚未真正可办理，未计时" : "未设 SLA"}</small></td>
    <td className={node.completionResult === "late" ? "journey-overdue" : undefined}>{node.state === "not_applicable" ? "不适用" : journeyTime(node.actualAt, "instant", node.state === "completed" ? "未知" : "—")}{node.actualQuality === "unverified" && <small>补报未核实</small>}</td>
    <td>{node.records.length ? node.records.map((record, index) => <div key={record.domain + record.id + index}><RecordLink record={record} context={context} /><small>{record.version ? "v" + record.version : ""}{record.lineId ? " · PO/颜色记录" : ""}</small></div>) : <span className="journey-muted">{node.state === "unavailable" ? "无权限或尚无原记录" : "尚无原记录"}</span>}</td>
  </tr>)}</tbody></NodeTable>;
}
function JourneyDetail({ order, context, onChange, asOf }: { order: OrderJourney; context: CockpitContext; asOf: string | undefined; onChange: (patch: Partial<CockpitContext>) => void }) {
  const nodes = order.stages.flatMap(stage => stage.nodes);
  const current = nodes.filter(node => node.current);
  const expanded = context.expanded === undefined ? order.stages.filter(stage => ["active", "blocked"].includes(stage.state)).map(stage => stage.key) : context.expanded.split(",");
  const toggle = (key: string) => onChange({ expanded: (expanded.includes(key) ? expanded.filter(value => value !== key) : [...expanded, key]).join(",") });
  const focus = (node: JourneyNode) => onChange({ expanded: [...new Set([...expanded, node.stage])].join(","), focus: node.instanceId });
  useEffect(() => { if (context.focus) window.requestAnimationFrame(() => document.getElementById("journey-node-" + context.focus)?.scrollIntoView({ block: "center", behavior: "smooth" })); }, [context.focus, context.expanded, order]);
  const rounds = [...new Set(order.stages.find(stage => stage.key === "development")?.nodes.map(node => node.round).filter((value): value is number => value !== null) ?? [])].sort((a, b) => b - a);
  const records = [...new Map([...order.links, ...nodes.flatMap(node => node.records)].map(record => [record.domain + record.id + record.url + record.version, record])).values()];
  const activities = nodes.flatMap(node => [
    ...(node.enteredAt ? [{ at: node.enteredAt, label: node.label + "进入办理", person: who(node.owner), node }] : []),
    ...(node.actualAt ? [{ at: node.actualAt, label: node.label + (node.actualQuality === "unverified" ? "补报完成（未核实）" : "完成"), person: who(node.operator ?? node.owner), node }] : []),
    ...node.assignmentHistory.map(item => ({ at: item.at, label: node.label + "改派：" + (item.from ?? "未指派") + " → " + (item.to ?? "未指派"), person: item.actorId, node })),
  ]).sort((a, b) => b.at.localeCompare(a.at));
  return <section className="journey-detail" aria-label="订单全景详情">
    <div className="journey-order-heading"><div><h2>{order.designStyleNo} <StatusBadge tone={tone(orderStatus(order) === "受阻" ? "blocked" : orderStatus(order) === "整单已完成" ? "completed" : "active")}>{orderStatus(order)}</StatusBadge></h2><p>{order.orderId ? "大货订单" : "产品开发"} · 客户 {order.customer ?? "未登记"} · {order.category ?? "品类未登记"} · {order.styleName ?? "款名未登记"}</p></div>{order.sourceId && rounds.length > 1 && <label>开发轮次<select value={context.round ?? order.selectedRound ?? rounds[0]} onChange={event => onChange({ round: Number(event.target.value), expanded: "development", focus: undefined })}>{rounds.map(round => <option key={round} value={round}>第 {round} 轮{round === order.adoptedRound ? " · 大货采用" : ""}</option>)}</select></label>}</div>
    <dl className="journey-order-facts"><div><dt>订购总量</dt><dd>{quantity(order)}</dd></div><div><dt>交货日期</dt><dd>{order.deliveryDate ?? "未登记"}</dd></div><div><dt>设计师</dt><dd>{order.designer ?? "无可见资料"}</dd></div><div><dt>主 / 第二跟单</dt><dd>{order.merchandisers.map(person => person.name ?? person.id).join(" / ") || "未指派"}</dd></div><div><dt>订单号 / PO</dt><dd>{[...order.orderNumbers, ...order.lines.map(line => line.po).filter(Boolean)].join(" / ") || "尚未登记"}</dd></div><div><dt>资料版本</dt><dd>开发 {order.sourceVersion === null ? "未登记" : "v" + order.sourceVersion} · 制单 {order.instructionVersion === null ? "未发布" : "v" + order.instructionVersion}</dd></div></dl>
    <div className="journey-section-title"><h3>订单全流程</h3><Button variant="secondary" onClick={() => onChange({ expanded: expanded.length === 7 ? "" : JOURNEY_STAGES.map(stage => stage.key).join(",") })}>{expanded.length === 7 ? "收起全部" : "展开全部小流程"}</Button></div>
    <div className="journey-flow">{order.stages.map((stage, index) => { const times = stageTimes(stage); return <FlowStageCard key={stage.key} title={(index + 1) + ". " + stage.label} status={stageStatus(stage, asOf)} tone={stage.nodes.some(node => node.current && node.risks.includes("overdue")) ? "danger" : tone(stage.state)} expectedAt={times.expected} actualAt={times.actual}><Button variant="secondary" aria-expanded={expanded.includes(stage.key)} onClick={() => toggle(stage.key)}>{expanded.includes(stage.key) ? "收起" : "查看小流程"} ({stage.nodes.length})</Button></FlowStageCard>; })}</div>
    <p className="journey-muted">阶段时间仅在适用节点全部有原目标及核实完成事实时汇总；并行节点按原状态展示，未启动节点不提前计时。</p>
    <div className="journey-detail-columns"><section className="journey-node-sections" aria-label="小流程明细">{order.stages.filter(stage => expanded.includes(stage.key)).map(stage => <section className="dx-production-panel" key={stage.key}><h2>{stage.label} · 小流程明细</h2><div className="journey-table-scroll"><NodeRows nodes={stage.nodes} context={context} asOf={asOf} /></div></section>)}{!expanded.length && <p>选择大流程查看负责人、时间与原记录。</p>}</section>
      <aside className="journey-side-panels"><section className="dx-production-panel"><h2>订单进度</h2>{([["开发", order.progress.development], ["大货", order.progress.bulk]] as const).map(([label, progress]) => <div className="journey-progress" key={label}><strong>{label}</strong>{progress ? <><span>{progress.completed} / {progress.applicable} 个适用节点</span><progress max={progress.applicable || 1} value={progress.completed} /></> : <span>尚无适用路线</span>}</div>)}<small>流程节点完成数不替代订购、实裁、生产、实收或装箱件数。</small></section>
        <RiskPanel>{current.filter(node => node.risks.length || node.state === "blocked").map(node => <button className="journey-risk-item" key={node.instanceId} onClick={() => focus(node)}><strong>{node.label}{node.subject ? " · " + node.subject : ""}</strong><span>{node.risks.map(risk => journeyRiskLabels[risk]).join(" / ") || "受阻"}</span>{node.blockers.map((blocker, index) => <small key={blocker.key + index}>{blocker.label}</small>)}</button>)}{!current.some(node => node.risks.length || node.state === "blocked") && <p>当前可见节点暂无风险。</p>}</RiskPanel>
        <section className="dx-production-panel"><h2>全部在办节点</h2>{current.filter(node => ["active", "blocked"].includes(node.state)).map(node => <div className="journey-active-node" key={node.instanceId}><button onClick={() => focus(node)}>{node.label}</button><span>{who(node.owner)}</span><small>{journeyTime(node.expectedAt, node.expectedPrecision)}</small></div>)}{!current.some(node => ["active", "blocked"].includes(node.state)) && <p>当前没有可见在办节点。</p>}</section>
      </aside></div>
    <div className="journey-evidence-columns"><DocumentList>{records.length ? records.map((record, index) => <div className="journey-document" key={record.domain + record.id + index}><RecordLink record={record} context={context}>{({ task: "原任务", development: "开发单", order: "订购信息", instruction: "大货制单", budget: "预算", sourcing: "外发审批 / 合同", cutting: "裁床实裁", receiving: "回货记录", closure: "回货与结案", production: "实际生产记录", preparation: "产前准备", rework: "返工记录", development_material: "面辅料记录" } as Record<string, string>)[record.domain] ?? "原业务记录"}</RecordLink><span>{record.version ? "v" + record.version : "—"}{record.lineId ? " · PO/颜色" : ""}</span></div>) : <p>尚无可见单据。</p>}</DocumentList>
      <ActivityLog><p className="journey-muted">原节点进入、完成与改派事实；完整记录可进入对应原单查看。</p>{activities.length ? <ol className="journey-activities">{activities.map((activity, index) => <li key={activity.at + activity.node.instanceId + index}><time>{journeyTime(activity.at)}</time><span><strong>{activity.label}</strong><small>{activity.person} · {activity.node.round ? "第 " + activity.node.round + " 轮" : "—"}</small></span><button onClick={() => focus(activity.node)}>定位</button></li>)}</ol> : <p>尚无可见操作事实。</p>}</ActivityLog></div>
  </section>;
}
type Props = { data: JourneyResult | null; error: string; detail: OrderJourney | null; detailError: string; detailLoading: boolean; context: CockpitContext; onChange: (patch: Partial<CockpitContext>, preserveSelection?: boolean) => void; actions: ReactNode };
export function DigitalJourneyCockpit({ data, error, detail, detailError, detailLoading, context, onChange, actions }: Props) {
  return <div className="digital-journey-cockpit"><PageHeader title="生产管理座舱" description={data ? "订单全生命周期 · " + journeyTime(data.asOf) : "订单全生命周期"} actions={actions} />
    <section className="journey-kpis" aria-label="订单筛选 KPI">{kpis.map(kpi => <KpiCard key={kpi.key} label={kpi.label} value={data?.summary[kpi.field] ?? "—"} detail={kpi.detail} tone={kpi.tone} selected={context.kpi === kpi.key} onClick={() => onChange({ kpi: kpi.key })} />)}</section>
    <p className="journey-muted">按当前授权及筛选范围统计订单；同单多个异常节点计一单。</p>
    <CockpitFilters context={context} data={data} onChange={onChange} />
    {error && <p role="alert">{error}</p>}
    <section className="dx-production-panel journey-orders" aria-label="订单列表" aria-busy={!data && !error}><div className="journey-table-scroll"><BusinessTable><thead><tr><th>款号 / 款名</th><th>客户 / 类型</th><th>订购量 / 交货日期</th><th>全部在办节点</th><th>状态</th><th>命中原因 / 下钻</th></tr></thead><tbody>{data?.items.map(order => <tr key={order.id} className={context.selected === order.id ? "is-selected" : undefined}><td><button className="journey-order-select" onClick={() => onChange({ selected: order.id, round: undefined, expanded: undefined, focus: undefined }, true)}>{order.designStyleNo}</button><small>{order.styleName ?? "款名未登记"}{order.temporaryStyleNo ? " · " + order.temporaryStyleNo : ""}</small></td><td>{order.customer ?? "客户未登记"}<small>{order.orderId ? "大货订单" : "产品开发"}</small></td><td>{quantity(order)}<small>{order.deliveryDate ?? "交期未登记"}</small></td><td>{order.stages.flatMap(stage => stage.nodes).filter(node => node.current && ["active", "blocked"].includes(node.state)).map(node => <small key={node.instanceId}>{node.label} · {who(node.owner)}</small>)}{!order.stages.some(stage => stage.nodes.some(node => node.current && ["active", "blocked"].includes(node.state))) && "暂无在办节点"}</td><td>{orderStatus(order)}</td><td>{matchingNodes(order, context.kpi).map(node => <button className="journey-hit" key={node.instanceId} onClick={() => onChange({ selected: order.id, expanded: node.stage, focus: node.instanceId, round: undefined }, true)}>{node.label}{node.subject ? " · " + node.subject : ""}<small>{node.risks.map(risk => journeyRiskLabels[risk]).join(" / ") || nodeStatus(node)}</small></button>)}</td></tr>)}</tbody></BusinessTable></div>
      {!data && !error && <p role="status">正在读取订单…</p>}{data?.items.length === 0 && <p role="status">当前授权和筛选范围没有订单。</p>}<Pagination page={context.page} pageSize={20} total={data?.total ?? null} onPage={page => onChange({ page })} /></section>
    {detailError && <p role="alert">{detailError}</p>}{detailLoading && <p role="status">正在读取订单详情…</p>}{detail && !detailLoading && <JourneyDetail order={detail} asOf={data?.asOf} context={{ ...context, selected: detail.id }} onChange={patch => onChange(patch, true)} />}
  </div>;
}
