import {requestFailureMessage,transportFailure} from "./request-failure-message.js";
import { createWebUrls } from "../url-contract.js";
import {sessionCacheVersion,registerSessionInvalidator} from './auth-session.js';
const urls = createWebUrls(import.meta.env.BASE_URL);
const reads=new Map<string,Promise<unknown>>();
let generation=0;
const invalidate=()=>{generation++;reads.clear();};
registerSessionInvalidator(invalidate);
/** Only concurrent task/candidate reads are shared. No settled data, budget,
 * attachment link, write or identity survives in this request map. */
export async function digitalRequest<T>(path: string, method = "GET", body?: unknown, key?: string,options?:{signal?:AbortSignal}): Promise<T> {
  const reading=method==='GET';
  if(!reading)invalidate();
  const identity=sessionCacheVersion(),revision=generation;
  const cacheKey=`${identity}:${revision}:${path}`;
  const share=reading&&!options?.signal&&(/^(?:access\/candidates)(?:\?|$)/.test(path)||/^tasks\/[0-9a-f-]{36}$/i.test(path));
  const hit=share?reads.get(cacheKey):undefined;
  if(hit)return structuredClone(await hit) as T;
  const request=(async()=>{
    const response=await fetch(urls.apiUrl(`digital-production/${path}`),{method,credentials:'include',cache:'no-store',
      headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),...(reading&&options?.signal?{signal:options.signal}:{})}).catch(error=>{if(error?.name==='AbortError')throw error;throw transportFailure(method);});
    if(!response.ok){
      const data=await response.json().catch(()=>({})) as {error?:{message?:string}};
      throw new Error(requestFailureMessage(response.status,data.error?.message));
    }
    const value:unknown=await response.json().catch(()=>{throw new Error(reading?"返回资料格式异常，请刷新重试":"未收到可确认的提交结果，请先核对原记录，避免重复提交");});
    if(!reading)invalidate();
    if(reading&&(identity!==sessionCacheVersion()||revision!==generation))throw new Error('读取条件已变化，请重试刷新');
    return value;
  })();
  if(share&&reads.size<128)reads.set(cacheKey,request);
  try{return structuredClone(await request) as T;}
  finally{if(reads.get(cacheKey)===request)reads.delete(cacheKey);}
}
