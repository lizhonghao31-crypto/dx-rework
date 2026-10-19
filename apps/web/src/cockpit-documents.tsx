import {useEffect,useRef,useState} from "react";
import type {OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {createWebUrls} from "../url-contract.js";
import {requestFailureMessage} from "./request-failure-message.js";
import {journeyRecordHref,journeyTime,type CockpitContext} from "./digital-journey-cockpit-model.js";
import {COCKPIT_DOCUMENT_CATEGORIES,loadCockpitDocumentCategory,loadCockpitDocumentEntry,type CockpitDocumentCategory,type CockpitDocumentEntry,type CockpitDocumentReader,type CockpitDocumentResult} from "./cockpit-documents-model.js";
import "./cockpit-documents.css";
const urls=createWebUrls(import.meta.env.BASE_URL);
class DocumentReadError extends Error{constructor(message:string,readonly status:number){super(message);}}
const read:CockpitDocumentReader=async(path,signal)=>{
 const response=await fetch(urls.apiUrl(path),{credentials:"include",cache:"no-store",signal}).catch(reason=>{if(reason.name==="AbortError")throw reason;throw new Error("资料读取失败，请检查连接后重试");});
 if(!response.ok){const data=await response.json().catch(()=>({}));throw new DocumentReadError(requestFailureMessage(response.status,data.error?.message),response.status);}
 return response.json().catch(()=>{throw new Error("资料返回异常，请重试");});
};
function Entry({entry,context,path,openPaths,onToggle}:{entry:CockpitDocumentEntry;context:CockpitContext;path:string;openPaths:string[];onToggle(path:string,open:boolean):void}){
 const [loaded,setLoaded]=useState<CockpitDocumentEntry|null>(null),[error,setError]=useState(""),[retry,setRetry]=useState(0),open=openPaths.includes(path);
 useEffect(()=>{if(!open||!entry.load)return;let live=true;const controller=new AbortController();setLoaded(null);setError("");void loadCockpitDocumentEntry(entry,read,controller.signal).then(value=>{if(live)setLoaded(value);}).catch(reason=>{if(live&&reason.name!=="AbortError")setError(reason instanceof DocumentReadError&&reason.status===403?"当前身份无权读取此版本资料。":reason instanceof DocumentReadError&&reason.status===404?"所选历史版本或原件暂不可用，请返回来源核对。":reason.message);});return()=>{live=false;controller.abort();};},[open,entry,retry]);
 const item=loaded??entry,children=item.children??[],files=item.files??[],canExpand=Boolean(entry.load||children.length||files.length);
 const content=<><strong>{item.label}</strong>{item.at&&<small>{journeyTime(item.at)}{item.by?` · ${item.by}`:""}</small>}{item.note&&<p>{item.note}</p>}{item.url&&<a href={urls.pageUrl(journeyRecordHref(item.url,context,"read"))}>查看原记录</a>}</>;
 return canExpand?<details className="cockpit-document-entry" open={open} onToggle={event=>{if(event.currentTarget.open!==open)onToggle(path,event.currentTarget.open);}}><summary>{entry.label}</summary>{open&&<div>{error?<p role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试读取此版本</button></p>:entry.load&&!loaded?<p role="status">正在读取此版本…</p>:<>{content}{files.map(file=><div className="cockpit-document-file" key={file.id}>{file.path?<a href={urls.apiUrl(file.path)} target="_blank" rel="noreferrer" title={file.name}>{file.name}</a>:<span tabIndex={0} title={file.name}>{file.name}</span>}{file.note&&<small>{file.note}</small>}{file.at&&<small>{journeyTime(file.at)}{file.by?` · ${file.by}`:""}</small>}</div>)}{children.map(child=><Entry key={child.id} entry={child} context={context} path={`${path}/${child.id}`} openPaths={openPaths} onToggle={onToggle}/>)}{!files.length&&!children.length&&!item.url&&<p>尚无可打开的原件或历史记录。</p>}</>}</div>}</details>:<article className="cockpit-document-entry">{content}</article>;
}
function Category({category,order,context,onChange}:{category:typeof COCKPIT_DOCUMENT_CATEGORIES[number];order:OrderJourney;context:CockpitContext;onChange(patch:Partial<CockpitContext>):void}){
 const paths=(context.documentOpen??"").split("|").filter(Boolean),open=paths.includes(category.key),[data,setData]=useState<CockpitDocumentResult|null>(null),[error,setError]=useState(""),[retry,setRetry]=useState(0),[page,setPage]=useState(1),[busy,setBusy]=useState(false);
 const key=`${order.id}:${order.asOf??""}:${order.selectedRound??""}`,lastKey=useRef(key);
 useEffect(()=>{if(key!==lastKey.current){setData(null);setPage(1);lastKey.current=key;}},[key]);
 useEffect(()=>{if(!open)return;let live=true;const controller=new AbortController();setBusy(true);setError("");void loadCockpitDocumentCategory(order,category.key,read,controller.signal,page).then(value=>{if(live)setData(previous=>page>1&&previous?{...value,state:previous.entries.length||value.entries.length?"created":value.state,entries:[...previous.entries,...value.entries.filter(entry=>!previous.entries.some(old=>old.id===entry.id))]}:value);}).catch(reason=>{if(live&&reason.name!=="AbortError"){setData(null);setError(reason instanceof DocumentReadError&&reason.status===403?"当前身份无权读取此类资料。":reason instanceof DocumentReadError&&reason.status===404?"资料不存在或不在授权范围，无法确认是否已创建。":reason.message);}}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;controller.abort();};},[open,key,retry,page,category.key,order]);
 const toggle=(path:string,isOpen:boolean)=>{const next=isOpen?[...new Set([...paths,path])]:paths.filter(item=>item!==path&&!item.startsWith(path+"/"));onChange({documentOpen:next.join("|")});};
 const labels={created:"已创建",missing:"待创建",not_applicable:"不适用",unknown:"待判断"};
 return <details className="cockpit-document-category" open={open} onToggle={event=>{if(event.currentTarget.open!==open)toggle(category.key,event.currentTarget.open);}}><summary><strong>{category.label}</strong><span>{error?"读取受限":data?labels[data.state]:"待判断"}</span></summary>{open&&<div>{error?<p role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试读取目录</button></p>:<>{data?.note&&<p>{data.note}</p>}{data?.entries.map(entry=><Entry key={entry.id} entry={entry} context={context} path={`${category.key}/${entry.id}`} openPaths={paths} onToggle={toggle}/>)}{data?.state==="missing"&&<p>当前授权范围未见已创建资料。</p>}{data?.nextPage&&<button type="button" disabled={busy} onClick={()=>setPage(data.nextPage!)}>读取下一页关联单据</button>}{busy&&<p role="status">正在读取资料…</p>}</>}</div>}</details>;
}
export function CockpitDocuments({order,context,onChange}:{order:OrderJourney;context:CockpitContext;onChange(patch:Partial<CockpitContext>):void}){
 return <div className="cockpit-document-directory" aria-label="本单11类相关资料">{COCKPIT_DOCUMENT_CATEGORIES.map(category=><Category key={`${order.id}:${category.key}`} category={category} order={order} context={context} onChange={onChange}/>)}</div>;
}
export type {CockpitDocumentCategory};
