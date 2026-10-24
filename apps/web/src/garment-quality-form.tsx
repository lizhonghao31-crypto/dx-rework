import {useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {ReceiptQualityFact,ReceiptQuality} from '@dx-rework/contracts/order-closure';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
export function GarmentQualityForm({orderId,receipt,onSaved}:{orderId:string;receipt:ReceiptQualityFact;onSaved:()=>Promise<void>}){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),writing=useRef(false);
 const pending=useRef<{body:ReceiptQuality;key:string}|null>(null);
 useDigitalDetailNavigationGuard(uncertain,busy,writing,'质检提交结果尚未确认，离开不会撤销原提交。仍要离开？');
 const submit=async(body?:ReceiptQuality)=>{
  if(writing.current)return;if(body&&!uncertain)pending.current={body,key:createClientRequestId()};if(!pending.current)return;
  writing.current=true;setBusy(true);setError('');
  try{const attempt=pending.current,value=await digitalRequest<{eventId:string;receiptId:string}>(`orders/${orderId}/closure/quality`,'POST',attempt.body,attempt.key);
   if(!value.eventId||value.receiptId!==receipt.receiptId)throw new Error('质检提交回执不完整');
   pending.current=null;setUncertain(false);await onSaved();
  }catch(e){const unknown=!(e instanceof DigitalRequestError)||e.resultUnknown;setUncertain(unknown);setError(e instanceof Error?e.message:'提交失败');}
  finally{writing.current=false;setBusy(false);}
 };
 return <details><summary>{receipt.inspected?`本批已检查 · 合格 ${receipt.qualifiedQuantity} / ${receipt.quantity}`:receipt.priorInspection?'本批数量已更正，需核对原检查范围':'登记本批到仓质检'}</summary>
 {receipt.problem&&<p>{receipt.problem}</p>}{error&&<p role="alert">{error}</p>}
 {uncertain?<><p role="status">回执未确认，请核对原提交，勿重复登记。</p><Button disabled={busy} onClick={()=>void submit()}>核对原质检提交</Button></>:<form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void submit({receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:Number(data.get('qualified')),occurredAt:new Date(`${data.get('at')}:00+08:00`).toISOString(),problem:String(data.get('problem')??'')});}}><fieldset disabled={busy}><legend>到仓质检</legend><div className="factory-batch-scope"><label>检查完成时间（北京时间）<input name="at" type="datetime-local" required/></label><label>本批合格数量<input name="qualified" type="number" min="0" max={receipt.quantity} required defaultValue={receipt.inspected?receipt.qualifiedQuantity:receipt.quantity}/></label></div><label>质量问题／处理说明<input name="problem" maxLength={2000}/></label><Button type="submit">保存到仓质检</Button></fieldset></form>}
 </details>;
}
