import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {BudgetSheet} from '@dx-rework/contracts/digital-budget';
import type {InstructionSheet} from '@dx-rework/contracts/production-instruction';
import type {QuotationSheet} from '@dx-rework/contracts/digital-quotation';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import {cachedVerifiedSession,registerSessionInvalidator,sessionCacheVersion,verifiedSessionIdentity,verifySession} from './auth-session.js';
import {digitalRequest} from './digital-production-api.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {beginForegroundWait} from './foreground-loading.js';
import {DocumentToolbarScope} from './document-editor.js';
import {DigitalBudgetPanel} from './digital-budget-panel.js';
import {ProductionInstructionPanel} from './production-instruction-panel.js';
import {DigitalQuotationPanel} from './digital-quotation-panel.js';
import {OriginalDocumentSwitcher,originalDocumentHref,type OriginalDocumentRef} from './original-document-directory.js';
import {navigateInternalPage} from './internal-navigation.js';
import {createWebUrls} from '../url-contract.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import './production-original-reader.css';

type Ref=Exclude<OriginalDocumentRef,{kind:'development'}>;
type Loaded={kind:'budget';sheet:BudgetSheet;order:DigitalOrder}|{kind:'instruction';sheet:InstructionSheet}|{kind:'quotation';sheet:QuotationSheet};
const urls=createWebUrls(import.meta.env.BASE_URL);

/** Original complete components receive only an authorized immutable snapshot.
 * The ordinary editable routes and current/history behavior remain unchanged.
 */
export function ProductionOriginalReader({reference,onClose}:{reference:Ref;onClose():void}){
 const [attempt,setAttempt]=useState(0),[identityRevision,setIdentityRevision]=useState(sessionCacheVersion),[choosing,setChoosing]=useState(false),[toolbar,setToolbar]=useState<HTMLElement|null>(null);
 const root=useRef<HTMLElement>(null),[result,setResult]=useState<{key:string;identity:string;value:Loaded}|null>(null),[failure,setFailure]=useState<{key:string;error:unknown}|null>(null);
 const key=JSON.stringify([reference,attempt,identityRevision]);
 useEffect(()=>registerSessionInvalidator(()=>{setResult(null);setFailure(null);setChoosing(false);setIdentityRevision(sessionCacheVersion());}),[]);
 useEffect(()=>{
  const abort=new AbortController(),finish=beginForegroundWait();let live=true;
  void(async()=>{
   const session=await verifySession();if(!live||abort.signal.aborted)return;
   if(session==='denied'||session.status!=='authorized')throw Error('请确认当前登录与岗位后读取原单。');
   const identity=verifiedSessionIdentity(session);let value:Loaded;
   if(reference.kind==='budget'){
    const data=await digitalRequest<{order:DigitalOrder;sheet:BudgetSheet}>(`orders/${reference.orderId}/budget/original-versions/${reference.version}`,'GET',undefined,undefined,{signal:abort.signal});
    if(data.order?.productionOrderId!==reference.orderId||data.sheet?.productionOrderId!==reference.orderId||data.sheet.version!==reference.version||data.sheet.status!=='published'||!data.sheet.document||data.sheet.canEdit||data.sheet.canSubmitSourcing)throw Error('原预算对象或版本不符，未读取当前预算');value={kind:'budget',...data};
   }else if(reference.kind==='instruction'){
    const sheet=await digitalRequest<InstructionSheet>(`orders/${reference.orderId}/instruction/original-versions/${reference.version}`,'GET',undefined,undefined,{signal:abort.signal});
    if(sheet.order?.productionOrderId!==reference.orderId||sheet.version!==reference.version||!sheet.isPublishedSnapshot||sheet.canEdit||!sheet.document)throw Error('原制单对象或版本不符，未读取当前制单');value={kind:'instruction',sheet};
   }else{
    const r=reference.resource,sheet=await digitalRequest<QuotationSheet>(`${r.kind==='source'?'sources':'orders'}/${r.id}/quotation/original-versions/${reference.version}?quoteId=${reference.quoteId}`,'GET',undefined,undefined,{signal:abort.signal});
    if(sheet.resource?.kind!==r.kind||sheet.resource.id!==r.id||sheet.quoteId!==reference.quoteId||sheet.version!==reference.version||sheet.status!=='confirmed'||sheet.canStructure||sheet.canConfirm)throw Error('原报价对象或版本不符，未读取当前报价');value={kind:'quotation',sheet};
   }
   if(live&&!abort.signal.aborted&&verifiedSessionIdentity(cachedVerifiedSession())===identity){setFailure(null);setResult({key,identity,value});}
  })().catch(error=>{if(live&&!abort.signal.aborted){setResult(null);setFailure({key,error});}}).finally(finish);
  return()=>{live=false;abort.abort();finish();};
 },[key]);
 const visible=result?.identity===verifiedSessionIdentity(cachedVerifiedSession())?result:null,error=failure?.key===key?failure.error:null,pending=!error&&visible?.key!==key;
 useInternalReturnScroll(!pending&&!error);
 useEffect(()=>{
  if(pending||error||!visible||history.state?.dxInternalRestoreScroll)return;
  const focus=()=>{const title=root.current?.querySelector<HTMLElement>('.dx-doc-toolbar h1');if(title){title.tabIndex=-1;title.focus({preventScroll:true});return true;}return false;};
  if(focus())return;const observer=new MutationObserver(()=>{if(focus())observer.disconnect();});if(root.current)observer.observe(root.current,{childList:true,subtree:true});return()=>observer.disconnect();
 },[key,pending,Boolean(error)]);
 const select=(ref:OriginalDocumentRef)=>{setChoosing(false);const href=originalDocumentHref(ref,new URLSearchParams(location.search).get('returnTo'),urls.base);if(href)void navigateInternalPage(href);};
 const value=visible?.value,resource=reference.kind==='quotation'?reference.resource:{kind:'order' as const,id:reference.orderId};
 return <section ref={root} className="production-original-reader" aria-label="完整原单只读查看" aria-busy={pending}>
  <Button type="button" onClick={onClose}>返回来源</Button>
  <header className="production-original-toolbar"><div ref={setToolbar} inert={pending}/><Button type="button" onClick={()=>setChoosing(true)}>切换单据</Button></header>
  {pending&&<p role="status">{visible?'正在切换，仍显示上一份；下载和打印暂不可用。':'正在读取所选原单…'}</p>}
  {error?<DigitalReadFailure error={error} onRetry={()=>setAttempt(v=>v+1)} retryLabel="重新读取所选原单"/>:null}
  {value&&<div inert={pending}><DocumentToolbarScope target={toolbar}>
   {value.kind==='budget'?<DigitalBudgetPanel key={JSON.stringify([value.kind,value.sheet.version])} order={value.order} initialVersion={value.sheet.version} originalSnapshot={value.sheet} embedded contained onClose={onClose}/>
    :value.kind==='instruction'?<ProductionInstructionPanel key={JSON.stringify([value.kind,value.sheet.version])} orderId={value.sheet.order.productionOrderId} initialVersion={value.sheet.version} originalSnapshot={value.sheet} embedded contained onClose={onClose}/>
     :<DigitalQuotationPanel key={JSON.stringify([value.kind,value.sheet.quoteId,value.sheet.version])} resource={value.sheet.resource} originalSnapshot={value.sheet}/>}
  </DocumentToolbarScope></div>}
  {choosing&&<OriginalDocumentSwitcher resource={resource} onSelect={select} onClose={()=>setChoosing(false)}/>}
 </section>;
}
