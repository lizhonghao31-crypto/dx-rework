import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AttachmentResponseSchema, UploadIntentResponseSchema, SampleCreateResultSchema, SamplePeopleResponseSchema, SampleAttachmentListSchema, type SampleCreate } from "@dx-rework/contracts";
import { Button, Surface } from "@dx-rework/ui";
import { Shell, Header } from "./components.js";
import { createWebUrls } from "../url-contract.js";
import { sampleRequest, sampleErrorMessage } from "./sample-request.js";
import { uploadSampleImage } from "./sample-image-upload.js";
import { createClientRequestId } from "./client-request-id.js";
import "./rework-v2-form.css";
import "./search-select.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  return sampleRequest(apiUrl(path), schema, init);
}
const availabilitySchema = z.object({ enabled: z.boolean(), canCreate: z.boolean(), canBatchCreate: z.boolean() });
export function SampleCreationLinks() {
  const [state, setState] = useState<z.infer<typeof availabilitySchema> | null>(null);
  useEffect(() => { const abort = new AbortController(); void request("samples/creation-availability", availabilitySchema, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setState(value); }).catch(() => {}); return () => abort.abort(); }, []);
  if (!state?.enabled) return null;
  return <div className="rework-v2-actions">{state.canCreate ? <a href={pageUrl("ui/samples/create")}>新增样衣</a> : null}{state.canBatchCreate ? <a href={pageUrl("ui/samples/batch-create")}>批量录入</a> : null}</div>;
}

type FileReference = { attachmentId: string; filename: string };
export function SampleImageUpload({ label, value, onChange, disabled, onBusy, onPending }: {
  label: string; value: FileReference[]; onChange(value: FileReference[]): void; disabled: boolean; onBusy(busy: boolean): void; onPending?(count: number): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const inFlight = useRef(false);
  const changePending = (files: File[]) => { setPendingFiles(files); onPending?.(files.length); };
  const upload = async (files: File[]) => {
    if (!files.length || disabled || inFlight.current) return;
    if (value.length + files.length > 20) { setError("最多上传 20 张图片"); return; }
    inFlight.current = true;
    setBusy(true); onBusy(true); setError(""); changePending(files);
    let current = value;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const original = files[index]!;
        const finalized = await uploadSampleImage(original, {
          createIntent: input => request("tools/attachments/upload-intents", UploadIntentResponseSchema, { method: "POST", body: JSON.stringify(input) }),
          finalize: attachmentId => request(`tools/attachments/${attachmentId}/finalize`, AttachmentResponseSchema, { method: "POST" }),
        });
        current = [...current, { attachmentId: finalized.attachmentId, filename: finalized.filename }];
        onChange(current);
        changePending(files.slice(index + 1));
      }
    } catch (e) { setError(sampleErrorMessage(e, "图片上传失败，请重试")); }
    finally { inFlight.current = false; setBusy(false); onBusy(false); }
  };
  return <div><label className="rework-v2-upload">{busy ? "上传中…" : label}<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={disabled || busy || pendingFiles.length > 0} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void upload(files); }} /></label>
    {value.map(file => <p key={file.attachmentId}>{file.filename} <Button type="button" disabled={disabled || busy} onClick={() => onChange(value.filter(item => item.attachmentId !== file.attachmentId))}>移除</Button></p>)}
    {pendingFiles.map((file, index) => <p key={`${file.name}:${index}`}>{file.name} · 未完成 <Button type="button" disabled={disabled || busy} onClick={() => { changePending(pendingFiles.filter((_, at) => at !== index)); setError(""); }}>移除</Button></p>)}
    {error ? <p role="alert">{error}</p> : null}
    {!busy && pendingFiles.length > 0 ? <Button type="button" disabled={disabled} onClick={() => { void upload(pendingFiles); }}>重试未完成的图片</Button> : null}</div>;
}

export function SamplePersonPicker({ label, value, onChange, disabled, endpoint = "samples/people" }: { label: string; value: string; onChange(value: string): void; disabled: boolean; endpoint?: string }) {
  const [text, setText] = useState(""), [people, setPeople] = useState<z.infer<typeof SamplePeopleResponseSchema>["people"]>([]), [error, setError] = useState("");
  useEffect(() => {
    if (value || !text.trim()) { setPeople([]); return; }
    const abort = new AbortController(), timer = setTimeout(() => {
      void request(`${endpoint}?search=${encodeURIComponent(text.trim())}`, SamplePeopleResponseSchema, { signal: abort.signal })
        .then(result => { if (!abort.signal.aborted) { setPeople(result.people); setError(result.people.length ? "" : "未找到有效员工"); } })
        .catch(e => { if (!abort.signal.aborted) setError(sampleErrorMessage(e, "员工搜索失败")); });
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [text, value, endpoint]);
  return <div><label>{label}<span className="rework-v2-control search-select"><input aria-label={label} type="search" value={text} disabled={disabled} autoComplete="off" placeholder="输入姓名后选择员工" onChange={e => { setText(e.target.value); onChange(""); setError(""); }} />
    {people.length ? <span className="search-select__results" role="listbox" aria-label={`${label}搜索结果`}>{people.map(person => <button type="button" role="option" aria-selected={false} key={person.userId} onClick={() => { onChange(person.userId); setText(`${person.name}${person.department ? ` · ${person.department}` : ""}`); setPeople([]); }}>{person.name} · {person.department || "未记录部门"}{people.filter(other => other.name === person.name && other.department === person.department).length > 1 ? ` · ${person.userId.slice(-6)}` : ""}</button>)}</span> : null}
  </span></label>{error ? <p role="status">{error}</p> : null}</div>;
}

type Draft = { key: string; brand: string; styleName: string; styleNo: string; color: string; size: string; category: string; department: string; purchaseDate: string; purchasePrice: string; purchaserUserId: string; holderUserId: string; differentHolder: boolean; remark: string; images: FileReference[] };
const empty = (): Draft => ({ key: createClientRequestId(), brand: "", styleName: "", styleNo: "", color: "", size: "", category: "", department: "", purchaseDate: "", purchasePrice: "", purchaserUserId: "", holderUserId: "", differentHolder: false, remark: "", images: [] });
export function SampleCreatePage({ batch = false }: { batch?: boolean }) {
  const [items, setItems] = useState<Draft[]>([empty()]), [receipts, setReceipts] = useState<FileReference[]>([]);
  const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<z.infer<typeof SampleCreateResultSchema> | null>(null), [availability, setAvailability] = useState<z.infer<typeof availabilitySchema> | null>(null);
  const attempt = useRef<{ hash: string; key: string } | null>(null);
  const uploaders = useRef(0);
  const [pendingUploads, setPendingUploads] = useState<Record<string, number>>({});
  const hasPendingUploads = Object.values(pendingUploads).some(count => count > 0);
  const onPendingUpload = (key: string, count: number) => setPendingUploads(current => ({ ...current, [key]: count }));
  const onUploadBusy = (active: boolean) => { uploaders.current = Math.max(0, uploaders.current + (active ? 1 : -1)); setUploading(uploaders.current > 0); };
  useEffect(() => { const abort = new AbortController(); void request("samples/creation-availability", availabilitySchema, { signal: abort.signal }).then(setAvailability).catch(e => { if (!abort.signal.aborted) setError(sampleErrorMessage(e, "无法读取登记状态")); }); return () => abort.abort(); }, []);
  const disabled = busy || uploading || !!result || !availability?.enabled;
  const update = (key: string, patch: Partial<Draft>) => setItems(current => current.map(item => item.key === key ? { ...item, ...patch } : item));
  const submit = async () => {
    if (disabled || uploaders.current > 0 || hasPendingUploads) return;
    setError("");
    try {
      const payload: SampleCreate[] = items.map(item => {
        if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(item.purchasePrice)) throw new Error("采购价必须是非负金额，最多两位小数");
        if (item.differentHolder && !item.holderUserId) throw new Error("请选择初始持有人");
        const [whole, decimal = ""] = item.purchasePrice.split(".");
        return { brand:item.brand,styleName:item.styleName,styleNo:item.styleNo,color:item.color,size:item.size,category:item.category,
          department:item.department,purchaseDate:item.purchaseDate,purchasePrice:`${whole}.${decimal.padEnd(2,"0")}`,purchaserUserId:item.purchaserUserId,
          holderUserId:item.differentHolder ? item.holderUserId : item.purchaserUserId,remark:item.remark,
          receiptAttachmentIds:receipts.map(file=>file.attachmentId),imageAttachmentIds:item.images.map(file=>file.attachmentId) };
      });
      const body = JSON.stringify(batch ? { items: payload } : payload[0]);
      if (attempt.current?.hash !== body) attempt.current = { hash: body, key: createClientRequestId() };
      setBusy(true);
      setResult(await request(batch ? "samples/batch" : "samples", SampleCreateResultSchema, { method:"POST",headers:{"idempotency-key":attempt.current.key},body }));
    } catch (e) { setError(sampleErrorMessage(e, "提交失败")); }
    finally { setBusy(false); }
  };
  return <Shell active="在管样衣" mobileNavigation="transaction"><main className="rework-v2-page">
    <Header title={batch ? "批量录入样衣" : "新增样衣"} subtitle="提交后直接记为借出中，生成首次领用记录。" badge="样衣管理" />
    <a href={pageUrl("ui/samples")}>返回在管样衣</a>
    {availability && !availability.enabled ? <p role="status">样衣登记尚未开放</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <Surface className="rework-v2-core"><h2>登记成功</h2>{result.items.map(item => <p key={item.sampleId}><a href={pageUrl(`ui/samples/${item.sampleId}`)}>{item.sampleCode}</a> · 借出中</p>)}</Surface> : null}
    <Surface className="rework-v2-core"><h2>采购小票（必填）</h2>{batch ? <p>本批样衣共用以下小票。</p> : null}<SampleImageUpload label="上传采购小票" value={receipts} onChange={setReceipts} disabled={disabled} onBusy={onUploadBusy} onPending={count => onPendingUpload("receipts", count)} /></Surface>
    {items.map((item, index) => <Surface className="rework-v2-core" key={item.key}>
      <div className="rework-v2-section-heading"><h2>样衣 {index + 1}</h2>{batch && items.length > 1 ? <Button disabled={disabled} onClick={() => { setItems(current => current.filter(row => row.key !== item.key)); onPendingUpload(item.key, 0); }}>移除本件</Button> : null}</div>
      <div className="rework-v2-grid">
        {([['brand','品牌'],['styleName','样衣名称'],['color','颜色'],['department','部门'],['purchaseDate','采购日期'],['purchasePrice','采购价']] as const).map(([field,label]) => <label key={field}>{label}<input required value={item[field]} disabled={disabled} type={field === 'purchaseDate' ? 'date' : 'text'} inputMode={field === 'purchasePrice' ? 'decimal' : undefined} onChange={e => update(item.key,{[field]:e.target.value})} /></label>)}
        <SamplePersonPicker label="采购人" value={item.purchaserUserId} disabled={disabled} onChange={purchaserUserId => update(item.key,{purchaserUserId})} />
      </div>
      <p><label><input type="checkbox" checked={item.differentHolder} disabled={disabled} onChange={e => update(item.key,{differentHolder:e.target.checked})} />初始持有人与采购人不同</label></p>
      {item.differentHolder ? <div className="rework-v2-grid"><SamplePersonPicker label="初始持有人" value={item.holderUserId} disabled={disabled} onChange={holderUserId => update(item.key,{holderUserId})} /></div> : null}
      <details className="rework-v2-more"><summary>补充资料与样衣图片</summary><div className="rework-v2-grid">
        {([['styleNo','款号'],['category','类别'],['size','尺码'],['remark','备注']] as const).map(([field,label]) => <label key={field}>{label}<input value={item[field]} disabled={disabled} onChange={e => update(item.key,{[field]:e.target.value})} /></label>)}
      </div><SampleImageUpload label="上传样衣图片" value={item.images} onChange={images => update(item.key,{images})} disabled={disabled} onBusy={onUploadBusy} onPending={count => onPendingUpload(item.key, count)} /></details>
    </Surface>)}
    {batch ? <Button disabled={disabled || items.length >= 50} onClick={() => setItems(current => [...current,empty()])}>增加一件样衣</Button> : null}
    <div className="rework-v2-actions"><Button variant="primary" disabled={disabled || hasPendingUploads || !receipts.length || !(batch ? availability?.canBatchCreate : availability?.canCreate)} onClick={() => { void submit(); }}>{busy ? "提交中…" : "提交建档并首次领用"}</Button></div>
  </main></Shell>;
}

export function SampleAttachments({ sampleId }: { sampleId: string }) {
  const [files, setFiles] = useState<z.infer<typeof SampleAttachmentListSchema>["attachments"]>([]), [error,setError] = useState("");
  useEffect(() => { const abort = new AbortController(); void request(`samples/${sampleId}/attachments`,SampleAttachmentListSchema,{signal:abort.signal}).then(data => { if (!abort.signal.aborted) setFiles(data.attachments); }).catch(e => { if (!abort.signal.aborted) setError(sampleErrorMessage(e, "附件读取失败")); }); return () => abort.abort(); },[sampleId]);
  return <Surface className="rework-v2-core"><details><summary>样衣图片与凭证</summary>{error ? <p role="alert">{error}</p> : null}{!files.length && !error ? <p>暂无可查看的附件</p> : null}<div className="rework-v2-image-grid">{files.map(file => <article key={`${file.attachmentId}:${file.purpose}`}><a href={apiUrl(`samples/${sampleId}/attachments/${file.attachmentId}/download`)} target="_blank" rel="noreferrer"><img loading="lazy" src={apiUrl(`samples/${sampleId}/attachments/${file.attachmentId}/download`)} alt={`${file.purpose === "purchase_receipt" ? "采购小票" : "样衣图片"}：${file.filename}`} /></a></article>)}</div></details></Surface>;
}
