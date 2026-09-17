import { useEffect, useMemo, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { WorkflowAnalysisResponseSchema, type WorkflowAnalysisResponse } from "@dx-rework/contracts";
import { ReportPreviewResponseSchema, type ReportPreviewResponse, type ReportType } from "@dx-rework/contracts/reporting";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { createWebUrls } from "../url-contract.js";
import { Header, Shell } from "./components.js";
import { verifySession } from "./auth.js";
import { canReadWorkAnalysis } from "./work-analysis-model.js";
import { ListPagination } from "./list-pagination.js";
import { reworkFlowNodes } from "./rework-flow-model.js";
import { ReworkModuleTabs } from "./rework-module-tabs.js";
import "./rework-data-sandbox.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const localDay = (value = new Date()) => new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(value);
const shiftDay = (day:string, offset:number) => localDay(new Date(Date.parse(`${day}T00:00:00+08:00`) + offset * 86400000));
const initialRange = () => { const to=localDay(), from=`${to.slice(0,8)}01`, days=Math.round((Date.parse(`${to}T00:00:00+08:00`)-Date.parse(`${from}T00:00:00+08:00`))/86400000)+1; const bTo=shiftDay(from,-1); return {aFrom:from,aTo:to,bFrom:shiftDay(bTo,-days+1),bTo}; };
const secondsText = (value:number|null) => value===null?"记录不足":value<3600?`${Math.max(1,Math.round(value/60))} 分钟`:value<86400?`${(value/3600).toFixed(value>=36000?0:1)} 小时`:`${(value/86400).toFixed(value>=864000?0:1)} 天`;
const nodeName = (status:string) => reworkFlowNodes[status]?.label ?? status;
const numberValue = (value:unknown) => { const parsed=Number(value); return Number.isFinite(parsed)?parsed:0; };
const textValue = (value:unknown) => value===null||value===undefined?"":String(value);

type Range = ReturnType<typeof initialRange>;
type LoadState = {kind:"loading"}|{kind:"ready";a:WorkflowAnalysisResponse;b:WorkflowAnalysisResponse}|{kind:"error";message:string};
type ProcessRow = {name:string;quantity:number;amount:number;orders:Set<string>};
type TopicPeriod = {quantity:ProcessRow[];cost:ProcessRow[];wageTotal:number|null;responsibility:{total:number;own:number;proposed:number;deducted:number;remaining:number}|null;truncated:boolean};
type TopicState = {kind:"loading"}|{kind:"ready";a:TopicPeriod;b:TopicPeriod;wageAllowed:boolean}|{kind:"error";message:string};

function Info({meaning,formula,use,caveat}:{meaning:string;formula:string;use:string;caveat:string}) {
  return <span className="data-sandbox-info" tabIndex={0} aria-label="指标说明"><span aria-hidden="true">ⓘ</span><span className="data-sandbox-info__popover" role="tooltip"><b>指标含义</b>{meaning}<b>计算公式</b>{formula}<b>管理用途</b>{use}<b>注意事项</b>{caveat}</span></span>;
}
function Delta({a,b,lowerBetter=false,neutral=false,format=(value:number)=>formatBusinessDecimal(value)}:{a:number|null;b:number|null;lowerBetter?:boolean;neutral?:boolean;format?:(value:number)=>string}) {
  if(a===null||b===null)return <small className="sandbox-delta is-neutral">对比期记录不足</small>;
  if(a===b)return <small className="sandbox-delta is-neutral">与对比期持平</small>;
  const up=a>b, good=lowerBetter?!up:up, change=b===0?null:Math.abs((a-b)/b*100);
  return <small className={`sandbox-delta ${neutral?"is-neutral":good?"is-good":"is-bad"}`}>{up?"↑":"↓"} {change===null?`对比期 ${format(b)} → ${format(a)}`:`${change.toFixed(change>=10?0:1)}%`} </small>;
}
function Metric({title,value,compare,children,info}:{title:string;value:string;compare?:React.ReactNode;children?:React.ReactNode;info:React.ComponentProps<typeof Info>}) {
  return <Surface className="data-sandbox-metric"><header><span>{title}</span><Info {...info}/></header><strong>{value}</strong>{children}{compare}</Surface>;
}

async function report(type:ReportType,from:string,to:string,q:string,signal:AbortSignal,page?:number) {
  const params=new URLSearchParams({from,to,limit:"500"});
  if(q.trim())params.set("q",q.trim());
  if(type==="wages"){params.set("wageSource","order_rework");if(page!==undefined)params.set("page",String(page));}
  const response=await fetch(apiUrl(`management/reports/${type}?${params}`),{credentials:"include",cache:"no-store",signal});
  if(response.status===403&&type==="wages")return null;
  if(!response.ok)throw new Error("返工专题分析读取失败");
  return ReportPreviewResponseSchema.parse(await response.json());
}
async function allWages(from:string,to:string,q:string,signal:AbortSignal):Promise<{head:ReportPreviewResponse;rows:ReportPreviewResponse["rows"]}|null>{
  const first=await report("wages",from,to,q,signal,1);if(!first)return null;
  const rows=[...first.rows],pages=first.pagination?.totalPages??1;
  for(let page=2;page<=pages;page++){const next=await report("wages",from,to,q,signal,page);if(next)rows.push(...next.rows);}
  return {head:first,rows};
}
function processRows(rows:ReportPreviewResponse["rows"]):{quantity:ProcessRow[];cost:ProcessRow[]}{
  const quantity=new Map<string,ProcessRow>(),cost=new Map<string,ProcessRow>();
  for(const row of rows){
    if(textValue(row.wageSource)!=="order_rework")continue;
    const name=textValue(row.processName)||"未命名工序",order=textValue(row.reworkOrderId)||textValue(row.orderNo);
    const costRow=cost.get(name)??{name,quantity:0,amount:0,orders:new Set<string>()};costRow.amount+=numberValue(row.wageAmount);if(order)costRow.orders.add(order);cost.set(name,costRow);
    if(textValue(row.assignmentMode)!=="individual"||row.quantity===null)continue;
    const quantityRow=quantity.get(name)??{name,quantity:0,amount:0,orders:new Set<string>()};quantityRow.quantity+=numberValue(row.quantity);if(order)quantityRow.orders.add(order);quantity.set(name,quantityRow);
  }
  const byQuantity=[...quantity.values()].sort((left,right)=>right.quantity-left.quantity||left.name.localeCompare(right.name,"zh-CN")).slice(0,10);
  const byCost=[...cost.values()].sort((left,right)=>right.amount-left.amount||left.name.localeCompare(right.name,"zh-CN")).slice(0,10);
  return {quantity:byQuantity,cost:byCost};
}
const totalOf=(reportValue:ReportPreviewResponse|null,key:string)=>reportValue?numberValue(reportValue.totals[key]):0;
async function topicPeriod(from:string,to:string,q:string,signal:AbortSignal):Promise<{period:TopicPeriod;wageAllowed:boolean}>{
  const [wages,responsibility,own,external]=await Promise.all([allWages(from,to,q,signal),report("responsibilities",from,to,q,signal),report("own_factory",from,to,q,signal),report("external_deductions",from,to,q,signal)]);
  const ranked=wages?processRows(wages.rows):{quantity:[],cost:[]};
  const truncated=Boolean(responsibility?.truncated||own?.truncated||external?.truncated);
  return {wageAllowed:wages!==null,period:{quantity:ranked.quantity,cost:ranked.cost,wageTotal:wages?numberValue(wages.head.totals.wageAmount):null,
    responsibility:truncated?null:{total:totalOf(responsibility,"amount"),own:totalOf(own,"amount"),proposed:totalOf(external,"proposedAmount"),deducted:totalOf(external,"actualAmount"),remaining:totalOf(external,"remainingAmount")},truncated}};
}

export function ReworkDataSandboxPage() {
  const initial=useMemo(()=>{const query=new URLSearchParams(window.location.search),defaults=initialRange();return {aFrom:query.get("aFrom")??defaults.aFrom,aTo:query.get("aTo")??defaults.aTo,bFrom:query.get("bFrom")??defaults.bFrom,bTo:query.get("bTo")??defaults.bTo};},[]);
  const [range,setRange]=useState<Range>(initial),[q,setQ]=useState(""),[node,setNode]=useState(""),[page,setPage]=useState(1),[refresh,setRefresh]=useState(0);
  const [allowed,setAllowed]=useState<boolean|null>(null),[state,setState]=useState<LoadState>({kind:"loading"}),[topics,setTopics]=useState<TopicState>({kind:"loading"});
  useEffect(()=>{let live=true;void verifySession().then(session=>{if(live)setAllowed(session!=="denied"&&canReadWorkAnalysis("workflow",session.user));}).catch(()=>{if(live)setAllowed(false);});return()=>{live=false;};},[]);
  useEffect(()=>{if(!allowed)return;const controller=new AbortController();setState({kind:"loading"});
    const load=(from:string,to:string,nodeFilter:string,pageNo:number)=>{const params=new URLSearchParams({group:"rework",snapshot:"period_end",from,to,q:q.trim(),node:nodeFilter,page:String(pageNo)});return fetch(apiUrl(`management/workflow-analysis?${params}`),{credentials:"include",cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error("数据沙盘读取失败");return WorkflowAnalysisResponseSchema.parse(await response.json());});};
    void Promise.all([load(range.aFrom,range.aTo,node,page),load(range.bFrom,range.bTo,"",1)]).then(([a,b])=>{if(!controller.signal.aborted)setState({kind:"ready",a,b});}).catch(error=>{if(!controller.signal.aborted)setState({kind:"error",message:error instanceof Error?error.message:"数据沙盘读取失败"});});return()=>controller.abort();
  },[allowed,range,q,node,page,refresh]);
  useEffect(()=>{if(!allowed)return;const controller=new AbortController();setTopics({kind:"loading"});void Promise.all([topicPeriod(range.aFrom,range.aTo,q,controller.signal),topicPeriod(range.bFrom,range.bTo,q,controller.signal)]).then(([a,b])=>{if(!controller.signal.aborted)setTopics({kind:"ready",a:a.period,b:b.period,wageAllowed:a.wageAllowed&&b.wageAllowed});}).catch(error=>{if(!controller.signal.aborted)setTopics({kind:"error",message:error instanceof Error?error.message:"返工专题分析读取失败"});});return()=>controller.abort();},[allowed,range,q,refresh]);
  useEffect(()=>{const url=new URL(window.location.href);url.searchParams.set("view","sandbox");for(const [key,value] of Object.entries(range))url.searchParams.set(key,value);window.history.replaceState(window.history.state,"",url);},[range]);
  if(allowed===false)return <Shell active="返工单看板"><div className="data-sandbox"><Header title="返工数据沙盘" badge="无查看权限"/><ReworkModuleTabs active="sandbox"/><Surface>当前账号没有管理分析读取权限，返工办理权限不受影响。</Surface></div></Shell>;
  const ready=state.kind==="ready"?state:null,topic=topics.kind==="ready"?topics:null;
  const a=ready?.a,b=ready?.b,topicA=topic?.a,topicB=topic?.b;
  const slowA=a?.nodeMetrics.find(item=>item.averageFlowSeconds!==null)??null,slowB=b?.nodeMetrics.find(item=>item.status===slowA?.status)??null;
  const nodes=a?.nodeMetrics??[],topQuantity=topicA?.quantity[0]??null,topCost=topicA?.cost[0]??null;
  const compareQuantity=topQuantity?topicB?.quantity.find(item=>item.name===topQuantity.name)??null:null,compareCost=topCost?topicB?.cost.find(item=>item.name===topCost.name)??null:null;
  const summaries:string[]=[];
  if(a&&b){const backlog=a.openAtEndCount-b.openAtEndCount;summaries.push(`期末未完成较对比期${backlog>0?`增加 ${backlog} 单`:backlog<0?`减少 ${Math.abs(backlog)} 单`:"持平"}。`);if(slowA)summaries.push(`${nodeName(slowA.status)}是A期平均流转最久环节（${secondsText(slowA.averageFlowSeconds)}），B期同环节为${secondsText(slowB?.averageFlowSeconds??null)}。`);summaries.push(`A期有往返 ${a.roundtripCount} 单，其中 2 次以上往返 ${a.repeatedCount} 单。`);}
  return <Shell active="返工单看板"><div className="data-sandbox">
    <Header title="返工数据沙盘" subtitle="看流转、找积压、追到原单；等待时间完整计入流程，不等于实际作业工时。" badge={a?`数据截至 ${new Date(a.asOf).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}`:"读取中"}/>
    <ReworkModuleTabs active="sandbox"/>
    <Surface className="data-sandbox-toolbar"><label>分析期间 A<span><input type="date" value={range.aFrom} onChange={e=>{setRange(value=>({...value,aFrom:e.target.value}));setPage(1);}}/>至<input type="date" value={range.aTo} onChange={e=>{setRange(value=>({...value,aTo:e.target.value}));setPage(1);}}/></span></label><label>对比期间 B<span><input type="date" value={range.bFrom} onChange={e=>setRange(value=>({...value,bFrom:e.target.value}))}/>至<input type="date" value={range.bTo} onChange={e=>setRange(value=>({...value,bTo:e.target.value}))}/></span></label><label>关键词<input value={q} placeholder="单号 / 款号" onChange={e=>{setQ(e.target.value);setPage(1);}}/></label><Button disabled={state.kind==="loading"||topics.kind==="loading"} onClick={()=>setRefresh(value=>value+1)}>刷新</Button></Surface>
    {state.kind==="error"?<Surface className="data-sandbox-error"><p role="alert">{state.message}</p><Button onClick={()=>setRefresh(value=>value+1)}>重试</Button></Surface>:null}
    {topics.kind==="error"?<Surface className="data-sandbox-error"><p role="alert">{topics.message}；流程分析仍可继续使用。</p><Button onClick={()=>setRefresh(value=>value+1)}>重试专题</Button></Surface>:null}
    <div className="data-sandbox-metrics">
      <Metric title="本期流转" value={a?`进入 ${formatBusinessDecimal(a.enteredCount)} · 完成 ${formatBusinessDecimal(a.completedInRangeCount)}`:"—"} info={{meaning:"所选期间进入返工流程与首次完成返工业务的订单数量。",formula:"进入量按订单创建时间；完成量按首次进入 completed 的时间。",use:"判断业务流入与处理完成是否同步变化。",caveat:"两者不是同一批订单，不计算‘完成÷新增’完成率。"}}><span className="sandbox-pair">对比期：进入 {b?.enteredCount??"—"} · 完成 {b?.completedInRangeCount??"—"}</span></Metric>
      <Metric title="期末未完成" value={a?`${formatBusinessDecimal(a.openAtEndCount)} 单`:"—"} compare={a&&b?<Delta a={a.openAtEndCount} b={b.openAtEndCount} lowerBetter/>:undefined} info={{meaning:"截至分析期间结束时仍未首次完成的有效返工订单。",formula:"期末已进入流程且尚未首次 completed、cancelled 的订单数。",use:"查看积压是在增加还是消化。",caveat:"历史期末按真实节点事件还原，不使用今天状态倒推。"}}/>
      <Metric title="平均流转时长" value={a?secondsText(a.averageCycleSeconds):"—"} compare={a&&b?<Delta a={a.averageCycleSeconds} b={b.averageCycleSeconds} lowerBetter format={secondsText}/>:undefined} info={{meaning:"本期首次完成订单从创建返工单到首次业务完成的平均经过时间。",formula:"本期首次完成订单完整流转秒数之和 ÷ 有完整记录的完成订单数。",use:"观察整体流程是不是变慢。",caveat:"包含等待、夜间和排队时间，不等于实际劳动工时。"}}/>
      <Metric title="流转最久环节" value={slowA?nodeName(slowA.status):"记录不足"} compare={slowA?<small className="sandbox-pair">A {secondsText(slowA.averageFlowSeconds)} · B {secondsText(slowB?.averageFlowSeconds??null)}</small>:undefined} info={{meaning:"所选期间已离开节点的业务中，平均流转时长最长的环节。",formula:"各节点离开时间－进入时间取平均后比较。",use:"快速定位最可能拖慢后续推进的环节。",caveat:"环节性质不同，不能仅凭绝对时长认定人员责任；需结合积压与原单核查。"}}/>
      <Metric title="工序件次最高" value={topQuantity?topQuantity.name:"记录不足"} compare={topQuantity?<small className="sandbox-pair">A {formatBusinessDecimal(topQuantity.quantity)} 件次 · B {compareQuantity?formatBusinessDecimal(compareQuantity.quantity):"无记录"}</small>:undefined} info={{meaning:"A期已生成工资明细的个人上数中，累计工序件次最高的工序。",formula:"按工序汇总个人计件工资明细中的有效数量；每位工人实际上数计为相应工序件次。",use:"找出返工作业量最集中的工序，结合涉及订单进一步排查质量改善重点。",caveat:"这是工序件次，不是去重衣服件数；旧集体计件不纳入件次排行。"}}/>
      <Metric title="工序费用最高" value={topCost?topCost.name:"记录不足"} compare={topCost?<small className="sandbox-pair">A {formatBusinessCurrency(topCost.amount)} · B {compareCost?formatBusinessCurrency(compareCost.amount):"无记录"}</small>:undefined} info={{meaning:"A期已记录返工工资中，金额最高的工序。",formula:"按工序汇总订单返工工资明细的当前有效工资金额。",use:"识别已记录返工人工费用最集中的工序。",caveat:"工资不是完整质量损失；没有工资查看权限时不展示。"}}/>
    </div>
    {summaries.length?<Surface className="data-sandbox-section data-sandbox-summary"><div className="data-sandbox-section__title"><div><h2>异常与变化摘要</h2><p>只陈述可核实变化，不自动认定人员或供应商责任。</p></div><Info meaning="根据A/B期间的积压、节点流转与往返事实自动生成的简短摘要。" formula="直接读取本页已展示指标，不使用隐藏评分或预测模型。" use="帮助管理层先找到值得核查的位置，再进入节点和原单验证。" caveat="摘要是定位线索，不是责任结论。"/></div><ol>{summaries.map(item=><li key={item}>{item}</li>)}</ol></Surface>:null}
    <Surface className="data-sandbox-section"><div className="data-sandbox-section__title"><div><h2>节点流转与积压</h2><p>平均时长看已办完的节点，期末未完成和最长停留看还没办完的事项。</p></div>{node?<Button variant="secondary" onClick={()=>{setNode("");setPage(1);}}>清除节点筛选</Button>:null}</div>
      <div className="data-sandbox-table-wrap"><table><thead><tr><th>环节</th><th>A 平均流转</th><th>B 平均流转</th><th>变化</th><th>A 期末未完成</th><th>最长已停留</th><th>样本</th><th></th></tr></thead><tbody>{nodes.map(item=>{const prior=b?.nodeMetrics.find(candidate=>candidate.status===item.status);return <tr key={item.status} className={node===item.status?"is-selected":""}><td><b>{nodeName(item.status)}</b></td><td>{secondsText(item.averageFlowSeconds)}</td><td>{secondsText(prior?.averageFlowSeconds??null)}</td><td><Delta a={item.averageFlowSeconds} b={prior?.averageFlowSeconds??null} lowerBetter format={secondsText}/></td><td>{formatBusinessDecimal(item.openCount)}</td><td>{secondsText(item.longestOpenSeconds)}</td><td>{formatBusinessDecimal(item.flowCount)}</td><td><button onClick={()=>{setNode(item.status);setPage(1);}}>查看事项</button></td></tr>;})}</tbody></table></div>{a&&!nodes.length?<p>当前期间没有可计算的节点流转记录。</p>:null}
    </Surface>
    <div className="data-sandbox-topic-grid">
      <Surface className="data-sandbox-section"><div className="data-sandbox-section__title"><div><h2>工序件次排行</h2><p>按已确认个人上数统计；数量和费用分开观察。</p></div><Info meaning="返工工序已确认个人上数的件次排行。" formula="个人计件工资明细数量按工序汇总；旧集体计件不纳入件次排行。" use="发现返工作业量集中在哪些工序。" caveat="同一件衣服经过多个工序会分别计次，因此不是去重衣服数。"/></div>{topic?.wageAllowed?<div className="data-sandbox-rank">{topicA?.quantity.map((item,index)=>{const prior=topicB?.quantity.find(candidate=>candidate.name===item.name);return <div key={item.name}><b>{index+1}. {item.name}</b><span>{formatBusinessDecimal(item.quantity)} 件次</span><small>B期 {prior?`${formatBusinessDecimal(prior.quantity)} 件次`:`无记录`} · 涉及 {item.orders.size} 单</small></div>;})}{!topicA?.quantity.length?<p>当前期间没有可用的个人计件数量记录。</p>:null}</div>:<p>当前角色无工资明细查看权限，本区不展示工序件次和费用，流程指标不受影响。</p>}</Surface>
      <Surface className="data-sandbox-section"><div className="data-sandbox-section__title"><div><h2>工序费用排行</h2><p>仅统计系统已记录返工工资，不等于完整质量损失。</p></div><Info meaning="按工序汇总的系统已记录返工工资。" formula="订单返工工资明细当前有效金额按工序汇总。" use="找到已记录人工费用最集中的工序。" caveat="不包含材料、报废、物流、客户退货等未在本工资账本记录的质量成本。"/></div>{topic?.wageAllowed?<div className="data-sandbox-rank">{topicA?.cost.map((item,index)=>{const prior=topicB?.cost.find(candidate=>candidate.name===item.name);return <div key={item.name}><b>{index+1}. {item.name}</b><span>{formatBusinessCurrency(item.amount)}</span><small>B期 {prior?formatBusinessCurrency(prior.amount):"无记录"} · 涉及 {item.orders.size} 单</small></div>;})}{!topicA?.cost.length?<p>当前期间没有已记录返工工资。</p>:null}</div>:<p>当前角色无工资明细查看权限。</p>}</Surface>
    </div>
    <Surface className="data-sandbox-section"><div className="data-sandbox-section__title"><div><h2>费用与责任结构</h2><p>各项分别展示，不能相加冒充“总损失”。</p></div><Info meaning="所选期间已记录返工工资、最终责任、本厂承担及外部扣款事实。" formula="工资按劳动完成日期；责任按最终责任版本确认日期；外部台账按案件建立日期，沿用现有报表口径。" use="观察返工人工费用及责任承担结构，并与对比期核对。" caveat="不同金额代表不同业务事实，不可直接相加；外部累计实扣会随后续扣款更新。报表超过500行时本区不提供可能失真的责任汇总。"/></div>
      {topicA?.truncated?<p>当前责任/扣款明细超过报表预览上限，本区暂不展示责任金额汇总，请进入财务报表核对完整数据。</p>:<div className="data-sandbox-financial"><div><small>已记录返工工资</small><strong>{topicA?.wageTotal===null||topicA?.wageTotal===undefined?"无权限":formatBusinessCurrency(topicA.wageTotal)}</strong><span>B期 {topicB?.wageTotal===null||topicB?.wageTotal===undefined?"—":formatBusinessCurrency(topicB.wageTotal)}</span></div><div><small>责任金额</small><strong>{topicA?.responsibility?formatBusinessCurrency(topicA.responsibility.total):"—"}</strong><span>B期 {topicB?.responsibility?formatBusinessCurrency(topicB.responsibility.total):"—"}</span></div><div><small>本厂承担</small><strong>{topicA?.responsibility?formatBusinessCurrency(topicA.responsibility.own):"—"}</strong><span>B期 {topicB?.responsibility?formatBusinessCurrency(topicB.responsibility.own):"—"}</span></div><div><small>外部拟扣</small><strong>{topicA?.responsibility?formatBusinessCurrency(topicA.responsibility.proposed):"—"}</strong><span>B期 {topicB?.responsibility?formatBusinessCurrency(topicB.responsibility.proposed):"—"}</span></div><div><small>累计实扣</small><strong>{topicA?.responsibility?formatBusinessCurrency(topicA.responsibility.deducted):"—"}</strong><span>B期 {topicB?.responsibility?formatBusinessCurrency(topicB.responsibility.deducted):"—"}</span></div><div><small>未扣差额</small><strong>{topicA?.responsibility?formatBusinessCurrency(topicA.responsibility.remaining):"—"}</strong><span>B期 {topicB?.responsibility?formatBusinessCurrency(topicB.responsibility.remaining):"—"}</span></div></div>}
    </Surface>
    <Surface className="data-sandbox-section"><div className="data-sandbox-section__title"><div><h2>{node?`${nodeName(node)} · 期末未完成事项`:"期末未完成事项"}</h2><p>点击原单核查具体业务事实；历史快照只用于分析，不改变现在的办理状态。</p></div></div>
      {a?.items.length?<div className="data-sandbox-orders">{a.items.map(item=><a key={item.id} href={pageUrl(`ui/tasks/${item.id}`)}><strong>{item.styleNo||item.label}</strong><span>{item.label}{item.orderNo?` · ${item.orderNo}`:""}</span><b>{nodeName(item.status)}</b><small>已停留 {item.enteredAt?secondsText(Math.max(0,(Math.min(Date.parse(`${range.aTo}T00:00:00+08:00`)+86400000,Date.parse(a.asOf))-Date.parse(item.enteredAt))/1000)):"记录不足"}</small></a>)}</div>:<p>当前筛选没有期末未完成事项。</p>}
      {a?<ListPagination page={a.filters.page} totalPages={Math.max(1,Math.ceil(a.total/15))} busy={state.kind==="loading"} ariaLabel="返工数据沙盘分页" onPageChange={setPage}/>:null}
    </Surface>
  </div></Shell>;
}
