import {useRef,useState} from 'react';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import type {DigitalAccessOptions} from './digital-production-access-panel.js';
import {createClientRequestId as createLocalViewId} from './client-request-id.js';
import {digitalRequest} from './digital-production-api.js';
import {recoverDevelopmentSubmission,type PendingDevelopmentSubmission} from './development-submit-recovery.js';
import {listCreationDrafts,selectCreationDraft,writeCreationDraft,clearCreationDraft,type CreationDraftIdentity,type CreationDraftRecord,type CreationDraftSnapshot} from './development-creation-draft.js';

export type CreationOutgoing={path:string;method:'POST'|'PUT';key:string;body:string;sourceId:string|null;beforeVersion:number|null;native?:PendingDevelopmentSubmission};
type CreationView={viewId:string;intent:CreationDraftSnapshot['intent'];preorder:boolean};
async function readCreationSource(record:CreationDraftRecord){
 const sheet=record.phase!=='draft'&&record.sourceId?await digitalRequest<DevelopmentSheet>(`sources/${record.sourceId}/development`):undefined;
 if(sheet&&record.phase!=='draft'&&sheet.sourceId!==record.sourceId)throw Error('原开发档案身份不匹配，不能恢复办理');
 if(record.phase==='bound'&&sheet){
  if(sheet.productionOrderId)return {sheet,mode:'complete' as const,problem:'原开发档案已有客户订单；本页旧草稿保留，不能重新创建或确认。'};
  if(!sheet.canEdit)return {sheet,mode:'conflict' as const,problem:'已读回原草稿，当前没有编辑权限。本页原资料仍保留。'};
  if(sheet.version!==(record.version??0))return {sheet,mode:'conflict' as const,problem:'原开发档案版本已变化；本页草稿保留，请先核对，未自动保存。'};
 }
 return {sheet,mode:record.phase==='pending'?'pending' as const:'editable' as const,problem:''};
}
export function useDevelopmentCreationDraft(){
 const current=useRef<CreationDraftRecord|null>(null),owner=useRef<CreationDraftIdentity|null>(null),epoch=useRef(0),view=useRef(''),loaded=useRef(''),blocked=useRef(false),resolved=useRef<{path:string;key:string}|undefined>(undefined);
 const creationEnabled=useRef(false),canCreateLocal=useRef(false);
 const openedSource=useRef<DevelopmentSheet|undefined>(undefined);
 const [visibleView,setVisibleView]=useState<CreationView|null>(null),[restored,setRestored]=useState<CreationDraftRecord|null>(null),[sourceSheet,setSourceSheet]=useState<DevelopmentSheet|undefined>(),[problem,setProblem]=useState(''),[mode,setMode]=useState<'none'|'editable'|'pending'|'conflict'|'complete'>('none');
 const [mayReadSnapshot,setMayReadSnapshot]=useState(false);
 const [localDrafts,setLocalDrafts]=useState<CreationDraftRecord[]>([]);
 const resetView=()=>{
  current.current=null;view.current='';openedSource.current=undefined;resolved.current=undefined;
  setVisibleView(null);setRestored(null);setSourceSheet(undefined);setMode('none');setProblem('');setMayReadSnapshot(false);
 };
 const reset=()=>{
  epoch.current++;owner.current=null;loaded.current='';blocked.current=true;canCreateLocal.current=false;
  resetView();setLocalDrafts([]);
 };
 const refreshLocalDrafts=(identity:CreationDraftIdentity)=>{
  const records=listCreationDrafts(window.sessionStorage,identity);
  setLocalDrafts(canCreateLocal.current?records:records.filter(record=>record.phase==='pending'));
 };
 const persist=(record:CreationDraftRecord,proof=resolved.current)=>{
  writeCreationDraft(window.sessionStorage,record,proof);current.current=record;resolved.current=undefined;blocked.current=record.phase==='pending';
 };
 const resume=async(id:string,signal?:AbortSignal,verifiedAccess?:DigitalAccessOptions)=>{
  const identity=owner.current;
  if(!identity)throw Error('当前身份尚未核实，不能继续草稿');
  const record=listCreationDrafts(window.sessionStorage,identity).find(entry=>entry.viewId===id);
  if(!record)throw Error('未找到这份本页草稿，请从草稿列表重新选择');
  const stamp=epoch.current,location=window.location.href;
  const access=verifiedAccess??await digitalRequest<DigitalAccessOptions>('access/options');
  if(signal?.aborted||stamp!==epoch.current||window.location.href!==location)return null;
  if(access.actorId!==identity.actorId){reset();throw Error('当前身份已变化，不能恢复原账号草稿');}
  canCreateLocal.current=access.create&&creationEnabled.current;
  if(!canCreateLocal.current){
   refreshLocalDrafts(identity);
   if(record.phase!=='pending'){blocked.current=true;throw Error('当前身份不能创建，本页原草稿仍保留');}
  }
  const hydrated=await readCreationSource(record);
  if(signal?.aborted||stamp!==epoch.current||window.location.href!==location)return null;
  const selected=selectCreationDraft(window.sessionStorage,identity,id);
  if(!selected||JSON.stringify({...selected,open:record.open})!==JSON.stringify(record))
   throw Error('本页原草稿已变化，请重新选择');
  const next={...selected,open:true};
  persist(next);
  view.current=next.viewId;openedSource.current=hydrated.sheet;
  const opened={viewId:next.viewId,intent:next.snapshot.intent,preorder:next.snapshot.preorder};
  setRestored(next);setVisibleView(opened);setSourceSheet(hydrated.sheet);
  setMode(hydrated.mode);setProblem(hydrated.problem);blocked.current=hydrated.mode!=='editable';
  setMayReadSnapshot(canCreateLocal.current);
  refreshLocalDrafts(identity);
  return opened;
 };
 const load=async(access:DigitalAccessOptions,enabled:boolean,requestedView:string|null,signal:AbortSignal)=>{
  const identity={actorId:access.actorId,environment:window.location.origin+import.meta.env.BASE_URL},namespace=JSON.stringify(identity);
  if(loaded.current===namespace)return null;
  const stamp=++epoch.current;
  if(owner.current)resetView();
  owner.current=identity;loaded.current=namespace;blocked.current=true;
  creationEnabled.current=enabled;
  try{
   const records=listCreationDrafts(window.sessionStorage,identity);
   const selected=records.find(record=>record.viewId===requestedView);
   const mayCreate=access.create&&enabled;
   canCreateLocal.current=mayCreate;
   setLocalDrafts(mayCreate?records:records.filter(record=>record.phase==='pending'));
   blocked.current=!mayCreate;
   if(!requestedView)return null;
   if(!mayCreate&&selected?.phase!=='pending')throw Error('当前身份不能创建，本页原草稿仍保留');
   return await resume(requestedView,signal,access);
  }catch(error){if(!signal.aborted&&stamp===epoch.current)setProblem(error instanceof Error?error.message:'本页创建资料尚未核实，不能开启新单');return null;}
 };
 const open=async(saved?:DevelopmentSheet,initialIntent:CreationDraftSnapshot['intent']='development',initialPreorder=false)=>{
  const identity=owner.current;
  if(!identity||!canCreateLocal.current||blocked.current&&!current.current)throw Error(problem||'当前身份或本页草稿尚未核实，不能创建');
  const local=saved&&listCreationDrafts(window.sessionStorage,identity).find(record=>record.phase!=='draft'&&record.sourceId===saved.sourceId);
  if(local)return resume(local.viewId);
  selectCreationDraft(window.sessionStorage,identity);
  resetView();blocked.current=false;
  // Local view identity only, never an idempotency key or source identifier.
  const savedOrder=saved?.document?.customerOrderDraft;
  const opened:CreationView={viewId:createLocalViewId(),intent:saved?(savedOrder?.withOrder?'certain_order':'development'):initialIntent,
   preorder:saved?Boolean(savedOrder?.stage==='preorder'&&!savedOrder.wizardConfirmPreorder):initialPreorder};
  openedSource.current=saved;view.current=opened.viewId;setVisibleView(opened);setSourceSheet(saved);setMode('editable');
  refreshLocalDrafts(identity);
  return opened;
 };
 const snapshot=(id:string,value:CreationDraftSnapshot)=>{
  if(id!==view.current||!owner.current)throw Error('当前创建视图或身份已变化，原资料保留');
  const previous=current.current,sheet=openedSource.current;
  const common={schemaVersion:1 as const,viewId:id,identity:owner.current,open:true,snapshot:value};
  const next:CreationDraftRecord=previous?{...previous,snapshot:value}:sheet?{...common,phase:'bound',sourceId:sheet.sourceId,version:sheet.version}:{...common,phase:'draft'};
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
 const close=(canReturnToServer=false)=>{
  const record=current.current;if(!record)return;
  if(canReturnToServer&&record.phase==='bound'&&record.version!==null){
   clearCreationDraft(window.sessionStorage,record.identity,record.viewId);
   resetView();blocked.current=false;refreshLocalDrafts(record.identity);return;
  }
  const next={...record,open:false};persist(next);resetView();blocked.current=false;refreshLocalDrafts(record.identity);
 };
 const retry=()=>{if(current.current){persist(current.current);setProblem('');}};
 const completed=(sourceId:string,id=view.current)=>{
  const record=current.current;if(id!==view.current||record&&record.viewId!==id)return false;if(!record)return true;
  if(record.phase!=='draft'&&record.sourceId!==sourceId)return false;
  clearCreationDraft(window.sessionStorage,record.identity,record.viewId,record.phase==='pending'?record.original:undefined);
  resetView();blocked.current=false;refreshLocalDrafts(record.identity);return true;
 };
 const check=async()=>{
  const record=current.current;
  if(record?.phase!=='pending'||!record.native&&record.original.path!=='sources/drafts'&&record.original.method!=='PUT')throw Error('本页尚无受支持的原命令只读回执入口；原资料和实际标识保留，不能重发');
  const stamp=epoch.current,access=await digitalRequest<DigitalAccessOptions>('access/options');if(stamp!==epoch.current||access.actorId!==record.identity.actorId)throw Error('当前身份与原命令不符，不能读取回执');
  if(!record.native){
   const saved=record.original.method==='PUT'&&record.sourceId;
   const receipt=await digitalRequest<{sourceId:string|null;version?:number|null}>(saved?`sources/${saved}/development/draft-save-receipt`:'sources/drafts/receipt','GET',undefined,record.original.key);
   const expectedVersion=saved?(record.beforeVersion??0)+1:0;
   if(!receipt.sourceId||saved&&(receipt.sourceId!==saved||receipt.version!==expectedVersion))
    throw Error('尚未取得原草稿操作的回执，原输入和标识仍保留');
   const sheet=await digitalRequest<DevelopmentSheet>(`sources/${receipt.sourceId}/development`);
   if(stamp!==epoch.current||record!==current.current)return null;
   if(sheet.sourceId!==receipt.sourceId)throw Error('原草稿身份与回执不符，原输入仍保留');
   const matching=sheet.status==='draft'&&sheet.version===expectedVersion&&sheet.canEdit&&access.create&&creationEnabled.current;
   const next:CreationDraftRecord={schemaVersion:1,viewId:record.viewId,identity:record.identity,
    open:true,snapshot:record.snapshot,phase:'bound',sourceId:sheet.sourceId,version:expectedVersion};
   persist(next,record.original);setRestored(next);setSourceSheet(sheet);
   setMode(matching?'editable':'conflict');blocked.current=!matching;
   setProblem(matching?'':!sheet.canEdit?'已核对原草稿回执。当前没有编辑权限，本页原输入仍保留。':'原草稿已在另一处更新，请核对。本页原输入仍保留。');
   return null;
  }
  const result=await recoverDevelopmentSubmission(record.native,false);if(stamp!==epoch.current)return null;
  if(result.status!=='completed')throw Error('尚未取得原提交成功回执，不能认为原请求失败；原资料和标识仍保留');
  if(!completed(record.sourceId!,record.viewId))return null;return {sourceId:record.sourceId!,orderId:result.operation==='confirm'?result.productionOrderId:null};
 };
 return {load,open,resume,localDrafts,snapshot,started,acknowledged,refused,close,retry,completed,check,reset,viewId:visibleView?.viewId??'',visibleView,restored,sourceSheet,problem,mode,mayReadSnapshot};
}
