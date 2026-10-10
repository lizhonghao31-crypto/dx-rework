import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { DigitalOrderCreateSchema, DigitalSourceCreateSchema, type DigitalCustomer, type DigitalOrder, type DigitalOrderInput, type DigitalSource } from "@dx-rework/contracts/digital-production";
import type { OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { digitalRequest } from "./digital-production-api.js";
import { initialDigitalProductGroup } from "./digital-production-defaults.js";
import { createClientRequestId } from "./client-request-id.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";
import { changePoDate, inheritPoDate, removePoDateOverride } from "./po-date-input-defaults.js";
import type { DevelopmentSheet, DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { editableDevelopmentOrder, developmentOrderInput, initialDevelopmentDocument, type DevelopmentOrderDraft } from "./digital-development-editing.js";
import { preparePatternMaterial } from "./pattern-material-upload.js";
import { uploadDevelopmentMaterial } from "./digital-development-upload.js";

type CreatePicture = {id: string; file: File; preview: string; attachmentId?: string; error?: string | undefined};

export type DevelopmentCreateIntent = "development" | "certain_order" | "confirm_order";
const newLine = (): DigitalOrderInput["lines"][number] => ({formalPoNo:null, customerWarehouseArrivalDate:null, poNumber: null, formalStyleNo: null, temporaryStyleNo: null, color: "", colorForeign: null, deliveryDate: null, sizes: [{size: "", quantity: 1}]});
export function initialDevelopmentOrder(customers: DigitalCustomer[], source?: OrderJourney): DigitalOrderInput {
  return {customerCode: source?.customer ?? "", designStyleNo: source?.designStyleNo ?? "", temporaryStyleNo: source?.temporaryStyleNo ?? null,
    productGroup: initialDigitalProductGroup(customers, source?.customer ?? undefined),
    primaryMerchandiserId: customers.find(customer => customer.code === source?.customer)?.defaultMerchandiserId ?? null,
    orderDate: new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date()), contractDeliveryDate: null, lines: [newLine()]};
}

/** A facade over the existing source and order commands; no sample approval or route writes. */
export function DevelopmentCreateForm({intent, source, customers, onCancel, onCreated}: {
  intent: DevelopmentCreateIntent; source?: OrderJourney; customers: DigitalCustomer[];
  onCancel: () => void; onCreated: (sourceId: string, orderId: string | null) => void;
}) {
  const [form, setForm] = useState(() => editableDevelopmentOrder(initialDevelopmentOrder(customers, source)));
  const [template, setTemplate] = useState<DevelopmentDocument["template"]>("上衣");
  const [pictures, setPictures] = useState<CreatePicture[]>([]);
  const picturesRef = useRef<CreatePicture[]>([]), previews = useRef<string[]>([]);
  const draftSaveKey = useRef<{payload: string; key: string} | null>(null);
  useEffect(() => () => {for (const url of previews.current) URL.revokeObjectURL(url);}, []);
  const customerDateOverrides = useRef(new Set<number>());
  const [developmentType, setDevelopmentType] = useState<"头版" | "开发板">("头版");
  const [createdSource, setCreatedSource] = useState<string | null>(source?.sourceId ?? null);
  const [fixedCustomer, setFixedCustomer] = useState<string | null>(source?.customer ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const writing = useRef(false), sourceKey = useRef<{payload: string; key: string} | null>(null), orderKey = useRef<{payload: string; key: string} | null>(null);
  const initial = useRef(JSON.stringify(form)), dirty = useRef(false), completed = useRef(false);
  dirty.current = JSON.stringify(form) !== initial.current || developmentType !== "头版" || template !== "上衣" || pictures.length > 0;
  useEffect(() => {
    const unregister = registerInternalNavigationGuard(async () => {
      if (writing.current) return false;
      if (completed.current || !dirty.current) return true;
      return await confirmInApp("有未保存订购资料，确定离开？") && !writing.current;
    });
    const unload = (event: BeforeUnloadEvent) => {if (writing.current || (!completed.current && dirty.current)) {event.preventDefault(); event.returnValue = "";}};
    window.addEventListener("beforeunload", unload);
    return () => {unregister(); window.removeEventListener("beforeunload", unload);};
  }, []);
  const withOrder = intent !== "development";
  const title = intent === "confirm_order" ? "客户确定订单 · 补订购信息" : withOrder ? "产品开发（有确定订单）" : "产品开发（无确定订单）";
  const line = (index: number, patch: Partial<DevelopmentOrderDraft["lines"][number]>) => setForm(current => ({...current, lines: current.lines.map((value, i) => i === index ? {...value, ...patch} : value)}));
  const selectPictures = async (files: File[]) => {
    if (writing.current || !files.length) return;
    writing.current = true; setBusy(true); setError("");
    try {
      for (const original of files) {
        if (picturesRef.current.length >= 30) throw new Error("款图最多30张，请先移除不用的图片");
        const file = await preparePatternMaterial(original);
        if (!file.type.startsWith("image/")) throw new Error("款图请使用 JPG、PNG 或 WebP；PDF 可在开发单附件区上传");
        const preview = URL.createObjectURL(file); previews.current.push(preview);
        picturesRef.current = [...picturesRef.current, {id: createClientRequestId(), file, preview}];
        setPictures(picturesRef.current);
      }
    } catch (reason) {setError(reason instanceof Error ? reason.message : "图片无法读取，请换一张或重试；其它资料仍保留");}
    finally {writing.current = false; setBusy(false);}
  };
  const customerDate = (index: number, date: string | null) => {
    const overrides = new Set(customerDateOverrides.current);
    if (index > 0) overrides.add(index);
    customerDateOverrides.current = overrides;
    setForm(current => ({...current, lines: changePoDate(current.lines, "customerWarehouseArrivalDate", index, date, overrides)}));
  };
  const removeLine = (index: number) => {
    customerDateOverrides.current = removePoDateOverride(customerDateOverrides.current, index);
    setForm(current => ({...current, lines: current.lines.filter((_, position) => position !== index)}));
  };
  const save = async () => {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError("");
    try {
      const sourceInput = DigitalSourceCreateSchema.parse({developmentType, designStyleNo: form.designStyleNo, temporaryStyleNo: form.temporaryStyleNo, customerCode: form.customerCode || null});
      const orderInput = withOrder ? DigitalOrderCreateSchema.parse(developmentOrderInput(form)) : null;
      let id = createdSource;
      if (!id) {
        const payload = JSON.stringify(sourceInput);
        if (sourceKey.current?.payload !== payload) sourceKey.current = {payload, key: createClientRequestId()};
        const next = await digitalRequest<DigitalSource>("sources", "POST", sourceInput, sourceKey.current.key);
        id = next.sourceId; setCreatedSource(id); setFixedCustomer(next.customerCode);
      }
      if (!source) {
        const base = `sources/${id}/development`;
        const sheet = await digitalRequest<DevelopmentSheet>(base);
        const document = sheet.document ?? {...initialDevelopmentDocument(template), orderDate: form.orderDate};
        if (sheet.status === "published" || !sheet.canEdit) throw new Error("开发单已发布或无修改权限，请重新打开查看");
        if (picturesRef.current.some(picture => !picture.attachmentId)) {
          const limits = await digitalRequest<{maxUploadBytes: number}>(`${base}/upload-limits`);
          for (const picture of picturesRef.current) {
            if (picture.attachmentId) continue;
            try {
              const attachmentId = await uploadDevelopmentMaterial(base, picture.file, "款图", limits.maxUploadBytes);
              picturesRef.current = picturesRef.current.map(item => item.id === picture.id ? {...item, attachmentId, error: undefined} : item);
              setPictures(picturesRef.current);
            } catch (reason) {
              const message = reason instanceof Error ? reason.message : "上传失败，请重试";
              picturesRef.current = picturesRef.current.map(item => item.id === picture.id ? {...item, error: message} : item);
              setPictures(picturesRef.current); throw reason;
            }
          }
        }
        const added = picturesRef.current.filter(picture => picture.attachmentId && !document.files.some(file => file.attachmentId === picture.attachmentId)).map(picture => ({attachmentId: picture.attachmentId!, kind: "款图" as const}));
        if (!sheet.document || added.length) {
          const body = {expectedVersion: sheet.version, document: {...document, files: [...document.files, ...added]}};
          const payload = JSON.stringify(body);
          if (draftSaveKey.current?.payload !== payload) draftSaveKey.current = {payload, key: createClientRequestId()};
          await digitalRequest<DevelopmentSheet>(base, "PUT", body, draftSaveKey.current.key);
        }
      }
      let orderId: string | null = null;
      if (orderInput) {
        const payload = JSON.stringify(orderInput);
        if (orderKey.current?.payload !== payload) orderKey.current = {payload, key: createClientRequestId()};
        const order = await digitalRequest<DigitalOrder>(`sources/${id}/confirm`, "POST", orderInput, orderKey.current.key);
        orderId = order.productionOrderId;
      }
      completed.current = true; writing.current = false; onCreated(id, orderId);
    } catch (reason) {
      const validation = reason as {issues?: Array<{message: string}>};
      setError(validation.issues?.[0]?.message ?? (reason instanceof Error ? reason.message : "保存失败"));
    } finally {writing.current = false; setBusy(false);}
  };
  return <Surface className="development-create"><form onSubmit={event => {event.preventDefault(); void save();}}>
    <h2>{title}</h2>
    {source && <p>沿用第 {source.adoptedRound ?? source.selectedRound ?? 1} 轮开发资料；头版/开发板与已有工序保持原档案。</p>}
    {error && <p role="alert">{error}</p>}
    {createdSource && !source && error && <p role="status">开发档案已保存。修正订购信息后重试会沿用此档案。</p>}
    <fieldset disabled={busy}><div className="development-create-grid">
      {intent !== "confirm_order" && <label>开发类型<select aria-label="开发类型" disabled={Boolean(createdSource)} value={developmentType} onChange={event => setDevelopmentType(event.target.value as "头版" | "开发板")}><option>头版</option><option>开发板</option></select></label>}
      <label>设计款号<input required maxLength={100} value={form.designStyleNo} readOnly={Boolean(createdSource)} onChange={event => setForm({...form, designStyleNo: event.target.value})}/></label>
      <label>代用款号<input maxLength={100} value={form.temporaryStyleNo ?? ""} readOnly={Boolean(createdSource)} onChange={event => setForm({...form, temporaryStyleNo: event.target.value || null})}/></label>
      <label>客户<select aria-label="客户" required={withOrder} disabled={Boolean(createdSource && fixedCustomer)} value={form.customerCode} onChange={event => {const customer = customers.find(customer => customer.code === event.target.value); setForm({...form, customerCode: event.target.value, primaryMerchandiserId: customer?.defaultMerchandiserId ?? null, productGroup: initialDigitalProductGroup(customers, event.target.value)});}}><option value="">通用开发 / 请选择</option>{customers.map(customer => <option key={customer.code} value={customer.code}>{customer.code} · {customer.name}</option>)}</select></label>
    </div>
    <div className={`development-create-layout${source ? " development-create-layout-existing" : ""}`}>
    {!source && <section className="development-create-pictures"><h3>款图</h3><p>保存时沿用同一开发草稿；进入开发单后直接查看，无需再次上传。</p>
      <label>选择款图<input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy || pictures.length >= 30} onChange={event => {const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void selectPictures(files);}}/></label>
      <label>开发单模板<select value={template} disabled={Boolean(createdSource)} onChange={event => setTemplate(event.target.value as DevelopmentDocument["template"])}><option>上衣</option><option>裤子</option></select></label>
      <div className="development-thumbnails">{pictures.map(picture => <div key={picture.id}><a href={picture.preview} target="_blank" rel="noreferrer"><img src={picture.preview} alt={picture.file.name}/></a><span>{picture.file.name} · {picture.attachmentId ? "上传完成，待保存关联" : "待保存上传"}</span>{picture.error && <p role="alert">{picture.error}</p>}<Button type="button" disabled={busy} onClick={() => {picturesRef.current = picturesRef.current.filter(item => item.id !== picture.id); setPictures(picturesRef.current);}}>移除未保存款图</Button></div>)}</div>
      {pictures.some(picture => picture.error) && <Button type="button" disabled={busy} onClick={() => void save()}>重试保存并上传</Button>}
    </section>}
    <div className="development-create-order">{withOrder && <><h3>订购信息</h3><p>默认主跟单：{customers.find(customer => customer.code === form.customerCode)?.defaultMerchandiserName ?? "未配置，待主管指派"}</p>
      <div className="development-create-grid"><label>产品分组<select aria-label="产品分组" value={form.productGroup} onChange={event => setForm({...form, productGroup: event.target.value as DigitalOrderInput["productGroup"]})}>{(customers.find(customer => customer.code === form.customerCode)?.productGroups ?? [form.productGroup]).map(group => <option key={group}>{group}</option>)}</select></label>
        <label>客户下单日期<input required type="date" value={form.orderDate} onChange={event => setForm({...form, orderDate: event.target.value})}/></label>
</div>
      <div className="development-table-scroll"><table className="development-create-po-table"><thead><tr><th>PO</th><th>正式款号 / PO</th><th>本 PO 代用号（选填）</th><th>颜色 / 外文</th><th>客户要求到仓日期</th><th>尺码与订购数量</th><th>操作</th></tr></thead><tbody>
      {form.lines.map((value, index) => <tr key={index}><th>{index + 1}</th>
        <td><input aria-label={`PO ${index+1} 正式款号 / PO`} maxLength={100} value={value.formalPoNo ?? ""} onChange={event => line(index, {formalPoNo: event.target.value || null})}/></td>
        <td><input aria-label={`PO ${index+1} 代用款号（选填）`} maxLength={100} placeholder={form.temporaryStyleNo ?? "沿用母单代用号"} value={value.temporaryStyleNo ?? ""} onChange={event => line(index, {temporaryStyleNo: event.target.value || null})}/></td>
        <td><input aria-label={`PO ${index+1} 颜色`} placeholder="颜色（必填）" required maxLength={100} value={value.color} onChange={event => line(index, {color: event.target.value})}/><input aria-label={`PO ${index+1} 颜色外文`} placeholder="颜色外文（选填）" maxLength={100} value={value.colorForeign ?? ""} onChange={event => line(index, {colorForeign: event.target.value || null})}/></td>
        <td><input aria-label={`PO ${index+1} 客户要求到仓日期`} type="date" value={value.customerWarehouseArrivalDate ?? ""} onChange={event => customerDate(index, event.target.value || null)}/>{index === 0 && <small>其余 PO 默认沿用，可单独修改。</small>}</td>
        <td>{value.sizes.map((size, sizeIndex) => <div className="development-create-size" key={sizeIndex}><input aria-label={`PO ${index+1} 尺码 ${sizeIndex+1}`} placeholder="尺码" required maxLength={100} value={size.size} onChange={event => line(index, {sizes: value.sizes.map((item, i) => i === sizeIndex ? {...item, size: event.target.value} : item)})}/><input aria-label={`PO ${index+1} 订购数量 ${sizeIndex+1}`} required type="text" inputMode="numeric" pattern="[0-9]+" maxLength={8} value={size.quantity} onChange={event => line(index, {sizes: value.sizes.map((item, i) => i === sizeIndex ? {...item, quantity: event.target.value} : item)})}/>{value.sizes.length > 1 && <Button type="button" aria-label={`删除 PO ${index+1} 尺码 ${sizeIndex+1}`} onClick={async () => {if (await confirmInApp("删除这个尺码和订购数量？") && !writing.current) line(index, {sizes: value.sizes.filter((_, i) => i !== sizeIndex)});}}>删除</Button>}</div>)}<Button type="button" disabled={value.sizes.length >= 50} onClick={() => line(index, {sizes: [...value.sizes, {size: "", quantity: "1"}]})}>添加尺码</Button></td>
        <td>{form.lines.length > 1 && <Button type="button" onClick={async () => {if (await confirmInApp("删除这个 PO 和全部订购数量？") && !writing.current) removeLine(index);}}>删除 PO</Button>}</td>
      </tr>)}</tbody></table></div><Button type="button" disabled={form.lines.length >= 50} onClick={() => setForm(current => ({...current, lines: [...current.lines, inheritPoDate({...newLine(), sizes: [{size: "", quantity: "1"}]}, current.lines[0], "customerWarehouseArrivalDate")]}))}>添加款色 / PO</Button>
    </>}
    <div className="pattern-actions"><Button type="submit" disabled={busy}>{busy ? "保存中…" : intent === "confirm_order" ? "确认下单" : "保存并填写开发单"}</Button><Button type="button" disabled={busy} onClick={async () => {if ((!dirty.current || await confirmInApp("有未保存订购资料或款图，确定离开？")) && !writing.current) onCancel();}}>返回列表</Button></div></div></div></fieldset>
  </form></Surface>;
}
