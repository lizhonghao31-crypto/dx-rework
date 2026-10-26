import {useLiveSearch} from "./use-live-search.js";
import { SearchableSelect } from "./search-select.js";
import {CockpitHome} from "./cockpit-home.js";
import "./digital-kpi-density.css";
import {CockpitDetail} from "./cockpit-detail.js";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@dx-rework/ui";
import { FilterBar, KpiCard, PageHeader } from "@dx-rework/ui/production";
import { JOURNEY_NODES, JOURNEY_STAGES, type JourneyResult, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { journeyRiskLabels,journeyStateLabels,type CockpitContext } from "./digital-journey-cockpit-model.js";
import "./digital-journey-cockpit.css";

const kpis = [
  {key:"all",label:"全部订单",field:"all",tone:"info"},
  {key:"active",label:"进行中",field:"active",tone:"info"},
  {key:"not_started",label:"未启动",field:"notStarted",tone:"neutral"},
  {key:"due_soon",label:"临期",field:"dueSoon",tone:"warning"},
  {key:"overdue",label:"逾期",field:"overdue",tone:"danger"},
  {key:"completed",label:"整单已完成",field:"completed",tone:"success"},
] as const;

function CockpitFilters({ context, data, onChange }: { context: CockpitContext; data: JourneyResult | null; onChange: (patch: Partial<CockpitContext>) => void }) {
  const [more, setMore] = useState(Boolean(context.stage || context.node || context.state || context.risk || context.startDate || context.endDate));
  const [draft, setDraft] = useState(context);
  useEffect(() => setDraft(current=>({...context,search:current.search.trim()===context.search?current.search:context.search})), [context]);
  const liveSearch=useLiveSearch(draft.search,context.search,search=>onChange({...draft,search,page:1}));
  const field = (key: keyof CockpitContext, value: string) => {const next={...draft,[key]:key==="search"?value:value||undefined};setDraft(next);if(key!=="search")onChange({...next,page:1});};
  return <FilterBar className={"journey-filters"+(more?" is-expanded":"")} onSubmit={event => { event.preventDefault(); onChange({ ...draft, page: 1 }); }}>
    <label className="journey-search">综合搜索<input maxLength={100} aria-label="综合搜索" placeholder="款号、款名、客户、PO、跟单" value={draft.search} onCompositionStart={liveSearch.onCompositionStart} onCompositionEnd={liveSearch.onCompositionEnd} onChange={event => field("search", event.target.value)} /></label>
    <label>客户<SearchableSelect aria-label="客户" value={draft.customer ?? ""} onChange={event => field("customer", event.target.value)}><option value="">全部客户</option>{data?.facets?.customers.map(value => <option key={value}>{value}</option>)}</SearchableSelect></label>
    <label>跟单<SearchableSelect aria-label="跟单" value={draft.merchandiserId ?? ""} onChange={event => field("merchandiserId", event.target.value)}><option value="">主 / 第二跟单</option>{data?.facets?.merchandisers.map(person => <option value={person.id} key={person.id}>{person.name ?? person.id}</option>)}</SearchableSelect></label>
    <label className={"journey-category-filter"+(context.category?" is-applied":"")}>品类 / 款式<SearchableSelect aria-label="品类 / 款式" value={draft.category ?? ""} onChange={event => field("category", event.target.value)}><option value="">全部品类</option>{data?.facets?.categories.map(value => <option key={value}>{value}</option>)}</SearchableSelect></label>
    <div className="journey-filter-actions"><Button type="button" variant="secondary" onClick={() => setMore(!more)} aria-expanded={more}>更多筛选</Button>
    <Button type="button" variant="secondary" onClick={() => onChange({ page: 1, search: "", kpi: "all", customer: undefined, merchandiserId: undefined, category: undefined, stage: undefined, node: undefined, state: undefined, risk: undefined, startDate: undefined, endDate: undefined, missing:undefined })}>重置筛选</Button></div>
    {more && <div className="journey-more-filters">
      <label>大流程<select aria-label="大流程" value={draft.stage ?? ""} onChange={event => field("stage", event.target.value)}><option value="">全部流程</option>{JOURNEY_STAGES.map(stage => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label>
      <label>小流程<SearchableSelect aria-label="小流程" value={draft.node ?? ""} onChange={event => field("node", event.target.value)}><option value="">全部节点</option>{JOURNEY_NODES.map(node => <option key={node.key} value={node.key}>{node.label}</option>)}</SearchableSelect></label>
      <label>业务状态<select aria-label="业务状态" value={draft.state ?? ""} onChange={event => field("state", event.target.value)}><option value="">全部状态</option>{Object.entries(journeyStateLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>风险<select aria-label="风险" value={draft.risk ?? ""} onChange={event => field("risk", event.target.value)}><option value="">全部风险</option>{Object.entries(journeyRiskLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>创建开始日期<input type="date" value={draft.startDate ?? ""} onChange={event => field("startDate", event.target.value)} /></label>
      <label>创建结束日期<input type="date" value={draft.endDate ?? ""} onChange={event => field("endDate", event.target.value)} /></label>
    </div>}
  </FilterBar>;
}
type Props = { data: JourneyResult | null; error: string; detail: OrderJourney | null; detailError: string; detailLoading: boolean; context: CockpitContext; onChange: (patch: Partial<CockpitContext>, preserveSelection?: boolean) => void; actions: ReactNode };
export function DigitalJourneyCockpit({ data, error, detail, detailError, detailLoading, context, onChange, actions }: Props) {
  if (context.selected) return <div className="digital-journey-cockpit dx-production-refined" data-view="order" aria-busy={detailLoading}>{detail ? <>{detailError&&<p role="alert">刷新失败：{detailError}。仍显示上次读取资料。</p>}<CockpitDetail key={detail.id} busy={detailLoading||Boolean(detailError)} order={detail} asOf={detail.asOf??data?.asOf} context={{ ...context, selected: detail.id }} onChange={patch => onChange(patch, true)} actions={actions}/></> : <section className="dx-production-panel"><button className="journey-text-action" onClick={() => onChange({selected: undefined, expanded: undefined, focus: undefined, row: undefined, round: undefined}, true)}>‹ 返回订单总览</button>{detailError ? <p role="alert">{detailError}</p> : <p role="status">正在读取订单全景…</p>}</section>}</div>;
  return <div className="digital-journey-cockpit dx-production-refined" data-view="overview"><PageHeader title="生产管理座舱" actions={actions}/>
    <div className="cockpit-scope-tabs" role="group" aria-label="订单范围"><button type="button" aria-pressed={(context.scope??"production")==="production"} onClick={()=>onChange({scope:"production",kpi:"all"})}>生产订单{data?.scopeCounts?`（${data.scopeCounts.production}）`:""}</button><button type="button" aria-pressed={context.scope==="development"} onClick={()=>onChange({scope:"development",kpi:"all"})}>纯开发未下单{data?.scopeCounts?`（${data.scopeCounts.development}）`:""}</button></div>
    <section className="journey-kpis" aria-label="订单筛选 KPI">{kpis.map((kpi,index)=><KpiCard key={kpi.key} icon={<NavigationIcon name={(["List","Activity","Clock","TriangleAlert","TriangleAlert","CircleCheck"] as const)[index]??"List"}/>} label={kpi.label} value={data?.summary[kpi.field]??"—"} tone={kpi.tone} selected={context.kpi===kpi.key} onClick={()=>onChange({kpi:kpi.key})}/>)}</section>
    {data?.supervision&&<div className="journey-stat-note" aria-label="时效统计范围"><span>在办节点：{data.supervision.overdue} 单局部逾期，{data.supervision.dueSoon} 单临期</span>{data.supervision.coverage.length>0&&<details><summary>{data.supervision.coverage.map(item=>`${item.orders}单${({customer_date:"未填齐出货日",factory_date:"未填齐工厂交货日",fabric_date:"没填预计到布日",cutting_time:"缺可信收布时间",scope:"仅有岗位节点权限",plan:"无首版计划"})[item.key]}`).join("；")} · 查看</summary>{data.supervision.coverage.map(item=><button type="button" className="journey-text-action" key={item.key} onClick={()=>onChange({missing:item.key,kpi:"all",page:1})}>{item.orders} 单{({customer_date:"有PO没填客户出货日，整单交期统计只含已填PO",factory_date:"有PO没填工厂交货日，对应工厂交期未统计",fabric_date:"没填预计到布日，布料线预计未计入；其它节点照常统计",cutting_time:"缺可信实际收布时间，裁床24小时不能精确评价",scope:"仅有岗位节点权限，整单SLA未统计；已授权节点照常监督",plan:"无首版SLA计划，沿原任务截止监督"})[item.key]}</button>)}</details>}{context.missing&&<button type="button" className="journey-text-action" onClick={()=>onChange({missing:undefined,page:1})}>清除缺项筛选</button>}</div>}
    <CockpitFilters context={context} data={data} onChange={onChange}/>{error&&<p role="alert">{error}</p>}
    <CockpitHome data={data} error={error} context={context} onChange={onChange}/>
  </div>;
}
