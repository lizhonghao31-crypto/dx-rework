import {createWebUrls} from '../url-contract.js';
import {requestFailureMessage,transportFailure} from './request-failure-message.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
export class CatalogError extends Error {
 constructor(message:string,readonly status:number|null){super(message);}
}

export async function catalogRequest(path:string,method='GET',body?:unknown,key?:string,signal?:AbortSignal){
 const response=await fetch(urls.apiUrl(`master-data/auxiliaries${path}`),{
  method,credentials:'include',cache:'no-store',...(signal?{signal}:{}),
  headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
 }).catch(error=>{
  if(error?.name==='AbortError')throw error;
  throw new CatalogError(transportFailure(method).message,null);
 });
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw new CatalogError(requestFailureMessage(response.status,data?.error?.message,method),response.status);
 if(!data)throw new CatalogError(method==='GET'?'未能读取辅料目录，请重试':'目录操作结果未确认，请先核对原回执',null);
 return data;
}
