import { PatternMaterials } from "./pattern-materials.js";
import { ListPagination } from "./list-pagination.js";
import { SearchSelect } from "./search-select.js";
import { confirmInApp } from "./system-dialog.js";
import { PatternField as InsetField, PatternProgress } from "./pattern-controls.js";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Button, Surface } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { AssignPatternOrderSchema, PATTERN_ORDER_STATUS_LABELS, PatternOrderDetailSchema, PatternOrderListSchema, PatternPeopleFiltersSchema, PatternWorkerOptionsSchema, RecordPatternHoursSchema, type PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { Header } from "./components.js";
import { createClientRequestId } from "./client-request-id.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { PatternOrderForm } from "./pattern-order-form.js";
import { PatternOrderExceptions, type PatternExceptionAction } from "./pattern-order-exceptions.js";
import { elapsedText, patternRequest, patternTime, patternUrls } from "./pattern-order-client.js";
import { patternListPath, patternReturnPath, readPatternListQuery } from "./pattern-order-query.js";
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
  useEffect(() => { window.history.replaceState(null, "", pageUrl(listPath)); }, [listPath]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(page), q: search });
    if (status) params.set("status", status); if (creatorId) params.set("creatorId", creatorId); if (workerId) params.set("workerId", workerId);
    if (kind) params.set("kind", kind);
    void patternRequest(`orders?${params}`, PatternOrderListSchema, { signal: abort.signal }).then(setData).catch(e => { if (!abort.signal.aborted) { setError(e.message); setData(null); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [search, kind, status, creatorId, workerId, page, refresh]);
  useEffect(() => {
    if (!data?.canFilterPeople) { setPeople(null); return; }
    const abort = new AbortController();
    void patternRequest("people-filters", PatternPeopleFiltersSchema, { signal: abort.signal }).then(setPeople).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [data?.canFilterPeople, refresh]);
  return <div className="pattern-orders"><Header title="打板杂事看板" badge="订单打板" badgePlacement="subtitle" />
    {error ? <Surface><p role="alert">{error}</p><Button onClick={() => setRefresh(value => value + 1)}>重新读取</Button></Surface> : null}
    {data ? <Surface>
      <div className="pattern-fields pattern-filters"><InsetField label="搜索款号、订单号或任务名称" placeholder="款号 / 订单号 / 任务名称" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
        <label>订单类型<select value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}><option value="">全部</option><option value="pattern">打板</option><option value="misc">杂事</option></select></label>
        <label>订单状态<select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(PATTERN_ORDER_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {people ? <><label>创建人<select value={creatorId} onChange={e => { setCreatorId(e.target.value); setPage(1); }}><option value="">全部创建人</option>{people.creators.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <label>执行工人<select value={workerId} onChange={e => { setWorkerId(e.target.value); setPage(1); }}><option value="">全部工人</option>{people.workers.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label></> : null}
      </div>
      <div className="pattern-order-list" aria-busy={loading}>
        {data.items.map(order => <article className="pattern-order-row" key={order.orderId}>
          <div className="pattern-order-identity"><a href={detailHref(order.orderId)}>{order.kind === "misc" ? order.taskName : order.styleNo}</a><small>{order.orderNo}</small></div>
          <div><small>类型 / 状态</small><span>{order.kind === "misc" ? "杂事" : "打板"} · {PATTERN_ORDER_STATUS_LABELS[order.status]}</span></div>
          <div><small>创建人</small><span>{order.creatorName}</span></div>
          <div><small>当前师傅</small><span>{order.currentWorkerName ?? "待分配"}</span></div>
          <div><small>要求完成</small><span>{order.requiredDate ?? "—"}</span></div>
          <div><small>返工 / 提交时间</small><span>{order.reworkCount} 次</span><small>{patternTime(order.submittedAt)}</small></div>
        </article>)}
      </div>
      {!data.items.length ? <p className="pattern-empty">没有符合条件的订单。</p> : null}
      <div className="pattern-pagination"><span>共 {formatBusinessDecimal(data.totalCount)} 单</span><ListPagination page={data.page} totalPages={data.totalPages} busy={loading} onPageChange={setPage} ariaLabel="打板杂事看板分页" /></div>
    </Surface> : loading ? <p role="status">正在读取订单…</p> : null}
  </div>;
}

const historyLabels: Record<string, string> = { "pattern_room.order.submitted": "提交打板", "pattern_room.misc.submitted": "提交杂事", "pattern_room.misc.confirmed": "发起人确认杂事完成", "pattern_room.misc.hours_recorded": "主管填写实际工时", "pattern_room.order.assigned": "分配工人", "pattern_room.order.work_completed": "工人完工", "pattern_room.order.handed_over": "设计师确认交接", "pattern_room.order.materials_changed": "更新任务资料", "pattern_room.order.rework_requested": "发起原单返工", "pattern_room.order.worker_changed": "主管原单换人", "pattern_room.order.cancelled": "取消本次任务", "pattern_room.order.cancel_fees_confirmed": "设计师确认取消费用" };
export function PatternRoomOrderDetailPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<PatternOrderDetail | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false), [refresh, setRefresh] = useState(0);
  const [workers, setWorkers] = useState<z.infer<typeof PatternWorkerOptionsSchema>>([]), [workerSearch, setWorkerSearch] = useState(""), [personId, setPersonId] = useState("");
  const [hours, setHours] = useState("");
  const [reworkAmount, setReworkAmount] = useState(""), [exception, setException] = useState<PatternExceptionAction | null>(null);
  const search = useDebouncedValue(workerSearch.trim(), 250), requestedRound = new URLSearchParams(window.location.search).get("round");
  const staleRound = Boolean(order && requestedRound && requestedRound !== order.currentRoundId);
  const attempt = useRef<{ body: string; action: string; key: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); setError("");
    void patternRequest(`orders/${orderId}`, PatternOrderDetailSchema, { signal: abort.signal }).then(data => { setOrder(data); setException(null); }).catch(e => { if (!abort.signal.aborted) { setOrder(null); setError(e.message); } });
    return () => abort.abort();
  }, [orderId, refresh]);
  useEffect(() => {
    if (!order?.actions.assign || staleRound) return;
    const abort = new AbortController();
    void patternRequest(`workers?q=${encodeURIComponent(search)}`, PatternWorkerOptionsSchema, { signal: abort.signal }).then(setWorkers).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [order?.actions.assign, staleRound, search]);
  const act = async (action: "assign" | "complete" | "handoff" | "hours") => {
    if (!order || busy || staleRound) return;
    const current = order.rounds.find(round => round.roundId === order.currentRoundId);
    const input = { roundId: order.currentRoundId, version: order.version, ...(action === "assign" ? { personId, ...(current?.roundType === "rework" ? { amount: reworkAmount } : {}) } : {}), ...(action === "hours" ? { hours } : {}) };
    if (action === "assign") { const parsed = AssignPatternOrderSchema.safeParse(input); if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请填写有效派工信息"); return; } }
    if (action === "hours") { const parsed = RecordPatternHoursSchema.safeParse(input); if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请填写有效工时"); return; } }
    const body = JSON.stringify(input), path = action === "handoff" && order.kind === "misc" ? "confirm" : action;
    if (attempt.current?.body !== body || attempt.current.action !== action) attempt.current = { body, action, key: createClientRequestId() };
    setBusy(true); setError("");
    try { setOrder(await patternRequest(`orders/${orderId}/${path}`, PatternOrderDetailSchema, { method: "POST", body, headers: { "idempotency-key": attempt.current.key } })); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const visibleRounds = staleRound ? order?.rounds.filter(round => round.roundId === requestedRound) ?? [] : order?.rounds ?? [];
  const currentRound = order?.rounds.find(round => round.roundId === order.currentRoundId);
  const displayRound = staleRound ? visibleRounds[0] : currentRound;
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
  return <div className="pattern-orders"><Header title={order ? order.kind === "misc" ? order.taskName ?? "杂事" : order.styleNo : "板房订单"} badge={order?.orderNo ?? "订单打板"} badgePlacement="subtitle" />
    <div className="pattern-actions"><a href={pageUrl(patternReturnPath(window.location.search))}>返回列表</a><Button disabled={busy || editing} onClick={() => setRefresh(value => value + 1)}>刷新订单</Button></div>
    {error ? <Surface><p role="alert">{error}</p><Button disabled={busy} onClick={() => { setEditing(false); setRefresh(value => value + 1); }}>重新读取订单</Button></Surface> : null}
    {!order && !error ? <p role="status">正在读取订单…</p> : null}
    {order ? <>
      {staleRound ? <Surface><p>这是历史轮次链接，仅供查看。</p><a href={pageUrl(`ui/pattern-room/orders/${orderId}`)}>查看当前订单</a></Surface> : null}
      <Surface><h2>订单信息 <small className="pattern-status">{displayRound ? PATTERN_ORDER_STATUS_LABELS[displayRound.status] : "轮次不存在"}</small></h2><dl className="pattern-facts">
        <div><dt>创建人</dt><dd>{order.creatorName}</dd></div><div><dt>要求完成</dt><dd>{order.requiredDate ?? "—"}</dd></div>{order.kind === "misc" ? <div><dt>关联款号</dt><dd>{order.styleNo || "—"}</dd></div> : <><div><dt>客户</dt><dd>{order.customer || "—"}</dd></div><div><dt>尺码与颜色</dt><dd>{order.sizeColor || "—"}</dd></div><div><dt>版型</dt><dd>{order.variant ?? "—"}</dd></div><div><dt>参考历史款号</dt><dd>{order.referenceStyleNo || "—"}</dd></div></>}
      </dl>{order.note ? <p className="pattern-note">{order.note}</p> : null}
      </Surface>
      {order.canReadMaterials !== false && displayRound ? <Surface><h2>制作资料</h2><PatternMaterials files={order.attachments.filter(file => file.roundId === displayRound.roundId && file.active)} /></Surface> : null}
      <Surface>{displayRound ? <PatternProgress round={displayRound} misc={order.kind === "misc"} /> : null}
      {!staleRound && !editing ? <>
        {!exception && order.actions.assign ? <div className="pattern-fields pattern-assignment"><label>板房师傅<div className="rework-v2-control"><SearchSelect options={workers.map(worker => ({ value: worker.personId, label: worker.name }))} value={personId} onChange={setPersonId} onSearchChange={setWorkerSearch} placeholder="输入姓名选择师傅" ariaLabel="板房师傅" emptyText="没有匹配的师傅" disabled={busy} /></div></label>{currentRound?.roundType === "rework" ? <InsetField label="本轮返工金额（元）" inputMode="decimal" value={reworkAmount} onChange={e => setReworkAmount(e.target.value)} disabled={busy} /> : null}<div className="rework-v2-actions"><Button variant="primary" disabled={busy || !personId || (currentRound?.roundType === "rework" && !reworkAmount)} onClick={() => void act("assign")}>{busy ? "提交中…" : "确认分配"}</Button></div></div> : null}
        {!exception && order.actions.hours ? <div><h3>实际工时</h3><p>合计：{currentRound?.actualHours ? `${formatBusinessDecimal(currentRound.actualHours, 3)} 小时` : "待填写"}</p><div className="pattern-fields"><InsetField label="当前执行段实际工时（小时）" type="number" inputMode="decimal" min="0.1" max="999999.9" step="0.1" value={hours} onChange={e => setHours(e.target.value)} disabled={busy} /><Button variant="primary" disabled={busy || !hours} onClick={() => void act("hours")}>保存实际工时</Button></div></div> : null}
        {!exception ? <div className="pattern-actions">{order.actions.edit ? <Button disabled={busy} onClick={() => setEditing(true)}>更新任务资料</Button> : null}{order.actions.complete ? <Button variant="primary" disabled={busy} onClick={() => void confirmAction("complete")}>报完工</Button> : null}{order.actions.handoff ? <Button variant="primary" disabled={busy} onClick={() => void confirmAction("handoff")}>{order.kind === "misc" ? "确认完成" : "确认收到样板"}</Button> : null}</div> : null}
        <PatternOrderExceptions order={order} active={exception} onActive={value => { setException(value); }} busy={busy} onBusy={setBusy} onSaved={setOrder} />
      </> : null}</Surface>
      {editing && !staleRound ? <PatternOrderForm key={order.version} order={order} onCancel={() => setEditing(false)} onSaved={updated => { setOrder(updated); setEditing(false); }} /> : null}
      {visibleRounds.map(round => <Surface key={round.roundId}><details open={staleRound || round.roundId === order.currentRoundId || round.roundId === requestedRound}><summary><strong>{order.kind === "misc" ? "杂事" : round.index === 0 ? "首次打板" : round.index === null ? "返工请求（未派工）" : `第 ${round.index} 次返工`} · {PATTERN_ORDER_STATUS_LABELS[round.status]}</strong></summary>
        {round.requestReason ? <p className="pattern-note">返工要求：{round.requestReason}</p> : null}
        {round.cancelledAt ? <p>取消时间：{patternTime(round.cancelledAt)}{round.cancelledAmount != null ? ` · 取消部分费用 ${formatBusinessDecimal(round.cancelledAmount, 3)} 元` : ""}{round.feeConfirmedAt ? ` · 费用确认 ${patternTime(round.feeConfirmedAt)}` : ""}</p> : null}
        <p>{round.categoryName} · {order.kind === "misc" ? round.actualHours === undefined ? "按工时计价" : round.actualHours === null ? "工时待填写" : `${formatBusinessDecimal(round.actualHours, 3)} 小时` : round.roundType === "rework" ? round.agreedAmount === null ? "金额待主管核定" : "本轮金额由主管核定" : `${round.quantity === null ? "—" : formatBusinessDecimal(round.quantity, 3)} ${round.unit}`}{round.unitPrice !== undefined ? ` · ${formatBusinessDecimal(round.unitPrice, 3)} 元/${round.unit}` : ""}{round.agreedAmount != null ? ` · 合计 ${formatBusinessDecimal(round.agreedAmount, 3)} 元` : ""}</p>
        {round.segments.map(segment => <p id={`segment-${segment.segmentId}`} key={segment.segmentId}>{segment.workerName}{segment.actualHours !== null ? ` · ${formatBusinessDecimal(segment.actualHours, 3)} 小时` : ""}{segment.amount != null ? ` · 分配金额 ${formatBusinessDecimal(segment.amount, 3)} 元` : ""} · {segment.wageEligible ? "可计薪" : order.kind === "misc" && segment.actualHours === null ? "工时待填写" : "待计薪"}</p>)}
        <details className="pattern-node-history"><summary>节点用时</summary><ol className="pattern-nodes">{round.nodes.map(node => <li key={node.stage}><strong>{PATTERN_ORDER_STATUS_LABELS[node.stage]}</strong><span>{patternTime(node.enteredAt)} → {node.exitedAt ? patternTime(node.exitedAt) : "当前"}</span><span>{elapsedText(node.elapsedSeconds)}</span></li>)}</ol></details>
        {order.canReadMaterials !== false && order.attachments.some(file => file.roundId === round.roundId && (round.roundId !== displayRound?.roundId || !file.active)) && <details><summary>历史制作资料</summary><PatternMaterials files={order.attachments.filter(file => file.roundId === round.roundId && (round.roundId !== displayRound?.roundId || !file.active))} /></details>}
      </details></Surface>)}
      <Surface><details><summary>订单记录（{order.history.length} 条）</summary>{order.history.map((entry, index) => <p key={`${entry.at}:${index}`}>{patternTime(entry.at)} · {entry.actorName} · {historyLabels[entry.action] ?? "订单操作"}{entry.reason ? ` · ${entry.reason}` : ""}</p>)}</details></Surface>
    </> : null}
  </div>;
}
