import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Button, InsetField, Surface } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { PATTERN_ORDER_STATUS_LABELS, PatternOrderDetailSchema, PatternOrderListSchema, PatternPeopleFiltersSchema, PatternWorkerOptionsSchema, type PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { Header } from "./components.js";
import { createClientRequestId } from "./client-request-id.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { PatternOrderForm } from "./pattern-order-form.js";
import { elapsedText, patternRequest, patternTime, patternUrls } from "./pattern-order-client.js";
import { patternListPath, patternReturnPath, readPatternListQuery } from "./pattern-order-query.js";
import "./pattern-room.css";

const { apiUrl, pageUrl } = patternUrls;
export function PatternRoomOrdersPage() {
  const [initial] = useState(() => readPatternListQuery(window.location.search));
  const [data, setData] = useState<z.infer<typeof PatternOrderListSchema> | null>(null), [error, setError] = useState("");
  const [q, setQ] = useState(initial.q), [status, setStatus] = useState(initial.status), [creatorId, setCreatorId] = useState(initial.creatorId), [workerId, setWorkerId] = useState(initial.workerId), [page, setPage] = useState(initial.page);
  const [people, setPeople] = useState<z.infer<typeof PatternPeopleFiltersSchema> | null>(null), [creating, setCreating] = useState(false), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true);
  const search = useDebouncedValue(q.trim(), 250);
  const listPath = patternListPath({ q: search, status, creatorId, workerId, page });
  const detailHref = (id: string) => `${pageUrl(`ui/pattern-room/orders/${id}`)}?${new URLSearchParams({ returnTo: listPath })}`;
  useEffect(() => { window.history.replaceState(null, "", pageUrl(listPath)); }, [listPath]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(page), q: search });
    if (status) params.set("status", status); if (creatorId) params.set("creatorId", creatorId); if (workerId) params.set("workerId", workerId);
    void patternRequest(`orders?${params}`, PatternOrderListSchema, { signal: abort.signal }).then(setData).catch(e => { if (!abort.signal.aborted) { setError(e.message); setData(null); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [search, status, creatorId, workerId, page, refresh]);
  useEffect(() => {
    if (!data?.canFilterPeople) { setPeople(null); return; }
    const abort = new AbortController();
    void patternRequest("people-filters", PatternPeopleFiltersSchema, { signal: abort.signal }).then(setPeople).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [data?.canFilterPeople, refresh]);
  return <div className="pattern-orders"><Header title="创建订单" badge="订单打板" badgePlacement="subtitle" />
    {error ? <Surface><p role="alert">{error}</p><Button onClick={() => setRefresh(value => value + 1)}>重新读取</Button></Surface> : null}
    {creating ? <PatternOrderForm onCancel={() => setCreating(false)} onSaved={order => { window.location.assign(detailHref(order.orderId)); }} /> : null}
    {data ? <Surface>
      <div className="pattern-actions"><h2>板房订单</h2>{data.canCreate && !creating ? <Button variant="primary" onClick={() => setCreating(true)}>新建打板</Button> : null}</div>
      <div className="pattern-fields"><InsetField label="搜索款号或订单号" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
        <label>订单状态<select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(PATTERN_ORDER_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {people ? <><label>创建人<select value={creatorId} onChange={e => { setCreatorId(e.target.value); setPage(1); }}><option value="">全部创建人</option>{people.creators.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <label>执行工人<select value={workerId} onChange={e => { setWorkerId(e.target.value); setPage(1); }}><option value="">全部工人</option>{people.workers.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label></> : null}
      </div>
      <div className="pattern-price-table" aria-busy={loading}><table><thead><tr><th>订单 / 本次款号</th><th>状态</th><th>创建人</th><th>当前工人</th><th>要求完成</th><th>返工</th><th>提交时间</th></tr></thead><tbody>
        {data.items.map(order => <tr key={order.orderId}><th scope="row"><a href={detailHref(order.orderId)}>{order.orderNo}</a><small>{order.styleNo}</small></th><td>{PATTERN_ORDER_STATUS_LABELS[order.status]}</td><td>{order.creatorName}</td><td>{order.currentWorkerName ?? "待分配"}</td><td>{order.requiredDate ?? "—"}</td><td>{order.reworkCount} 次</td><td>{patternTime(order.submittedAt)}</td></tr>)}
      </tbody></table></div>
      {!data.items.length ? <p>没有符合条件的订单。</p> : null}
      <div className="pattern-actions"><span>共 {data.totalCount} 单 · 第 {data.page} / {data.totalPages} 页</span><Button disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Button disabled={loading || page >= data.totalPages} onClick={() => setPage(value => value + 1)}>下一页</Button></div>
    </Surface> : loading ? <p role="status">正在读取订单…</p> : null}
  </div>;
}

const historyLabels: Record<string, string> = { "pattern_room.order.submitted": "提交打板", "pattern_room.order.assigned": "分配工人", "pattern_room.order.work_completed": "工人完工", "pattern_room.order.handed_over": "设计师确认交接", "pattern_room.order.materials_changed": "更新制作资料" };
export function PatternRoomOrderDetailPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<PatternOrderDetail | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false), [refresh, setRefresh] = useState(0);
  const [workers, setWorkers] = useState<z.infer<typeof PatternWorkerOptionsSchema>>([]), [workerSearch, setWorkerSearch] = useState(""), [personId, setPersonId] = useState("");
  const [confirmation, setConfirmation] = useState<"complete" | "handoff" | null>(null);
  const search = useDebouncedValue(workerSearch.trim(), 250), requestedRound = new URLSearchParams(window.location.search).get("round");
  const staleRound = Boolean(order && requestedRound && requestedRound !== order.currentRoundId);
  const attempt = useRef<{ body: string; action: string; key: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); setError("");
    void patternRequest(`orders/${orderId}`, PatternOrderDetailSchema, { signal: abort.signal }).then(data => { setOrder(data); setConfirmation(null); }).catch(e => { if (!abort.signal.aborted) { setOrder(null); setError(e.message); } });
    return () => abort.abort();
  }, [orderId, refresh]);
  useEffect(() => {
    if (!order?.actions.assign || staleRound) return;
    const abort = new AbortController();
    void patternRequest(`workers?q=${encodeURIComponent(search)}`, PatternWorkerOptionsSchema, { signal: abort.signal }).then(setWorkers).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [order?.actions.assign, staleRound, search]);
  const act = async (action: "assign" | "complete" | "handoff") => {
    if (!order || busy || staleRound) return;
    const body = JSON.stringify({ roundId: order.currentRoundId, version: order.version, ...(action === "assign" ? { personId } : {}) });
    if (attempt.current?.body !== body || attempt.current.action !== action) attempt.current = { body, action, key: createClientRequestId() };
    setBusy(true); setError("");
    try { setOrder(await patternRequest(`orders/${orderId}/${action}`, PatternOrderDetailSchema, { method: "POST", body, headers: { "idempotency-key": attempt.current.key } })); setConfirmation(null); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const visibleRounds = staleRound ? order?.rounds.filter(round => round.roundId === requestedRound) ?? [] : order?.rounds ?? [];
  return <div className="pattern-orders"><Header title={order?.styleNo ?? "板房订单"} badge={order?.orderNo ?? "订单打板"} badgePlacement="subtitle" />
    <div className="pattern-actions"><a href={pageUrl(patternReturnPath(window.location.search))}>返回列表</a><Button disabled={busy || editing} onClick={() => setRefresh(value => value + 1)}>刷新订单</Button></div>
    {error ? <Surface><p role="alert">{error}</p><Button disabled={busy} onClick={() => { setEditing(false); setRefresh(value => value + 1); }}>重新读取订单</Button></Surface> : null}
    {!order && !error ? <p role="status">正在读取订单…</p> : null}
    {order ? <>
      {staleRound ? <Surface><p>这是历史轮次链接，仅供查看。</p><a href={pageUrl(`ui/pattern-room/orders/${orderId}`)}>查看当前订单</a></Surface> : null}
      <Surface><h2>{PATTERN_ORDER_STATUS_LABELS[order.status]}</h2><dl className="pattern-facts">
        <div><dt>创建人</dt><dd>{order.creatorName}</dd></div><div><dt>要求完成</dt><dd>{order.requiredDate ?? "—"}</dd></div><div><dt>客户</dt><dd>{order.customer || "—"}</dd></div><div><dt>尺码与颜色</dt><dd>{order.sizeColor || "—"}</dd></div><div><dt>版型</dt><dd>{order.variant ?? "—"}</dd></div><div><dt>参考历史款号</dt><dd>{order.referenceStyleNo || "—"}</dd></div>
      </dl>{order.note ? <p className="pattern-note">{order.note}</p> : null}
      {!staleRound && !editing ? <>
        {order.actions.assign ? <div className="pattern-fields"><InsetField label="搜索工人" value={workerSearch} onChange={e => { setWorkerSearch(e.target.value); setPersonId(""); }} disabled={busy} /><label>执行工人<select value={personId} onChange={e => setPersonId(e.target.value)} disabled={busy}><option value="">请选择工人</option>{workers.map(worker => <option key={worker.personId} value={worker.personId}>{worker.name}</option>)}</select></label><Button disabled={busy || !personId} onClick={() => void act("assign")}>确认分配</Button></div> : null}
        <div className="pattern-actions">{order.actions.edit ? <Button disabled={busy} onClick={() => setEditing(true)}>更新制作资料</Button> : null}{order.actions.complete ? <Button disabled={busy} onClick={() => setConfirmation("complete")}>报完工</Button> : null}{order.actions.handoff ? <Button disabled={busy} onClick={() => setConfirmation("handoff")}>确认收到样板</Button> : null}</div>
        {confirmation ? <div className="pattern-confirm"><p>{confirmation === "complete" ? "确认本轮制作已完成？提交后将交由设计师确认交接。" : "确认已收到本轮样板？交接后，本轮已完成的正金额工人记录将取得计薪资格。"}</p><div className="pattern-actions"><Button disabled={busy} onClick={() => setConfirmation(null)}>暂不提交</Button><Button variant="primary" disabled={busy} onClick={() => void act(confirmation)}>{busy ? "提交中…" : "确认提交"}</Button></div></div> : null}
      </> : null}</Surface>
      {editing && !staleRound ? <PatternOrderForm key={order.version} order={order} onCancel={() => setEditing(false)} onSaved={updated => { setOrder(updated); setEditing(false); }} /> : null}
      {visibleRounds.map(round => <Surface key={round.roundId}><h2>{round.index === 0 ? "首次打板" : `返工第 ${round.index} 轮`} · {PATTERN_ORDER_STATUS_LABELS[round.status]}</h2>
        <p>{round.categoryName} · {formatBusinessDecimal(round.quantity)} {round.unit}{round.unitPrice !== undefined ? ` · ${formatBusinessDecimal(round.unitPrice)} 元/${round.unit}` : ""}{round.agreedAmount !== undefined ? ` · 合计 ${formatBusinessDecimal(round.agreedAmount)} 元` : ""}</p>
        {round.segments.map(segment => <p key={segment.segmentId}>{segment.workerName}{segment.amount !== undefined ? ` · 分配金额 ${formatBusinessDecimal(segment.amount)} 元` : ""} · {segment.wageEligible ? "已具备计薪资格" : "尚未计薪"}</p>)}
        <p>节点耗时截至本次读取，可刷新查看最新耗时。</p><ol className="pattern-nodes">{round.nodes.map(node => <li key={node.stage}><strong>{PATTERN_ORDER_STATUS_LABELS[node.stage]}</strong><span>{patternTime(node.enteredAt)} → {node.exitedAt ? patternTime(node.exitedAt) : "当前"}</span><span>{elapsedText(node.elapsedSeconds)}</span></li>)}</ol>
        <h3>制作资料</h3><ul className="pattern-files">{order.attachments.filter(file => file.roundId === round.roundId).map(file => <li key={file.attachmentId}><span>{file.filename}{!file.active ? "（历史资料）" : ""}</span><a href={apiUrl(`pattern-room/attachments/${file.attachmentId}/download?mode=preview`)} target="_blank" rel="noreferrer">查看 / 打印</a><a href={apiUrl(`pattern-room/attachments/${file.attachmentId}/download?mode=download`)}>下载</a></li>)}</ul>
      </Surface>)}
      <Surface><h2>订单记录</h2>{order.history.map((entry, index) => <p key={`${entry.at}:${index}`}>{patternTime(entry.at)} · {entry.actorName} · {historyLabels[entry.action] ?? "订单操作"}{entry.reason ? ` · ${entry.reason}` : ""}</p>)}</Surface>
    </> : null}
  </div>;
}
