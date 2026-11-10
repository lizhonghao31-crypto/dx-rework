import {TodoReadBoundary,useTodoContentRead} from './todo-content-read.js';
import { SearchableSelect } from "./search-select.js";
import { PoDateSummary,PoDateDetails,PoDateRisks,PoDeadline } from "./po-delivery-dates.js";
import { shanghaiBusinessTime } from "./business-date.js";
import { productionDisplayReturnUrl,productionDisplayDomainHref,productionReportingHref } from "./production-display-context.js";
import { todoReturnPath } from "./todo-query-state.js";
import { ProductionExclusionControls } from "./production-exclusion-controls.js";
import { NavigationIcon } from "./navigation-icons.js";
import { ProductionPilotControls, ProductionReceiptSummary } from "./production-closure-ui.js";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { ProductionDashboardSchema, ProductionDashboardDetailSchema, type ProductionDashboard, type ProductionDashboardItem } from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { verifySession } from "./auth.js";
import { Header, Shell } from "./components.js";
import { ListPagination } from "./list-pagination.js";
import { createWebUrls } from "../url-contract.js";
import {digitalDetailReturnUrl} from "./digital-detail-route.js";
import { canAccessProductionReporting } from "./platform-modules.js";
import { canControlProductionMotion, canMoveProductionEvents, canAnimateProductionProgress, relativeProductionTime, changedDashboardOrders, productionDashboardKey, progressLabels, progressText, productionEventText, productionStatusLabels } from "./production-dashboard-model.js";
import "./sourcing-workspace.css";
import "./production-dashboard-page.css";
import "./production-board.css";
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const number=(value:number)=>formatBusinessDecimal(value);
const timestamp=(value:string)=>shanghaiBusinessTime(value);
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
export function ProductionDashboardPage(props:{productionOrderId?:string|undefined}){return <TodoReadBoundary><ProductionDashboardContent {...props}/></TodoReadBoundary>;}
function ProductionDashboardContent({productionOrderId}:{productionOrderId?:string|undefined}) {
  const factoryDecisionId=new URLSearchParams(window.location.search).get('factoryDecisionId');
  const factoryQuery=factoryDecisionId?'?'+new URLSearchParams({factoryDecisionId}):'';
  const [data,setData]=useState<ProductionDashboard|null>(null),[detail,setDetail]=useState<z.infer<typeof ProductionDashboardDetailSchema>|null>(null);
  const readRef=useTodoContentRead({routeName:'production_detail',entityId:productionOrderId??'',factoryDecisionId},Boolean(detail&&detail.detail.order.productionOrderId===productionOrderId));
  const [q,setQ]=useState(""),[supplier,setSupplier]=useState(""),[status,setStatus]=useState(""),[progressState,setProgressState]=useState("");
  const [risk,setRisk]=useState(""),[root,setRoot]=useState(false),[managementOpen,setManagementOpen]=useState(false),[deleting,setDeleting]=useState<string|null>(null);
  const [page,setPage]=useState(1),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [changed,setChanged]=useState<string[]>([]),[paused,setPaused]=useState(false),[hovered,setHovered]=useState(false),[focused,setFocused]=useState(false),[reduced,setReduced]=useState(false);
  const [visible,setVisible]=useState(!document.hidden),[overflow,setOverflow]=useState(false),[now,setNow]=useState(Date.now()),[filtersOpen,setFiltersOpen]=useState(false),[touchReading,setTouchReading]=useState(false);
  const [canControlMotion,setCanControlMotion]=useState(false),[canOpenReporting,setCanOpenReporting]=useState(false);
  useEffect(()=>{let live=true;void verifySession().then(session=>{if(!live)return;if(session==="denied"){setCanControlMotion(false);setCanOpenReporting(false);return;}setRoot(session.user.isRoot===true);setCanControlMotion(canControlProductionMotion(session.user));setCanOpenReporting(canAccessProductionReporting(session.user));}).catch(()=>{if(live){setCanControlMotion(false);setCanOpenReporting(false);}});return()=>{live=false;};},[]);
  const sequence=useRef(0),last=useRef<ProductionDashboard|null>(null),belt=useRef<HTMLDivElement|null>(null);
  const load=async(manual=false)=>{
    const version=++sequence.current;setLoading(true);setError("");
    try{
      if(productionOrderId){const result=await request(`/${productionOrderId}${factoryQuery}`,ProductionDashboardDetailSchema);if(version===sequence.current){setDetail(result);

      }}
      else{const params=new URLSearchParams({page:String(page)});if(q.trim())params.set("q",q.trim());if(supplier)params.set("supplierId",supplier);if(status)params.set("status",status);if(progressState)params.set("progressState",progressState);if(risk)params.set("risk",risk);
        if(manual&&last.current)params.set("previousAsOf",last.current.asOf);
        const result=await request(`?${params}`,ProductionDashboardSchema);
        if(version===sequence.current){setChanged(manual&&last.current?changedDashboardOrders(last.current.items,result.items):[]);setData(result);last.current=result;}
      }
    }catch(e){if(version===sequence.current)setError(e instanceof Error?e.message:"加载失败");}finally{if(version===sequence.current)setLoading(false);}
  };
  // Only initial load, explicit filter/page changes and the refresh button request data.
  useEffect(()=>{const timer=setTimeout(()=>{void load();},q?250:0);return()=>{clearTimeout(timer);sequence.current++;};},[productionOrderId,factoryDecisionId,page,q,supplier,status,progressState,risk]);
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
  const orderReturn=digitalDetailReturnUrl(new URLSearchParams(window.location.search).get("returnTo"),import.meta.env.BASE_URL);
  const displayReturn=productionDisplayReturnUrl(new URLSearchParams(window.location.search).get('returnTo'));
  return <Shell active="实时看板"><div ref={readRef} className="sourcing-workspace production-dashboard production-board">
    <Header iconRoute="/ui/production-dashboard" title="实时看板" subtitle="生产数量与工作日进度，按实际记录判断。" badge="实时生产看板"/>
    <div className="production-dashboard__toolbar">{canOpenReporting?<a href={productionReportingHref(productionOrderId??null,factoryDecisionId,orderReturn??displayReturn)!}><NavigationIcon route="/ui/production-reporting" />生产数据填报</a>:null}{productionOrderId?<a href={todoReturnPath(window.location.search)?pageUrl(todoReturnPath(window.location.search)!):orderReturn??displayReturn??pageUrl("ui/production-dashboard")}>{todoReturnPath(window.location.search) ? "返回我的待办" : orderReturn?"返回这张订单":displayReturn?"返回实时生产展示":"返回实时看板"}</a>:null}
      <span>{asOf?<time dateTime={asOf} title={timestamp(asOf)}>数据截至 {timestamp(asOf)} · 读取于{relativeProductionTime(asOf,now)}前</time>:"正在读取数据"}</span>
      {canControlMotion?<Button variant="secondary" aria-pressed={paused} onClick={()=>{if(canControlMotion)setPaused(value=>!value);}}>{paused?"继续动效":"暂停动效"}</Button>:null}
      <Button variant="secondary" disabled={loading} onClick={()=>{void load(true);}}><span aria-hidden="true" className={loading?"production-dashboard__refreshing":""}>↻</span> {loading?"刷新中…":"刷新"}</Button>
      {root?<Button variant="secondary" aria-expanded={managementOpen} onClick={()=>setManagementOpen(value=>!value)}>管理⌄</Button>:null}
    </div>
    {root&&managementOpen?<div className="production-admin-tools"><ProductionExclusionControls onExcluded={()=>{setData(null);setDetail(null);last.current=null;void load();}}/>{!productionOrderId?<ProductionPilotControls/>:null}</div>:null}
    {productionOrderId?<ProductionReceiptSummary factoryDecisionId={factoryDecisionId} productionOrderId={productionOrderId} refreshKey={detail?.asOf}/>:null}
    {error?<p role="alert" className="sourcing-delete-error">{error}</p>:null}
    {!data&&!detail&&loading?<p role="status">正在加载生产数据…</p>:null}
    {!productionOrderId?<>
      {data?<div className="production-chase-summary" aria-label="当前筛选追单摘要">
        <button aria-pressed={risk==="attention"} onClick={()=>{setRisk("attention");setPage(1);}}>需关注 {number(data.chaseCounts?.attention??data.counts.attention)}</button>
        <button aria-pressed={risk==="stale"} onClick={()=>{setRisk("stale");setPage(1);}}>2天未更新 {number(data.chaseCounts?.stale??0)}</button>
        <button aria-pressed={risk==="due_pressure"} onClick={()=>{setRisk("due_pressure");setPage(1);}}>本周交期承压 {number(data.chaseCounts?.duePressure??0)}</button>
        <span>生产中 {number(data.counts.inProduction)} · 完成 {number(data.counts.completed)} · 已发货 {number(data.counts.shipped)}</span>
        {risk?<button onClick={()=>{setRisk("");setPage(1);}}>清除风险筛选</button>:null}
      </div>:null}
      {data?.events.length?<Surface className="sourcing-list-card"><div className="production-dashboard__toolbar"><strong>最近生产动态</strong>
        {touchReading?<Button variant="secondary" onClick={()=>setTouchReading(false)}>结束触摸阅读</Button>:null}</div>
        <div className="production-dashboard__events board-events" ref={belt} onTouchStart={()=>setTouchReading(true)} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setFocused(false);}}>
          {data.events.map(event=><a className="production-dashboard__event board-event-link" key={event.id} href={pageUrl(`ui/production-dashboard/${event.productionOrderId}${event.factoryDecisionId?"?"+new URLSearchParams({factoryDecisionId:event.factoryDecisionId}):""}`)}>
            <strong>{event.firstStyleNo} · {event.supplierName}</strong><span>{productionEventText(event)}{event.quantity===null?"":` ${number(event.quantity)} 件`}</span>
            <span>{event.kind==="progress_changed"?timestamp(event.recordedAt):event.businessDate}</span>
          </a>)}
        </div></Surface>:null}
      <Surface className="sourcing-list-card board-directory"><div className="board-filters">
        <label>关键词<input value={q} maxLength={100} placeholder="款号或供应商" onChange={e=>{setQ(e.target.value);setPage(1);}}/></label>
        <div className="board-extra"><button className="board-filter-toggle" aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(value=>!value)}>供应商 / 状态 / 进度筛选</button><div className={filtersOpen?"is-open":""}>
        <label>供应商<SearchableSelect value={supplier} onChange={e=>{setSupplier(e.target.value);setPage(1);}}><option value="">全部负责供应商</option>{data?.suppliers.map(s=><option key={s.supplierId} value={s.supplierId}>{s.supplierName}</option>)}</SearchableSelect></label>
        <label>生产状态<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">全部状态</option>{Object.entries(productionStatusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>生产进度<select value={progressState} onChange={e=>{setProgressState(e.target.value);setPage(1);}}><option value="">全部进度</option>{Object.entries(progressLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>追单风险<select value={risk} onChange={e=>{setRisk(e.target.value);setPage(1);}}><option value="">全部</option><option value="attention">需关注</option><option value="stale">2天未更新</option><option value="due_pressure">本周交期承压</option><option value="po_deadline">PO 交期提醒</option></select></label>
        </div></div>
      </div><div className="board-table-head" aria-hidden="true"><span>订单 / 供应商</span><span>产量 / 交期</span><span>生产与时间进度</span><span>最近记录 / 关注原因</span><span>操作</span></div><div aria-busy={loading}>
        {data?.items.map(item=><article className={`board-row${changed.includes(productionDashboardKey(item.order))?" production-dashboard__changed":""}`} key={`${item.order.productionOrderId}:${item.order.factoryDecisionId??"original"}`}>
          <div className="board-identity"><a href={pageUrl(`ui/production-dashboard/${item.order.productionOrderId}${item.order.factoryDecisionId?"?"+new URLSearchParams({factoryDecisionId:item.order.factoryDecisionId}):""}`)}><strong>{item.order.firstStyleNo}</strong></a><span>{item.order.supplierName}</span>{item.chase&&item.order.status==="in_production"?<small className="board-concentration" title="本公司当前权限可见的未完订单，不代表供应商全部产能">当前 {item.chase.supplierOpenCount} 张未完 · {item.chase.supplierDueThisWeekCount} 张本周到期</small>:null}<StatusBadge tone={item.order.status==="in_production"?"info":"success"}>{productionStatusLabels[item.order.status]}</StatusBadge></div>
          <div className="board-quantity"><strong>{number(item.progress.completedQuantity)} <small>/ {number(item.order.quantity)} 件</small></strong><span>{item.progress.frozen?"完成时产量":"累计产量"}</span><PoDateSummary lines={item.order.poDeliveryDates} legacy={item.order.deliveryDate}/><PoDeadline lines={item.order.poDeliveryDates} finished={item.order.status!=="in_production"||Boolean(item.order.poDeliveryClosed)}/>{item.order.lines.length>1?<small>{item.order.lines.length} 个款色 · 详情逐项查看</small>:null}</div>
          <ProductionProgressBars item={item} motion={motion}/>
          <div className="board-update"><time title={item.progress.lastUpdatedAt?timestamp(item.progress.lastUpdatedAt):undefined}>{item.progress.lastUpdatedAt?`距上次记录 ${relativeProductionTime(item.progress.lastUpdatedAt,now)}`:"待首次上报"}</time><p className="board-reason" data-state={item.progress.progressState}>{progressText(item.progress)}</p><PoDateRisks risks={item.deliveryRisks}/>{item.order.sourceCaseArchived?<span>原外发单已删除 · 生产记录保留</span>:null}</div>
          <div className="board-row-actions"><a className="board-detail-link" href={pageUrl(`ui/production-dashboard/${item.order.productionOrderId}${item.order.factoryDecisionId?"?"+new URLSearchParams({factoryDecisionId:item.order.factoryDecisionId}):""}`)}>详情</a>{root?<button className="board-delete" onClick={()=>setDeleting(item.order.productionOrderId)}>删除</button>:null}</div>
          {item.chase&&item.order.status==="in_production"?<div className="board-chase">
            <strong>剩余 {number(item.chase.remainingQuantity)} 件</strong>
            <span>{item.chase.remainingWorkdays===null?"交期未记录":`距交期 ${item.chase.remainingWorkdays} 个工作日`}</span>
            {item.chase.requiredDailyQuantity!==null?<span>需日均 {number(item.chase.requiredDailyQuantity)} 件</span>:null}
            <span>{item.chase.recentDailyQuantity===null?"近期有效记录不足，暂不判断":`近3个有效生产日均 ${number(item.chase.recentDailyQuantity)} 件`}</span>
            {item.chase.deliveryPressure?<strong className="is-pressure">交期承压</strong>:null}
          </div>:null}
        </article>)}
        {data&&!data.items.length?<p>{data.totalCount?"本页暂无订单，请返回第一页。":"当前筛选暂无生产订单"}</p>:null}
      </div><details><summary>计算口径</summary>剩余工作日包含今天，按周一至周五计算。近3个有效生产日取最近7自然日内有上报的日期；修正取最新版本，无上报不补0，数据不足不推测。</details>{data?<ListPagination page={page} totalPages={Math.max(1,Math.ceil(data.totalCount/15))} onPageChange={setPage} busy={loading} ariaLabel="实时看板分页"/>:null}</Surface>
    </>:null}
    {deleting?<div className="production-delete-overlay" role="presentation"><section role="dialog" aria-modal="true" aria-label="删除测试或误建生产订单" className="production-delete-dialog">
      <div className="production-dashboard__toolbar"><h2>删除测试 / 误建记录</h2><Button variant="secondary" onClick={()=>setDeleting(null)}>关闭</Button></div>
      <ProductionExclusionControls key={deleting} productionOrderId={deleting} onExcluded={()=>{setDeleting(null);setData(null);setDetail(null);last.current=null;void load();}}/>
    </section></div>:null}
    {detail?<>
      <Surface className="sourcing-list-card board-detail"><h2>{detail.detail.order.firstStyleNo} · {detail.detail.order.supplierName}</h2><p>{productionStatusLabels[detail.detail.order.status]} · <PoDateSummary lines={detail.detail.order.poDeliveryDates} legacy={detail.detail.order.deliveryDate}/></p>
        <ProductionProgressBars item={{order:detail.detail.order,progress:detail.progress}} motion={motion}/><p className="board-reason" data-state={detail.progress.progressState}>{progressText(detail.progress)}</p>
        <p>工艺：{detail.detail.order.processes.join("、")}</p><PoDateDetails lines={detail.detail.order.poDeliveryDates} finished={detail.detail.order.status!=="in_production"||Boolean(detail.detail.order.poDeliveryClosed)}/><PoDateRisks risks={detail.deliveryRisks}/>
        {detail.progress.frozen?<p>进度保留完成时事实；以下明细和历史保留后续修正。</p>:null}
        <div className="sourcing-order-list">{detail.detail.order.lines.map(line=><div key={line.position} className="production-dashboard__line"><strong>{line.position}. {line.styleNo} · {line.color??"未记录颜色"}</strong><span>{number(line.completedQuantity)} / {number(line.quantity)} 件</span></div>)}</div>
        {detail.detail.canReport||detail.detail.canCorrect?<a href={productionDisplayDomainHref(pageUrl(`ui/production-reporting/${productionOrderId}${factoryQuery}`),window.location.search)}>进入生产填报与修正</a>:null}
      </Surface>
      <Surface className="sourcing-list-card"><details><summary>生产上报与修正历史（{detail.detail.history.length} 条）</summary>
        {detail.detail.history.map(h=><div className="production-dashboard__line" key={h.reportId}><strong>{detail.detail.order.lines.find(l=>l.position===h.position)?.styleNo} · {h.businessDate} · {number(h.quantity)} 件</strong><span>{h.actorName} · {h.revision===1?"上报":"Root修正"} · {h.effective?"当前有效":"已被修正"} · {timestamp(h.createdAt)}</span>{h.reason?<span>原因：{h.reason}</span>:null}</div>)}
      </details><details><summary>状态与发货历史</summary>{detail.detail.transitions.map((t,i)=><p key={i}>{productionStatusLabels[t.status as keyof typeof productionStatusLabels]??t.status} · {t.businessDate} · {t.actorName}</p>)}
        {detail.detail.shipment?<p>发货款号 {detail.detail.shipment.firstStyleNo} · {detail.detail.shipment.shippedOn} · 登记产量 {number(detail.detail.shipment.recordedQuantity)} 件；仓库收货独立记录。</p>:null}
      </details></Surface>
    </>:null}
  </div></Shell>;
}


