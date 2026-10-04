import { useEffect, useRef, useState } from "react";
import { Button } from "@dx-rework/ui";
import { DigitalNotificationClaimSchema, type DigitalNotification } from "@dx-rework/contracts/digital-production-notifications";
import { createWebUrls } from "../url-contract.js";
import { todoRouteHref } from "./todo-route-link.js";
import { notificationActionLift } from "./digital-notification-position.js";
import "./digital-notification-toast.css";
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
export function DigitalNotificationToast({userId}:{userId:string}) {
  const [notice,setNotice]=useState<DigitalNotification|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const current=useRef<DigitalNotification|null>(null),running=useRef(false),unavailable=useRef(false);
  const region=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const element=region.current;
    if(!element||!notice)return;
    let frame=0;
    const measure=()=>{
      frame=0;
      const rect=element.getBoundingClientRect();
      const prior=Number.parseFloat(element.style.getPropertyValue("--digital-notification-lift"))||0;
      const actions=Array.from(document.querySelectorAll<HTMLElement>("button.dx-button--primary:not(:disabled), .mobile-actions button:not(:disabled), .responsibility-actions button:not(:disabled), .process-worker-actions button:not(:disabled), .mobile-primary-navigation"))
        .filter(button=>!element.contains(button)&&getComputedStyle(button).visibility!=="hidden")
        .map(button=>button.getBoundingClientRect())
        .filter(box=>box.width>0&&box.height>0&&box.bottom>72&&box.top<window.innerHeight&&box.right>0&&box.left<window.innerWidth);
      const lift=notificationActionLift({left:rect.left,right:rect.right,top:rect.top+prior,bottom:rect.bottom+prior},actions);
      element.style.setProperty("--digital-notification-lift",`${lift}px`);
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
    const resize=new ResizeObserver(schedule);resize.observe(element);resize.observe(document.body);
    const changes=new MutationObserver(schedule);changes.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:["class","disabled"]});
    window.addEventListener("scroll",schedule,true);window.addEventListener("resize",schedule);schedule();
    return()=>{resize.disconnect();changes.disconnect();window.removeEventListener("scroll",schedule,true);window.removeEventListener("resize",schedule);cancelAnimationFrame(frame);};
  },[notice?.eventId]);
  useEffect(()=>{
    const controller=new AbortController();current.current=null;setNotice(null);unavailable.current=false;
    const refresh=async()=>{
      if(running.current||unavailable.current||document.hidden)return;
      if(!current.current&&window.matchMedia("(max-width: 800px)").matches&&document.activeElement?.matches("input,textarea,select"))return;
      running.current=true;
      try {
        const old=current.current;
        const response=await fetch(apiUrl(`digital-production/notifications/${old?old.eventId:"claim"}`),{method:old?"GET":"POST",credentials:"include",cache:"no-store",signal:controller.signal});
        if(response.status===404){unavailable.current=true;return;}
        if(!response.ok)return;
        if(response.headers.get("x-dx-rework-actor-id")!==userId){window.location.reload();return;}
        const result=DigitalNotificationClaimSchema.parse(await response.json());
        if(controller.signal.aborted)return;
        current.current=result.notification;setNotice(result.notification);
        // Only one claimed notification is displayed; no preclaiming a hidden queue.
      }catch{ /* The next shared indicator refresh retries transient failures. */ }
      finally{running.current=false;}
    };
    window.addEventListener("dx-rework:todo-refresh",refresh);
    return()=>{controller.abort();window.removeEventListener("dx-rework:todo-refresh",refresh);};
  },[userId]);
  const dismiss=async(go:boolean)=>{
    if(!current.current||busy)return;
    const item=current.current;setBusy(true);setError("");
    try{
      const response=await fetch(apiUrl(`digital-production/notifications/${item.eventId}/acknowledge`),{method:"POST",credentials:"include"});
      if(!response.ok)throw new Error("确认未成功，请重试");
      current.current=null;setNotice(null);
      if(go)window.location.assign(todoRouteHref(item.route));
      else window.dispatchEvent(new Event("dx-rework:todo-read"));
    }catch{setError("确认未成功，请重试");}finally{setBusy(false);}
  };
  if(!notice)return null;
  return <section ref={region} className="digital-notification-toast" aria-live="polite" aria-label="站内提醒"><div className="digital-notification-content"><p>{notice.title}</p>{notice.context&&<dl>{notice.context.styleNo&&<><dt>款号</dt><dd>{notice.context.styleNo}</dd></>}{notice.context.colors.length>0&&<><dt>颜色</dt><dd>{notice.context.colors.join(' / ')}</dd></>}{notice.context.poNumbers.length>0&&<><dt>PO</dt><dd>{notice.context.poNumbers.join(' / ')}</dd></>}{notice.context.orderId&&<><dt>母单编号</dt><dd>{notice.context.orderId}</dd></>}</dl>}</div><p className="digital-notification-hint">{notice.actionable?"确认提醒后，待办仍会保留。":"此消息仅供知悉。"}</p>{error&&<p role="alert">{error}</p>}<div><Button disabled={busy} onClick={()=>void dismiss(false)}>我知道了</Button><Button disabled={busy} onClick={()=>void dismiss(true)}>{notice.actionable?"去处理":"查看"}</Button></div></section>;
}
