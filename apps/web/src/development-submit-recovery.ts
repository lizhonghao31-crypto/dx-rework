import {DevelopmentSubmissionReceiptSchema,type DevelopmentSubmissionReceipt} from '@dx-rework/contracts/digital-development';
import type {DigitalOrderInput} from '@dx-rework/contracts/digital-production';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {developmentSubmissionPath} from './development-creation-command-path.js';

export type PendingDevelopmentSubmission={sourceId:string;key:string}&(
 |{operation:'publish';body:{expectedVersion:number;patternOrder?:{categoryId:string;priceVersion:number}}}
 |{operation:'publish_preorder';body:{expectedVersion:number}}
 |{operation:'confirm';body:DigitalOrderInput});

function matchesSubmission(command:PendingDevelopmentSubmission,receipt:DevelopmentSubmissionReceipt){
 return receipt.status==='completed'&&receipt.sourceId===command.sourceId&&receipt.operation===command.operation&&
   (command.operation!=='publish_preorder'||receipt.operation==='publish_preorder'&&receipt.documentVersion===command.body.expectedVersion);
}

export function developmentSubmissionResult(command:PendingDevelopmentSubmission,result:unknown):DevelopmentSubmissionReceipt{
 const value=result as {sourceId?:unknown;status?:unknown;version?:unknown;publishedAt?:unknown;productionOrderId?:unknown}|null;
 const receipt=DevelopmentSubmissionReceiptSchema.safeParse(command.operation==='confirm'
  ?{status:'completed',operation:command.operation,sourceId:value?.sourceId,productionOrderId:value?.productionOrderId}
  :command.operation==='publish_preorder'
  ?{status:'completed',operation:command.operation,sourceId:value?.sourceId,documentVersion:value?.version,publishedAt:value?.publishedAt}
  :{status:'completed',operation:command.operation,sourceId:value?.sourceId,documentVersion:value?.status==='published'?value.version:null});
 if(!receipt.success||!matchesSubmission(command,receipt.data))throw new DigitalRequestError('尚未取得匹配原提交的成功回执，输入和原操作标识已保留',200,'INVALID_RESPONSE');
 return receipt.data;
}

/** A lookup never resubmits. Explicit recovery first looks up the original
 * committed receipt, then may replay exactly the captured body and key. */
export async function recoverDevelopmentSubmission(command:PendingDevelopmentSubmission,replay=false,request:typeof digitalRequest=digitalRequest):Promise<DevelopmentSubmissionReceipt>{
 const raw=await request<unknown>(`sources/${command.sourceId}/development/submission-receipt?operation=${command.operation}&key=${encodeURIComponent(command.key)}`);
 const parsed=DevelopmentSubmissionReceiptSchema.safeParse(raw);
 if(!parsed.success||parsed.data.status==='completed'&&!matchesSubmission(command,parsed.data))throw new DigitalRequestError('原提交回执不完整或不匹配，尚未确认结果',200,'INVALID_RESPONSE');
 if(parsed.data.status==='completed'||!replay)return parsed.data;
 const result=await request<unknown>(developmentSubmissionPath(command.sourceId,command.operation),'POST',command.body,command.key);
 return developmentSubmissionResult(command,result);
}
