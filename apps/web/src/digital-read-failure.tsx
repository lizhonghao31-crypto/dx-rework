import {Button} from '@dx-rework/ui';
import {requestFailureMessage,transportFailure} from './request-failure-message.js';
import {DigitalRequestError} from './digital-production-api.js';

export const asDigitalReadError=(error:unknown):Error=>error instanceof Error?error:new Error(typeof error==='string'?error:'未能读取资料');

export function digitalReadFailureInfo(error:unknown){
 const message=error instanceof Error?error.message:typeof error==='string'?error:'未能读取资料';
 const detail=error instanceof DigitalRequestError&&message===(error.status===null?transportFailure('GET').message:requestFailureMessage(error.status,undefined,"GET"))?'':message;
 if(error instanceof DigitalRequestError){
  if(error.status===null)return {title:'网络连接失败',detail,next:'请检查连接后重试读取。'};
  if(error.status===401)return {title:'登录已失效',detail,next:'请重新登录后读取原记录。'};
  if(error.status===403)return {title:'当前身份无权查看',detail,next:'请返回原工作台，或联系有权管理岗位核对当前授权。'};
  if(error.status===404)return {title:'原记录不存在或当前不可见',detail,next:'请从原工作台重新定位记录后再读取。'};
  if(error.status===409)return {title:'读取请求未被接受',detail,next:'请从原入口核对当前资料后重新读取。'};
  if(error.status>=500)return {title:'服务暂时不可用',detail,next:'请稍后重试读取。'};
 }
 return {title:'资料读取失败',detail,next:'请核对读取条件，或返回原来源后重试。'};
}
/** Read-only recovery: each host supplies the actual failed request, never a write command. */
export function DigitalReadFailure({error,onRetry,retryLabel='重试读取',busy=false}:{error:unknown;onRetry?:(()=>void)|undefined;retryLabel?:string;busy?:boolean}){
 const {title,detail,next}=digitalReadFailureInfo(error);
 return <section className="digital-read-failure"><p role="alert"><strong>{title}</strong>{detail&&detail!==title?`：${detail}`:null}</p><p>{next}</p>{onRetry&&<Button type="button" disabled={busy} onClick={()=>onRetry()}>{retryLabel}</Button>}</section>;
}
