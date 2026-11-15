import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {OrderTimeCheckResultSchema,OrderTimeRequestReadSchema,type OrderTimeOperation,type OrderTimeCheckResult} from '@dx-rework/contracts/order-time-requests';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {createWebUrls} from '../url-contract.js';
import {timeText} from './order-time-settings-model.js';
import './order-time-request.css';

/** The operation points at the saved native proposal. It does not publish it,
 * copy files or replace the existing command's unknown-result recovery. */
export function useOrderTimeApplication(onRequested?:()=>void){
 const [intent,setIntent]=useState<{operation:OrderTimeOperation;check:OrderTimeCheckResult}|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const pending=useRef<{body:unknown;key:string}|null>(null),writing=useRef(false),live=useRef(true),generation=useRef(0);
 useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;};},[]);
 const inspect=async(operation:OrderTimeOperation,enabled:boolean)=>{
  if(!enabled)return true;
  const turn=++generation.current,check=OrderTimeCheckResultSchema.parse(await digitalRequest('order-time/check','POST',{operation}));
  if(!live.current||turn!==generation.current)return false;
  if(check.feasibility==='sufficient'||check.feasibility==='not_applicable')return true;
  const next={operation,check};setIntent(next);setError('');setReason('');
  if(!check.canRequest&&!check.canApply&&check.feasibility==='insufficient'){
   const note='工艺变更后时间不足，请原单设计师接续提交时效调整申请';setReason(note);await send(next,note);
  }
  return false;
 };
 const send=async(proposal:NonNullable<typeof intent>,note:string)=>{
  if(writing.current||!note.trim())return;writing.current=true;setBusy(true);setError('');
  pending.current??={body:{operation:proposal.operation,fingerprint:proposal.check.fingerprint,reason:note},key:createClientRequestId()};
  try{
   const result=OrderTimeRequestReadSchema.parse(await digitalRequest('order-time/requests','POST',pending.current.body,pending.current.key));
   pending.current=null;if(!live.current)return;setUncertain(false);onRequested?.();
   const urls=createWebUrls(import.meta.env.BASE_URL),query=new URLSearchParams({timeRequest:result.requestId,returnTo:window.location.pathname+window.location.search});
   window.location.assign(urls.pageUrl('ui/digital-production')+'?'+query);
  }catch(value){
   if(!live.current)return;setError(value instanceof Error?value.message:'申请未完成，填写内容已保留');
   if(value instanceof DigitalRequestError&&!value.resultUnknown){pending.current=null;setUncertain(false);
    if(value.code==='ORDER_TIME_STALE')try{const next=OrderTimeCheckResultSchema.parse(await digitalRequest('order-time/check','POST',{operation:proposal.operation}));setIntent(current=>current?{...current,check:next}:current);}catch{/* Keep the saved proposal and reason. */}
   }else setUncertain(true);
  }finally{writing.current=false;if(live.current)setBusy(false);}
 };
 const submit=()=>intent?send(intent,reason):Promise.resolve();
 const dialog=intent&&<section className="r5-time-application" aria-label="本单时效申请">
  <h3>{intent.check.feasibility==='unknown'?'本单资料还没齐':'本单时间不足'}</h3>
  {intent.check.feasibility==='unknown'?<p>{intent.check.coverage.join('；')}</p>:<p>可用 {timeText(Math.max(0,intent.check.availableMinutes??0))}，当前安排需要 {timeText(intent.check.requiredMinutes)}，预计晚交 {timeText(intent.check.lateMinutes)}。</p>}
  {error&&<p role="alert">{error}</p>}
  <label>申请说明<textarea aria-label="本单时效申请说明" maxLength={2000} disabled={busy||uncertain} value={reason} onChange={event=>setReason(event.target.value)}/></label>
  <footer><Button type="button" disabled={busy||uncertain} onClick={()=>setIntent(null)}>继续补充原单</Button><Button type="button" variant="primary" disabled={busy||!reason.trim()} onClick={()=>void submit()}>{uncertain?'核对上次申请结果':busy?'正在提交…':intent.check.canRequest?'提交时效调整申请':'通知设计师接续申请'}</Button></footer>
 </section>;
 return {inspect,dialog};
}
