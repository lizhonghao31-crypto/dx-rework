import { useEffect, useState } from "react";
import { ReceivedQuantityLabel } from "./received-quantity-label.js";
import { z } from "zod";
import { ProductionPilotListSchema,ProductionExpectedReceiptsSchema,ProductionReceivingSummarySchema,type ProductionReceivingSummary } from "@dx-rework/contracts";
import { Button, Surface } from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";
import { verifySession } from "./auth.js";
import { ListPagination } from "./list-pagination.js";
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
async function read<T>(path:string,schema:z.ZodType<T>,signal?:AbortSignal){
 const response=await fetch(apiUrl(`production-closure/${path}`),{credentials:"include",cache:"no-store",...(signal?{signal}:{})});
 const body=await response.json();if(!response.ok)throw new Error(body?.error?.message??"生产信息加载失败");return schema.parse(body);
}
export function ProductionPilotControls(){
 const [root,setRoot]=useState(false),[open,setOpen]=useState(false),[data,setData]=useState<z.infer<typeof ProductionPilotListSchema>|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;void verifySession().then(s=>{if(live)setRoot(s!=="denied"&&s.user.isRoot===true);}).catch(()=>undefined);return()=>{live=false;};},[]);
 const load=async()=>{try{setData(await read("pilots",ProductionPilotListSchema));}catch(e){setError(e instanceof Error?e.message:"加载失败");}};
 if(!root)return null;
 return <Surface className={`sourcing-list-card production-admin-tool${open?' is-open':''}`}><Button className="ui-disclosure-trigger" aria-expanded={open} variant="secondary" disabled={busy} onClick={()=>{setOpen(!open);if(!open)void load();}}>供应商试点设置</Button>
  {open?<><p>按供应商启用生产风险待办和回货关联。关闭后停止新增待办与关联，保留已记录的业务历史。</p>
   {error?<p role="alert">{error}</p>:null}<div className="sourcing-form-grid">{data?.suppliers.map(s=><label key={s.supplierId}>{s.supplierName}
    <select disabled={busy} value={s.enabled?"on":"off"} onChange={async e=>{setBusy(true);setError("");try{
     const response=await fetch(apiUrl("production-closure/pilots"),{method:"PUT",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({supplierId:s.supplierId,enabled:e.target.value==="on"})});
     if(!response.ok){const body=await response.json();throw new Error(body?.error?.message??"设置失败");}await load();
    }catch(e){setError(e instanceof Error?e.message:"设置失败");}finally{setBusy(false);}}}><option value="off">未启用</option><option value="on">已启用</option></select></label>)}</div></>:null}
 </Surface>;
}
export function ProductionExpectedPicker({value,onSelect,disabled=false}:{disabled?:boolean;value:string;onSelect:(shipment:ProductionReceivingSummary|null)=>void}){
 const [q,setQ]=useState(""),[page,setPage]=useState(1),[data,setData]=useState<z.infer<typeof ProductionExpectedReceiptsSchema>|null>(null),[error,setError]=useState(""),[open,setOpen]=useState(false);
 const [selected,setSelected]=useState<ProductionReceivingSummary|null>(null);
 useEffect(()=>{if(!open)return;const controller=new AbortController();const timer=setTimeout(()=>{void read(`expected-receipts?${new URLSearchParams({q,page:String(page)})}`,ProductionExpectedReceiptsSchema,controller.signal)
  .then(result=>{setData(result);setError("");}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:"加载失败");});},200);
  return()=>{clearTimeout(timer);controller.abort();};},[open,q,page]);
 return <Surface className="receiving-form-card"><Button disabled={disabled} variant="secondary" onClick={()=>setOpen(!open)}>关联生产发货单（选填）</Button>
  {value&&selected?<p>已选：{selected.firstStyleNo} · {selected.supplierName} · 合同 {selected.contractNumber} · {selected.shippedOn} <Button disabled={disabled} variant="secondary" onClick={()=>{setSelected(null);onSelect(null);}}>取消关联</Button></p>:null}
  {open?<><p>仅预填首款款号。送货单数量和实际收货数量请按本次到货填写。</p>
   <label className="receiving-field">搜索款号或供应商<input disabled={disabled} maxLength={100} value={q} onChange={e=>{setQ(e.target.value);setPage(1);}}/></label>
   {error?<p role="alert">{error}</p>:null}
   {data?.items.map(s=><div key={s.productionOrderId}><Button disabled={disabled} variant="secondary" onClick={()=>{setSelected(s);onSelect(s);setOpen(false);}}>{s.firstStyleNo} · {s.supplierName} · 合同 {s.contractNumber} · {s.shippedOn} · 预计 {s.expectedQuantity} 件 · 已关联 {s.receipts.filter(r=>!r.archived).length} 次收货</Button></div>)}
   {data&&data.totalCount===0?<p>没有匹配的试点发货单。</p>:null}
   {data?<ListPagination page={page} totalPages={Math.max(1,Math.ceil(data.totalCount/15))} onPageChange={setPage} ariaLabel="预期回货分页"/>:null}</>:null}
 </Surface>;
}
export function ProductionReceiptSummary({productionOrderId,refreshKey}:{productionOrderId:string;refreshKey?:string|undefined}){
 const [data,setData]=useState<ProductionReceivingSummary|null>(null),[error,setError]=useState("");
 useEffect(()=>{const controller=new AbortController();void read(`orders/${productionOrderId}/receipts`,z.object({shipment:ProductionReceivingSummarySchema.nullable()}),controller.signal)
  .then(result=>{setData(result.shipment);setError("");}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:"回货信息加载失败");});return()=>controller.abort();},[productionOrderId,refreshKey]);
 if(error)return <p role="alert">{error}</p>;if(!data)return null;
 return <Surface className="sourcing-list-card"><h2>发货与实际回货</h2><p>{data.shippedOn} 已发货 · 首款 {data.firstStyleNo} · 预计 {data.expectedQuantity} 件</p>
  <p>发货不代表仓库已收货。以下为仓库关联的实收记录；批次汇总调整仍以订单回货页面为准。</p>
  {data.receipts.length?data.receipts.map(r=><p key={r.receiptId}>{new Date(r.receivedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})} · <ReceivedQuantityLabel>实收</ReceivedQuantityLabel> {r.actualQuantity} 件{r.archived?" · 批次已归档":""}</p>):<p>尚无关联的实际收货记录。</p>}
 </Surface>;
}

