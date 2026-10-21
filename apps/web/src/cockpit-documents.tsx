import {cachedVerifiedSession,verifySession,invalidateSession,sessionCacheVersion,registerSessionInvalidator} from './auth-session.js';
import {useEffect,useMemo,useState,useSyncExternalStore} from "react";
import type {OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {createWebUrls} from "../url-contract.js";
import {requestFailureMessage} from "./request-failure-message.js";
import {journeyRecordHref,journeyTime,type CockpitContext} from "./digital-journey-cockpit-model.js";
import {COCKPIT_DOCUMENT_CATEGORIES,createCockpitDocumentSnapshot,emptyCockpitDirectoryStates,type CockpitDocumentSnapshot,type CockpitDirectoryState,type CockpitDocumentCategory,type CockpitDocumentEntry,type CockpitDocumentMetadataFact,type CockpitDocumentReader} from "./cockpit-documents-model.js";
import "./cockpit-documents.css";
const urls=createWebUrls(import.meta.env.BASE_URL);
class DocumentReadError extends Error{constructor(message:string,readonly status:number){super(message);}}
const read:CockpitDocumentReader=async(path,signal)=>{
 const response=await fetch(urls.apiUrl(path),{credentials:"include",cache:"no-store",signal}).catch(reason=>{if(reason.name==="AbortError")throw reason;throw new Error("资料读取失败，请检查连接后重试");});
 if(!response.ok){const data=await response.json().catch(()=>({}));throw new DocumentReadError(requestFailureMessage(response.status,data.error?.message),response.status);}
 return response.json().catch(()=>{throw new Error("资料返回异常，请重试");});
};
function MetadataSummary({facts}:{facts:CockpitDocumentMetadataFact[]}){
 const groups=new Map<string,{labels:string[];at:string;by:string}>(),missing:string[]=[];
 for(const fact of facts){if(!fact.at&&!fact.by){missing.push(fact.label);continue;}const key=JSON.stringify([fact.at,fact.by]),group=groups.get(key);if(group)group.labels.push(fact.label);else groups.set(key,{labels:[fact.label],at:fact.at,by:fact.by});}
 return <div className="cockpit-document-metadata">{groups.size>0&&<dl>{[...groups.values()].map(group=><div key={group.labels.join("/")}><dt>{group.labels.join(" / ")}</dt><dd>{group.by||"人员未记录"} · {group.at?<time title={group.at}>{journeyTime(group.at)}</time>:"时间未记录"}</dd></div>)}</dl>}{missing.length>0&&<p>{missing.join(" / ")}：未记录</p>}</div>;
}
function Entry({entry,context,path,openPaths,onToggle,readEntry}:{readEntry:CockpitDocumentSnapshot["loadEntry"];entry:CockpitDocumentEntry;context:CockpitContext;path:string;openPaths:string[];onToggle(path:string,open:boolean):void}){
 const [loaded,setLoaded]=useState<CockpitDocumentEntry|null>(null),[error,setError]=useState(""),[retry,setRetry]=useState(0),open=openPaths.includes(path);
 useEffect(()=>{if(!open||!entry.load)return;let live=true;const controller=new AbortController();setLoaded(null);setError("");void readEntry(entry,controller.signal).then(value=>{if(live)setLoaded(value);}).catch(reason=>{if(live&&reason.name!=="AbortError")setError(reason instanceof DocumentReadError&&reason.status===403?"当前身份无权读取此版本资料。":reason instanceof DocumentReadError&&reason.status===404?"所选历史版本或原件暂不可用，请返回来源核对。":reason.message);});return()=>{live=false;controller.abort();};},[open,entry,retry,readEntry]);
 const item=loaded??entry,children=item.children??[],files=item.files??[],canExpand=Boolean(entry.load||children.length||files.length||item.metadata?.length),note=item.note&&!entry.label.includes(item.note)?item.note:undefined;
 const content=<><div className="cockpit-document-summary">{note&&<span>{note}</span>}{!item.metadata&&item.at&&<span>{journeyTime(item.at)}{item.by?` · ${item.by}`:""}</span>}{item.url&&<a href={urls.pageUrl(journeyRecordHref(item.url,context,"read"))}>查看原记录</a>}</div>{item.metadata&&<MetadataSummary facts={item.metadata}/>}</>;
 return canExpand?<details className="cockpit-document-entry" open={open} onToggle={event=>{if(event.currentTarget.open!==open)onToggle(path,event.currentTarget.open);}}><summary>{entry.label}</summary>{open&&<div className="cockpit-document-entry-body">{error?<p role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试读取此版本</button></p>:entry.load&&!loaded?<p role="status">正在读取此版本…</p>:<>{content}{files.map(file=><div className="cockpit-document-file" key={file.id}>{file.path?<a href={urls.apiUrl(file.path)} target="_blank" rel="noreferrer" title={file.name}>{file.name}</a>:<span tabIndex={0} title={file.name}>{file.name}</span>}{(file.note||file.at)&&<small>{[file.note,file.at?journeyTime(file.at):"",file.by].filter(Boolean).join(" · ")}</small>}</div>)}{children.map(child=><Entry readEntry={readEntry} key={child.id} entry={child} context={context} path={`${path}/${child.id}`} openPaths={openPaths} onToggle={onToggle}/>)}{!files.length&&!children.length&&!item.url&&<p>尚无可打开的原件或历史记录。</p>}</>}</div>}</details>:<article className="cockpit-document-entry"><strong>{item.label}</strong>{content}</article>;
}

const documentIdentityListeners=new Set<()=>void>();registerSessionInvalidator(()=>{for(const listener of documentIdentityListeners)listener();});
let fallbackSnapshotSequence=0;
const idleStates=emptyCockpitDirectoryStates(),noSubscription=()=>()=>undefined;
function Category({category,state,session,context,onChange,onRetryIdentity,waitingReason}:{waitingReason:string;category:typeof COCKPIT_DOCUMENT_CATEGORIES[number];state:CockpitDirectoryState;session:CockpitDocumentSnapshot|null;context:CockpitContext;onChange(patch:Partial<CockpitContext>):void;onRetryIdentity():void}){
 const paths=(context.documentOpen??"").split('|').filter(Boolean),open=paths.includes(category.key),data=state.data,error=state.error,busy=state.phase==='loading'||Boolean(waitingReason);
 const toggle=(path:string,isOpen:boolean)=>{const next=isOpen?[...new Set([...paths,path])]:paths.filter(item=>item!==path&&!item.startsWith(path+'/'));onChange({documentOpen:next.join('|')});};
 const labels={created:'已创建',missing:'尚未创建',not_applicable:'不适用',unknown:'无法确认'},label=busy?'读取中':state.phase==='error'?state.denied?'无权读取':'读取失败':data?labels[data.state]:'尚未读取';
 return <details className="cockpit-document-category" data-state={error?'error':data?.state??'unknown'} data-read-state={state.phase} open={open} onToggle={event=>{if(event.currentTarget.open!==open)toggle(category.key,event.currentTarget.open);}}><summary><strong>{category.label}</strong><span>{label}</span></summary>{open&&<div>{error?<p role="alert">{error}<button type="button" onClick={()=>session?void session.load(category.key):onRetryIdentity()}>重试读取目录</button></p>:<>{data?.note&&<p>{data.note}</p>}{data?.entries.map(entry=><Entry readEntry={session!.loadEntry} key={entry.id} entry={entry} context={context} path={`${category.key}/${entry.id}`} openPaths={paths} onToggle={toggle}/>)}{data?.state==='missing'&&<p>当前授权范围未见已创建资料。</p>}{data?.nextPage&&<button type="button" disabled={busy} onClick={()=>void session?.load(category.key,true)}>读取下一页关联单据</button>}{busy&&<p role="status">{waitingReason||'正在读取资料…'}</p>}</>}</div>}</details>;
}
function DocumentsForSnapshot({order,context,onChange,identity,onRetryIdentity,identityError,waitingReason}:{waitingReason:string;order:OrderJourney;context:CockpitContext;onChange(patch:Partial<CockpitContext>):void;identity:{actorId:string;epoch:number}|null;onRetryIdentity():void;identityError:string}){
 const [session,setSession]=useState<CockpitDocumentSnapshot|null>(null);
 useEffect(()=>{if(!identity)return;const current=createCockpitDocumentSnapshot(order,read,()=>{const verified=cachedVerifiedSession();return Boolean(identity.epoch===sessionCacheVersion()&&verified&&verified!=='denied'&&verified.user.id===identity.actorId);});setSession(current);current.start();return()=>current.dispose();},[]);
 const states=useSyncExternalStore(session?.subscribe??noSubscription,session?.getSnapshot??(()=>idleStates),()=>idleStates);
 return <>{COCKPIT_DOCUMENT_CATEGORIES.map(category=><Category key={category.key} category={category} state={identityError?{phase:'error',error:identityError}:states[category.key]} session={session} context={context} onChange={onChange} onRetryIdentity={onRetryIdentity} waitingReason={waitingReason}/>)}</>;
}
export function CockpitDocuments({order,context,onChange}:{order:OrderJourney;context:CockpitContext;onChange(patch:Partial<CockpitContext>):void}){
 const [identity,setIdentity]=useState<{actorId:string;epoch:number}|null>(null),[authRevision,setAuthRevision]=useState(0),[identityError,setIdentityError]=useState('');
 useEffect(()=>{let live=true;const reset=()=>{setIdentity(null);setAuthRevision(value=>value+1);};documentIdentityListeners.add(reset);setIdentityError('');void verifySession().then(verified=>{if(!live||cachedVerifiedSession()!==verified)return;if(verified==='denied'||verified.status!=='authorized'){setIdentityError('登录状态尚未确认，请重新登录后读取本单资料。');return;}setIdentity({actorId:verified.user.id,epoch:sessionCacheVersion()});});return()=>{live=false;documentIdentityListeners.delete(reset);};},[authRevision]);
 const fallback=useMemo(()=>++fallbackSnapshotSequence,[order]),current=identity?.epoch===sessionCacheVersion()?identity:null;
 const waitingReason=context.selected&&context.selected!==order.id?'正在读取所选订单，目录尚未读取。':context.round&&context.round!==order.selectedRound?'正在读取所选开发轮次，目录尚未读取。':'';
 const key=JSON.stringify([context.selected,context.round,current?.actorId??'unverified',current?.epoch??authRevision,order.id,order.sourceId,order.orderId,order.selectedRound,order.sourceVersion,order.instructionVersion,order.asOf??fallback,[...order.links,...order.stages.flatMap(stage=>stage.nodes.flatMap(node=>node.records))].map(record=>[record.domain,record.id,record.version,record.lineId])]);
 return <div className="cockpit-document-directory" role="region" tabIndex={0} aria-label="本单11类相关资料"><DocumentsForSnapshot key={key} order={order} context={context} onChange={onChange} identity={waitingReason?null:current} identityError={identityError} waitingReason={waitingReason} onRetryIdentity={invalidateSession}/></div>;
}
export type {CockpitDocumentCategory};
