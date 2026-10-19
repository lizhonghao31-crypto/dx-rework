import {useEffect,useRef,useState} from "react";
import {createWebUrls} from "../url-contract.js";
import {trapCockpitDialogFocus} from "./cockpit-dialog-focus.js";
const urls=createWebUrls(import.meta.env.BASE_URL);

/** One actual registered image, previewed in place without losing the order context. */
export function CockpitPhoto({src,label,className=""}:{src:string|null|undefined;label:string;className?:string}){
  const [open,setOpen]=useState(false),[failed,setFailed]=useState(false),[thumbFailed,setThumbFailed]=useState(false),[zoom,setZoom]=useState(1),[retry,setRetry]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{setOpen(false);setFailed(false);setThumbFailed(false);setZoom(1);setRetry(0);},[src]);
  useEffect(()=>{
    if(!open||!dialog.current)return;
    const view=dialog.current,previous=document.body.style.overflow;
    view.showModal();document.body.style.overflow="hidden";
    return()=>{view.close();document.body.style.overflow=previous;trigger.current?.focus();};
  },[open]);
  if(!src)return <span className={`cockpit-photo-empty ${className}`}>未上传款图</span>;
  const url=urls.pageUrl(src);
  return <><button type="button" className={`cockpit-photo-trigger ${className}`} ref={trigger} aria-label={`预览${label}款图`} onClick={()=>{setOpen(true);setZoom(1);setFailed(false);}}>
    <img key={`${src}:thumbnail:${retry}`} src={url} alt={`${label}款图`} onLoad={event=>{event.currentTarget.hidden=false;setThumbFailed(false);}} onError={event=>{event.currentTarget.hidden=true;setThumbFailed(true);}}/><span className="cockpit-photo-fallback">{thumbFailed?"加载失败，点击重试":"款图预览"}</span>
  </button><dialog className="cockpit-photo-dialog" ref={dialog} onClose={()=>setOpen(false)} aria-label={`${label}款图预览`} onKeyDown={trapCockpitDialogFocus}>
    <header><div><h2>款图预览</h2><p>{label}</p></div><button type="button" autoFocus aria-label="关闭款图预览" onClick={()=>dialog.current?.close()}>×</button></header>
    <div className="cockpit-photo-stage">{failed?<div role="alert"><p>款图加载失败</p><button type="button" onClick={()=>{setFailed(false);setRetry(n=>n+1);}}>重新加载款图</button></div>:open&&<img key={`${src}:${retry}`} src={url} alt={`${label}完整款图`} style={{width:`${zoom*100}%`,height:`${zoom*100}%`}} onError={()=>setFailed(true)}/>}</div>
    <footer><button type="button" aria-label="缩小款图" disabled={zoom<=.5||failed} onClick={()=>setZoom(n=>Math.max(.5,n-.25))}>−</button><output aria-live="polite">{Math.round(zoom*100)}%</output><button type="button" aria-label="放大款图" disabled={zoom>=3||failed} onClick={()=>setZoom(n=>Math.min(3,n+.25))}>＋</button><button type="button" disabled={failed} onClick={()=>setZoom(1)}>适应窗口</button></footer>
  </dialog></>;
}
