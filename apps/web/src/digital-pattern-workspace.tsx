import "./digital-kpi-density.css";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useState } from "react";
import { Button, Surface, StatusBadge } from "@dx-rework/ui";
import { FilterBar, KpiCard, PageHeader, Pagination } from "@dx-rework/ui/production";
import { PATTERN_LANES, PatternWorkspaceFilterSchema, type PatternWorkspaceFilter, type PatternWorkspaceResult, type PatternWorkspaceTask } from "@dx-rework/contracts/digital-development-workspace";
import type { DigitalTask } from "@dx-rework/contracts/digital-production-tasks";
import type { DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { digitalRequest } from "./digital-production-api.js";
import { DigitalTasksPanel } from "./digital-production-tasks-panel.js";
import { DevelopmentExecutionPanel } from "./digital-development-execution-panel.js";
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { digitalTaskView } from "./digital-task-view.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development-workspace.css";

const states = {uncreated: "尚未创建", pending: "条件未齐", active: "办理中", blocked: "受阻", completed: "已完成", cancelled: "已取消", inherited: "沿用", unavailable: "不可访问", not_applicable: "不适用"};
const date = (value: string | null) => value ? new Date(value).toLocaleString("sv-SE", {hour12: false, timeZone: "Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"}) : "未登记";
const duration = (seconds: number) => {if (!Number.isFinite(seconds)) return '时间待核实'; const minutes = Math.floor(Math.max(0, seconds) / 60), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60); return days ? `${days}天${hours ? `${hours}小时` : ''}` : hours ? `${hours}小时${minutes % 60 ? `${minutes % 60}分` : ''}` : `${minutes}分`;};
const stay = (task: PatternWorkspaceTask, asOf: string) => {
  if (!task.node.enteredAt) return "尚未启动计时";
  const end = ['completed','cancelled'].includes(task.node.state) ? task.node.actualAt : asOf;
  if (!end) return "停留时间待核实";
  return `停留 ${duration((Date.parse(end) - Date.parse(task.node.enteredAt)) / 1000)}`;
};
const deadline = (task: PatternWorkspaceTask) => task.node.expectedAt ? task.node.expectedPrecision === 'date' ? task.node.expectedAt.slice(0,10) : date(task.node.expectedAt) : task.node.sla === 'not_started' ? '未启动' : '未设时限';
function initialFilter(): PatternWorkspaceFilter {
  const parsed = PatternWorkspaceFilterSchema.safeParse(Object.fromEntries([...new URLSearchParams(window.location.search)].filter(([key]) => ["page", "search", "group", "lane", "owner", "state", "risk"].includes(key))));
  return parsed.success ? parsed.data : PatternWorkspaceFilterSchema.parse({});
}
export function DigitalPatternWorkspace() {
  const [filter, setFilter] = useState(initialFilter), [result, setResult] = useState<PatternWorkspaceResult | null>(null);
  const [options, setOptions] = useState<DigitalAccessOptions | null>(null), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("task"));
  const [selected, setSelected] = useState<DigitalTask | null>(null), [sheet, setSheet] = useState<DevelopmentSheet | null>(null), [detailError, setDetailError] = useState("");
  const [tab, setTab] = useState(new URLSearchParams(window.location.search).get("taskView") === "correct" ? "历史记录" : "基本信息"), [collapsed, setCollapsed] = useState(false);
  const urls = createWebUrls(import.meta.env.BASE_URL);
  const persist = (next: PatternWorkspaceFilter, task: string | null) => {
    const query = new URLSearchParams(Object.entries(next).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    if (task) query.set("task", task);
    window.history.replaceState(window.history.state, "", `${urls.pageUrl("ui/digital-pattern-room")}?${query}`);
  };
  useEffect(() => {
    let live = true; setError("");
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    void Promise.all([digitalRequest<PatternWorkspaceResult>(`workspaces/pattern?${query}`), digitalRequest<DigitalAccessOptions>("access/options")]).then(([data, access]) => {if (live) {setResult(data); setOptions(access);}}).catch(reason => {if (live) {setResult(null); setError(reason.message);}});
    return () => {live = false;};
  }, [filter, refresh]);
  useEffect(() => {
    let live = true; setSelected(null); setSheet(null); setDetailError("");
    if (selectedId) void digitalRequest<DigitalTask>(`tasks/${selectedId}`).then(async task => {
      if (!live) return;
      // A direct query cannot turn a non-development task into a board operation.
      if (!task.taskKind.startsWith("development_")) throw Error("该任务请在原业务入口办理");
      setSelected(task);
      if (task.sourceId) {const document = await digitalRequest<DevelopmentSheet>(`sources/${task.sourceId}/development?round=${task.routeVersion}`); if (live) setSheet(document);}
    }).catch(reason => {if (live) {setSelected(null); setSheet(null); setDetailError(reason.message);}});
    return () => {live = false;};
  }, [selectedId, refresh]);
  const update = (patch: Partial<PatternWorkspaceFilter>) => {const next = PatternWorkspaceFilterSchema.parse({...filter, page: 1, ...patch}); setFilter(next); setResult(null); setSelectedId(null); persist(next, null);};
  const changed = () => setRefresh(value => value + 1);
  const choose = (id: string) => {setSelectedId(id); setTab("基本信息"); setCollapsed(false); persist(filter,id);};
  const selectedNode = [...(result?.items ?? []), ...(result?.risks ?? [])].find(item => item.node.instanceId === selectedId);
  const view = digitalTaskView(window.location.search) === "correct" ? "correct" : selected && ["completed","cancelled"].includes(selected.state) ? "read" : "handle";
  const taskUrl = selected ? `${urls.pageUrl("ui/digital-production")}?task=${selected.taskId}&taskView=${view}&returnTo=${encodeURIComponent(window.location.pathname+window.location.search)}` : "";
  return <div className="pattern-workspace pattern-golden dx-production-refined">
    <div className="development-breadcrumb"><a href={urls.pageUrl('ui/digital-cockpit')}>生产管理座舱</a> › <strong>板房管理台</strong></div>
    <PageHeader title="板房管理台" description="按真实开发任务查看材料、交接与办理" actions={<Button onClick={changed}>刷新</Button>}/>
    {error && <p role="alert">{error}</p>}
    <div className="pattern-group-cards">{PATTERN_LANES.map((lane,index) => <KpiCard key={lane.key} icon={<NavigationIcon name={(["FileText","Shirt","Scissors","Settings","Shirt","ClipboardCheck","PackageCheck"] as const)[index]??"FileText"} />} className={`pattern-lane-kpi lane-${index}`} label={lane.label} value={result ? lane.groups.reduce((total,group) => total+result.counts[group],0) : "—"} detail="真实任务数" selected={filter.lane === lane.key} onClick={() => update({lane:filter.lane === lane.key ? undefined : lane.key,group:undefined})}/>)}</div>
    <div className="pattern-workspace-body"><section className="dx-production-panel pattern-task-list"><div className="pattern-board-title"><h2>开发进度看板</h2><span>{result ? `${result.archiveTotal} 款 · ${result.total} 项任务` : "读取中…"}</span>{(filter.lane || filter.group) && <Button onClick={() => update({lane:undefined,group:undefined})}>显示全部环节</Button>}</div>
    <div className="pattern-board-filters"><FilterBar as="div"><label>款号 / PO<input maxLength={100} value={filter.search} onChange={event => update({search: event.target.value})}/></label>
      <label>主办人<select value={filter.owner ?? ""} onChange={event => update({owner: event.target.value || undefined})}><option value="">全部主办</option>{result?.owners.map(owner => <option key={owner.id} value={owner.id}>{owner.name ?? "原主办人"}</option>)}</select></label>
      <label>任务状态<select value={filter.state} onChange={event => update({state: event.target.value as PatternWorkspaceFilter["state"]})}>{Object.entries({ongoing: "在办与待启动", all: "全部当前任务", pending: "条件未齐", active: "办理中", blocked: "受阻", completed: "已完成"}).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>风险<select value={filter.risk ?? ""} onChange={event => update({risk: (event.target.value || undefined) as PatternWorkspaceFilter["risk"]})}><option value="">全部风险</option><option value="overdue">超时</option><option value="due_soon">临期</option><option value="blocked">受阻</option><option value="unknown">时间待核实</option></select></label>
    </FilterBar><p>{result ? `${result.archiveTotal} 个开发档案 · ${result.total} 项真实任务` : "正在读取授权任务…"}</p></div>
      <div className="pattern-board-scroll" role="region" aria-label="开发环节看板，可横向滚动查看全部环节" tabIndex={0}><div className={`pattern-board-columns ${filter.lane || filter.group ? "is-filtered" : ""}`}>{PATTERN_LANES.filter(lane => (!filter.lane || lane.key === filter.lane) && (!filter.group || (lane.groups as readonly string[]).includes(filter.group))).map(lane => <section className={`pattern-board-column lane-${lane.key}`} key={lane.key}><h3><i aria-hidden="true"><NavigationIcon name={({materials:'FileText',pattern:'Shirt',cutting:'Scissors',craft:'Settings',sewing:'Shirt',check:'ClipboardCheck',shipping:'PackageCheck'} as const)[lane.key]} /></i>{lane.label} <span>{result ? lane.groups.reduce((total,group) => total+result.counts[group],0) : "—"}</span></h3>
      <div className="pattern-lane-cards">{result?.items.filter(task => (lane.groups as readonly string[]).includes(task.group)).map(task => <button type="button" key={task.node.instanceId} aria-pressed={selectedId === task.node.instanceId} className={`pattern-task-card ${task.node.risks.includes("overdue") ? "is-overdue" : ""}`} onClick={() => choose(task.node.instanceId)}>
        <strong>{task.designStyleNo}</strong><small>{task.customer ?? "通用开发"} · 第 {task.node.round ?? 1} 轮</small><small>{task.node.label}</small><small>当前主办：{task.node.owner?.name ?? "待派工"}</small>
        <StatusBadge tone={task.node.risks.includes("overdue") || task.node.state === "blocked" ? "danger" : task.node.state === "completed" ? "success" : "info"}>{task.node.risks.includes("overdue") ? "超时" : states[task.node.state]}</StatusBadge>
        <small>{result ? stay(task,result.asOf) : '计时读取中'}</small>
        <small title={task.node.expectedAt ?? undefined}>截止 {deadline(task)}</small>
      </button>)}</div>
      {result && !result.items.some(task => (lane.groups as readonly string[]).includes(task.group)) && <p>{lane.groups.some(group => result.counts[group] > 0) ? "本页无此环节任务" : "暂无任务"}</p>}
      {!filter.lane && <button className="development-text-action pattern-lane-more" onClick={() => update({lane:lane.key,group:undefined})}>查看全部</button>}
      </section>)}</div></div>{!filter.lane && !filter.group && <p className="pattern-board-scroll-hint">横向滚动看板可查看全部七个环节</p>}
      {!result && !error && <p role="status">正在读取授权任务…</p>}{result && !result.items.length && <p>当前筛选暂无真实任务</p>}
      <Pagination page={filter.page} pageSize={20} total={result?.total ?? null} onPage={page => update({page})}/>
    </section><aside className="dx-production-panel pattern-risk-panel"><h2>风险与 SLA</h2><div className="pattern-risk-filters">{[['','全部'],['overdue','超时'],['due_soon','临期'],['blocked','受阻']] .map(([key,label]) => <button key={key} aria-pressed={(filter.risk ?? '') === key} onClick={() => update({risk:(key || undefined) as PatternWorkspaceFilter['risk']})}>{label} {result ? (result.risks ?? []).filter(task => !key || task.node.risks.some(risk => risk === key)).length : '—'}</button>)}</div><div className="pattern-risk-list">{result?.risks?.map(task => <button className={task.node.risks.includes('overdue') ? 'is-overdue' : ''} key={task.node.instanceId} onClick={() => choose(task.node.instanceId)}><strong>{task.node.label} · {task.node.risks.map(risk => ({overdue:"超时",due_soon:"临期",blocked:"受阻",unknown:"时间待核实"})[risk]).join(' / ')}{task.node.overdueSeconds !== null && task.node.overdueSeconds > 0 ? ` ${duration(task.node.overdueSeconds)}` : ''}</strong><span>{task.designStyleNo} · {task.customer ?? '通用开发'}</span><span>负责人：{task.node.owner?.name ?? '待派工'}</span><span>{result ? stay(task,result.asOf) : ''} · 截止 {deadline(task)}</span>{task.node.blockers.length > 0 && <span className="pattern-risk-reason">{task.node.blockers.map(item => item.label).join('；')}</span>}</button>)}{result && !result.risks?.length && <p>当前筛选无风险任务</p>}</div><small>计数仅为本栏命中，最多 20 项</small></aside></div>
    <section className="dx-production-panel pattern-task-detail" aria-label="选中任务详情">
      {!selectedId && <p className="development-empty">选择任务，就近查看基础资料、面辅料、交接与原办理。</p>}
      {detailError && <p role="alert">{detailError}</p>}
      {selectedId && !selected && !detailError && <p role="status">正在读取任务…</p>}
      {selected && options && <><header className="pattern-detail-heading"><h2>{sheet?.designStyleNo ?? selected.identity?.designStyleNo ?? '原任务'} <small>{sheet?.customerCode ?? selected.identity?.customerCode ?? '通用开发'} · 第 {selected.routeVersion} 轮</small> {selectedNode?.node.risks.length ? <StatusBadge tone={selectedNode.node.risks.includes('overdue') || selectedNode.node.risks.includes('blocked') ? 'danger' : 'warning'}>{selectedNode.node.risks.map(risk => ({overdue:'超时',due_soon:'临期',blocked:'受阻',unknown:'待核实'})[risk]).join(' / ')}</StatusBadge> : null}</h2><button className="development-text-action" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? '展开' : '收起'}</button></header>
      {!collapsed && <><nav className="development-tabs" aria-label="板房任务资料">{['基本信息','面辅料情况','当前交接','历史记录'].map(label => <button key={label} aria-pressed={tab === label} onClick={() => setTab(label)}>{label}</button>)}</nav>
      {tab === '基本信息' && <div className="pattern-detail-columns"><section><h3>基本信息</h3><dl><dt>款号</dt><dd>{sheet?.designStyleNo ?? selected.identity?.designStyleNo ?? '无可见资料'}</dd><dt>开发类型</dt><dd>{sheet?.developmentType ?? '未读取'}</dd><dt>当前环节</dt><dd>{selected.label}</dd><dt>主办人</dt><dd>{selected.assigneeName ?? '待派工'}</dd><dt>截止时间</dt><dd>{selected.slaHours === null ? '无时限' : date(selected.dueAt)}</dd></dl></section><section><h3>面辅料情况</h3><div className="pattern-material-summary">{sheet?.document?.materials.filter(material => material.requiredThisRound).map(material => <p key={material.materialId}><strong>{material.category} · {material.label || material.name}</strong><span>{material.available || sheet.materialEvents.some(event => event.materialId === material.materialId && ['到货','确认代用'].includes(event.action)) ? '已登记到料 / 代用' : '尚缺到料记录'}</span></p>)}{!sheet?.document?.materials.some(material => material.requiredThisRound) && <p>本轮无可见必需材料记录</p>}</div></section><section><h3>当前交接</h3><dl><dt>任务</dt><dd>{selected.label}</dd><dt>进入</dt><dd>{date(selected.enteredAt)}</dd><dt>状态</dt><dd>{selected.state === 'ready' ? '可办理' : selected.state === 'completed' ? '已完成' : selected.state === 'blocked' ? '受阻' : selected.state === 'pending' ? '待前置' : '已取消'}</dd><dt>本轮完成</dt><dd>{selected.routeProgress.completed} / {selected.routeProgress.applicable}</dd><dt>缺项</dt><dd>{selected.blockedReason || selectedNode?.node.blockers.map(item => item.label).join('；') || '无已记录阻断'}</dd></dl></section><section className="pattern-quick-actions"><h3>快捷操作</h3><Button variant="primary" onClick={() => setTab('当前交接')}>{view === 'handle' ? '进入原办理 / 交接' : '查看任务记录'}</Button>{selected.canManage && view === 'handle' && <Button onClick={() => setTab('当前交接')}>查看分派 / 改派</Button>}<Button onClick={() => setTab('历史记录')}>查看历史</Button><a href={taskUrl}>打开原任务详情</a></section></div>}
      {tab === '面辅料情况' && <div className="pattern-material-table development-table-scroll"><BusinessMaterials sheet={sheet}/></div>}
      {['当前交接','历史记录'].includes(tab) && <div className="pattern-detail-operation"><DigitalTasksPanel key={`${selected.taskId}:${refresh}:${tab}`} options={options} taskId={selected.taskId} compact view={tab === '历史记录' && view === 'handle' ? 'read' : view} onChanged={changed}/>{tab === '当前交接' && view === 'handle' && selected.sourceId && sheet?.status === 'published' && selected.routeVersion === (sheet.latestRoundNumber ?? 1) && <Surface><DevelopmentExecutionPanel key={`${selected.taskId}:${refresh}`} sourceId={selected.sourceId} materialRevision={sheet.materialEvents.length} taskId={selected.taskId} onChanged={changed}/></Surface>}</div>}
      </>}
      </>}
    </section>
  </div>;
}
function BusinessMaterials({sheet}: {sheet: DevelopmentSheet | null}) {
  return <table><thead><tr><th>材料</th><th>规格 / 数量</th><th>到料事实</th><th>原计划日期</th></tr></thead><tbody>{sheet?.document?.materials.filter(material => material.requiredThisRound).map(material => <tr key={material.materialId}><td>{material.category} · {material.label || material.name}</td><td>{material.specification || '—'} · {material.quantity || '—'}</td><td>{material.available || sheet.materialEvents.some(event => event.materialId === material.materialId && ['到货','确认代用'].includes(event.action)) ? '已登记到料/代用' : '尚缺到料记录'}</td><td>{sheet.materialEvents.filter(event => event.materialId === material.materialId && event.action === '修改预计日期').at(-1)?.expectedDate ?? material.expectedDate ?? '未登记'}</td></tr>)}</tbody></table>;
}
