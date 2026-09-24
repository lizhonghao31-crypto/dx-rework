import { BasicReworkBoard, ReworkBoardAccess } from "./basic-rework-board.js";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import type { ManagementReworkPage, ManagementReworkRow } from "@dx-rework/contracts/reporting";
import { Button, InsetField, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { Header, Shell } from "../components.js";
import { verifySession } from "../auth.js";
import { ListPagination } from "../list-pagination.js";
import { confirmInApp } from "../system-dialog.js";
import { useDebouncedValue } from "../use-debounced-value.js";
import { ReworkDataSandboxPage } from "../rework-data-sandbox-page.js";
import { ReworkModuleTabs } from "../rework-module-tabs.js";
import { deleteReworkOrder, loadReworkOrders } from "./reporting-client.js";
import { ManagementOrderCard } from "./management-order-card.js";
import "./reporting.css";
import "./rework-query-mobile.css";

const statuses: Array<[ManagementReworkRow["status"] | "", string]> = [
  ["", "全部状态"],["draft","草稿"],["pending_process_configuration","待配置工序"],["pending_ie_review","待 IE 审核"],
  ["pending_task_assignment","待分工"],["in_progress","返工执行中"],["pending_order_review","待尾部确认最终数量"],["pending_final_quantity_ie_review","最终数量待 IE 复核"],
  ["pending_quantity_adjustment_ie_review","数量调整待 IE"],["pending_responsibility_determination","责任判定与资料核验"],
  ["pending_owner_signature","待老板确认签字"],["pending_responsibility_action","责任结算中"],["completed","订单已完成"],["cancelled","已取消"],
];
const responsibilityTypes = [["","全部责任"],["own_factory","本厂承担"],["processing_factory","加工厂"],["embroidery_factory","印绣花厂"],["washing_factory","洗水厂"],["fabric_supplier","面料商"]] as const;
type LoadState = { kind: "loading" } | { kind: "ready"; value: ManagementReworkPage } | { kind: "unavailable"; message: string };

export function ReworkQueryPage() {
  const sandbox = new URLSearchParams(window.location.search).get("view") === "sandbox";
  return <ReworkBoardAccess basic={<BasicReworkBoard />} business={sandbox ? <ReworkDataSandboxPage /> : <BusinessReworkQueryPage />} />;
}

function BusinessReworkQueryPage() {
  const initial = useMemo(() => new URLSearchParams(window.location.search), []);
  const [q, setQ] = useState(initial.get("q") ?? "");
  const debouncedQ = useDebouncedValue(q, 200);
  const [status, setStatus] = useState(initial.get("status") ?? "");
  const [reworkKind, setReworkKind] = useState(initial.get("reworkKind") ?? "");
  const [responsibilityType,setResponsibilityType]=useState(initial.get("responsibilityType")??"");
  const [from,setFrom]=useState(initial.get("from")??"");
  const [to,setTo]=useState(initial.get("to")??"");
  const [overdue, setOverdue] = useState(initial.get("overdue") ?? "");
  const [exception, setException] = useState(initial.get("exception") ?? "");
  const [page,setPage]=useState(() => { const value=Number(initial.get("page")); return Number.isInteger(value)&&value>0?value:1; });
  const [moreFilters,setMoreFilters]=useState(Boolean(initial.get("from")||initial.get("to")||initial.get("overdue")));
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const [isRoot, setIsRoot] = useState(false);
  const [canSandbox, setCanSandbox] = useState(false);
  const [deletingOrderId, setDeletingOrderId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const resetPage=()=>{setPage(1);};
  const filters = useMemo(() => ({ q: debouncedQ.trim() || undefined, status: status || undefined, reworkKind: reworkKind || undefined, responsibilityType:responsibilityType||undefined,from,to, overdue: overdue || undefined, exception: exception || undefined,page: String(page), limit: "15" }), [debouncedQ,status,reworkKind,responsibilityType,from,to,overdue,exception,page]);

  useEffect(() => {
    const url = new URL(window.location.href);
    for (const [name,value] of Object.entries({q,status,reworkKind,responsibilityType,from,to,overdue,exception,page:page>1?String(page):""})) {
      if(value) url.searchParams.set(name,value); else url.searchParams.delete(name);
    }
    window.history.replaceState(window.history.state,"",url);
  }, [q,status,reworkKind,responsibilityType,from,to,overdue,exception,page]);
  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    setState((current) => current.kind === "ready" ? current : { kind: "loading" });
    void loadReworkOrders(filters, controller.signal)
      .then((value) => setState({ kind: "ready", value }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "unavailable", message: error instanceof Error ? error.message : "订单查询失败" });
      })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => { controller.abort(); };
  }, [filters, refresh]);
  useEffect(() => {
    let mounted = true;
    void verifySession().then((session) => {
      if (!mounted || session === "denied" || session.status !== "authorized") return;
      const root = session.user.isRoot === true;
      setIsRoot(root);
      setCanSandbox(root || session.user.capabilities.includes("dashboard:management:read"));
    });
    return () => { mounted = false; };
  }, []);
  const remove = async (order: ManagementReworkRow): Promise<void> => {
    const name = order.reworkNo ?? order.reworkOrderId;
    if (!(await confirmInApp(`确认删除 ${name} 吗？删除后将从业务与报表入口隐藏，并关闭相关待办。`))) return;
    setDeletingOrderId(order.reworkOrderId);
    setDeleteError("");
    void deleteReworkOrder(order.reworkOrderId)
      .then(() => setRefresh((value) => value + 1))
      .catch((error: unknown) => setDeleteError(error instanceof Error ? error.message : "删除失败"))
      .finally(() => setDeletingOrderId(""));
  };
  const items = state.kind === "ready" ? state.value.items : [];
  return <Shell active="返工单看板"><div className="rework-query-content">
    <Header title="返工单看板" subtitle="查看权限范围内返工单；进入订单详情查看完整流程并处理对应节点。" badge={!refreshing && state.kind === "ready" ? `${formatBusinessDecimal(items.length)} 条当前结果` : "查询中"} />
    {canSandbox ? <ReworkModuleTabs active="board" /> : null}
    <Surface className="reporting-filters reporting-filters--orders">
      <InsetField label="关键词" aria-label="关键词" value={q} onChange={(event) => {setQ(event.target.value);resetPage();}} placeholder="单号 / 款号 / 订单 / 人员 / 供应商" />
      <label>类别<select value={reworkKind} onChange={(event) => {setReworkKind(event.target.value);resetPage();}}><option value="">全部类别</option><option value="qc_rework">QC返工</option><option value="inhouse_finishing">本厂做尾</option></select></label>
      <label>状态<select value={status} onChange={(event) => {setStatus(event.target.value);resetPage();}}>{statuses.map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>责任<select value={responsibilityType} onChange={event=>{setResponsibilityType(event.target.value);resetPage();}}>{responsibilityTypes.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
      <button type="button" className="rework-query-more-toggle" aria-expanded={moreFilters} aria-controls="rework-query-more" onClick={()=>setMoreFilters(!moreFilters)}>日期 / 更多筛选 {moreFilters?'−':'+'}</button>
      <div id="rework-query-more" className={`rework-query-more${moreFilters?' is-open':''}`}>
      <label className="reporting-date-range">日期范围<span><input aria-label="开始日期" type="date" value={from} onChange={event=>{setFrom(event.target.value);resetPage();}} /><i>至</i><input aria-label="结束日期" type="date" value={to} onChange={event=>{setTo(event.target.value);resetPage();}} /></span></label>
      <label>逾期<select value={overdue} onChange={(event) => {setOverdue(event.target.value);resetPage();}}><option value="">全部</option><option value="true">仅逾期</option><option value="false">未逾期</option></select></label>
      </div>
      <label>异常<select value={exception} onChange={(event) => {setException(event.target.value);resetPage();}}><option value="">全部</option><option value="true">仅异常</option><option value="false">无异常</option></select></label>
      <Button className="reporting-filters__refresh" onClick={() => setRefresh((value) => value + 1)}>刷新</Button>
    </Surface>
    {state.kind === "loading" && <Surface className="reporting-state">正在查询…</Surface>}
    {state.kind === "unavailable" && <Surface className="reporting-state">{state.message}</Surface>}
    {deleteError && <Surface className="reporting-state reporting-delete-error"><p role="alert">{deleteError}</p></Surface>}
    {state.kind === "ready" && items.length === 0 && <Surface className="reporting-state">没有符合筛选条件的返工单。</Surface>}
    <div className="reporting-order-grid">{items.map((order) => <ManagementOrderCard order={order} key={order.reworkOrderId} canDelete={isRoot} deleting={deletingOrderId === order.reworkOrderId} onDelete={remove} />)}</div>
    {state.kind === "ready" && <ListPagination
      page={state.value.page}
      totalPages={state.value.totalPages}
      busy={refreshing}
      ariaLabel="返工单分页"
      onPageChange={setPage}
    />}
  </div></Shell>;
}
