import { SearchableSelect } from "./search-select.js";
import { PoDateSummary,PoDateDetails } from "./po-delivery-dates.js";
import "./digital-kpi-density.css";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useState } from "react";
import { Button } from "@dx-rework/ui";
import { BusinessTable, FilterBar, KpiCard, Pagination, StatusBadge } from "@dx-rework/ui/production";
import { DEVELOPMENT_VIEWS, DevelopmentWorkspaceFilterSchema, type DevelopmentWorkspaceFilter, type DevelopmentWorkspaceItem, type DevelopmentWorkspaceResult } from "@dx-rework/contracts/digital-development-workspace";
import type { DigitalCustomer } from "@dx-rework/contracts/digital-production";
import type { DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { digitalRequest } from "./digital-production-api.js";
import { DigitalDevelopmentPanel } from "./digital-development-panel.js";
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
  const [options, setOptions] = useState<{creationEnabled: boolean; customers: DigitalCustomer[]} | null>(null), [access, setAccess] = useState<DigitalAccessOptions | null>(null);
  const [intent, setIntent] = useState<DevelopmentCreateIntent | null>(null), [confirm, setConfirm] = useState<DevelopmentWorkspaceItem | null>(null);
  const [createMode, setCreateMode] = useState<"development" | "certain_order">("development");
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [sheets, setSheets] = useState<Record<string, DevelopmentSheet>>({}), [sheetErrors, setSheetErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("selected"));
  const [tab, setTab] = useState("基础资料"), [collapsed, setCollapsed] = useState(false), [search, setSearch] = useState(filter.search);
  const editor = new URLSearchParams(window.location.search).get("development");
  const round = Number(new URLSearchParams(window.location.search).get("round")) || undefined;
  const contextUrl = (parameters: Record<string, string> = {}, next = filter, selected = selectedId) => {
    const query = new URLSearchParams({workspace: "designer", ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)])), ...(selected ? {selected} : {}), ...parameters});
    return `${urls.pageUrl("ui/digital-production")}?${query}`;
  };
  useEffect(() => {
    let live = true; setError("");
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    void Promise.all([digitalRequest<DevelopmentWorkspaceResult>(`workspaces/designer?${query}`), digitalRequest<typeof options>("options"), digitalRequest<DigitalAccessOptions>("access/options")])
      .then(([data, nextOptions, nextAccess]) => {if (live) {setResult(data); setOptions(nextOptions); setAccess(nextAccess);}}).catch(reason => {if (live) {setResult(null); setError(reason.message);}});
    return () => {live = false;};
  }, [filter, refresh]);
  useEffect(() => {
    let live = true; setSheets({}); setSheetErrors({});
    const item = result?.items.find(value => value.journey.id === selectedId);
    if (item?.journey.sourceId) {
      const source = item.journey.sourceId;
      void digitalRequest<DevelopmentSheet>(`sources/${source}/development${item.journey.sourceVersion && item.journey.selectedRound ? `?round=${item.journey.selectedRound}` : ""}`)
        .then(sheet => {if (live) setSheets(current => ({...current, [item.journey.id]:sheet}));})
        .catch(reason => {if (live) setSheetErrors(current => ({...current, [item.journey.id]:reason.message}));});
    }
    return () => {live = false;};
  }, [result, selectedId]);
  const update = (patch: Partial<DevelopmentWorkspaceFilter>) => {
    const parsed = DevelopmentWorkspaceFilterSchema.safeParse({...filter, page: 1, ...patch});
    if (!parsed.success) {setError(parsed.error.issues[0]?.message ?? "筛选条件无效"); return;}
    const next = parsed.data;
    setFilter(next); setResult(null); setSelectedId(null); setCollapsed(false);
    window.history.replaceState(window.history.state, "", contextUrl({}, next, null));
  };
  const select = (id: string) => {setSelectedId(id); setCollapsed(false); setTab("基础资料"); window.history.replaceState(window.history.state, "", contextUrl({}, filter, id));};
  const selected = result?.items.find(item => item.journey.id === selectedId), sheet = selected ? sheets[selected.journey.id] : undefined;
  const openUrl = (item: DevelopmentWorkspaceItem) => contextUrl({development:item.journey.sourceId!, ...(item.journey.selectedRound && item.journey.sourceVersion ? {round:String(item.journey.selectedRound)} : {})}, filter, item.journey.id);
  if (editor) return <div className="development-workspace pattern-orders digital-production"><DigitalDevelopmentPanel sourceId={editor} {...(round ? {initialRound: round} : {})} onClose={() => {void navigateInternalPage(contextUrl()).then(() => setRefresh(value => value + 1));}}/></div>;
  if (intent && options) return <div className="development-workspace development-golden dx-production-refined development-create-page">
    <div className="development-breadcrumb">产品开发 › <strong>创建订单</strong></div>
    <DevelopmentCreateForm key={confirm?.journey.id ?? "new-development"} intent={intent} {...(confirm ? {source: confirm.journey} : {})} customers={options.customers} onIntentChange={setIntent} onCancel={() => {setIntent(null); setConfirm(null); setRefresh(value => value + 1);}} onCreated={sourceId => {void navigateInternalPage(contextUrl({development:sourceId}));}}/>
  </div>;
  return <div className="development-workspace development-golden dx-production-refined">
    <form className="development-global-search" onSubmit={event => {event.preventDefault(); update({search});}}><input aria-label="搜索开发档案" placeholder="搜索单号、客户、款号、PO…" value={search} onChange={event => setSearch(event.target.value)}/><Button type="submit">搜索</Button></form>
    <div className="development-breadcrumb">产品开发 › <strong>设计师创建订单</strong></div>
    <section className="dx-production-panel development-list-panel">
      <nav className="development-tabs" aria-label="创建类型">{([['development','产品开发（无确定订单）'],['certain_order','产品开发（有确定订单）']] as const).map(([key,label]) => <button key={key} type="button" aria-pressed={createMode === key} onClick={() => setCreateMode(key)}>{label}</button>)}</nav>
      <FilterBar as="div"><label className="development-search-field">款号 / PO<input value={search} maxLength={100} placeholder="款号、款名或 PO" onChange={event => setSearch(event.target.value)} onKeyDown={event => {if (event.key === "Enter") update({search});}}/></label><label>客户<SearchableSelect value={filter.customer ?? ""} onChange={event => update({customer:event.target.value || undefined})}><option value="">全部客户</option>{result?.customers.map(customer => <option key={customer}>{customer}</option>)}</SearchableSelect></label><label>设计师<SearchableSelect value={filter.designer ?? ""} onChange={event => update({designer:event.target.value || undefined})}><option value="">全部设计师</option>{result?.designers?.map(designer => <option key={designer}>{designer}</option>)}</SearchableSelect></label><label>状态<select value={filter.view} onChange={event => update({view:event.target.value as DevelopmentWorkspaceFilter['view']})}>{DEVELOPMENT_VIEWS.map(view => <option key={view.key} value={view.key}>{view.label}</option>)}</select></label><label className="development-date-field">创建日期<span className="development-date-input"><input aria-label="创建开始日期" type="date" value={filter.startDate ?? ""} onChange={event => update({startDate:event.target.value || undefined})}/><span aria-hidden="true">{filter.startDate ?? "开始日期"}</span></span><span className="development-date-separator">至</span><span className="development-date-input"><input aria-label="创建结束日期" type="date" value={filter.endDate ?? ""} onChange={event => update({endDate:event.target.value || undefined})}/><span aria-hidden="true">{filter.endDate ?? "结束日期"}</span></span></label><Button className="development-filter-apply" onClick={() => update({search})}>筛选</Button>{options?.creationEnabled && access?.create && <Button className="development-create-action" variant="primary" onClick={() => {setIntent(createMode); setConfirm(null);}}>新建开发单</Button>}</FilterBar>
      {error && <p role="alert">{error}</p>}
      {intent && options ? <DevelopmentCreateForm key={confirm?.journey.id ?? "new-development"} intent={intent} {...(confirm ? {source: confirm.journey} : {})} customers={options.customers} onIntentChange={setIntent} onCancel={() => {setIntent(null); setConfirm(null); setRefresh(value => value + 1);}} onCreated={id => {void navigateInternalPage(contextUrl({development:id},filter,id));}}/> : <>
      <div className="development-view-cards">{DEVELOPMENT_VIEWS.filter(view => view.key !== "all").map((view,index) => <KpiCard key={view.key} icon={<NavigationIcon name={(["FileText","History","Users","PackageCheck"] as const)[index]??"FileText"} />} className={`development-kpi development-kpi-${index}`} label={view.label} value={result?.counts[view.key] ?? "—"} detail={['待完善资料','正在开发','等待订购确认','已记录订购信息'][index]} selected={filter.view === view.key} onClick={() => update({view:filter.view === view.key ? 'all' : view.key})}/>)}</div>
      <div className="development-table-scroll development-list-viewport"><BusinessTable><thead><tr><th>序号</th><th>款图 / 款号</th><th>款名</th><th>客户</th><th>开发类型</th><th>当前轮次</th><th>状态</th><th>要求完成</th><th>创建日期</th><th>操作</th></tr></thead><tbody>{result?.items.map((item,index) => <tr key={item.journey.id} className={selectedId === item.journey.id ? 'is-selected' : ''}><td>{(filter.page-1)*20+index+1}</td><td><button className="development-row-select" aria-pressed={selectedId === item.journey.id} onClick={() => select(item.journey.id)}><StyleImage key={`${item.journey.id}:${item.journey.sourceVersion}:${item.journey.selectedRound}:${item.journey.styleImageUrl}`} item={item}/><strong>{item.journey.designStyleNo}</strong></button></td><td>{item.journey.styleName ?? "未登记"}</td><td>{item.journey.customer ?? "通用开发"}</td><td>{item.journey.developmentType ?? "待完善"}</td><td>{item.journey.sourceVersion ? `第 ${item.journey.selectedRound ?? 1} 轮` : "待填写"}</td><td><StatusBadge tone={item.view === 'ordered' ? 'success' : item.view === 'draft' ? 'neutral' : 'info'}>{viewLabel(item)}</StatusBadge></td><td>{date(item.journey.requiredCompletionDate)}</td><td>{date(item.journey.createdAt)}</td><td><button className="development-text-action" onClick={() => select(item.journey.id)}>查看</button></td></tr>)}</tbody></BusinessTable>
      {result && !result.items.length && <p className="development-empty">当前视图暂无档案</p>}{!result && !error && <p role="status">正在读取开发档案…</p>}</div>
      <Pagination page={filter.page} pageSize={20} total={result?.total ?? null} onPage={page => update({page})}/>
      </>}
    </section>
    {!intent && <section className="dx-production-panel development-selected" aria-label="选中开发档案">
      {!selected ? <p className="development-empty">从上方列表选择档案，查看开发资料与订购信息。</p> : <>
        <header className="development-selected-heading"><StyleImage key={`${selected.journey.id}:${selected.journey.sourceVersion}:${selected.journey.styleImageUrl}`} item={selected}/><div><h2>{selected.journey.designStyleNo} <StatusBadge tone="info">{viewLabel(selected)}</StatusBadge></h2><p>款名：{selected.journey.styleName ?? "未登记"} · 客户：{selected.journey.customer ?? "通用开发"} · 开发类型：{sheet?.developmentType ?? "未读取"} · 设计师：{selected.journey.designer ?? "未登记"} · 创建日期：{date(selected.journey.createdAt)}</p></div><button className="development-text-action" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? "展开" : "收起"}</button></header>
        {!collapsed && <><nav className="development-tabs" aria-label="档案资料">{['基础资料','开发资料','订购信息','版本记录'].map(label => <button key={label} aria-pressed={tab === label} onClick={() => setTab(label)}>{label}</button>)}</nav>
        {sheetErrors[selected.journey.id] && <p role="alert">开发资料读取失败：{sheetErrors[selected.journey.id]}</p>}
        <div className={`development-detail-columns ${tab !== '基础资料' ? 'is-single' : ''}`}>
          {tab === '基础资料' && <section><h3>基础资料</h3><dl className="development-fact-pairs"><div><dt>款号</dt><dd>{selected.journey.designStyleNo}</dd></div><div><dt>款名</dt><dd>{selected.journey.styleName ?? "未登记"}</dd></div><div><dt>客户</dt><dd>{selected.journey.customer ?? "通用开发"}</dd></div><div><dt>产品类别</dt><dd>{selected.journey.category ?? "未登记"}</dd></div><div><dt>设计师</dt><dd>{selected.journey.designer ?? "未登记"}</dd></div><div><dt>开发类型</dt><dd>{sheet?.developmentType ?? "未读取"}</dd></div><div className="is-wide"><dt>制作说明</dt><dd>{sheet?.document?.instructions || "未登记"}</dd></div></dl></section>}
          {['基础资料','开发资料'].includes(tab) && <section><h3>开发资料</h3><div className="development-column-body"><dl><dt>当前轮次</dt><dd>第 {selected.journey.selectedRound ?? 1} 轮</dd><dt>当前状态</dt><dd>{viewLabel(selected)}</dd><dt>要求完成</dt><dd>{date(sheet?.document?.returnDate)}</dd><dt>工艺 / 洗水</dt><dd>{sheet?.document ? `${sheet.document.craft} / ${sheet.document.washing}` : "未登记"}</dd><dt>面辅料</dt><dd>{sheet?.document?.materials.filter(item => item.requiredThisRound).map(item => `${item.category}：${item.name || item.label}`).join('；') || "未登记"}</dd></dl>{sheet?.document?.files.length ? <p className="development-attachment-summary">附件：{sheet.document.files.map(file => file.kind).join('、')}（在原单查看）</p> : null}</div>{selected.journey.sourceId && <a className="development-column-action" href={openUrl(selected)}>打开完整开发单 / 附件 / 打印</a>}</section>}
          {['基础资料','订购信息'].includes(tab) && <section><h3>订购信息</h3><PoDateDetails lines={selected.journey.poDeliveryDates}/><div className="development-column-body"><dl><dt>确定订单</dt><dd>{selected.journey.orderId ? "有" : "无"}</dd><dt>订购数量</dt><dd>{selected.journey.orderId ? selected.journey.lines.reduce((total,line) => total+line.orderedQuantity,0).toLocaleString() : "尚无确定订单"}</dd><dt>PO / 颜色</dt><dd>{selected.journey.lines.map(line => `${line.po ?? '未补号'} / ${line.color}`).join('；') || "未登记"}</dd><dt>PO 双交期</dt><dd><PoDateSummary lines={selected.journey.poDeliveryDates??[]}/></dd></dl></div><div className="development-column-action">{selected.canConfirm && options?.creationEnabled && access?.create && <Button variant="primary" onClick={() => {setConfirm(selected); setIntent('confirm_order');}}>客户确定订单</Button>}{selected.journey.orderId && <a href={`${urls.pageUrl('ui/digital-production')}?order=${selected.journey.orderId}&returnTo=${encodeURIComponent(contextUrl())}`}>查看完整订购信息</a>}</div></section>}
          {tab === '版本记录' && <section><h3>版本与采用轮次</h3><p>当前开发第 {selected.journey.selectedRound ?? 1} 轮 · {sheet?.version ? `版本 ${sheet.version}` : "资料尚未保存"}</p><p>{selected.journey.adoptedRound ? `大货采用第 ${selected.journey.adoptedRound} 轮` : "尚未登记大货采用轮次"}</p>{selected.journey.sourceId && <a href={openUrl(selected)}>查看完整版本历史 / 复版</a>}</section>}
        </div></>}
      </>}
    </section>}
  </div>;
}
