import {requestFailureMessage,transportFailure} from './request-failure-message.js';
export type ResponseErrorFactory=(message:string,code:string|undefined,status:number)=>Error;
export class RequestFeedbackError extends Error {
 constructor(message:string,readonly outcome:'read_failed'|'rejected'|'unknown',readonly status:number|null,readonly code?:string){super(message);this.name='RequestFeedbackError';}
}
export const isReadRequest=(method='GET')=>['GET','HEAD'].includes(method.toUpperCase());
const outcome=(method:string,status:number)=>isReadRequest(method)?'read_failed':status>=400&&status<500&&status!==408?'rejected':'unknown';
export const invalidResponseMessage=(method:string)=>isReadRequest(method)?'返回资料不完整或格式异常，尚未确认原资料；请重新读取，仍失败请管理员核对接口':'未收到可确认的提交结果，请先核对原记录，避免重复提交';
/** No retries, body changes or key generation. An already-sent write abort is
 * uncertain, whereas a signal cancelled before fetch proves it was not sent. */
export async function feedbackFetch(input:RequestInfo|URL,init:RequestInit={}){
 const method=init.method??'GET';if(init.signal?.aborted)throw new DOMException('请求已取消，尚未发送','AbortError');
 try{return await fetch(input,init);}catch(error){if(isReadRequest(method)&&(error as Error)?.name==='AbortError')throw error;throw new RequestFeedbackError(transportFailure(method).message,isReadRequest(method)?'read_failed':'unknown',null);}
}
export async function feedbackJson<T>(response:Response,method:string,parse:(value:unknown)=>T,makeError?:ResponseErrorFactory):Promise<T>{
 const body:unknown=await response.json().catch(error=>{if(isReadRequest(method)&&(error as Error)?.name==='AbortError')throw error;return undefined;});
 if(!response.ok){const error=body&&typeof body==='object'&&'error'in body?body.error:null;const message=error&&typeof error==='object'&&'message'in error&&typeof error.message==='string'?error.message:undefined;const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:undefined;const text=requestFailureMessage(response.status,message,method);throw makeError?makeError(text,code,response.status):new RequestFeedbackError(text,outcome(method,response.status),response.status,code);}
 const invalid=()=>makeError?makeError(invalidResponseMessage(method),'INVALID_RESPONSE',response.status):new RequestFeedbackError(invalidResponseMessage(method),isReadRequest(method)?'read_failed':'unknown',response.status,'INVALID_RESPONSE');
 if(body===undefined)throw invalid();
 try{return parse(body);}catch{throw invalid();}
}
/** Only use for an existing no-content command contract. HTTP 204 acknowledgement
 * is its receipt; a later failed GET cannot turn that receipt into a failure. */
export async function feedbackNoContent(response:Response,method:string,makeError?:ResponseErrorFactory){
 if(!response.ok)await feedbackJson(response,method,value=>value,makeError);
 else if(response.status!==204){const message=invalidResponseMessage(method);throw makeError?makeError(message,'INVALID_RESPONSE',response.status):new RequestFeedbackError(message,isReadRequest(method)?'read_failed':'unknown',response.status,'INVALID_RESPONSE');}
}

export const unknownWriteResult=(error:unknown)=>error instanceof RequestFeedbackError?error.outcome==='unknown':!(typeof (error as {status?:unknown})?.status==='number'&&Number((error as {status:number}).status)>=400&&Number((error as {status:number}).status)<500&&Number((error as {status:number}).status)!==408);
