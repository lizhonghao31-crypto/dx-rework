import { productionDisplayReturnUrl } from "./production-display-context.js";
import { moduleCanWrite } from "./member-module-policy.js";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { ProductionReportingDetailSchema, ProductionReportingListSchema, ProductionScopeDirectorySchema,
  type ProductionReportingDetail, type ProductionScopeInput } from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { Header, Shell } from "./components.js";
import { verifySession, type AuthorizedUser } from "./auth.js";
import { ListPagination } from "./list-pagination.js";
import { createClientRequestId } from "./client-request-id.js";
import { confirmInApp } from "./system-dialog.js";
import { createWebUrls } from "../url-contract.js";
import "./sourcing-workspace.css";
import "./production-reporting-page.css";
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const labels={in_production:"生产中",production_completed:"生产完成",shipped:"已发货"} as const;
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
async function request<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}) {
  const response=await fetch(apiUrl(`production-reporting${path}`),{credentials:"include",cache:"no-store",...init,
    headers:{accept:"application/json",...(init.body?{"content-type":"application/json"}:{}),...init.headers}});
  const body=await response.json();if(!response.ok)throw new Error(body?.error?.message??"操作失败，请重试");
  return schema.parse(body);
}
export function ProductionReportingPage({productionOrderId}:{productionOrderId?:string|undefined}) {
  const [user,setUser]=useState<AuthorizedUser|null>(null),[error,setError]=useState(""),[message,setMessage]=useState("");
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[page,setPage]=useState(1);
  const [q,setQ]=useState(""),[supplier,setSupplier]=useState(""),[status,setStatus]=useState("");
  const [list,setList]=useState<z.infer<typeof ProductionReportingListSchema>|null>(null);
  const [detail,setDetail]=useState<ProductionReportingDetail|null>(null);
  const [quantities,setQuantities]=useState<Record<number,string>>({}),[date,setDate]=useState(today);
  const [correcting,setCorrecting]=useState<ProductionReportingDetail["history"][number]|null>(null);
  const [correctionQuantity,setCorrectionQuantity]=useState(""),[correctionDate,setCorrectionDate]=useState(today),[reason,setReason]=useState("");
  const [directory,setDirectory]=useState<z.infer<typeof ProductionScopeDirectorySchema>|null>(null);
  const [scopeUser,setScopeUser]=useState(""),[scopeSupplier,setScopeSupplier]=useState("");
  const mutation=useRef(false), retry=useRef<{payload:string;key:string}|null>(null),version=useRef(0);
  useEffect(()=>{void verifySession().then(s=>{if(s!=="denied"&&s.status==="authorized")setUser(s.user);});},[]);
  const load=async()=>{
    const current=++version.current;setLoading(true);setError("");
    try {
      if(productionOrderId){const result=await request(`/${productionOrderId}`,ProductionReportingDetailSchema);if(current===version.current)setDetail(result);}
      else {const params=new URLSearchParams({page:String(page)});if(q.trim())params.set("q",q.trim());if(supplier)params.set("supplierId",supplier);if(status)params.set("status",status);
        const result=await request(`?${params}`,ProductionReportingListSchema);if(current===version.current)setList(result);}
    }catch(e){if(current===version.current)setError(e instanceof Error?e.message:"加载失败");}
    finally{if(current===version.current)setLoading(false);}
  };
  useEffect(()=>{const timer=setTimeout(()=>{void load();},q?250:0);return()=>{clearTimeout(timer);version.current++;};},[productionOrderId,page,q,supplier,status]);
  const write=async(path:string,body:unknown,success:string)=>{
    if(mutation.current)return;mutation.current=true;setBusy(true);setError("");setMessage("");
    const payload=JSON.stringify({path,body});if(retry.current?.payload!==payload)retry.current={payload,key:createClientRequestId()};
    try {const result=await request(path,ProductionReportingDetailSchema,{method:"POST",body:JSON.stringify(body),headers:{"idempotency-key":retry.current.key}});
      setDetail(result);retry.current=null;setMessage(success);setQuantities({});setCorrecting(null);
    }catch(e){setError(e instanceof Error?e.message:"保存失败");}finally{mutation.current=false;setBusy(false);}
  };
  const execute=async(kind:"complete"|"ship")=>{
    if(!detail||busy)return;
    const text=kind==="complete"?`确认生产完成？已上报 ${formatBusinessDecimal(detail.order.completedQuantity)} / ${formatBusinessDecimal(detail.order.quantity)} 件。请按实际完成情况确认。`:
      `确认已发货？款号 ${detail.order.firstStyleNo}，已登记产量 ${formatBusinessDecimal(detail.order.completedQuantity)} 件。此操作不会确认仓库收货。`;
    if(await confirmInApp(text,{confirmLabel:kind==="complete"?"确认生产完成":"确认已发货"}))await write(`/${productionOrderId}/${kind}`,{businessDate:date,confirmed:true},kind==="complete"?"已登记生产完成":"已登记发货，等待仓库实际收货");
  };
  const loadScopes=async()=>{try{setDirectory(await request("/scopes",ProductionScopeDirectorySchema));}catch(e){setError(e instanceof Error?e.message:"加载失败");}};
  const saveScope=async(input:ProductionScopeInput)=>{
    if(mutation.current)return;mutation.current=true;setBusy(true);setError("");
    try{const response=await fetch(apiUrl("production-reporting/scopes"),{method:"POST",credentials:"include",headers:{"content-type":"application/json","idempotency-key":createClientRequestId()},body:JSON.stringify(input)});
      if(!response.ok){const body=await response.json();throw new Error(body?.error?.message??"负责范围保存失败");}
      await loadScopes();setMessage(input.active?"负责范围已保存":"负责范围已撤销");
    }catch(e){setError(e instanceof Error?e.message:"保存失败");}finally{mutation.current=false;setBusy(false);}
  };
  return <Shell active="生产数据填报"><main className="sourcing-workspace production-reporting">
    <Header iconRoute="/ui/production-reporting" title="生产数据填报" subtitle="按实际生产情况上报，系统自动累计。" badge="实时生产看板" />
    <a href={pageUrl("ui/production-dashboard")}><NavigationIcon route="/ui/production-dashboard" />实时看板</a>
    {error?<p role="alert" className="sourcing-delete-error">{error}</p>:null}
    {message?<p role="status">{message}</p>:null}
    {productionOrderId?<a href={productionDisplayReturnUrl(new URLSearchParams(window.location.search).get("returnTo"))??pageUrl("ui/production-reporting")}>{productionDisplayReturnUrl(new URLSearchParams(window.location.search).get("returnTo"))?"返回实时生产展示":"返回生产订单"}</a>:null}
    <Button disabled={busy||loading} variant="secondary" onClick={()=>{void load();}}>刷新</Button>
    {loading?<p role="status">正在加载…</p>:null}
    {!productionOrderId?<>
      <Surface className="sourcing-list-card"><div className="sourcing-form-grid">
        <label>关键词<input aria-label="搜索生产订单" value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} placeholder="款号或供应商" maxLength={100}/></label>
        <label>供应商<select value={supplier} onChange={e=>{setSupplier(e.target.value);setPage(1);}}><option value="">全部负责供应商</option>{list?.suppliers.map(s=><option key={`${s.supplierId}:${s.supplierName}`} value={s.supplierId}>{s.supplierName}</option>)}</select></label>
        <label>生产状态<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">全部状态</option>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      </div><div className="sourcing-order-list">
        {list?.items.map(order=><Surface className="sourcing-order-card" key={order.productionOrderId}><a className="sourcing-order-card__main" href={pageUrl(`ui/production-reporting/${order.productionOrderId}`)}>
          <div className="sourcing-order-card__heading"><div><strong>{order.firstStyleNo}</strong><span>{order.supplierName}</span></div><StatusBadge tone={order.status==="in_production"?"info":"success"}>{labels[order.status]}</StatusBadge></div>
          <dl><div><dt>累计生产</dt><dd>{formatBusinessDecimal(order.completedQuantity)} / {formatBusinessDecimal(order.quantity)} 件</dd></div><div><dt>交货日期</dt><dd>{order.deliveryDate??"未记录"}</dd></div><div><dt>合同编号</dt><dd>{order.contractNumber}</dd></div></dl>
          {order.reportingState?<span>待首次上报</span>:null}{order.sourceCaseArchived?<span>原外发单已删除 · 生产记录保留</span>:null}
        </a></Surface>)}
        {!loading&&list?.items.length===0?<p>暂无负责范围内的生产订单</p>:null}
      </div>{list?<ListPagination page={page} totalPages={Math.max(1,Math.ceil(list.totalCount/15))} onPageChange={setPage} busy={loading} ariaLabel="生产订单分页"/>:null}</Surface>
    </>:null}
    {detail?<>
      <Surface className="sourcing-list-card"><h2>{detail.order.firstStyleNo} · {detail.order.supplierName}</h2>
        <p>{labels[detail.order.status]} · 合同 {detail.order.contractNumber} · 交货日期 {detail.order.deliveryDate??"未记录"}</p>
        <p>累计生产 {formatBusinessDecimal(detail.order.completedQuantity)} / {formatBusinessDecimal(detail.order.quantity)} 件{detail.order.reportingState?" · 待首次上报":""}</p>
        {detail.order.sourceCaseArchived?<p>原外发单已删除，生产记录继续保留。</p>:null}
        <p>工艺：{detail.order.processes.join("、")}</p>
        {(moduleCanWrite(user,"sourcing")&&detail.canReport)&&detail.order.status!=="shipped"?<div className="sourcing-form-grid"><label>业务日期<input type="date" value={date} max={today()} onChange={e=>setDate(e.target.value)} disabled={busy}/></label></div>:null}
        <div className="sourcing-order-list">{detail.order.lines.map(line=><Surface key={line.position} className="sourcing-order-card"><div className="production-reporting__line">
          <strong>{line.position}. {line.styleNo} · {line.color??"未记录颜色"}</strong>
          <p>累计 {formatBusinessDecimal(line.completedQuantity)} / {formatBusinessDecimal(line.quantity)} 件 · 剩余 {formatBusinessDecimal(line.quantity-line.completedQuantity)} 件</p>
          {(moduleCanWrite(user,"sourcing")&&detail.canReport)&&detail.order.status==="in_production"?<form className="sourcing-form-grid production-reporting__report" onSubmit={e=>{e.preventDefault();void write(`/${productionOrderId}/reports`,{position:line.position,businessDate:date,quantity:Number(quantities[line.position])},"本次产量已保存");}}>
            <label>本次新增数量<input type="number" inputMode="numeric" min={1} max={line.quantity-line.completedQuantity} step={1} required disabled={busy||line.quantity===line.completedQuantity} value={quantities[line.position]??""} onChange={e=>setQuantities(v=>({...v,[line.position]:e.target.value}))}/></label>
            <Button type="submit" disabled={busy||loading||!date||!quantities[line.position]||line.quantity===line.completedQuantity}>保存上报</Button>
          </form>:null}
        </div></Surface>)}</div>
        {(moduleCanWrite(user,"sourcing")&&detail.canReport)&&detail.order.status==="in_production"?<Button disabled={busy||loading||!date} onClick={()=>{void execute("complete");}}>生产完成</Button>:null}
        {(moduleCanWrite(user,"sourcing")&&detail.canReport)&&detail.order.status==="production_completed"?<Button disabled={busy||loading||!date} onClick={()=>{void execute("ship");}}>登记发货</Button>:null}
        {detail.shipment?<p>发货款号 {detail.shipment.firstStyleNo} · {detail.shipment.shippedOn} · 发货时登记产量 {formatBusinessDecimal(detail.shipment.recordedQuantity)} 件（仓库收货另行记录）</p>:null}
      </Surface>
      <Surface className="sourcing-list-card"><details><summary>生产历史（{detail.history.length} 条）</summary>
        {detail.history.map(h=><div className="production-reporting__history" key={h.reportId}><strong>{detail.order.lines.find(l=>l.position===h.position)?.styleNo} · {h.businessDate} · {formatBusinessDecimal(h.quantity)} 件</strong>
          <p>{h.actorName} · {new Date(h.createdAt).toLocaleString("zh-CN")} · {h.revision===1?"原始上报":"Root修正"}{h.effective?" · 当前有效":" · 已被修正"}</p>{h.reason?<p>原因：{h.reason}</p>:null}
          {detail.canCorrect&&h.effective?<Button variant="secondary" disabled={busy} onClick={()=>{setCorrecting(h);setCorrectionQuantity(String(h.quantity));setCorrectionDate(h.businessDate);setReason("");}}>Root 修正</Button>:null}
        </div>)}
        {detail.transitions.map((t,i)=><p key={i}>{labels[t.status as keyof typeof labels]??t.status} · {t.businessDate} · {t.actorName} · 记录于 {new Date(t.createdAt).toLocaleString("zh-CN")}</p>)}
      </details></Surface>
      {detail.canCorrect&&correcting?<Surface className="sourcing-list-card"><h2>Root 修正原始上报</h2><p>原记录保留；以下数量替换该条记录的有效数量。</p>
        <form className="sourcing-form-grid" onSubmit={e=>{e.preventDefault();void write(`/${productionOrderId}/reports/${correcting.rootReportId}/corrections`,{expectedReportId:correcting.reportId,businessDate:correctionDate,quantity:Number(correctionQuantity),reason},"修正已保存，原记录保留");}}>
          <label>修正后数量<input required type="number" min={0} step={1} value={correctionQuantity} onChange={e=>setCorrectionQuantity(e.target.value)} disabled={busy}/></label>
          <label>业务日期<input required type="date" max={today()} value={correctionDate} onChange={e=>setCorrectionDate(e.target.value)} disabled={busy}/></label>
          <label>修正原因<input required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}/></label>
          <div className="production-reporting__actions"><Button type="submit" disabled={busy||!reason.trim()}>保存修正</Button><Button variant="secondary" disabled={busy} onClick={()=>setCorrecting(null)}>取消</Button></div>
        </form></Surface>:null}
    </>:null}
    {user?.isRoot?<Surface className="sourcing-list-card"><details onToggle={e=>{if(e.currentTarget.open&&!directory)void loadScopes();}}><summary>驻厂人员负责范围</summary>
      <p>先在“人员与权限”分配驻厂生产填报角色，再配置负责范围。</p>
      <form className="sourcing-form-grid" onSubmit={e=>{e.preventDefault();void saveScope({userId:scopeUser,scopeType:productionOrderId&&!scopeSupplier?"order":"supplier",scopeId:scopeSupplier||productionOrderId||"",active:true});}}>
        <label>驻厂人员<select required value={scopeUser} onChange={e=>setScopeUser(e.target.value)}><option value="">请选择</option>{directory?.users.map(u=><option key={u.userId} value={u.userId}>{u.displayName}</option>)}</select></label>
        <label>负责范围<select required={!productionOrderId} value={scopeSupplier} onChange={e=>setScopeSupplier(e.target.value)}><option value="">{productionOrderId?"仅当前订单":"请选择供应商"}</option>{directory?.suppliers.map(s=><option key={s.supplierId} value={s.supplierId}>{s.supplierName}</option>)}</select></label>
        <Button type="submit" disabled={busy||!scopeUser||(!scopeSupplier&&!productionOrderId)}>保存负责范围</Button>
      </form>
      {directory?.scopes.map(s=><p key={`${s.userId}:${s.scopeType}:${s.scopeId}`}>{directory.users.find(u=>u.userId===s.userId)?.displayName??"已撤销角色人员"} · {s.scopeLabel} <Button variant="secondary" disabled={busy} onClick={()=>{void confirmInApp("确认撤销该负责范围？").then(ok=>{if(ok)void saveScope({userId:s.userId,scopeType:s.scopeType,scopeId:s.scopeId,active:false});});}}>撤销</Button></p>)}
    </details></Surface>:null}
  </main></Shell>;
}
