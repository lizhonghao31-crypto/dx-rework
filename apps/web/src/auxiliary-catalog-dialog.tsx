import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@dx-rework/ui';
import {AuxiliaryPageSchema,AuxiliaryItemSchema,CreateAuxiliarySchema,RenameAuxiliarySchema,DisableAuxiliarySchema,MergeAuxiliarySchema,type AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import {createWebUrls} from '../url-contract.js';
import {createClientRequestId} from './client-request-id.js';
import {PatternDialog} from './pattern-dialog.js';
import {confirmInApp} from './system-dialog.js';
import {useDebouncedValue} from './use-debounced-value.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {requestFailureMessage,transportFailure} from './request-failure-message.js';
import './auxiliary-catalog-dialog.css';
const urls=createWebUrls(import.meta.env.BASE_URL);
type Action='create'|'rename'|'disable'|'merge';
class CatalogError extends Error{constructor(message:string,readonly status:number|null){super(message);}}
async function request(path:string,method='GET',body?:unknown,key?:string,signal?:AbortSignal){
 const response=await fetch(urls.apiUrl(`master-data/auxiliaries${path}`),{method,credentials:'include',cache:'no-store',...(signal?{signal}:{}),headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}).catch(error=>{if(error?.name==='AbortError')throw error;throw new CatalogError(transportFailure(method).message,null);});
 const data=await response.json().catch(()=>null);if(!response.ok)throw new CatalogError(requestFailureMessage(response.status,data?.error?.message,method),response.status);if(!data)throw new CatalogError(method==='GET'?'未能读取辅料目录，请重试':'目录操作结果未确认，请先核对原回执',null);return data;
}
export function AuxiliaryCatalogDialog({onSelect,onClose,disabled=false}:{onSelect(item:AuxiliaryItem):void;onClose():void;disabled?:boolean}){
 const [search,setSearch]=useState(''),q=useDebouncedValue(search.trim(),250),[page,setPage]=useState(1),[includeInactive,setIncludeInactive]=useState(false),[refresh,setRefresh]=useState(0);
 const [result,setResult]=useState<ReturnType<typeof AuxiliaryPageSchema.parse>|null>(null),[readError,setReadError]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),writing=useRef(false),input=useRef<HTMLInputElement>(null);
 const [action,setAction]=useState<Action|null>(null),[source,setSource]=useState<AuxiliaryItem|null>(null),[target,setTarget]=useState<AuxiliaryItem|null>(null);
 const [name,setName]=useState(''),[specification,setSpecification]=useState(''),[supplier,setSupplier]=useState(''),[kind,setKind]=useState<AuxiliaryItem['auxiliaryKind']>('普通辅料'),[reason,setReason]=useState('');
 const attempt=useRef<{action:Action;path:string;body:unknown;key:string}|null>(null),locked=disabled||busy||unknown;
 useDigitalDetailNavigationGuard(unknown,busy,writing,'共享辅料操作结果仍未确认，离开不会撤销提交并会丢失本页重试标识。仍要离开？');
 useEffect(()=>{input.current?.focus();},[]);
 useEffect(()=>{const abort=new AbortController();setReadError('');setResult(null);void request(`?${new URLSearchParams({q,page:String(page),includeInactive:String(includeInactive)})}`,'GET',undefined,undefined,abort.signal).then(data=>{if(!abort.signal.aborted)setResult(AuxiliaryPageSchema.parse(data));}).catch(error=>{if(!abort.signal.aborted)setReadError(error.message);});return()=>abort.abort();},[q,page,includeInactive,refresh]);
 const edit=(next:Action,item:AuxiliaryItem|null=null)=>{if(locked)return;setAction(next);setSource(item);setTarget(null);setName(item?.name??search.trim());setSpecification(item?.specification??'');setSupplier(item?.supplier??'');setKind(item?.auxiliaryKind??'普通辅料');setReason('');setError('');attempt.current=null;};
 const complete=(item:AuxiliaryItem)=>{setUnknown(false);attempt.current=null;setAction(null);setSource(null);setNotice(`共享辅料“${item.name}”的目录操作已取得回执；订单资料尚未保存。请搜索并选择当前有效条目。`);setRefresh(x=>x+1);};
 const send=async(prior:NonNullable<typeof attempt.current>)=>{
  if(writing.current)return;writing.current=true;setBusy(true);setError('');
  try{complete(AuxiliaryItemSchema.parse(await request(prior.path,'POST',prior.body,prior.key)));}
  catch(error){const uncertain=unknown||!(error instanceof CatalogError)||error.status===null||error.status===408||error.status>=500;setUnknown(uncertain);setError(uncertain?`${error instanceof CatalogError?error.message:'未收到有效目录回执'}；目录操作结果尚未确认，请保留本页标识先核对回执；订单材料尚未改变。`:error.message);}
  finally{writing.current=false;setBusy(false);}
 };
 const recover=async(retry=false)=>{const prior=attempt.current;if(!prior||writing.current)return;writing.current=true;setBusy(true);setError('');
  try{const data=await request(`/receipt?${new URLSearchParams({action:prior.action,key:prior.key})}`);if(data.receipt){complete(AuxiliaryItemSchema.parse(data.receipt));return;}if(!retry){setError('尚未查到原目录回执，结果仍未确认；请稍后核对，或沿原标识重试。');return;}}
  catch(error){setError(`原目录操作仍未确认：${error instanceof Error?error.message:'服务暂未响应'}。请保留原标识。`);return;}
  finally{writing.current=false;setBusy(false);}
  await send(prior);
 };
 const submit=async()=>{if(locked||!action)return;const body=action==='create'?CreateAuxiliarySchema.safeParse({name,specification,supplier,auxiliaryKind:kind}):action==='rename'?RenameAuxiliarySchema.safeParse({expectedVersion:source?.version,name,reason}):action==='disable'?DisableAuxiliarySchema.safeParse({expectedVersion:source?.version,reason}):MergeAuxiliarySchema.safeParse({expectedVersion:source?.version,targetId:target?.id,expectedTargetVersion:target?.version,reason});
  if(!body.success){setError(body.error.issues[0]?.message??'请核对目录资料');return;}
  const path=action==='create'?'':`/${source!.id}/${action==='rename'?'versions':action}`;
  if(!attempt.current||attempt.current.path!==path||JSON.stringify(attempt.current.body)!==JSON.stringify(body.data))attempt.current={action,path,body:body.data,key:createClientRequestId()};await send(attempt.current);
 };
 const close=async()=>{if(busy||disabled)return;if(unknown&&!await confirmInApp('目录提交仍未确认，关闭不会撤销操作，并会丢失本页核对标识。仍要关闭？'))return;onClose();};
 return createPortal(<PatternDialog title="共享辅料" busy={busy||disabled} onClose={()=>void close()}><section className="auxiliary-catalog-dialog"><header><h2>选择共享辅料</h2><p>选择只填入本行资料；本轮是否使用仍由文员核料确认。</p></header>
  <div className="auxiliary-catalog-search"><label>搜索品名、规格或供应方<input ref={input} value={search} maxLength={100} disabled={busy} onChange={event=>{setSearch(event.target.value);setPage(1);}}/></label><label><input type="checkbox" checked={includeInactive} disabled={busy} onChange={event=>{setIncludeInactive(event.target.checked);setPage(1);}}/>显示停用及已合并记录</label>{result?.canManage&&<Button type="button" disabled={locked} onClick={()=>edit('create')}>直接新增辅料</Button>}</div>
  {notice&&<p role="status">{notice}</p>}{readError&&<p role="alert">{readError}<Button type="button" disabled={busy} onClick={()=>setRefresh(x=>x+1)}>重新读取目录</Button></p>}{!result&&!readError&&<p role="status">正在读取共享辅料…</p>}
  <div className="auxiliary-catalog-results">{result?.items.map(item=><article key={item.id}><div><strong>{item.name}</strong><span>{item.auxiliaryKind} · 规格：{item.specification||'未填写'} · 供应方：{item.supplier||'未填写'}</span>{!item.active&&<small>{item.mergedInto?'已合并，保留原引用':'已停用，旧订单快照保留'}</small>}</div><div>{action==='merge'?<Button type="button" disabled={locked||!item.active||Boolean(item.mergedInto)||item.id===source?.id} onClick={()=>setTarget(item)}>作为合并目标</Button>:<Button type="button" disabled={locked||!item.active||Boolean(item.mergedInto)} onClick={()=>{onSelect(item);onClose();}}>选择此辅料</Button>}{result.canManage&&!item.mergedInto&&<><Button type="button" disabled={locked} onClick={()=>edit('rename',item)}>改名</Button><Button type="button" disabled={locked} onClick={()=>edit('merge',item)}>合并重复项</Button>{item.active&&<Button type="button" disabled={locked} onClick={()=>edit('disable',item)}>停用</Button>}</>}</div></article>)}</div>
  {result&&!result.items.length&&<p>没有匹配的辅料。可换关键词，或由有权岗位直接新增。</p>}{result&&<nav aria-label="辅料目录分页"><Button type="button" disabled={busy||page===1} onClick={()=>setPage(page-1)}>上一页辅料</Button><span>第 {page} 页 · 共 {result.total} 项</span><Button type="button" disabled={busy||page*result.pageSize>=result.total} onClick={()=>setPage(page+1)}>下一页辅料</Button></nav>}
  {action&&<form onSubmit={event=>{event.preventDefault();event.stopPropagation();void submit();}}><h3>{({create:'直接新增共享辅料',rename:'改名',disable:'停用',merge:'合并重复项'})[action]}</h3>{source&&<p>当前辅料：{source.name} · 版本 {source.version}</p>}{(action==='create'||action==='rename')&&<label>辅料品名<input value={name} maxLength={100} disabled={locked} onChange={event=>setName(event.target.value)}/></label>}{action==='create'&&<><label>规格<input value={specification} maxLength={100} disabled={locked} onChange={event=>setSpecification(event.target.value)}/></label><label>供应方<input value={supplier} maxLength={100} disabled={locked} onChange={event=>setSupplier(event.target.value)}/></label><label>辅料分类<select value={kind} disabled={locked} onChange={event=>setKind(event.target.value as typeof kind)}>{['普通辅料','拉链','扁机'].map(value=><option key={value}>{value}</option>)}</select></label></>}{action==='merge'&&<p>请搜索并选定重复项的保留目标。合并后保留：{target?`${target.name} · 版本 ${target.version}`:'尚未选择'}。分类、规格及供应方须一致，原引用与历史名称保留。</p>}{action!=='create'&&<label>本次变更原因<textarea value={reason} disabled={locked} maxLength={500} onChange={event=>setReason(event.target.value)}/></label>}{error&&<p role="alert">{error}</p>}{unknown&&<section><p>原操作标识：{attempt.current?.key}</p><Button type="button" disabled={busy} onClick={()=>void recover()}>核对原目录回执</Button><Button type="button" disabled={busy} onClick={()=>void recover(true)}>沿原标识重试目录操作</Button></section>}<div><Button type="button" disabled={locked} onClick={()=>{setAction(null);setError('');}}>取消本次编辑</Button><Button type="submit" variant="primary" disabled={locked}>{busy?'保存目录中…':'保存共享目录'}</Button></div></form>}
  <footer><Button type="button" disabled={busy||disabled} onClick={()=>void close()}>关闭辅料选择</Button></footer>
 </section></PatternDialog>,document.body);
}
