import {BulkTaskWorkbench} from "./bulk-task-workbench.js";
import {OrderDocumentContainer} from "./order-document-container.js";
import {TaskWorkbenchSample} from "./task-workbench-sample.js";
import { DigitalPatternWorkspace } from "./digital-pattern-workspace.js";
import type { DigitalTask } from "@dx-rework/contracts/digital-production-tasks";
import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { PageHeader } from "@dx-rework/ui/production";
import type { DigitalOrder, DigitalSource } from "@dx-rework/contracts/digital-production";
import { createWebUrls } from "../url-contract.js";
import { verifySession } from "./auth.js";
import { canAccessDigitalProduction } from "./platform-modules.js";
import { navigateInternalPage } from "./internal-navigation.js";
import { OrderClosurePanel } from "./order-closure-panel.js";
import { FactoryFlowPanel } from "./factory-flow-panel.js";
import { BulkPreparationPanel } from "./bulk-preparation-panel.js";
import { DigitalTasksPanel } from "./digital-production-tasks-panel.js";
import { digitalTaskView } from "./digital-task-view.js";
import { digitalRequest } from "./digital-production-api.js";
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { createClientRequestId } from "./client-request-id.js";
import { canAttachHistoricalSource, digitalDetailClosePath, digitalDetailRoute, digitalLandingPath, historicalSourceCandidates } from "./digital-detail-route.js";
import "./pattern-room.css";
import "./digital-production.css";
import "./digital-detail.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
export function DigitalProductionEntry() {
  const [available, setAvailable] = useState(false);
  useEffect(() => { let live = true; void verifySession().then(session => { if (live) setAvailable(session !== "denied" && canAccessDigitalProduction(session.user)); }); return () => { live = false; }; }, []);
  return available ? <a className="dx-button dx-button--secondary" href={urls.pageUrl("ui/digital-cockpit")}>生产管理座舱</a> : null;
}

async function closeDetail() {
  const target = digitalDetailClosePath(window.location.search, urls.base);
  if (target) { await navigateInternalPage(target); return; }
  const session = await verifySession(), landing = session === "denied" ? null : digitalLandingPath(session.user);
  if (landing) await navigateInternalPage(urls.pageUrl(landing), { replace: true });
}

function LegacyLanding() {
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void verifySession().then(async session => {
      if (!live) return;
      const target = session === "denied" ? null : digitalLandingPath(session.user);
      if (target) await navigateInternalPage(urls.pageUrl(target), { replace: true });
      else setError("当前身份无可访问的数字生产工作台");
    });
    return () => { live = false; };
  }, []);
  return error ? <p role="alert">{error}</p> : <p role="status">正在打开工作台…</p>;
}

function OrderDetail({ id }: { id: string }) {
  const [order, setOrder] = useState<DigitalOrder | null>(null), [access, setAccess] = useState<DigitalAccessOptions | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void Promise.all([digitalRequest<DigitalOrder>(`orders/${id}`), digitalRequest<DigitalAccessOptions>("access/options")])
      .then(([next, flags]) => { if (live) { setOrder(next); setAccess(flags); } }).catch(reason => { if (live) setError(reason.message); });
    return () => { live = false; };
  }, [id]);
  if (error) return <><Button onClick={() => void closeDetail()}>返回</Button><p role="alert">{error}</p></>;
  if (!order) return <p role="status">正在读取原订单…</p>;
  if (!access) return <p role="status">正在读取原订单权限…</p>;
  const detailUrl = (kind: string, value: string) => `${urls.pageUrl("ui/digital-production")}?${kind}=${encodeURIComponent(value)}&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  return <><PageHeader title={order.designStyleNo} description={`${order.customerCode} · ${order.productGroup}`} />
    <div className="pattern-actions"><Button onClick={() => void closeDetail()}>返回</Button>
      {(access.manage || access.roles.some(role => ["sample_designer", "order_merchandiser"].includes(role))) && <a className="dx-button dx-button--secondary" href={detailUrl("budget", id)}>成本预算表</a>}
      <a className="dx-button dx-button--secondary" href={detailUrl("instruction", id)}>大货制单与客户交期</a>
      <a className="dx-button dx-button--secondary" href={detailUrl("bulk", id)}>产前准备</a>
      <a className="dx-button dx-button--secondary" href={detailUrl("factory", id)}>裁后工艺与发厂</a>
      <a className="dx-button dx-button--secondary" href={detailUrl("closure", id)}>回货与结案</a>
      {order.sourceId && <a className="dx-button dx-button--secondary" href={detailUrl("development", order.sourceId)}>查看开发单</a>}
    </div>
    <Surface className="digital-mother-readonly"><p>{order.sourceId ? "已关联开发来源" : "待提交开发单 · 未设时限"} · 主跟单：{order.primaryMerchandiserId ? "已指派" : "待指派"}</p>
      <p>客户下单：{order.orderDate} · 原合同交付：{order.contractDeliveryDate ?? "未登记"}</p>
      {order.lines.map(line => <section key={line.lineId}><h2>{line.color}</h2><dl>
        <div><dt>正式款号 / PO</dt><dd>{line.formalPoNo ?? line.poNumber ?? line.formalStyleNo ?? "未登记"}</dd></div>
        {line.formalStyleNo && line.formalStyleNo !== (line.formalPoNo ?? line.poNumber) && <div><dt>原正式款号</dt><dd>{line.formalStyleNo}</dd></div>}
        <div><dt>代用款号</dt><dd>{line.temporaryStyleNo ?? order.temporaryStyleNo ?? "未登记"}</dd></div>
        <div><dt>出货日期</dt><dd>{line.customerWarehouseArrivalDate ?? line.deliveryDate ?? "未登记"}</dd></div>
        <div><dt>加工厂交货日</dt><dd>{line.factoryDeliveryDate ?? "未登记"}</dd></div>
        <div><dt>尺码与数量</dt><dd>{line.sizes.map(size => `${size.size}：${size.quantity.toLocaleString()}`).join(" / ")}</dd></div>
      </dl></section>)}
    </Surface>
    {canAttachHistoricalSource(order, access) && <HistoricalSourceAttach order={order} onAttached={setOrder} />}
  </>;
}

function HistoricalSourceAttach({ order, onAttached }: { order: DigitalOrder; onAttached(order: DigitalOrder): void }) {
  const [sources, setSources] = useState<DigitalSource[]>([]), [page, setPage] = useState(1), [search, setSearch] = useState(""), [selected, setSelected] = useState<DigitalSource | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const writing = useRef(false), pending = useRef<{ sourceId: string; key: string } | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let live = true; setLoading(true);
    const timer = window.setTimeout(() => { void digitalRequest<{ items: DigitalSource[] }>(`sources?page=${page}&search=${encodeURIComponent(search)}`).then(result => { if (live) { setSources(result.items); setError(""); } }).catch(reason => { if (live) setError(reason.message); }).finally(() => { if (live) setLoading(false); }); }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [page, search]);
  const attach = async () => {
    if (!selected || writing.current) return;
    writing.current = true; setBusy(true); setError("");
    if (pending.current?.sourceId !== selected.sourceId) pending.current = { sourceId: selected.sourceId, key: createClientRequestId() };
    try { const next = await digitalRequest<DigitalOrder>(`orders/${order.productionOrderId}/source/${selected.sourceId}`, "POST", {}, pending.current.key); pending.current = null; if (alive.current) onAttached(next); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "关联失败"); }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const candidates = historicalSourceCandidates(order, sources), displayed = selected && !candidates.some(source => source.sourceId === selected.sourceId) ? [selected, ...candidates] : candidates;
  return <Surface><h2>关联开发来源</h2><p>此历史单尚无开发来源，可按原规则补关联。</p>{error && <p role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void attach(); }}><fieldset disabled={busy}>
      <label>搜索开发来源<input value={search} maxLength={100} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
      <label>开发来源 *<select aria-label="开发来源" required value={selected?.sourceId ?? ""} onChange={event => setSelected(displayed.find(source => source.sourceId === event.target.value) ?? null)}><option value="">请选择</option>{displayed.map(source => <option key={source.sourceId} value={source.sourceId}>{source.designStyleNo} · {source.developmentType}</option>)}</select></label>
      {loading && <p role="status">正在读取开发来源…</p>}
      {!loading && !candidates.length && <p>本页没有符合原关联规则的开发来源</p>}
      <div className="pattern-actions"><Button type="button" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</Button><span>{page}</span><Button type="button" disabled={sources.length < 15 || loading} onClick={() => setPage(value => value + 1)}>下一页</Button><Button type="submit" disabled={!selected || loading}>关联</Button></div>
    </fieldset></form></Surface>;
}

function TaskDetail({ id }: { id: string }) {
  const [task,setTask]=useState<DigitalTask|null>(null);
  const [access, setAccess] = useState<DigitalAccessOptions | null>(null), [error, setError] = useState("");
  useEffect(() => { let live = true; setAccess(null);setTask(null);setError("");void Promise.all([digitalRequest<DigitalAccessOptions>("access/options"),digitalRequest<DigitalTask>(`tasks/${id}`)]).then(([next,current]) => { if (live) {setAccess(next);setTask(current);} }).catch(reason => { if (live) setError(reason.message); }); return () => { live = false; }; }, [id]);
  if(task?.orderId&&task.taskKind==='bulk_pattern'&&digitalTaskView(window.location.search)!=='correct')return <BulkTaskWorkbench key={id} task={task} onClose={()=>void closeDetail()}/>;
  if(task?.sourceId&&task.taskKind.startsWith('development_')&&digitalTaskView(window.location.search)!=='correct')return <TaskWorkbenchSample key={id} task={task} onClose={()=>void closeDetail()}/>;
  return <><div className="pattern-actions"><Button onClick={() => void closeDetail()}>返回</Button></div>{error && <p role="alert">{error}</p>}{access ? task?.taskKind.startsWith("development_") ? <DigitalPatternWorkspace key={id} selectedOnly initialTask={task} initialAccess={access}/> : <DigitalTasksPanel options={access} taskId={id} compact view={digitalTaskView(window.location.search)} /> : !error && <p role="status">正在读取原任务…</p>}</>;
}

/** Native detail consumers; no order/task list or creation state. */
export function DigitalProductionPage() {
  const route = digitalDetailRoute(window.location.search);
  let detail;
  switch (route.kind) {
    case "landing": detail = <LegacyLanding />; break;
    case "invalid": detail = <><Button onClick={() => void closeDetail()}>返回</Button><p role="alert">{route.message}</p></>; break;
    case "closure": detail = <OrderClosurePanel orderId={route.id} onClose={() => void closeDetail()} />; break;
    case "factory": detail = <FactoryFlowPanel orderId={route.id} onClose={() => void closeDetail()} />; break;
    case "bulk": detail = <BulkPreparationPanel orderId={route.id} onClose={() => void closeDetail()} />; break;
    case "instruction": detail = <OrderDocumentContainer key={`instruction:${route.id}:${route.version}`} initial={{kind:"instruction",id:route.id,version:route.version}} onClose={() => void closeDetail()} />; break;
    case "budget": detail = <OrderDocumentContainer key={`budget:${route.id}:${route.version}`} initial={{kind:"budget",id:route.id,version:route.version}} onClose={() => void closeDetail()} />; break;
    case "order": detail = <OrderDetail id={route.id} />; break;
    case "development": detail = <OrderDocumentContainer key={`development:${route.id}:${route.version}`} initial={{kind:"development",id:route.id,version:route.version}} onClose={() => void closeDetail()} />; break;
    case "task": detail = <TaskDetail id={route.id} />; break;
  }
  return <div className="pattern-orders digital-production">{detail}</div>;
}
