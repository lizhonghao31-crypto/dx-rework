import { createWebUrls } from "../url-contract.js";
import { useEffect, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import type { DigitalCustomer, DigitalOrder } from "@dx-rework/contracts/digital-production";
import type { CustomerDateHistory } from "@dx-rework/contracts/production-instruction";
import { PoCustomerDateHistory } from "./po-customer-dates.js";
import { digitalRequest } from "./digital-production-api.js";
export type DigitalAccessOptions = { manage: boolean; customers: boolean; approveDelivery: boolean; create: boolean; actorId: string; roles: string[] };
type Candidate = { id: string; displayName: string; roles: string[] };
type Delivery = CustomerDateHistory;
export function DigitalAccessPanel({ options, customers, order, onChanged }: { options: DigitalAccessOptions; customers: DigitalCustomer[]; order: DigitalOrder | null; onChanged(): Promise<void> }) {
  const [people, setPeople] = useState<Candidate[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [customerCode, setCustomerCode] = useState(customers[0]?.code ?? "");
  const [defaultMerchandiserId, setDefaultMerchandiserId] = useState(customers[0]?.defaultMerchandiserId ?? "");
  const [orderMerchandiserId, setOrderMerchandiserId] = useState(order?.primaryMerchandiserId ?? "");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const load = async () => {
    if (options.manage || options.customers || options.create) setPeople(await digitalRequest<Candidate[]>("access/candidates"));
    if (order) {
      setDeliveries(await digitalRequest<Delivery[]>(`orders/${order.productionOrderId}/delivery-requests`));
    } else { setDeliveries([]); }
  };
  useEffect(() => { void load().catch(reason => setError(reason.message)); }, [order?.productionOrderId, options.manage, options.customers, options.create]);
  useEffect(() => {
    const customer = customers.find((item) => item.code === customerCode) ?? customers[0];
    if (!customer) { setCustomerCode(""); setDefaultMerchandiserId(""); return; }
    if (customer.code !== customerCode) setCustomerCode(customer.code);
    setDefaultMerchandiserId(customer.defaultMerchandiserId ?? "");
  }, [customers, customerCode]);
  useEffect(() => {
    setOrderMerchandiserId(order?.primaryMerchandiserId ?? "");
  }, [order?.productionOrderId, order?.primaryMerchandiserId]);
  const save = async (path: string, body: unknown, method = "POST") => {
    if (busy) return; setBusy(true); setError("");
    try { await digitalRequest(path, method, body); await onChanged(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); } finally { setBusy(false); }
  };
  const personOptions = (role?: string) => people.filter(person => !role || person.roles.includes(role)).map(person => <option key={person.id} value={person.id}>{person.displayName}</option>);
  if (!options.manage && !options.customers && !order) return null;
  return <Surface><h2>订单人员与授权</h2>{error && <p role="alert">{error}</p>}
    {options.customers && !order && <form onSubmit={event => { event.preventDefault(); void save(`customers/${customerCode}/default-merchandiser`, { merchandiserId: defaultMerchandiserId || null }, "PUT"); }}><fieldset disabled={busy}><legend>客户默认主跟单</legend><label>客户<select required name="customer" value={customerCode} onChange={event => { const code = event.target.value; setCustomerCode(code); setDefaultMerchandiserId(customers.find(customer => customer.code === code)?.defaultMerchandiserId ?? ""); }}>{customers.map(customer => <option key={customer.code} value={customer.code}>{customer.code}</option>)}</select></label><label>主跟单<select name="person" value={defaultMerchandiserId} onChange={event => setDefaultMerchandiserId(event.target.value)}><option value="">未指定</option>{personOptions("order_merchandiser")}</select></label><Button type="submit">保存默认跟单</Button></fieldset></form>}
    {order && <><p>主跟单：{people.find(person => person.id === order.primaryMerchandiserId)?.displayName ?? (order.primaryMerchandiserId ? "已指派" : "待指派")}</p>
      {options.manage && <form onSubmit={event => { event.preventDefault(); void save(`orders/${order.productionOrderId}/merchandiser`, { merchandiserId: orderMerchandiserId, expectedVersion: order.version }, "PUT"); }}><fieldset disabled={busy}><legend>调整主跟单</legend><select name="person" required value={orderMerchandiserId} onChange={event => setOrderMerchandiserId(event.target.value)}><option value="">请选择</option>{personOptions("order_merchandiser")}</select><Button type="submit">保存指派</Button></fieldset></form>}
      <p>客户交期按明确 PO 办理。<a href={`${createWebUrls(import.meta.env.BASE_URL).pageUrl("ui/digital-production")}?instruction=${order.productionOrderId}`}>进入大货制单交期区域</a></p>
      <div className="digital-access-date-history"><PoCustomerDateHistory requests={deliveries} canApprove={options.approveDelivery} busy={busy} onDecide={(requestId,approved)=>void save(`delivery-requests/${requestId}/decision`,{decision:approved?"approved":"rejected"})}/></div>
    </>}
  </Surface>;
}
