import {z} from 'zod';
import {feedbackFetch,feedbackJson,RequestFeedbackError,unknownWriteResult} from './request-response-feedback.js';
import {SUBMISSION_RECOVERY_WINDOW_MS} from './submission-attempt.js';
export type ReceivingBoardMutationKind='packing'|'difference'|'receipt'|'batch'|'delete';
const id=z.string().min(1),quantity=z.number().int().nonnegative();
const batch=z.object({receivingBatchId:id,styleNo:id,version:z.number().int().positive(),documentQuantity:quantity,actualQuantity:quantity,defectiveQuantity:quantity,differenceQuantity:z.number().int()});
const receipts={
 packing:z.object({receivingBatchId:id,packingRevisionId:id,packingQuantity:quantity,recordedBy:id,recordedAt:id}),
 difference:z.object({receivingBatchId:id,resolutionId:id,differenceType:z.enum(['receiving','packing']),differenceQuantity:z.number().int(),result:id,handledBy:id,handledAt:id}),
 receipt:batch,batch,delete:z.object({receivingBatchId:id,deleted:z.literal(true)}),
};
export async function receivingBoardWrite(kind:ReceivingBoardMutationKind,path:string,init:RequestInit){
 const response=await feedbackFetch(path,init);return feedbackJson(response,init.method??'POST',value=>{receipts[kind].parse(value);return value;});
}
export async function receivingBoardRead<T>(path:string):Promise<T>{
 const response=await feedbackFetch(path,{credentials:'include',cache:'no-store'});
 return feedbackJson(response,'GET',value=>{z.object({rows:z.array(z.object({receivingBatchId:id,version:z.number().int().positive()})),kpis:z.object({orderCount:quantity,receivedQuantity:quantity,abnormalOrderCount:quantity,differenceQuantity:z.number(),differenceRate:z.number()}),page:z.number().int().positive(),totalPages:quantity,totalCount:quantity}).parse(value);return value as T;});
}
/** Only these existing receiving commands: retain the original route/body/headers,
 * never generate a key, auto-retry, or treat a read as a write receipt. */
export function createReceivingBoardMutation(){
 type Command={kind:ReceivingBoardMutationKind;path:string;init:RequestInit;fingerprint:string;startedAt:number;unknown:boolean};
 let pending:Command|null=null,active=false;
 const freeze=(kind:ReceivingBoardMutationKind,path:string,init:RequestInit):Command=>{
  const headers=new Headers(init.headers),copy={...init,headers};
  return {kind,path,init:copy,fingerprint:JSON.stringify([kind,path,init.method,init.body,[...headers]]),startedAt:Date.now(),unknown:false};
 };
 const submit=async(kind:ReceivingBoardMutationKind,path:string,init:RequestInit)=>{
  if(active)throw new RequestFeedbackError('原提交正在核对，请等待当前请求结束','rejected',409);
  const proposed=freeze(kind,path,init);
  if(pending?.unknown&&(pending.fingerprint!==proposed.fingerprint||Date.now()-pending.startedAt>=SUBMISSION_RECOVERY_WINDOW_MS))throw new RequestFeedbackError('原提交结果尚未确认，不能改内容或超过恢复期限后重发；请先重新读取本单原记录，仍不明确请管理员核查','unknown',null);
  const command=pending??proposed,wasUnknown=command.unknown;pending=command;active=true;
  try{await receivingBoardWrite(command.kind,command.path,command.init);pending=null;return {kind:command.kind,path:command.path};}
  catch(error){if(wasUnknown||unknownWriteResult(error)){command.unknown=true;if(wasUnknown&&!unknownWriteResult(error))throw new RequestFeedbackError(`${error instanceof Error?error.message:'本次核对被拒绝'}；原提交结果仍未确认，请核对原记录`,'unknown',(error as {status?:number}).status??null,(error as {code?:string}).code);}else pending=null;throw error;}
  finally{active=false;}
 };
 return {submit,hasUnknown:()=>pending?.unknown===true,retry:async()=>{if(!pending?.unknown)throw new RequestFeedbackError('没有待核对的原提交，请重新读取本单','rejected',409);return submit(pending.kind,pending.path,pending.init);}};
}
