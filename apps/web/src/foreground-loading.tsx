import {useEffect,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';

const visibleDelay = 250;
type Subscription=()=>void;
type Wait={visible:boolean;finish:()=>void};
let current:Wait|null=null;
const subscribers=new Set<Subscription>();
const notify=()=>{for(const subscriber of subscribers)subscriber();};

function openWait():Wait{
  const timer=setTimeout(()=>{
    if(current!==wait)return;
    wait.visible=true;
    notify();
  },visibleDelay);
  const wait={visible:false,finish:()=>{
    clearTimeout(timer);
    if(current!==wait)return;
    current=null;
    if(wait.visible)notify();
  }};
  return wait;
}

export function beginForegroundWait(){
  current?.finish();
  const wait=openWait();
  current=wait;
  return wait.finish;
}

/** Supply the real pending interaction key, only for foreground reads. */
export function useForegroundWait(key:string|undefined){
  useEffect(()=>key===undefined?undefined:beginForegroundWait(),[key]);
}

function subscribe(subscriber:Subscription){
  subscribers.add(subscriber);
  return()=>{subscribers.delete(subscriber);};
}
const visible=()=>current?.visible??false;
const serverVisible=()=>false;

export function ForegroundLoading(){
  const waiting=useSyncExternalStore(subscribe,visible,serverVisible);
  const [modal,setModal]=useState<HTMLDialogElement|null>(null);
  useEffect(()=>{
    let active:HTMLDialogElement|null=null;
    const update=()=>{
      // The native modal top layer is above the application, regardless of z-index.
      const dialogs=Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"));
      active=dialogs.filter(dialog=>{
        try{return dialog.matches(":modal");}catch{return false;}
      }).at(-1)??null;
      setModal(active);
    };
    update();
    const observer=new MutationObserver(records=>{
      if(active&&!active.isConnected||records.some(record=>record.type==="attributes"&&record.target instanceof HTMLDialogElement))update();
    });
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["open"]});
    return()=>observer.disconnect();
  },[]);
  const feedback=<div role={waiting?"status":undefined} aria-live="polite" aria-atomic="true" className="dx-foreground-loading">
    {waiting&&<span>请稍等</span>}
  </div>;
  return modal?createPortal(feedback,modal):feedback;
}
