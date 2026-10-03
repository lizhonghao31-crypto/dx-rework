import { useEffect, useRef, useState } from "react";
import { Button } from "@dx-rework/ui";
import { DigitalNotificationClaimSchema, type DigitalNotification } from "@dx-rework/contracts/digital-production-notifications";
import { createWebUrls } from "../url-contract.js";
import { todoRouteHref } from "./todo-route-link.js";
import "./digital-notification-toast.css";
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
export function DigitalNotificationToast({userId}:{userId:string}) {
  const [notice,setNotice]=useState<DigitalNotification|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const current=useRef<DigitalNotification|null>(null),running=useRef(false),unavailable=useRef(false);
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
  return <section className="digital-notification-toast" aria-live="polite" aria-label="站内提醒"><p>{notice.title}</p><p className="digital-notification-hint">{notice.actionable?"确认提醒后，待办仍会保留。":"此消息仅供知悉。"}</p>{error&&<p role="alert">{error}</p>}<div><Button disabled={busy} onClick={()=>void dismiss(false)}>我知道了</Button><Button disabled={busy} onClick={()=>void dismiss(true)}>{notice.actionable?"去处理":"查看"}</Button></div></section>;
}
