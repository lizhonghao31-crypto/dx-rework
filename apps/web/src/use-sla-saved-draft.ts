import {useRef,useState} from 'react';
import {SlaDraftEnvelopeSchema,SlaDraftSavedReplySchema,SlaDraftDiscardedReplySchema,type SlaDraftEnvelope,type SlaDraftGroup,type SlaDraftSave,type SlaSavedDraft} from '@dx-rework/contracts/sla-settings-drafts';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';

type Values=SlaDraftSave['values'];
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const settingsDraftEqual=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
/** Preserve only the author's changes, against the server-recorded old baseline. */
export function mergeSavedSettings<T extends Values>(current:T,saved:SlaSavedDraft):T{
 return Object.fromEntries(Object.entries(current).map(([key,value])=>[key,settingsDraftEqual(saved.values[key as keyof typeof saved.values],saved.baselineValues[key as keyof typeof saved.baselineValues])?value:saved.values[key as keyof typeof saved.values]])) as T;
}
export function useSlaSavedDraft(group:SlaDraftGroup,readOnly:boolean,onAuthorityChanged?:()=>void){
 const [head,setHead]=useState<SlaDraftEnvelope|null>(null),[unknown,setUnknown]=useState(false),[busy,setBusy]=useState(false);
 const latest=useRef<SlaDraftEnvelope|null>(null),writing=useRef(false),pending=useRef<{kind:'save'|'discard';body:unknown;key:string}|null>(null);
 const remember=(value:SlaDraftEnvelope)=>{if(value.group!==group)throw Error('草稿返回了其他设置类别，请重新读取');latest.current=value;setHead(value);return value;};
 const read=async()=>{if(readOnly)return null;try{return remember(SlaDraftEnvelopeSchema.parse(await digitalRequest(`sla-settings/drafts?group=${group}`)));}catch(error){if(error instanceof DigitalRequestError&&[401,403].includes(error.status??0))onAuthorityChanged?.();throw error;}};
 const savedFor=(version:number,values:Values,reason:string)=>Boolean(head?.draft&&head.draft.expectedVersion===version&&settingsDraftEqual(head.draft.values,values)&&head.draft.reason===reason.trim());
 const write=async(kind:'save'|'discard',body:unknown)=>{
  if(readOnly||writing.current)throw Error('当前不能修改草稿');
  if(pending.current&&pending.current.kind!==kind)throw Error('上次提交结果尚未确认，请先重试原操作');
  writing.current=true;setBusy(true);
  if(!pending.current)pending.current={kind,body,key:createClientRequestId()};
  try{
   const command=pending.current;
   const result=await digitalRequest(kind==='save'?'sla-settings/drafts':'sla-settings/drafts/discard','POST',command.body,command.key);
   if(kind==='save'){
    let reply;try{reply=SlaDraftSavedReplySchema.parse(result);}catch{throw new DigitalRequestError('保存回执尚未确认，请重试原保存',null);}
    if(reply.saved.group!==group)throw new DigitalRequestError('保存回执类别不一致，请核对原保存',null);
    pending.current=null;setUnknown(false);
    if(reply.superseded){await read();throw Error('原草稿已保存，但另一窗口随后修改过。请重新核对当前草稿。');}
    remember({group,currentStandardVersion:reply.currentStandardVersion,revision:reply.currentRevision,draft:reply.saved});
    return {superseded:false,draft:reply.saved,currentStandardVersion:reply.currentStandardVersion};
   }
   let reply;try{reply=SlaDraftDiscardedReplySchema.parse(result);}catch{throw new DigitalRequestError('取消回执尚未确认，请重试原操作',null);}
   pending.current=null;setUnknown(false);remember(reply);
   return {superseded:reply.superseded,draft:reply.draft,currentStandardVersion:reply.currentStandardVersion};
  }catch(error){
   if(error instanceof DigitalRequestError&&[401,403].includes(error.status??0))onAuthorityChanged?.();
   if(pending.current&&(!(error instanceof DigitalRequestError)||error.resultUnknown))setUnknown(true);
   else{pending.current=null;setUnknown(false);}
   throw error;
  }finally{writing.current=false;setBusy(false);}
 };
 return {head,unknown,busy,read,savedFor,
  savedRevision:(version:number,values:Values,reason:string)=>savedFor(version,values,reason)?head?.draft?.revision:undefined,
  save:(version:number,values:Values,reason:string)=>write('save',{group,expectedVersion:version,expectedDraftRevision:latest.current?.revision??0,values,reason:reason.trim()}),
  discard:()=>write('discard',{group,expectedDraftRevision:latest.current?.revision??0})};
}
