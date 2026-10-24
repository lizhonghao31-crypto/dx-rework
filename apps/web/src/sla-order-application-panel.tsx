import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import {DIGITAL_SLA_PARAMETERS} from '@dx-rework/contracts/digital-sla';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
type NodeTime={forecast:{at:string|null;reasons:string[]};deadline:{at:string|null};status:string;actualStart:string|null};
type Preview={orderId:string;token:string;configurationVersion:number;changes:{nodeId:string;label:string;before:NodeTime;after:NodeTime}[];skipped:string[]};
type Row={preview?:Preview;key?:string;state:'previewed'|'failed'|'unknown'|'applied';message?:string;body?:unknown};
const date=(at:string|null)=>at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'无可靠预计';
export function SlaOrderApplicationPanel({version,parameterKeys,disabled,onPendingChange}:{version:number;parameterKeys:string[];disabled:boolean;onPendingChange(value:boolean):void}){
 const [orders,setOrders]=useState<DigitalOrder[]>([]),[query,setQuery]=useState(''),[page,setPage]=useState(1),[selection,setSelection]=useState<string[]>([]),[reason,setReason]=useState(''),[rows,setRows]=useState<Record<string,Row>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const running=useRef(false),live=useRef(true);
 const keyString=JSON.stringify([...parameterKeys].sort()),unknown=Object.values(rows).some(r=>r.state==='unknown');
 useEffect(()=>{if(!unknown)setRows({});},[version,keyString,reason]);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 useEffect(()=>{onPendingChange(busy||unknown);return()=>onPendingChange(false);},[busy,unknown,onPendingChange]);
 useEffect(()=>{const listener=(e:BeforeUnloadEvent)=>{if(unknown||busy){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',listener);return()=>window.removeEventListener('beforeunload',listener);},[unknown,busy]);
 const search=async(nextPage=1)=>{try{const result=await digitalRequest<{items:DigitalOrder[]}>(`orders?page=${nextPage}&search=${encodeURIComponent(query)}`);setOrders(result.items);setPage(nextPage);}catch(e){setError(e instanceof Error?e.message:'读取失败');}};
 const run=async(apply:boolean)=>{
  if(running.current)return;running.current=true;setBusy(true);setError('');
  try{for(const orderId of selection){
   const prior=rows[orderId];if(prior?.state==='applied')continue;
   const body={orderId,configurationVersion:version,parameterKeys,reason:reason.trim()};
   if(apply&&(!prior?.preview||!['previewed','unknown'].includes(prior.state)))continue;
   try{
    if(apply){
     const exact=prior?.body??{...body,previewToken:prior!.preview!.token},key=prior?.key??createClientRequestId();
     setRows(r=>({...r,[orderId]:{...prior!,body:exact,key}}));
     try{const result=await digitalRequest<{orderId:string;applicationId:string}>('sla-settings/orders/apply','POST',exact,key);if(result.orderId!==orderId||!result.applicationId)throw new DigitalRequestError('提交结果不完整',null);setRows(r=>({...r,[orderId]:{...r[orderId]!,state:'applied',message:'已应用，原起点及历史保留'}}));}
     catch(e){setRows(r=>({...r,[orderId]:{...r[orderId]!,state:e instanceof DigitalRequestError&&e.resultUnknown?'unknown':'failed',message:e instanceof Error?e.message:'应用失败'}}));}
    }else{
     const preview=await digitalRequest<Preview>('sla-settings/orders/preview','POST',body);if(!preview.token||preview.orderId!==orderId||!Array.isArray(preview.changes))throw new Error('预览返回不完整');
     setRows(r=>({...r,[orderId]:{preview,state:'previewed'}}));
    }
   }catch(e){setRows(r=>({...r,[orderId]:{state:'failed',message:e instanceof Error?e.message:'本单未能预览'}}));}
  }}finally{running.current=false;if(live.current)setBusy(false);}
 };
 const locked=disabled||busy||unknown;
 return <details className="sla-settings-help"><summary>指定在途订单应用现行标准</summary>
  <p>仅应用已发布的 v{version}。先在上方勾选节点，再选择订单；已有订单或客户特例保留，已完成节点不改。</p>
  {disabled&&<p>请先处理上方未发布草稿，再应用现行标准。</p>}
  <p>已选参数：{parameterKeys.map(k=>DIGITAL_SLA_PARAMETERS.find(p=>p.key===k)?.label).join('、')||'尚未选择'}</p>
  {error&&<p role="alert">{error}</p>}
  <div className="sla-standard-toolbar"><label>查找订单<input value={query} disabled={locked} onChange={e=>setQuery(e.target.value)}/></label><Button variant="secondary" disabled={locked} onClick={()=>void search()}>查找</Button></div>
  <ul className="sla-standard-rows">{orders.map(order=><li key={order.productionOrderId}><label><input type="checkbox" disabled={locked||selection.length>=20&&!selection.includes(order.productionOrderId)||rows[order.productionOrderId]?.state==='applied'} checked={selection.includes(order.productionOrderId)} onChange={e=>setSelection(s=>e.target.checked?[...s,order.productionOrderId]:s.filter(id=>id!==order.productionOrderId))}/>{order.designStyleNo} · {order.customerCode}</label></li>)}</ul>
  {!!orders.length&&<div className="sla-standard-toolbar"><Button variant="secondary" disabled={locked||page===1} onClick={()=>void search(page-1)}>上一页</Button><span>第 {page} 页</span><Button variant="secondary" disabled={locked} onClick={()=>void search(page+1)}>下一页</Button></div>}
  <label className="sla-change-reason">本次应用原因<input value={reason} disabled={locked} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
  <Button disabled={locked||!selection.length||!parameterKeys.length||!reason.trim()} onClick={()=>void run(false)}>预览选定订单（{selection.length}）</Button>
  <div aria-live="polite">{selection.map(id=>rows[id]&&<details key={id} className="sla-publish-preview"><summary>{orders.find(o=>o.productionOrderId===id)?.designStyleNo??'已选订单'} · {({previewed:'可应用',failed:'未应用',unknown:'结果待确认',applied:'已应用'})[rows[id]!.state]}</summary>{rows[id]!.message&&<p>{rows[id]!.message}</p>}{rows[id]!.preview?.changes.map(c=><div key={c.nodeId}><strong>{c.label}</strong><p>预计完成：{date(c.before.forecast.at)} → {date(c.after.forecast.at)}</p>{c.before.deadline.at!==c.after.deadline.at&&<p>截止：{date(c.before.deadline.at)} → {date(c.after.deadline.at)}</p>}{c.after.forecast.reasons.length>0&&<p>{c.after.forecast.reasons.join('；')}</p>}</div>)}{!!rows[id]!.preview?.skipped.length&&<p>已有合法订单/客户特例保持不变。</p>}</details>)}</div>
  {Object.values(rows).some(r=>r.state==='previewed'||r.state==='unknown')&&<Button disabled={busy||disabled} onClick={()=>void run(true)}>{unknown?'用原命令确认未明结果':'确认逐单应用'}</Button>}
  {Object.values(rows).some(r=>r.state==='applied')&&<p role="status">已应用 {Object.values(rows).filter(r=>r.state==='applied').length} 单；未应用或未确认 {selection.filter(id=>rows[id]?.state!=='applied').length} 单。</p>}
 </details>;
}
