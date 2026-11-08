import {useRef,useState,useEffect} from 'react';
import {Button} from '@dx-rework/ui';
import {digitalRequest} from './digital-production-api.js';
/** Explicitly retry only the failed authorized objects, not the whole list.
 * The idempotent derived-queue requests finish even if navigation changes;
 * their results cannot update another page's UI. */
export function CockpitRetryUpdates({ids,onUpdated}:{ids:readonly string[];onUpdated:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),live=useRef(false),key=ids.join(','),current=useRef(key);current.current=key;
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 if(!ids.length)return null;
 const retry=async()=>{
  if(busy)return;const requested=key;setBusy(true);setError('');
  const active=()=>live.current&&current.current===requested;
  try{let queued=0,failed=0;for(const id of [...new Set(ids)].slice(0,15)){
   try{await digitalRequest(`journeys/${encodeURIComponent(id)}/refresh`,'POST');queued++;}catch{failed++;}
  }if(active()){if(queued)onUpdated();if(failed)setError(`${failed} 单重试未成功，请稍后再试。`);}}
  finally{if(active())setBusy(false);}
 };
 return <><Button type="button" variant="secondary" disabled={busy} onClick={()=>void retry()}>{busy?'正在请求重试…':'重试更新失败订单'}</Button>{error&&<p role="alert">{error}</p>}</>;
}
