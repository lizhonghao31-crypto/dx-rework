import { useEffect, useState } from "react";
import { Button, Surface, StatusBadge } from "@dx-rework/ui";
import { FilterBar, KpiCard, PageHeader, Pagination } from "@dx-rework/ui/production";
import { PATTERN_GROUPS, PatternWorkspaceFilterSchema, type PatternWorkspaceFilter, type PatternWorkspaceResult } from "@dx-rework/contracts/digital-development-workspace";
import type { DigitalTask } from "@dx-rework/contracts/digital-production-tasks";
import type { DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { digitalRequest } from "./digital-production-api.js";
import { DigitalTasksPanel } from "./digital-production-tasks-panel.js";
import { DevelopmentExecutionPanel } from "./digital-development-execution-panel.js";
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development-workspace.css";

const states = {uncreated: "尚未创建", pending: "条件未齐", active: "办理中", blocked: "受阻", completed: "已完成", cancelled: "已取消", inherited: "沿用", unavailable: "不可访问", not_applicable: "不适用"};
const date = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", {hour12: false, timeZone: "Asia/Shanghai"}) : "未登记";
function initialFilter(): PatternWorkspaceFilter {
  const parsed = PatternWorkspaceFilterSchema.safeParse(Object.fromEntries([...new URLSearchParams(window.location.search)].filter(([key]) => ["page", "search", "group", "owner", "state", "risk"].includes(key))));
  return parsed.success ? parsed.data : PatternWorkspaceFilterSchema.parse({});
}
export function DigitalPatternWorkspace() {
  const [filter, setFilter] = useState(initialFilter), [result, setResult] = useState<PatternWorkspaceResult | null>(null);
  const [options, setOptions] = useState<DigitalAccessOptions | null>(null), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("task"));
  const [selected, setSelected] = useState<DigitalTask | null>(null), [sheet, setSheet] = useState<DevelopmentSheet | null>(null), [detailError, setDetailError] = useState("");
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
  return <div className="pattern-workspace pattern-orders digital-production">
    <PageHeader title="板房管理台" description="按真实开发任务查看材料、交接与办理" actions={<Button onClick={changed}>刷新</Button>}/>
    {error && <p role="alert">{error}</p>}
    <Surface><FilterBar as="div"><label>款号 / PO<input maxLength={100} value={filter.search} onChange={event => update({search: event.target.value})}/></label>
      <label>主办人<select value={filter.owner ?? ""} onChange={event => update({owner: event.target.value || undefined})}><option value="">全部主办</option>{result?.owners.map(owner => <option key={owner.id} value={owner.id}>{owner.name ?? "原主办人"}</option>)}</select></label>
      <label>任务状态<select value={filter.state} onChange={event => update({state: event.target.value as PatternWorkspaceFilter["state"]})}>{Object.entries({ongoing: "在办与待启动", all: "全部当前任务", pending: "条件未齐", active: "办理中", blocked: "受阻", completed: "已完成"}).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>风险<select value={filter.risk ?? ""} onChange={event => update({risk: (event.target.value || undefined) as PatternWorkspaceFilter["risk"]})}><option value="">全部风险</option><option value="overdue">超时</option><option value="due_soon">临期</option><option value="blocked">受阻</option><option value="unknown">时间待核实</option></select></label>
    </FilterBar><p>{result ? `${result.archiveTotal} 个开发档案 · ${result.total} 项真实任务` : "正在读取授权任务…"}</p></Surface>
    <div className="pattern-group-cards">{PATTERN_GROUPS.map(group => <KpiCard key={group.key} label={group.label} value={result?.counts[group.key] ?? "—"} detail="任务数" selected={filter.group === group.key} onClick={() => update({group: filter.group === group.key ? undefined : group.key})}/>)}</div>
    <div className="pattern-workspace-body"><Surface className="pattern-task-list"><h2>{PATTERN_GROUPS.find(group => group.key === filter.group)?.label ?? "全部环节"}</h2>
      <div className="pattern-board-scroll"><div className={`pattern-board-columns ${filter.group ? "is-filtered" : ""}`}>{PATTERN_GROUPS.filter(group => !filter.group || group.key === filter.group).map(group => <section className="pattern-board-column" key={group.key}><h3>{group.label} <span>{result?.counts[group.key] ?? "—"}</span></h3>
      {result?.items.filter(task => task.group === group.key).map(task => <button type="button" key={task.node.instanceId} aria-pressed={selectedId === task.node.instanceId} className={`pattern-task-card ${task.node.risks.includes("overdue") ? "is-overdue" : ""}`} onClick={() => {setSelectedId(task.node.instanceId); persist(filter, task.node.instanceId);}}>
        <span><strong>{task.designStyleNo}</strong><small>{task.customer ?? "通用开发"} · {task.designer ?? "设计师未登记"}</small></span><span><strong>{task.node.label}</strong><small>第 {task.node.round ?? 1} 轮 · {task.node.owner?.name ?? "待派工"}</small></span>
        <StatusBadge tone={task.node.risks.includes("overdue") || task.node.state === "blocked" ? "danger" : task.node.state === "completed" ? "success" : "info"}>{states[task.node.state]}</StatusBadge>
        <small>进入 {date(task.node.enteredAt)} · 截止 {task.node.expectedAt ? date(task.node.expectedAt) : task.node.sla === "not_started" ? "未启动计时" : "无时限"}</small>
        <small>{task.node.enteredAt && result && !["completed", "cancelled"].includes(task.node.state) ? `已停留 ${Math.max(0, (Date.parse(result.asOf) - Date.parse(task.node.enteredAt)) / 3600000).toFixed(1)} 小时` : task.node.enteredAt ? "原完成时间见任务详情" : "尚未进入计时"}{task.node.risks.length > 0 && ` · ${task.node.risks.map(risk => ({overdue: "超时", due_soon: "临期", blocked: "受阻", unknown: "时间待核实"})[risk]).join(" / ")}`}</small>
        {task.node.blockers.length > 0 && <small className="pattern-task-risk">{task.node.blockers.map(blocker => blocker.label).join("；")}</small>}
      </button>)}
      {result && !result.items.some(task => task.group === group.key) && <p>{result.counts[group.key] ? "本页无此环节任务" : "暂无任务"}</p>}
      {!filter.group && (result?.counts[group.key] ?? 0) > 0 && <Button onClick={() => update({group: group.key})}>查看本环节</Button>}
      </section>)}</div></div>
      {result && !result.items.length && <p>当前筛选暂无真实任务</p>}
      <Pagination page={filter.page} pageSize={20} total={result?.total ?? null} onPage={page => update({page})}/>
    </Surface><section className="pattern-task-detail" aria-label="选中任务详情">
      {!selectedId && <Surface><h2>任务详情</h2><p>选择任务查看原资料、面辅料、交接与合法操作。</p></Surface>}
      {detailError && <p role="alert">{detailError}</p>}
      {selectedId && !selected && !detailError && <p role="status">正在读取任务…</p>}
      {selected && options && <>
        {sheet && <Surface className="pattern-selected-basics"><h2>{sheet.designStyleNo} · 第 {selected.routeVersion} 轮</h2><dl className="pattern-basic-facts"><div><dt>客户</dt><dd>{sheet.customerCode ?? "通用开发"}</dd></div><div><dt>开发类型</dt><dd>{sheet.developmentType}</dd></div><div><dt>设计师</dt><dd>{sheet.designerName}</dd></div><div><dt>工艺 / 洗水</dt><dd>{sheet.document?.craft ?? "未登记"} / {sheet.document?.washing ?? "未登记"}</dd></div></dl>
          <h3>本轮面辅料</h3><div className="development-table-scroll"><table><thead><tr><th>材料</th><th>规格 / 数量</th><th>到料事实</th><th>原计划日期</th></tr></thead><tbody>{sheet.document?.materials.filter(material => material.requiredThisRound).map(material => <tr key={material.materialId}><td>{material.category} · {material.label || material.name}</td><td>{material.specification || "—"} · {material.quantity || "—"}</td><td>{material.available || sheet.materialEvents.some(event => event.materialId === material.materialId && ["到货", "确认代用"].includes(event.action)) ? "已登记到料/代用" : "尚缺到料记录"}</td><td>{sheet.materialEvents.filter(event => event.materialId === material.materialId && event.action === "修改预计日期").at(-1)?.expectedDate ?? material.expectedDate ?? "未登记"}</td></tr>)}</tbody></table></div>
          {!sheet.document?.materials.some(material => material.requiredThisRound) && <p>本轮无必需材料记录</p>}
        </Surface>}
        <DigitalTasksPanel key={`${selected.taskId}:${refresh}`} options={options} taskId={selected.taskId} compact onChanged={changed}/>
        {selected.sourceId && sheet?.status === "published" && selected.routeVersion === (sheet.latestRoundNumber ?? 1) && <Surface><DevelopmentExecutionPanel key={`${selected.taskId}:${refresh}`} sourceId={selected.sourceId} materialRevision={sheet.materialEvents.length} taskId={selected.taskId} onChanged={changed}/></Surface>}
      </>}
    </section></div>
  </div>;
}
