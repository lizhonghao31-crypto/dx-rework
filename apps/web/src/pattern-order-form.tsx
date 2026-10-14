import {MiscAssociationField} from "./misc-association-field.js";
import { SearchableSelect } from "./search-select.js";
import { PatternDialog } from "./pattern-dialog.js";
import "./pattern-governed.css";
import { PatternMaterials } from "./pattern-materials.js";
import { PatternField as InsetField } from "./pattern-controls.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { Button, Surface } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { CreatePatternOrderSchema, CreateMiscOrderSchema, UpdateMiscMaterialsSchema, UpdatePatternMaterialsSchema, PatternOrderDetailSchema, type PatternOrderDetail, type MiscAssociationSnapshot } from "@dx-rework/contracts/pattern-orders";
import { PatternCategoryOptionsSchema } from "@dx-rework/contracts/pattern-room";
import { createClientRequestId } from "./client-request-id.js";
import { patternRequest, PatternRequestError, uploadPatternOriginal } from "./pattern-order-client.js";
import { patternEstimate } from "./pattern-order-query.js";
import { PatternMaterialInput, PATTERN_MATERIAL_LIMIT } from "./pattern-material-input.js";
import { usePatternQuote } from "./use-pattern-quote.js";
import { usePatternDraftGuard } from "./use-pattern-draft-guard.js";

export function PatternOrderForm({ order, kind = order?.kind ?? "pattern", onSaved, onCancel }: { order?: PatternOrderDetail; kind?: "pattern" | "misc"; onSaved(order: PatternOrderDetail): void; onCancel(): void }) {
  const misc = kind === "misc";
  const [values, setValues] = useState({ taskName: order?.taskName ?? "", styleNo: order?.styleNo ?? "", requiredDate: order?.requiredDate ?? "", customer: order?.customer ?? "", sizeColor: order?.sizeColor ?? "", referenceStyleNo: order?.referenceStyleNo ?? "", variant: order?.variant ?? "", note: order?.note ?? "", reason: "" });
  const [association,setAssociation]=useState<MiscAssociationSnapshot|null>(order?.association??null),[unmatchedAssociation,setUnmatchedAssociation]=useState(false);
  const legacyAssociation=Boolean(misc&&order&&!order.association&&!association&&order.styleNo&&values.styleNo===order.styleNo);
  const [files, setFiles] = useState((order?.attachments ?? []).filter(file => file.active && file.roundId === order?.currentRoundId).map(file => ({ attachmentId: file.attachmentId, filename: file.filename, mimeType: file.mimeType })));
  const [categories, setCategories] = useState<z.infer<typeof PatternCategoryOptionsSchema>>([]), [categoryId, setCategoryId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [refreshPrice, setRefreshPrice] = useState(0);
  const price = usePatternQuote(order ? null : misc ? "hourly-quote" : categoryId ? `category-options/${categoryId}/quote` : null, refreshPrice);
  const quote = price.quote;
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const draft = usePatternDraftGuard(JSON.stringify([values, association, unmatchedAssociation, files.map(file => file.attachmentId), categoryId, quantity]), busy || uploading);
  useEffect(() => {
    if (order || misc) return;
    const abort = new AbortController();
    void patternRequest("category-options", PatternCategoryOptionsSchema, { signal: abort.signal }).then(setCategories).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [order, misc, refreshPrice]);
  const upload = async (selected: File[]) => {
    if (busy || uploading || !selected.length) return;
    if (selected.length + files.length > PATTERN_MATERIAL_LIMIT) { setError("最多上传 20 份制作资料，请先移除不需要的资料"); return; }
    setUploading(true); setError("");
    try {
      for (const file of selected) {
        const uploaded = await uploadPatternOriginal(file, kind);
        setFiles(current => [...current, { attachmentId: uploaded.attachmentId, filename: uploaded.filename, mimeType: uploaded.mimeType }]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "资料上传失败"); }
    finally { setUploading(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || uploading || (!order && (!quote || quote.amount === null))) return;
    if(misc&&unmatchedAssociation){setError("关联款号请选择命中的已有档案或PO，或明确选择不关联订单");document.getElementById('misc-association')?.focus();return;}
    const { reason, taskName, ...fields } = values;
    const common = { styleNo: fields.styleNo, requiredDate: fields.requiredDate || null, note: fields.note, attachmentIds: files.map(file => file.attachmentId) };
    const materials = misc ? { ...common, taskName,...(!legacyAssociation?{association:association?{kind:association.kind,id:association.id}:null}:{}) } : { ...fields, ...common, variant: fields.variant || null };
    const input = order ? (misc ? UpdateMiscMaterialsSchema : UpdatePatternMaterialsSchema).safeParse({ ...materials, reason, version: order.version, roundId: order.currentRoundId })
      : misc ? CreateMiscOrderSchema.safeParse({ ...materials, priceVersion: quote?.version }) : CreatePatternOrderSchema.safeParse({ ...materials, categoryId, quantity: Number(quantity), priceVersion: quote?.version });
    if (!input.success) { setError(input.error.issues[0]?.message ?? "请补充必填信息"); return; }
    const body = JSON.stringify(input.data);
    if (attempt.current?.body !== body) attempt.current = { body, key: createClientRequestId() };
    setBusy(true); setError("");
    try {
      const saved = await patternRequest(order ? `orders/${order.orderId}/${misc ? "misc-materials" : "materials"}` : misc ? "misc-orders" : "orders", PatternOrderDetailSchema, { method: "POST", body, headers: { "idempotency-key": attempt.current.key } });
      draft.markSaved();
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败");
      if (e instanceof PatternRequestError && e.code === "PRICE_CHANGED") setRefreshPrice(value => value + 1);
    } finally { setBusy(false); }
  };
  const disabled = busy || uploading;
  const estimated = patternEstimate(quote?.amount ?? null, quantity);
  const content = <Surface className="pattern-form-page" data-dx-ui="governed"><form className="pattern-order-form" onSubmit={event => void submit(event)}>{order && <h2>更新任务资料</h2>}
    <div className={`pattern-fields pattern-form-primary${!order && !misc ? " is-pattern-create" : ""}`}>
      {misc ? <InsetField label="任务名称 *" value={values.taskName} required maxLength={200} onChange={e => setValues({ ...values, taskName: e.target.value })} disabled={disabled} /> : null}
      {misc?legacyAssociation?<div><span>历史关联款号：{values.styleNo}</span><Button type="button" disabled={disabled} onClick={()=>setValues({...values,styleNo:""})}>更换关联</Button></div>:<MiscAssociationField value={association} disabled={disabled} onUnmatchedSearch={()=>{setUnmatchedAssociation(true);setAssociation(null);setValues(current=>({...current,styleNo:""}));}} onChange={selected=>{setAssociation(selected);setUnmatchedAssociation(false);setValues(current=>({...current,styleNo:selected?.styleNo??""}));}}/>:<InsetField label="款号 *" value={values.styleNo} required maxLength={100} onChange={e=>setValues({...values,styleNo:e.target.value})} disabled={disabled}/> }
      {!order && !misc ? <><label>品类 *<SearchableSelect className="rework-v2-control" required value={categoryId} onChange={e => setCategoryId(e.target.value)} disabled={disabled}><option value="">请选择品类</option>{categories.map(category => <option key={category.priceId} value={category.priceId}>{category.name}（{category.unit}）</option>)}</SearchableSelect></label>
        <InsetField label="数量 *" type="number" min={1} max={1_000_000} step={1} required value={quantity} onChange={e => setQuantity(e.target.value)} disabled={disabled} />
        <div className="pattern-total"><span>本单价格</span><strong>{price.status === "loading" ? "正在读取…" : estimated !== null ? `¥${formatBusinessDecimal(estimated, 2)}` : "—"}</strong></div></> : null}
      <InsetField label="要求完成日期" type="date" value={values.requiredDate} onChange={e => setValues({ ...values, requiredDate: e.target.value })} disabled={disabled} />
      {misc && !order ? <div className="pattern-hourly"><p role="status">小时单价：{price.status === "loading" ? "正在读取…" : price.status === "error" ? "读取失败" : quote?.amount === null ? "尚未配置，请联系老板配置。" : quote ? `${formatBusinessDecimal(quote.amount, 2)} 元/小时` : "—"}</p><Button type="button" disabled={disabled || price.status === "loading"} onClick={() => setRefreshPrice(value => value + 1)}>刷新价格</Button></div> : null}
      {!misc && <InsetField label="客户" value={values.customer} maxLength={100} onChange={e => setValues({ ...values, customer: e.target.value })} disabled={disabled} />}
    </div>
    {!misc ? <div className="pattern-fields pattern-form-secondary">
      <InsetField label="尺码与颜色" value={values.sizeColor} maxLength={200} onChange={e => setValues({ ...values, sizeColor: e.target.value })} disabled={disabled} />
      <label>版型<select className="rework-v2-control" value={values.variant} onChange={e => setValues({ ...values, variant: e.target.value })} disabled={disabled}><option value="">未指定</option>{["初版", "复版", "齐色版"].map(value => <option key={value}>{value}</option>)}</select></label>
      <InsetField label="参考款号" value={values.referenceStyleNo} maxLength={100} onChange={e => setValues({ ...values, referenceStyleNo: e.target.value })} disabled={disabled} /></div> : null}
    <label className="pattern-form-note">备注<textarea rows={2} className="rework-v2-control" value={values.note} maxLength={2000} onChange={e => setValues({ ...values, note: e.target.value })} disabled={disabled} /></label>
    <PatternMaterialInput kind={kind} count={files.length} label={misc ? "上传图片 / PDF" : "上传制作图片 / PDF *"} disabled={disabled} onFiles={selected => void upload(selected)} />
    {uploading ? <p role="status">正在上传原始制作资料…</p> : null}
    {files.length > 0 && <PatternMaterials files={files} disabled={disabled} onRemove={id => setFiles(current => current.filter(file => file.attachmentId !== id))} />}
    {order ? <InsetField label="变更原因 *" value={values.reason} required maxLength={500} onChange={e => setValues({ ...values, reason: e.target.value })} disabled={disabled} /> : null}
    {error ? <p role="alert">{error}</p> : null}
    {price.status === "error" && <div><p role="alert">{price.message}</p>{!misc && <Button type="button" disabled={disabled} onClick={() => setRefreshPrice(value => value + 1)}>重读价格</Button>}</div>}
    <div className="rework-v2-action-area"><div className="rework-v2-actions"><Button type="button" disabled={disabled} onClick={async () => { if (await draft.requestLeave()) onCancel(); }}>取消</Button><Button type="submit" variant="primary" disabled={disabled || (!order && (!quote || quote.amount === null))}>{busy ? "提交中…" : order ? "保存资料" : misc ? "提交杂事" : "提交打板"}</Button></div></div>
  </form></Surface>;
  return order ? <PatternDialog title="更新任务资料" busy={disabled} onClose={async () => { if (await draft.requestLeave()) onCancel(); }}>{content}</PatternDialog> : content;
}
