import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {TodoResponseSchema,TodoReadReceiptSchema,type TodoResponse,type TodoRouteDescriptor} from '@dx-rework/contracts';
import {createWebUrls} from '../url-contract.js';
import {verifySession,cachedVerifiedSession,sessionCacheVersion,registerSessionInvalidator} from './auth-session.js';
import {requestFailureMessage} from './request-failure-message.js';
import {publishTodoRead} from './todo-indicator-refresh.js';

export type TodoContentScope={routeName:TodoRouteDescriptor['routeName'];entityId:string;developmentRound?:number|undefined;reportIds?:string[]|undefined;factoryDecisionId?:string|null|undefined};
class RejectedTodoRead extends Error { constructor(message:string,readonly status:number){super(message);} }
const ReadContext=createContext<((scope:TodoContentScope)=>boolean)|null>(null),urls=createWebUrls(import.meta.env.BASE_URL);
const sessionListeners=new Set<()=>void>();registerSessionInvalidator(()=>{for(const reset of sessionListeners)reset();});
const activeActor=()=>{const session=cachedVerifiedSession();return session&&session!=='denied'?session.user.id:null;};
const matches=(todo:TodoResponse,scope:TodoContentScope)=>todo.route.routeName===scope.routeName&&todo.route.entityId===scope.entityId&&
 (todo.route.developmentRound===undefined||todo.route.developmentRound===scope.developmentRound)&&
 (todo.route.factoryDecisionId===undefined||todo.route.factoryDecisionId===scope.factoryDecisionId)&&
 (todo.category!=='digital_fabric_decision'||scope.reportIds?.includes(todo.todoId)===true);

/** Obtain a personal content token before mounting business readers. A token
 * fetched after an older business response must never mark newer content read. */
export function TodoReadBoundary({children}:{children:ReactNode}){
 const todoId=new URLSearchParams(window.location.search).get('todo');
 return <PersonalTodoReader key={todoId??'direct'}>{children}</PersonalTodoReader>;
}
function PersonalTodoReader({children}:{children:ReactNode}){
 const todoId=new URLSearchParams(window.location.search).get('todo');
 const [attempt,setAttempt]=useState(0),[metadata,setMetadata]=useState<TodoResponse|null>(null),[phase,setPhase]=useState<'loading'|'ready'|'error'|'bypass'>('loading');
 const [error,setError]=useState(''),[syncError,setSyncError]=useState(''),[syncing,setSyncing]=useState(false);
 const version=useRef<number|null>(null),alive=useRef(true),writing=useRef(false),completed=useRef(''),readyScope=useRef<TodoContentScope|null>(null);
 useEffect(()=>{alive.current=true;const reset=()=>{version.current=null;readyScope.current=null;completed.current='';setMetadata(null);setPhase('error');setError('账号状态已变化，请重新核对本人事项。');};sessionListeners.add(reset);return()=>{alive.current=false;sessionListeners.delete(reset);};},[]);
 useEffect(()=>{
  if(!todoId){setPhase('bypass');return;}
  let live=true;const abort=new AbortController();setPhase('loading');setError('');setSyncError('');setMetadata(null);readyScope.current=null;completed.current='';
  void(async()=>{
   const session=await verifySession();if(!live)return;if(session==='denied')throw Error('登录状态未确认，请重新登录后打开本人事项。');
   const epoch=sessionCacheVersion();version.current=epoch;
   const response=await fetch(urls.apiUrl(`todos/mine/${encodeURIComponent(todoId)}`),{credentials:'include',cache:'no-store',signal:abort.signal});
   const body=await response.json().catch(()=>null);if(!live||epoch!==sessionCacheVersion())return;if(!response.ok){if(response.status===403||response.status===404){setError(requestFailureMessage(response.status,body?.error?.message,"GET"));setPhase('bypass');return;}throw Error(requestFailureMessage(response.status,body?.error?.message,"GET"));}
   const parsed=TodoResponseSchema.safeParse(body);if(!parsed.success)throw Error("本人事项资料不完整或格式无效，请重试；仍失败请管理员核对事项接口响应");const todo=parsed.data;if(!live||epoch!==sessionCacheVersion())return;
   if(todo.recipientUserId!==session.user.id)throw Error('事项不属于当前账号，本次不记录已读。');
   setMetadata(todo);setPhase('ready');
  })().catch(reason=>{if(live&&!abort.signal.aborted){setError(reason instanceof Error?reason.message:'本人事项暂未核对成功');setPhase('error');}});
  return()=>{live=false;abort.abort();};
 },[todoId,attempt]);
 const mark=useCallback(async(scope:TodoContentScope)=>{
  if(!metadata?.contentToken||writing.current||completed.current===metadata.contentToken||version.current!==sessionCacheVersion()||activeActor()!==metadata.recipientUserId||!matches(metadata,scope))return;
  readyScope.current=scope;writing.current=true;setSyncing(true);setSyncError('');
  try{
   // Natural (person, item, token) uniqueness makes retries safe. Never abort a
   // sent write or replace its content token when the outcome is uncertain.
   const response=await fetch(urls.apiUrl(`todos/mine/${metadata.todoId}/read`),{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({contentToken:metadata.contentToken,route:metadata.route})});
   const body=await response.json().catch(()=>null);if(!response.ok){const message=requestFailureMessage(response.status,body?.error?.message,"POST");if(response.status>=400&&response.status<500&&response.status!==408)throw new RejectedTodoRead(message,response.status);throw Error(message);}
   const parsed=TodoReadReceiptSchema.safeParse(body);if(!parsed.success)throw Error('未收到有效阅读回执，结果尚未确认');const receipt=parsed.data;if(receipt.contentToken!==metadata.contentToken)throw Error('事项阅读回执不匹配，请保留当前内容后重新核对');
   if(version.current!==sessionCacheVersion()||activeActor()!==metadata.recipientUserId)return;
   completed.current=metadata.contentToken;publishTodoRead(metadata.recipientUserId);
  }catch(reason){if(alive.current&&version.current===sessionCacheVersion()&&activeActor()===metadata.recipientUserId){if(reason instanceof RejectedTodoRead){readyScope.current=null;completed.current='';setMetadata(null);setSyncError('');setError(`${reason.message} 本次阅读记录被拒绝，事项内容、归属或权限可能已变化；请重新核对事项并读取当前内容。`);setPhase('error');}else setSyncError(`阅读状态尚未确认：${reason instanceof Error?reason.message:'服务暂未响应'}。可仅重试当前内容的已读同步；这不代表资料仍是最新版本。`);}}
  finally{writing.current=false;if(alive.current)setSyncing(false);}
 },[metadata]);
 const contentRead=useCallback((scope:TodoContentScope)=>{if(!metadata?.contentToken||!matches(metadata,scope))return false;void mark(scope);return true;},[mark,metadata]);
 if(!todoId)return <>{children}</>;
 if(phase==='loading')return <p role="status">正在核对本人事项…</p>;
 if(phase==='error')return <section><p role="alert">{error} 尚未记录已读。</p><button type="button" onClick={()=>setAttempt(x=>x+1)}>重试核对事项</button><button type="button" onClick={()=>setPhase('bypass')}>继续查看，本次不记录已读</button></section>;
 return <ReadContext.Provider value={phase==='ready'?contentRead:null}>{phase==='bypass'&&error&&<p role="status">{error} 本次不记录已读；资料仍按原查看权限读取。</p>}{children}{syncError&&<p role="status">{syncError}<button type="button" disabled={syncing} onClick={()=>{if(readyScope.current)void mark(readyScope.current);}}>仅重试已读同步</button></p>}</ReadContext.Provider>;
}

/** Call only after the corresponding business body has successfully rendered. */
export function useTodoContentRead(scope:TodoContentScope,ready:boolean){
 const contentRead=useContext(ReadContext),identity=JSON.stringify(scope),element=useRef<HTMLElement|null>(null);
 const attach=useCallback((node:HTMLElement|null)=>{element.current=node;},[]);
 useEffect(()=>{
  if(!ready||!contentRead||!element.current)return;
  const check=()=>{const node=element.current;if(node&&document.visibilityState!=='hidden'&&!node.closest('[hidden],[aria-hidden="true"]')&&!['hidden','collapse'].includes(getComputedStyle(node).visibility)&&node.getClientRects().length)contentRead(JSON.parse(identity) as TodoContentScope);};
  const observer=new MutationObserver(check);for(let node:HTMLElement|null=element.current;node;node=node.parentElement)observer.observe(node,{attributes:true,attributeFilter:['hidden','aria-hidden','style','class']});
  check();document.addEventListener('visibilitychange',check);return()=>{observer.disconnect();document.removeEventListener('visibilitychange',check);};
 },[contentRead,identity,ready]);
 return attach;
}
