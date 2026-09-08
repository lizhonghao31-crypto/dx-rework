import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ProductionExclusionPreviewSchema, type ProductionExclusionPreview } from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, Surface } from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";
import { verifySession } from "./auth.js";
import { confirmInApp } from "./system-dialog.js";
import { createClientRequestId } from "./client-request-id.js";
const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
async function request(id: string, init?: RequestInit): Promise<ProductionExclusionPreview> {
  const response = await fetch(apiUrl(`production-reporting/${encodeURIComponent(id)}/exclusion`), { credentials: "include", cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? "生产记录排除操作失败，请重试");
  return ProductionExclusionPreviewSchema.parse(body);
}
export function ProductionExclusionControls({ onExcluded }: { onExcluded: () => void }) {
  const [root, setRoot] = useState(false), [open, setOpen] = useState(false);
  const [id, setId] = useState(""), [reason, setReason] = useState(""), [error, setError] = useState("");
  const [preview, setPreview] = useState<ProductionExclusionPreview | null>(null), [busy, setBusy] = useState(false);
  const lock = useRef(false), sequence = useRef(0), attempt = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => { let live = true; void verifySession().then(s => { if (live) setRoot(s !== "denied" && s.user.isRoot === true); }).catch(() => undefined); return () => { live = false; sequence.current++; }; }, []);
  const load = async () => {
    if (lock.current) return;
    const target = id.trim(), version = ++sequence.current;
    setPreview(null); setError("");
    if (!z.string().uuid().safeParse(target).success) { setError("请填写完整的生产订单ID，再预览确认款色和数量。"); return; }
    lock.current = true; setBusy(true);
    try { const result = await request(target); if (version === sequence.current) setPreview(result); }
    catch (e) { if (version === sequence.current) setError(e instanceof Error ? e.message : "预览失败"); }
    finally { lock.current = false; setBusy(false); }
  };
  const exclude = async () => {
    if (lock.current || !preview || preview.exclusion || preview.order.productionOrderId !== id.trim() || !reason.trim()) return;
    lock.current = true; setBusy(true); setError("");
    const target = preview, explanation = reason.trim();
    try {
      if (!await confirmInApp(`确认排除测试或误建生产记录？\n款色：${target.order.lines.map(l => `${l.styleNo} / ${l.color ?? "未维护"}`).join("、")}\n供应商：${target.order.supplierName}\n数量：${formatBusinessDecimal(target.order.quantity)} 件\n原因：${explanation}\n关联收货 ${target.receiptIds.length} 条；原收货、生产和外发历史保留，不会一并删除。\n生产ID：${target.order.productionOrderId}`, { confirmLabel: "确认排除", cancelLabel: "取消" })) return;
      const body = { expectedVersion: target.version, confirmedProductionOrderId: target.order.productionOrderId, reason: explanation, confirmed: true };
      const signature = JSON.stringify(body);
      if (attempt.current?.signature !== signature) attempt.current = { signature, key: createClientRequestId() };
      const result = await request(target.order.productionOrderId, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.current.key }, body: signature });
      setPreview(result); onExcluded();
    } catch (e) { setError(e instanceof Error ? e.message : "排除失败，请重新预览核对"); }
    finally { lock.current = false; setBusy(false); }
  };
  if (!root) return null;
  return <Surface className="sourcing-list-card production-admin-tool" data-open={open}>
    <Button className="ui-disclosure-trigger" aria-expanded={open} variant="secondary" disabled={busy} onClick={() => setOpen(!open)}>测试／误建生产记录排除</Button>
    {open ? <>
      <p>仅按精确ID核对测试或误建对象；普通历史归档不属于测试排除。排除后退出正常列表、动态、预警和统计，历史审计保留。</p>
      <div className="sourcing-form-grid"><label>生产订单ID<input value={id} disabled={busy} maxLength={36} onChange={e => { setId(e.target.value); setPreview(null); setError(""); sequence.current++; }} /></label>
      <Button variant="secondary" disabled={busy} onClick={() => void load()}>预览精确对象</Button></div>
      {error ? <p role="alert">{error}</p> : null}
      {preview ? <section aria-label="生产排除预览"><h3>{preview.order.firstStyleNo} · {preview.order.supplierName}</h3>
        <p>{formatBusinessDecimal(preview.order.quantity)} 件 · 合同 {preview.order.contractNumber} · {preview.order.sourceCaseArchived ? "原外发单已归档" : "原外发单保留"}</p>
        {preview.order.lines.map(l => <p key={l.position}>{l.styleNo} / {l.color ?? "未维护颜色"} · {formatBusinessDecimal(l.quantity)} 件</p>)}
        <p>上报及修正 {formatBusinessDecimal(preview.reportCount)} 条；关联实际收货 {formatBusinessDecimal(preview.receiptIds.length)} 条。关联收货历史不会删除。</p>
        {preview.receiptIds.length ? <details><summary>关联收货ID</summary>{preview.receiptIds.map(receiptId => <p key={receiptId}>{receiptId}</p>)}</details> : null}
        {preview.exclusion ? <p role="status">已排除：{preview.exclusion.reason} · {new Date(preview.exclusion.excludedAt).toLocaleString("zh-CN")}</p> : <>
          <div className="sourcing-form-grid"><label>排除原因<input disabled={busy} value={reason} maxLength={500} onChange={e => setReason(e.target.value)} placeholder="说明为什么属于测试或误建记录" /></label>
          <Button disabled={busy || !reason.trim()} onClick={() => void exclude()}>{busy ? "正在处理…" : "确认排除测试记录"}</Button></div>
        </>}
      </section> : null}
    </> : null}
  </Surface>;
}

