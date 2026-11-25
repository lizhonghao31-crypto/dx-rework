import {useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {ReworkOrderResponseSchema} from '@dx-rework/contracts';
import type {GarmentReworkSource} from '@dx-rework/contracts/order-closure';
import {createWebUrls} from '../url-contract.js';
import {createClientRequestId} from './client-request-id.js';
import {digitalDetailReturnUrl} from './digital-detail-route.js';
import {DigitalRequestError} from './digital-production-api.js';
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';

const urls=createWebUrls(import.meta.env.BASE_URL);

export function GarmentOriginalRework({source,maximum}:{source:GarmentReworkSource;maximum:number}){
 const [busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[error,setError]=useState(''),[reworkId,setReworkId]=useState<string|null>(null);
 const writing=useRef(false),key=useRef<string|null>(null);
 useDigitalDetailNavigationGuard(unknown,busy,writing,'原返工草稿结果尚未确认，确认离开？');
 const create=async()=>{
  if(writing.current||reworkId)return;
  writing.current=true;setBusy(true);setError('');key.current??=createClientRequestId();
  try{
   const response=await feedbackFetch(urls.apiUrl('rework-orders/garment-quality/drafts'),{method:'POST',credentials:'include',cache:'no-store',
    headers:{'content-type':'application/json','idempotency-key':key.current},body:JSON.stringify(source)});
   const saved=await feedbackJson(response,'POST',value=>ReworkOrderResponseSchema.parse(value),(message,code,status)=>new DigitalRequestError(message,status,code));
   setReworkId(saved.reworkOrderId);setUnknown(false);
  }catch(reason){setUnknown(!(reason instanceof DigitalRequestError)||reason.resultUnknown);
   setError(reason instanceof Error?reason.message:'原返工草稿结果尚未确认。');}
  finally{writing.current=false;setBusy(false);}
 };
 const back=digitalDetailReturnUrl(window.location.pathname+window.location.search,urls.base);
 return <section aria-label="本批成衣原返工">
  <p>本次检查确认问题 {maximum} 件。创建草稿不改变原实收和质检结论。</p>
  {error&&<p role="alert">{error}</p>}
  {reworkId?<a href={urls.pageUrl(`ui/tasks/${reworkId}`)+(back?'?'+new URLSearchParams({returnTo:back}):'')}>查看原成衣返工单</a>
   :<Button type="button" label={unknown?'核对原成衣返工回执':'按本批问题发起返工'} isDisabled={busy} onClick={()=>void create()}/>}
 </section>;
}
