import {useLiveSearch} from "./use-live-search.js";
import { SearchableSelect } from "./search-select.js";
import {CockpitHome} from "./cockpit-home.js";
import "./digital-kpi-density.css";
import {CockpitDetail} from "./cockpit-detail.js";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@dx-rework/ui";
import { FilterBar, KpiCard, PageHeader } from "@dx-rework/ui/production";
import { JOURNEY_NODES, JOURNEY_STAGES, type JourneyResult, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { cockpitFilterPatch,journeyRiskLabels,journeyStateLabels,type CockpitContext } from "./digital-journey-cockpit-model.js";
import "./digital-journey-cockpit.css";

const kpis = [
  {key:"all",label:"全部订单",field:"all",tone:"info"},
  {key:"active",label:"进行中",field:"active",tone:"info"},
  {key:"not_started",label:"未启动",field:"notStarted",tone:"neutral"},
  {key:"due_soon",label:"临期",field:"dueSoon",tone:"warning"},
  {key:"overdue",label:"逾期",field:"overdue",tone:"danger"},
  {key:"completed",label:"整单已完成",field:"completed",tone:"success"},
] as const;

function CockpitFilters({ context, data, onChange, onSearchDraft }: { context: CockpitContext; data: JourneyResult | null; onChange: (patch: Partial<CockpitContext>) => void; onSearchDraft?:((value:string,pending:boolean)=>void)|undefined }) {
  const [more, setMore] = useState(Boolean(context.stage || context.node || context.state || context.risk || context.startDate || context.endDate));
  const [draft, setDraft] = useState(context),composing=useRef(false);
  useEffect(() => setDraft(current=>({...context,search:current.search.trim()===context.search?current.search:context.search})), [context]);
  const liveSearch=useLiveSearch(draft.search,context.search,search=>onChange({...draft,search,page:1}));
  useEffect(()=>onSearchDraft?.(draft.search,liveSearch.pending),[draft.search,liveSearch.pending,onSearchDraft]);
  const field = (key: keyof CockpitContext, value: string) => {const next={...draft,[key]:key==="search"?value:value||undefined};setDraft(next);if(key!=="search")onChange({...next,page:1});};
  return <FilterBar className={"journey-filters"+(more?" is-expanded":"")} onSubmit={event => { event.preventDefault(); if(!composing.current)onChange({ ...draft, page: 1 }); }}>
    <label className="journey-search">综合搜索<input maxLength={100} aria-label="综合搜索" placeholder="款号、款名、客户、PO、跟单" value={draft.search} onCompositionStart={()=>{composing.current=true;liveSearch.onCompositionStart();}} onCompositionEnd={()=>{composing.current=false;liveSearch.onCompositionEnd();}} onChange={event => field("search", event.target.value)} /></label>
    <label>客户<SearchableSelect aria-label="客户" value={draft.customer ?? ""} onChange={event => field("customer", event.target.value)}><option value="">全部客户</option>{data?.facets?.customers.map(value => <option key={value}>{value}</option>)}</SearchableSelect></label>
    <label>跟单<SearchableSelect aria-label="跟单" value={draft.merchandiserId ?? ""} onChange={event => field("merchandiserId", event.target.value)}><option value="">主 / 第二跟单</option>{data?.facets?.merchandisers.map(person => <option value={person.id} key={person.id}>{person.name ?? person.id}</option>)}</SearchableSelect></label>
    <label className={"journey-category-filter"+(context.category?" is-applied":"")}>品类 / 款式<SearchableSelect aria-label="品类 / 款式" value={draft.category ?? ""} onChange={event => field("category", event.target.value)}><option value="">全部品类</option>{data?.facets?.categories.map(value => <option key={value}>{value}</option>)}</SearchableSelect></label>
      <label>阶段<select aria-label="大流程" value={draft.stage ?? ""} onChange={event => field("stage", event.target.value)}><option value="">全流程</option>{JOURNEY_STAGES.map(stage => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label>
    <div className="journey-filter-actions"><Button type="button" variant="secondary" onClick={() => setMore(!more)} aria-expanded={more}>更多筛选</Button>
    <Button type="button" variant="secondary" onClick={() => onChange({ page: 1, search: "", kpi: "all", customer: undefined, merchandiserId: undefined, category: undefined, stage: undefined, node: undefined, state: undefined, risk: undefined, startDate: undefined, endDate: undefined, missing:undefined })}>重置筛选</Button></div>
    {more && <div className="journey-more-filters">
      <label>小流程<SearchableSelect aria-label="小流程" value={draft.node ?? ""} onChange={event => field("node", event.target.value)}><option value="">全部节点</option>{JOURNEY_NODES.map(node => <option key={node.key} value={node.key}>{node.label}</option>)}</SearchableSelect></label>
      <label>业务状态<select aria-label="业务状态" value={draft.state ?? ""} onChange={event => field("state", event.target.value)}><option value="">全部状态</option>{Object.entries(journeyStateLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>风险<select aria-label="风险" value={draft.risk ?? ""} onChange={event => field("risk", event.target.value)}><option value="">全部风险</option>{Object.entries(journeyRiskLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>创建开始日期<input type="date" value={draft.startDate ?? ""} onChange={event => field("startDate", event.target.value)} /></label>
      <label>创建结束日期<input type="date" value={draft.endDate ?? ""} onChange={event => field("endDate", event.target.value)} /></label>
    </div>}
  </FilterBar>;
}
export function cockpitConditionsLabel(context:CockpitContext,data?:JourneyResult|null){
 const pieces=[context.scope==='development'?'纯开发未下单':'生产订单',context.search?`搜索“${context.search}”`:'全部搜索词',context.stage?JOURNEY_STAGES.find(stage=>stage.key===context.stage)?.label??'阶段待核':'全流程'];
 if(context.customer)pieces.push(`客户 ${context.customer}`);if(context.category)pieces.push(`品类 ${context.category}`);
 if(context.merchandiserId)pieces.push(`跟单 ${data?.facets?.merchandisers.find(person=>person.id===context.merchandiserId)?.name??'已指定（姓名未读取）'}`);
 if(context.node)pieces.push(JOURNEY_NODES.find(node=>node.key===context.node)?.label??'所选节点');if(context.state)pieces.push(journeyStateLabels[context.state]);if(context.risk)pieces.push(journeyRiskLabels[context.risk]);
 if(context.startDate||context.endDate)pieces.push(`创建日期 ${context.startDate??'不限'} 至 ${context.endDate??'不限'}`);if(context.kpi!=='all')pieces.push(kpis.find(kpi=>kpi.key===context.kpi)?.label??'受阻订单');if(context.missing)pieces.push('已应用原时效缺项筛选');pieces.push(`第${context.page}页`);return pieces.join('；');
}
type Props = { data: JourneyResult | null; error: string; detail: OrderJourney | null; detailError: string; detailLoading: boolean; context: CockpitContext; appliedContext?:CockpitContext|null;readPhase?:string;searchDraft?:{value:string;pending:boolean};onSearchDraft?:((value:string,pending:boolean)=>void)|undefined;onChange: (patch: Partial<CockpitContext>, preserveSelection?: boolean) => void; actions: ReactNode;onPlanCommitted?:(()=>void)|undefined;restoreReading?:boolean };
export function DigitalJourneyCockpit({ data, error, detail, detailError, detailLoading, context, appliedContext,readPhase,searchDraft,onSearchDraft,onChange,actions,onPlanCommitted,restoreReading=false }: Props) {
 if(context.selected)return <div className="digital-journey-cockpit dx-production-refined" data-view="order" aria-busy={detailLoading}>{detail?<>{detailLoading&&<p role="status">正在重新读取；以下仍是上次数据时点的资料。</p>}{detailError&&<p role="alert">刷新失败：{detailError}。仍显示上次读取资料，请重试刷新。</p>}<CockpitDetail key={detail.id} busy={detailLoading||Boolean(detailError)} order={detail} asOf={detail.asOf??data?.asOf} context={{...context,selected:detail.id}} onChange={patch=>onChange(patch,true)} actions={actions} onPlanCommitted={onPlanCommitted} restoreReading={restoreReading}/></>:<section className="dx-production-panel"><button className="journey-text-action" onClick={()=>onChange({selected:undefined},true)}>‹ 返回订单总览</button>{detailError?<p role="alert">{detailError}</p>:<p role="status">正在读取订单全景…</p>}{actions}</section>}</div>;
 const actual=appliedContext??context,applyResult=(patch:Partial<CockpitContext>,preserve=false)=>onChange({...cockpitFilterPatch(actual),...patch},preserve),pending=Boolean(searchDraft?.pending)||['preparing','loading'].includes(readPhase??'');
 const coverageNames={customer_date:'有PO未填客户出货日，整单交期只含已填PO',factory_date:'有PO未填工厂交货日',fabric_date:'预计到布日未登记',cutting_time:'缺可信实际收布时间，裁床24小时暂不能精确评价',scope:'仅有岗位节点权限，整单SLA未统计',plan:'未采用首版SLA计划，沿原任务截止监督',fact_time:'已授权事实时间矛盾，部分节点暂不能评价'};
 return <div className="digital-journey-cockpit dx-production-refined" data-view="overview" aria-busy={pending||readPhase==='identity'}><PageHeader title="生产管理座舱" actions={actions}/>
  <div className="cockpit-scope-tabs" role="group" aria-label="订单范围"><button type="button" aria-pressed={(context.scope??'production')==='production'} onClick={()=>onChange({scope:'production',kpi:'all'})}>生产订单</button><button type="button" aria-pressed={context.scope==='development'} onClick={()=>onChange({scope:'development',kpi:'all'})}>纯开发未下单</button></div>
  <CockpitFilters context={context} data={data} onChange={onChange} onSearchDraft={onSearchDraft}/>
  {pending&&<p className="cockpit-read-status" role="status">{searchDraft?.pending||readPhase==='preparing'?'准备搜索…':'正在查找…'}{data&&' 暂时保留上次结果。'}</p>}{readPhase==='identity'&&<p role="status">正在核验当前身份…</p>}
  <section aria-label="整单业务状态与客户交期"><h2 className="cockpit-metric-heading">整单业务状态与客户交期</h2><div className="journey-kpis" aria-label="订单筛选 KPI">{kpis.map((kpi,index)=><KpiCard key={kpi.key} icon={<NavigationIcon name={(['List','Activity','Clock','TriangleAlert','TriangleAlert','CircleCheck'] as const)[index]??'List'}/>} label={kpi.label} value={data?.summary[kpi.field]??'—'} tone={kpi.tone} selected={actual.kpi===kpi.key} onClick={()=>applyResult({kpi:kpi.key,page:1})}/>)}</div></section>
  {data?.supervision&&data.supervision.coverage.length>0&&<details className="journey-stat-note" data-cockpit-disclosure="coverage"><summary>整单时效依据待核 · 查看具体缺项</summary>{data.supervision.coverage.map(item=><button type="button" className="journey-text-action" key={item.key} onClick={()=>applyResult({missing:item.key,kpi:'all',page:1})}>{item.orders} 单{coverageNames[item.key]}</button>)}{actual.missing&&<button type="button" className="journey-text-action" onClick={()=>applyResult({missing:undefined,page:1})}>清除缺项筛选</button>}</details>}
  {error&&<p role="alert">读取“{cockpitConditionsLabel(context,data)}”失败：{error}。{data?'仍显示上次读取的订单，可刷新重试。':''}</p>}
  <CockpitHome data={data} error={error} context={actual} onChange={applyResult}/>
 </div>;
}
