import { useEffect, useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { Button, InsetField, Surface } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { CreatePatternOrderSchema, UpdatePatternMaterialsSchema, PatternOrderDetailSchema, type PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { PatternCategoryOptionsSchema, PatternPriceQuoteSchema } from "@dx-rework/contracts/pattern-room";
import { createClientRequestId } from "./client-request-id.js";
import { patternRequest, PatternRequestError, uploadPatternOriginal } from "./pattern-order-client.js";
import { patternEstimate } from "./pattern-order-query.js";

export function PatternOrderForm({ order, onSaved, onCancel }: { order?: PatternOrderDetail; onSaved(order: PatternOrderDetail): void; onCancel(): void }) {
  const [values, setValues] = useState({ styleNo: order?.styleNo ?? "", requiredDate: order?.requiredDate ?? "", customer: order?.customer ?? "", sizeColor: order?.sizeColor ?? "", referenceStyleNo: order?.referenceStyleNo ?? "", variant: order?.variant ?? "", note: order?.note ?? "", reason: "" });
  const [files, setFiles] = useState((order?.attachments ?? []).filter(file => file.active && file.roundId === order?.currentRoundId).map(file => ({ attachmentId: file.attachmentId, filename: file.filename })));
  const [categories, setCategories] = useState<z.infer<typeof PatternCategoryOptionsSchema>>([]), [categoryId, setCategoryId] = useState("");
  const [quote, setQuote] = useState<z.infer<typeof PatternPriceQuoteSchema> | null>(null), [quantity, setQuantity] = useState("1");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [refreshPrice, setRefreshPrice] = useState(0);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    if (order) return;
    const abort = new AbortController();
    void patternRequest("category-options", PatternCategoryOptionsSchema, { signal: abort.signal }).then(setCategories).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [order, refreshPrice]);
  useEffect(() => {
    setQuote(null);
    if (!categoryId) return;
    const abort = new AbortController();
    void patternRequest(`category-options/${categoryId}/quote`, PatternPriceQuoteSchema, { signal: abort.signal }).then(setQuote).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [categoryId, refreshPrice]);
  const upload = async (selected: File[]) => {
    if (selected.length + files.length > 20) { setError("最多上传 20 份制作资料"); return; }
    setUploading(true); setError("");
    try {
      for (const file of selected) {
        const uploaded = await uploadPatternOriginal(file);
        setFiles(current => [...current, { attachmentId: uploaded.attachmentId, filename: uploaded.filename }]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "资料上传失败"); }
    finally { setUploading(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || uploading) return;
    const { reason, ...fields } = values;
    const materials = { ...fields, requiredDate: fields.requiredDate || null, variant: fields.variant || null, attachmentIds: files.map(file => file.attachmentId) };
    const input = order ? UpdatePatternMaterialsSchema.safeParse({ ...materials, reason, version: order.version, roundId: order.currentRoundId })
      : CreatePatternOrderSchema.safeParse({ ...materials, categoryId, quantity: Number(quantity), priceVersion: quote?.version });
    if (!input.success) { setError(input.error.issues[0]?.message ?? "请补充必填信息"); return; }
    const body = JSON.stringify(input.data);
    if (attempt.current?.body !== body) attempt.current = { body, key: createClientRequestId() };
    setBusy(true); setError("");
    try {
      onSaved(await patternRequest(order ? `orders/${order.orderId}/materials` : "orders", PatternOrderDetailSchema, { method: "POST", body, headers: { "idempotency-key": attempt.current.key } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败");
      if (e instanceof PatternRequestError && e.code === "PRICE_CHANGED") { setQuote(null); setRefreshPrice(value => value + 1); }
    } finally { setBusy(false); }
  };
  const disabled = busy || uploading;
  const estimated = patternEstimate(quote?.amount ?? null, quantity);
  return <Surface><form className="pattern-order-form" onSubmit={event => void submit(event)}><h2>{order ? "更新制作资料" : "新建打板"}</h2>
    <div className="pattern-fields">
      <InsetField label="本次款号（必填）" value={values.styleNo} required maxLength={100} onChange={e => setValues({ ...values, styleNo: e.target.value })} disabled={disabled} />
      {!order ? <><label>品类（必填）<select required value={categoryId} onChange={e => setCategoryId(e.target.value)} disabled={disabled}><option value="">请选择品类</option>{categories.map(category => <option key={category.priceId} value={category.priceId}>{category.name}（{category.unit}）</option>)}</select></label>
        <InsetField label="数量（必填）" type="number" min={1} max={1_000_000} step={1} required value={quantity} onChange={e => setQuantity(e.target.value)} disabled={disabled} />
        <p>执行价：{quote?.amount ? `${formatBusinessDecimal(quote.amount)} 元/${quote.unit}` : "选择品类后显示"}<br />预计金额：{estimated !== null ? `${formatBusinessDecimal(estimated)} 元` : "填写品类与数量后显示"}</p></> : null}
      <InsetField label="要求完成日期" type="date" value={values.requiredDate} onChange={e => setValues({ ...values, requiredDate: e.target.value })} disabled={disabled} />
      <InsetField label="客户" value={values.customer} maxLength={100} onChange={e => setValues({ ...values, customer: e.target.value })} disabled={disabled} />
      <InsetField label="尺码与颜色" value={values.sizeColor} maxLength={200} onChange={e => setValues({ ...values, sizeColor: e.target.value })} disabled={disabled} />
      <label>版型<select value={values.variant} onChange={e => setValues({ ...values, variant: e.target.value })} disabled={disabled}><option value="">未指定</option>{["初版", "复版", "齐色版"].map(value => <option key={value}>{value}</option>)}</select></label>
      <InsetField label="参考历史款号（可选）" value={values.referenceStyleNo} maxLength={100} onChange={e => setValues({ ...values, referenceStyleNo: e.target.value })} disabled={disabled} />
    </div>
    <label>备注<textarea value={values.note} maxLength={2000} onChange={e => setValues({ ...values, note: e.target.value })} disabled={disabled} /></label>
    <label>制作 PDF / 清晰图片（至少一份）<input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" disabled={disabled} onChange={e => { const selected = Array.from(e.target.files ?? []); e.target.value = ""; void upload(selected); }} /></label>
    {uploading ? <p role="status">正在上传原始制作资料…</p> : null}
    <ul className="pattern-files">{files.map(file => <li key={file.attachmentId}><span>{file.filename}</span><Button type="button" disabled={disabled} onClick={() => setFiles(current => current.filter(item => item.attachmentId !== file.attachmentId))}>移出当前资料</Button></li>)}</ul>
    {order ? <><InsetField label="变更原因（必填）" value={values.reason} required maxLength={500} onChange={e => setValues({ ...values, reason: e.target.value })} disabled={disabled} /><p>旧资料保留在订单记录中。派工后的变更会通知主管和当前工人。</p></> : <p>提交即确认材料已齐备，订单将进入待分配。</p>}
    {error ? <p role="alert">{error}</p> : null}
    <div className="pattern-actions"><Button type="button" disabled={disabled} onClick={onCancel}>取消</Button><Button type="submit" variant="primary" disabled={disabled || (!order && !quote)}>{busy ? "提交中…" : order ? "保存资料" : "提交打板"}</Button></div>
  </form></Surface>;
}
