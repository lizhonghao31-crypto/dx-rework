import {Button} from '@dx-rework/ui';
import {cachedVerifiedSession,verifySession,refreshSession,verifiedSessionIdentity,registerSessionInvalidator} from './auth-session.js';
import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {JOURNEY_STAGES,JOURNEY_NODES,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {createWebUrls} from '../url-contract.js';
import {requestFailureMessage} from './request-failure-message.js';
import {journeyRecordHref,type CockpitContext} from './digital-journey-cockpit-model.js';
import {COCKPIT_DOCUMENT_CATEGORIES,createCockpitDocumentSnapshot,emptyCockpitDirectoryStates,type CockpitDocumentSnapshot,type CockpitDirectoryState,type CockpitDocumentCategory,type CockpitDocumentEntry,type CockpitDocumentMetadataFact,type CockpitDocumentReader} from './cockpit-documents-model.js';
import {COCKPIT_PRIORITY_DOCUMENTS} from './cockpit-document-catalog.js';
import {documentTime,documentFocusKey,filterDocumentEntries} from './cockpit-document-presentation.js';
import {trapCockpitDialogFocus} from './cockpit-dialog-focus.js';
import './cockpit-documents.css';
const urls=createWebUrls(import.meta.env.BASE_URL);
class DocumentReadError extends Error{constructor(message:string,readonly status:number){super(message);}}
const read:CockpitDocumentReader=async(path,signal)=>{
 const response=await fetch(urls.apiUrl(path),{credentials:'include',cache:'no-store',signal}).catch(reason=>{if(reason.name==='AbortError')throw reason;throw new Error('资料读取失败，请检查连接后重试');});
 if(!response.ok){const data=await response.json().catch(()=>({}));throw new DocumentReadError(requestFailureMessage(response.status,data.error?.message,'GET'),response.status);}
 return response.json().catch(()=>{throw new Error('资料返回异常，请重试');});
};
function MetadataSummary({facts}:{facts:CockpitDocumentMetadataFact[]}){
 const groups=new Map<string,{labels:string[];at:string;by:string}>(),missing:string[]=[];
 for(const fact of facts){if(!fact.at&&!fact.by){missing.push(fact.label);continue;}const key=JSON.stringify([fact.at,fact.by]),group=groups.get(key);if(group)group.labels.push(fact.label);else groups.set(key,{labels:[fact.label],at:fact.at,by:fact.by});}
 return <div className="cockpit-document-metadata">{groups.size>0&&<dl>{[...groups.values()].map(group=><div key={group.labels.join("/")}><dt>{group.labels.join(" / ")}</dt><dd>{group.by||"人员未记录"} · {group.at?<time title={group.at}>{documentTime(group.at)}</time>:"时间未记录"}</dd></div>)}</dl>}{missing.length>0&&<p>{missing.join(" / ")}：未记录</p>}</div>;
}
function Entry({entry,context,path,openPaths,onToggle,readEntry,onNavigate}:{onNavigate(path:string):CockpitContext;readEntry:CockpitDocumentSnapshot["loadEntry"];entry:CockpitDocumentEntry;context:CockpitContext;path:string;openPaths:string[];onToggle(path:string,open:boolean):void}){
 const [loaded,setLoaded]=useState<CockpitDocumentEntry|null>(null),[error,setError]=useState(""),[retry,setRetry]=useState(0),open=openPaths.includes(path);
 useEffect(()=>{if(!open||!entry.load)return;let live=true;const controller=new AbortController();setLoaded(null);setError("");void readEntry(entry,controller.signal).then(value=>{if(live)setLoaded(value);}).catch(reason=>{if(live&&reason.name!=="AbortError")setError(reason instanceof DocumentReadError&&reason.status===403?"当前身份无权读取此版本资料。":reason instanceof DocumentReadError&&reason.status===404?"所选历史版本或原件暂不可用，请返回来源核对。":reason.message);});return()=>{live=false;controller.abort();};},[open,entry,retry,readEntry]);
 const item=loaded??entry,children=item.children??[],files=item.files??[],canExpand=Boolean(entry.load||children.length||files.length||item.metadata?.length),note=item.note&&!entry.label.includes(item.note)?item.note:undefined;
 const content=<><div className="cockpit-document-summary">{note&&<span>{note}</span>}{!item.metadata&&item.at&&<span>{documentTime(item.at)}{item.by?` · ${item.by}`:""}</span>}{item.url&&<a data-document-focus={documentFocusKey(path+"/original")} onFocus={()=>onNavigate(path+"/original")} onClick={event=>{event.currentTarget.href=urls.pageUrl(journeyRecordHref(item.url!,onNavigate(path+"/original"),"read"));}} href={urls.pageUrl(journeyRecordHref(item.url,context,"read"))}>查看原记录</a>}</div>{item.metadata&&<MetadataSummary facts={item.metadata}/>}</>;
 return canExpand?<details className="cockpit-document-entry" open={open} onToggle={event=>{if(event.currentTarget.open!==open)onToggle(path,event.currentTarget.open);}}><summary data-document-focus={documentFocusKey(path)} onFocus={()=>onNavigate(path)}>{entry.label}</summary>{open&&<div className="cockpit-document-entry-body">{error?<p role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试读取此版本</button></p>:entry.load&&!loaded?<p role="status">正在读取此版本…</p>:<>{content}{files.map(file=><div className="cockpit-document-file" key={file.id}>{file.path?<a href={urls.apiUrl(file.path)} target="_blank" rel="noreferrer" title={file.name}>{file.name}</a>:<span tabIndex={0} title={file.name}>{file.name}</span>}{(file.note||file.at)&&<small>{[file.note,file.at?documentTime(file.at):"",file.by].filter(Boolean).join(" · ")}</small>}</div>)}{children.map(child=><Entry readEntry={readEntry} key={child.id} entry={child} context={context} path={`${path}/${child.id}`} openPaths={openPaths} onToggle={onToggle} onNavigate={onNavigate}/>)}{!files.length&&!children.length&&!item.url&&<p>尚无可打开的原件或历史记录。</p>}</>}</div>}</details>:<article className="cockpit-document-entry"><strong>{item.label}</strong>{content}</article>;
}

const documentIdentityListeners=new Set<()=>void>();registerSessionInvalidator(()=>{for(const listener of documentIdentityListeners)listener();});
let fallbackSnapshotSequence=0;
const idleStates=emptyCockpitDirectoryStates(),noSubscription=()=>()=>undefined;
const stateLabel=(state:CockpitDirectoryState,waiting:string)=>state.phase==='error'?'读取失败':waiting?'读取中':state.phase==='idle'||state.phase==='loading'?'读取中':state.data?({created:'有记录',missing:'尚无记录',not_applicable:'不适用',unknown:'待核实'} as const)[state.data.state]:'尚未读取';
type CategoryDefinition=typeof COCKPIT_DOCUMENT_CATEGORIES[number];
function Category({category,state,session,context,onChange,onNavigate,onRetryIdentity,waitingReason,query}:{category:CategoryDefinition;state:CockpitDirectoryState;session:CockpitDocumentSnapshot|null;context:CockpitContext;onChange(patch:Partial<CockpitContext>):void;onNavigate(path:string):CockpitContext;onRetryIdentity():void;waitingReason:string;query:string}){
 const paths=(context.documentOpen??'').split('|').filter(Boolean),open=paths.includes(category.key),data=waitingReason?undefined:state.data,busy=state.phase==='loading'||Boolean(waitingReason);
 const toggle=(path:string,isOpen:boolean)=>{const next=isOpen?[...new Set([...paths,path])]:paths.filter(item=>item!==path&&!item.startsWith(path+'/'));onChange({documentOpen:next.join('|')});};
 const ownMatch=category.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),entries=ownMatch?data?.entries??[]:filterDocumentEntries(data?.entries??[],query);
 if(query&&!ownMatch&&!entries.length)return null;
 return <details className="cockpit-document-category" data-state={state.phase==='error'?'error':data?.state??'unknown'} data-read-state={state.phase} open={open} onToggle={event=>{if(event.currentTarget.open!==open)toggle(category.key,event.currentTarget.open);}}>
  <summary data-document-focus={category.key}><strong>{category.label}</strong><span>{stateLabel(state,waitingReason)}</span></summary>
  {open&&<div><p className="cockpit-document-node-name">所属节点：{JOURNEY_NODES.find(n=>n.key===category.node)?.label??category.label}</p>{state.error?<p role="alert">{state.error}<button type="button" onClick={()=>session?void session.load(category.key):onRetryIdentity()}>重试读取目录</button></p>:<>{data?.note&&<p>{data.note}</p>}{entries.map(entry=><Entry readEntry={session!.loadEntry} key={entry.id} entry={entry} context={context} path={`${category.key}/${entry.id}`} openPaths={paths} onToggle={toggle} onNavigate={onNavigate}/>)}{data?.state==='missing'&&<p>当前授权范围未见记录；不代表此项为必须补填。</p>}{data?.nextPage&&<button type="button" disabled={busy} onClick={()=>void session?.load(category.key,true)}>读取下一页关联单据</button>}{busy&&<p role="status">{waitingReason||'正在读取资料…'}</p>}</>}</div>}
 </details>;
}
function DocumentsForSnapshot({order,context,onChange,identity,onRefreshIdentity,identityError,waitingReason}:{order:OrderJourney;context:CockpitContext;onChange(patch:Partial<CockpitContext>):void;identity:{actorId:string;signature:string}|null;onRefreshIdentity():void;identityError:string;waitingReason:string}){
 const [session,setSession]=useState<CockpitDocumentSnapshot|null>(null),dialog=useRef<HTMLDialogElement>(null),body=useRef<HTMLDivElement>(null),directory=useRef<HTMLDivElement>(null),lastTrigger=useRef<HTMLElement|null>(null),closing=useRef(false),restoring=useRef(false),scrollTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const changeRef=useRef(onChange),contextRef=useRef(context);changeRef.current=onChange;contextRef.current=context;
 const open=context.documentView==='all';
 useEffect(()=>{if(!identity)return;const current=createCockpitDocumentSnapshot(order,read,()=>{const verified=cachedVerifiedSession();return Boolean(verified&&verified!=='denied'&&verified.user.id===identity.actorId&&verifiedSessionIdentity(verified)===identity.signature);});setSession(current);for(const c of COCKPIT_PRIORITY_DOCUMENTS)void current.load(c.key);return()=>current.dispose();},[identity?.signature]);
 const states=useSyncExternalStore(session?.subscribe??noSubscription,session?.getSnapshot??(()=>idleStates),()=>idleStates);
 useEffect(()=>{if(open&&session&&!waitingReason)session.start();},[open,session,waitingReason]);
 useEffect(()=>{
  if(!open||!dialog.current)return;const view=dialog.current,overflow=document.body.style.overflow;closing.current=false;view.showModal();document.body.style.overflow='hidden';
  const saved=contextRef.current,wanted=saved.documentFocus,scroll=saved.documentScroll??0;let finished=false;
  const restore=()=>{if(finished||!body.current)return;const target=wanted?view.querySelector<HTMLElement>(`[data-document-focus="${CSS.escape(wanted)}"]`):null;if(wanted&&!target)return;restoring.current=true;body.current.scrollTop=scroll;target?.focus({preventScroll:true});restoring.current=false;finished=true;observer.disconnect();};
  const observer=new MutationObserver(restore),stop=()=>{finished=true;observer.disconnect();};observer.observe(view,{childList:true,subtree:true});const frame=requestAnimationFrame(restore),timer=setTimeout(stop,10000);view.addEventListener('pointerdown',stop);view.addEventListener('keydown',stop);view.addEventListener('wheel',stop);
  return()=>{closing.current=true;clearTimeout(timer);clearTimeout(scrollTimer.current);cancelAnimationFrame(frame);observer.disconnect();view.removeEventListener('pointerdown',stop);view.removeEventListener('keydown',stop);view.removeEventListener('wheel',stop);view.close();document.body.style.overflow=overflow;const trigger=lastTrigger.current?.isConnected?lastTrigger.current:directory.current?.querySelector<HTMLElement>('[data-document-trigger]');trigger?.focus({preventScroll:true});};
 },[open]);
 const closeAll=()=>{closing.current=true;changeRef.current({documentView:undefined});dialog.current?.close();};
 const navigate=(path:string)=>{const next={...contextRef.current,documentView:'all' as const,documentFocus:documentFocusKey(path),documentScroll:Math.round(body.current?.scrollTop??contextRef.current.documentScroll??0)};if(!restoring.current)changeRef.current({documentFocus:next.documentFocus,documentScroll:next.documentScroll});return next;};
 const openAll=(category?:CategoryDefinition,trigger?:HTMLElement)=>{lastTrigger.current=trigger??null;const current=contextRef.current,paths=(current.documentOpen??'').split('|').filter(Boolean);changeRef.current({documentView:'all',documentStage:category?.stage,documentSearch:undefined,documentScroll:0,documentFocus:category?.key??'document-search',...(category?{documentOpen:[...new Set([...paths,category.key])].join('|')}:{})});onRefreshIdentity();};
 const visible=COCKPIT_DOCUMENT_CATEGORIES.filter(c=>!states[c.key].denied&&states[c.key].data?.state!=='not_applicable');
 const displayState=(key:CockpitDocumentCategory):CockpitDirectoryState=>identityError?{phase:'error',error:identityError}:states[key];
 return <div className="cockpit-document-directory" role="region" aria-label="本单相关单据" ref={directory}>
  <div className="cockpit-document-priority" role="region" aria-label="生产常用单据" tabIndex={0}>{COCKPIT_PRIORITY_DOCUMENTS.filter(c=>visible.some(v=>v.key===c.key)).map(c=>{const state=displayState(c.key);return <button className="cockpit-document-priority-row" data-category={c.key} data-read-state={state.phase} data-state={state.data?.state??'unknown'} type="button" key={c.key} onClick={event=>openAll(c,event.currentTarget)}><span>{c.label}</span><small>{stateLabel(state,waitingReason)}</small><span className="cockpit-document-chevron" aria-hidden="true">›</span></button>;})}</div>
  {identityError&&<p role="alert">{identityError}</p>}
  <footer className="cockpit-document-footer"><button type="button" className="journey-text-action cockpit-document-open-all" data-document-trigger onClick={event=>openAll(undefined,event.currentTarget)}>查看全部</button></footer>
  <dialog ref={dialog} className="cockpit-documents-dialog" aria-label="全部相关单据" onKeyDown={trapCockpitDialogFocus} onCancel={event=>{event.preventDefault();closeAll();}} onClose={()=>{if(!dialog.current?.open&&!closing.current)changeRef.current({documentView:undefined});}}>
   <header><div><h2>全部相关单据</h2><p>{order.designStyleNo} · 按流程查看原单、采用版及历史</p></div><button type="button" autoFocus aria-label="关闭全部相关单据" onClick={closeAll}>×</button></header>
   <div className="cockpit-document-filters"><label>流程阶段<select aria-label="单据流程阶段" value={context.documentStage??''} onChange={event=>changeRef.current({documentStage:event.target.value as CockpitContext['documentStage']||undefined,documentScroll:0})}><option value="">全部七阶段</option>{JOURNEY_STAGES.map(stage=><option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label><label>查找已读取资料<input data-document-focus="document-search" aria-label="查找已读取资料" value={context.documentSearch??''} maxLength={100} placeholder="标题 / 备注 / 已载入文件名" onChange={event=>changeRef.current({documentSearch:event.target.value,documentScroll:0})}/></label></div>
   <p className="cockpit-document-read-note">未展开的历史原件按需读取；有记录不等同于资料已有效。</p>
   <div ref={body} className="cockpit-document-modal-scroll" role="region" aria-label="按节点分类的原单目录" tabIndex={0} onScroll={()=>{if(restoring.current)return;clearTimeout(scrollTimer.current);const scroll=Math.round(body.current?.scrollTop??0);scrollTimer.current=setTimeout(()=>changeRef.current({documentScroll:scroll}),80);}}>
    {JOURNEY_STAGES.filter(stage=>!context.documentStage||context.documentStage===stage.key).map(stage=><section className="cockpit-document-stage" key={stage.key}><h3>{stage.label}</h3>{visible.filter(c=>c.stage===stage.key).map(category=><Category key={category.key} category={category} state={displayState(category.key)} session={session} context={context} onChange={onChange} onNavigate={navigate} waitingReason={waitingReason} onRetryIdentity={onRefreshIdentity} query={context.documentSearch??''}/>)}</section>)}
   </div>
   <footer><span>仅查找当前可读取且已载入的资料；后续分页可在原分类继续读取。</span><Button type="button" variant="secondary" onClick={closeAll}>关闭</Button></footer>
  </dialog>
 </div>;
}
export function CockpitDocuments({order,context,onChange}:{order:OrderJourney;context:CockpitContext;onChange(patch:Partial<CockpitContext>):void}){
 const [identity,setIdentity]=useState<{actorId:string;signature:string}|null>(null),[revalidating,setRevalidating]=useState(false),refreshGeneration=useRef(0),[authRevision,setAuthRevision]=useState(0),[identityError,setIdentityError]=useState('');
 useEffect(()=>{let live=true;const reset=()=>{setIdentity(null);setAuthRevision(value=>value+1);};documentIdentityListeners.add(reset);setIdentityError('');void verifySession().then(verified=>{if(!live||cachedVerifiedSession()!==verified)return;if(verified==='denied'||verified.status!=='authorized'){setIdentityError('登录状态尚未确认，请重新登录后读取本单资料。');return;}setIdentity({actorId:verified.user.id,signature:verifiedSessionIdentity(verified)});});return()=>{live=false;documentIdentityListeners.delete(reset);};},[authRevision]);
 const refreshIdentity=()=>{const generation=++refreshGeneration.current;setRevalidating(true);setIdentityError('');void refreshSession().then(verified=>{if(generation!==refreshGeneration.current||cachedVerifiedSession()!==verified)return;setRevalidating(false);if(verified==='denied'||verified.status!=='authorized'){setIdentity(null);setIdentityError('当前身份尚未通过读取核验；未展示任何原记录或数量。');return;}setIdentity({actorId:verified.user.id,signature:verifiedSessionIdentity(verified)});});};
 const fallback=useMemo(()=>++fallbackSnapshotSequence,[order]),current=identity&&identity.signature===verifiedSessionIdentity(cachedVerifiedSession())?identity:null;
 const waitingReason=context.selected&&context.selected!==order.id?'正在读取所选订单，目录尚未读取。':context.round&&context.round!==order.selectedRound?'正在读取所选开发轮次，目录尚未读取。':!current||revalidating?'正在核验读取身份…':'';
 const key=JSON.stringify([context.selected,context.round,current?.actorId??'unverified',authRevision,order.id,order.sourceId,order.orderId,order.selectedRound,order.sourceVersion,order.instructionVersion,order.asOf??fallback,[...order.links,...order.stages.flatMap(stage=>stage.nodes.flatMap(node=>node.records))].map(record=>[record.domain,record.id,record.version,record.lineId])]);
 return <DocumentsForSnapshot key={key} order={order} context={context} onChange={onChange} identity={context.selected&&context.selected!==order.id||context.round&&context.round!==order.selectedRound?null:current} identityError={identityError} waitingReason={waitingReason} onRefreshIdentity={refreshIdentity}/>;
}
export type {CockpitDocumentCategory};
