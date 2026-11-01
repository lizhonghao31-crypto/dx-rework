import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {DigitalOrderInput} from '@dx-rework/contracts/digital-production';
import {matchingShortLeadApproval,type ShortLeadState} from '@dx-rework/contracts/short-commitment';
import {digitalRequest} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {verifySession} from './auth.js';
import './series-plan.css';
export function ShortLeadPanel({sourceId,order,onState,saveDraft,readOnly=false}:{sourceId:string|null;order?:DigitalOrderInput|undefined;onState?:(state:ShortLeadState|null)=>void;saveDraft?:()=>Promise<void>;readOnly?:boolean}){
 const [state,setState]=useState<ShortLeadState|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const writing=useRef(false),op=useRef<{payload:string;key:string}|null>(null),onStateRef=useRef(onState);onStateRef.current=onState;
 const base=sourceId?`sources/${sourceId}/short-lead-requests`:'short-lead-requests';
 const load=async()=>{await verifySession();const s=await digitalRequest<ShortLeadState>(base);setState(s);onStateRef.current?.(s);};
 useEffect(()=>{const c=new AbortController();setState(null);setError('');setMessage('');onStateRef.current?.(null);void (async()=>{await verifySession();return digitalRequest<ShortLeadState>(base,'GET',undefined,undefined,{signal:c.signal});})().then(s=>{setState(s);onStateRef.current?.(s);}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>c.abort();},[base]);
 const send=async(path:string,body:unknown,prepare=false)=>{if(writing.current)return;writing.current=true;setBusy(true);setError('');setMessage('');try{if(prepare&&saveDraft)await saveDraft();const payload=JSON.stringify([path,body]);if(op.current?.payload!==payload)op.current={payload,key:createClientRequestId()};await digitalRequest(path,'POST',body,op.current.key);setMessage('办理已保存。');try{await load();}catch{setError('办理已成功，但最新列表未读到；请重新读取，不要重复提交新申请。');}}catch(e){setError((e as Error).message);}finally{writing.current=false;setBusy(false);}};
 const approved=order&&state?matchingShortLeadApproval(order,state.requests):null;
 if(readOnly&&state&&!state.canApprove&&!state.requests.length)return null;
 return <details className="series-plan-panel"><summary>{readOnly?'短交期正式单特批':'不足30自然日正式下单特批'}<small>仅老板或Root批准；开发草稿仍可保存</small></summary>
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}<Button type="button" disabled={busy} onClick={()=>void load().catch(e=>setError(e.message))}>重新读取特批</Button>
  {!readOnly&&<><p>特批绑定本次客户、款号、PO、数量、日期及销售系列；更改这些资料需按新资料申请。批准不代替正式下单。</p>{!sourceId&&<p>请先用原按钮保存开发资料草稿，再提交本来源的短交期申请。</p>}</>}
  <label className="series-plan-fields">{readOnly?'审批原因':'申请 / 审批原因'}<textarea aria-label="短交期特批原因" maxLength={1000} rows={2} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
  {!readOnly&&state?.canRequest&&<Button type="button" disabled={busy||Boolean(approved)||!sourceId||!order||!reason.trim()} onClick={()=>void send(base,{order,reason},true)}>{approved?'本版已获特批，无需重复申请':'提交短交期特批申请'}</Button>}
  <div className="short-lead-table">{state?.requests.map(r=><article key={r.requestId}><strong>{r.designStyleNo} · {r.customerCode} · {r.consumedOrderId?'已用于正式单':r.decision?(r.decision.approved?'已批准':'已驳回'):'待老板 / Root批准'}</strong><dl><div><dt>客户约定出货日期</dt><dd>{r.facts.lines.map(l=>`${l.formalPoNo??l.color} ${l.customerDate??'未填'}`).join('；')}</dd></div><div><dt>申请人 / 承诺基准日</dt><dd>{r.requesterName} · {r.commitmentDay}</dd></div></dl><p>{r.reason}</p>{r.decision&&<p>{r.decision.deciderName}：{r.decision.reason}</p>}{r.staleReason&&<p role="status">{r.staleReason}</p>}{state.canApprove&&!r.decision&&<div className="series-plan-actions"><Button type="button" disabled={busy||!reason.trim()||Boolean(r.staleReason)} onClick={()=>void send(`${r.sourceId?`sources/${r.sourceId}/short-lead-requests`:'short-lead-requests'}/${r.requestId}/decision`,{approved:true,reason})}>批准本次正式单特批</Button><Button type="button" disabled={busy||!reason.trim()} onClick={()=>void send(`${r.sourceId?`sources/${r.sourceId}/short-lead-requests`:'short-lead-requests'}/${r.requestId}/decision`,{approved:false,reason})}>驳回</Button></div>}</article>)}</div>{state&&!state.requests.length&&<p>当前授权范围没有特批申请。</p>}
 </details>;
}
