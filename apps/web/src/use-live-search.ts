import {useEffect,useRef,useState} from "react";

/** Keep typing local; commit one query after a pause and cancel it on reset. */
export function useLiveSearch(value:string,applied:string,onApply:(value:string)=>void){
 const apply=useRef(onApply);apply.current=onApply;
 const [composing,setComposing]=useState(false);
 const normalized=value.trim();
 useEffect(()=>{
  if(composing||normalized===applied)return;
  const timer=window.setTimeout(()=>apply.current(normalized),normalized?250:0);
  return()=>window.clearTimeout(timer);
 },[normalized,applied,composing]);
 return {pending:composing||normalized!==applied,onCompositionStart:()=>setComposing(true),onCompositionEnd:()=>setComposing(false)};
}
