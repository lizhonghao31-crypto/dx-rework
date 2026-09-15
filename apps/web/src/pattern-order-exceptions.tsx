import { PatternMaterials, type PatternMaterial } from "./pattern-materials.js";
import { SearchSelect } from "./search-select.js";
import { PatternField as InsetField } from "./pattern-controls.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { CancelPatternOrderSchema, PatternOrderDetailSchema, PatternRoundActionSchema, PatternWorkerOptionsSchema, RequestPatternReworkSchema, TransferPatternOrderSchema, type PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import type { z } from "zod";
import { createClientRequestId } from "./client-request-id.js";
import { patternRequest, uploadPatternOriginal } from "./pattern-order-client.js";
import { useDebouncedValue } from "./use-debounced-value.js";

export type PatternExceptionAction = "rework" | "transfer" | "cancel" | "cancel-fees";
const titles = { rework: "发起原单返工", transfer: "原单换人", cancel: "取消本次任务", "cancel-fees": "确认取消费用" };
export function PatternOrderExceptions({ order, active, onActive, busy, onBusy, onSaved }: { order: PatternOrderDetail; active: PatternExceptionAction | null; onActive(action: PatternExceptionAction | null): void; busy: boolean; onBusy(value: boolean): void; onSaved(order: PatternOrderDetail): void }) {
  const [reason, setReason] = useState(""), [category, setCategory] = useState("customer_change"), [amount, setAmount] = useState(""), [hours, setHours] = useState("");
  const [personId, setPersonId] = useState(""), [searchText, setSearchText] = useState(""), [workers, setWorkers] = useState<z.infer<typeof PatternWorkerOptionsSchema>>([]);
  const [files, setFiles] = useState<PatternMaterial[]>([]), [uploading, setUploading] = useState(false), [error, setError] = useState("");
  const disabled = busy || uploading;
  const [retained, setRetained] = useState<PatternMaterial[]>([]);
  const attempt = useRef<{ body: string; action: string; key: string } | null>(null), search = useDebouncedValue(searchText.trim(), 250);
  const round = order.rounds.find(item => item.roundId === order.currentRoundId)!, segment = round.segments.at(-1);
  const pending = order.status === "pending_assignment", fixedMisc = order.kind === "misc" && round.completedAt !== null && round.actualHours != null;
  useEffect(() => {
    setRetained(order.attachments.filter(file => file.roundId === order.currentRoundId && file.active));
    setReason(""); setAmount(""); setHours(""); setPersonId(""); setSearchText(""); setFiles([]); setError(""); attempt.current = null;
  }, [active, order.currentRoundId, order.attachments]);
  useEffect(() => {
    if (active !== "transfer") return;
    const abort = new AbortController();
    void patternRequest(`workers?q=${encodeURIComponent(search)}`, PatternWorkerOptionsSchema, { signal: abort.signal }).then(setWorkers).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [active, search]);
  const upload = async (selected: File[]) => {
    setUploading(true); onBusy(true); setError("");
    try {
      for (const file of selected) {
        const result = await uploadPatternOriginal(file, "pattern", "rework");
        setFiles(current => [...current, { attachmentId: result.attachmentId, filename: result.filename, mimeType: result.mimeType }]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "附件上传失败"); }
    finally { setUploading(false); onBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!active || busy || uploading) return;
    const basis = { version: order.version, roundId: order.currentRoundId };
    const input = active === "rework" ? RequestPatternReworkSchema.safeParse({ ...basis, reason, reasonCategory: category, retainedAttachmentIds: retained.map(file => file.attachmentId), attachmentIds: files.map(file => file.attachmentId) })
      : active === "transfer" ? TransferPatternOrderSchema.safeParse({ ...basis, segmentId: segment?.segmentId, personId, reason, ...(order.kind === "misc" ? { hours } : { amount }) })
      : active === "cancel" ? CancelPatternOrderSchema.safeParse({ ...basis, reason, ...(!pending ? { segmentId: segment?.segmentId, ...(order.kind === "pattern" ? { amount } : fixedMisc ? {} : { hours }) } : {}) })
      : PatternRoundActionSchema.safeParse(basis);
    if (!input.success) { setError(input.error.issues[0]?.message ?? "请填写必要信息"); return; }
    const body = JSON.stringify(input.data);
    if (attempt.current?.body !== body || attempt.current.action !== active) attempt.current = { body, action: active, key: createClientRequestId() };
    onBusy(true); setError("");
    try {
      const result = await patternRequest(`orders/${order.orderId}/${active}`, PatternOrderDetailSchema, { method: "POST", body, headers: { "idempotency-key": attempt.current.key } });
      onSaved(result); onActive(null);
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { onBusy(false); }
  };
  if (!active) return <div className="pattern-actions">
    {order.actions.rework ? <Button disabled={disabled} onClick={() => onActive("rework")}>发起原单返工</Button> : null}
    {order.actions.transfer ? <Button disabled={disabled} onClick={() => onActive("transfer")}>原单换人</Button> : null}
    {order.actions.cancel ? <Button disabled={disabled} onClick={() => onActive("cancel")}>取消任务</Button> : null}
    {order.actions.cancelFees ? <Button disabled={disabled} onClick={() => onActive("cancel-fees")}>确认取消费用</Button> : null}
  </div>;
  return <form className="pattern-exception pattern-order-form" onSubmit={event => void submit(event)}><h3>{titles[active]}</h3>
    {active === "rework" ? <>
      <label>返工原因分类<select className="rework-v2-control" disabled={disabled} value={category} onChange={e => setCategory(e.target.value)}><option value="customer_change">客户修改要求</option><option value="workmanship">制作不符合要求</option><option value="other">其他</option></select></label>

      <label className="rework-v2-upload">补充图片 / PDF<input type="file" multiple accept="application/pdf,image/*,.pdf,.jpg,.jpeg,.png,.webp" disabled={disabled} onChange={e => { const selected = Array.from(e.target.files ?? []); e.target.value = ""; if (selected.length + files.length + retained.length > 20) setError("本轮资料合计最多20份，请先移除不需要的资料"); else void upload(selected); }} /></label>
      <PatternMaterials files={[...retained, ...files]} disabled={disabled} onRemove={id => { setRetained(current => current.filter(file => file.attachmentId !== id)); setFiles(current => current.filter(file => file.attachmentId !== id)); }} />
    </> : null}
    {active === "transfer" ? <label>接手师傅<div className="rework-v2-control"><SearchSelect options={workers.filter(worker => worker.userId !== segment?.workerUserId).map(worker => ({ value: worker.personId, label: worker.name }))} value={personId} onChange={setPersonId} onSearchChange={setSearchText} placeholder="输入姓名选择师傅" ariaLabel="接手师傅" emptyText="没有匹配的师傅" disabled={disabled} /></div></label> : null}
    {active === "transfer" || (active === "cancel" && !pending) ? <>
      <p>当前执行人：{segment?.workerName}。{order.kind === "pattern" ? `当前段金额 ${formatBusinessDecimal(segment?.amount ?? "0", 3)} 元；以前执行段保留。` : "按本单保存的小时价计算每段实际劳动。"}</p>
      {order.kind === "pattern" ? <InsetField label={active === "transfer" ? "原工人应得部分（元，无实际制作填0）" : "当前工人取消部分费用（元，无费用填0）"} inputMode="decimal" required value={amount} disabled={disabled} onChange={e => setAmount(e.target.value)} />
        : active === "cancel" && fixedMisc ? <p>工时与完工已确定，本次保留既有计薪事实。</p>
        : <InsetField label="当前执行段已做工时（小时，无实际工作填0）" inputMode="decimal" required value={hours} disabled={disabled} onChange={e => setHours(e.target.value)} />}
    </> : null}
    {active === "cancel" ? <p>{pending ? "取消未派工请求，保留历史轮次。" : "确认工作已经停止。打板有费用时，仍由原设计师确认取消费用。"}</p> : null}
    {active === "cancel-fees" ? <><p>请核对以下取消费用，确认后计入工资，订单仍为已取消。</p>{order.rounds.filter(item => item.cancelledAmount != null && /[1-9]/.test(item.cancelledAmount) && item.feeConfirmedAt === null).map(item => <p key={item.roundId}>{item.index === 0 ? "首次打板" : `第${item.index}次返工`}：{formatBusinessDecimal(item.cancelledAmount!, 3)} 元</p>)}</>
      : <label>{active === "rework" ? "返工内容 / 原因（必填）" : "操作说明（必填）"}<textarea className="rework-v2-control" required maxLength={active === "rework" ? 2000 : 500} disabled={disabled} value={reason} onChange={e => setReason(e.target.value)} /></label>}
    {error ? <p role="alert">{error}</p> : null}{uploading ? <p role="status">正在上传原始资料…</p> : null}
    <div className="rework-v2-action-area"><div className="rework-v2-actions"><Button type="button" disabled={disabled} onClick={() => onActive(null)}>暂不提交</Button><Button type="submit" variant="primary" disabled={disabled}>{busy ? "提交中…" : titles[active]}</Button></div></div>
  </form>;
}
