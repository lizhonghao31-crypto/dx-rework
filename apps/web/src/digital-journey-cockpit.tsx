import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Button, StatusBadge, type Tone } from "@dx-rework/ui";
import { ActivityLog, BusinessTable, DocumentList, FilterBar, FlowStageCard, KpiCard, NodeTable, PageHeader, Pagination } from "@dx-rework/ui/production";
import { JOURNEY_NODES, JOURNEY_STAGES, type JourneyNode, type JourneyRecord, type JourneyResult, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { createWebUrls } from "../url-contract.js";
import { journeyRiskLabels, journeyStateLabels, journeyRecordHref, journeyTime, matchingNodes, nodeStatus, orderStatus, stageStatus, stageTimes, journeyDocumentGroups, type CockpitContext } from "./digital-journey-cockpit-model.js";
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
  return <FilterBar className="journey-filters" onSubmit={event => { event.preventDefault(); onChange({ ...draft, page: 1 }); }}>
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
function NodeRows({ nodes, context, asOf, onChange }: { nodes: JourneyNode[]; context: CockpitContext; asOf: string | undefined; onChange: (patch: Partial<CockpitContext>) => void }) {
  return <NodeTable className="journey-node-table"><colgroup><col className="node-name"/><col className="node-owner"/><col className="node-status"/><col className="node-time"/><col className="node-time"/><col className="node-record"/></colgroup>
    <thead><tr><th>节点 / 轮次</th><th>负责人</th><th>状态</th><th>预计完成时间</th><th>实际完成时间</th><th>查看 / 办理</th></tr></thead>
    <tbody>{nodes.map(node => {
      const open = context.focus === node.instanceId;
      return <Fragment key={node.instanceId}><tr id={"journey-node-" + node.instanceId} className={open ? "is-focused" : undefined}>
        <td><button className="journey-node-toggle" aria-expanded={open} aria-controls={"journey-node-detail-" + node.instanceId} onClick={() => onChange({ focus: open ? undefined : node.instanceId })}><span aria-hidden="true">{open ? "▾" : "▸"}</span>{node.label}</button><small>{node.subject || (node.round ? `第 ${node.round} 轮` : "")}{!node.current ? " · 历史" : ""}</small></td>
        <td title={who(node.owner)}>{who(node.owner)}</td><td title={nodeStatus(node, asOf)}><StatusBadge tone={nodeTone(node)}>{nodeStatus(node, asOf)}</StatusBadge></td>
        <td className={node.risks.includes("overdue") ? "journey-overdue" : undefined}>{node.state === "not_applicable" ? "不适用" : node.state === "unavailable" ? "无可见时间" : journeyTime(node.expectedAt, node.expectedPrecision)}</td>
        <td className={node.completionResult === "late" ? "journey-overdue" : undefined}>{node.state === "not_applicable" ? "不适用" : journeyTime(node.actualAt, "instant", node.state === "completed" ? "未知" : "—")}</td>
        <td>{node.records.length === 1 ? <RecordLink record={node.records[0]!} context={context}/> : node.records.length > 1 ? <button className="journey-text-action" onClick={() => onChange({ focus: node.instanceId })}>选择记录 ({node.records.length})</button> : <span className="journey-muted">尚无记录</span>}</td>
      </tr>{open && <tr className="journey-node-expanded" id={"journey-node-detail-" + node.instanceId}><td colSpan={6}><div className="journey-node-extra">
        <div><strong>{node.label}{node.round ? ` · 第 ${node.round} 轮` : ""}{node.occurrence ? ` · 第 ${node.occurrence} 次` : ""}</strong>
          <p>{node.operator ? `实际操作者：${who(node.operator)}` : "尚无实际操作者记录"}{node.actualQuality === "unverified" ? " · 完成时间待核实" : ""}</p>
          <p>{node.expectedKind === "plan" ? "原计划目标，办理计时尚未启动" : node.sla === "running" ? "按原办理时限计时" : node.sla === "finished" ? "原办理计时已结束" : node.sla === "not_started" ? "尚未进入办理计时" : "尚无办理时限"}</p>
          {node.blockers.length > 0 && <ul>{node.blockers.map((blocker, index) => <li key={blocker.key + index}>{blocker.label}{blocker.record?.url && <> · <RecordLink record={blocker.record} context={context}>查看前置记录</RecordLink></>}</li>)}</ul>}
          {node.inheritedFrom && <p>沿用第 {node.inheritedFrom.round} 轮 · 原任务 {node.inheritedFrom.taskId}</p>}
          {node.assignmentHistory.length > 0 && <details><summary>改派历史 ({node.assignmentHistory.length})</summary>{node.assignmentHistory.map((item, index) => <p key={item.at + index}>{journeyTime(item.at)} · {item.from ?? "未指派"} → {item.to ?? "未指派"} · 操作人 {item.actorId}</p>)}</details>}
        </div><div className="journey-node-records">{node.records.map((record, index) => <RecordLink key={record.domain + record.id + index} record={record} context={context}>{recordLabel(record)}{record.version ? ` · v${record.version}` : ""}{record.lineId ? ` · 明细 ${record.lineId.slice(-8)}` : ""} · {record.mode === "handle" ? "办理" : "查看"}</RecordLink>)}</div>
      </div></td></tr>}</Fragment>;
    })}</tbody></NodeTable>;
}
const recordNames: Record<string, string> = { task: "原任务", development: "开发单", order: "订购信息", instruction: "大货制单", budget: "预算", sourcing: "外发审批 / 合同", cutting: "裁床实裁", receiving: "回货记录", closure: "回货与结案", production: "实际生产记录", preparation: "产前准备", rework: "返工记录", development_material: "面辅料记录" };
const recordLabel = (record: JourneyRecord) => recordNames[record.domain] ?? "原业务记录";
function JourneyDetail({ order, context, onChange, asOf, actions }: { order: OrderJourney; context: CockpitContext; onChange: (patch: Partial<CockpitContext>) => void; asOf: string | undefined; actions: ReactNode }) {
  const nodes = order.stages.flatMap(stage => stage.nodes);
  const current = nodes.filter(node => node.current);
  const active = current.filter(node => ["active", "blocked"].includes(node.state));
  const risks = current.filter(node => node.risks.length || node.state === "blocked");
  const [nodeFilter, setNodeFilter] = useState("all");
  const [search, setSearch] = useState(context.search);
  const [businessTab, setBusinessTab] = useState("订单总览");
  const expanded = (context.expanded ?? "").split(",").filter(key => order.stages.some(stage => stage.key === key));
  const flowCollapsed = context.flow === "collapsed";
  const selectedNode = nodes.find(node => node.instanceId === context.focus) ?? active[0] ?? current.find(node => node.state !== "unavailable");
  const focus = (node: JourneyNode) => { setNodeFilter("all"); onChange({ expanded: node.stage, focus: node.instanceId }); };
  useEffect(() => { window.scrollTo(0, 0); setBusinessTab("订单总览"); setNodeFilter("all"); }, [order.id]);
  const rounds = [...new Set(order.stages.find(stage => stage.key === "development")?.nodes.map(node => node.round).filter((value): value is number => value !== null) ?? [])].sort((a, b) => b - a);
  const groups = journeyDocumentGroups(order);
  const records = groups.flatMap(group => group.entries);
  const tabDomains: Record<string, string[]> = { "开发表样": ["development", "development_material"], "大货生产": ["instruction", "preparation", "cutting", "production"], "外发管理": ["sourcing"], "质检管理": ["receiving", "closure"] };
  const tabRecords = records.filter(entry => tabDomains[businessTab]?.includes(entry.record.domain) && Boolean(journeyRecordHref(entry.record.url ?? "", context)));
  const activities = nodes.flatMap(node => [
    ...(node.enteredAt ? [{ key: node.instanceId + ":entered:" + node.enteredAt, at: node.enteredAt, label: node.label + "进入办理", person: who(node.owner), node }] : []),
    ...(node.actualAt ? [{ key: node.instanceId + ":done:" + node.actualAt, at: node.actualAt, label: node.label + (node.actualQuality === "unverified" ? "补报完成（待核实）" : "完成"), person: who(node.operator ?? node.owner), node }] : []),
    ...node.assignmentHistory.map((item, index) => ({ key: node.instanceId + ":assignment:" + item.at + index, at: item.at, label: node.label + "改派", person: item.actorId, node })),
  ]).sort((a, b) => b.at.localeCompare(a.at));
  const filterNodes = expanded.length ? nodes.filter(node => expanded.includes(node.stage)) : nodes;
  const filters = [{key:"all",label:"全部节点"},{key:"completed",label:"已完成"},{key:"active",label:"进行中"},{key:"not_started",label:"未开始"},{key:"overdue",label:"逾期"}];
  const matches = (node: JourneyNode, key: string) => key === "all" || (key === "overdue" ? node.risks.includes("overdue") : key === "completed" ? ["completed", "inherited"].includes(node.state) : key === "not_started" ? ["uncreated", "pending"].includes(node.state) : node.state === key);
  const visibleNodes = filterNodes.filter(node => matches(node, nodeFilter));
  const progress = order.progress.bulk ?? order.progress.development;
  const progressLabel = order.progress.bulk ? "大货节点进度" : "开发节点进度";
  const percent = progress && progress.applicable ? Math.round(progress.completed / progress.applicable * 100) : null;
  const progressNodes = current.filter(node => node.countsInProgress && (order.progress.bulk ? node.stage !== "development" && node.stage !== "creation" : node.stage === "development"));
  const metrics = [
    {label:"订单总数",value:quantity(order),detail:"原订购数量",icon:"▦",color:"blue"},
    {label:"开发节点完成",value:order.progress.development ? `${order.progress.development.completed} / ${order.progress.development.applicable}` : "—",detail:order.progress.development ? "已完成 / 适用节点" : "尚无可见适用路线",icon:"▣",color:"green"},
    {label:"大货节点完成",value:order.progress.bulk ? `${order.progress.bulk.completed} / ${order.progress.bulk.applicable}` : "—",detail:order.progress.bulk ? "已完成 / 适用节点" : "尚无可见适用路线",icon:"◷",color:"blue"},
    {label:"计划交货日期",value:order.deliveryDate ?? "未登记",detail:"原订单交期",icon:"▤",color:"purple"},
    {label:"订单状态",value:orderStatus(order),detail:"原业务节点状态",icon:"▣",color:"green"},
    {label:"风险预警",value:`${risks.length} 项`,detail:"查看详情 ›",icon:"⚠",color:"red"},
  ];
  return <section className="journey-detail journey-golden" id="journey-detail-top" aria-label="订单全景详情">
    <form className="journey-global-search" onSubmit={event => {event.preventDefault();onChange({search,page:1,selected:undefined,expanded:undefined,focus:undefined,round:undefined});}}><span aria-hidden="true">⌕</span><input aria-label="搜索订单" value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索单号、客户、款号、款名、PO、跟单…"/><Button type="submit" variant="primary">⌕ 搜索</Button></form>
    <div className="journey-detail-toolbar"><div><button className="journey-text-action" onClick={() => onChange({ selected: undefined, expanded: undefined, focus: undefined, round: undefined })}>‹ 生产管理总览</button><span> › 订单详情</span></div><div className="journey-detail-actions">{actions}</div></div>
    <div className="journey-order-heading"><div><h1>{order.designStyleNo}<StatusBadge tone={tone(orderStatus(order) === "受阻" ? "blocked" : orderStatus(order) === "整单已完成" ? "completed" : "active")}>{orderStatus(order)}</StatusBadge><span className="journey-order-kind">{order.orderId ? "大货订单" : "产品开发"}</span></h1><p>{order.styleName ?? "款名未登记"}<span>客户：{order.customer ?? "未登记"}</span><span>跟单：{order.merchandisers.map(person=>person.name??person.id).join(" / ")||"未指派"}</span><span>下单总数：{quantity(order)}</span><span>交货日期：{order.deliveryDate??"未登记"}</span></p></div>{order.sourceId && rounds.length > 1 && <label>开发轮次<select aria-label="开发轮次" value={context.round ?? order.selectedRound ?? rounds[0]} onChange={event => onChange({ round: Number(event.target.value), expanded: "development", focus: undefined })}>{rounds.map(round => <option key={round} value={round}>第 {round} 轮{round === order.adoptedRound ? " · 大货采用" : ""}</option>)}</select></label>}</div>
    <section className="journey-order-summary"><nav className="journey-business-tabs" aria-label="订单业务页签">{["订单总览",...Object.keys(tabDomains).filter(label=>records.some(entry=>tabDomains[label]?.includes(entry.record.domain)&&Boolean(journeyRecordHref(entry.record.url??"",context))))].map(label=>{return <button key={label} className={businessTab===label?"is-selected":undefined} title={label} onClick={()=>setBusinessTab(label)}>{label}</button>;})}</nav>
      {businessTab!=="订单总览" && <div className="journey-tab-records" aria-label={businessTab+"原记录"}>{tabRecords.map(entry=><RecordLink key={entry.key} record={entry.record} context={context}>{entry.label}</RecordLink>)}</div>}
      <div className="journey-order-metrics" aria-label="订单指标">{metrics.map(metric=><article key={metric.label} className={"journey-metric is-"+metric.color}><span className="journey-metric-icon" aria-hidden="true">{metric.icon}</span><div><span>{metric.label}</span><strong>{metric.value}</strong>{metric.color==="red"?<button className="journey-text-action" onClick={()=>document.getElementById("journey-risks")?.focus()}>{metric.detail}</button>:<small>{metric.detail}</small>}</div></article>)}</div>
    </section>
    <section className={"dx-production-panel journey-flow-panel" + (flowCollapsed ? " is-collapsed" : "")} aria-label="订单全流程"><div className="journey-section-title"><h2>订单全流程总览</h2><div className="journey-flow-legend"><span className="is-completed">● 已完成</span><span className="is-active">● 进行中</span><span>● 未开始</span><span className="journey-overdue">● 逾期</span></div><button className="journey-text-action" aria-expanded={!flowCollapsed} onClick={()=>onChange({flow:flowCollapsed?"expanded":"collapsed"})}>{flowCollapsed?"展开流程时间 ⌄":"收起流程时间 ⌃"}</button></div>
      <div className="journey-flow">{order.stages.map((stage,index)=>{const times=stageTimes(stage);return <div className={expanded.includes(stage.key)?"journey-stage-wrap is-expanded":"journey-stage-wrap"} key={stage.key}><span className={"journey-stage-number is-"+stage.state} aria-hidden="true">{stage.state==="completed"?"✓":index+1}</span><FlowStageCard title={`${index+1}. ${stage.label}`} status={stageStatus(stage,asOf)} tone={stage.nodes.some(node=>node.current&&node.risks.includes("overdue"))?"danger":tone(stage.state)} expectedAt={times.expected} actualAt={times.actual}><button className="journey-stage-toggle" aria-label={stage.label+"节点明细"} aria-pressed={expanded.includes(stage.key)} onClick={()=>{setNodeFilter("all");onChange({expanded:expanded.includes(stage.key)?"":stage.key,focus:undefined});}}><span className="journey-visually-hidden">查看节点明细</span></button></FlowStageCard></div>;})}</div>
    </section>
    <div className="journey-three-columns">
      <section className="dx-production-panel journey-current-panel" aria-label="当前节点详情"><div className="journey-section-title"><h2>当前节点详情：{selectedNode?.label??"暂无在办节点"}</h2>{selectedNode&&<StatusBadge tone={nodeTone(selectedNode)}>{nodeStatus(selectedNode,asOf)}</StatusBadge>}</div>
        {active.length>1&&<div className="journey-parallel-nodes" aria-label="并行在办节点">{active.map(node=><button key={node.instanceId} className="journey-text-action" onClick={()=>focus(node)}>{node.label} · {who(node.owner)}</button>)}</div>}
        {selectedNode?<div className="journey-current-body"><dl><div><dt>负责人：</dt><dd>{who(selectedNode.owner)}</dd></div><div><dt>预计完成：</dt><dd>{journeyTime(selectedNode.expectedAt,selectedNode.expectedPrecision)}</dd></div><div><dt>实际完成：</dt><dd>{journeyTime(selectedNode.actualAt,"instant","—")}</dd></div><div><dt>轮次 / 次数：</dt><dd>{selectedNode.round??"—"} / {selectedNode.occurrence??"—"}</dd></div></dl><div className="journey-current-context"><p>前置情况：{selectedNode.blockers.map(blocker=>blocker.label).join("；")||"未记录阻断"}</p><p>实际操作者：{selectedNode.operator ? who(selectedNode.operator) : "尚无记录"}</p><p>资料版本：开发 {order.sourceVersion===null?"未登记":"v"+order.sourceVersion} · 制单 {order.instructionVersion===null?"未发布":"v"+order.instructionVersion}</p><div className="journey-current-records">{selectedNode.records.map((record,index)=><RecordLink key={record.id+index} record={record} context={context}>{recordLabel(record)}{record.version?` · v${record.version}`:""} ›</RecordLink>)}{records.filter(entry=>entry.record.domain==="development").slice(0,2).map(entry=><RecordLink key={entry.key} record={entry.record} context={context}>{entry.label} ›</RecordLink>)}</div></div></div>:<p>当前没有可见在办事实。</p>}
      </section>
      <section className="dx-production-panel journey-progress-panel"><h2>订单进度</h2><div className="journey-progress-body"><div className="journey-progress-ring" role="img" aria-label={progressLabel+(percent===null?"未知":percent+"%") }><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="40" fill="none" stroke="#e8f2fb" strokeWidth="9"/><circle cx="50" cy="50" r="40" fill="none" stroke="#00b985" strokeWidth="9" pathLength="100" strokeDasharray={`${percent??0} 100`} transform="rotate(-90 50 50)"/></svg><div><strong>{percent===null?"—":percent+"%"}</strong><small>{progressLabel}</small></div></div><dl>{[{label:"已完成",key:"completed",color:"green"},{label:"进行中",key:"active",color:"blue"},{label:"未开始",key:"not_started",color:"gray"},{label:"逾期",key:"overdue",color:"red"}].map(item=><div key={item.key}><dt><i className={"is-"+item.color}/>{item.label}</dt><dd>{progressNodes.filter(node=>matches(node,item.key)).length}</dd></div>)}</dl></div></section>
      <section className="dx-production-panel journey-risk-panel" id="journey-risks" tabIndex={-1}><div className="journey-section-title"><h2>风险与异常</h2><strong className="journey-overdue">{risks.length} 项风险</strong></div><div className="journey-risk-viewport">{risks.length?risks.map((node,index)=><button className="journey-risk-item" key={node.instanceId} onClick={()=>focus(node)}><b>{index+1}</b><div><strong>{node.label}{node.subject?" · "+node.subject:""}</strong><span>{node.risks.map(risk=>journeyRiskLabels[risk]).join(" / ")||"受阻"}</span><small>{node.blockers.map(blocker=>blocker.label).join("；")||who(node.owner)}</small></div></button>):<p>当前可见节点暂无风险。</p>}</div></section>
      <section className="dx-production-panel journey-node-panel" aria-label="小流程明细"><div className="journey-node-tabs">{filters.map(item=><button key={item.key} className={nodeFilter===item.key?"is-selected":undefined} onClick={()=>setNodeFilter(item.key)}>{item.label}（{filterNodes.filter(node=>matches(node,item.key)).length}）</button>)}<button className="journey-text-action" onClick={()=>{setNodeFilter("all");onChange({expanded:"",focus:undefined});}}>显示全部</button></div><div className="journey-node-viewport" tabIndex={0} aria-label="节点明细纵向浏览"><NodeRows nodes={visibleNodes} context={context} asOf={asOf} onChange={onChange}/></div></section>
      <div className="journey-documents-panel"><DocumentList><div className="journey-documents-viewport">{records.length?records.map(entry=><div className="journey-document" key={entry.key}><span aria-hidden="true">▧</span><span>{recordLabel(entry.record)}</span><RecordLink record={entry.record} context={context}>{entry.label}</RecordLink></div>):<p>尚无可见单据。</p>}</div></DocumentList></div>
      <div className="journey-activity-panel"><ActivityLog><ol className="journey-activities">{activities.map(activity=><li key={activity.key}><time>{journeyTime(activity.at)}</time><span>{activity.person}</span><button className="journey-text-action" onClick={()=>focus(activity.node)}>{activity.label}</button></li>)}{!activities.length&&<li>尚无可见操作事实。</li>}</ol></ActivityLog></div>
    </div>
  </section>;
}
type Props = { data: JourneyResult | null; error: string; detail: OrderJourney | null; detailError: string; detailLoading: boolean; context: CockpitContext; onChange: (patch: Partial<CockpitContext>, preserveSelection?: boolean) => void; actions: ReactNode };
export function DigitalJourneyCockpit({ data, error, detail, detailError, detailLoading, context, onChange, actions }: Props) {
  if (context.selected) return <div className="digital-journey-cockpit dx-production-refined" data-view="order">{detail && !detailLoading && !detailError ? <JourneyDetail order={detail} asOf={data?.asOf} context={{ ...context, selected: detail.id }} onChange={patch => onChange(patch, true)} actions={actions}/> : <section className="dx-production-panel"><button className="journey-text-action" onClick={() => onChange({selected: undefined, expanded: undefined, focus: undefined, round: undefined}, true)}>‹ 返回订单总览</button>{detailError ? <p role="alert">{detailError}</p> : <p role="status">正在读取订单全景…</p>}</section>}</div>;
  return <div className="digital-journey-cockpit dx-production-refined" data-view="overview"><PageHeader title="生产管理座舱" description="订单全生命周期" actions={actions}/>
    <section className="journey-kpis" aria-label="订单筛选 KPI">{kpis.map(kpi => <KpiCard key={kpi.key} label={kpi.label} value={data?.summary[kpi.field] ?? "—"} detail={kpi.detail} tone={kpi.tone} selected={context.kpi === kpi.key} onClick={() => onChange({ kpi: kpi.key })}/>)}</section>
    <CockpitFilters context={context} data={data} onChange={onChange}/>{error && <p role="alert">{error}</p>}
    <section className="dx-production-panel journey-orders" aria-label="订单列表" aria-busy={!data && !error}><div className="journey-section-title"><h2>订单总览</h2><span className="journey-muted">{data ? `${data.total} 个授权订单 · 同单异常不重复计数` : "正在读取…"}</span></div><div className="journey-orders-viewport"><BusinessTable><thead><tr><th>款号 / 款名</th><th>客户 / 类型</th><th>订购量 / 交期</th><th>在办事项</th><th>状态</th><th>命中原因</th></tr></thead><tbody>{data?.items.map(order => <tr key={order.id}><td><button className="journey-order-select" onClick={() => onChange({ selected: order.id, round: undefined, expanded: "", focus: undefined }, true)}>{order.designStyleNo}</button><small>{order.styleName ?? "款名未登记"}</small></td><td>{order.customer ?? "客户未登记"}<small>{order.orderId ? "大货订单" : "产品开发"}</small></td><td>{quantity(order)}<small>{order.deliveryDate ?? "交期未登记"}</small></td><td><details className="journey-list-work"><summary>{order.stages.flatMap(stage => stage.nodes).filter(node => node.current && ["active", "blocked"].includes(node.state)).length} 项在办 / 受阻</summary>{order.stages.flatMap(stage => stage.nodes).filter(node => node.current && ["active", "blocked"].includes(node.state)).map(node => <button className="journey-text-action" key={node.instanceId} onClick={() => onChange({ selected: order.id, expanded: node.stage, focus: node.instanceId, round: undefined }, true)}>{node.label} · {who(node.owner)}</button>)}</details></td><td><StatusBadge tone={tone(orderStatus(order) === "受阻" ? "blocked" : orderStatus(order) === "整单已完成" ? "completed" : "active")}>{orderStatus(order)}</StatusBadge></td><td><div className="journey-hits">{matchingNodes(order, context.kpi).map(node => <button className="journey-hit" key={node.instanceId} onClick={() => onChange({ selected: order.id, expanded: node.stage, focus: node.instanceId, round: undefined }, true)}>{node.label}<small>{node.risks.map(risk => journeyRiskLabels[risk]).join(" / ") || nodeStatus(node)}</small></button>)}</div></td></tr>)}</tbody></BusinessTable></div>
      {!data && !error && <p role="status">正在读取订单…</p>}{data?.items.length === 0 && <p role="status">当前授权和筛选范围没有订单。</p>}<Pagination page={context.page} pageSize={20} total={data?.total ?? null} onPage={page => onChange({ page })}/></section>
  </div>;
}
