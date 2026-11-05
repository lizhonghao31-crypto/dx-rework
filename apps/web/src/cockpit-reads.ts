import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {JourneyResult,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {cachedVerifiedSession,registerSessionInvalidator,verifiedSessionIdentity,verifySession} from './auth-session.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {cockpitQuery,type CockpitContext} from './digital-journey-cockpit-model.js';

function currentIdentity(){const session=cachedVerifiedSession();return session===undefined?'':session==='denied'?'denied':session.status!=='authorized'?'no-role':verifiedSessionIdentity(session);}
const subscribe=(notify:()=>void)=>{let live=true;const check=()=>{if(!live)return;notify();void verifySession().then(()=>{if(live)notify();});};const stop=registerSessionInvalidator(check);check();return()=>{live=false;stop();};};
export const useCockpitIdentity=()=>useSyncExternalStore(subscribe,currentIdentity,()=> '');
type ListRead={identity:string;requested:string;busy:boolean;data:JourneyResult|null;applied:CockpitContext|null;error:string};
type DetailRead={identity:string;key:string;busy:boolean;data:OrderJourney|null;error:string};
const denied=(error:unknown)=>error instanceof DigitalRequestError&&error.status!==null&&[401,403,404].includes(error.status);
const message=(error:unknown)=>error instanceof Error?error.message:'读取失败，请重试';
function validList(value:JourneyResult,page:number){
 return value?.ruleVersion==='journey-v2.0'&&value.page===page&&Number.isSafeInteger(value.total)&&value.total>=0&&Array.isArray(value.items)&&Boolean(value.summary)&&typeof value.asOf==='string'&&Number.isFinite(Date.parse(value.asOf));
}
/** Results own their successful conditions. The independent generations also
 * protect same-key A1→B→A2, retries and finalizers; no settled API data is cached. */
export function useCockpitReads(context:CockpitContext,refresh:number){
 const session=useCockpitIdentity(),identity=['denied','no-role'].includes(session)?'':session,identityError=session==='denied'?'当前登录或读取身份尚未核准，请重新登录或刷新重试':session==='no-role'?'当前身份尚无业务角色，请返回工作台核对授权':'',query=cockpitQuery(context),selected=context.selected??'',detailKey=`${selected}:${context.round??'current'}`;
 const [list,setList]=useState<ListRead|null>(null),[detail,setDetail]=useState<DetailRead|null>(null);
 const listGeneration=useRef(0),detailGeneration=useRef(0),liveIdentity=useRef(identity);liveIdentity.current=identity;
 useEffect(()=>{
  const turn=++listGeneration.current,controller=new AbortController(),conditions=structuredClone(context);
  const live=()=>turn===listGeneration.current&&identity===liveIdentity.current;
  if(!identity||selected)return()=>{++listGeneration.current;controller.abort();};
  setList(previous=>({identity,requested:query,busy:true,data:previous?.identity===identity?previous.data:null,applied:previous?.identity===identity?previous.applied:null,error:''}));
  void digitalRequest<JourneyResult>('journeys?'+query,'GET',undefined,undefined,{signal:controller.signal}).then(value=>{
   if(!live())return;if(!validList(value,conditions.page))throw new DigitalRequestError('订单结果与本次查询不一致，请重新读取',null,'INVALID_RESPONSE');
   setList({identity,requested:query,busy:false,data:value,applied:conditions,error:''});
  }).catch(error=>{if(!live()||error?.name==='AbortError')return;setList(previous=>({identity,requested:query,busy:false,data:!denied(error)&&previous?.identity===identity?previous.data:null,applied:!denied(error)&&previous?.identity===identity?previous.applied:null,error:message(error)}));
  }).finally(()=>{if(live())setList(previous=>previous?.identity===identity?{...previous,busy:false}:previous);});
  return()=>{++listGeneration.current;controller.abort();};
 },[query,identity,refresh,Boolean(selected)]);
 useEffect(()=>{
  const turn=++detailGeneration.current,controller=new AbortController();
  const live=()=>turn===detailGeneration.current&&identity===liveIdentity.current;
  if(!identity||!selected)return()=>{++detailGeneration.current;controller.abort();};
  setDetail(previous=>({identity,key:detailKey,busy:true,data:previous?.identity===identity&&previous.key===detailKey?previous.data:null,error:''}));
  void digitalRequest<OrderJourney>('journeys/'+selected+'?view=cockpit'+(context.round?'&round='+context.round:''),'GET',undefined,undefined,{signal:controller.signal}).then(value=>{
   if(!live())return;if(!value||![value.id,value.orderId,value.sourceId].includes(selected)||!Array.isArray(value.stages))throw new DigitalRequestError('订单详情与所选对象不一致，请重新读取',null,'INVALID_RESPONSE');
   setDetail({identity,key:detailKey,busy:false,data:value,error:''});
  }).catch(error=>{if(!live()||error?.name==='AbortError')return;setDetail(previous=>({identity,key:detailKey,busy:false,data:!denied(error)&&previous?.identity===identity&&previous.key===detailKey?previous.data:null,error:message(error)}));
  }).finally(()=>{if(live())setDetail(previous=>previous?.identity===identity&&previous.key===detailKey?{...previous,busy:false}:previous);});
  return()=>{++detailGeneration.current;controller.abort();};
 },[detailKey,identity,refresh]);
 const shownList=identity&&list?.identity===identity?list:null,shownDetail=identity&&detail?.identity===identity&&detail.key===detailKey?detail:null;
 return {identity,data:shownList?.data??null,applied:shownList?.applied??null,listError:identityError||shownList?.error||'',listPhase:identityError?'error':!identity?'identity':shownList?.requested!==query?'preparing':shownList?.busy?'loading':shownList?.error?'error':'ready',detail:shownDetail?.data??null,detailError:identityError||shownDetail?.error||'',detailLoading:Boolean(selected)&&!identityError&&(!shownDetail||shownDetail.busy)};
}
