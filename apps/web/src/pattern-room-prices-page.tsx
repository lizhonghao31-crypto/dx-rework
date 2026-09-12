import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { Button, InsetField, Surface } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { PatternPriceChangeSchema, PatternPriceHistorySchema, PatternPriceItemSchema, PatternPricesSchema, type PatternPriceItem } from "@dx-rework/contracts/pattern-room";
import { Header } from "./components.js";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import "./system-dialog.css";
import "./pattern-room.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const amountText = (value: string | null) => value === null ? "未配置" : formatBusinessDecimal(value);
async function readPrice<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), { ...init, credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? "操作未完成，请重试");
  return schema.parse(body);
}
function PriceDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose(): void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="system-dialog pattern-price-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>;
}

export function PatternRoomPricesPage() {
  const [data, setData] = useState<z.infer<typeof PatternPricesSchema> | null>(null), [error, setError] = useState("");
  const [editing, setEditing] = useState<PatternPriceItem | null>(null), [amount, setAmount] = useState(""), [enabled, setEnabled] = useState(true), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState("");
  const [history, setHistory] = useState<{ item: PatternPriceItem; rows: z.infer<typeof PatternPriceHistorySchema> } | null>(null);
  const attempt = useRef<{ body: string; priceId: string; key: string } | null>(null);
  const refresh = async () => { setData(await readPrice("pattern-room/prices", PatternPricesSchema)); setError(""); };
  useEffect(() => { const abort = new AbortController(); void readPrice("pattern-room/prices", PatternPricesSchema, { signal: abort.signal }).then(setData).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "价格读取失败"); }); return () => abort.abort(); }, []);
  const edit = (item: PatternPriceItem) => { setEditing(item); setAmount(item.amount ?? ""); setEnabled(item.enabled); setReason(""); setFormError(""); attempt.current = null; };
  const showHistory = async (item: PatternPriceItem) => {
    try { setHistory({ item, rows: await readPrice(`pattern-room/prices/${item.priceId}/history`, PatternPriceHistorySchema) }); }
    catch (e) { setError(e instanceof Error ? e.message : "价格记录读取失败"); }
  };
  const save = async () => {
    if (!editing || busy) return;
    const parsed = PatternPriceChangeSchema.safeParse({ version: editing.version, amount, enabled, reason });
    if (!parsed.success) { setFormError(parsed.error.issues[0]?.message ?? "请检查价格与调整原因"); return; }
    const body = JSON.stringify(parsed.data);
    if (attempt.current?.body !== body || attempt.current.priceId !== editing.priceId) attempt.current = { body, priceId: editing.priceId, key: createClientRequestId() };
    setBusy(true); setFormError("");
    try {
      await readPrice(editing.kind === "hourly" ? "pattern-room/prices/hourly" : `pattern-room/prices/categories/${editing.priceId}`, PatternPriceItemSchema,
        { method: "POST", body, headers: { "idempotency-key": attempt.current.key } });
      setEditing(null); attempt.current = null;
      await refresh();
    } catch (e) { setFormError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  };
  return <div className="pattern-prices"><Header title="板房价格管控" badge="订单打板" badgePlacement="subtitle" />
    {error ? <Surface><p role="alert">{error}</p><Button onClick={() => void refresh().catch(e => setError(e instanceof Error ? e.message : "价格读取失败"))}>重新读取</Button></Surface> : null}
    {!data && !error ? <p role="status">正在读取价格…</p> : null}
    {data ? <>
      <Surface><h2>打板品类执行价</h2><p>新价格用于之后提交的订单；已提交订单保留原执行价。</p>
        <div className="pattern-price-table"><table><thead><tr><th>品类</th><th>单位</th><th>执行价（元）</th><th>状态</th><th>最近调整</th><th>操作</th></tr></thead><tbody>
          {data.categories.map(item => <tr key={item.priceId}><th scope="row">{item.name}</th><td>{item.unit}</td><td>{amountText(item.amount)}</td><td>{item.enabled ? "启用" : "停用"}</td>
            <td>{item.updatedBy ?? "初始化"}<small>{time(item.updatedAt)}</small></td><td><Button onClick={() => void showHistory(item)}>价格记录</Button>{data.canWriteCategories ? <Button onClick={() => edit(item)}>调整</Button> : null}</td></tr>)}
        </tbody></table></div>
      </Surface>
      <Surface><h2>杂事小时单价</h2><p className="pattern-hourly-price">{amountText(data.hourly.amount)}{data.hourly.amount !== null ? " 元/小时" : ""}</p>
        {data.hourly.amount === null ? <p>请由老板或 root 配置后再提交杂事订单。</p> : <p>最近调整：{data.hourly.updatedBy ?? "初始化"} · {time(data.hourly.updatedAt)}</p>}
        <Button onClick={() => void showHistory(data.hourly)}>价格记录</Button>{" "}{data.canWriteHourly ? <Button onClick={() => edit(data.hourly)}>调整小时单价</Button> : null}
      </Surface>
    </> : null}
    {editing ? <PriceDialog title={`调整${editing.name}`} busy={busy} onClose={() => setEditing(null)}><form onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2>调整{editing.name}</h2><p>当前价格：{amountText(editing.amount)} 元/{editing.unit}</p>
      <InsetField label={`新执行价（元/${editing.unit}）`} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} autoFocus />
      {editing.kind === "category" ? <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />启用此品类</label> : null}
      <InsetField label="调整原因（必填）" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy} />
      {formError ? <div><p role="alert">{formError}</p><Button type="button" disabled={busy} onClick={() => { setEditing(null); void refresh().catch(e => setError(e instanceof Error ? e.message : "价格读取失败")); }}>重新读取价格</Button></div> : null}
      <div className="system-dialog__actions"><Button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</Button></div>
    </form></PriceDialog> : null}
    {history ? <PriceDialog title={`${history.item.name}价格记录`} onClose={() => setHistory(null)}><div className="pattern-price-history"><h2>{history.item.name}价格记录</h2>
      {history.rows.map(row => <section key={row.version}><strong>{row.version === 1 ? "初始化" : `${amountText(row.oldAmount)} →`} {amountText(row.amount)} 元/{history.item.unit}</strong>
        <p>{row.enabled ? "启用" : "停用"} · {row.changedBy ?? "初始化"} · {time(row.changedAt)}</p><p>{row.reason}</p></section>)}
      <Button onClick={() => setHistory(null)}>关闭</Button></div></PriceDialog> : null}
  </div>;
}
