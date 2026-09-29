import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import type { DigitalCustomer, DigitalOrder, DigitalOrderInput, DigitalSource } from "@dx-rework/contracts/digital-production";
import { createWebUrls } from "../url-contract.js";
import { Header } from "./components.js";
import "./pattern-room.css";
import "./digital-production.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
async function request<T>(path: string, method = "GET", body?: unknown, key?: string): Promise<T> {
  const response = await fetch(urls.apiUrl(`digital-production/${path}`), { method, credentials: "include", cache: "no-store",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(data.error?.message ?? (response.status === 404 ? "数字生产功能尚未开放" : "操作失败，请重试"));
  }
  return response.json() as Promise<T>;
}
export function DigitalProductionEntry() {
  const [available, setAvailable] = useState(false);
  useEffect(() => { let live = true; void request("options").then(() => { if (live) setAvailable(true); }).catch(() => undefined); return () => { live = false; }; }, []);
  return available ? <a className="dx-button dx-button--secondary" href={urls.pageUrl("ui/digital-production")}>数字生产订单</a> : null;
}
const newLine = (): DigitalOrderInput["lines"][number] => ({ poNumber: null, formalStyleNo: null, temporaryStyleNo: null, color: "", colorForeign: null, deliveryDate: null, sizes: [{ size: "", quantity: 1 }] });
const emptyOrder = (): DigitalOrderInput => ({ customerCode: "", productGroup: "男装", designStyleNo: "", temporaryStyleNo: null,
  orderDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), contractDeliveryDate: null, lines: [newLine()] });
export function DigitalProductionPage() {
  const [options, setOptions] = useState<{ creationEnabled: boolean; customers: DigitalCustomer[] } | null>(null);
  const [orders, setOrders] = useState<DigitalOrder[]>([]);
  const [sources, setSources] = useState<DigitalSource[]>([]);
  const [selected, setSelected] = useState<DigitalOrder | null>(null);
  const [mode, setMode] = useState<"list" | "source" | "order">("list");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [developmentType, setDevelopmentType] = useState<"头版" | "开发板">("头版");
  const [form, setForm] = useState<DigitalOrderInput>(emptyOrder);
  const [page, setPage] = useState(1); const [search, setSearch] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const operation = useRef<{ payload: string; key: string } | null>(null);
  const alive = useRef(true);
  const loadingVersion = useRef(0);
  const writing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = async () => {
    const version = ++loadingVersion.current;
    const query = `page=${page}&search=${encodeURIComponent(search)}`;
    const [nextOptions, nextOrders, nextSources] = await Promise.all([
      request<{ creationEnabled: boolean; customers: DigitalCustomer[] }>("options"),
      request<{ items: DigitalOrder[] }>(`orders?${query}`), request<{ items: DigitalSource[] }>(`sources?${query}`),
    ]);
    if (alive.current && version === loadingVersion.current) { setOptions(nextOptions); setOrders(nextOrders.items); setSources(nextSources.items); }
  };
  useEffect(() => { let live = true; const timer = window.setTimeout(() => { void reload().catch(reason => { if (live) setError(String(reason.message)); }); }, 150); return () => { live = false; window.clearTimeout(timer); }; }, [page, search]);
  const run = async (path: string, body: unknown, method = "POST") => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true); setError("");
    const payload = JSON.stringify([path, method, body]);
    if (operation.current?.payload !== payload) operation.current = { payload, key: crypto.randomUUID() };
    try {
      const value = await request<DigitalOrder | { sourceId: string }>(path, method, body, operation.current.key);
      operation.current = null;
      if ("productionOrderId" in value) setSelected(value);
      setMode("list"); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { writing.current = false; setBusy(false); }
  };
  const updateLine = (index: number, patch: Partial<DigitalOrderInput["lines"][number]>) => setForm(current => ({ ...current, lines: current.lines.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  const start = (next: "source" | "order", source?: DigitalSource) => { setSelected(null); setSourceId(source?.sourceId ?? null); setForm({ ...emptyOrder(), designStyleNo: source?.designStyleNo ?? "", temporaryStyleNo: source?.temporaryStyleNo ?? null, customerCode: source?.customerCode ?? "" }); setMode(next); setError(""); };
  return <div className="pattern-orders digital-production"><Header title="数字生产订单" badge="订单源头" badgePlacement="subtitle" />
    {error && <p role="alert">{error}</p>}
    {options && <><Surface><div className="pattern-actions"><Button onClick={() => { setMode("list"); setSelected(null); }}>订单列表</Button>
      {options.creationEnabled && <><Button onClick={() => start("order")}>直接下单</Button><Button onClick={() => start("source")}>新增开发来源</Button></>}
    </div></Surface>
    {mode !== "list" && <Surface><form onSubmit={event => { event.preventDefault(); void run(mode === "source" ? "sources" : sourceId ? `sources/${sourceId}/confirm` : "orders", mode === "source" ? { developmentType, designStyleNo: form.designStyleNo, temporaryStyleNo: form.temporaryStyleNo, customerCode: form.customerCode || null } : form); }}>
      <h2>{mode === "source" ? "新增开发来源" : sourceId ? "确认下单" : "直接下单"}</h2><fieldset disabled={busy}>
      {mode === "source" && <label>开发类型<select value={developmentType} onChange={event => setDevelopmentType(event.target.value as "头版" | "开发板")}><option>头版</option><option>开发板</option></select></label>}
      <label>设计款号<input required maxLength={100} value={form.designStyleNo} readOnly={Boolean(sourceId)} onChange={event => setForm({ ...form, designStyleNo: event.target.value })} /></label>
      <label>代用款号<input maxLength={100} value={form.temporaryStyleNo ?? ""} onChange={event => setForm({ ...form, temporaryStyleNo: event.target.value || null })} /></label>
      <label>客户<select required={mode === "order"} value={form.customerCode} onChange={event => { const code = event.target.value; const group = options.customers.find(item => item.code === code)?.productGroups[0]; setForm({ ...form, customerCode: code, productGroup: (group ?? form.productGroup) as DigitalOrderInput["productGroup"] }); }}><option value="">请选择</option>{options.customers.map(customer => <option key={customer.code} value={customer.code}>{customer.code} · {customer.name}</option>)}</select></label>
      {mode === "order" && <><label>产品分组<select value={form.productGroup} onChange={event => setForm({ ...form, productGroup: event.target.value as DigitalOrderInput["productGroup"] })}>{(options.customers.find(item => item.code === form.customerCode)?.productGroups ?? [form.productGroup]).map(group => <option key={group}>{group}</option>)}</select></label>
        <label>客户下单日期<input required type="date" value={form.orderDate} onChange={event => setForm({ ...form, orderDate: event.target.value })} /></label>
        <label>客户合同交付日期<input type="date" value={form.contractDeliveryDate ?? ""} onChange={event => setForm({ ...form, contractDeliveryDate: event.target.value || null })} /></label>
        {form.lines.map((line, index) => <fieldset key={index}><legend>款色 / PO {index + 1}</legend>
          <label>PO 号<input maxLength={100} value={line.poNumber ?? ""} onChange={event => updateLine(index, { poNumber: event.target.value || null })} /></label>
          <label>正式款号<input maxLength={100} value={line.formalStyleNo ?? ""} onChange={event => updateLine(index, { formalStyleNo: event.target.value || null })} /></label>
          <label>代用款号<input maxLength={100} value={line.temporaryStyleNo ?? ""} onChange={event => updateLine(index, { temporaryStyleNo: event.target.value || null })} /></label>
          <label>颜色外文<input maxLength={100} value={line.colorForeign ?? ""} onChange={event => updateLine(index, { colorForeign: event.target.value || null })} /></label>
          <label>颜色<input required maxLength={100} value={line.color} onChange={event => updateLine(index, { color: event.target.value })} /></label>
          <label>明细约定交期<input type="date" value={line.deliveryDate ?? ""} onChange={event => updateLine(index, { deliveryDate: event.target.value || null })} /></label>
          {line.sizes.map((size, sizeIndex) => <div className="pattern-actions" key={sizeIndex}><label>尺码<input required maxLength={100} value={size.size} onChange={event => updateLine(index, { sizes: line.sizes.map((item, i) => i === sizeIndex ? { ...item, size: event.target.value } : item) })} /></label><label>数量<input required type="number" min={1} max={10000000} step={1} value={size.quantity} onChange={event => updateLine(index, { sizes: line.sizes.map((item, i) => i === sizeIndex ? { ...item, quantity: Number(event.target.value) } : item) })} /></label>{line.sizes.length > 1 && <Button type="button" onClick={() => updateLine(index, { sizes: line.sizes.filter((_, i) => i !== sizeIndex) })}>删除尺码</Button>}</div>)}
          <Button type="button" disabled={line.sizes.length >= 50} onClick={() => updateLine(index, { sizes: [...line.sizes, { size: "", quantity: 1 }] })}>添加尺码</Button>
          {form.lines.length > 1 && <Button type="button" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== index) })}>删除款色</Button>}
        </fieldset>)}<Button type="button" disabled={form.lines.length >= 50} onClick={() => setForm({ ...form, lines: [...form.lines, newLine()] })}>添加款色 / PO</Button></>}
      <div className="pattern-actions"><Button type="submit" disabled={busy}>保存</Button><Button type="button" onClick={() => setMode("list")}>取消</Button></div></fieldset>
    </form></Surface>}
    {mode === "list" && !selected && <><Surface><label>搜索款号 / PO<input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
      <h2>履约母单</h2>{orders.length === 0 && <p>暂无订单</p>}{orders.map(order => <div className="pattern-actions" key={order.productionOrderId}><Button onClick={() => { void request<DigitalOrder>(`orders/${order.productionOrderId}`).then(setSelected).catch(reason => setError(reason.message)); }}>{order.designStyleNo}</Button><span>{order.customerCode} · {order.lines.length} 个款色 · {order.status === "waiting_development" ? "待提交开发单" : "已关联开发来源"}</span></div>)}
      <h2>开发来源</h2>{sources.length === 0 && <p>暂无开发来源</p>}{sources.map(source => <div className="pattern-actions" key={source.sourceId}><span>{source.designStyleNo} · {source.developmentType}</span>{source.productionOrderId ? <span>已下单</span> : options.creationEnabled && <Button onClick={() => start("order", source)}>确认下单</Button>}</div>)}
      <div className="pattern-actions"><Button disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button><span>{page}</span><Button disabled={orders.length < 20 && sources.length < 20} onClick={() => setPage(page + 1)}>下一页</Button></div>
    </Surface></>}
    {mode === "list" && selected && <Surface><h2>{selected.designStyleNo}</h2><p>{selected.customerCode} · {selected.productGroup} · {selected.status === "waiting_development" ? "待提交开发单 · 未设时限" : "已关联开发来源"}</p>
      <p>客户下单：{selected.orderDate} · 合同交付：{selected.contractDeliveryDate ?? "待补"}</p>
      {selected.lines.map(line => <form key={`${line.lineId}:${selected.version}`} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(`orders/${selected.productionOrderId}/lines/${line.lineId}/numbers`, { expectedVersion: selected.version, poNumber: data.get("poNumber") || null, formalStyleNo: data.get("formalStyleNo") || null }, "PATCH"); }}><fieldset disabled={busy}><legend>{line.color}</legend><p>{line.sizes.map(size => `${size.size}：${size.quantity.toLocaleString()}`).join(" / ")}</p><label>PO 号<input name="poNumber" maxLength={100} defaultValue={line.poNumber ?? ""} /></label><label>正式款号<input name="formalStyleNo" maxLength={100} defaultValue={line.formalStyleNo ?? ""} /></label><Button type="submit">保存编号</Button></fieldset></form>)}
      {!selected.sourceId && <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(`orders/${selected.productionOrderId}/source/${String(data.get("sourceId"))}`, {}); }}><label>关联开发来源<select name="sourceId" required><option value="">请选择</option>{sources.filter(source => !source.productionOrderId && source.designStyleNo === selected.designStyleNo).map(source => <option key={source.sourceId} value={source.sourceId}>{source.designStyleNo} · {source.developmentType}</option>)}</select></label><Button type="submit" disabled={busy}>关联</Button></form>}
    </Surface>}
    </>}
  </div>;
}
