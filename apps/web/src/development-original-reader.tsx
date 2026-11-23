import {useEffect,useState} from 'react';
import type {DevelopmentPublishedVersion} from '@dx-rework/contracts/digital-development';
import {Button} from '@dx-rework/ui';
import {cachedVerifiedSession,registerSessionInvalidator,sessionCacheVersion,verifiedSessionIdentity,verifySession} from './auth-session.js';
import {beginForegroundWait} from './foreground-loading.js';
import {digitalRequest} from './digital-production-api.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {DevelopmentPublishedDocument} from './development-published-document.js';
import {OriginalDocumentSwitcher,originalDocumentHref,type OriginalDocumentRef} from './original-document-directory.js';
import {createWebUrls} from '../url-contract.js';
import {navigateInternalPage} from './internal-navigation.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';

/** Exact published document mode of the existing development detail route. */
export function DevelopmentOriginalReader({sourceId,roundNumber,documentVersion,onClose}:{sourceId:string;roundNumber:number;documentVersion:number;onClose:()=>void}){
 const [attempt,setAttempt]=useState(0),[identityRevision,setIdentityRevision]=useState(sessionCacheVersion);
 const [result,setResult]=useState<{key:string;identity:string;value:DevelopmentPublishedVersion}|null>(null);
 const [failure,setFailure]=useState<{key:string;error:unknown}|null>(null);
 const [choosing,setChoosing]=useState(false);
 const key=JSON.stringify([sourceId,roundNumber,documentVersion,attempt,identityRevision]);
 useEffect(()=>registerSessionInvalidator(()=>{setResult(null);setFailure(null);setIdentityRevision(sessionCacheVersion());}),[]);
 useEffect(()=>{
  const controller=new AbortController(),finish=beginForegroundWait();let live=true;
  void(async()=>{
   const session=await verifySession();
   if(!live||controller.signal.aborted)return;
   if(session==='denied'||session.status!=='authorized')throw new Error('请先确认当前登录与岗位，再读取原单。');
   const identity=verifiedSessionIdentity(session);
   if(verifiedSessionIdentity(cachedVerifiedSession())!==identity)return;
   const value=await digitalRequest<DevelopmentPublishedVersion>(`sources/${sourceId}/development/versions/${documentVersion}?round=${roundNumber}`,'GET',undefined,undefined,{signal:controller.signal});
   if(!live||controller.signal.aborted||verifiedSessionIdentity(cachedVerifiedSession())!==identity)return;
   if(value.sourceId!==sourceId||value.roundNumber!==roundNumber||value.documentVersion!==documentVersion||!value.document||!Array.isArray(value.document.files)||!Array.isArray(value.document.materials))throw new Error('原单返回的对象、轮次或资料版本不符，未读取其他版本。');
   setFailure(null);setResult({key,identity,value});
  })().catch(error=>{if(live&&!controller.signal.aborted){setResult(null);setFailure({key,error});}}).finally(finish);
  return()=>{live=false;controller.abort();finish();};
 },[sourceId,roundNumber,documentVersion,key]);
 const visible=result?.identity===verifiedSessionIdentity(cachedVerifiedSession())?result:null;
 const error=failure?.key===key?failure.error:null,pending=!error&&visible?.key!==key;
 useInternalReturnScroll(!pending&&!error);
 useEffect(()=>{
  if(pending||error||!visible||window.history.state?.dxInternalRestoreScroll)return;
  const frame=requestAnimationFrame(()=>{const title=document.querySelector<HTMLElement>('[aria-label="开发原单精确版本"] .dx-doc-toolbar h1');if(title){title.tabIndex=-1;title.focus({preventScroll:true});}});
  return()=>cancelAnimationFrame(frame);
 },[key,pending,Boolean(error)]);
 const select=(ref:OriginalDocumentRef)=>{
  setChoosing(false);
  const target=originalDocumentHref(ref,new URLSearchParams(window.location.search).get('returnTo'),createWebUrls(import.meta.env.BASE_URL).base);
  if(target)void navigateInternalPage(target);
 };
 return <section aria-label="开发原单查看" aria-busy={pending}>
  <Button type="button" onClick={onClose}>返回来源</Button>
  {error?<DigitalReadFailure error={error} onRetry={()=>setAttempt(value=>value+1)} retryLabel="重试读取所选原单"/>:null}
  {pending&&<p role="status">{visible?'正在切换，仍显示上一份；该份下载与打印暂不可用。':'正在读取所选原单…'}</p>}
  {!visible&&<Button type="button" onClick={()=>setChoosing(true)}>切换单据</Button>}
  {visible&&<DevelopmentPublishedDocument value={visible.value} blocked={pending} onSwitch={()=>setChoosing(true)}/>}
  {choosing&&<OriginalDocumentSwitcher resource={{kind:'source',id:sourceId}} onSelect={select} onClose={()=>setChoosing(false)}/>}
 </section>;
}
