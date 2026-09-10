import { useEffect, useMemo, useState } from "react";
import { Button } from "@dx-rework/ui";
import { WorkflowAnalysisQuerySchema, WorkflowAnalysisResponseSchema, type WorkflowAnalysisResponse } from "@dx-rework/contracts";
import { businessActionLabel, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { createWebUrls } from "../url-contract.js";
import { verifySession } from "./auth.js";
import { canReadWorkAnalysis, elapsedWorkTime } from "./work-analysis-model.js";
import { ListPagination } from "./list-pagination.js";
import { reworkFlowNodes } from "./rework-flow-model.js";
import "./rework-flow-panel.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const time = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未记录";
const nodeLabel = (value: string | null) => value === null ? "开始" : reworkFlowNodes[value]?.label ?? value;
type Props = { keyword: string; search: string; node: string; from: string; to: string; refreshToken: number; onQuery: (value: string) => void; onNode: (value: string) => void; onRefresh: () => void };

export function ReworkFlowPanel(props: Props) {
  const [allowed, setAllowed] = useState(false), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [data, setData] = useState<WorkflowAnalysisResponse | null>(null);
  const [filters, setFilters] = useState(() => WorkflowAnalysisQuerySchema.parse({ group: "rework" }));
  const query = useMemo(() => ({ ...filters, q: props.search, node: props.node, from: props.from || undefined, to: props.to || undefined }), [filters, props.search, props.node, props.from, props.to]);
  useEffect(() => { setFilters(value => ({ ...value, page: 1 })); }, [props.search, props.node, props.from, props.to]);
  useEffect(() => {
    let active = true;
    void verifySession().then(session => { if (active) setAllowed(session !== "denied" && canReadWorkAnalysis("workflow", session.user)); }).catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    setBusy(true); setError(""); setData(null);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    void fetch(apiUrl(`management/workflow-analysis?${params}`), { credentials: "include", cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("流程分析暂时不可用，可继续办理下方返工单，稍后点击刷新。");
      const result = WorkflowAnalysisResponseSchema.parse(await response.json());
      if (!controller.signal.aborted) setData(result);
    }).catch(() => { if (!controller.signal.aborted) setError("流程分析暂时不可用，可继续办理下方返工单，稍后点击刷新。"); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [allowed, query, props.refreshToken]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") props.onRefresh(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) props.onRefresh(); };
    document.addEventListener("visibilitychange", refresh); window.addEventListener("pageshow", restored);
    return () => { document.removeEventListener("visibilitychange", refresh); window.removeEventListener("pageshow", restored); };
  }, [props.onRefresh]);
  const change = (patch: Partial<typeof filters>) => setFilters(value => ({ ...value, ...patch, page: 1 }));
  if (!allowed) return null;
  return <section className="rework-flow" aria-label="流程等待与往返">
    <button className="rework-flow__summary" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <strong>流程等待与往返</strong><span>{data ? `当前等待 ${data.waitingCount} · 有往返 ${data.roundtripCount} · 缺记录 ${data.missingEntryCount}` : busy ? "读取中…" : "暂未取得分析"}</span><b>{open ? "收起⌃" : "展开⌄"}</b>
    </button>
    {open && <div className="rework-flow__body">
      <div className="rework-flow__toolbar">
        <label>联动关键词<input value={props.keyword} maxLength={100} onChange={event => props.onQuery(event.target.value)} placeholder="RW号 / 原订单 / 款号 / 人员 / 供应商" /></label>
        <label>当前节点<select value={props.node} onChange={event => props.onNode(event.target.value)}><option value="">全部节点</option>{Object.entries(reworkFlowNodes).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
        <label>流程状态<select value={filters.state} onChange={event => change({ state: event.target.value as typeof filters.state })}><option value="all">全部</option><option value="waiting">当前等待</option><option value="closed">已结束</option></select></label>
        <label>往返<select value={filters.roundtrip} onChange={event => change({ roundtrip: event.target.value as typeof filters.roundtrip })}><option value="all">全部</option><option value="yes">有退回 / 往返</option><option value="repeated">2 次以上</option><option value="no">无退回记录</option></select></label>
        <label>记录<select value={filters.issue} onChange={event => change({ issue: event.target.value as typeof filters.issue })}><option value="all">全部记录</option><option value="missing">进入时间 / 历史缺失</option></select></label>
        <label>等待排序<select value={filters.sort} onChange={event => change({ sort: event.target.value as typeof filters.sort })}><option value="longest">等待最长优先</option><option value="shortest">等待最短优先</option></select></label>
        <Button disabled={busy} onClick={props.onRefresh}>刷新</Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {data && <>
        <div className="rework-flow__insights">
          <button onClick={() => change({ state: "waiting" })}><b>{data.waitingCount}</b>当前等待</button>
          <button onClick={() => change({ state: "waiting", sort: "longest" })}><b>{data.longestEnteredAt ? elapsedWorkTime(data.longestEnteredAt, data.asOf) : "未记录"}</b>等待最长</button>
          <button onClick={() => change({ roundtrip: "repeated" })}><b>{data.repeatedCount}</b>2 次以上往返</button>
          <button onClick={() => change({ issue: "missing" })}><b>{data.missingEntryCount}</b>进入时间 / 历史缺失</button>
        </div>
        <div className="rework-flow__nodes" aria-label="节点积压">{data.groups.map(group => <Button key={group.key} onClick={() => props.onNode(group.key.split(":")[1] ?? "")}>{nodeLabel(group.key.split(":")[1] ?? null)} · {group.count} 单</Button>)}</div>
        <p className="rework-flow__scope">当前搜索、节点与日期范围内共 {data.total} 单 · 数据截至 {time(data.asOf)}</p>
        {!data.items.length ? <p>当前筛选没有流程记录。</p> : <div className="rework-flow__list">{data.items.map(item => <article key={item.id}>
          <div className="rework-flow__row">
            <a href={pageUrl(`ui/tasks/${item.id}`)}><strong>{item.styleNo || item.label}</strong><small>{item.label}{item.orderNo ? ` · ${item.orderNo}` : ""}</small></a>
            <div><b>{nodeLabel(item.status)}</b><span>{item.status === "completed" ? "已结束" : elapsedWorkTime(item.enteredAt, data.asOf)}</span></div>
            <div><small>上一步提交 / 发起</small><span>{item.submitterName || "未记录"}</span><small>{time(item.enteredAt)}</small></div>
            <div><small>当前处理</small><span>{item.status === "completed" ? "已结束" : item.status === "in_progress" && item.execution.some(task => task.people.length) ? [...new Set(item.execution.flatMap(task => task.people))].length > 1 ? "多人执行" : item.execution.flatMap(task => task.people)[0] : item.handlers.length ? item.handlers.join("、") : "具体人员未分配"}</span><small>{reworkFlowNodes[item.status]?.role || "按原办理权限"}</small></div>
          </div>
          <details><summary>节点与往返记录 · {item.roundtripCount} 次退回</summary>
            {item.history.length ? item.history.map(event => <p key={event.id}><b>{event.changesNode ? `${nodeLabel(event.from)} → ${nodeLabel(event.to)}` : businessActionLabel(event.action)}</b>{event.returned ? " · 退回" : ""}<br />{event.actorName || "未记录"} · {time(event.enteredAt)}{event.leftAt ? ` · 离开 ${time(event.leftAt)}` : ""}{event.reason ? ` · 原因：${event.reason}` : ""}</p>) : <p>历史节点未记录。</p>}
          </details>
          {item.execution.length ? <details><summary>实际执行人员与报数记录</summary>{item.execution.map(task => <div key={task.taskId}><b>{task.processName} · {task.people.join("、") || "人员未记录"}</b>{task.reports.length ? task.reports.map(report => <p key={report.id}>{formatBusinessDecimal(report.quantity)} · {report.rejected ? "已退回" : "已报数"} · 提交人 {report.actorName || "未记录"} · {time(report.at)}</p>) : <p>尚无报数记录</p>}</div>)}</details> : null}
        </article>)}</div>}
        <ListPagination page={data.filters.page} totalPages={Math.ceil(data.total / 15)} busy={busy} ariaLabel="流程等待分析分页" onPageChange={page => setFilters(value => ({ ...value, page }))} />
      </>}
      <details className="rework-flow__notes"><summary>口径与历史说明</summary><p>等待时间取真实节点进入事件，不是劳动工时，也不代表超时违规。往返按明确退回或驳回记录计次，展开查看提交、退回人和原因。缺失不记为 0；多人报数不会重置节点等待。分析仅供定位，办理仍进入原返工单。</p></details>
    </div>}
  </section>;
}
