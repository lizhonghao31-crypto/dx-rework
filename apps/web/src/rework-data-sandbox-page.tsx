import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { WorkflowAnalysisResponseSchema, type WorkflowAnalysisResponse } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import { Header, Shell } from "./components.js";
import { reworkFlowNodes } from "./rework-flow-model.js";
import "./rework-data-sandbox.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
type Period = { from: string; to: string };
type Summary = NonNullable<WorkflowAnalysisResponse["periodSummary"]>;
const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const parseDay = (value: string) => new Date(`${value}T00:00:00+08:00`);
const shiftDays = (value: string, offset: number) => { const date = parseDay(value); date.setUTCDate(date.getUTCDate() + offset); return day(date); };
const rangeDays = (range: Period) => Math.max(1, Math.round((parseDay(range.to).getTime() - parseDay(range.from).getTime()) / 86400000) + 1);
const defaultPeriods = (): { a: Period; b: Period } => {
  const today = day(new Date()), first = `${today.slice(0, 8)}01`, length = rangeDays({ from: first, to: today });
  const bTo = shiftDays(first, -1), bFrom = shiftDays(bTo, -(length - 1));
  return { a: { from: first, to: today }, b: { from: bFrom, to: bTo } };
};
const duration = (seconds: number | null) => {
  if (seconds === null) return "—";
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 36000 ? 1 : 0)}小时`;
  return `${(seconds / 86400).toFixed(seconds < 864000 ? 1 : 0)}天`;
};
const timeChange = (current: number | null, prior: number | null, lowerIsBetter = false) => {
  if (current === null || prior === null) return { text: "不可比", tone: "neutral" as const };
  const delta = current - prior;
  if (delta === 0) return { text: "持平", tone: "neutral" as const };
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return { text: `${delta > 0 ? "↑" : "↓"} ${duration(Math.abs(delta))}`, tone: improved ? "good" as const : "bad" as const };
};
const countChange = (current: number, prior: number, lowerIsBetter = false) => {
  const delta = current - prior;
  if (!delta) return { text: "持平", tone: "neutral" as const };
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return { text: `${delta > 0 ? "↑" : "↓"} ${Math.abs(delta)}`, tone: improved ? "good" as const : "bad" as const };
};
const volumeChange = (current: number, prior: number) => {
  const delta = current - prior;
  return { text: delta === 0 ? "持平" : `${delta > 0 ? "↑" : "↓"} ${Math.abs(delta)}`, tone: "neutral" as const };
};
function MetricInfo({ title, formula, use, note }: { title: string; formula: string; use: string; note: string }) {
  const [open, setOpen] = useState(false);
  return <span className="sandbox-info" onMouseEnter={()=>setOpen(true)} onMouseLeave={()=>setOpen(false)} onFocus={()=>setOpen(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false);}}>
    <button type="button" aria-label={`查看${title}口径`} aria-expanded={open} onClick={()=>setOpen(value=>!value)} onKeyDown={event=>{if(event.key==="Escape")setOpen(false);}}>ⓘ</button>
    {open?<span className="sandbox-info__popover" role="note"><b>{title}</b><span><strong>公式：</strong>{formula}</span><span><strong>用途：</strong>{use}</span><span><strong>注意：</strong>{note}</span></span>:null}
  </span>;
}
function MetricCard({ title, primary, secondary, comparison, info }: { title: string; primary: string; secondary: string; comparison: { text: string; tone: "good" | "bad" | "neutral" }; info: Parameters<typeof MetricInfo>[0] }) {
  return <Surface className="sandbox-kpi"><MetricInfo {...info}/><small>{title}</small><strong>{primary}</strong><span>{secondary}</span><em className={`is-${comparison.tone}`}>{comparison.text}</em></Surface>;
}
async function loadPeriod(period: Period, q: string, signal: AbortSignal): Promise<WorkflowAnalysisResponse> {
  const params = new URLSearchParams({ group: "rework", periodMode: "activity", from: period.from, to: period.to, page: "1" });
  if (q.trim()) params.set("q", q.trim());
  const response = await fetch(apiUrl(`management/workflow-analysis?${params}`), { credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw new Error("数据沙盘读取失败");
  return WorkflowAnalysisResponseSchema.parse(await response.json());
}
const slowestNode = (summary: Summary) => [...summary.nodes].filter(node => node.averageSeconds !== null).sort((a, b) => (b.averageSeconds ?? 0) - (a.averageSeconds ?? 0))[0] ?? null;
const nodeLabel = (node: string) => reworkFlowNodes[node]?.label ?? node;

export function ReworkDataSandboxPage() {
  const defaults = useMemo(defaultPeriods, []), [a, setA] = useState(defaults.a), [b, setB] = useState(defaults.b);
  const [draftA, setDraftA] = useState(defaults.a), [draftB, setDraftB] = useState(defaults.b), [q, setQ] = useState(""), [draftQ, setDraftQ] = useState("");
  const [dataA, setDataA] = useState<WorkflowAnalysisResponse | null>(null), [dataB, setDataB] = useState<WorkflowAnalysisResponse | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [refreshKey, setRefreshKey] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const version = ++request.current, controller = new AbortController();
    setBusy(true); setError("");
    void Promise.all([loadPeriod(a, q, controller.signal), loadPeriod(b, q, controller.signal)]).then(([first, second]) => {
      if (version !== request.current) return;
      setDataA(first); setDataB(second);
    }).catch(error => { if (!controller.signal.aborted && version === request.current) setError(error instanceof Error ? error.message : "数据沙盘读取失败"); })
      .finally(() => { if (!controller.signal.aborted && version === request.current) setBusy(false); });
    return () => controller.abort();
  }, [a, b, q, refreshKey]);
  const summaryA = dataA?.periodSummary ?? null, summaryB = dataB?.periodSummary ?? null;
  const slowestA = summaryA ? slowestNode(summaryA) : null;
  const compareNode = new Map((summaryB?.nodes ?? []).map(node => [node.node, node]));
  const slowestPrior = slowestA ? compareNode.get(slowestA.node) ?? null : null;
  const dataAsOf = dataA?.asOf ?? null;
  const apply = () => {
    if (!draftA.from || !draftA.to || !draftB.from || !draftB.to || draftA.from > draftA.to || draftB.from > draftB.to) { setError("日期范围无效"); return; }
    setA(draftA); setB(draftB); setQ(draftQ.trim());
  };
  return <Shell active="数据沙盘"><div className="rework-data-sandbox">
    <Header title="数据沙盘" iconRoute="/ui/rework-data-sandbox" subtitle="返工流程运营 · 双期间对比与原单下钻" badge="订单返工" />
    <Surface className="sandbox-filter"><div><b>分析期间 A</b><input type="date" value={draftA.from} onChange={e=>setDraftA(value=>({...value,from:e.target.value}))}/><span>至</span><input type="date" value={draftA.to} onChange={e=>setDraftA(value=>({...value,to:e.target.value}))}/></div><div><b>对比期间 B</b><input type="date" value={draftB.from} onChange={e=>setDraftB(value=>({...value,from:e.target.value}))}/><span>至</span><input type="date" value={draftB.to} onChange={e=>setDraftB(value=>({...value,to:e.target.value}))}/></div><label>款号 / RW / ERP<input value={draftQ} maxLength={100} onChange={e=>setDraftQ(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")apply();}}/></label><Button disabled={busy} onClick={apply}>应用</Button><Button variant="secondary" disabled={busy} onClick={()=>setRefreshKey(value=>value+1)}>刷新</Button></Surface>
    {error ? <div role="alert"><Surface className="sandbox-state">{error}。原返工看板和办理入口不受影响。</Surface></div> : null}
    {busy && !summaryA ? <Surface className="sandbox-state">正在读取返工运营数据…</Surface> : null}
    {summaryA && summaryB ? <>
      <div className="sandbox-kpis">
        <MetricCard title="业务进入 / 完成" primary={`${summaryA.enteredCount} / ${summaryA.completedCount}`} secondary={`B期 ${summaryB.enteredCount} / ${summaryB.completedCount}`} comparison={volumeChange(summaryA.completedCount,summaryB.completedCount)} info={{title:"业务进入 / 完成",formula:"进入量=首次进入返工流程发生在所选期间的有效订单；完成量=首次进入已完成状态发生在所选期间的有效订单。",use:"同时观察业务流入与处理结果，避免用“完成÷新增”制造错误完成率。",note:"业务量升降为中性变化，不自动判断好坏；取消、删除订单不纳入。"}}/>
        <MetricCard title="期末未完成" primary={`${summaryA.openAtEndCount} 单`} secondary={`B期 ${summaryB.openAtEndCount} 单`} comparison={countChange(summaryA.openAtEndCount,summaryB.openAtEndCount,true)} info={{title:"期末未完成",formula:"截至期间最后一刻，已经进入返工流程且尚未首次进入已完成状态的有效订单数。",use:"判断积压是在增加还是消化。",note:"按历史节点事件还原期末状态；首次完成后的重新判责不重新计为主流程未完成。"}}/>
        <MetricCard title="平均流转时长" primary={duration(summaryA.averageCycleSeconds)} secondary={`B期 ${duration(summaryB.averageCycleSeconds)} · A期${summaryA.cycleSampleCount}个完整样本`} comparison={timeChange(summaryA.averageCycleSeconds,summaryB.averageCycleSeconds,true)} info={{title:"平均流转时长",formula:"本期首次完成且首个进入事件完整的订单，从首次进入返工流程到首次进入已完成状态的总经过时间之和 ÷ 完整样本数。",use:"观察一张返工单从发起到首次业务完成整体需要经过多久。",note:"包含排队、等待、夜间和休息时间，不等于实际劳动工时；缺记录不按0计算。"}}/>
        <MetricCard title="流转最久环节" primary={slowestA ? nodeLabel(slowestA.node) : "—"} secondary={slowestA ? `A期平均 ${duration(slowestA.averageSeconds)} · B期同环节 ${duration(slowestPrior?.averageSeconds??null)}` : "暂无完整样本"} comparison={timeChange(slowestA?.averageSeconds??null,slowestPrior?.averageSeconds??null,true)} info={{title:"流转最久环节",formula:"比较首次业务完成前，各环节在本期离开该节点的完整流转记录，取平均流转时长最高的环节；变化只与B期同一环节比较。",use:"快速定位哪个环节占用的业务等待时间最长，再结合积压和原单检查原因。",note:"流转时长包含等待，不代表实际操作工时，也不能单凭本指标认定人员责任。"}}/>
      </div>
      <Surface className="sandbox-section"><div className="sandbox-section__title"><div><h2>各环节流转</h2><p>A期与B期使用同一口径。平均时长看已完成流转，期末未完成看仍停在该环节的业务。</p></div><MetricInfo title="各环节流转" formula="节点平均=本期离开该节点、且发生在首次业务完成前的完整流转时长之和÷流转次数；期末未完成按期间结束时真实节点还原。" use="同时识别普遍较慢的环节与正在积压的环节。" note="补图、报数和普通保存不重置时钟；缺进入或离开时间不补造。"/><small>数据截至 {dataAsOf ? new Date(dataAsOf).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}) : "未记录"}</small></div>
        <div className="sandbox-node-head" aria-hidden="true"><span>环节</span><span>A期平均流转</span><span>对比B期</span><span>A期期末未完成</span><span>最长已停留</span><span>查看</span></div>
        <div className="sandbox-node-list">{summaryA.nodes.map(node=>{const prior=compareNode.get(node.node);const delta=timeChange(node.averageSeconds,prior?.averageSeconds??null,true);return <div className="sandbox-node-row" key={node.node}><b>{nodeLabel(node.node)}</b><span>{duration(node.averageSeconds)}<small>{node.completedCount}次完成流转</small></span><em className={`is-${delta.tone}`}>{delta.text}</em><span>{node.openAtEndCount} 单</span><span>{duration(node.longestOpenSeconds)}</span><span>{node.longestOpenItemId?<a href={pageUrl(`ui/tasks/${node.longestOpenItemId}`)}>最长事项 →</a>:"—"}</span></div>;})}</div>
        {!summaryA.nodes.length?<p>所选期间没有可计算的节点流转记录。</p>:null}
      </Surface>
      <Surface className="sandbox-section sandbox-integrity"><div><h2>数据口径</h2><p>本沙盘使用真实节点迁移时间。退回后重新进入同一节点作为新的流转记录；首次业务完成后的重新判责保留历史，但不改写首次完成周期。</p></div><div><b>A期完整整单样本 {summaryA.cycleSampleCount}</b><span>缺完整周期 {summaryA.missingCycleCount}</span></div><div><b>B期完整整单样本 {summaryB.cycleSampleCount}</b><span>缺完整周期 {summaryB.missingCycleCount}</span></div></Surface>
    </> : null}
  </div></Shell>;
}
