import {feedbackFetch,feedbackJson,isReadRequest} from "./request-response-feedback.js";
import {isDigitalProductionReadRequest} from '@dx-rework/contracts/digital-production-read-requests';
import { createWebUrls } from "../url-contract.js";
import {sessionCacheVersion,registerSessionInvalidator} from './auth-session.js';
/** Typed read boundaries preserve original business messages and unknown write outcomes. */
export class DigitalRequestError extends Error {
  readonly resultUnknown:boolean;
  constructor(message:string,readonly status:number|null,readonly code?:string,readonly operation:'read'|'write'='write'){super(message);this.name='DigitalRequestError';this.resultUnknown=operation==='write'&&(status===null||status>=500||status===408||code==='INVALID_RESPONSE'||code==='IDEMPOTENCY_IN_PROGRESS'||code==='IDEMPOTENCY_CONFLICT');}
}
const urls = createWebUrls(import.meta.env.BASE_URL);
const reads=new Map<string,Promise<unknown>>();
let generation=0;
const invalidate=()=>{generation++;reads.clear();};
registerSessionInvalidator(invalidate);
/** Only concurrent task/candidate reads are shared. No settled data, budget,
 * attachment link, write or identity survives in this request map. */
export async function digitalRequest<T>(path: string, method = "GET", body?: unknown, key?: string,options?:{signal?:AbortSignal}): Promise<T> {
  const reading=isDigitalProductionReadRequest(method,`/digital-production/${path}`),operation=reading?'read' as const:'write' as const;
  if(!reading)invalidate();
  const identity=sessionCacheVersion(),revision=generation;
  const cacheKey=`${identity}:${revision}:${path}`;
  const share=reading&&!options?.signal&&(/^(?:access\/candidates)(?:\?|$)/.test(path)||/^tasks\/[0-9a-f-]{36}$/i.test(path));
  const hit=share?reads.get(cacheKey):undefined;
  if(hit)return structuredClone(await hit) as T;
  const request=(async()=>{
    const response=await feedbackFetch(urls.apiUrl(`digital-production/${path}`),{method,credentials:'include',cache:'no-store',
      headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),...(reading&&options?.signal?{signal:options.signal}:{})}).catch(error=>{if(error?.name==='AbortError')throw error;throw new DigitalRequestError(reading&&!isReadRequest(method)?'本次只读演算读取失败，请重新读取':error.message,null,undefined,operation);});
    const value=await feedbackJson(response,reading?'GET':method,value=>value,(message,code,status)=>{const id=response.headers?.get('x-request-id');
      // Old open pages/servers may still supply the generic write fallback.
      // Preserve safe domain reasons and identifiers, not that false outcome.
      const text=reading&&status>=500&&code==='INTERNAL_ERROR'?'资料读取未完成，请重新读取；仍失败时请管理员按请求编号核查':message;
      return new DigitalRequestError(id&&/^[\w.:-]{1,128}$/.test(id)?`${text}（请求编号：${id}）`:text,status,code,operation);});
    if(!reading)invalidate();
    if(reading&&(identity!==sessionCacheVersion()||revision!==generation))throw new Error('读取条件已变化，请重试刷新');
    return value;
  })();
  if(share&&reads.size<128)reads.set(cacheKey,request);
  try{return structuredClone(await request) as T;}
  finally{if(reads.get(cacheKey)===request)reads.delete(cacheKey);}
}
