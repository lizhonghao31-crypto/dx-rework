import {useEffect,useRef,useState} from "react";
import {CockpitDate} from "./cockpit-date.js";
import type {JourneyLogPage,OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {digitalRequest} from "./digital-production-api.js";
import {journeyTime} from "./digital-journey-cockpit-model.js";
import {trapCockpitDialogFocus} from "./cockpit-dialog-focus.js";

export function CockpitOperationLog({order}:{order:OrderJourney}){
  const summary=order.operationLog,dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),request=useRef<AbortController|null>(null);
  const [open,setOpen]=useState(false),[page,setPage]=useState(summary),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const live=useRef(false);
  const loading=useRef(false);
  useEffect(()=>{setOpen(false);setPage(summary);setError("");request.current?.abort();setBusy(false);},[order.id,summary?.asOf]);
  useEffect(()=>{
    live.current=open;
    if(!open||!dialog.current)return;
    const view=dialog.current,overflow=document.body.style.overflow;view.showModal();document.body.style.overflow="hidden";
    return()=>{live.current=false;request.current?.abort();view.close();document.body.style.overflow=overflow;trigger.current?.focus();};
  },[open]);
  const load=async()=>{
    if(loading.current||!page?.nextCursor)return;
    loading.current=true;
    const controller=new AbortController();request.current=controller;setBusy(true);setError("");
    try{
      const next=await digitalRequest<JourneyLogPage>(`journeys/${order.id}/logs?cursor=${encodeURIComponent(page.nextCursor)}`,"GET",undefined,undefined,{signal:controller.signal});
      if(next.asOf!==page.asOf)throw new Error("记录范围已变化，请关闭后重新打开操作记录");
      if(live.current&&!controller.signal.aborted)setPage(current=>current?{...next,items:[...current.items,...next.items]}:next);
    }catch(failure){if(live.current&&!controller.signal.aborted)setError(failure instanceof Error?failure.message:"操作记录读取失败");}
    finally{if(request.current===controller){loading.current=false;if(live.current&&!controller.signal.aborted)setBusy(false);}}
  };
  return <section className="dx-production-panel journey-activity-panel"><div className="journey-section-title"><h2>操作记录</h2>{summary&&<button type="button" className="journey-text-action" ref={trigger} onClick={()=>{setPage(summary);setError("");setOpen(true);}}>查看更多</button>}</div>
    <ol className="cockpit-log-summary">{summary?.items.map(item=><li key={item.id}><CockpitDate value={item.at}/><span title={item.actor?.name??"姓名未登记"} tabIndex={0}>{item.actor?.name??"姓名未登记"}</span><strong>{item.object} · {item.action}</strong></li>)}</ol>
    {!summary?<p className="journey-muted">操作记录暂不可用。</p>:!summary.items.length?<p className="journey-muted">暂无可查节点操作记录。</p>:null}
    <dialog ref={dialog} className="cockpit-log-dialog" aria-label="操作记录" onClose={()=>{live.current=false;request.current?.abort();loading.current=false;setBusy(false);setOpen(false);}} onKeyDown={trapCockpitDialogFocus}>
      <header><div><h2>操作记录</h2><p>订单：{order.designStyleNo}</p></div><button type="button" autoFocus aria-label="关闭操作记录" onClick={()=>dialog.current?.close()}>×</button></header>
      <p className="journey-muted">节点事件与改派记录；其他业务操作请查看对应单据。</p>
      <div className="cockpit-log-scroll" tabIndex={0} role="region" aria-label="操作记录明细"><table><thead><tr><th>登记时间</th><th>操作人</th><th>操作</th><th>对象</th></tr></thead><tbody>{page?.items.map(item=><tr key={item.id}><td>{journeyTime(item.at)}</td><td>{item.actor?.name??"姓名未登记"}</td><td>{item.action}</td><td>{item.object}</td></tr>)}</tbody></table></div>
      {error&&<p role="alert">{error}</p>}<footer><span>已载入 {page?.items.length??0} 条</span>{page?.nextCursor?<button type="button" disabled={busy} onClick={()=>void load()}>{busy?"正在读取…":error?"重试读取后续记录":"加载后续记录"}</button>:<span>当前范围记录已全部载入</span>}</footer>
    </dialog>
  </section>;
}
