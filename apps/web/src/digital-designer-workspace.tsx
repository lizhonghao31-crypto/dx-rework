import {CockpitRetryUpdates} from './cockpit-retry-updates.js';
import {useDevelopmentCreationDraft} from './use-development-creation-draft.js';
import {registerSessionInvalidator} from './auth-session.js';
import {useLiveSearch} from "./use-live-search.js";
import { SearchableSelect } from "./search-select.js";
import {DevelopmentOrderArchive} from "./development-order-archive.js";
import "./digital-kpi-density.css";
import { NavigationIcon } from "./navigation-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button,Surface } from "@dx-rework/ui";
import { BusinessTable, FilterBar, KpiCard, Pagination, StatusBadge } from "@dx-rework/ui/production";
import { DEVELOPMENT_VIEWS, DevelopmentWorkspaceFilterSchema, type DevelopmentWorkspaceFilter, type DevelopmentWorkspaceItem, type DevelopmentWorkspaceResult } from "@dx-rework/contracts/digital-development-workspace";
import type { DigitalCustomer, DigitalOrder } from "@dx-rework/contracts/digital-production";
import type { DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { digitalRequest } from "./digital-production-api.js";
import {OrderDocumentContainer} from "./order-document-container.js";
import { DevelopmentCreateForm, type DevelopmentCreateIntent } from "./digital-development-create-form.js";
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { navigateInternalPage } from "./internal-navigation.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development-workspace.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
const date = (value: string | null | undefined) => !value ? "未登记" : /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(value).toLocaleDateString("sv-SE", {timeZone:"Asia/Shanghai"});
const viewLabel = (item: DevelopmentWorkspaceItem) => DEVELOPMENT_VIEWS.find(view => view.key === item.view)?.label;
function initialFilter(): DevelopmentWorkspaceFilter {
  const parsed = DevelopmentWorkspaceFilterSchema.safeParse(Object.fromEntries([...new URLSearchParams(window.location.search)].filter(([key]) => ["page", "search", "customer", "view", "designer", "startDate", "endDate"].includes(key))));
  return parsed.success ? parsed.data : DevelopmentWorkspaceFilterSchema.parse({});
}
function StyleImage({item}: {item: DevelopmentWorkspaceItem}) {
  const [failed, setFailed] = useState(false);
  const image = item.journey.styleImageUrl;
  return image && !failed ? <img loading="lazy" decoding="async" className="development-style-image" alt={`${item.journey.designStyleNo} 款图`} src={urls.apiUrl(image.replace(/^\/api\//,''))} onError={() => setFailed(true)}/> : <span className="development-style-placeholder">{failed ? "款图不可用" : "暂无款图"}</span>;
}
export function DigitalDesignerWorkspace() {
  const [filter, setFilter] = useState(initialFilter), [result, setResult] = useState<DevelopmentWorkspaceResult | null>(null);
  const [options, setOptions] = useState<{independentCraftsEnabled?:boolean;orderTimeEnabled?:boolean;creationEnabled: boolean; customers: DigitalCustomer[]; minimumInitialCustomerDate?:string;serverToday?:string} | null>(null), [access, setAccess] = useState<DigitalAccessOptions | null>(null);
  const [intent, setIntent] = useState<DevelopmentCreateIntent | null>(null), [confirm, setConfirm] = useState<DevelopmentWorkspaceItem | null>(null);
  const creation=useDevelopmentCreationDraft();
  const [creationMessage,setCreationMessage]=useState(''),[creationBusy,setCreationBusy]=useState(false);
  const [confirmSheet,setConfirmSheet]=useState<DevelopmentSheet|undefined>(),[preparingConfirm,setPreparingConfirm]=useState(false),[confirmError,setConfirmError]=useState("");
  const [confirmedOrderId,setConfirmedOrderId]=useState<string|null>(null);
  const [confirmedOrder,setConfirmedOrder]=useState<DigitalOrder|null>(null),[confirmedOrderError,setConfirmedOrderError]=useState(""),[orderRetry,setOrderRetry]=useState(0);
  const preparing=useRef(false),detailLeaveCheck=useRef<(()=>Promise<boolean>)|null>(null);
  const rememberLeaveCheck=useCallback((check:(()=>Promise<boolean>)|null)=>{detailLeaveCheck.current=check;},[]);
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [sheets, setSheets] = useState<Record<string, DevelopmentSheet>>({}), [sheetErrors, setSheetErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("selected"));
  const [collapsed, setCollapsed] = useState(false), [search, setSearch] = useState(filter.search);
  const [orders,setOrders]=useState<Record<string,DigitalOrder>>({}),[orderErrors,setOrderErrors]=useState<Record<string,string>>({});
  const liveSearch=useLiveSearch(search,filter.search,value=>update({search:value}));
  const editor = new URLSearchParams(window.location.search).get("development");
  const round = Number(new URLSearchParams(window.location.search).get("round")) || undefined;
  const contextUrl = (parameters: Record<string, string> = {}, next = filter, selected = selectedId) => {
    const query = new URLSearchParams({workspace: "designer", ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)])), ...(selected ? {selected} : {}), ...parameters});
    return `${urls.pageUrl("ui/digital-production")}?${query}`;
  };
  useEffect(() => {
    let live=true;setConfirmedOrder(null);setConfirmedOrderError("");
    if(confirmedOrderId)void digitalRequest<DigitalOrder>(`orders/${confirmedOrderId}`).then(order=>{if(live)setConfirmedOrder(order);}).catch(reason=>{if(live)setConfirmedOrderError(reason.message);});
    return()=>{live=false;};
  },[confirmedOrderId,orderRetry]);
  useEffect(() => {
    let live = true; const abort=new AbortController();setError("");setResult(null);
    if(liveSearch.pending)return()=>{live=false;abort.abort();};
    const read={signal:abort.signal};
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    void Promise.all([digitalRequest<DevelopmentWorkspaceResult>(`workspaces/designer?${query}`,"GET",undefined,undefined,read), digitalRequest<typeof options>("options","GET",undefined,undefined,read), digitalRequest<DigitalAccessOptions>("access/options","GET",undefined,undefined,read)])
      .then(async([data, nextOptions, nextAccess]) => {if (live) {setResult(data);setOptions(nextOptions);setAccess(nextAccess);const restored=await creation.load(nextAccess,Boolean(nextOptions?.creationEnabled),editor);if(live&&restored)setIntent(restored);}}).catch(reason => {if (live) {setResult(null); setError(reason.message);}});
    return () => {live = false;abort.abort();};
  }, [filter, refresh,liveSearch.pending]);
  useEffect(()=>registerSessionInvalidator(()=>{creation.reset();setIntent(null);setConfirm(null);setConfirmSheet(undefined);setAccess(null);setOptions(null);setRefresh(value=>value+1);}),[]);
  useEffect(() => {
    let live = true; setSheets({}); setSheetErrors({});setOrders({});setOrderErrors({});
    const item = result?.items.find(value => editor ? value.journey.sourceId === editor : value.journey.id === selectedId);
    if (item?.journey.sourceId) {
      const source = item.journey.sourceId;
      void digitalRequest<DevelopmentSheet>(`sources/${source}/development${item.journey.sourceVersion && item.journey.selectedRound ? `?round=${item.journey.selectedRound}` : ""}`)
        .then(sheet => {if (live) setSheets(current => ({...current, [item.journey.id]:sheet}));})
        .catch(reason => {if (live) setSheetErrors(current => ({...current, [item.journey.id]:reason.message}));});
    }
    if(item?.journey.orderId){const id=item.journey.orderId;void digitalRequest<DigitalOrder>(`orders/${id}`).then(order=>{if(live)setOrders({[item.journey.id]:order});}).catch(reason=>{if(live)setOrderErrors({[item.journey.id]:reason.message});});}
    return () => {live = false;};
  }, [result, selectedId, editor]);
  const update = (patch: Partial<DevelopmentWorkspaceFilter>) => {
    const parsed = DevelopmentWorkspaceFilterSchema.safeParse({...filter, page: 1, ...patch});
    if (!parsed.success) {setError(parsed.error.issues[0]?.message ?? "筛选条件无效"); return;}
    const next = parsed.data;
    setFilter(next); setResult(null); setSelectedId(null); setCollapsed(false);
    window.history.replaceState(window.history.state, "", contextUrl({}, next, null));
  };
  const select = (id: string) => {setSelectedId(id); setCollapsed(false); window.history.replaceState(window.history.state, "", contextUrl({}, filter, id));};
  const selected = result?.items.find(item => item.journey.id === selectedId), sheet = selected ? sheets[selected.journey.id] : undefined;
  const openUrl = (item: DevelopmentWorkspaceItem) => contextUrl({development:item.journey.sourceId!, ...(item.journey.selectedRound && item.journey.sourceVersion ? {round:String(item.journey.selectedRound)} : {})}, filter, item.journey.id);
  const editorItem=result?.items.find(item=>item.journey.sourceId===editor),editorSheet=editorItem?sheets[editorItem.journey.id]:undefined;
  const canConfirm=Boolean(editorItem?.canConfirm&&!editorItem.journey.orderId&&editorSheet?.status==="published"&&!editorSheet.productionOrderId&&options?.creationEnabled&&access?.create&&!confirmedOrderId);
  const beginConfirmation=async()=>{
    if(preparing.current||!canConfirm||!editorItem||!editor)return;
    preparing.current=true;setPreparingConfirm(true);setConfirmError("");
    try{
      if(detailLeaveCheck.current&&!await detailLeaveCheck.current())return;
      // Read the selected round again before restoring its published, locked PO draft.
      const currentRound=new URLSearchParams(window.location.search).get("round");
      const current=await digitalRequest<DevelopmentSheet>(`sources/${editor}/development${currentRound?`?round=${encodeURIComponent(currentRound)}`:""}`);
      if(current.status!=="published"||current.productionOrderId){setRefresh(value=>value+1);throw new Error(current.productionOrderId?"此开发单已有客户订单，请核对最新关联订单。":"请先沿原流程发布开发单，再确认客户订单。");}
      setConfirmSheet(current);setConfirm(editorItem);setIntent("confirm_order");
    }catch(reason){setConfirmError(reason instanceof Error?reason.message:"订购资料读取失败，请重试；开发资料仍保留。");}
    finally{preparing.current=false;setPreparingConfirm(false);}
  };
  if(intent&&options&&!confirm&&['pending','conflict','complete'].includes(creation.mode)){
    const record=creation.restored;
    return <Surface className="development-workspace"><h1>{creation.mode==='pending'?'原创建提交结果待核对':'本页原开发资料保留'}</h1><p>款号：{record?.snapshot.form.designStyleNo||'未填写'} · 客户：{record?.snapshot.form.customerCode||'未填写'}。完整原输入仍保留，尚未开始新的提交。</p>{record?.snapshot.form.lines.map((line,index)=><p key={index}>原PO {index+1} · {line.formalPoNo||line.poNumber||'未填写'} · {line.color} · {line.sizes.map(size=>`${size.size} ${size.quantity}`).join(' / ')}</p>)}{creation.problem&&<p role="alert">{creation.problem}</p>}{creationMessage&&<p role="status">{creationMessage}</p>}
      {creation.mode==='pending'&&record?.phase==='pending'&&(record.native?<Button type="button" disabled={creationBusy} onClick={()=>{setCreationBusy(true);setCreationMessage('');void creation.check().then(result=>{if(result){setIntent(null);void navigateInternalPage(contextUrl({development:result.sourceId}));}}).catch(reason=>setCreationMessage(reason instanceof Error?reason.message:'原提交尚未核实，原资料仍保留')).finally(()=>setCreationBusy(false));}}>只读核对原提交结果</Button>:<p>该原创建或保存步骤尚无受支持的只读终态入口；原实际标识及输入保留。不能把它当成新草稿再提交，请先核对权威终态。</p>)}
      <Button type="button" disabled={creationBusy} onClick={()=>{try{creation.close();setIntent(null);}catch(reason){setCreationMessage(reason instanceof Error?reason.message:'原恢复记录尚未保留');}}}>返回列表并保留资料</Button>
    </Surface>;
  }
  if (intent && options) return <div className="development-workspace development-golden dx-production-refined development-create-page">
    <div className="development-breadcrumb">产品开发 › <strong>{confirm?"客户确定订单":"新建开发订单"}</strong></div>
    {creation.problem&&!confirm&&<p role="alert">{creation.problem} <Button type="button" onClick={()=>{try{creation.retry();}catch(reason){setCreationMessage(reason instanceof Error?reason.message:'本页记录仍未保留');}}}>重试保留本页资料</Button></p>}{creationMessage&&<p role="status">{creationMessage}</p>}
    <DevelopmentCreateForm key={confirm?.journey.id ?? creation.viewId??"new-development"} intent={intent} {...(confirm ? {source: confirm.journey,...(confirmSheet?{existingDraft:confirmSheet}:{}),cancelLabel:"返回开发单"} : {...(creation.sourceSheet?{existingDraft:creation.sourceSheet}:{}),...(creation.viewId&&access?{creation:{viewId:creation.viewId,actorId:access.actorId,snapshot:creation.restored?.snapshot,onSnapshot:creation.snapshot,started:creation.started,acknowledged:creation.acknowledged,refused:creation.refused}}:{})})} customers={options.customers} independentCraftsEnabled={options.independentCraftsEnabled} orderTimeEnabled={options.orderTimeEnabled} minimumDate={options.minimumInitialCustomerDate} serverToday={options.serverToday} onIntentChange={setIntent} onCancel={() => {if(!confirm)try{creation.close();}catch(reason){setCreationMessage(reason instanceof Error?reason.message:'原资料尚未保留');return;}setIntent(null); setConfirm(null); setConfirmSheet(undefined);if(!editor)setRefresh(value => value + 1);}} onCreated={(sourceId,orderId) => {
      if(!confirm)try{if(!creation.completed(sourceId,creation.viewId))return;}catch(reason){setCreationMessage('原办理已完成；本页恢复记录尚未清理。'+(reason instanceof Error?reason.message:''));return;}
      if(confirm&&editor===sourceId){setConfirmedOrderId(orderId);setIntent(null);setConfirm(null);setConfirmSheet(undefined);setRefresh(value=>value+1);}
      else void navigateInternalPage(contextUrl({development:sourceId}));
    }}/>
  </div>;
  if (editor) return <div className="development-workspace pattern-orders digital-production">
    {error&&<p role="alert">开发档案读取失败：{error} <Button onClick={()=>setRefresh(value=>value+1)}>重试读取开发档案</Button></p>}
    {confirmedOrderId&&<><p role="status">客户订单已确认。{confirmedOrder?`已读取关联订单：${confirmedOrder.designStyleNo}。`:!confirmedOrderError?"正在读取关联客户订单…":""} <a href={`${urls.pageUrl("ui/digital-production")}?order=${confirmedOrderId}&returnTo=${encodeURIComponent(window.location.pathname+window.location.search)}`}>查看关联客户订单</a></p>{confirmedOrderError&&<p role="alert">订单确认已成功，关联订单读取失败：{confirmedOrderError} <Button onClick={()=>setOrderRetry(value=>value+1)}>重试读取关联订单</Button></p>}</>}
    {confirmError&&<p role="alert">{confirmError}</p>}
    <OrderDocumentContainer key={`${editor}:${round}:${refresh}`} initial={{kind:"development",id:editor,version:round}} onLeaveCheck={rememberLeaveCheck} headerActions={canConfirm?<Button variant="primary" disabled={preparingConfirm} onClick={()=>void beginConfirmation()}>{preparingConfirm?"正在读取订购资料…":"客户确定订单"}</Button>:undefined} onClose={() => {void navigateInternalPage(contextUrl()).then(() => setRefresh(value => value + 1));}}/>
  </div>;
  return <div className="development-workspace development-golden dx-production-refined">

    <div className="development-breadcrumb">产品开发 › <strong>设计师创建订单</strong></div>{creation.problem&&<p role="alert">{creation.problem}</p>}{creationMessage&&<p role="status">{creationMessage}</p>}
    <section className="dx-production-panel development-list-panel">

      <FilterBar as="div"><label className="development-search-field">款号 / PO<input value={search} maxLength={100} onCompositionStart={liveSearch.onCompositionStart} onCompositionEnd={liveSearch.onCompositionEnd} placeholder="款号、款名或 PO" onChange={event => setSearch(event.target.value)} onKeyDown={event => {if (event.key === "Enter"&&!event.nativeEvent.isComposing) update({search});}}/></label><label>客户<SearchableSelect value={filter.customer ?? ""} onChange={event => update({customer:event.target.value || undefined})}><option value="">全部客户</option>{result?.customers.map(customer => <option key={customer}>{customer}</option>)}</SearchableSelect></label><label>设计师<SearchableSelect value={filter.designer ?? ""} onChange={event => update({designer:event.target.value || undefined})}><option value="">全部设计师</option>{result?.designers?.map(designer => <option key={designer}>{designer}</option>)}</SearchableSelect></label><label>状态<select value={filter.view} onChange={event => update({view:event.target.value as DevelopmentWorkspaceFilter['view']})}>{DEVELOPMENT_VIEWS.map(view => <option key={view.key} value={view.key}>{view.label}</option>)}</select></label><label className="development-date-field">创建日期<span className="development-date-input"><input aria-label="创建开始日期" type="date" value={filter.startDate ?? ""} onChange={event => update({startDate:event.target.value || undefined})}/><span aria-hidden="true">{filter.startDate ?? "开始日期"}</span></span><span className="development-date-separator">至</span><span className="development-date-input"><input aria-label="创建结束日期" type="date" value={filter.endDate ?? ""} onChange={event => update({endDate:event.target.value || undefined})}/><span aria-hidden="true">{filter.endDate ?? "结束日期"}</span></span></label>{options?.creationEnabled && access?.create && <Button className="development-create-action" variant="primary" onClick={() => {try{setIntent(creation.open());setConfirm(null);setCreationMessage("");}catch(reason){setCreationMessage(reason instanceof Error?reason.message:"本页创建资料尚未核实");}}}>新建开发订单</Button>}</FilterBar>
      {error && <p role="alert">{error}</p>}{result?.freshness&&<p role="status">部分订单信息尚未更新，数量暂不显示。<CockpitRetryUpdates ids={result.freshness.retryIds??[]} onUpdated={()=>setRefresh(value=>value+1)}/></p>}{result?.detailFailures?.length? <p role="status">{result.detailFailures.map(item=>item.designStyleNo).join("、")} 的详情读取失败。<Button onClick={()=>setRefresh(value=>value+1)}>重新读取本页</Button></p>:null}
      <>
      <div className="development-view-cards">{DEVELOPMENT_VIEWS.filter(view => view.key !== "all").map((view,index) => <KpiCard key={view.key} icon={<NavigationIcon name={(["FileText","History","Users","PackageCheck"] as const)[index]??"FileText"} />} className={`development-kpi development-kpi-${index}`} label={view.label} value={result?.counts?.[view.key] ?? "—"} detail={['待完善资料','正在开发','等待订购确认','已记录订购信息'][index]} selected={filter.view === view.key} onClick={() => update({view:filter.view === view.key ? 'all' : view.key})}/>)}</div>
      <div className="development-table-scroll development-list-viewport"><BusinessTable><thead><tr><th>序号</th><th>款图 / 款号</th><th>款名</th><th>客户</th><th>开发类型</th><th>当前轮次</th><th>状态</th><th>要求完成</th><th>创建日期</th><th>操作</th></tr></thead><tbody>{result?.items.map((item,index) => <tr key={item.journey.id} className={selectedId === item.journey.id ? 'is-selected' : ''}><td>{((result?.page??filter.page)-1)*15+index+1}</td><td><span className="development-row-select"><StyleImage key={`${item.journey.id}:${item.journey.sourceVersion}:${item.journey.selectedRound}:${item.journey.styleImageUrl}`} item={item}/><strong>{item.journey.designStyleNo}</strong></span></td><td>{item.journey.styleName ?? "未登记"}</td><td>{item.journey.customer ?? "通用开发"}</td><td>{item.journey.developmentType ?? "待完善"}</td><td>{item.journey.sourceVersion ? `第 ${item.journey.selectedRound ?? 1} 轮` : "待填写"}</td><td><StatusBadge tone={item.view === 'ordered' ? 'success' : item.view === 'draft' ? 'neutral' : 'info'}>{viewLabel(item)}</StatusBadge></td><td>{date(item.journey.requiredCompletionDate)}</td><td>{date(item.journey.createdAt)}</td><td>{item.journey.sourceId?<a className="development-text-action" id={`development-open-${item.journey.id}`} href={openUrl(item)} onClick={()=>{setSelectedId(item.journey.id);setCollapsed(false);}}>打开开发单</a>:<button className="development-text-action" onClick={() => select(item.journey.id)}>查看原档案</button>}</td></tr>)}</tbody></BusinessTable>
      {result && !result.freshness && !result.detailFailures?.length && !result.items.length && <p className="development-empty">当前视图暂无档案</p>}{!result && !error && <p role="status">正在读取开发档案…</p>}</div>
      {!result?.freshness&&<Pagination page={filter.page} pageSize={15} total={result?.total ?? null} onPage={page => update({page})}/>}
      </>
    </section>
    {!intent && selected && <section className="dx-production-panel development-selected" aria-label="选中开发档案">
      {!selected ? <p className="development-empty">从上方列表选择档案，查看开发资料与订购信息。</p> : <>
        <header className="development-selected-heading"><StyleImage key={`${selected.journey.id}:${selected.journey.sourceVersion}:${selected.journey.styleImageUrl}`} item={selected}/><div><h2>{selected.journey.designStyleNo} <StatusBadge tone="info">{viewLabel(selected)}</StatusBadge></h2><p>款名：{selected.journey.styleName ?? "未登记"} · 客户：{selected.journey.customer ?? "通用开发"} · 开发类型：{sheet?.developmentType ?? "未读取"} · 设计师：{selected.journey.designer ?? "未登记"} · 创建日期：{date(selected.journey.createdAt)}</p></div><button className="development-text-action" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? "展开" : "收起"}</button></header>
        {!collapsed&&<DevelopmentOrderArchive item={selected} sheet={sheet} order={orders[selected.journey.id]} sheetError={sheetErrors[selected.journey.id]} orderError={orderErrors[selected.journey.id]} sourceUrl={selected.journey.sourceId?openUrl(selected):null}/> }
      </>}
    </section>}
  </div>;
}
