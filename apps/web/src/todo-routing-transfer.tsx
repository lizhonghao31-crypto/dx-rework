import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {Button} from '@dx-rework/ui';
import {TodoResponseSchema,TodoRoutingExceptionListResponseSchema,TransferTodoRoutingExceptionSchema,type TodoResponse,type TodoRoutingException} from '@dx-rework/contracts';
import {createWebUrls} from '../url-contract.js';
import {SearchableSelect} from './search-select.js';
import {roleLabel} from './components.js';
import {digitalRequest} from './digital-production-api.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import './todo-routing-transfer.css';
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
const Candidates=z.array(z.object({id:z.string().uuid(),displayName:z.string(),roles:z.array(z.string())}).strict());
type Person=z.infer<typeof Candidates>[number];
const message=(status:number,reason?:string)=>reason&&/[\u3400-\u9fff]/u.test(reason)?reason:status===403?'当前身份或接手人不符合这项任务的权限，请核对后重试':status===404?'这项转交不存在或当前不可见':status===409?'这项转交的状态已变化，请重新读取后核对':status===401?'登录已失效，请重新登录':'转交资料未被接受，请检查后重试';
async function readExceptions(signal?:AbortSignal){
 const response=await fetch(apiUrl('todos/routing-exceptions/mine'),{credentials:'include',cache:'no-store',...(signal?{signal}:{})});const body:unknown=await response.json();if(!response.ok)throw Error(message(response.status));return TodoRoutingExceptionListResponseSchema.parse(body).routingExceptions;
}
/** Only the assigned manager's original exception and existing authorised people read. */
export function TodoRoutingTransfer({todo,canManage,onChanged}:{todo:TodoResponse;canManage:boolean;onChanged:()=>void}){
 const [open,setOpen]=useState(false),[exception,setException]=useState<TodoRoutingException|null>(null),[people,setPeople]=useState<Person[]>([]),[recipient,setRecipient]=useState(''),[reason,setReason]=useState(''),[loading,setLoading]=useState(false),[readReady,setReadReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0),[uncertain,setUncertain]=useState(false),[accepted,setAccepted]=useState(false);
 const attempt=useRef(new SubmissionAttempt()),writing=useRef(false);
 useEffect(()=>{
  if(!open||!canManage||accepted||attempt.current.hasPending)return;
  const abort=new AbortController();setLoading(true);setReadReady(false);setError('');
  void Promise.all([readExceptions(abort.signal),digitalRequest<unknown>('access/candidates','GET',undefined,undefined,{signal:abort.signal})]).then(([exceptions,candidates])=>{
   if(abort.signal.aborted)return;setException(exceptions.find(item=>item.routingTodoId===todo.todoId&&item.status==='pending')??null);setPeople(Candidates.parse(candidates));setReadReady(true);
  }).catch(cause=>{if(!abort.signal.aborted)setError(cause instanceof Error&&/[\u3400-\u9fff]/u.test(cause.message)?cause.message:'转交事项或接手人员读取失败，请重试');}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();
 },[open,canManage,todo.todoId,retry,accepted]);
 const submit=async()=>{
  if(writing.current||loading||!readReady||accepted||attempt.current.hasPending||!exception||!canManage)return;
  const parsed=TransferTodoRoutingExceptionSchema.safeParse({recipientUserId:recipient,reason});
  if(!parsed.success||!people.some(person=>person.id===recipient)){setError('请选择名单中的接手人并填写转交原因。');return;}
  writing.current=true;setBusy(true);setError('');const snapshot=parsed.data,originalId=exception.todoId,path=apiUrl(`todos/routing-exceptions/${exception.routingExceptionId}/transfer`);
  const result=await attempt.current.run(async()=>{
   const response=await fetch(path,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify(snapshot)});
   if(!response.ok){const body=await response.json().catch(()=>({})) as {error?:{message?:string;code?:string}};throw new SubmissionRequestError(message(response.status,body.error?.message),body.error?.code,response.status);}
   const transferred=TodoResponseSchema.parse(await response.json());if(transferred.todoId!==originalId||transferred.recipientUserId!==snapshot.recipientUserId)throw Error('转交结果尚待核对');
  });
  if(result.kind==='success'){setAccepted(true);setNotice(`已转交给${people.find(person=>person.id===snapshot.recipientUserId)?.displayName??'所选接手人'}，原任务的办理进度保留。`);onChanged();}
  else if(result.kind==='failure'){setUncertain(result.uncertain);setError(result.uncertain?'提交结果尚未确认，请先重新读取转交事项，暂不重复提交。':result.failure.message);}
  writing.current=false;setBusy(false);
 };
 const recheck=async()=>{
  if(writing.current)return;writing.current=true;setLoading(true);setError('');
  try{const exceptions=await readExceptions();const pending=exceptions.find(item=>item.routingTodoId===todo.todoId&&item.status==='pending');setNotice(pending?'这项转交仍在待处理列表，提交结果尚未确认，暂不重复提交。':'这项转交已不在待处理列表，请从原单核对当前接手结果。');}
  catch{setError('转交事项仍未读到，请稍后重新读取；暂不重复提交。');}finally{writing.current=false;setLoading(false);}
 };
 if(!canManage)return <p role="status">此项转交由当前指定的管理人办理。</p>;
 return <details className="todo-routing-transfer" onToggle={event=>setOpen(event.currentTarget.open)}><summary>选择接手人并转交</summary>
  <>
   {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{loading&&<p role="status">正在读取转交事项…</p>}
   {uncertain?<Button type="button" disabled={loading||busy} onClick={()=>void recheck()}>重新读取转交事项</Button>:!accepted&&<>
    {error&&<Button type="button" disabled={loading||busy} onClick={()=>setRetry(value=>value+1)}>重读转交事项与人员</Button>}
    {!loading&&!error&&!exception?<p>当前待处理列表中未找到这项转交，请刷新待办并从原单核对。</p>:null}
    {exception&&<form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={loading||busy||!readReady||accepted}>
     <label>接手人<SearchableSelect value={recipient} required onChange={event=>setRecipient(event.target.value)}><option value="">请选择在职接手人</option>{people.map(person=><option key={person.id} value={person.id}>{person.displayName} · {[...new Set(person.roles.map(code=>roleLabel(code)===code?'已登记岗位':roleLabel(code)))].join('、')}</option>)}</SearchableSelect></label>
     {!loading&&!people.length?<p>当前名单中暂无可选人员，请核对人员任职情况。</p>:null}
     <label>转交原因<textarea required maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label><Button type="submit" variant="primary" disabled={!people.length}>确认转交此项任务</Button>
    </fieldset></form>}
   </>}
  </>
 </details>;
}
