import {ListPagination} from './list-pagination.js';
import {useForegroundWait} from "./foreground-loading.js";
import {lazyBusinessPage} from './lazy-business-page.js';
import {CurrentProductionReturn} from './development-workspace-return.js';
import {AcceptanceClockPanel} from './acceptance-clock-panel.js';
import {TodoReadBoundary} from './todo-content-read.js';
import {customerPoDateLabel} from "./digital-workspace-copy.js";
import type { DigitalTask } from "@dx-rework/contracts/digital-production-tasks";
import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { PageHeader } from "@dx-rework/ui/production";
import type { DigitalOrder, DigitalSource } from "@dx-rework/contracts/digital-production";
import { createWebUrls } from "../url-contract.js";
import { verifySession } from "./auth.js";
import { canAccessDigitalProduction } from "./platform-modules.js";
import { navigateInternalPage } from "./internal-navigation.js";
import { DigitalTasksPanel } from "./digital-production-tasks-panel.js";
import { digitalTaskView } from "./digital-task-view.js";
import { digitalRequest } from "./digital-production-api.js";
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { createClientRequestId } from "./client-request-id.js";
import {ProductionReadinessPanel} from "./production-readiness-panel.js";
import { canAttachHistoricalSource, digitalDetailClosePath, digitalDetailRoute, digitalLandingPath } from "./digital-detail-route.js";
import {readTechnicalOriginalSearch} from './technical-original-route.js';
import {warehouseWorkbenchReturnTab} from './warehouse-workbench-route.js';
import "./pattern-room.css";
import "./digital-production.css";
import "./digital-detail.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
const ShortLeadWorkspace=lazyBusinessPage(()=>import('./short-lead-workspace.js').then(module=>({default:module.ShortLeadWorkspace})),{shellOnError:false});
const OrderTimeRequestPage=lazyBusinessPage(()=>import('./order-time-request-page.js').then(module=>({default:module.OrderTimeRequestPage})),{shellOnError:false});
const DevelopmentArrangementPage=lazyBusinessPage(()=>import('./development-arrangement-page.js').then(module=>({default:module.DevelopmentArrangementPage})),{shellOnError:false});
const BulkTaskWorkbench=lazyBusinessPage(()=>import('./bulk-task-workbench.js').then(module=>({default:module.BulkTaskWorkbench})),{shellOnError:false});
const OrderDocumentContainer=lazyBusinessPage(()=>import('./order-document-container.js').then(module=>({default:module.OrderDocumentContainer})),{shellOnError:false});
const DevelopmentOriginalReader=lazyBusinessPage(()=>import('./development-original-reader.js').then(module=>({default:module.DevelopmentOriginalReader})),{shellOnError:false});
const DevelopmentTechnicalOriginal=lazyBusinessPage(()=>import('./development-technical-original.js').then(module=>({default:module.DevelopmentTechnicalOriginal})),{shellOnError:false});
const WarehouseReceiptBatchPanel=lazyBusinessPage(()=>import('./warehouse-receipt-batch-panel.js').then(module=>({default:module.WarehouseReceiptBatchPanel})),{shellOnError:false});
const WarehouseCraftWork=lazyBusinessPage(()=>import('./warehouse-craft-work.js').then(module=>({default:module.WarehouseCraftWork})),{shellOnError:false});
const PreparationMaterialOriginal=lazyBusinessPage(()=>import('./preparation-material-original.js').then(module=>({default:module.PreparationMaterialOriginal})),{shellOnError:false});
const OrderHistoryOriginal=lazyBusinessPage(()=>import('./order-history-original.js').then(module=>({default:module.OrderHistoryOriginal})),{shellOnError:false});
const ProductionOriginalReader=lazyBusinessPage(()=>import('./production-original-reader.js').then(module=>({default:module.ProductionOriginalReader})),{shellOnError:false});
const TaskWorkbenchSample=lazyBusinessPage(()=>import('./task-workbench-sample.js').then(module=>({default:module.TaskWorkbenchSample})),{shellOnError:false});
const DigitalPatternWorkspace=lazyBusinessPage(()=>import('./digital-pattern-workspace.js').then(module=>({default:module.DigitalPatternWorkspace})),{shellOnError:false});
const OrderClosurePanel=lazyBusinessPage(()=>import('./order-closure-panel.js').then(module=>({default:module.OrderClosurePanel})),{shellOnError:false});
const FactoryFlowPanel=lazyBusinessPage(()=>import('./factory-flow-panel.js').then(module=>({default:module.FactoryFlowPanel})),{shellOnError:false});
const BulkPreparationPanel=lazyBusinessPage(()=>import('./bulk-preparation-panel.js').then(module=>({default:module.BulkPreparationPanel})),{shellOnError:false});

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
  const [attempt,setAttempt]=useState(0);
  useForegroundWait((!order||!access)&&!error?`digital-order:${id}:${attempt}`:undefined);
  useEffect(()=>{
    const controller=new AbortController(),init={signal:controller.signal};
    setOrder(null);setAccess(null);setError("");
    void Promise.all([
      digitalRequest<DigitalOrder>(`orders/${id}`,"GET",undefined,undefined,init),
      digitalRequest<DigitalAccessOptions>("access/options","GET",undefined,undefined,init),
    ]).then(([next,flags])=>{
      if(!controller.signal.aborted){setOrder(next);setAccess(flags);}
    }).catch(reason=>{
      if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"原订单读取失败");
    });
    return()=>controller.abort();
  },[id,attempt]);
  if(error)return <><Button onClick={()=>void closeDetail()}>返回</Button><p role="alert">{error}</p><Button onClick={()=>setAttempt(value=>value+1)}>重新读取</Button></>;
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
      {(access.manage||access.roles.some(role=>['sample_designer','order_merchandiser'].includes(role)))&&<a className="dx-button dx-button--secondary" href={detailUrl('timeOrder',id)}>本单时效</a>}
      {order.sourceId && <a className="dx-button dx-button--secondary" href={detailUrl("development", order.sourceId)}>查看开发单</a>}
    </div>
    <Surface className="digital-mother-readonly"><p>{order.sourceId ? "已关联开发来源" : "待提交开发单 · 未设时限"} · 主跟单：{order.primaryMerchandiserId ? "已指派" : "待指派"}</p>
      <p>客户下单：{order.orderDate} · 原合同交付：{order.contractDeliveryDate ?? "未登记"}</p>
      {order.lines.map(line => <section key={line.lineId}><h2>{line.color}</h2><dl>
        <div><dt>正式款号 / PO</dt><dd>{line.formalPoNo ?? line.poNumber ?? line.formalStyleNo ?? "未登记"}</dd></div>
        {line.formalStyleNo && line.formalStyleNo !== (line.formalPoNo ?? line.poNumber) && <div><dt>原正式款号</dt><dd>{line.formalStyleNo}</dd></div>}
        <div><dt>代用款号</dt><dd>{line.temporaryStyleNo ?? order.temporaryStyleNo ?? "未登记"}</dd></div>
        <div><dt>{customerPoDateLabel}</dt><dd>{line.customerWarehouseArrivalDate ?? line.deliveryDate ?? "未登记"}</dd></div>
        <div><dt>加工厂交货日</dt><dd>{line.factoryDeliveryDate ?? "未登记"}</dd></div>
        <div><dt>尺码与数量</dt><dd>{line.sizes.map(size => `${size.size}：${size.quantity.toLocaleString()}`).join(" / ")}</dd></div>
      </dl></section>)}
    </Surface>
    {canAttachHistoricalSource(order, access) && <HistoricalSourceAttach key={order.productionOrderId} order={order} onAttached={setOrder} />}
  </>;
}

function HistoricalSourceAttach({ order, onAttached }: { order: DigitalOrder; onAttached(order: DigitalOrder): void }) {
  const [sources, setSources] = useState<DigitalSource[]>([]), [total,setTotal]=useState<number|null>(null), [page, setPage] = useState(1), [search, setSearch] = useState(""), [selected, setSelected] = useState<DigitalSource | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const writing = useRef(false), pending = useRef<{ sourceId: string; key: string } | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let live = true; setLoading(true); setTotal(null);
    const timer = window.setTimeout(() => { void digitalRequest<{ items: DigitalSource[]; total:number }>(`orders/${order.productionOrderId}/source-candidates?page=${page}&search=${encodeURIComponent(search)}`).then(result => { if (live) { setSources(result.items); setTotal(result.total); setError(""); } }).catch(reason => { if (live) setError(reason.message); }).finally(() => { if (live) setLoading(false); }); }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [order.productionOrderId,page, search]);
  const attach = async () => {
    if (!selected || writing.current) return;
    writing.current = true; setBusy(true); setError("");
    if (pending.current?.sourceId !== selected.sourceId) pending.current = { sourceId: selected.sourceId, key: createClientRequestId() };
    try { const next = await digitalRequest<DigitalOrder>(`orders/${order.productionOrderId}/source/${selected.sourceId}`, "POST", {}, pending.current.key); pending.current = null; if (alive.current) onAttached(next); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "关联失败"); }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const displayed = selected && !sources.some(source => source.sourceId === selected.sourceId) ? [selected, ...sources] : sources;
  return <Surface><h2>关联开发来源</h2><p>此历史单尚无开发来源，可按原规则补关联。</p>{error && <p role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void attach(); }}><fieldset disabled={busy}>
      <label>搜索开发来源<input value={search} maxLength={100} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
      <label>开发来源 *<select aria-label="开发来源" required value={selected?.sourceId ?? ""} onChange={event => setSelected(displayed.find(source => source.sourceId === event.target.value) ?? null)}><option value="">请选择</option>{displayed.map(source => <option key={source.sourceId} value={source.sourceId}>{source.designStyleNo} · {source.developmentType}</option>)}</select></label>
      {loading && <p role="status">正在读取开发来源…</p>}
      {!loading && total!==null && !sources.length && <p>本页没有符合原关联规则的开发来源</p>}
      <ListPagination page={page} total={total} totalPages={total===null?null:Math.max(1,Math.ceil(total/15))} busy={loading||busy} onPageChange={setPage} ariaLabel="关联开发来源分页"/>
      <div className="pattern-actions"><Button type="submit" disabled={!selected || loading}>关联</Button></div>
    </fieldset></form></Surface>;
}

function TaskDetail({ id }: { id: string }) {
  const [task,setTask]=useState<DigitalTask|null>(null);
  const [access, setAccess] = useState<DigitalAccessOptions | null>(null), [error, setError] = useState("");
  const [attempt,setAttempt]=useState(0);
  useForegroundWait((!access||!task)&&!error?`digital-task:${id}:${attempt}`:undefined);
  useEffect(()=>{
    const controller=new AbortController(),init={signal:controller.signal};
    setAccess(null);setTask(null);setError("");
    void Promise.all([
      digitalRequest<DigitalAccessOptions>("access/options","GET",undefined,undefined,init),
      digitalRequest<DigitalTask>(`tasks/${id}`,"GET",undefined,undefined,init),
    ]).then(([next,current])=>{
      if(!controller.signal.aborted){setAccess(next);setTask(current);}
    }).catch(reason=>{
      if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"原任务读取失败");
    });
    return()=>controller.abort();
  },[id,attempt]);
  const taskView=digitalTaskView(window.location.search);
  const warehouseTab=task?.taskKind==='warehouse_preshrink'||task?.taskKind==='warehouse_dispatch'
    ?warehouseWorkbenchReturnTab(digitalDetailClosePath(window.location.search,urls.base),urls.base):null;
  if(task?.orderId&&(task.taskKind==='bulk_pattern'||task.taskKind==='warehouse_preshrink'&&warehouseTab==='preshrink')&&taskView!=='correct')return <BulkTaskWorkbench key={id} task={task} onClose={()=>void closeDetail()}/>;
  if(task?.orderId&&task.taskKind==='warehouse_dispatch'&&warehouseTab==='dispatch'&&taskView==='handle'&&task.canExecute&&!task.paused)
    return <FactoryFlowPanel key={id} orderId={task.orderId} warehouseDispatchTask={id} onClose={()=>void closeDetail()}/>;
  if(task?.sourceId&&task.taskKind.startsWith('development_')&&digitalTaskView(window.location.search)!=='correct')return <TaskWorkbenchSample key={id} task={task} onClose={()=>void closeDetail()}/>;
  return <><div className="pattern-actions"><Button onClick={() => void closeDetail()}>返回</Button></div>{error&&<><p role="alert">{error}</p><Button onClick={()=>setAttempt(value=>value+1)}>重新读取</Button></>}{access ? task?.taskKind.startsWith("development_") ? <DigitalPatternWorkspace key={id} selectedOnly initialTask={task} initialAccess={access}/> : <DigitalTasksPanel options={access} taskId={id} {...(task?.taskId===id?{initialTask:task}:{})} compact view={digitalTaskView(window.location.search)} /> : !error && <p role="status">正在读取原任务…</p>}</>;
}

/** Native detail consumers; no order/task list or creation state. */
export function DigitalProductionPage(){return <TodoReadBoundary><DigitalProductionPageContent/></TodoReadBoundary>;}
function DigitalProductionPageContent() {
  const route = digitalDetailRoute(window.location.search);
  let detail;
  switch (route.kind) {
    case "landing": detail = <LegacyLanding />; break;
    case "invalid": detail = <><Button onClick={() => void closeDetail()}>返回</Button><p role="alert">{route.message}</p></>; break;
    case "timeRequest": detail = <OrderTimeRequestPage key={`${route.id}:${route.version??'current'}`} requestId={route.id} originalVersion={route.version} onClose={()=>void closeDetail()}/>; break;
    case "timeOrder": detail = <OrderTimeRequestPage key={route.id} resource={{kind:'order',id:route.id}} onClose={()=>void closeDetail()}/>; break;
    case "timeSource": detail = <OrderTimeRequestPage key={route.id} resource={{kind:'source',id:route.id}} onClose={()=>void closeDetail()}/>; break;
    case "shortLead": detail = <ShortLeadWorkspace key={route.id} sourceId={route.id} onClose={()=>void closeDetail()}/>; break;
    case "closure": detail = new URLSearchParams(location.search).has('originalEvent')?
      <OrderHistoryOriginal orderId={route.id} domain="closure" onClose={()=>void closeDetail()}/>:
      <OrderClosurePanel orderId={route.id} onClose={() => void closeDetail()} />; break;
    case "factory": detail = new URLSearchParams(window.location.search).get('warehouseCraft')==='1'?
      <WarehouseCraftWork key={route.id} orderId={route.id} onClose={()=>void closeDetail()}/>:<FactoryFlowPanel orderId={route.id} onClose={() => void closeDetail()} />; break;
    case "materialSource":
    case "materialOrder": {
      const query=new URLSearchParams(window.location.search);
      detail = query.has('originalMaterial')||query.has('originalMaterialVersion')?
       <PreparationMaterialOriginal resource={{kind:route.kind==='materialSource'?'source':'order',id:route.id}} onClose={()=>void closeDetail()}/>:
       query.getAll('warehouseReceipt').length===1&&query.get('warehouseReceipt')==='1'?
        <WarehouseReceiptBatchPanel key={`${route.kind}:${route.id}`} resource={{kind:route.kind==='materialSource'?'source':'order',id:route.id}}
         onClose={()=>void closeDetail()}/>:
       <section aria-label="投面辅料办理"><Button variant="secondary" onClick={()=>void closeDetail()}>返回来源</Button>
        <ProductionReadinessPanel key={`${route.kind}:${route.id}`}
          resource={{kind:route.kind==='materialSource'?'source':'order',id:route.id}} focusKind="material_investment"/></section>;
      break;
    }
    case "bulk": detail = new URLSearchParams(location.search).has('originalEvent')?
      <OrderHistoryOriginal orderId={route.id} domain="bulk-preparation" onClose={()=>void closeDetail()}/>:
      <BulkPreparationPanel orderId={route.id} warehouseMaterials={new URLSearchParams(location.search).get('warehouseMaterials')==='1'}
       onClose={() => void closeDetail()} />; break;
    case "instruction":
    case "budget": detail = route.original?<ProductionOriginalReader key={`${route.kind}:${route.id}`} reference={{kind:route.kind,orderId:route.id,version:route.version!}} onClose={()=>void closeDetail()}/>:<OrderDocumentContainer key={`${route.kind}:${route.id}:${route.version}`} initial={{kind:route.kind,id:route.id,version:route.version}} onClose={() => void closeDetail()} />; break;
    case 'quotationSource':
    case 'quotationOrder': detail=<ProductionOriginalReader key={`${route.kind}:${route.id}`} reference={{kind:'quotation',resource:{kind:route.kind==='quotationSource'?'source':'order',id:route.id},quoteId:route.quoteId!,version:route.version!}} onClose={()=>void closeDetail()}/>;break;
    case "order": detail = <OrderDetail id={route.id} />; break;
    case "arrangement": detail = <DevelopmentArrangementPage sourceId={route.id} round={route.version} onClose={() => void closeDetail()} />; break;
    case "development": detail = readTechnicalOriginalSearch(window.location.search)!==undefined?
      <DevelopmentTechnicalOriginal key={route.id} sourceId={route.id} onClose={()=>void closeDetail()}/>:
      route.documentVersion===undefined?<OrderDocumentContainer key={`development:${route.id}:${route.version}`} initial={{kind:"development",id:route.id,version:route.version}} onClose={() => void closeDetail()} />:<DevelopmentOriginalReader key={route.id} sourceId={route.id} roundNumber={route.version!} documentVersion={route.documentVersion} onClose={()=>void closeDetail()}/>; break;
    case "task": detail = <TaskDetail key={route.id} id={route.id} />; break;
  }
  return <div className="pattern-orders digital-production"><CurrentProductionReturn/>{route.kind!=="landing"&&route.kind!=="invalid"&&route.kind!=='timeRequest'&&<AcceptanceClockPanel resourceId={route.id}/>}{detail}</div>;
}
