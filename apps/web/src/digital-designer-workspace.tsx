import {useLiveSearch} from "./use-live-search.js";
import { SearchableSelect } from "./search-select.js";
import {DevelopmentOrderArchive} from "./development-order-archive.js";
import "./digital-kpi-density.css";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useState } from "react";
import { Button } from "@dx-rework/ui";
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
  const [options, setOptions] = useState<{creationEnabled: boolean; customers: DigitalCustomer[]; minimumInitialCustomerDate?:string;serverToday?:string} | null>(null), [access, setAccess] = useState<DigitalAccessOptions | null>(null);
  const [intent, setIntent] = useState<DevelopmentCreateIntent | null>(null), [confirm, setConfirm] = useState<DevelopmentWorkspaceItem | null>(null);
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
    let live = true; const abort=new AbortController();setError("");setResult(null);
    if(liveSearch.pending)return()=>{live=false;abort.abort();};
    const read={signal:abort.signal};
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    void Promise.all([digitalRequest<DevelopmentWorkspaceResult>(`workspaces/designer?${query}`,"GET",undefined,undefined,read), digitalRequest<typeof options>("options","GET",undefined,undefined,read), digitalRequest<DigitalAccessOptions>("access/options","GET",undefined,undefined,read)])
      .then(([data, nextOptions, nextAccess]) => {if (live) {setResult(data); setOptions(nextOptions); setAccess(nextAccess);}}).catch(reason => {if (live) {setResult(null); setError(reason.message);}});
    return () => {live = false;abort.abort();};
  }, [filter, refresh,liveSearch.pending]);
  useEffect(() => {
    let live = true; setSheets({}); setSheetErrors({});setOrders({});setOrderErrors({});
    const item = result?.items.find(value => value.journey.id === selectedId);
    if (item?.journey.sourceId) {
      const source = item.journey.sourceId;
      void digitalRequest<DevelopmentSheet>(`sources/${source}/development${item.journey.sourceVersion && item.journey.selectedRound ? `?round=${item.journey.selectedRound}` : ""}`)
        .then(sheet => {if (live) setSheets(current => ({...current, [item.journey.id]:sheet}));})
        .catch(reason => {if (live) setSheetErrors(current => ({...current, [item.journey.id]:reason.message}));});
    }
    if(item?.journey.orderId){const id=item.journey.orderId;void digitalRequest<DigitalOrder>(`orders/${id}`).then(order=>{if(live)setOrders({[item.journey.id]:order});}).catch(reason=>{if(live)setOrderErrors({[item.journey.id]:reason.message});});}
    return () => {live = false;};
  }, [result, selectedId]);
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
  if (editor) return <div className="development-workspace pattern-orders digital-production"><OrderDocumentContainer key={`${editor}:${round}`} initial={{kind:"development",id:editor,version:round}} onClose={() => {void navigateInternalPage(contextUrl()).then(() => setRefresh(value => value + 1));}}/></div>;
  if (intent && options) return <div className="development-workspace development-golden dx-production-refined development-create-page">
    <div className="development-breadcrumb">产品开发 › <strong>新建开发订单</strong></div>
    <DevelopmentCreateForm key={confirm?.journey.id ?? "new-development"} intent={intent} {...(confirm ? {source: confirm.journey,...(sheets[confirm.journey.id]?.document?.customerOrderDraft?.withOrder?{existingDraft:sheets[confirm.journey.id]!}:{})} : {})} customers={options.customers} minimumDate={options.minimumInitialCustomerDate} serverToday={options.serverToday} onIntentChange={setIntent} onCancel={() => {setIntent(null); setConfirm(null); setRefresh(value => value + 1);}} onCreated={sourceId => {void navigateInternalPage(contextUrl({development:sourceId}));}}/>
  </div>;
  return <div className="development-workspace development-golden dx-production-refined">

    <div className="development-breadcrumb">产品开发 › <strong>设计师创建订单</strong></div>
    <section className="dx-production-panel development-list-panel">

      <FilterBar as="div"><label className="development-search-field">款号 / PO<input value={search} maxLength={100} onCompositionStart={liveSearch.onCompositionStart} onCompositionEnd={liveSearch.onCompositionEnd} placeholder="款号、款名或 PO" onChange={event => setSearch(event.target.value)} onKeyDown={event => {if (event.key === "Enter"&&!event.nativeEvent.isComposing) update({search});}}/></label><label>客户<SearchableSelect value={filter.customer ?? ""} onChange={event => update({customer:event.target.value || undefined})}><option value="">全部客户</option>{result?.customers.map(customer => <option key={customer}>{customer}</option>)}</SearchableSelect></label><label>设计师<SearchableSelect value={filter.designer ?? ""} onChange={event => update({designer:event.target.value || undefined})}><option value="">全部设计师</option>{result?.designers?.map(designer => <option key={designer}>{designer}</option>)}</SearchableSelect></label><label>状态<select value={filter.view} onChange={event => update({view:event.target.value as DevelopmentWorkspaceFilter['view']})}>{DEVELOPMENT_VIEWS.map(view => <option key={view.key} value={view.key}>{view.label}</option>)}</select></label><label className="development-date-field">创建日期<span className="development-date-input"><input aria-label="创建开始日期" type="date" value={filter.startDate ?? ""} onChange={event => update({startDate:event.target.value || undefined})}/><span aria-hidden="true">{filter.startDate ?? "开始日期"}</span></span><span className="development-date-separator">至</span><span className="development-date-input"><input aria-label="创建结束日期" type="date" value={filter.endDate ?? ""} onChange={event => update({endDate:event.target.value || undefined})}/><span aria-hidden="true">{filter.endDate ?? "结束日期"}</span></span></label>{options?.creationEnabled && access?.create && <Button className="development-create-action" variant="primary" onClick={() => {setIntent("development"); setConfirm(null);}}>新建开发订单</Button>}</FilterBar>
      {error && <p role="alert">{error}</p>}
      <>
      <div className="development-view-cards">{DEVELOPMENT_VIEWS.filter(view => view.key !== "all").map((view,index) => <KpiCard key={view.key} icon={<NavigationIcon name={(["FileText","History","Users","PackageCheck"] as const)[index]??"FileText"} />} className={`development-kpi development-kpi-${index}`} label={view.label} value={result?.counts[view.key] ?? "—"} detail={['待完善资料','正在开发','等待订购确认','已记录订购信息'][index]} selected={filter.view === view.key} onClick={() => update({view:filter.view === view.key ? 'all' : view.key})}/>)}</div>
      <div className="development-table-scroll development-list-viewport"><BusinessTable><thead><tr><th>序号</th><th>款图 / 款号</th><th>款名</th><th>客户</th><th>开发类型</th><th>当前轮次</th><th>状态</th><th>要求完成</th><th>创建日期</th><th>操作</th></tr></thead><tbody>{result?.items.map((item,index) => <tr key={item.journey.id} className={selectedId === item.journey.id ? 'is-selected' : ''}><td>{(filter.page-1)*15+index+1}</td><td><span className="development-row-select"><StyleImage key={`${item.journey.id}:${item.journey.sourceVersion}:${item.journey.selectedRound}:${item.journey.styleImageUrl}`} item={item}/><strong>{item.journey.designStyleNo}</strong></span></td><td>{item.journey.styleName ?? "未登记"}</td><td>{item.journey.customer ?? "通用开发"}</td><td>{item.journey.developmentType ?? "待完善"}</td><td>{item.journey.sourceVersion ? `第 ${item.journey.selectedRound ?? 1} 轮` : "待填写"}</td><td><StatusBadge tone={item.view === 'ordered' ? 'success' : item.view === 'draft' ? 'neutral' : 'info'}>{viewLabel(item)}</StatusBadge></td><td>{date(item.journey.requiredCompletionDate)}</td><td>{date(item.journey.createdAt)}</td><td>{item.journey.sourceId?<a className="development-text-action" id={`development-open-${item.journey.id}`} href={openUrl(item)} onClick={()=>{setSelectedId(item.journey.id);setCollapsed(false);}}>打开开发单</a>:<button className="development-text-action" onClick={() => select(item.journey.id)}>查看原档案</button>}</td></tr>)}</tbody></BusinessTable>
      {result && !result.items.length && <p className="development-empty">当前视图暂无档案</p>}{!result && !error && <p role="status">正在读取开发档案…</p>}</div>
      <Pagination page={filter.page} pageSize={15} total={result?.total ?? null} onPage={page => update({page})}/>
      </>
    </section>
    {!intent && selected && <section className="dx-production-panel development-selected" aria-label="选中开发档案">
      {!selected ? <p className="development-empty">从上方列表选择档案，查看开发资料与订购信息。</p> : <>
        <header className="development-selected-heading"><StyleImage key={`${selected.journey.id}:${selected.journey.sourceVersion}:${selected.journey.styleImageUrl}`} item={selected}/><div><h2>{selected.journey.designStyleNo} <StatusBadge tone="info">{viewLabel(selected)}</StatusBadge></h2><p>款名：{selected.journey.styleName ?? "未登记"} · 客户：{selected.journey.customer ?? "通用开发"} · 开发类型：{sheet?.developmentType ?? "未读取"} · 设计师：{selected.journey.designer ?? "未登记"} · 创建日期：{date(selected.journey.createdAt)}</p></div><button className="development-text-action" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? "展开" : "收起"}</button></header>
        {!collapsed&&<DevelopmentOrderArchive item={selected} sheet={sheet} order={orders[selected.journey.id]} sheetError={sheetErrors[selected.journey.id]} orderError={orderErrors[selected.journey.id]} sourceUrl={selected.journey.sourceId?openUrl(selected):null} canConfirm={Boolean(selected.canConfirm&&sheet?.status==="published"&&options?.creationEnabled&&access?.create)} onConfirm={()=>{setConfirm(selected);setIntent('confirm_order');}}/>}
      </>}
    </section>}
  </div>;
}
