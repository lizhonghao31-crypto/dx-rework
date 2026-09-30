import { useEffect, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import type { DigitalCustomer, DigitalOrder } from "@dx-rework/contracts/digital-production";
import { digitalRequest } from "./digital-production-api.js";
export type DigitalAccessOptions = { manage: boolean; delegate: boolean; customers: boolean; approveDelivery: boolean; create: boolean; actorId: string; roles: string[] };
type Candidate = { id: string; displayName: string; roles: string[] };
type Delegation = { delegationId: string; delegateId: string; purpose: string; expiresAt: string; revokedAt: string | null };
type Delivery = { requestId: string; deliveryDate: string; reason: string; decision: string | null };
export function DigitalAccessPanel({ options, customers, order, onChanged }: { options: DigitalAccessOptions; customers: DigitalCustomer[]; order: DigitalOrder | null; onChanged(): Promise<void> }) {
  const [people, setPeople] = useState<Candidate[]>([]);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [customerCode, setCustomerCode] = useState(customers[0]?.code ?? "");
  const [defaultMerchandiserId, setDefaultMerchandiserId] = useState(customers[0]?.defaultMerchandiserId ?? "");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const load = async () => {
    if (options.delegate || options.create) setPeople(await digitalRequest<Candidate[]>("access/candidates"));
    if (order) {
      if (options.delegate) setDelegations(await digitalRequest<Delegation[]>(`access/delegations/order/${order.productionOrderId}`));
      setDeliveries(await digitalRequest<Delivery[]>(`orders/${order.productionOrderId}/delivery-requests`));
    } else { setDelegations([]); setDeliveries([]); }
  };
  useEffect(() => { void load().catch(reason => setError(reason.message)); }, [order?.productionOrderId, options.delegate, options.create]);
  useEffect(() => {
    const customer = customers.find((item) => item.code === customerCode) ?? customers[0];
    if (!customer) { setCustomerCode(""); setDefaultMerchandiserId(""); return; }
    if (customer.code !== customerCode) setCustomerCode(customer.code);
    setDefaultMerchandiserId(customer.defaultMerchandiserId ?? "");
  }, [customers, customerCode]);
  const save = async (path: string, body: unknown, method = "POST") => {
    if (busy) return; setBusy(true); setError("");
    try { await digitalRequest(path, method, body); await onChanged(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); } finally { setBusy(false); }
  };
  const personOptions = (role?: string) => people.filter(person => !role || person.roles.includes(role)).map(person => <option key={person.id} value={person.id}>{person.displayName}</option>);
  if (!options.delegate && !options.customers && !order) return null;
  return <Surface><h2>订单人员与授权</h2>{error && <p role="alert">{error}</p>}
    {options.customers && !order && <form onSubmit={event => { event.preventDefault(); void save(`customers/${customerCode}/default-merchandiser`, { merchandiserId: defaultMerchandiserId || null }, "PUT"); }}><fieldset disabled={busy}><legend>客户默认主跟单</legend><label>客户<select required name="customer" value={customerCode} onChange={event => { const code = event.target.value; setCustomerCode(code); setDefaultMerchandiserId(customers.find(customer => customer.code === code)?.defaultMerchandiserId ?? ""); }}>{customers.map(customer => <option key={customer.code} value={customer.code}>{customer.code}</option>)}</select></label><label>主跟单<select name="person" value={defaultMerchandiserId} onChange={event => setDefaultMerchandiserId(event.target.value)}><option value="">未指定</option>{personOptions("order_merchandiser")}</select></label><Button type="submit">保存默认跟单</Button></fieldset></form>}
    {order && <><p>主跟单：{people.find(person => person.id === order.primaryMerchandiserId)?.displayName ?? (order.primaryMerchandiserId ? "已指派" : "待指派")}</p>
      {options.manage && <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void save(`orders/${order.productionOrderId}/merchandiser`, { merchandiserId: data.get("person"), expectedVersion: order.version }, "PUT"); }}><fieldset disabled={busy}><legend>调整主跟单</legend><select name="person" required defaultValue={order.primaryMerchandiserId ?? ""}><option value="">请选择</option>{personOptions("order_merchandiser")}</select><Button type="submit">保存指派</Button></fieldset></form>}
      {options.delegate && <><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void save("access/delegations", { resourceKind: "order", resourceId: order.productionOrderId, delegateId: data.get("person"), purpose: data.get("purpose"), expiresAt: new Date(`${String(data.get("expires"))}:00+08:00`).toISOString() }); }}><fieldset disabled={busy}><legend>有限期订单代理</legend><label>人员<select name="person" required><option value="">请选择</option>{personOptions()}</select></label><label>资料范围<select name="purpose"><option value="technical">技术资料</option>{options.manage && <option value="budget">预算资料（仅设计师／跟单）</option>}</select></label><label>到期时间（北京时间）<input name="expires" type="datetime-local" required /></label><Button type="submit">授权</Button></fieldset></form>
        {delegations.map(item => <div className="pattern-actions" key={item.delegationId}><span>{people.find(person => person.id === item.delegateId)?.displayName ?? "代理人员"} · {item.purpose === "budget" ? "预算" : "技术资料"} · {new Date(item.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>{item.revokedAt ? <span>已撤销</span> : <Button disabled={busy} onClick={() => void save(`access/delegations/${item.delegationId}/revoke`, {})}>撤销</Button>}</div>)}</>}
      {(options.roles.includes("root_superuser") || (options.roles.includes("order_merchandiser") && order.primaryMerchandiserId === options.actorId)) && <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void save(`orders/${order.productionOrderId}/delivery-requests`, { deliveryDate: data.get("date"), reason: data.get("reason"), expectedVersion: order.version }); }}><fieldset disabled={busy}><legend>申请变更正式货期</legend><label>新交付日<input name="date" type="date" required /></label><label>原因<input name="reason" required maxLength={1000} /></label><Button type="submit">提交总监批准</Button></fieldset></form>}
      {deliveries.map(item => <div className="pattern-actions" key={item.requestId}><span>{item.deliveryDate} · {item.reason} · {item.decision === "approved" ? "已批准" : item.decision === "rejected" ? "已驳回" : "待批准"}</span>{!item.decision && options.approveDelivery && <><Button disabled={busy} onClick={() => void save(`delivery-requests/${item.requestId}/decision`, { decision: "approved" })}>批准</Button><Button disabled={busy} onClick={() => void save(`delivery-requests/${item.requestId}/decision`, { decision: "rejected" })}>驳回</Button></>}</div>)}
    </>}
  </Surface>;
}
