import { PatternNodeHistory, PatternNodeRecord, PatternRoundRecord } from "./pattern-round-record.js";
import { patternSelectedStage, patternWorkflow } from "./pattern-workflow.js";
import { PatternOrderCard } from "./pattern-order-card.js";
import { PatternMaterials } from "./pattern-materials.js";
import { PatternOrderDelete } from "./pattern-order-delete.js";
import { ListPagination } from "./list-pagination.js";
import { SearchSelect } from "./search-select.js";
import { confirmInApp } from "./system-dialog.js";
import { PatternField as InsetField, PatternProgress } from "./pattern-controls.js";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { AssignPatternOrderSchema, PATTERN_ORDER_STATUS_LABELS, PatternOrderDetailSchema, PatternOrderListSchema, PatternPeopleFiltersSchema, PatternWorkerOptionsSchema, RecordPatternHoursSchema, type PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { Header } from "./components.js";
import { createClientRequestId } from "./client-request-id.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { PatternOrderForm } from "./pattern-order-form.js";
import { PatternOrderExceptions, type PatternExceptionAction } from "./pattern-order-exceptions.js";
import { patternRequest, patternTime, patternUrls } from "./pattern-order-client.js";
import { patternListPath, patternReturnPath, readPatternListQuery } from "./pattern-order-query.js";
import { canLeaveInternalPage, navigateInternalPage } from "./internal-navigation.js";
import { useInternalReturnScroll } from "./use-internal-return-scroll.js";
import "./pattern-room.css";

const { pageUrl } = patternUrls;
export function PatternRoomOrdersPage() {
  const [initial] = useState(() => readPatternListQuery(window.location.search));
  const [data, setData] = useState<z.infer<typeof PatternOrderListSchema> | null>(null), [error, setError] = useState("");
  const [q, setQ] = useState(initial.q), [status, setStatus] = useState(initial.status), [creatorId, setCreatorId] = useState(initial.creatorId), [workerId, setWorkerId] = useState(initial.workerId), [page, setPage] = useState(initial.page);
  const [kind, setKind] = useState(initial.kind);
  const [people, setPeople] = useState<z.infer<typeof PatternPeopleFiltersSchema> | null>(null), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true);
  const search = useDebouncedValue(q.trim(), 250);
  const listPath = patternListPath({ q: search, kind, status, creatorId, workerId, page });
  const detailHref = (id: string) => `${pageUrl(`ui/pattern-room/orders/${id}`)}?${new URLSearchParams({ returnTo: listPath })}`;
  useEffect(() => { window.history.replaceState(window.history.state, "", pageUrl(listPath)); }, [listPath]);
  useInternalReturnScroll(!loading && data !== null);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(page), q: search });
    if (status) params.set("status", status); if (creatorId) params.set("creatorId", creatorId); if (workerId) params.set("workerId", workerId);
    if (kind) params.set("kind", kind);
    void patternRequest(`orders?${params}`, PatternOrderListSchema, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setData(result); }).catch(e => { if (!abort.signal.aborted) { setError(e.message); setData(null); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [search, kind, status, creatorId, workerId, page, refresh]);
  useEffect(() => {
    if (!data?.canFilterPeople) { setPeople(null); return; }
    const abort = new AbortController();
    void patternRequest("people-filters", PatternPeopleFiltersSchema, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setPeople(result); }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [data?.canFilterPeople, refresh]);
  return <div className="pattern-orders rework-query-content"><Header title="订单打板/杂事看板" badge="订单打板" badgePlacement="subtitle" />
    {error ? <Surface><p role="alert">{error}</p><Button onClick={() => setRefresh(value => value + 1)}>重新读取</Button></Surface> : null}
    {data ? <>
      <Surface>
      <div className="pattern-fields pattern-filters"><InsetField label="搜索款号、订单号或任务名称" placeholder="款号 / 订单号 / 任务名称" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
        <label>订单类型<select value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}><option value="">全部</option><option value="pattern">打板</option><option value="misc">杂事</option></select></label>
        <label>订单状态<select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(PATTERN_ORDER_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {people ? <><label>创建人<select value={creatorId} onChange={e => { setCreatorId(e.target.value); setPage(1); }}><option value="">全部创建人</option>{people.creators.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <label>板房师傅<select value={workerId} onChange={e => { setWorkerId(e.target.value); setPage(1); }}><option value="">全部师傅</option>{people.workers.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label></> : null}
      </div>
      </Surface>
      <div className="reporting-order-grid" aria-busy={loading}>
        {data.items.map(order => <PatternOrderCard key={order.orderId} order={order} href={detailHref(order.orderId)} canDelete={data.canDelete} busy={loading} onDeleted={() => {
          setData(current => current ? { ...current, items: current.items.filter(item => item.orderId !== order.orderId) } : current);
          setPage(1); setRefresh(value => value + 1);
        }} />)}
      </div>
      {!data.items.length ? <p className="pattern-empty">没有符合条件的订单。</p> : null}
      <div className="pattern-pagination"><span>共 {formatBusinessDecimal(data.totalCount)} 单</span><ListPagination page={data.page} totalPages={data.totalPages} busy={loading} onPageChange={setPage} ariaLabel="订单打板/杂事看板分页" /></div>
    </> : loading ? <p role="status">正在读取订单…</p> : null}
  </div>;
}

const historyLabels: Record<string, string> = { "pattern_room.order.submitted": "提交打板", "pattern_room.misc.submitted": "提交杂事", "pattern_room.misc.confirmed": "发起人确认杂事完成", "pattern_room.misc.hours_recorded": "主管填写实际工时", "pattern_room.order.assigned": "分配工人", "pattern_room.order.work_completed": "工人完工", "pattern_room.order.handed_over": "设计师确认交接", "pattern_room.order.materials_changed": "更新任务资料", "pattern_room.order.rework_requested": "发起原单返工", "pattern_room.order.worker_changed": "主管原单换人", "pattern_room.order.cancelled": "取消本次任务", "pattern_room.order.cancel_fees_confirmed": "设计师确认取消费用" };
export function PatternRoomOrderDetailPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<PatternOrderDetail | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false), [refresh, setRefresh] = useState(0);
  const [workers, setWorkers] = useState<z.infer<typeof PatternWorkerOptionsSchema>>([]), [workerSearch, setWorkerSearch] = useState(""), [personId, setPersonId] = useState("");
  const [hours, setHours] = useState("");
  const [materialsOpen, setMaterialsOpen] = useState(() => !window.matchMedia("(max-width: 760px)").matches);
  const [workflowOpen, setWorkflowOpen] = useState(() => !window.matchMedia("(max-width: 760px)").matches);
  const [reworkAmount, setReworkAmount] = useState(""), [exception, setException] = useState<PatternExceptionAction | null>(null);
  const search = useDebouncedValue(workerSearch.trim(), 250), requestedRound = new URLSearchParams(window.location.search).get("round");
  const staleRound = Boolean(order && requestedRound && requestedRound !== order.currentRoundId);
  const attempt = useRef<{ body: string; action: string; key: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); setError("");
    void patternRequest(`orders/${orderId}`, PatternOrderDetailSchema, { signal: abort.signal }).then(data => { if (!abort.signal.aborted) { setOrder(data); setException(null); } }).catch(e => { if (!abort.signal.aborted) { setOrder(null); setError(e.message); } });
    return () => abort.abort();
  }, [orderId, refresh]);
  useEffect(() => {
    if (!order?.actions.assign || staleRound) return;
    const abort = new AbortController();
    void patternRequest(`workers?q=${encodeURIComponent(search)}`, PatternWorkerOptionsSchema, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setWorkers(result); }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [order?.actions.assign, staleRound, search]);
  const showUpdatedOrder = (updated: PatternOrderDetail) => {
    const params = new URLSearchParams(window.location.search);
    params.delete("node");
    if (params.has("round")) params.set("round", updated.currentRoundId);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    setOrder(updated);
  };
  const act = async (action: "assign" | "complete" | "handoff" | "hours") => {
    if (!order || busy || staleRound) return;
    const current = order.rounds.find(round => round.roundId === order.currentRoundId);
    const input = { roundId: order.currentRoundId, version: order.version, ...(action === "assign" ? { personId, ...(current?.roundType === "rework" ? { amount: reworkAmount } : {}) } : {}), ...(action === "hours" ? { hours } : {}) };
    if (action === "assign") { const parsed = AssignPatternOrderSchema.safeParse(input); if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请填写有效派工信息"); return; } }
    if (action === "hours") { const parsed = RecordPatternHoursSchema.safeParse(input); if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请填写有效工时"); return; } }
    const body = JSON.stringify(input), path = action === "handoff" && order.kind === "misc" ? "confirm" : action;
    if (attempt.current?.body !== body || attempt.current.action !== action) attempt.current = { body, action, key: createClientRequestId() };
    setBusy(true); setError("");
    try { showUpdatedOrder(await patternRequest(`orders/${orderId}/${path}`, PatternOrderDetailSchema, { method: "POST", body, headers: { "idempotency-key": attempt.current.key } })); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const visibleRounds = staleRound ? order?.rounds.filter(round => round.roundId === requestedRound) ?? [] : order?.rounds ?? [];
  const currentRound = order?.rounds.find(round => round.roundId === order.currentRoundId);
  const displayRound = staleRound ? visibleRounds[0] : currentRound;
  const selectedStage = displayRound ? patternSelectedStage(displayRound, window.location.search) : null;
  const selectedNode = displayRound ? patternWorkflow(displayRound, order?.kind === "misc").find(item => item.stage === selectedStage) : null;
  const currentWorkspace = !staleRound && selectedStage === currentRound?.status;
  const canAct = order && Object.entries(order.actions).some(([action, allowed]) => action !== "delete" && allowed);

  const confirmAction = async (action: "complete" | "handoff") => {
    if (busy || !order) return;
    const message = action === "complete" ? "确认本轮工作已完成？" : order.kind === "misc" ? "确认杂事已完成？" : "确认已收到本轮样板？";
    if (await confirmInApp(message)) await act(action);
  };
  useEffect(() => { setHours(currentRound?.segments.at(-1)?.actualHours ?? ""); }, [order?.version, currentRound?.segments]);
  useEffect(()=>{
    if(!order)return;
    const segment=new URLSearchParams(window.location.search).get("segment");
    if(segment&&order.rounds.some(round=>round.segments.some(item=>item.segmentId===segment))) document.getElementById(`segment-${segment}`)?.scrollIntoView({block:"center"});
  },[order]);
  return <div className="pattern-orders"><Header title={order ? order.kind === "misc" ? order.taskName ?? "杂事" : order.styleNo : "板房订单"} badge={order?.orderNo ?? "订单打板"} badgePlacement="subtitle" backHref={patternReturnPath(window.location.search)} />
    <div className="pattern-actions pattern-detail-toolbar"><Button disabled={busy || editing || exception !== null} onClick={() => setRefresh(value => value + 1)}>刷新订单</Button>{order?.actions.delete && !staleRound && <PatternOrderDelete orderId={order.orderId} version={order.version} label={order.orderNo} disabled={busy || editing || exception !== null} onBusy={setBusy} onDeleted={() => { void navigateInternalPage(pageUrl(patternReturnPath(window.location.search))); }} />}</div>
    {error ? <Surface><p role="alert">{error}</p><Button disabled={busy} onClick={async () => { if (await canLeaveInternalPage()) { setEditing(false); setRefresh(value => value + 1); } }}>重新读取订单</Button></Surface> : null}
    {!order && !error ? <p role="status">正在读取订单…</p> : null}
    {order ? <>
      {staleRound ? <Surface><p>这是历史轮次链接，仅供查看。</p><a href={pageUrl(`ui/pattern-room/orders/${orderId}`)}>查看当前订单</a></Surface> : null}
      <Surface><div className="pattern-section-heading"><h2>订单信息</h2>{displayRound && <StatusBadge tone={displayRound.status === "cancelled" ? "danger" : displayRound.status === "completed" ? "success" : "info"}>{PATTERN_ORDER_STATUS_LABELS[displayRound.status]}</StatusBadge>}</div><dl className="pattern-facts">
        <div><dt>创建人</dt><dd>{order.creatorName}</dd></div><div><dt>要求完成</dt><dd>{order.requiredDate ?? "—"}</dd></div>{order.kind === "misc" ? <div><dt>关联款号</dt><dd>{order.styleNo || "—"}</dd></div> : <><div><dt>客户</dt><dd>{order.customer || "—"}</dd></div><div><dt>尺码与颜色</dt><dd>{order.sizeColor || "—"}</dd></div><div><dt>版型</dt><dd>{order.variant ?? "—"}</dd></div><div><dt>参考历史款号</dt><dd>{order.referenceStyleNo || "—"}</dd></div></>}
      </dl>{order.note ? <p className="pattern-note">{order.note}</p> : null}
      </Surface>
      <div className="rework-detail-target-layout rework-detail-overview-grid pattern-detail-overview">
        {order.canReadMaterials !== false && displayRound ? <Surface className="rework-detail-images"><details className="pattern-disclosure" open={materialsOpen} onToggle={event => setMaterialsOpen(event.currentTarget.open)}><summary>制作资料</summary><PatternMaterials compact files={order.attachments.filter(file => file.roundId === displayRound.roundId && file.active)} /></details></Surface> : null}
        <Surface className="rework-workflow"><details className="pattern-disclosure" open={workflowOpen} onToggle={event => setWorkflowOpen(event.currentTarget.open)}><summary>订单流程{displayRound && <small>{PATTERN_ORDER_STATUS_LABELS[displayRound.status]}</small>}</summary>{displayRound && selectedStage ? <PatternProgress round={displayRound} misc={order.kind === "misc"} selected={selectedStage} search={window.location.search} disabled={busy || editing || exception !== null} /> : null}</details></Surface>
      </div>
      <Surface className="pattern-workspace"><section id="pattern-node-workspace" aria-label="节点办理区"><h2>{currentWorkspace && canAct ? "办理区" : "节点记录"}</h2>
      {displayRound && selectedStage && <PatternNodeRecord round={displayRound} misc={order.kind === "misc"} stage={selectedStage} />}
      {currentWorkspace && !editing ? <>
        {!exception && order.actions.assign ? <div className={`pattern-fields pattern-assignment${currentRound?.roundType === "rework" ? " has-rework-price" : ""}`}><label>板房师傅<div className="rework-v2-control"><SearchSelect options={workers.map(worker => ({ value: worker.personId, label: worker.name }))} value={personId} onChange={setPersonId} onSearchChange={setWorkerSearch} placeholder="输入姓名选择师傅" ariaLabel="板房师傅" emptyText="没有匹配的师傅" disabled={busy} /></div></label>{currentRound?.roundType === "rework" ? <InsetField label="本轮返工金额（元）" inputMode="decimal" value={reworkAmount} onChange={e => setReworkAmount(e.target.value)} disabled={busy} /> : null}<div className="rework-v2-actions pattern-single-action"><Button variant="primary" disabled={busy || !personId || (currentRound?.roundType === "rework" && !reworkAmount)} onClick={() => void act("assign")}>{busy ? "提交中…" : "确认分配"}</Button></div></div> : null}
        {!exception && order.actions.hours ? <div><h3>实际工时</h3><p>合计：{currentRound?.actualHours ? `${formatBusinessDecimal(currentRound.actualHours, 3)} 小时` : "待填写"}</p><div className="pattern-fields pattern-hours"><InsetField label="当前执行段实际工时（小时）" type="number" inputMode="decimal" min="0.1" max="999999.9" step="0.1" value={hours} onChange={e => setHours(e.target.value)} disabled={busy} /><div className="rework-v2-actions pattern-single-action"><Button variant="primary" disabled={busy || !hours} onClick={() => void act("hours")}>保存实际工时</Button></div></div></div> : null}
        {!exception ? <div className="pattern-actions">{order.actions.edit ? <Button disabled={busy} onClick={() => setEditing(true)}>更新任务资料</Button> : null}{order.actions.complete ? <Button variant="primary" disabled={busy} onClick={() => void confirmAction("complete")}>报完工</Button> : null}{order.actions.handoff ? <Button variant="primary" disabled={busy} onClick={() => void confirmAction("handoff")}>{order.kind === "misc" ? "确认完成" : "确认收到样板"}</Button> : null}</div> : null}
        <PatternOrderExceptions order={order} active={exception} onActive={value => { setException(value); }} busy={busy} onBusy={setBusy} onSaved={showUpdatedOrder} />
      </> : null}
      {!currentWorkspace && displayRound && selectedNode?.state !== "future" && selectedStage !== "pending_assignment" && <PatternRoundRecord round={displayRound} misc={order.kind === "misc"} idPrefix="node-" />}
      </section></Surface>
      {editing && !staleRound ? <PatternOrderForm key={order.version} order={order} onCancel={() => setEditing(false)} onSaved={updated => { showUpdatedOrder(updated); setEditing(false); }} /> : null}
      {visibleRounds.map(round => <Surface key={round.roundId}><details className="pattern-disclosure" open={staleRound || round.roundId === requestedRound || (round.roundId === order.currentRoundId && !window.matchMedia("(max-width: 760px)").matches)}><summary><strong>{order.kind === "misc" ? "杂事" : round.index === 0 ? "首次打板" : round.index === null ? "返工请求（未派工）" : `第 ${round.index} 次返工`} · {PATTERN_ORDER_STATUS_LABELS[round.status]}</strong></summary>
        <PatternRoundRecord round={round} misc={order.kind === "misc"} />
        <details className="pattern-node-history"><summary>节点用时</summary><PatternNodeHistory round={round} misc={order.kind === "misc"} /></details>
        {order.canReadMaterials !== false && order.attachments.some(file => file.roundId === round.roundId && (round.roundId !== displayRound?.roundId || !file.active)) && <details><summary>历史制作资料</summary><PatternMaterials files={order.attachments.filter(file => file.roundId === round.roundId && (round.roundId !== displayRound?.roundId || !file.active))} /></details>}
      </details></Surface>)}
      <Surface><details className="pattern-disclosure"><summary>订单记录（{formatBusinessDecimal(order.history.length)} 条）</summary><ol className="pattern-audit-list">{order.history.map((entry, index) => <li key={`${entry.at}:${index}`}><div><strong>{historyLabels[entry.action] ?? "订单操作"}</strong><span>{entry.actorName}</span><time>{patternTime(entry.at)}</time></div>{entry.reason && <p className="pattern-note">{entry.reason}</p>}</li>)}</ol></details></Surface>
    </> : null}
  </div>;
}
