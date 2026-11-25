import {useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {TextArea} from '@astryxdesign/core/TextArea';
import {DigitalRequestError,digitalRequest} from './digital-production-api.js';
import {unknownWriteResult} from './request-response-feedback.js';
import {createClientRequestId} from './client-request-id.js';
import {acceptanceInputNow} from './acceptance-business-time.js';
import {useForegroundWait} from './foreground-loading.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';

type Scope={orderId:string;preparationId:string;taskId:string;stepRef:string|null};
type RecordRow={factId:string;occurredAt:string|null;recordedAt:string;actorName:string;note:string|null;supplier:string|null};
type Current={scope:Scope;expectedRevision:number;canRecord:boolean;facts:RecordRow[]};
type Request={key:string;body:{kind:'工艺沟通';expectedRevision:number;note:string;supplier:string;occurredAt:string;stepRef?:string}};
const text=(error:unknown)=>error instanceof Error?error.message:'读取或办理失败，请重试';

/** A task-scoped excerpt of the existing logistics record. There is no
 * alternate craft write or authority to record a physical movement here. */
export function WorkbenchFactoryCommunicationPanel(scope:Scope&{onSaved?():void}){
 const target=JSON.stringify([scope.orderId,scope.preparationId,scope.taskId,scope.stepRef]);
 return <CurrentCommunication key={target} {...scope}/>;
}

function CurrentCommunication({orderId,preparationId,taskId,stepRef,onSaved}:Scope&{onSaved?():void}){
 const base=`orders/${orderId}/factory-flow`,locator=new URLSearchParams({preparationId,taskId,...(stepRef?{stepRef}:{})}).toString();
 const [view,setView]=useState<Current|null>(null),[readVersion,reload]=useState(0),[reading,setReading]=useState(true);
 const [note,setNote]=useState(''),[readError,setReadError]=useState(''),[actionError,setActionError]=useState(''),[receipt,setReceipt]=useState(false);
 const pending=useRef<Request|null>(null),busy=useRef(false),[working,setWorking]=useState(false),[uncertain,setUncertain]=useState(false);
 useDigitalDetailNavigationGuard(Boolean(note.trim())||uncertain,working,busy,'本次原工艺沟通尚未保存或回执待核，仍要离开？');
 useForegroundWait(reading?`original-craft-communication:${locator}:${readVersion}`:undefined);
 useEffect(()=>{
  const control=new AbortController();setReading(true);setReadError('');
  void digitalRequest<Current>(`${base}/workbench-communication?${locator}`,'GET',undefined,undefined,{signal:control.signal})
   .then(result=>{
    if(control.signal.aborted)return;
    if(result.scope?.orderId!==orderId||result.scope?.preparationId!==preparationId||result.scope?.taskId!==taskId||result.scope?.stepRef!==stepRef||
     !Number.isSafeInteger(result.expectedRevision)||!Array.isArray(result.facts))throw Error('原工艺记录范围未确认');
    setView(result);
   }).catch(error=>{if(!control.signal.aborted){setView(null);setReadError(text(error));}})
   .finally(()=>{if(!control.signal.aborted)setReading(false);});
  return()=>control.abort();
 },[base,locator,orderId,preparationId,readVersion,stepRef]);
 const save=async()=>{
  if(busy.current||(!pending.current&&(!view?.canRecord||reading||!note.trim())))return;
  if(!pending.current&&view)pending.current={key:createClientRequestId(),body:{kind:'工艺沟通',expectedRevision:view.expectedRevision,note:note.trim(),
    supplier:'',occurredAt:acceptanceInputNow().toISOString(),...(stepRef?{stepRef}:{})}};
  const command=pending.current;if(!command)return;
  busy.current=true;setWorking(true);setActionError('');setReceipt(false);
  try{
   const result=await digitalRequest<FactoryFlowSheet>(`${base}/logistics`,'POST',command.body,command.key);
   if(result.orderId!==orderId||result.preparationId!==preparationId||!result.facts?.some(fact=>fact.kind==='工艺沟通'&&
    (fact.payload.stepRef??null)===stepRef&&fact.payload.note===command.body.note&&fact.occurredAt===command.body.occurredAt))
    throw new DigitalRequestError('原工艺沟通回执尚未确认，请用同一内容核对。',200,'INVALID_RESPONSE');
   pending.current=null;setNote('');setUncertain(false);setReceipt(true);reload(v=>v+1);onSaved?.();
  }catch(error){
   const unknown=error instanceof DigitalRequestError?error.resultUnknown:unknownWriteResult(error);
   setActionError(text(error));setUncertain(unknown);
   if(!unknown){pending.current=null;reload(v=>v+1);}
  }finally{busy.current=false;setWorking(false);}
 };
 return <section aria-label="本项工艺沟通">
  <h3>工艺沟通</h3>
  {receipt&&<p role="status">本次沟通已记录。</p>}
  {actionError&&<p role="alert">{actionError}</p>}
  {readError&&<p role="alert">原沟通记录未读到。<Button label="仅重新读取" onClick={()=>reload(v=>v+1)}/></p>}
  {(view?.canRecord||uncertain)&&<form onSubmit={event=>{event.preventDefault();void save();}}>
   <TextArea label="本次沟通内容" value={note} onChange={setNote} isDisabled={working||uncertain} maxLength={2000}/>
   <Button type="submit" label={uncertain?'使用原内容核对提交结果':'记录沟通'} isLoading={working} isDisabled={working||!uncertain&&(reading||!note.trim())}/>
  </form>}
  {view&&<ul aria-label="原沟通记录">{view.facts.map(fact=><li key={fact.factId}>
   <p>{fact.note??'原备注未登记'}</p><small>{fact.actorName}{fact.supplier?` · ${fact.supplier}`:''}{fact.occurredAt?` · ${new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(fact.occurredAt))}`:' · 实际时间未登记'}</small>
  </li>)}</ul>}
 </section>;
}
