import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, InsetField } from "@dx-rework/ui";
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
  const [files, setFiles] = useState<Array<{ attachmentId: string; filename: string }>>([]), [uploading, setUploading] = useState(false), [error, setError] = useState("");
  const attempt = useRef<{ body: string; action: string; key: string } | null>(null), search = useDebouncedValue(searchText.trim(), 250);
  const round = order.rounds.find(item => item.roundId === order.currentRoundId)!, segment = round.segments.at(-1);
  const pending = order.status === "pending_assignment", fixedMisc = order.kind === "misc" && round.completedAt !== null && round.actualHours != null;
  useEffect(() => {
    setReason(""); setAmount(""); setHours(""); setPersonId(""); setSearchText(""); setFiles([]); setError(""); attempt.current = null;
  }, [active, order.currentRoundId]);
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
        setFiles(current => [...current, { attachmentId: result.attachmentId, filename: result.filename }]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "附件上传失败"); }
    finally { setUploading(false); onBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!active || busy || uploading) return;
    const basis = { version: order.version, roundId: order.currentRoundId };
    const input = active === "rework" ? RequestPatternReworkSchema.safeParse({ ...basis, reason, reasonCategory: category, attachmentIds: files.map(file => file.attachmentId) })
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
    {order.actions.rework ? <Button disabled={busy} onClick={() => onActive("rework")}>发起原单返工</Button> : null}
    {order.actions.transfer ? <Button disabled={busy} onClick={() => onActive("transfer")}>原单换人</Button> : null}
    {order.actions.cancel ? <Button disabled={busy} onClick={() => onActive("cancel")}>取消任务</Button> : null}
    {order.actions.cancelFees ? <Button disabled={busy} onClick={() => onActive("cancel-fees")}>确认取消费用</Button> : null}
  </div>;
  return <form className="pattern-confirm pattern-order-form" onSubmit={event => void submit(event)}><h3>{titles[active]}</h3>
    {active === "rework" ? <>
      <label>返工原因分类<select disabled={busy} value={category} onChange={e => setCategory(e.target.value)}><option value="customer_change">客户修改要求</option><option value="workmanship">制作不符合要求</option><option value="other">其他</option></select></label>
      <p>沿用本单制作资料，可补充新文件。主管明确核定金额并派工后计为一次返工。</p>
      <label>补充 PDF / 清晰图片<input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" disabled={busy} onChange={e => { const selected = Array.from(e.target.files ?? []); e.target.value = ""; if (selected.length + files.length > 20) setError("最多补充20份资料"); else void upload(selected); }} /></label>
      <ul className="pattern-files">{files.map(file => <li key={file.attachmentId}>{file.filename}<Button type="button" disabled={busy} onClick={() => setFiles(current => current.filter(item => item.attachmentId !== file.attachmentId))}>移出</Button></li>)}</ul>
    </> : null}
    {active === "transfer" ? <div className="pattern-fields"><InsetField label="搜索接手工人" value={searchText} disabled={busy} onChange={e => { setSearchText(e.target.value); setPersonId(""); }} /><label>接手工人<select required disabled={busy} value={personId} onChange={e => setPersonId(e.target.value)}><option value="">请选择另一名工人</option>{workers.filter(worker => worker.userId !== segment?.workerUserId).map(worker => <option key={worker.personId} value={worker.personId}>{worker.name}</option>)}</select></label></div> : null}
    {active === "transfer" || (active === "cancel" && !pending) ? <>
      <p>当前执行人：{segment?.workerName}。{order.kind === "pattern" ? `当前段金额 ${formatBusinessDecimal(segment?.amount ?? "0")} 元；以前执行段保留。` : "按本单保存的小时价计算每段实际劳动。"}</p>
      {order.kind === "pattern" ? <InsetField label={active === "transfer" ? "原工人应得部分（元，无实际制作填0）" : "当前工人取消部分费用（元，无费用填0）"} inputMode="decimal" required value={amount} disabled={busy} onChange={e => setAmount(e.target.value)} />
        : active === "cancel" && fixedMisc ? <p>工时与完工已确定，本次保留既有计薪事实。</p>
        : <InsetField label="当前执行段已做工时（小时，无实际工作填0）" inputMode="decimal" required value={hours} disabled={busy} onChange={e => setHours(e.target.value)} />}
    </> : null}
    {active === "cancel" ? <p>{pending ? "取消未派工请求，保留历史轮次。" : "确认工作已经停止。打板有费用时，仍由原设计师确认取消费用。"}</p> : null}
    {active === "cancel-fees" ? <><p>请核对以下取消费用，确认后计入工资，订单仍为已取消。</p>{order.rounds.filter(item => item.cancelledAmount != null && /[1-9]/.test(item.cancelledAmount) && item.feeConfirmedAt === null).map(item => <p key={item.roundId}>{item.index === 0 ? "首次打板" : `第${item.index}次返工`}：{formatBusinessDecimal(item.cancelledAmount!)} 元</p>)}</>
      : <label>{active === "rework" ? "返工内容 / 原因（必填）" : "操作说明（必填）"}<textarea required maxLength={active === "rework" ? 2000 : 500} disabled={busy} value={reason} onChange={e => setReason(e.target.value)} /></label>}
    {error ? <p role="alert">{error}</p> : null}{uploading ? <p role="status">正在上传原始资料…</p> : null}
    <div className="pattern-actions"><Button type="button" disabled={busy} onClick={() => onActive(null)}>暂不提交</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? "提交中…" : titles[active]}</Button></div>
  </form>;
}
