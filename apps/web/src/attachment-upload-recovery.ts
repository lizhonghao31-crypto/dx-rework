import {AttachmentResponseSchema,UploadIntentResponseSchema,type AttachmentResponse,type CreateUploadIntent} from '@dx-rework/contracts';
import {sessionCacheVersion,registerSessionInvalidator} from './auth-session.js';
import {sha256Hex} from './attachment-upload.js';
import {feedbackFetch,feedbackJson,unknownWriteResult} from './request-response-feedback.js';
import {requestFailureMessage} from './request-failure-message.js';
import {createWebUrls} from '../url-contract.js';

type Api={createIntent(input:CreateUploadIntent):Promise<unknown>;finalize(id:string):Promise<unknown>};
type Pending={intent?:ReturnType<typeof UploadIntentResponseSchema.parse>;ready?:AttachmentResponse;intentUnknown?:boolean;active?:Promise<AttachmentResponse>};
let attempts=new WeakMap<File,Map<string,Pending>>();
const fileScopes=new WeakMap<File,string>();let nextFileScope=0;
export const localFileScope=(file:File)=>{let scope=fileScopes.get(file);if(!scope){scope=String(++nextFileScope);fileScopes.set(file,scope);}return scope;};
registerSessionInvalidator(()=>{attempts=new WeakMap();});
export class AttachmentStageError extends Error {
 constructor(readonly stage:'hash'|'intent'|'transfer'|'finalize',message:string,readonly attachmentId:string|undefined,options?:ErrorOptions){super(message,options);this.name='AttachmentStageError';}
}
const transferFile=async(url:string,method:string,body:FormData)=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45_000);try{return await feedbackFetch(url,{method,body,credentials:'omit',signal:controller.signal});}finally{clearTimeout(timer);}};
const labels={hash:'文件校验',intent:'上传申请',transfer:'文件传输',finalize:'服务端文件校验'};
const fail=(stage:AttachmentStageError['stage'],error:unknown,id?:string)=>{
 const status=(error as {status?:number})?.status,unknown=unknownWriteResult(error);
 const detail=typeof status==='number'?requestFailureMessage(status,error instanceof Error?error.message:undefined,'POST'):error instanceof Error&&/[一-鿿]/.test(error.message)?error.message:'尚未取得可确认的结果';
 const next=stage==='intent'?(unknown?'申请结果尚未确认，请原上传人在本页保留文件，联系有附件管理权限的管理员核对原上传记录，不能自动另建申请':'申请已被拒绝，本地文件仍保留；请按原因处理后重试'):id?'已保留本次附件标识；请原上传人在本页重试核对原文件，不重复传输已就绪文件':'请检查所选文件后重试';
 return new AttachmentStageError(stage,`${labels[stage]}未完成：${detail}。${next}；本单资料尚未因此保存`,id,{cause:error});
};

/** In-memory, identity and host scoped. No signed URL/file is persisted. A retry
 * with a known ID only finalizes; it never POSTs the immutable object again.
 * A definite verification rejection releases the attempt for a later selection.
 * An unknown intent without an ID cannot be safely recreated automatically. */
export async function uploadAttachmentWithRecovery(file:File,scope:string,api:Api,hash?:string,measure:<T>(stage:'intent'|'oss'|'finalize',operation:()=>Promise<T>)=>Promise<T>=(_stage,operation)=>operation(),originalFile:File=file):Promise<AttachmentResponse>{
 const identity=sessionCacheVersion();
 let digest:string;try{digest=hash??await sha256Hex(file);}catch(error){throw fail('hash',error);}
 if(identity!==sessionCacheVersion())throw new Error('账号已变化，请在当前账号重新选择附件');
 const key=JSON.stringify([identity,scope,file.name,file.type,file.size,digest]);
 let fileAttempts=attempts.get(originalFile);if(!fileAttempts){fileAttempts=new Map();attempts.set(originalFile,fileAttempts);}
 let state=fileAttempts.get(key);if(!state){state={};fileAttempts.set(key,state);}
 if(state.active)return state.active;if(state.ready)return state.ready;
 if(state.intentUnknown)throw fail('intent',new Error('上次申请结果仍未知，未重新申请'));
 const pending=state;
 const current=()=>{if(identity!==sessionCacheVersion())throw new Error('账号已变化，原附件结果不应用到当前页面');};
 const operation=(async()=>{
  if(!pending.intent){
   try{const raw=await measure('intent',()=>api.createIntent({filename:file.name,mimeType:file.type as CreateUploadIntent['mimeType'],sizeBytes:file.size,sha256:digest}));pending.intent=UploadIntentResponseSchema.parse(raw);current();}
   catch(error){if(unknownWriteResult(error)||error instanceof Error&&error.name==='ZodError')pending.intentUnknown=true;else fileAttempts.delete(key);throw fail('intent',error);}
   const form=new FormData();for(const [name,value]of Object.entries(pending.intent.uploadFields))form.append(name,value);form.append('file',file);
   try{const response=await measure('oss',()=>transferFile(pending.intent!.uploadUrl,pending.intent!.uploadMethod,form));if(!response.ok)throw new Error('文件传输尚未确认，请先核对原文件');current();}
   catch(error){throw fail('transfer',error,pending.intent.attachmentId);}
  }
  const id=pending.intent.attachmentId;
  try{const ready=AttachmentResponseSchema.parse(await measure('finalize',()=>api.finalize(id)));current();
   if(ready.attachmentId!==id||ready.status!=='ready'||ready.sha256!==digest||ready.sizeBytes!==file.size||ready.mimeType!==file.type||ready.filename!==file.name)throw new Error('服务端附件回执与本次文件不一致');
   pending.ready=ready;return ready;
  }catch(error){const code=(error as {code?:string})?.code,status=(error as {status?:number})?.status;
   // The existing service marks metadata/content/object-missing 422 as rejected.
   // Permission/404/network failures are not proof that the object is absent.
   if(status===422&&code==='ATTACHMENT_METADATA_MISMATCH')fileAttempts.delete(key);
   throw fail('finalize',error,id);
  }
 })();pending.active=operation;try{return await operation;}finally{delete pending.active;}
}
const urls=createWebUrls(import.meta.env.BASE_URL);
export async function attachmentJson<T>(path:string,parse:(value:unknown)=>T,init:RequestInit={}){
 const method=init.method??'GET';return feedbackJson(await feedbackFetch(urls.apiUrl(path),{...init,credentials:'include',cache:'no-store',headers:{...(init.body?{'content-type':'application/json'}:{}),...init.headers}}),method,parse);
}
export const toolsAttachmentApi:Api={
 createIntent:input=>attachmentJson('tools/attachments/upload-intents',value=>UploadIntentResponseSchema.parse(value),{method:'POST',body:JSON.stringify(input)}),
 finalize:id=>attachmentJson(`tools/attachments/${id}/finalize`,value=>AttachmentResponseSchema.parse(value),{method:'POST'}),
};
