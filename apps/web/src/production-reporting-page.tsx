import {productionDisplayDomainHref} from './production-display-context.js';
import {SUBMISSION_RECOVERY_WINDOW_MS} from "./submission-attempt.js";
import {feedbackFetch,feedbackJson,unknownWriteResult} from "./request-response-feedback.js";
import { SearchableSelect } from "./search-select.js";
import { shanghaiBusinessTime } from "./business-date.js";
import { productionDisplayReturnUrl } from "./production-display-context.js";
import { moduleCanWrite } from "./member-module-policy.js";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { z } from "zod";
import { ProductionReportingDetailSchema, ProductionReportingListSchema, ProductionScopeDirectorySchema,
  type ProductionReportingDetail, type ProductionScopeInput } from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { Header, Shell } from "./components.js";
import { verifySession, type AuthorizedUser } from "./auth.js";
import {registerSessionInvalidator,sessionCacheVersion} from './auth-session.js';
import { ListPagination } from "./list-pagination.js";
import { createClientRequestId } from "./client-request-id.js";
import { confirmInApp } from "./system-dialog.js";
import { createWebUrls } from "../url-contract.js";
import "./sourcing-workspace.css";
import "./production-reporting-page.css";
import {productionLineTarget} from "./production-line-target.js";
import {digitalDetailReturnUrl} from "./digital-detail-route.js";
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const labels={in_production:"生产中",production_completed:"生产完成",shipped:"已发货"} as const;
async function request<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}) {
  const response=await feedbackFetch(apiUrl(`production-reporting${path}`),{credentials:"include",cache:"no-store",...init,
    headers:{accept:"application/json",...(init.body?{"content-type":"application/json"}:{}),...init.headers}});
  return feedbackJson(response,init.method??'GET',value=>schema.parse(value));
}
export async function saveProductionScope(input:ProductionScopeInput,key:string){
 const response=await feedbackFetch(apiUrl("production-reporting/scopes"),{method:"POST",credentials:"include",headers:{"content-type":"application/json","idempotency-key":key},body:JSON.stringify(input)});await feedbackJson(response,"POST",value=>{if(!value||typeof value!=="object"||!("saved"in value)||value.saved!==true)throw Error("invalid scope receipt");return value;});
}

type ProductionAttempt={payload:string;key:string;startedAt:number;uncertain?:boolean;inFlight?:boolean};
// In-memory recovery belongs to the verified principal and original command,
// not to a mounted detail. No payload/key is persisted or shared across users.
const productionAttempts=new Map<string,ProductionAttempt>(),scopeAttempts=new Map<string,ProductionAttempt>();
let attemptRevision=0;
const attemptListeners=new Set<()=>void>(),attemptSnapshot=()=>attemptRevision;
const subscribeAttempts=(listener:()=>void)=>{attemptListeners.add(listener);return()=>{attemptListeners.delete(listener);};};
const changedAttempts=()=>{attemptRevision++;for(const listener of attemptListeners)listener();};
export function ProductionReportingPage({productionOrderId}:{productionOrderId?:string|undefined}) {
  useSyncExternalStore(subscribeAttempts,attemptSnapshot,attemptSnapshot);
  const factoryDecisionId=new URLSearchParams(window.location.search).get('factoryDecisionId');
  const factoryQuery=factoryDecisionId?'?'+new URLSearchParams({factoryDecisionId}):'';
  const identityVersion=useSyncExternalStore(registerSessionInvalidator,sessionCacheVersion,sessionCacheVersion);
  const [verified,setVerified]=useState<{version:number;user:AuthorizedUser}|null>(null),[error,setError]=useState(""),[message,setMessage]=useState("");
  const user=verified?.version===identityVersion?verified.user:null;
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[page,setPage]=useState(1);
  const [q,setQ]=useState(""),[supplier,setSupplier]=useState(""),[status,setStatus]=useState("");
  const [listResult,setList]=useState<{key:string;value:z.infer<typeof ProductionReportingListSchema>}|null>(null);
  const [detailResult,setDetail]=useState<{key:string;value:ProductionReportingDetail}|null>(null);
  const [quantities,setQuantities]=useState<Record<number,string>>({}),[date,setDate]=useState('');
  const [correcting,setCorrecting]=useState<ProductionReportingDetail["history"][number]|null>(null);
  const [correctionQuantity,setCorrectionQuantity]=useState(""),[correctionDate,setCorrectionDate]=useState(''),[reason,setReason]=useState("");
  const [directoryResult,setDirectory]=useState<{key:string;value:z.infer<typeof ProductionScopeDirectorySchema>}|null>(null);
  const [scopeError,setScopeError]=useState("");
  const [scopeUser,setScopeUser]=useState(""),[scopeRefreshPending,setScopeRefreshPending]=useState(false),[scopeSupplier,setScopeSupplier]=useState("");
  // Permission changes invalidate reads without discarding this principal's
  // original uncertain command or authorizing another command in its place.
  const authority=user?[user.id,user.isRoot===true,[...(user.businessRoles??[])].sort(),[...user.capabilities].sort(),user.effectiveWriteCapabilities?[...user.effectiveWriteCapabilities].sort():null,[...(user.readOnlyModules??[])].sort()]:null;
  const contextKey=JSON.stringify([authority,productionOrderId??null,factoryDecisionId]);
  const commandKey=JSON.stringify([user?.id??null,productionOrderId??null,factoryDecisionId]);
  const readKey=JSON.stringify([contextKey,identityVersion]),context=useRef(readKey);context.current=readKey;
  const sameOrder=(value:ProductionReportingDetail)=>value.order.productionOrderId===productionOrderId&&(value.order.factoryDecisionId??null)===factoryDecisionId;
  const detail=productionOrderId&&detailResult?.key===readKey&&sameOrder(detailResult.value)?detailResult.value:null;
  const list=!productionOrderId&&listResult?.key===readKey?listResult.value:null;
  const directory=directoryResult?.key===readKey?directoryResult.value:null;
  const dateContext=useRef('');
  const businessToday=detail&&detail.order.productionOrderId===productionOrderId&&(detail.order.factoryDecisionId??null)===factoryDecisionId&&detail.asOf?detail.businessToday:undefined;
  useEffect(()=>{
    if(!businessToday)return;
    if(dateContext.current!==contextKey){dateContext.current=contextKey;setDate(businessToday);setCorrectionDate(businessToday);}
  },[businessToday,contextKey]);
  const retry=useMemo(()=>({get current(){return productionAttempts.get(commandKey)??null;},set current(value:ProductionAttempt|null){if(value)productionAttempts.set(commandKey,value);else productionAttempts.delete(commandKey);changedAttempts();}}),[commandKey]);
  const scopeKey=user?.id??'unverified';
  const scopeRetry=useMemo(()=>({get current(){return scopeAttempts.get(scopeKey)??null;},set current(value:ProductionAttempt|null){if(value)scopeAttempts.set(scopeKey,value);else scopeAttempts.delete(scopeKey);changedAttempts();}}),[scopeKey]);
  const mutation=useRef(false),version=useRef(0);
  useEffect(()=>{let live=true;const pending=verifySession(),version=sessionCacheVersion();void pending.then(s=>{if(live&&version===sessionCacheVersion())setVerified(s!=="denied"&&s.status==="authorized"?{version,user:s.user}:null);});return()=>{live=false;};},[identityVersion]);
  useEffect(()=>{setError('');setMessage('');setScopeError('');setQuantities({});setCorrecting(null);setScopeUser('');setScopeSupplier('');},[readKey]);
  const load=async()=>{
    if(!user)return;
    const startedContext=readKey;
    const current=++version.current;setLoading(true);setError("");
    try {
      if(productionOrderId){const result=await request(`/${productionOrderId}${factoryQuery}`,ProductionReportingDetailSchema);if(!sameOrder(result))throw new Error('生产资料与当前订单或工厂版本不一致，请从原订单重新读取');if(current===version.current&&context.current===startedContext)setDetail({key:startedContext,value:result});}
      else {const params=new URLSearchParams({page:String(page)});if(q.trim())params.set("q",q.trim());if(supplier)params.set("supplierId",supplier);if(status)params.set("status",status);
        const result=await request(`?${params}`,ProductionReportingListSchema);if(current===version.current&&context.current===startedContext)setList({key:startedContext,value:result});}
    }catch(e){if(current===version.current&&context.current===startedContext)setError(e instanceof Error?e.message:"加载失败");}
    finally{if(current===version.current&&context.current===startedContext)setLoading(false);}
  };
  useEffect(()=>{const timer=setTimeout(()=>{void load();},q?250:0);return()=>{clearTimeout(timer);version.current++;};},[readKey,page,q,supplier,status]);
  const write=async(path:string,body:unknown,success:string,recover=false)=>{
    const startedContext=readKey;
    if(!user||!detail||context.current!==startedContext)return;
    if(mutation.current||retry.current?.inFlight)return;
    if(recover&&!retry.current)return; // A stale recovery control cannot allocate a new key after confirmation.
    mutation.current=true;setBusy(true);setError("");setMessage("");
    if(!recover)body={...(body as Record<string,unknown>),factoryDecisionId};const payload=JSON.stringify({path,body});if(retry.current?.uncertain&&retry.current.payload!==payload){setError("上次提交结果尚未确认，请先刷新原订单核对；重试时须保留原内容和请求标识。");mutation.current=false;setBusy(false);return;}if(retry.current?.payload!==payload)retry.current={payload,key:createClientRequestId(),startedAt:Date.now()};
    if(retry.current.uncertain&&Date.now()-retry.current.startedAt>=SUBMISSION_RECOVERY_WINDOW_MS){setError("原提交已超出安全重试时间，请核对原订单；本次未重发，也不会另建请求标识。");mutation.current=false;setBusy(false);return;}
    const attempt=retry.current;attempt.inFlight=true;changedAttempts();
    try {const result=await request(path,ProductionReportingDetailSchema,{method:"POST",body:JSON.stringify(body),headers:{"idempotency-key":attempt.key}});
      if(!sameOrder(result))throw new Error('提交回执与原订单或工厂版本不一致，结果尚未确认，请核对原记录');
      retry.current=null;if(context.current!==startedContext)return;setDetail({key:startedContext,value:result});setMessage(success);setQuantities({});setCorrecting(null);
    }catch(e){if(retry.current?.uncertain||unknownWriteResult(e)){if(retry.current)retry.current.uncertain=true;}else retry.current=null;if(context.current===startedContext)setError((e instanceof Error?e.message:"提交结果尚未确认，请核对原订单")+(retry.current?.uncertain?"；原提交结果仍未确认，请核对原订单。":""));}finally{attempt.inFlight=false;changedAttempts();mutation.current=false;setBusy(false);}
  };
  const execute=async(kind:"complete"|"ship")=>{
    if(!detail||busy||selectedLine.lineId||!businessToday||!date)return;
    const text=kind==="complete"?`确认生产完成？已上报 ${formatBusinessDecimal(detail.order.completedQuantity)} / ${formatBusinessDecimal(detail.order.quantity)} 件。请按实际完成情况确认。`:
      `确认已发货？款号 ${detail.order.firstStyleNo}，已登记产量 ${formatBusinessDecimal(detail.order.completedQuantity)} 件。此操作不会确认仓库收货。`;
    if(await confirmInApp(text,{confirmLabel:kind==="complete"?"确认生产完成":"确认已发货"}))await write(`/${productionOrderId}/${kind}`,{businessDate:date,confirmed:true},kind==="complete"?"已登记生产完成":"已登记发货，等待仓库实际收货");
  };
  const loadScopes=async()=>{const startedContext=readKey;try{const value=await request("/scopes",ProductionScopeDirectorySchema);if(context.current!==startedContext)return false;setDirectory({key:startedContext,value});setScopeRefreshPending(false);setScopeError("");setMessage(value=>value.includes("最新范围暂未读取")?"负责范围变更已保存，最新范围已读取。":value);return true;}catch(e){if(context.current===startedContext)setScopeError(e instanceof Error?e.message:"负责范围未能读取，请重新读取");return false;}};
  const saveScope=async(input:ProductionScopeInput)=>{
    const startedContext=readKey;
    if(scopeRefreshPending){setScopeError("负责范围已保存，请先重新读取负责范围；本次未重复提交。");return;}if(mutation.current||scopeRetry.current?.inFlight)return;mutation.current=true;setBusy(true);setScopeError("");setMessage("");
    const payload=JSON.stringify(input);if(scopeRetry.current?.uncertain&&scopeRetry.current.payload!==payload){setScopeError("上次负责范围提交结果尚未确认，请先读取原范围核对；重试时须保留原内容和请求标识。");mutation.current=false;setBusy(false);return;}if(scopeRetry.current?.payload!==payload)scopeRetry.current={payload,key:createClientRequestId(),startedAt:Date.now()};
    if(scopeRetry.current.uncertain&&Date.now()-scopeRetry.current.startedAt>=SUBMISSION_RECOVERY_WINDOW_MS){setScopeError("原提交已超出安全重试时间，请核对原负责范围；本次未重发，也不会另建请求标识。");mutation.current=false;setBusy(false);return;}
    const attempt=scopeRetry.current;attempt.inFlight=true;changedAttempts();
    try{await saveProductionScope(input,attempt.key);scopeRetry.current=null;setScopeRefreshPending(true);
      if(context.current!==startedContext)return;setMessage(input.active?"负责范围已保存":"负责范围已撤销");
      const refreshed=await loadScopes();if(context.current!==startedContext)return;if(!refreshed)setMessage("负责范围已保存，最新范围暂未读取；请重新读取负责范围，不要重复提交。");
    }catch(e){if(scopeRetry.current?.uncertain||unknownWriteResult(e)){if(scopeRetry.current)scopeRetry.current.uncertain=true;}else scopeRetry.current=null;if(context.current===startedContext)setScopeError((e instanceof Error?e.message:"负责范围提交结果尚未确认，请读取原范围核对")+(scopeRetry.current?.uncertain?"；原提交结果仍未确认，请读取原范围核对。":""));}finally{attempt.inFlight=false;changedAttempts();mutation.current=false;setBusy(false);}
  };
  const pendingProduction=retry.current&&(retry.current.uncertain||retry.current.inFlight)?JSON.parse(retry.current.payload) as {path:string;body:{factoryDecisionId?:string|null}}:null;
  const canRecoverProduction=Boolean(pendingProduction&&pendingProduction.path.startsWith(`/${productionOrderId}/`)&&(pendingProduction.body.factoryDecisionId??null)===factoryDecisionId);
  const recoverProduction=async()=>{if(!canRecoverProduction||!pendingProduction||busy)return;await write(pendingProduction.path,pendingProduction.body,"原生产提交已确认，最新办理状态已读取。",true);};
  const selectedLine=productionLineTarget(window.location.search,detail?.order.poDeliveryDates);
  const orderReturn=digitalDetailReturnUrl(new URLSearchParams(window.location.search).get("returnTo"),import.meta.env.BASE_URL);
  return <Shell active="生产数据填报"><main className="sourcing-workspace production-reporting">
    <Header iconRoute="/ui/production-reporting" title="生产数据填报" subtitle="按实际生产情况上报，系统自动累计。" badge="实时生产看板" />
    <a href={pageUrl("ui/production-dashboard")}><NavigationIcon route="/ui/production-dashboard" />实时看板</a>
    {error?<p role="alert" className="sourcing-delete-error">{error}</p>:null}
    {scopeError?<p role="alert" className="sourcing-delete-error">{scopeError}</p>:null}
    {canRecoverProduction?<section aria-label="原生产提交恢复"><p>原生产提交结果仍未确认。刷新后的业务阶段不会撤销原请求；请先用原内容核对结果，再办理下一步。</p><Button disabled={busy||loading||!detail||retry.current?.inFlight} onClick={()=>void recoverProduction()}>使用原内容核对生产提交</Button></section>:null}
    {message?<p role="status">{message}</p>:null}
    {productionOrderId?<a href={orderReturn??productionDisplayReturnUrl(new URLSearchParams(window.location.search).get("returnTo"))??pageUrl("ui/production-reporting")}>{orderReturn?"返回这张订单":productionDisplayReturnUrl(new URLSearchParams(window.location.search).get("returnTo"))?"返回实时生产展示":"返回生产订单"}</a>:null}
    <Button disabled={busy||loading} variant="secondary" onClick={()=>{void load();}}>刷新</Button>
    {loading?<p role="status">正在加载…</p>:null}
    {!productionOrderId?<>
      <Surface className="sourcing-list-card"><div className="sourcing-form-grid">
        <label>关键词<input aria-label="搜索生产订单" value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} placeholder="款号或供应商" maxLength={100}/></label>
        <label>供应商<SearchableSelect value={supplier} onChange={e=>{setSupplier(e.target.value);setPage(1);}}><option value="">全部负责供应商</option>{list?.suppliers.map(s=><option key={`${s.supplierId}:${s.supplierName}`} value={s.supplierId}>{s.supplierName}</option>)}</SearchableSelect></label>
        <label>生产状态<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">全部状态</option>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      </div><div className="sourcing-order-list">
        {list?.items.map(order=><Surface className="sourcing-order-card" key={`${order.productionOrderId}:${order.factoryDecisionId??"original"}`}><a className="sourcing-order-card__main" href={pageUrl(`ui/production-reporting/${order.productionOrderId}${order.factoryDecisionId?"?"+new URLSearchParams({factoryDecisionId:order.factoryDecisionId}):""}`)}>
          <div className="sourcing-order-card__heading"><div><strong>{order.firstStyleNo}</strong><span>{order.supplierName}</span></div><StatusBadge tone={order.status==="in_production"?"info":"success"}>{labels[order.status]}</StatusBadge></div>
          <dl><div><dt>累计生产</dt><dd>{formatBusinessDecimal(order.completedQuantity)} / {formatBusinessDecimal(order.quantity)} 件</dd></div><div><dt>交货日期</dt><dd>{order.deliveryDate??"未记录"}</dd></div><div><dt>合同编号</dt><dd>{order.contractNumber}</dd></div></dl>
          {order.reportingState?<span>待首次上报</span>:null}{order.sourceCaseArchived?<span>原外发单已删除 · 生产记录保留</span>:null}
        </a></Surface>)}
        {!loading&&list?.items.length===0?<p>暂无负责范围内的生产订单</p>:null}
      </div>{list?<ListPagination page={page} totalPages={Math.max(1,Math.ceil(list.totalCount/15))} onPageChange={setPage} busy={loading} ariaLabel="生产订单分页"/>:null}</Surface>
    </>:null}
    {detail&&selectedLine.error?<p role="alert">{selectedLine.error}</p>:detail?<>
      <Surface className="sourcing-list-card"><h2>{detail.order.firstStyleNo} · {detail.order.supplierName}</h2>
        <p>{labels[detail.order.status]} · 合同 {detail.order.contractNumber} · 交货日期 {detail.order.deliveryDate??"未记录"}</p>
        <p>累计生产 {formatBusinessDecimal(detail.order.completedQuantity)} / {formatBusinessDecimal(detail.order.quantity)} 件{detail.order.reportingState?" · 待首次上报":""}</p>
        {detail.order.sourceCaseArchived?<p>原外发单已删除，生产记录继续保留。</p>:null}
        <p>工艺：{detail.order.processes.join("、")}</p>
        {!businessToday?<p role="status">本单业务日期上限尚未读取，请刷新后再办理；已提交的原请求仍可核对结果。</p>:null}
        {(moduleCanWrite(user,"sourcing")&&detail.canReport)&&detail.order.status!=="shipped"?<div className="sourcing-form-grid"><label>业务日期<input type="date" value={date} max={businessToday} onChange={e=>setDate(e.target.value)} disabled={busy||!businessToday}/></label></div>:null}
        {detail.qcProgressOrderId&&<p><a href={productionDisplayDomainHref(pageUrl(`ui/digital-production?factory=${detail.qcProgressOrderId}&factoryAction=productionProgress${detail.order.factoryDecisionId?`&factoryDecisionId=${detail.order.factoryDecisionId}`:''}`),window.location.search)}>进入QC统一办理：生产进度、适用成品量与现场照片</a></p>}
        <div className="sourcing-order-list">{detail.order.lines.filter(line=>selectedLine.position===null||line.position===selectedLine.position).map(line=><Surface key={line.position} className="sourcing-order-card"><div className="production-reporting__line">
          <strong>{line.position}. {line.styleNo} · {line.color??"未记录颜色"}</strong>
          <p>累计 {formatBusinessDecimal(line.completedQuantity)} / {formatBusinessDecimal(line.quantity)} 件 · 剩余 {formatBusinessDecimal(line.quantity-line.completedQuantity)} 件</p>
          {(moduleCanWrite(user,"sourcing")&&detail.canReport)&&detail.order.status==="in_production"?<form className="sourcing-form-grid production-reporting__report" onSubmit={e=>{e.preventDefault();void write(`/${productionOrderId}/reports`,{position:line.position,businessDate:date,quantity:Number(quantities[line.position])},"本次产量已保存");}}>
            <label>本次新增数量 *<input type="number" inputMode="numeric" min={1} max={line.quantity-line.completedQuantity} step={1} required disabled={busy||line.quantity===line.completedQuantity} value={quantities[line.position]??""} onChange={e=>setQuantities(v=>({...v,[line.position]:e.target.value}))}/></label>
            <Button type="submit" disabled={busy||loading||Boolean(pendingProduction)||!businessToday||!date||!quantities[line.position]||line.quantity===line.completedQuantity}>保存上报</Button>
          </form>:null}
        </div></Surface>)}</div>
        {(moduleCanWrite(user,"sourcing")&&detail.canReport)&&!selectedLine.lineId&&detail.order.status==="in_production"?<Button disabled={busy||loading||Boolean(pendingProduction)||!businessToday||!date} onClick={()=>{void execute("complete");}}>生产完成</Button>:null}
        {(moduleCanWrite(user,"sourcing")&&detail.canReport)&&!selectedLine.lineId&&detail.order.status==="production_completed"?<Button disabled={busy||loading||Boolean(pendingProduction)||!businessToday||!date} onClick={()=>{void execute("ship");}}>登记发货</Button>:null}
        {selectedLine.lineId?<p>当前仅办理这个PO的日报。生产完成和发货涉及整单，请先<a href={(()=>{const query=new URLSearchParams(window.location.search);query.delete("line");return `${window.location.pathname}${query.size?`?${query}`:""}`;})()}>查看全部PO</a>再确认。</p>:null}
        {detail.shipment?<p>发货款号 {detail.shipment.firstStyleNo} · {detail.shipment.shippedOn} · 发货时登记产量 {formatBusinessDecimal(detail.shipment.recordedQuantity)} 件（仓库收货另行记录）</p>:null}
      </Surface>
      <Surface className="sourcing-list-card"><details><summary>生产历史（{detail.history.length} 条）</summary>
        {detail.history.map(h=><div className="production-reporting__history" key={h.reportId}><strong>{detail.order.lines.find(l=>l.position===h.position)?.styleNo} · {h.businessDate} · {formatBusinessDecimal(h.quantity)} 件</strong>
          <p>{h.actorName} · {shanghaiBusinessTime(h.createdAt)} · {h.revision===1?"原始上报":"Root修正"}{h.effective?" · 当前有效":" · 已被修正"}</p>{h.reason?<p>原因：{h.reason}</p>:null}
          {detail.canCorrect&&h.effective?<Button variant="secondary" disabled={busy} onClick={()=>{setCorrecting(h);setCorrectionQuantity(String(h.quantity));setCorrectionDate(h.businessDate);setReason("");}}>Root 修正</Button>:null}
        </div>)}
        {detail.transitions.map((t,i)=><p key={i}>{labels[t.status as keyof typeof labels]??t.status} · {t.businessDate} · {t.actorName} · 记录于 {shanghaiBusinessTime(t.createdAt)}</p>)}
      </details></Surface>
      {detail.canCorrect&&correcting?<Surface className="sourcing-list-card"><h2>Root 修正原始上报</h2><p>原记录保留；以下数量替换该条记录的有效数量。</p>
        <form className="sourcing-form-grid" onSubmit={e=>{e.preventDefault();void write(`/${productionOrderId}/reports/${correcting.rootReportId}/corrections`,{expectedReportId:correcting.reportId,businessDate:correctionDate,quantity:Number(correctionQuantity),reason},"修正已保存，原记录保留");}}>
          <label>修正后数量 *<input required type="number" min={0} step={1} value={correctionQuantity} onChange={e=>setCorrectionQuantity(e.target.value)} disabled={busy}/></label>
          <label>业务日期 *<input required type="date" max={businessToday} value={correctionDate} onChange={e=>setCorrectionDate(e.target.value)} disabled={busy||!businessToday}/></label>
          <label>修正原因 *<input required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}/></label>
          <div className="production-reporting__actions"><Button type="submit" disabled={busy||Boolean(pendingProduction)||!businessToday||!reason.trim()}>保存修正</Button><Button variant="secondary" disabled={busy} onClick={()=>setCorrecting(null)}>取消</Button></div>
        </form></Surface>:null}
    </>:null}
    {user?.isRoot?<Surface className="sourcing-list-card"><details onToggle={e=>{if(e.currentTarget.open&&!directory)void loadScopes();}}><summary>驻厂人员负责范围</summary><Button disabled={busy} onClick={()=>{void loadScopes();}}>重新读取负责范围</Button>
      <p>先在“人员与权限”分配驻厂生产填报角色，再配置负责范围。</p>
      <form className="sourcing-form-grid" onSubmit={e=>{e.preventDefault();void saveScope({userId:scopeUser,scopeType:productionOrderId&&!scopeSupplier?"order":"supplier",scopeId:scopeSupplier||productionOrderId||"",active:true});}}>
        <label>驻厂人员 *<SearchableSelect required value={scopeUser} onChange={e=>setScopeUser(e.target.value)}><option value="">请选择</option>{directory?.users.map(u=><option key={u.userId} value={u.userId}>{u.displayName}</option>)}</SearchableSelect></label>
        <label>负责范围{!productionOrderId ? " *" : "（选填）"}<SearchableSelect required={!productionOrderId} value={scopeSupplier} onChange={e=>setScopeSupplier(e.target.value)}><option value="">{productionOrderId?"仅当前订单":"请选择供应商"}</option>{directory?.suppliers.map(s=><option key={s.supplierId} value={s.supplierId}>{s.supplierName}</option>)}</SearchableSelect></label>
        <Button type="submit" disabled={busy||!scopeUser||(!scopeSupplier&&!productionOrderId)}>保存负责范围</Button>
      </form>
      {directory?.scopes.map(s=><p key={`${s.userId}:${s.scopeType}:${s.scopeId}`}>{directory.users.find(u=>u.userId===s.userId)?.displayName??"已撤销角色人员"} · {s.scopeLabel} <Button variant="secondary" disabled={busy} onClick={()=>{void confirmInApp("确认撤销该负责范围？").then(ok=>{if(ok)void saveScope({userId:s.userId,scopeType:s.scopeType,scopeId:s.scopeId,active:false});});}}>撤销</Button></p>)}
    </details></Surface>:null}
  </main></Shell>;
}

export {request as productionReportingRequest};
