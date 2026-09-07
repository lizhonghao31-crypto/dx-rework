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
import { canMoveProductionEvents, canAnimateProductionProgress, relativeProductionTime, changedDashboardOrders, progressLabels, progressText, productionEventText, productionStatusLabels } from "./production-dashboard-model.js";
import "./sourcing-workspace.css";
import "./production-dashboard-page.css";
import "./production-board.css";
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const number=(value:number)=>formatBusinessDecimal(value);
const timestamp=(value:string)=>new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
async function request<T>(path:string,schema:z.ZodType<T>) {
  const response=await fetch(apiUrl(`production-dashboard${path}`),{credentials:"include",cache:"no-store",headers:{accept:"application/json"}});
  const body=await response.json();if(!response.ok)throw new Error(body?.error?.message??"看板加载失败，请重试");return schema.parse(body);
}
export function ProductionProgressBars({item,motion=false}:{item:ProductionDashboardItem;motion?:boolean}) {
  const p=item.progress,node=useRef<HTMLDivElement|null>(null),[inView,setInView]=useState(false);
  useEffect(()=>{const element=node.current;if(!element||typeof IntersectionObserver==="undefined")return;const observer=new IntersectionObserver(entries=>setInView(entries.some(entry=>entry.isIntersecting)));observer.observe(element);return()=>observer.disconnect();},[]);
  const active=canAnimateProductionProgress(item,motion&&inView);
  return <div className="board-bars" data-state={p.progressState} ref={node}>
    <div><span>生产进度{p.frozen?"（完成时）":""}</span><b>{number(p.productionProgress)}%</b></div>
    <div className="board-track" role="progressbar" aria-label="生产进度" aria-valuenow={p.productionProgress} aria-valuemin={0} aria-valuemax={100}><span className={active?"board-fill is-moving":"board-fill"} style={{width:`${p.productionProgress}%`}}/></div>
    <div><span>时间进度</span><b>{p.timeProgress===null?(p.firstReportedOn?"交期未记录":"待首次上报"):`${number(p.timeProgress)}%`}</b></div>
    {p.timeProgress!==null?<div className="board-track board-time" role="progressbar" aria-label="时间进度" aria-valuenow={p.timeProgress} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${p.timeProgress}%`}}/></div>:null}
  </div>;
}
export function ProductionDashboardPage({productionOrderId}:{productionOrderId?:string|undefined}) {
  const [data,setData]=useState<ProductionDashboard|null>(null),[detail,setDetail]=useState<z.infer<typeof ProductionDashboardDetailSchema>|null>(null);
  const [q,setQ]=useState(""),[supplier,setSupplier]=useState(""),[status,setStatus]=useState(""),[progressState,setProgressState]=useState("");
  const [page,setPage]=useState(1),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [changed,setChanged]=useState<string[]>([]),[paused,setPaused]=useState(false),[hovered,setHovered]=useState(false),[focused,setFocused]=useState(false),[reduced,setReduced]=useState(false);
  const [visible,setVisible]=useState(!document.hidden),[overflow,setOverflow]=useState(false),[now,setNow]=useState(Date.now()),[filtersOpen,setFiltersOpen]=useState(false),[touchReading,setTouchReading]=useState(false);
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
  useEffect(()=>{const update=()=>{setVisible(!document.hidden);setNow(Date.now());};document.addEventListener("visibilitychange",update);const timer=setInterval(()=>{if(!document.hidden)setNow(Date.now());},60000);return()=>{document.removeEventListener("visibilitychange",update);clearInterval(timer);};},[]);
  useEffect(()=>{const node=belt.current;if(!node)return;const measure=()=>setOverflow(node.scrollWidth>node.clientWidth+1);measure();const observer=new ResizeObserver(measure);observer.observe(node);return()=>observer.disconnect();},[data?.asOf,productionOrderId]);
  const motion=!paused&&!reduced&&visible&&!error&&!loading;
  const moving=motion&&overflow&&!touchReading&&canMoveProductionEvents(data?.events.length??0,paused,hovered,focused,reduced);
  useEffect(()=>{
    if(!moving||!belt.current)return;
    let frame=0,previous=0;const tick=(now:number)=>{const node=belt.current;if(!node)return;
      if(previous){const maximum=node.scrollWidth-node.clientWidth;if(maximum>0)node.scrollLeft=node.scrollLeft>=maximum-1?0:node.scrollLeft+Math.min(now-previous,50)*0.02;}
      previous=now;frame=requestAnimationFrame(tick);
    };frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[moving,data?.asOf]);
  const asOf=data?.asOf??detail?.asOf;
  return <Shell active="实时看板"><main className="sourcing-workspace production-dashboard production-board">
    <Header iconRoute="/ui/production-dashboard" title="实时看板" subtitle="生产数量与工作日进度，按实际记录判断。" badge="实时生产看板"/>
    <div className="production-dashboard__toolbar"><a href={pageUrl("ui/production-reporting")}><NavigationIcon route="/ui/production-reporting" />生产数据填报</a>{productionOrderId?<a href={pageUrl("ui/production-dashboard")}>返回实时看板</a>:null}
      <span>{asOf?<time dateTime={asOf} title={timestamp(asOf)}>数据截至 {timestamp(asOf)} · 读取于{relativeProductionTime(asOf,now)}前</time>:"正在读取数据"}</span>
      <Button variant="secondary" aria-pressed={paused} onClick={()=>setPaused(value=>!value)}>{paused?"继续动效":"暂停动效"}</Button>
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
        {touchReading?<Button variant="secondary" onClick={()=>setTouchReading(false)}>结束触摸阅读</Button>:null}</div>
        <div className="production-dashboard__events board-events" ref={belt} onTouchStart={()=>setTouchReading(true)} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setFocused(false);}}>
          {data.events.map(event=><a className="production-dashboard__event board-event-link" key={event.id} href={pageUrl(`ui/production-dashboard/${event.productionOrderId}`)}>
            <strong>{event.firstStyleNo} · {event.supplierName}</strong><span>{productionEventText(event)}{event.quantity===null?"":` ${number(event.quantity)} 件`}</span>
            <span>{event.kind==="progress_changed"?timestamp(event.recordedAt):event.businessDate}</span>
          </a>)}
        </div></Surface>:null}
      <Surface className="sourcing-list-card board-directory"><div className="board-filters">
        <label>关键词<input value={q} maxLength={100} placeholder="款号或供应商" onChange={e=>{setQ(e.target.value);setPage(1);}}/></label>
        <div className="board-extra"><button className="board-filter-toggle" aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(value=>!value)}>供应商 / 状态 / 进度筛选</button><div className={filtersOpen?"is-open":""}>
        <label>供应商<select value={supplier} onChange={e=>{setSupplier(e.target.value);setPage(1);}}><option value="">全部负责供应商</option>{data?.suppliers.map(s=><option key={s.supplierId} value={s.supplierId}>{s.supplierName}</option>)}</select></label>
        <label>生产状态<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">全部状态</option>{Object.entries(productionStatusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>生产进度<select value={progressState} onChange={e=>{setProgressState(e.target.value);setPage(1);}}><option value="">全部进度</option>{Object.entries(progressLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        </div></div>
      </div><div className="board-table-head" aria-hidden="true"><span>订单 / 供应商</span><span>产量 / 交期</span><span>生产与时间进度</span><span>最近记录 / 关注原因</span><span>操作</span></div><div aria-busy={loading}>
        {data?.items.map(item=><article className={`board-row${changed.includes(item.order.productionOrderId)?" production-dashboard__changed":""}`} key={item.order.productionOrderId}>
          <div className="board-identity"><a href={pageUrl(`ui/production-dashboard/${item.order.productionOrderId}`)}><strong>{item.order.firstStyleNo}</strong></a><span>{item.order.supplierName}</span><StatusBadge tone={item.order.status==="in_production"?"info":"success"}>{productionStatusLabels[item.order.status]}</StatusBadge></div>
          <div className="board-quantity"><strong>{number(item.progress.completedQuantity)} <small>/ {number(item.order.quantity)} 件</small></strong><span>{item.progress.frozen?"完成时产量":"累计产量"}</span><span>交期 {item.order.deliveryDate??"未记录"}</span>{item.order.lines.length>1?<small>{item.order.lines.length} 个款色 · 详情逐项查看</small>:null}</div>
          <ProductionProgressBars item={item} motion={motion}/>
          <div className="board-update"><time title={item.progress.lastUpdatedAt?timestamp(item.progress.lastUpdatedAt):undefined}>{item.progress.lastUpdatedAt?`距上次记录 ${relativeProductionTime(item.progress.lastUpdatedAt,now)}`:"待首次上报"}</time><p className="board-reason" data-state={item.progress.progressState}>{progressText(item.progress)}</p>{item.order.sourceCaseArchived?<span>原外发单已删除 · 生产记录保留</span>:null}</div>
          <a className="board-detail-link" href={pageUrl(`ui/production-dashboard/${item.order.productionOrderId}`)}>详情</a>
        </article>)}
        {data&&!data.items.length?<p>{data.totalCount?"本页暂无订单，请返回第一页。":"当前筛选暂无生产订单"}</p>:null}
      </div>{data?<ListPagination page={page} totalPages={Math.max(1,Math.ceil(data.totalCount/15))} onPageChange={setPage} busy={loading} ariaLabel="实时看板分页"/>:null}</Surface>
    </>:null}
    {detail?<>
      <Surface className="sourcing-list-card board-detail"><h2>{detail.detail.order.firstStyleNo} · {detail.detail.order.supplierName}</h2><p>{productionStatusLabels[detail.detail.order.status]} · 交货日期 {detail.detail.order.deliveryDate??"未记录"}</p>
        <ProductionProgressBars item={{order:detail.detail.order,progress:detail.progress}} motion={motion}/><p className="board-reason" data-state={detail.progress.progressState}>{progressText(detail.progress)}</p>
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

