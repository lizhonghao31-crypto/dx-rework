import { useEffect, useMemo, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { WorkflowAnalysisResponseSchema, type WorkflowAnalysisResponse } from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
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

type Range = ReturnType<typeof initialRange>;
type LoadState = {kind:"loading"}|{kind:"ready";a:WorkflowAnalysisResponse;b:WorkflowAnalysisResponse}|{kind:"error";message:string};

function Info({meaning,formula,use,caveat}:{meaning:string;formula:string;use:string;caveat:string}) {
  return <span className="data-sandbox-info" tabIndex={0} aria-label="指标说明"><span aria-hidden="true">ⓘ</span><span className="data-sandbox-info__popover" role="tooltip"><b>指标含义</b>{meaning}<b>计算公式</b>{formula}<b>管理用途</b>{use}<b>注意事项</b>{caveat}</span></span>;
}
function Delta({a,b,lowerBetter=false,format=(value:number)=>formatBusinessDecimal(value)}:{a:number|null;b:number|null;lowerBetter?:boolean;format?:(value:number)=>string}) {
  if(a===null||b===null)return <small className="sandbox-delta is-neutral">对比期记录不足</small>;
  if(a===b)return <small className="sandbox-delta is-neutral">与对比期持平</small>;
  const up=a>b, good=lowerBetter?!up:up, change=b===0?null:Math.abs((a-b)/b*100);
  return <small className={`sandbox-delta ${good?"is-good":"is-bad"}`}>{up?"↑":"↓"} {change===null?`对比期 ${format(b)} → ${format(a)}`:`${change.toFixed(change>=10?0:1)}%`} </small>;
}
function Metric({title,value,compare,children,info}:{title:string;value:string;compare?:React.ReactNode;children?:React.ReactNode;info:React.ComponentProps<typeof Info>}) {
  return <Surface className="data-sandbox-metric"><header><span>{title}</span><Info {...info}/></header><strong>{value}</strong>{children}{compare}</Surface>;
}

export function ReworkDataSandboxPage() {
  const initial=useMemo(()=>{const query=new URLSearchParams(window.location.search),defaults=initialRange();return {aFrom:query.get("aFrom")??defaults.aFrom,aTo:query.get("aTo")??defaults.aTo,bFrom:query.get("bFrom")??defaults.bFrom,bTo:query.get("bTo")??defaults.bTo};},[]);
  const [range,setRange]=useState<Range>(initial),[q,setQ]=useState(""),[node,setNode]=useState(""),[page,setPage]=useState(1),[refresh,setRefresh]=useState(0);
  const [allowed,setAllowed]=useState<boolean|null>(null),[state,setState]=useState<LoadState>({kind:"loading"});
  useEffect(()=>{let live=true;void verifySession().then(session=>{if(live)setAllowed(session!=="denied"&&canReadWorkAnalysis("workflow",session.user));}).catch(()=>{if(live)setAllowed(false);});return()=>{live=false;};},[]);
  useEffect(()=>{if(!allowed)return;const controller=new AbortController();setState({kind:"loading"});
    const load=(from:string,to:string,nodeFilter:string,pageNo:number)=>{const params=new URLSearchParams({group:"rework",snapshot:"period_end",state:"waiting",from,to,q:q.trim(),node:nodeFilter,page:String(pageNo)});return fetch(apiUrl(`management/workflow-analysis?${params}`),{credentials:"include",cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error("数据沙盘读取失败");return WorkflowAnalysisResponseSchema.parse(await response.json());});};
    void Promise.all([load(range.aFrom,range.aTo,node,page),load(range.bFrom,range.bTo,"",1)]).then(([a,b])=>{if(!controller.signal.aborted)setState({kind:"ready",a,b});}).catch(error=>{if(!controller.signal.aborted)setState({kind:"error",message:error instanceof Error?error.message:"数据沙盘读取失败"});});return()=>controller.abort();
  },[allowed,range,q,node,page,refresh]);
  useEffect(()=>{const url=new URL(window.location.href);url.searchParams.set("view","sandbox");for(const [key,value] of Object.entries(range))url.searchParams.set(key,value);window.history.replaceState(window.history.state,"",url);},[range]);
  if(allowed===false)return <Shell active="返工单看板"><div className="data-sandbox"><Header title="返工数据沙盘" badge="无查看权限"/><ReworkModuleTabs active="sandbox"/><Surface>当前账号没有管理分析读取权限，返工办理权限不受影响。</Surface></div></Shell>;
  const ready=state.kind==="ready"?state:null;
  const a=ready?.a,b=ready?.b;
  const slowA=a?.nodeMetrics.find(item=>item.averageFlowSeconds!==null)??null,slowB=b?.nodeMetrics.find(item=>item.status===slowA?.status)??null;
  const nodes=a?.nodeMetrics??[];
  return <Shell active="返工单看板"><div className="data-sandbox">
    <Header title="返工数据沙盘" subtitle="看流转、找积压、追到原单；等待时间完整计入流程，不等于实际作业工时。" badge={a?`数据截至 ${new Date(a.asOf).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}`:"读取中"}/>
    <ReworkModuleTabs active="sandbox"/>
    <Surface className="data-sandbox-toolbar"><label>分析期间 A<span><input type="date" value={range.aFrom} onChange={e=>{setRange(value=>({...value,aFrom:e.target.value}));setPage(1);}}/>至<input type="date" value={range.aTo} onChange={e=>{setRange(value=>({...value,aTo:e.target.value}));setPage(1);}}/></span></label><label>对比期间 B<span><input type="date" value={range.bFrom} onChange={e=>setRange(value=>({...value,bFrom:e.target.value}))}/>至<input type="date" value={range.bTo} onChange={e=>setRange(value=>({...value,bTo:e.target.value}))}/></span></label><label>关键词<input value={q} placeholder="单号 / 款号" onChange={e=>{setQ(e.target.value);setPage(1);}}/></label><Button disabled={state.kind==="loading"} onClick={()=>setRefresh(value=>value+1)}>刷新</Button></Surface>
    {state.kind==="error"?<Surface className="data-sandbox-error"><p role="alert">{state.message}</p><Button onClick={()=>setRefresh(value=>value+1)}>重试</Button></Surface>:null}
    <div className="data-sandbox-metrics">
      <Metric title="本期流转" value={a?`进入 ${formatBusinessDecimal(a.enteredCount)} · 完成 ${formatBusinessDecimal(a.completedInRangeCount)}`:"—"} info={{meaning:"所选期间进入返工流程与首次完成返工业务的订单数量。",formula:"进入量按订单创建时间；完成量按首次进入 completed 的时间。",use:"判断业务流入与处理完成是否同步变化。",caveat:"两者不是同一批订单，不计算‘完成÷新增’完成率。"}}><span className="sandbox-pair">对比期：进入 {b?.enteredCount??"—"} · 完成 {b?.completedInRangeCount??"—"}</span></Metric>
      <Metric title="期末未完成" value={a?`${formatBusinessDecimal(a.openAtEndCount)} 单`:"—"} compare={a&&b?<Delta a={a.openAtEndCount} b={b.openAtEndCount} lowerBetter/>:undefined} info={{meaning:"截至分析期间结束时仍未首次完成的有效返工订单。",formula:"期末已进入流程且尚未首次 completed、cancelled 的订单数。",use:"查看积压是在增加还是消化。",caveat:"历史期末按真实节点事件还原，不使用今天状态倒推；缺节点历史不会伪造成积压。"}}/>
      <Metric title="平均流转时长" value={a?secondsText(a.averageCycleSeconds):"—"} compare={a&&b?<Delta a={a.averageCycleSeconds} b={b.averageCycleSeconds} lowerBetter format={secondsText}/>:undefined} info={{meaning:"本期首次完成订单从创建返工单到首次业务完成的平均经过时间。",formula:"本期首次完成订单完整流转秒数之和 ÷ 有完整记录的完成订单数。",use:"观察整体流程是不是变慢。",caveat:"包含等待、夜间和排队时间，不等于实际劳动工时。"}}/>
      <Metric title="流转最久环节" value={slowA?nodeName(slowA.status):"记录不足"} compare={slowA?<small className="sandbox-pair">A {secondsText(slowA.averageFlowSeconds)} · B {secondsText(slowB?.averageFlowSeconds??null)}</small>:undefined} info={{meaning:"所选期间已离开节点的业务中，平均流转时长最长的环节。",formula:"各节点离开时间－进入时间取平均后比较。",use:"快速定位最可能拖慢后续推进的环节。",caveat:"环节性质不同，不能仅凭绝对时长认定人员责任；需结合积压与原单核查。"}}/>
    </div>
    <Surface className="data-sandbox-section"><div className="data-sandbox-section__title"><div><h2>节点流转与积压</h2><p>平均时长看已办完的节点，期末未完成和最长停留看还没办完的事项。</p></div>{node?<Button variant="secondary" onClick={()=>{setNode("");setPage(1);}}>清除节点筛选</Button>:null}</div>
      <div className="data-sandbox-table-wrap"><table><thead><tr><th>环节</th><th>A 平均流转</th><th>B 平均流转</th><th>变化</th><th>A 期末未完成</th><th>最长已停留</th><th>样本</th><th></th></tr></thead><tbody>{nodes.map(item=>{const prior=b?.nodeMetrics.find(candidate=>candidate.status===item.status);return <tr key={item.status} className={node===item.status?"is-selected":""}><td><b>{nodeName(item.status)}</b></td><td>{secondsText(item.averageFlowSeconds)}</td><td>{secondsText(prior?.averageFlowSeconds??null)}</td><td><Delta a={item.averageFlowSeconds} b={prior?.averageFlowSeconds??null} lowerBetter format={secondsText}/></td><td>{formatBusinessDecimal(item.openCount)}</td><td>{secondsText(item.longestOpenSeconds)}</td><td>{formatBusinessDecimal(item.flowCount)}</td><td><Button variant="secondary" onClick={()=>{setNode(item.status);setPage(1);}}>查看事项</Button></td></tr>;})}</tbody></table></div>{a&&!nodes.length?<p>当前期间没有可计算的节点流转记录。</p>:null}
    </Surface>
    <Surface className="data-sandbox-section"><div className="data-sandbox-section__title"><div><h2>{node?`${nodeName(node)} · 期末未完成事项`:"期末未完成事项"}</h2><p>点击原单核查具体业务事实；历史快照只用于分析，不改变现在的办理状态。</p></div></div>
      {a?.items.length?<div className="data-sandbox-orders">{a.items.map(item=><a key={item.id} href={pageUrl(`ui/tasks/${item.id}`)}><strong>{item.styleNo||item.label}</strong><span>{item.label}{item.orderNo?` · ${item.orderNo}`:""}</span><b>{nodeName(item.status)}</b><small>已停留 {item.enteredAt?secondsText(Math.max(0,(Math.min(Date.parse(`${range.aTo}T00:00:00+08:00`)+86400000,Date.parse(a.asOf))-Date.parse(item.enteredAt))/1000)):"记录不足"}</small></a>)}</div>:<p>当前筛选没有期末未完成事项。</p>}
      {a?<ListPagination page={a.filters.page} totalPages={Math.max(1,Math.ceil(a.total/15))} busy={state.kind==="loading"} ariaLabel="返工数据沙盘分页" onPageChange={setPage}/>:null}
    </Surface>
  </div></Shell>;
}
