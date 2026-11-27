import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import type {ConfirmDevelopmentSampleHandover,ConfirmDevelopmentSampleHandoverResult,DevelopmentSampleHandover} from '@dx-rework/contracts/digital-development-workspace';
import {createClientRequestId} from './client-request-id.js';
import {DigitalRequestError,digitalRequest} from './digital-production-api.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import {useForegroundRead} from './use-foreground-read.js';
import './development-sample-handover.css';

const dateLabel=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
const electronicLabels={materials:'面辅料供应信息',order_quantities:'客户订单数量',quotation:'报价表'} as const;
const incomplete={materials:'请在版单补齐材料、供应商、数量和单位',order_quantities:'待核原订单的 PO 与尺码数量',quotation:'待有可交付的客户确认报价'} as const;

export function DevelopmentSampleHandoverPanel({sourceId,round,documentVersion,refreshRevision,onReady,onProgress}:{sourceId:string;round:number;documentVersion:number;refreshRevision:number;onReady:(ready:boolean)=>void;onProgress?:(state:'complete'|'pending'|'unknown'|'failed')=>void}){
 const path=`sources/${sourceId}/production-readiness/sample-handover`;
 const read=useCallback((signal:AbortSignal)=>digitalRequest<DevelopmentSampleHandover>(path,'GET',undefined,undefined,{signal}),[path]);
 const result=useForegroundRead('development-sample-handover',`${sourceId}:${round}:${documentVersion}:${refreshRevision}`,read);
 const view=result.value?.sourceId===sourceId&&result.value.round===round?result.value:null;
 const readable=view?.documentVersion===documentVersion&&!view.electronic.some(item=>item.state==='unavailable');
 const progress=view?.formal&&readable?(view.formal.currentComplete?'complete':'pending'):null;
 const [message,setMessage]=useState<{recipientId:string;label:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const writing=useRef(false),attempt=useRef(new SubmissionAttempt());
 const unknown=attempt.current.hasPending;
 useEffect(()=>onReady(!result.waiting),[result.waiting,onReady]);
 useEffect(()=>onProgress?.(result.error?'failed':progress??'unknown'),[result.error,progress,onProgress]);
 useDigitalDetailNavigationGuard(unknown,busy,writing,'本次样衣交接结果尚未确认，确认离开？');

 const send=async(retry=false)=>{
  if(writing.current||(!retry&&(!view?.canConfirm||!view.recipient||view.documentVersion!==documentVersion||unknown)))return;
  writing.current=true;setBusy(true);setError('');setMessage(null);
  const save=async(input:ConfirmDevelopmentSampleHandover,key:string)=>{
   let saved:ConfirmDevelopmentSampleHandoverResult;
   try{saved=await digitalRequest<ConfirmDevelopmentSampleHandoverResult>(path,'POST',input,key);}
   catch(cause){if(cause instanceof DigitalRequestError&&!cause.resultUnknown)throw new SubmissionRequestError(cause.message,cause.code,cause.status??500);throw cause;}
   if(saved.handover?.sourceId!==sourceId||saved.receipt?.round!==input.round||saved.receipt?.recipientId!==input.recipientId||!saved.receipt.eventId)
    throw new Error('原样衣交接回执未确认');
   setMessage({recipientId:saved.receipt.recipientId,label:`已记录样衣交接 · ${saved.receipt.recipientName??'接收跟单'} · ${dateLabel(saved.receipt.occurredAt)}`});
   result.refreshSilently();
  };
  try{
   const outcome=retry?await attempt.current.retry():await attempt.current.run(save.bind(null,{round,documentVersion,recipientId:view!.recipient!.id},createClientRequestId()));
   if(outcome.kind==='failure'){setError(outcome.failure.message);if(!outcome.uncertain)result.refreshSilently();}
   else if(outcome.kind==='expired')setError('原请求已超过安全恢复期限，请核对原交接记录。');
  }finally{writing.current=false;setBusy(false);}
 };

 return <>
  {result.error?<DigitalReadFailure error={result.error} onRetry={result.retry} retryLabel="重试读取样衣交接"/>
   :view?<div className="development-handover-checklist" data-progress={progress??undefined}>
    {progress?<p role="status"><strong>交资料—{progress==='complete'?'完成':'未完成'}</strong></p>
     :<p>{readable?'本阶段不作正式四项交资料考核':'未能核对正式交资料状态'}</p>}
    <p>已交 {view.electronic.filter(item=>item.state==='shared').length+Number(Boolean(view.current))} 项</p>
    {progress==='pending'&&view.formal?.historicalCompletion&&<p>原正式交资料完成记录 · {dateLabel(view.formal.historicalCompletion.at)} · 当前版本或接收人待交齐</p>}
    <ul aria-label="电子资料交接">{view.electronic.map(item=><li key={item.kind} data-receipt={item.state}>
     {item.state==='shared'?<span aria-hidden="true">✓ </span>:!['unavailable','not_applicable'].includes(item.state)&&<span aria-hidden="true">× </span>}
     <strong>{electronicLabels[item.kind]}</strong>{' · '}
     {item.state==='shared'&&item.receipt?`已交 · v${item.receipt.version} · ${dateLabel(item.receipt.at)}`
      :item.state==='not_applicable'?'本阶段不要求'
      :item.state==='unavailable'?'不可查看'
      :item.state==='waiting_recipient'?'待指定接收跟单'
      :item.state==='waiting_share'?`待交 · v${item.version}`:incomplete[item.kind]}
    </li>)}</ul>
    <section aria-label="样衣交接">
    <h3>样衣交接</h3>
    {view.current?<p data-receipt="shared"><span aria-hidden="true">✓ </span>已交样衣 · {view.current.recipientName??'接收跟单'} · {dateLabel(view.current.occurredAt)}</p>
     :<p data-receipt="waiting_share"><span aria-hidden="true">× </span>{view.recipient?`待交样衣 · 接收跟单：${view.recipient.name??'姓名未登记'}`:'待指定接收跟单'}</p>}
    {view.documentVersion!==documentVersion?<p>版单资料已更新，请刷新本单后再办理。</p>
     :view.canConfirm&&!unknown&&message?.recipientId!==view.recipient?.id&&<Button label="确认已交样衣" size="sm" isDisabled={busy||result.waiting} onClick={()=>void send()}/>}
    {view.history.some(record=>record.eventId!==view.current?.eventId)&&<details><summary>原样衣交接记录</summary><ul>
     {view.history.filter(record=>record.eventId!==view.current?.eventId).map(record=><li key={record.eventId}>
      {record.recipientName??'接收跟单'} · {record.confirmedByName??'原确认人'} · {dateLabel(record.occurredAt)} · 版单 v{record.documentVersion}
     </li>)}
    </ul></details>}
    </section>
   </div>:<p role="status">正在读取样衣交接…</p>}
  {message&&<p role="status">{message.label}</p>}{error&&<p role="alert">{error}</p>}
  {unknown&&<Button label="使用原内容核对样衣交接" size="sm" isDisabled={busy} onClick={()=>void send(true)}/>}
 </>;
}
