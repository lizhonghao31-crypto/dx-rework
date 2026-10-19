import {useEffect,useState} from "react";
import { ReceivedQuantityLabel } from "./received-quantity-label.js";
import {Button,Surface} from "@dx-rework/ui";
import {ProductionAnalysisQuerySchema,ProductionAnalysisResponseSchema,type ProductionAnalysisQuery,type ProductionAnalysisResponse} from "@dx-rework/contracts";
import {formatBusinessDecimal} from "@dx-rework/contracts/business-display";
import {verifySession} from "./auth.js";
import {createWebUrls} from "../url-contract.js";
import {ListPagination} from "./list-pagination.js";
import {canReadProductionAnalysis,productionAnalysisDueLabels,productionAnalysisReceivingLabels} from "./production-analysis-model.js";
import "./rework-v2-form.css";
import "./production-analysis.css";

const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const quantity=(value:string|number|null)=>value===null?"未记录":formatBusinessDecimal(value,0);
const time=(value:string|null)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"未记录";
const states={in_production:"生产中",production_completed:"生产完成",shipped:"已发货"};
export function ProductionAnalysisPanel({supplierId,view="concentration"}:{supplierId?:string;view?:"supplier"|"concentration"}) {
  const [access,setAccess]=useState<"loading"|"allowed"|"denied">("loading"),[open,setOpen]=useState(false);
  const [query,setQuery]=useState<ProductionAnalysisQuery>(()=>ProductionAnalysisQuerySchema.parse({supplierId,...(view==="concentration"?{status:"in_production"}:{})}));
  const [data,setData]=useState<ProductionAnalysisResponse|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[retry,setRetry]=useState(0);
  const [theme,setTheme]=useState<"delivery"|"concentration"|"alerts">(view==="supplier"?"delivery":"concentration");
  const [draft,setDraft]=useState({q:"",dueFrom:"",dueTo:""});
  useEffect(()=>{let active=true;void verifySession().then(session=>{if(active)setAccess(session!=="denied"&&session.status==="authorized"&&canReadProductionAnalysis(session.user)?"allowed":"denied");}).catch(()=>{if(active)setAccess("denied");});return()=>{active=false;};},[]);
  useEffect(()=>{
    if(!open||access!=="allowed")return;const abort=new AbortController();setBusy(true);setError("");
    const params=new URLSearchParams();for(const[key,value]of Object.entries(query))if(value!==undefined)params.set(key,String(value));
    void fetch(apiUrl(`production-dashboard/analysis?${params}`),{credentials:"include",cache:"no-store",signal:abort.signal}).then(async response=>{
      if(response.status===401||response.status===403){if(!abort.signal.aborted){setData(null);setAccess("denied");}throw new Error("当前身份无权查看此分析。");}
      if(!response.ok)throw new Error("分析读取失败，请重试。");
      const next=ProductionAnalysisResponseSchema.parse(await response.json());if(!abort.signal.aborted)setData(next);
    }).catch(reason=>{if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:"读取失败。");}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});
    return()=>abort.abort();
  },[access,open,query,retry]);
  const change=(patch:Partial<ProductionAnalysisQuery>)=>setQuery({...data?.filters??query,page:1,groupPage:1,...patch,...(supplierId?{supplierId}:{})});
  if(access!=="allowed")return open&&access==="denied"?<p role="alert">当前身份无权查看此分析。</p>:null;
  return <section className="production-analysis">
    <Button className="ui-disclosure-trigger" variant="secondary" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{view==="supplier"?"供应商履约事实":"在外订单与预警复盘"}{open?" · 收起":" · 展开"}</Button>
    {open&&<>
      <div className="production-analysis-toolbar"><h2>{view==="supplier"?"本公司与该供应商的履约记录":"本公司在外订单分析"}</h2><Button disabled={busy} onClick={()=>setRetry(value=>value+1)}>{busy?"正在读取…":"刷新分析"}</Button></div>
      <div className="production-analysis-tabs" aria-label="生产分析主题">{([['delivery','交付与回货'],['concentration','在外集中'],['alerts','预警记录']] as const).map(([key,label])=><Button key={key} variant={theme===key?'primary':'secondary'} disabled={busy} onClick={()=>{if(key!==theme)setData(null);setTheme(key);change({status:key==='concentration'?'in_production':undefined,dueBucket:'all'});}}>{label}</Button>)}</div>
      <details className="production-analysis-filters"><summary>筛选款号与批准交期</summary><form onSubmit={event=>{event.preventDefault();const parsed=ProductionAnalysisQuerySchema.safeParse({...query,q:draft.q,dueFrom:draft.dueFrom||undefined,dueTo:draft.dueTo||undefined,page:1,groupPage:1});if(parsed.success)setQuery(parsed.data);else setError('请检查交期范围。');}}><label>款号 / 供应商<input className="rework-v2-control" value={draft.q} maxLength={120} onChange={event=>setDraft(value=>({...value,q:event.target.value}))}/></label><label>批准交期从<input className="rework-v2-control" type="date" value={draft.dueFrom} onChange={event=>setDraft(value=>({...value,dueFrom:event.target.value}))}/></label><label>至<input className="rework-v2-control" type="date" value={draft.dueTo} onChange={event=>setDraft(value=>({...value,dueTo:event.target.value}))}/></label><Button type="submit" disabled={busy}>应用筛选</Button></form></details>
      {error&&<p role="alert">{error}</p>}
      {data&&<>
        <p>数据截至 {time(data.asOf)} · {data.filters.q?`搜索 ${data.filters.q} · `:''}{data.filters.status?states[data.filters.status]:'全部生产状态'} · {productionAnalysisDueLabels[data.filters.dueBucket]}{data.filters.dueFrom||data.filters.dueTo?` · 批准交期 ${data.filters.dueFrom??'不限'} 至 ${data.filters.dueTo??'不限'}`:''}{data.filters.supplierId?` · 供应商 ID ${data.filters.supplierId}`:''}</p>
        <Surface><dl className="production-analysis-metrics"><div><dt>符合条件订单 / 未完</dt><dd>{quantity(data.summary.totalCount)} / {quantity(data.summary.openCount)}</dd></div><div><dt>未完剩余生产数量</dt><dd>{quantity(data.summary.remainingQuantity)}</dd></div><div><dt>尚无有效实收订单</dt><dd>{quantity(data.summary.ordersWithoutReceipts)}</dd></div><div><dt>真实预警记录</dt><dd>{quantity(data.summary.alertCount)}</dd></div></dl></Surface>
        {theme==='concentration'?<><div className="production-analysis-tabs">{(['all','overdue','soon','missing','later'] as const).map(key=><Button key={key} disabled={busy} variant={data.filters.dueBucket===key?'primary':'secondary'} onClick={()=>change({dueBucket:key})}>{productionAnalysisDueLabels[key]}{key==='overdue'?` ${data.summary.overdueCount}`:key==='soon'?` ${data.summary.soonCount}`:key==='missing'?` ${data.summary.missingDueCount}`:''}</Button>)}</div><p>仅统计本公司有效“生产中”订单，剩余量取订单量减有效上报量；完成与已发货不计未完，不能推断供应商总产能。</p><Surface><h3>供应商集中情况</h3>{data.groups.map(group=><div className="production-analysis-group" key={group.supplierId}><Button disabled={busy||!!supplierId} onClick={()=>change({supplierId:group.supplierId})}>{group.supplierName} · {group.supplierId.slice(-6)}</Button><span>{quantity(group.openCount)}单未完 · 剩余 {quantity(group.remainingQuantity)}件 · 逾期 {quantity(group.overdueCount)}单</span></div>)}{!supplierId&&data.filters.supplierId&&<Button onClick={()=>change({supplierId:undefined})}>清除供应商筛选</Button>}<ListPagination page={data.filters.groupPage} totalPages={Math.ceil(data.groupTotal/15)} busy={busy} ariaLabel="供应商集中分页" onPageChange={groupPage=>change({groupPage})}/></Surface></>:null}
        {theme==='alerts'?<p>首次观察时间来自已有预警记录；已读不等于解决，记录关闭不证明风险恢复。后续上报和交付只做时间对照，不推断干预效果。</p>:null}
        {theme==='delivery'?<p>发货不等于到仓；数量达到发货记录不代表整单质量验收。{quantity(data.summary.ordersWithUnallocatedAdjustments)}单存在未分配的批次调整，需核查。返工关联单数：{data.summary.qualityOrderCount===null?'当前身份无权查看':quantity(data.summary.qualityOrderCount)}；不累加工序数量，不计算全局返工率。</p>:null}
        {!data.items.length&&<Surface><p>当前筛选没有生产订单。</p></Surface>}
        {data.items.map(item=><Surface key={item.order.productionOrderId} className="production-analysis-order"><div className="production-analysis-toolbar"><h3>{item.order.firstStyleNo} · {item.order.supplierName}</h3><a href={pageUrl(`ui/production-dashboard/${item.order.productionOrderId}`)}>查看原生产单</a></div><p>{item.order.contractNumber} · {states[item.order.status]} · 批准交期 {item.order.deliveryDate??'未记录'} · 决定版本 {item.order.decisionVersion}{item.order.sourceCaseArchived?' · 来源外发单已归档，生产事实保留':''}</p>
          {theme==='concentration'?<dl className="production-analysis-metrics"><div><dt>订单量 / 有效生产量</dt><dd>{quantity(item.order.quantity)} / {quantity(item.order.completedQuantity)}</dd></div><div><dt>未完剩余</dt><dd>{quantity(item.remainingQuantity)}</dd></div><div><dt>交期分组</dt><dd>{productionAnalysisDueLabels[item.dueBucket]}</dd></div></dl>:null}
          {theme==='delivery'?<><div className="production-analysis-timeline"><div><b>正式派单</b><span>{time(item.order.dispatchedAt)}</span></div><div><b>首次生产业务日</b><span>{item.order.firstReportedOn??'待首次上报'}</span></div><div><b>生产完成</b><span>{item.completedOn??'未记录'}</span></div><div><b>发货</b><span>{item.shippedOn??'未记录'} · {quantity(item.shippedQuantity)}件</span></div><div><b>首次到仓</b><span>{time(item.firstReceivedAt)}</span></div><div><b><ReceivedQuantityLabel>有效累计实收</ReceivedQuantityLabel></b><span>{quantity(item.receivedQuantity)}件 · {productionAnalysisReceivingLabels[item.receivingState]}</span></div></div><details><summary>款色、收货与返工关联明细</summary>{item.order.lines.map(line=><p key={line.position}>{line.styleNo} · {line.color??'颜色未记录'} · {quantity(line.quantity)}件</p>)}<p>回货只关联整份生产单；未保存具体款色行关系时不分摊实收。</p>{item.receipts.map(receipt=><p key={receipt.receiptId}>收货 {receipt.receiptId} · 批次 {receipt.receivingBatchId} · <ReceivedQuantityLabel>实收</ReceivedQuantityLabel> {quantity(receipt.actualQuantity)}件 · {time(receipt.receivedAt)}{receipt.archived?' · 归档收货，不计有效实收':''}{receipt.correctionId?` · 修订 ${receipt.correctionId}`:''}</p>)}<p>批次调整待核查 {item.unallocatedBatchCount}批；已归档收货 {item.archivedReceiptCount}次。完工录入 {time(item.completedRecordedAt)}；发货录入 {time(item.shipmentRecordedAt)}。</p>{item.quality?<><p>明确关联返工 {item.quality.reworkOrderCount}单；关联歧义 {item.quality.ambiguousBatchCount}批，不归责供应商。</p>{item.quality.orders.map(order=><p key={order.reworkOrderId}><a href={pageUrl(`ui/tasks/${order.reworkOrderId}`)}>{order.reworkNo??order.reworkOrderId}</a> · 登记 {quantity(order.quantity)}件</p>)}<p>每张返工单数量单独列示，同件跨返工单或工序可能重复，不相加为不良件数。</p></>:<p>返工事实仅向已有管理报表查看权限开放。</p>}</details></>:null}
          {theme==='alerts'?(item.alerts.length?item.alerts.map(alert=><article className="production-analysis-alert" key={alert.alertId}><strong>{({behind:'进度落后',high_risk:'高风险',stale:'未更新'} as const)[alert.kind]}</strong><p>首次观察 {time(alert.firstObservedAt)} · 我的已读 {time(alert.readAt)} · 记录关闭 {time(alert.closedAt)}</p><p>随后首条生产记录 {time(alert.nextReportAt)}（业务日 {alert.nextReportBusinessDate??'未记录'}）</p><p>完工 {item.completedOn??'未记录'} · 发货 {item.shippedOn??'未记录'} · 首次实收 {time(item.firstReceivedAt)}</p></article>):<p>该订单没有保存过预警记录，不代表历史从未出现风险。</p>):null}
        </Surface>)}
        <ListPagination page={data.filters.page} totalPages={Math.ceil(data.summary.totalCount/15)} busy={busy} ariaLabel="生产分析订单分页" onPageChange={page=>change({page})}/>
      </>}
    </>}
  </section>;
}

