import {useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {ReceiptQualityFact,ReceiptQuality,ReceiptQualityVerification} from '@dx-rework/contracts/order-closure';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
export function qualityCompletionTime(value:string){const date=new Date(`${value}+08:00`);if(!value||!Number.isFinite(date.getTime()))throw new Error('请填写有效的北京时间');return date.toISOString();}
export function GarmentQualityForm({orderId,receipt,onSaved,canVerify=false}:{orderId:string;receipt:ReceiptQualityFact;canVerify?:boolean;onSaved:()=>Promise<void>}){
 const [timeMode,setTimeMode]=useState<'reported'|'now'>('reported');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),writing=useRef(false);
 const pending=useRef<{body:ReceiptQuality|ReceiptQualityVerification;path:string;key:string}|null>(null);
 useDigitalDetailNavigationGuard(uncertain,busy,writing,'质检提交结果尚未确认，离开不会撤销原提交。仍要离开？');
 const submit=async(body?:ReceiptQuality|ReceiptQualityVerification,verify=false)=>{
  if(writing.current)return;if(body&&!uncertain)pending.current={body,path:`orders/${orderId}/closure/quality${verify?'/verify-time':''}`,key:createClientRequestId()};if(!pending.current)return;
  writing.current=true;setBusy(true);setError('');
  try{const attempt=pending.current,value=await digitalRequest<{eventId:string;receiptId:string}>(attempt.path,'POST',attempt.body,attempt.key);
   if(!value.eventId||value.receiptId!==receipt.receiptId)throw new Error('质检提交回执不完整');
   pending.current=null;setUncertain(false);await onSaved();
  }catch(e){const unknown=!(e instanceof DigitalRequestError)||e.resultUnknown;setUncertain(unknown);setError(e instanceof Error?e.message:'提交失败');}
  finally{writing.current=false;setBusy(false);}
 };
 return <details><summary>{receipt.inspected?`本批已检查 · 合格 ${receipt.qualifiedQuantity} / ${receipt.quantity}`:receipt.priorInspection?'本批数量已更正，需核对原检查范围':'登记本批到仓质检'}</summary>
 {receipt.problem&&<p>{receipt.problem}</p>}{error&&<p role="alert">{error}</p>}
 {uncertain?<><p role="status">回执未确认，请核对原提交，勿重复登记。</p><Button disabled={busy} onClick={()=>void submit()}>核对原质检提交</Button></>:<form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void submit({receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:Number(data.get('qualified')),...(timeMode==='now'?{timeMode:'now'}:{occurredAt:qualityCompletionTime(String(data.get('at')??''))}),problem:String(data.get('problem')??'')});}}><fieldset disabled={busy}><legend>到仓质检</legend><div className="factory-batch-scope"><label>检查时间<select aria-label="检查时间" value={timeMode} onChange={event=>setTimeMode(event.target.value as typeof timeMode)}><option value="reported">补录实际时间</option><option value="now">现在检查完成</option></select></label>{timeMode==='reported'&&<label>检查完成时间（北京时间）<input name="at" type="datetime-local" step="0.001" required/></label>}<label>本批合格数量<input name="qualified" type="number" min="0" max={receipt.quantity} required defaultValue={receipt.inspected?receipt.qualifiedQuantity:receipt.quantity}/></label></div><label>质量问题／处理说明<input name="problem" maxLength={2000}/></label><Button type="submit">保存到仓质检</Button></fieldset></form>}
 {receipt.inspected&&receipt.completedAt&&<p>检查实际时间 {new Date(receipt.completedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {receipt.timeQuality??'时间待核实'}</p>}
 {canVerify&&receipt.inspected&&receipt.completedAt&&receipt.eventId&&!['现场登记','已核实'].includes(receipt.timeQuality??'')&&!uncertain&&<form onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);void submit({receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,eventId:receipt.eventId!,occurredAt:receipt.completedAt!,reason:String(data.get('reason')??'')},true);}}><fieldset disabled={busy}><legend>核实原检查时间</legend><p>只核实上方原记录的真实时间，不重建质检或修改合格数量。</p><label>核实依据<input name="reason" required maxLength={2000}/></label><Button type="submit">核实原检查时间</Button></fieldset></form>}
 </details>;
}
