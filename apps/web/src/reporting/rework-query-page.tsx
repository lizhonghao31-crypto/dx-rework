import type { ManagementReworkPage, ManagementReworkRow } from "@dx-rework/contracts/reporting";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { Header, Shell } from "../components.js";
import { loadReworkOrders, reportingBusinessDate, reportingBusinessMonthStart } from "./reporting-client.js";
import { ManagementOrderCard } from "./management-order-card.js";
import "./reporting.css";

const statuses: Array<[ManagementReworkRow["status"] | "", string]> = [
  ["", "全部状态"],["pending_process_configuration","待配置工序"],["pending_ie_review","待 IE 审核"],
  ["pending_task_assignment","待分工"],["in_progress","返工执行中"],["pending_order_review","待整单审核"],
  ["pending_quantity_adjustment_ie_review","数量调整待 IE"],["pending_responsibility_determination","待责任判定"],
  ["pending_responsibility_action","责任处理中"],["completed","已完成"],["cancelled","已取消"],
];
const responsibilityTypes = [["","全部责任"],["own_factory","本厂承担"],["processing_factory","加工厂"],["embroidery_factory","印绣花厂"],["washing_factory","洗水厂"],["fabric_supplier","面料商"]] as const;

type LoadState = { kind: "loading" } | { kind: "ready"; value: ManagementReworkPage } | { kind: "unavailable"; message: string };

export function ReworkQueryPage() {
  const initial = useMemo(() => new URLSearchParams(window.location.search), []);
  const [q, setQ] = useState(initial.get("q") ?? "");
  const [status, setStatus] = useState(initial.get("status") ?? "");
  const [responsibilityType,setResponsibilityType]=useState(initial.get("responsibilityType")??"");
  const [from,setFrom]=useState(initial.get("from")??reportingBusinessMonthStart());
  const [to,setTo]=useState(initial.get("to")??reportingBusinessDate());
  const [overdue, setOverdue] = useState(initial.get("overdue") ?? "");
  const [exception, setException] = useState(initial.get("exception") ?? "");
  const [cursor,setCursor]=useState("");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const resetPage=()=>setCursor("");
  const filters = useMemo(() => ({ q: q.trim() || undefined, status: status || undefined, responsibilityType:responsibilityType||undefined,from,to, overdue: overdue || undefined, exception: exception || undefined,cursor:cursor||undefined, limit: "40" }), [q,status,responsibilityType,from,to,overdue,exception,cursor]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setState({ kind: "loading" });
      void loadReworkOrders(filters, controller.signal)
        .then((value) => setState({ kind: "ready", value }))
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "unavailable", message: error instanceof Error ? error.message : "订单查询失败" });
        });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [filters, refresh]);
  useEffect(()=>{const focus=()=>setRefresh(value=>value+1);window.addEventListener("focus",focus);return()=>window.removeEventListener("focus",focus);},[]);

  const items = state.kind === "ready" ? state.value.items : [];
  const canViewReports = state.kind === "ready" && state.value.canViewReports;
  return <Shell active="全部订单">
    <Header title="全部订单" subtitle="查看权限范围内订单；进入订单详情查看完整流程并处理对应节点。" badge={state.kind === "ready" ? `${items.length} 条当前结果` : "服务端实时查询"} action={canViewReports ? "财务报表" : "返回工作台"} actionHref={canViewReports ? "/ui/reports" : "/"} />
    <Surface className="reporting-filters">
      <InsetField label="关键词" aria-label="关键词" value={q} onChange={(event) => {setQ(event.target.value);resetPage();}} placeholder="单号 / 款号 / 订单 / 人员 / 供应商" />
      <label>状态<select value={status} onChange={(event) => {setStatus(event.target.value);resetPage();}}>{statuses.map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>责任<select value={responsibilityType} onChange={event=>{setResponsibilityType(event.target.value);resetPage();}}>{responsibilityTypes.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
      <label>开始日期<input type="date" value={from} onChange={event=>{setFrom(event.target.value);resetPage();}} /></label>
      <label>结束日期<input type="date" value={to} onChange={event=>{setTo(event.target.value);resetPage();}} /></label>
      <label>逾期<select value={overdue} onChange={(event) => {setOverdue(event.target.value);resetPage();}}><option value="">全部</option><option value="true">仅逾期</option><option value="false">未逾期</option></select></label>
      <label>异常<select value={exception} onChange={(event) => {setException(event.target.value);resetPage();}}><option value="">全部</option><option value="true">仅异常</option><option value="false">无异常</option></select></label>
      <Button onClick={() => setRefresh((value) => value + 1)}>立即刷新</Button>
    </Surface>
    {state.kind === "loading" && <Surface className="reporting-state">正在查询…</Surface>}
    {state.kind === "unavailable" && <Surface className="reporting-state">{state.message}</Surface>}
    {state.kind === "ready" && items.length === 0 && <Surface className="reporting-state">没有符合筛选条件的返工单。</Surface>}
    <div className="reporting-order-grid">{items.map((order) => <ManagementOrderCard order={order} key={order.reworkOrderId} />)}</div>
    {state.kind === "ready" && (cursor || state.value.nextCursor) && <Surface className="reporting-pagination">
      {cursor && <Button onClick={()=>setCursor("")}>返回第一页</Button>}
      {state.value.nextCursor && <Button variant="primary" onClick={()=>setCursor(state.value.nextCursor??"")}>下一页</Button>}
      <StatusBadge tone="info">使用稳定游标翻页，不因新增数据重复读取当前页。</StatusBadge>
    </Surface>}
  </Shell>;
}
