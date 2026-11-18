import {useRef,useState} from 'react';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import type {DigitalAccessOptions} from './digital-production-access-panel.js';
import {digitalRequest} from './digital-production-api.js';
import {recoverDevelopmentSubmission,type PendingDevelopmentSubmission} from './development-submit-recovery.js';
import {readCreationDraft,writeCreationDraft,clearCreationDraft,type CreationDraftIdentity,type CreationDraftRecord,type CreationDraftSnapshot} from './development-creation-draft.js';

export type CreationOutgoing={path:string;method:'POST'|'PUT';key:string;body:string;sourceId:string|null;beforeVersion:number|null;native?:PendingDevelopmentSubmission};
async function readCreationSource(record:CreationDraftRecord){
 const sheet=record.phase!=='draft'&&record.sourceId?await digitalRequest<DevelopmentSheet>(`sources/${record.sourceId}/development`):undefined;
 if(sheet&&record.phase!=='draft'&&sheet.sourceId!==record.sourceId)throw Error('原开发档案身份不匹配，不能恢复办理');
 if(record.phase==='bound'&&sheet){
  if(sheet.productionOrderId)return {sheet,mode:'complete' as const,problem:'原开发档案已有客户订单；本页旧草稿保留，不能重新创建或确认。'};
  if(sheet.version!==(record.version??0))return {sheet,mode:'conflict' as const,problem:'原开发档案版本已变化；本页草稿保留，请先核对，未自动保存。'};
 }
 return {sheet,mode:record.phase==='pending'?'pending' as const:'editable' as const,problem:''};
}
export function useDevelopmentCreationDraft(){
 const current=useRef<CreationDraftRecord|null>(null),owner=useRef<CreationDraftIdentity|null>(null),epoch=useRef(0),view=useRef(''),loaded=useRef(''),blocked=useRef(false),resolved=useRef<{path:string;key:string}|undefined>(undefined);
 const [viewId,setViewId]=useState(''),[restored,setRestored]=useState<CreationDraftRecord|null>(null),[sourceSheet,setSourceSheet]=useState<DevelopmentSheet|undefined>(),[problem,setProblem]=useState(''),[mode,setMode]=useState<'none'|'editable'|'pending'|'conflict'|'complete'>('none');
 const reset=()=>{epoch.current++;owner.current=null;current.current=null;loaded.current='';view.current='';blocked.current=true;resolved.current=undefined;setViewId('');setRestored(null);setSourceSheet(undefined);setMode('none');setProblem('');};
 const persist=(record:CreationDraftRecord,proof=resolved.current)=>{
  writeCreationDraft(window.sessionStorage,record,proof);current.current=record;resolved.current=undefined;blocked.current=record.phase==='pending';
 };
 const load=async(access:DigitalAccessOptions,creationEnabled:boolean,editor:string|null)=>{
  const identity={actorId:access.actorId,environment:window.location.origin+import.meta.env.BASE_URL},namespace=JSON.stringify(identity);
  if(loaded.current===namespace)return null;
  const stamp=++epoch.current;
  if(owner.current){current.current=null;view.current='';resolved.current=undefined;setRestored(null);setViewId('');setSourceSheet(undefined);setMode('none');setProblem('');}
  owner.current=identity;loaded.current=namespace;blocked.current=true;
  try{
   const record=readCreationDraft(window.sessionStorage,identity);if(!record){blocked.current=false;return null;}
   if((record.phase==='draft'||!record.sourceId)&&(!access.create||!creationEnabled))throw Error('当前身份不能创建；本页原草稿仍保留。');
   const hydrated=await readCreationSource(record);
   if(stamp!==epoch.current)return null;current.current=record;view.current=record.viewId;setViewId(record.viewId);setRestored(record);
   setSourceSheet(hydrated.sheet);setMode(hydrated.mode);setProblem(hydrated.problem);
   blocked.current=hydrated.mode!=='editable';
   // Unrelated existing documents never get an unsent new-order snapshot.
   if(editor&&(record.phase==='draft'||record.sourceId!==editor))return null;
   return record.open?record.snapshot.intent:null;
  }catch(error){if(stamp===epoch.current){blocked.current=true;setProblem(error instanceof Error?error.message:'本页创建资料尚未核实，不能开启新单');}return null;}
 };
 const open=async()=>{
  if(!owner.current||blocked.current&&!current.current)throw Error(problem||'当前身份或本页草稿尚未核实，不能创建');
  const record=current.current;
  if(record){
   // In-page navigation can remount the form before another access load.
   // Read the original bound identity/version before mounting that editor.
   const stamp=epoch.current,hydrated=await readCreationSource(record);
   if(stamp!==epoch.current||current.current!==record)return null;
   const next={...record,open:true};persist(next);
   blocked.current=hydrated.mode!=='editable';setRestored(next);setViewId(next.viewId);setSourceSheet(hydrated.sheet);setMode(hydrated.mode);setProblem(hydrated.problem);
   return next.snapshot.intent;
  }
  // Local view identity only, never an idempotency key or source identifier.
  view.current=crypto.randomUUID();setViewId(view.current);setRestored(null);setSourceSheet(undefined);setMode('editable');return 'development' as const;
 };
 const snapshot=(id:string,value:CreationDraftSnapshot)=>{
  if(id!==view.current||!owner.current)throw Error('当前创建视图或身份已变化，原资料保留');
  const previous=current.current,next:CreationDraftRecord=previous?{...previous,snapshot:value}:{schemaVersion:1,viewId:id,identity:owner.current,open:true,phase:'draft',snapshot:value};
  try{persist(next);setProblem('');}catch(error){current.current=next;blocked.current=true;setProblem(error instanceof Error?error.message:'本页草稿未能保留，未发送');throw error;}
 };
 const started=(id:string,outgoing:CreationOutgoing)=>{
  const record=current.current;if(blocked.current||id!==view.current||!record)throw Error('本页草稿尚未安全保留，未发送');
  const {sourceId,beforeVersion,native,...original}=outgoing;
  persist({schemaVersion:1,viewId:record.viewId,identity:record.identity,open:record.open,snapshot:record.snapshot,phase:'pending',sourceId,beforeVersion,original,...(native?{native}:{})});
 };
 const acknowledged=(id:string,outgoing:CreationOutgoing,sourceId:string,version:number|null)=>{
  const record=current.current;if(id!==view.current||record?.phase!=='pending'||record.original.key!==outgoing.key||record.original.path!==outgoing.path)return;
  const original=record.original;
  const next:CreationDraftRecord={schemaVersion:1,viewId:record.viewId,identity:record.identity,open:record.open,snapshot:record.snapshot,phase:'bound',sourceId,version};
  resolved.current={key:original.key,path:original.path};
  try{persist(next);}catch(error){current.current=next;blocked.current=true;setProblem('原操作已确认成功，本页恢复记录尚未保存；继续发送已阻止。'+(error instanceof Error?error.message:''));}
 };
 const refused=(id:string,outgoing:CreationOutgoing)=>{
  const record=current.current;if(id!==view.current||record?.phase!=='pending'||record.original.key!==outgoing.key||record.original.path!==outgoing.path)return;
  const {original,sourceId,beforeVersion}=record,common={schemaVersion:1 as const,viewId:record.viewId,identity:record.identity,open:record.open,snapshot:record.snapshot};
  const next:CreationDraftRecord=sourceId?{...common,phase:'bound',sourceId,version:beforeVersion}:{...common,phase:'draft'};
  resolved.current={key:original.key,path:original.path};try{persist(next);}catch(error){blocked.current=true;setProblem(error instanceof Error?error.message:'原拒绝结果已知，恢复记录尚未保存');}
 };
 const close=()=>{const record=current.current;if(record){const next={...record,open:false};persist(next);setRestored(next);}};
 const retry=()=>{if(current.current){persist(current.current);setProblem('');}};
 const completed=(sourceId:string,id=view.current)=>{
  const record=current.current;if(id!==view.current||record&&record.viewId!==id)return false;if(!record)return true;
  if(record.phase!=='draft'&&record.sourceId!==sourceId)return false;
  clearCreationDraft(window.sessionStorage,record.identity,record.viewId,record.phase==='pending'?record.original:undefined);current.current=null;setRestored(null);setMode('none');return true;
 };
 const check=async()=>{
  const record=current.current;if(record?.phase!=='pending'||!record.native)throw Error('本页尚无受支持的原命令只读回执入口；原资料和实际标识保留，不能重发');
  const stamp=epoch.current,access=await digitalRequest<DigitalAccessOptions>('access/options');if(stamp!==epoch.current||access.actorId!==record.identity.actorId)throw Error('当前身份与原命令不符，不能读取回执');
  const result=await recoverDevelopmentSubmission(record.native,false);if(stamp!==epoch.current)return null;
  if(result.status!=='completed')throw Error('尚未取得原提交成功回执，不能认为原请求失败；原资料和标识仍保留');
  if(!completed(record.sourceId!,record.viewId))return null;return {sourceId:record.sourceId!,orderId:result.operation==='confirm'?result.productionOrderId:null};
 };
 return {load,open,snapshot,started,acknowledged,refused,close,retry,completed,check,reset,viewId,restored,sourceSheet,problem,mode};
}
