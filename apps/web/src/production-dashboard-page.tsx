import { ProductionExclusionControls } from "./production-exclusion-controls.js";
import { NavigationIcon } from "./navigation-icons.js";
import { ProductionPilotControls, ProductionReceiptSummary } from "./production-closure-ui.js";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { ProductionDashboardSchema, ProductionDashboardDetailSchema, type ProductionDashboard, type ProductionDashboardItem } from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { Header, Shell } from "./components.js";
import { ListPagination } from "./list-pagination.js";
import { createWebUrls } from "../url-contract.js";
import { canMoveProductionEvents, changedDashboardOrders, progressLabels, progressText, productionEventText, productionStatusLabels } from "./production-dashboard-model.js";
import "./sourcing-workspace.css";
import "./production-dashboard-page.css";
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const number=(value:number)=>formatBusinessDecimal(value);
const timestamp=(value:string)=>new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
async function request<T>(path:string,schema:z.ZodType<T>) {
  const response=await fetch(apiUrl(`production-dashboard${path}`),{credentials:"include",cache:"no-store",headers:{accept:"application/json"}});
  const body=await response.json();if(!response.ok)throw new Error(body?.error?.message??"看板加载失败，请重试");return schema.parse(body);
}
export function ProductionProgressBars({item}:{item:ProductionDashboardItem}) {
  const p=item.progress;
  return <div className="production-dashboard__progress" data-state={p.progressState}>
    <div className="production-dashboard__progress-label"><span>生产进度{p.frozen?"（完成时）":""}</span><strong>{number(p.productionProgress)}%</strong></div>
    <progress max={100} value={p.productionProgress} aria-label="生产进度"/>
    <div className="production-dashboard__progress-label"><span>时间进度</span><strong>{p.timeProgress===null?(p.firstReportedOn?"交期未记录":"待首次上报"):`${number(p.timeProgress)}%`}</strong></div>
    {p.timeProgress!==null?<progress max={100} value={p.timeProgress} aria-label="时间进度"/>:null}
    <span className="production-dashboard__progress-state">{p.progressState==="normal"?"✓ ":p.attention?"⚠ ":""}{progressText(p)}</span>
  </div>;
}
export function ProductionDashboardPage({productionOrderId}:{productionOrderId?:string|undefined}) {
  const [data,setData]=useState<ProductionDashboard|null>(null),[detail,setDetail]=useState<z.infer<typeof ProductionDashboardDetailSchema>|null>(null);
  const [q,setQ]=useState(""),[supplier,setSupplier]=useState(""),[status,setStatus]=useState(""),[progressState,setProgressState]=useState("");
  const [page,setPage]=useState(1),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [changed,setChanged]=useState<string[]>([]),[paused,setPaused]=useState(false),[hovered,setHovered]=useState(false),[focused,setFocused]=useState(false),[reduced,setReduced]=useState(false);
  const sequence=useRef(0),last=useRef<ProductionDashboard|null>(null),belt=useRef<HTMLDivElement|null>(null);
  const load=async(manual=false)=>{
    const version=++sequence.current;setLoading(true);setError("");
    try{
      if(productionOrderId){const result=await request(`/${productionOrderId}`,ProductionDashboardDetailSchema);if(version===sequence.current){setDetail(result);
        const todo=new URLSearchParams(window.location.search).get("todo");
        if(todo){const response=await fetch(apiUrl(`production-closure/alerts/${encodeURIComponent(todo)}/read`),{method:"POST",credentials:"include"});
          if(!response.ok&&response.status!==404)throw new Error("生产待办已读状态保存失败，请刷新重试");
          window.dispatchEvent(new Event("dx-rework:todo-read"));}
      }}
      else{const params=new URLSearchParams({page:String(page)});if(q.trim())params.set("q",q.trim());if(supplier)params.set("supplierId",supplier);if(status)params.set("status",status);if(progressState)params.set("progressState",progressState);
        if(manual&&last.current)params.set("previousAsOf",last.current.asOf);
        const result=await request(`?${params}`,ProductionDashboardSchema);
        if(version===sequence.current){setChanged(manual&&last.current?changedDashboardOrders(last.current.items,result.items):[]);setData(result);last.current=result;}
      }
    }catch(e){if(version===sequence.current)setError(e instanceof Error?e.message:"加载失败");}finally{if(version===sequence.current)setLoading(false);}
  };
  // Only initial load, explicit filter/page changes and the refresh button request data.
  useEffect(()=>{const timer=setTimeout(()=>{void load();},q?250:0);return()=>{clearTimeout(timer);sequence.current++;};},[productionOrderId,page,q,supplier,status,progressState]);
  useEffect(()=>{if(!changed.length)return;const timer=setTimeout(()=>setChanged([]),1800);return()=>clearTimeout(timer);},[changed]);
  useEffect(()=>{const media=window.matchMedia("(prefers-reduced-motion: reduce)");const update=()=>setReduced(media.matches);update();media.addEventListener("change",update);return()=>media.removeEventListener("change",update);},[]);
  const moving=canMoveProductionEvents(data?.events.length??0,paused,hovered,focused,reduced);
  useEffect(()=>{
    if(!moving||!belt.current)return;
    let frame=0,previous=0;const tick=(now:number)=>{const node=belt.current;if(!node)return;
      if(previous){const maximum=node.scrollWidth-node.clientWidth;if(maximum>0)node.scrollLeft=node.scrollLeft>=maximum-1?0:node.scrollLeft+Math.min(now-previous,50)*0.02;}
      previous=now;frame=requestAnimationFrame(tick);
    };frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[moving,data?.asOf]);
  const asOf=data?.asOf??detail?.asOf;
  return <Shell active="实时看板"><main className="sourcing-workspace production-dashboard">
    <Header iconRoute="/ui/production-dashboard" title="实时看板" subtitle="生产数量与工作日进度，按实际记录判断。" badge="实时生产看板"/>
    <div className="production-dashboard__toolbar"><a href={pageUrl("ui/production-reporting")}><NavigationIcon route="/ui/production-reporting" />生产数据填报</a>{productionOrderId?<a href={pageUrl("ui/production-dashboard")}>返回实时看板</a>:null}
      <span>{asOf?`数据截至 ${new Date(asOf).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit"})}`:"正在读取数据"}</span>
      <Button variant="secondary" disabled={loading} onClick={()=>{void load(true);}}><span aria-hidden="true" className={loading?"production-dashboard__refreshing":""}>↻</span> {loading?"刷新中…":"刷新"}</Button>
    </div>
    <ProductionExclusionControls onExcluded={()=>{setData(null);setDetail(null);last.current=null;void load();}}/>
    {productionOrderId?<ProductionReceiptSummary productionOrderId={productionOrderId} refreshKey={detail?.asOf}/>:null}
    {error?<p role="alert" className="sourcing-delete-error">{error}</p>:null}
    {!data&&!detail&&loading?<p role="status">正在加载生产数据…</p>:null}
    {!productionOrderId?<>
      <ProductionPilotControls/>
      {data?<Surface className="sourcing-list-card"><div className="production-dashboard__toolbar" aria-label="生产运行状态">
        <strong>{data.counts.attention?`${number(data.counts.attention)} 单需关注`:"当前筛选无进度预警"}</strong><span>生产中 {number(data.counts.inProduction)}</span><span>生产完成 {number(data.counts.completed)}</span><span>已发货 {number(data.counts.shipped)}</span>
      </div></Surface>:null}
      {data?.events.length?<Surface className="sourcing-list-card"><div className="production-dashboard__toolbar"><strong>最近生产动态</strong>
        {data.events.length>=3?<Button variant="secondary" aria-pressed={paused} onClick={()=>setPaused(v=>!v)}>{paused?"继续滚动":"暂停滚动"}</Button>:null}</div>
        <div className="production-dashboard__events" ref={belt} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setFocused(false);}}>
          {data.events.map(event=><a className="production-dashboard__event" key={event.id} href={pageUrl(`ui/production-dashboard/${event.productionOrderId}`)}>
            <strong>{event.firstStyleNo} · {event.supplierName}</strong><span>{productionEventText(event)}{event.quantity===null?"":` ${number(event.quantity)} 件`}</span>
            <span>{event.kind==="progress_changed"?timestamp(event.recordedAt):event.businessDate}</span>
          </a>)}
        </div></Surface>:null}
      <Surface className="sourcing-list-card"><div className="sourcing-form-grid">
        <label>关键词<input value={q} maxLength={100} placeholder="款号或供应商" onChange={e=>{setQ(e.target.value);setPage(1);}}/></label>
        <label>供应商<select value={supplier} onChange={e=>{setSupplier(e.target.value);setPage(1);}}><option value="">全部负责供应商</option>{data?.suppliers.map(s=><option key={s.supplierId} value={s.supplierId}>{s.supplierName}</option>)}</select></label>
        <label>生产状态<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">全部状态</option>{Object.entries(productionStatusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>生产进度<select value={progressState} onChange={e=>{setProgressState(e.target.value);setPage(1);}}><option value="">全部进度</option>{Object.entries(progressLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      </div><div className="sourcing-order-list" aria-busy={loading}>
        {data?.items.map(item=><Surface className={`sourcing-order-card${changed.includes(item.order.productionOrderId)?" production-dashboard__changed":""}`} key={item.order.productionOrderId}>
          <a className="sourcing-order-card__main" href={pageUrl(`ui/production-dashboard/${item.order.productionOrderId}`)}>
            <div className="sourcing-order-card__heading"><div><strong>{item.order.firstStyleNo}</strong><span>{item.order.supplierName}</span></div><StatusBadge tone={item.order.status==="in_production"?"info":"success"}>{productionStatusLabels[item.order.status]}</StatusBadge></div>
            <dl><div><dt>{item.progress.frozen?"完成时产量":"累计产量"}</dt><dd>{number(item.progress.completedQuantity)} / {number(item.order.quantity)} 件</dd></div><div><dt>交货日期</dt><dd>{item.order.deliveryDate??"未记录"}</dd></div><div><dt>最后上报或修正</dt><dd>{item.progress.lastUpdatedAt?timestamp(item.progress.lastUpdatedAt):"待首次上报"}</dd></div></dl>
            <ProductionProgressBars item={item}/>{item.order.sourceCaseArchived?<span>原外发单已删除 · 生产记录保留</span>:null}
          </a></Surface>)}
        {data&&!data.items.length?<p>{data.totalCount?"本页暂无订单，请返回第一页。":"当前筛选暂无生产订单"}</p>:null}
      </div>{data?<ListPagination page={page} totalPages={Math.max(1,Math.ceil(data.totalCount/15))} onPageChange={setPage} busy={loading} ariaLabel="实时看板分页"/>:null}</Surface>
    </>:null}
    {detail?<>
      <Surface className="sourcing-list-card"><h2>{detail.detail.order.firstStyleNo} · {detail.detail.order.supplierName}</h2><p>{productionStatusLabels[detail.detail.order.status]} · 交货日期 {detail.detail.order.deliveryDate??"未记录"}</p>
        <ProductionProgressBars item={{order:detail.detail.order,progress:detail.progress}}/>
        <p>工艺：{detail.detail.order.processes.join("、")}</p>
        {detail.progress.frozen?<p>进度保留完成时事实；以下明细和历史保留后续修正。</p>:null}
        <div className="sourcing-order-list">{detail.detail.order.lines.map(line=><div key={line.position} className="production-dashboard__line"><strong>{line.position}. {line.styleNo} · {line.color??"未记录颜色"}</strong><span>{number(line.completedQuantity)} / {number(line.quantity)} 件</span></div>)}</div>
        {detail.detail.canReport||detail.detail.canCorrect?<a href={pageUrl(`ui/production-reporting/${productionOrderId}`)}>进入生产填报与修正</a>:null}
      </Surface>
      <Surface className="sourcing-list-card"><details><summary>生产上报与修正历史（{detail.detail.history.length} 条）</summary>
        {detail.detail.history.map(h=><div className="production-dashboard__line" key={h.reportId}><strong>{detail.detail.order.lines.find(l=>l.position===h.position)?.styleNo} · {h.businessDate} · {number(h.quantity)} 件</strong><span>{h.actorName} · {h.revision===1?"上报":"Root修正"} · {h.effective?"当前有效":"已被修正"} · {timestamp(h.createdAt)}</span>{h.reason?<span>原因：{h.reason}</span>:null}</div>)}
      </details><details><summary>状态与发货历史</summary>{detail.detail.transitions.map((t,i)=><p key={i}>{productionStatusLabels[t.status as keyof typeof productionStatusLabels]??t.status} · {t.businessDate} · {t.actorName}</p>)}
        {detail.detail.shipment?<p>发货款号 {detail.detail.shipment.firstStyleNo} · {detail.detail.shipment.shippedOn} · 登记产量 {number(detail.detail.shipment.recordedQuantity)} 件；仓库收货独立记录。</p>:null}
      </details></Surface>
    </>:null}
  </main></Shell>;
}
