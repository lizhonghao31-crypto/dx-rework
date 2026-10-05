import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { DigitalOrderCreateSchema, DigitalSourceCreateSchema, type DigitalCustomer, type DigitalOrder, type DigitalOrderInput, type DigitalSource } from "@dx-rework/contracts/digital-production";
import type { OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { digitalRequest } from "./digital-production-api.js";
import { initialDigitalProductGroup } from "./digital-production-defaults.js";
import { createClientRequestId } from "./client-request-id.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";

export type DevelopmentCreateIntent = "development" | "certain_order" | "confirm_order";
const newLine = (): DigitalOrderInput["lines"][number] => ({poNumber: null, formalStyleNo: null, temporaryStyleNo: null, color: "", colorForeign: null, deliveryDate: null, sizes: [{size: "", quantity: 1}]});
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
  const [form, setForm] = useState(() => initialDevelopmentOrder(customers, source));
  const [developmentType, setDevelopmentType] = useState<"头版" | "开发板">("头版");
  const [createdSource, setCreatedSource] = useState<string | null>(source?.sourceId ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const writing = useRef(false), sourceKey = useRef<{payload: string; key: string} | null>(null), orderKey = useRef<{payload: string; key: string} | null>(null);
  const initial = useRef(JSON.stringify(form)), dirty = useRef(false), completed = useRef(false);
  dirty.current = JSON.stringify(form) !== initial.current || developmentType !== "头版";
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
  const line = (index: number, patch: Partial<DigitalOrderInput["lines"][number]>) => setForm(current => ({...current, lines: current.lines.map((value, i) => i === index ? {...value, ...patch} : value)}));
  const save = async () => {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError("");
    try {
      const sourceInput = DigitalSourceCreateSchema.parse({developmentType, designStyleNo: form.designStyleNo, temporaryStyleNo: form.temporaryStyleNo, customerCode: form.customerCode || null});
      const orderInput = withOrder ? DigitalOrderCreateSchema.parse(form) : null;
      let id = createdSource;
      if (!id) {
        const payload = JSON.stringify(sourceInput);
        if (sourceKey.current?.payload !== payload) sourceKey.current = {payload, key: createClientRequestId()};
        const next = await digitalRequest<DigitalSource>("sources", "POST", sourceInput, sourceKey.current.key);
        id = next.sourceId; setCreatedSource(id);
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
      <label>客户<select aria-label="客户" required={withOrder} disabled={Boolean(createdSource && form.customerCode)} value={form.customerCode} onChange={event => {const customer = customers.find(customer => customer.code === event.target.value); setForm({...form, customerCode: event.target.value, primaryMerchandiserId: customer?.defaultMerchandiserId ?? null, productGroup: initialDigitalProductGroup(customers, event.target.value)});}}><option value="">通用开发 / 请选择</option>{customers.map(customer => <option key={customer.code} value={customer.code}>{customer.code} · {customer.name}</option>)}</select></label>
    </div>
    {withOrder && <><h3>订购信息</h3><p>默认主跟单：{customers.find(customer => customer.code === form.customerCode)?.defaultMerchandiserName ?? "未配置，待主管指派"}</p>
      <div className="development-create-grid"><label>产品分组<select aria-label="产品分组" value={form.productGroup} onChange={event => setForm({...form, productGroup: event.target.value as DigitalOrderInput["productGroup"]})}>{(customers.find(customer => customer.code === form.customerCode)?.productGroups ?? [form.productGroup]).map(group => <option key={group}>{group}</option>)}</select></label>
        <label>客户下单日期<input required type="date" value={form.orderDate} onChange={event => setForm({...form, orderDate: event.target.value})}/></label>
        <label>客户合同交付日期<input type="date" value={form.contractDeliveryDate ?? ""} onChange={event => setForm({...form, contractDeliveryDate: event.target.value || null})}/></label></div>
      {form.lines.map((value, index) => <fieldset key={index}><legend>款色 / PO {index + 1}</legend><div className="development-create-grid">
        <label>PO 号<input maxLength={100} value={value.poNumber ?? ""} onChange={event => line(index, {poNumber: event.target.value || null})}/></label>
        <label>正式款号<input maxLength={100} value={value.formalStyleNo ?? ""} onChange={event => line(index, {formalStyleNo: event.target.value || null})}/></label>
        <label>代用款号<input maxLength={100} value={value.temporaryStyleNo ?? ""} onChange={event => line(index, {temporaryStyleNo: event.target.value || null})}/></label>
        <label>颜色外文<input maxLength={100} value={value.colorForeign ?? ""} onChange={event => line(index, {colorForeign: event.target.value || null})}/></label>
        <label>颜色<input required maxLength={100} value={value.color} onChange={event => line(index, {color: event.target.value})}/></label>
        <label>明细约定交期<input type="date" value={value.deliveryDate ?? ""} onChange={event => line(index, {deliveryDate: event.target.value || null})}/></label></div>
        {value.sizes.map((size, sizeIndex) => <div className="pattern-actions" key={sizeIndex}><label>尺码<input required maxLength={100} value={size.size} onChange={event => line(index, {sizes: value.sizes.map((item, i) => i === sizeIndex ? {...item, size: event.target.value} : item)})}/></label><label>数量<input required type="number" min={1} max={10000000} step={1} value={size.quantity} onChange={event => line(index, {sizes: value.sizes.map((item, i) => i === sizeIndex ? {...item, quantity: Number(event.target.value)} : item)})}/></label>{value.sizes.length > 1 && <Button type="button" onClick={() => line(index, {sizes: value.sizes.filter((_, i) => i !== sizeIndex)})}>删除尺码</Button>}</div>)}
        <div className="pattern-actions"><Button type="button" disabled={value.sizes.length >= 50} onClick={() => line(index, {sizes: [...value.sizes, {size: "", quantity: 1}]})}>添加尺码</Button>{form.lines.length > 1 && <Button type="button" onClick={() => setForm({...form, lines: form.lines.filter((_, i) => i !== index)})}>删除款色</Button>}</div>
      </fieldset>)}<Button type="button" disabled={form.lines.length >= 50} onClick={() => setForm({...form, lines: [...form.lines, newLine()]})}>添加款色 / PO</Button>
    </>}
    <div className="pattern-actions"><Button type="submit" disabled={busy}>{busy ? "保存中…" : intent === "confirm_order" ? "确认下单" : "保存并填写开发单"}</Button><Button type="button" disabled={busy} onClick={onCancel}>返回列表</Button></div></fieldset>
  </form></Surface>;
}
