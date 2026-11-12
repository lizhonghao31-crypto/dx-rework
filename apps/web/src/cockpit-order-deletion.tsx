import {useRef,useState,useEffect} from 'react';
import {Button} from '@dx-rework/ui';
import {WholeOrderDeletionPreviewSchema,WholeOrderDeletionResultSchema,type WholeOrderDeletionPreview,type WholeOrderDeletionResult} from '@dx-rework/contracts/whole-order-deletion';
import {digitalRequest} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {CockpitHomeDialog} from './cockpit-home-dialog.js';
import './cockpit-order-deletion.css';

export function CockpitOrderDeletion({ids,onClose,onCommitted}:{ids:string[];onClose:()=>void;onCommitted:()=>void}){
 const [preview,setPreview]=useState<WholeOrderDeletionPreview|null>(null),[result,setResult]=useState<WholeOrderDeletionResult|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const active=useRef(true),running=useRef(false),key=useRef(createClientRequestId());
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 useEffect(()=>{let current=true;setPreview(null);setError('');void digitalRequest('whole-orders/delete-preview','POST',{ids}).then(value=>{if(current)setPreview(WholeOrderDeletionPreviewSchema.parse(value));}).catch(error=>{if(current)setError(error instanceof Error?error.message:'读取失败，请重试');});return()=>{current=false;};},[reload]);
 const submit=async()=>{
  if(!preview||running.current)return;running.current=true;setBusy(true);setError('');
  try{
   const response=WholeOrderDeletionResultSchema.parse(await digitalRequest('whole-orders/delete','POST',{orders:preview.orders.map(({id,revision})=>({id,revision}))},key.current));
   if(!active.current)return;setResult(response);
   if(response.results.some(item=>item.status==='deleted'||item.status==='already_deleted'))onCommitted();
  }catch(error){if(active.current)setError((error instanceof Error?error.message:'未收到删除结果')+'。可用原操作核对结果，不会重复删除。');}
  finally{running.current=false;if(active.current)setBusy(false);}
 };
 const counts:Record<string,number>={};for(const order of preview?.orders??[])for(const [kind,count]of Object.entries(order.counts))counts[kind]=(counts[kind]??0)+count;
 const complete=Boolean(result?.results.every(item=>item.status==='deleted'||item.status==='already_deleted'));
 return <CockpitHomeDialog busy={busy} title={`删除 ${preview?.orders.length??ids.length} 张订单？`} onClose={()=>{if(!running.current)onClose();}}>
  <div className="cockpit-delete-content">
   <p>将同时删除以下订单及其关联业务单。</p>
   {!preview&&!error&&<p role="status">正在核对关联范围…</p>}
   {error&&<p role="alert">{error}</p>}
   {preview&&<><ul className="cockpit-delete-orders">{preview.orders.map(order=><li key={order.id}><strong>{order.label}</strong><span>{order.customer??'未登记客户'} · {order.poCount} 个 PO{order.deleted?' · 已删除':''}</span></li>)}</ul>
    <h3>本次关联范围</h3><div className="cockpit-delete-scope">
     <div><strong>开发与板房</strong><span>{counts.source??0} 张开发单 · {counts.pattern_room??0} 张板房单</span></div>
     <div><strong>正式生产</strong><span>{counts.order??0} 张母单 · {counts.po??0} 个 PO</span></div>
     <div><strong>外发与裁床</strong><span>{counts.sourcing??0} 张外发单 · {counts.cutting??0} 张裁床单</span></div>
     <div><strong>回货与返工</strong><span>{counts.receiving??0} 笔回货 · {counts.rework??0} 张返工单</span></div>
    </div><ul className="cockpit-delete-note"><li>未完成待办将取消，相关业务将停止办理。</li><li>历史记录保留，不再计入正常业务列表与统计。</li></ul><p className="cockpit-delete-warning">删除后不能自行恢复。</p></>}
   {result&&<ul aria-label="删除结果">{result.results.map(item=><li key={item.id}>{preview?.orders.find(order=>order.id===item.id)?.label??item.id}：{item.status==='deleted'?'已删除':item.status==='already_deleted'?'此前已删除':item.message??'未删除'}</li>)}</ul>}
   <footer><Button variant="secondary" disabled={busy} onClick={onClose}>{complete?'完成':'取消'}</Button>
    {result?.results.some(item=>item.status==='failed')&&<Button variant="secondary" disabled={busy} onClick={()=>{setResult(null);key.current=createClientRequestId();setReload(value=>value+1);}}>重新核对关联范围</Button>}
    {!preview&&error&&<Button variant="secondary" onClick={()=>setReload(value=>value+1)}>重试读取</Button>}
    {preview&&!complete&&<Button className="cockpit-delete-danger" disabled={busy} onClick={()=>void submit()}>{busy?'正在处理…':result||error?'核对并重试':`删除这 ${preview.orders.length} 单`}</Button>}
   </footer>
  </div>
 </CockpitHomeDialog>;
}
