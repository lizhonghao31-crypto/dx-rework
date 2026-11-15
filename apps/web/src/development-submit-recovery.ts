import {DevelopmentSubmissionReceiptSchema,type DevelopmentSheet,type DevelopmentSubmissionReceipt} from '@dx-rework/contracts/digital-development';
import type {DigitalOrder,DigitalOrderInput} from '@dx-rework/contracts/digital-production';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';

export type PendingDevelopmentSubmission={sourceId:string;key:string}&(
 |{operation:'publish';body:{expectedVersion:number;patternOrder?:{categoryId:string;priceVersion:number}}}
 |{operation:'confirm';body:DigitalOrderInput});

export function developmentSubmissionResult(command:PendingDevelopmentSubmission,result:unknown):DevelopmentSubmissionReceipt{
 const value=result as {sourceId?:unknown;status?:unknown;version?:unknown;productionOrderId?:unknown}|null;
 const receipt=DevelopmentSubmissionReceiptSchema.safeParse(command.operation==='publish'
  ?{status:'completed',operation:'publish',sourceId:value?.sourceId,documentVersion:value?.status==='published'?value.version:null}
  :{status:'completed',operation:'confirm',sourceId:value?.sourceId,productionOrderId:value?.productionOrderId});
 if(!receipt.success||receipt.data.status!=='completed'||receipt.data.sourceId!==command.sourceId)throw new DigitalRequestError('尚未取得匹配原提交的成功回执，输入和原操作标识已保留',200,'INVALID_RESPONSE');
 return receipt.data;
}

/** A lookup never resubmits. Explicit recovery first looks up the original
 * committed receipt, then may replay exactly the captured body and key. */
export async function recoverDevelopmentSubmission(command:PendingDevelopmentSubmission,replay=false,request:typeof digitalRequest=digitalRequest):Promise<DevelopmentSubmissionReceipt>{
 const raw=await request<unknown>(`sources/${command.sourceId}/development/submission-receipt?operation=${command.operation}&key=${encodeURIComponent(command.key)}`);
 const parsed=DevelopmentSubmissionReceiptSchema.safeParse(raw);
 if(!parsed.success||parsed.data.status==='completed'&&(parsed.data.sourceId!==command.sourceId||parsed.data.operation!==command.operation))throw new DigitalRequestError('原提交回执不完整或不匹配，尚未确认结果',200,'INVALID_RESPONSE');
 if(parsed.data.status==='completed'||!replay)return parsed.data;
 if(command.operation==='publish'){
  const result=await request<DevelopmentSheet>(`sources/${command.sourceId}/development/publish`,'POST',command.body,command.key);
  return developmentSubmissionResult(command,result);
 }
 const result=await request<DigitalOrder>(`sources/${command.sourceId}/confirm`,'POST',command.body,command.key);
 return developmentSubmissionResult(command,result);
}
