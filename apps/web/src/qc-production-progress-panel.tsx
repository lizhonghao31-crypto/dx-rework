import {registerSessionInvalidator,sessionCacheVersion} from './auth-session.js';
import {useContext,useEffect,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {Button} from '@dx-rework/ui';
import {SubmitQcProgressSchema,QC_PROGRESS_HOURS,type QcProductionProgressSheet,type QcProductionExecution,type SubmitQcProgress} from '@dx-rework/contracts/qc-production-progress';
import type {UploadIntentResponse} from '@dx-rework/contracts';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {unknownWriteResult} from './request-response-feedback.js';
import {createClientRequestId} from './client-request-id.js';
import {DocumentGuardContext,useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {prepareImageUploadCandidate,sha256Hex,uploadImageWithNormalizationRetry} from './attachment-upload.js';
import {createWebUrls} from '../url-contract.js';
import './qc-production-progress-panel.css';
const urls=createWebUrls(import.meta.env.BASE_URL);
type Pending={path:string;body:unknown;key:string};
// Only original immutable requests are retained, in memory and under their verified principal.
// These digital command keys have no24h purge; do not apply the legacy reporter's expiry.
const pendingCommands=new Map<string,Pending>();
const errorText=(e:unknown)=>e instanceof Error?e.message:'读取或提交未完成';
const localTime=(at:string)=>new Date(Date.parse(at)+8*3600000).toISOString().slice(0,16);
const displayTime=(at:string|null)=>at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'起点未知';
function useQcCommand(owner:string,refresh:()=>Promise<void>,readVersion:number){
 const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[pending,setPending]=useState(()=>pendingCommands.has(owner)),[error,setError]=useState(''),[message,setMessage]=useState(''),[readRequired,setReadRequired]=useState(false);
 const writing=useRef(false),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{setReadRequired(false);},[readVersion]);
 const send=async(path:string,body:unknown,key:string,recover=false)=>{
  if(writing.current)return;const prior=pendingCommands.get(owner);if(prior&&!recover){setPending(true);setError('原提交结果尚未确认，请先恢复原请求，不能换内容另提');return;}
  const attempt=prior??{path,body:structuredClone(body),key};pendingCommands.set(owner,attempt);writing.current=true;setBusy(true);setError('');setMessage('');let confirmed=false;
  try{
   const ack=await digitalRequest<Record<string,unknown>>(attempt.path,'POST',attempt.body,attempt.key);
   if(ack.committed!==true||attempt.path.endsWith('/qc-progress')&&ack.submissionId!==(attempt.body as SubmitQcProgress).submissionId)throw new DigitalRequestError('未收到可确认的保存回执，请恢复原请求',null,'INVALID_RESPONSE');
   confirmed=true;pendingCommands.delete(owner);if(!alive.current)return;setPending(false);setDirty(false);setMessage('本次记录已保存。');
   await refresh();
  }catch(e){
   if(!alive.current)return;
   if(confirmed){setReadRequired(true);setMessage('本次记录已保存，刷新资料失败；重新读取即可，不要重复提交。');setError(errorText(e));}
   else{const uncertain=recover||(e instanceof DigitalRequestError?e.resultUnknown:unknownWriteResult(e));if(!uncertain)pendingCommands.delete(owner);setPending(uncertain);setError(errorText(e));}
  }finally{writing.current=false;if(alive.current)setBusy(false);}
 };
 const retry=()=>{const prior=pendingCommands.get(owner);if(prior)void send(prior.path,prior.body,prior.key,true);};
 return {busy,dirty,setDirty,pending,error,setError,message,readRequired,writing,send,retry,original:pendingCommands.get(owner)};
}
type DraftLine={include:boolean;state:'not_started'|'working'|'stopped'|'finished';cut:string;sew:string;iron:string;quantity:string;reason:string};
function QcExecutionEditor({orderId,viewerId,execution:e,asOf,refresh,readVersion}:{orderId:string;viewerId:string;execution:QcProductionExecution;asOf:string;refresh:()=>Promise<void>;readVersion:number}){
 const base=`orders/${orderId}/qc-progress`,owner=JSON.stringify([viewerId,orderId,e.factoryDecisionId,'progress']),command=useQcCommand(owner,refresh,readVersion),basis=useRef(e);
 const original=command.original?.body as SubmitQcProgress|undefined;
 const initial=(value:QcProductionExecution)=>Object.fromEntries(value.lines.map(line=>{const saved=original?.observations.find(o=>o.lineId===line.lineId);return [line.lineId,{include:Boolean(saved),state:saved?.state??'working',cut:saved?.cuttingPercent==null?'':String(saved.cuttingPercent),sew:saved?.sewingPercent==null?'':String(saved.sewingPercent),iron:saved?.ironingPercent==null?'':String(saved.ironingPercent),quantity:saved?.additionalFinishedQuantity==null?'':String(saved.additionalFinishedQuantity),reason:saved?.reason??''} as DraftLine];}));
 const [lines,setLines]=useState<Record<string,DraftLine>>(()=>initial(e)),[at,setAt]=useState(()=>localTime(original?.collectedAt??asOf)),[note,setNote]=useState(original?.note??''),[mode,setMode]=useState<'progress'|'photos'>(original?.kind??'progress'),[related,setRelated]=useState(original?.relatedProgressRecordId??''),[events,setEvents]=useState<string[]>(original?.criticalEvents??[]);
 const [photos,setPhotos]=useState<Array<{id:string;name:string;url:string}>>(()=>original?.attachmentIds.map(id=>({id,name:'原请求关联的照片',url:''}))??[]),[uploading,setUploading]=useState(false),[failed,setFailed]=useState<File[]>([]);
 const objectUrls=useRef(new Set<string>()),intents=useRef(new Map<string,{intent:UploadIntentResponse;uploaded:boolean}>()),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const url of objectUrls.current)URL.revokeObjectURL(url);objectUrls.current.clear();};},[]);
 useEffect(()=>{if(command.dirty||command.pending||command.busy||uploading)return;basis.current=e;setLines(initial(e));setAt(localTime(asOf));setNote('');setEvents([]);setMode('progress');setRelated('');for(const url of objectUrls.current)URL.revokeObjectURL(url);objectUrls.current.clear();setPhotos([]);setFailed([]);intents.current.clear();},[readVersion,command.dirty,command.pending,command.busy,uploading]);
 useDigitalDetailNavigationGuard(command.dirty||command.pending,command.busy||uploading,command.writing,command.pending?'本次结果未明，暂离会保留原请求；返回后须先恢复原内容，不能另提相同产量。':'本次生产进度或照片尚未保存，是否离开并丢弃输入？');
 const view=basis.current,sourceChanged=e.scopeRevision!==view.scopeRevision||e.progressRevision!==view.progressRevision;
 const disabled=sourceChanged||!e.canRecord||command.busy||command.pending||command.readRequired||uploading;
 const edit=(id:string,change:Partial<DraftLine>)=>{setLines(current=>({...current,[id]:{...current[id]!,...change}}));command.setDirty(true);};
 const upload=async(files:File[])=>{
  if(disabled||!files.length||command.writing.current)return;if(photos.length+files.length>10){command.setError('每次最多10张照片');return;}
  command.writing.current=true;setUploading(true);command.setDirty(true);setFailed([]);command.setError('');let remaining=files;
  try{
   const scope=basis.current,query=new URLSearchParams({scopeRevision:scope.scopeRevision,...(scope.factoryDecisionId?{factoryDecisionId:scope.factoryDecisionId}:{})});
   const limits=await digitalRequest<{maxUploadBytes:number}>(base+'/upload-limits?'+query);
   for(const selected of files){
    const prepared=await prepareImageUploadCandidate(selected);
    const result=await uploadImageWithNormalizationRetry(selected,prepared,async file=>{
     if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>limits.maxUploadBytes)throw Error('请选择符合大小限制的JPG、PNG、WebP图片');
     const checksum=await sha256Hex(file),intentKey=`${checksum}:${file.type}:${file.size}`;let state=intents.current.get(intentKey);
     if(!state){const intent=await digitalRequest<UploadIntentResponse>(base+'/upload-intents','POST',{factoryDecisionId:scope.factoryDecisionId,scopeRevision:scope.scopeRevision,upload:{filename:file.name,mimeType:file.type,sizeBytes:file.size,sha256:checksum}});state={intent,uploaded:false};intents.current.set(intentKey,state);}
     if(!state.uploaded){const form=new FormData();for(const [k,v]of Object.entries(state.intent.uploadFields))form.append(k,v);form.append('file',file);const response=await fetch(state.intent.uploadUrl,{method:state.intent.uploadMethod,body:form,credentials:'omit'});if(!response.ok)throw Error('图片上传未完成；原上传项保留，可重试或移除');state.uploaded=true;}
     await digitalRequest(base+`/attachments/${state.intent.attachmentId}/finalize`,'POST',{});return {attachmentId:state.intent.attachmentId,file};
    });
    if(!alive.current)return;const url=URL.createObjectURL(result.file);objectUrls.current.add(url);setPhotos(current=>current.some(p=>p.id===result.attachmentId)?current:[...current,{id:result.attachmentId,name:result.file.name,url}]);remaining=remaining.slice(1);
   }
  }catch(error){if(alive.current){setFailed(remaining);command.setError(errorText(error));}}finally{command.writing.current=false;if(alive.current)setUploading(false);}
 };
 const submit=(event:FormEvent)=>{event.preventDefault();if(disabled||failed.length)return;try{
  const scope=basis.current,body=SubmitQcProgressSchema.parse({submissionId:createClientRequestId(),factoryDecisionId:scope.factoryDecisionId,expectedScopeRevision:scope.scopeRevision,expectedProgressRevision:scope.progressRevision,kind:mode,relatedProgressRecordId:mode==='photos'?related:null,collectedAt:mode==='photos'?null:new Date(at+'+08:00').toISOString(),observations:mode==='photos'?[]:scope.lines.filter(l=>lines[l.lineId]?.include).map(l=>{const value=lines[l.lineId]!;return {lineId:l.lineId,state:value.state,cuttingPercent:value.cut===''?null:Number(value.cut),sewingPercent:value.sew===''?null:Number(value.sew),ironingPercent:value.iron===''?null:Number(value.iron),reason:value.reason,...(value.quantity===''?{}:{additionalFinishedQuantity:Number(value.quantity)})};}),criticalEvents:mode==='photos'?[]:events,attachmentIds:photos.map(p=>p.id),note});
  void command.send(base,body,body.submissionId);
 }catch(error){command.setError(error instanceof Error&&'issues'in error?String((error as {issues:Array<{message:string}>}).issues[0]?.message):errorText(error));}};
 return <section className="qc-progress-editor"><p>填写岗位：QC · 本厂单{view.lines.length}项PO。工序比例是现场观察，成品量只填本次新增；未核清可留空，不能填0代替未知。</p>
  {command.error&&<p role="alert">{command.error}</p>}{command.message&&<p role="status">{command.message}</p>}
  {command.pending&&<div className="qc-progress-recovery"><p>原请求结果尚未确认。输入已锁定，恢复会使用原始内容与提交标识；刷新或返回不会改成另一笔数量。</p><Button type="button" disabled={command.busy} onClick={command.retry}>恢复原提交</Button></div>}
  {sourceChanged&&<p role="status">当前厂单范围或进度已变化，原输入已保留。请重新读取并明确处理草稿；原结果未明时仍可恢复原请求。</p>}
  {!e.canRecord&&<p role="status">当前账号可查看记录；本范围进度由当前指派QC办理，质量检查及仓库职责保持原分工。</p>}
  <form onSubmit={submit}><fieldset disabled={disabled}><legend>本次生产进度与照片</legend>
   <label>办理内容<select value={mode} onChange={event=>{setMode(event.target.value as typeof mode);command.setDirty(true);}}><option value="progress">记录本次现场进度</option><option value="photos">补传原进度照片</option></select></label>
   {mode==='progress'?<><label>真实采集时间（北京时间）<input type="datetime-local" required value={at} onChange={event=>{setAt(event.target.value);command.setDirty(true);}}/></label>
   <div className="qc-progress-lines">{view.lines.map(line=>{const draft=lines[line.lineId],clock=e.lineClocks.find(c=>c.lineId===line.lineId)?.clock;return <section key={line.lineId}><h4>{line.poNumber??'待补PO'} · {line.color}</h4><p>分配{line.quantity}件 · 已录成品{line.completedQuantity}件 · 下次提醒：{displayTime(clock?.remindAt??null)}</p><label><input type="checkbox" checked={draft?.include??false} onChange={event=>edit(line.lineId,{include:event.target.checked})}/>本次记录这项PO</label>{draft?.include&&<div className="qc-progress-fields"><label>现场状态<select value={draft.state} onChange={event=>edit(line.lineId,{state:event.target.value as DraftLine['state']})}><option value="working">生产中</option><option value="not_started">尚未开工</option><option value="stopped">现场暂停</option><option value="finished">现场已完成</option></select></label>{(['cut','sew','iron'] as const).map((field,index)=><label key={field}>{['裁剪','车缝','整烫'][index]}观察进度（%）<input type="number" min="0" max="100" step="1" value={draft[field]} placeholder="未核清可留空" onChange={event=>edit(line.lineId,{[field]:event.target.value})}/></label>)}<label>本次新增成品量（选填）<input type="number" min="1" step="1" value={draft.quantity} placeholder="只填本次新增，不能重复填累计" onChange={event=>edit(line.lineId,{quantity:event.target.value})}/></label><label>原因／现场说明<textarea value={draft.reason} required={['not_started','stopped'].includes(draft.state)} maxLength={2000} onChange={event=>edit(line.lineId,{reason:event.target.value})}/></label></div>}</section>;})}</div>
   <div className="qc-progress-events">{[['cut_start','现场开裁事件'],['first_piece','首件事件']].map(([key,label])=><label key={key}><input type="checkbox" checked={events.includes(key!)} onChange={event=>{setEvents(current=>event.target.checked?[...current,key!]:current.filter(v=>v!==key));command.setDirty(true);}}/>{label}（须附照片）</label>)}</div><p>首次登记成品量须有首件照片；普通周期无新关键事件时无需重复上传。观察或报量不会自动产生质量合格、完工或发货事实。</p></>:<label>关联原进度<select required value={related} onChange={event=>{setRelated(event.target.value);command.setDirty(true);}}><option value="">请选择已有现场记录</option>{e.records.filter(r=>r.kind==='progress').map(r=><option key={r.recordId} value={r.recordId}>{displayTime(r.collectedAt)} · {r.actorName} · {r.observations.length}项PO</option>)}</select></label>}
   <label>本次现场照片<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';void upload(files);}}/></label>
   <p>{uploading?'正在上传并核验…':`已就绪${photos.length}张，保存后才关联本次记录。`}</p>
   <div className="qc-progress-photos">{photos.map(photo=><figure key={photo.id}>{photo.url&&<a href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt="本次现场照片"/></a>}<figcaption>{photo.name}</figcaption><Button type="button" onClick={()=>{if(photo.url){URL.revokeObjectURL(photo.url);objectUrls.current.delete(photo.url);}setPhotos(current=>current.filter(p=>p.id!==photo.id));command.setDirty(true);}}>移除此照片</Button></figure>)}</div>
   <label>本次说明<textarea aria-label="本次说明" maxLength={2000} value={note} onChange={event=>{setNote(event.target.value);command.setDirty(true);}}/></label>
   <Button type="submit" disabled={disabled||failed.length>0}>保存本次进度与照片</Button>
  </fieldset></form>
  {failed.length>0&&<div role="alert"><p>{failed.length}张尚未完成，已成功图片保留。重试前不会把整组显示为成功。</p><Button disabled={command.busy||uploading||command.pending} onClick={()=>void upload(failed)}>重试未完成图片</Button><Button disabled={command.busy||uploading||command.pending} onClick={()=>setFailed([])}>移除未完成项</Button></div>}
 </section>;
}
function QcManagerForm({sheet,people,refresh,readVersion}:{sheet:QcProductionProgressSheet;people:Array<{id:string;displayName:string;roles:string[]}>;refresh:()=>Promise<void>;readVersion:number}){
 const command=useQcCommand(JSON.stringify([sheet.viewerId,sheet.orderId,'quality-lead']),refresh,readVersion),[lead,setLead]=useState(sheet.qualityLeadId??''),version=useRef(sheet.settingsVersion);
 useEffect(()=>{if(!command.dirty&&!command.pending&&!command.busy){setLead(sheet.qualityLeadId??'');version.current=sheet.settingsVersion;}},[readVersion,command.dirty,command.pending,command.busy]);
 useDigitalDetailNavigationGuard(command.dirty||command.pending,command.busy,command.writing,command.pending?'原负责人配置结果未明，暂离保留原请求，返回后可恢复。':'质检负责人配置尚未保存，是否离开并丢弃输入？');
 return <details><summary>质检负责人接收设置</summary><p>此处仅设置72小时升级接收人，不改变原QC派工、完工或仓库权限。未设置时明确转为管理人员的缺接收人事项。</p>{command.error&&<p role="alert">{command.error}</p>}{command.message&&<p role="status">{command.message}</p>}{command.pending&&<Button disabled={command.busy} onClick={command.retry}>恢复原负责人配置</Button>}<form onSubmit={event=>{event.preventDefault();void command.send(`orders/${sheet.orderId}/qc-progress/settings`,{expectedVersion:version.current,qualityLeadId:lead||null},createClientRequestId());}}><fieldset disabled={command.busy||command.pending||command.readRequired}><legend>升级接收人</legend><label>质检负责人<select value={lead} onChange={event=>{setLead(event.target.value);command.setDirty(true);}}><option value="">待指定</option>{people.filter(p=>p.roles.includes('quality_control')).map(p=><option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label><Button type="submit">保存负责人</Button></fieldset></form></details>;
}
function QcAdoptForm({sheet,execution,refresh,readVersion}:{sheet:QcProductionProgressSheet;execution:QcProductionExecution;refresh:()=>Promise<void>;readVersion:number}){
 const command=useQcCommand(JSON.stringify([sheet.viewerId,sheet.orderId,execution.factoryDecisionId,'adopt']),refresh,readVersion),[reason,setReason]=useState('');
 useDigitalDetailNavigationGuard(command.dirty||command.pending,command.busy,command.writing,command.pending?'本次开始监督结果未明，暂离保留原请求，返回后可恢复。':'开始监督的说明尚未提交，是否离开并丢弃？');
 return <details><summary>历史在途：明确开始监督</summary><p>缺可信旧起点时，从本次授权操作开始监督；不补造工厂收货，不重置已经存在的窗口。</p>{command.error&&<p role="alert">{command.error}</p>}{command.message&&<p role="status">{command.message}</p>}{command.pending&&<Button onClick={command.retry}>恢复原监督请求</Button>}<form onSubmit={event=>{event.preventDefault();void command.send(`orders/${sheet.orderId}/qc-progress/adopt`,{factoryDecisionId:execution.factoryDecisionId,expectedScopeRevision:execution.scopeRevision,reason},createClientRequestId());}}><fieldset disabled={command.busy||command.pending||command.readRequired}><legend>开始本厂单监督</legend><label>采用说明<textarea required maxLength={2000} value={reason} onChange={event=>{setReason(event.target.value);command.setDirty(true);}}/></label><Button type="submit">确认从现在开始监督</Button></fieldset></form></details>;
}
export function QcProductionProgressPanel({orderId,people}:{orderId:string;people:Array<{id:string;displayName:string;roles:string[]}>}){
 const identityVersion=useSyncExternalStore(registerSessionInvalidator,sessionCacheVersion,sessionCacheVersion);
 const inherited=useContext(DocumentGuardContext),own=useRef(new Set<()=>Promise<boolean>>()),guards=inherited??own.current;
 const [sheet,setSheet]=useState<QcProductionProgressSheet|null>(null),[sheetIdentity,setSheetIdentity]=useState(-1),[error,setError]=useState(''),[readVersion,setReadVersion]=useState(0),[epoch,setEpoch]=useState(0),[selected,setSelected]=useState<string|null>(()=>new URLSearchParams(window.location.search).get('factoryDecisionId'));
 const generation=useRef(0),snapshots=useRef(new Map<string,QcProductionExecution>());
 const load=async()=>{const current=++generation.current;try{const value=await digitalRequest<QcProductionProgressSheet>(`orders/${orderId}/qc-progress`);if(current!==generation.current)return;if(value.orderId!==orderId||!value.viewerId||!Array.isArray(value.executions))throw Error('生产记录与当前订单不一致，请重新进入');for(const e of value.executions)snapshots.current.set(e.factoryDecisionId??'original',e);setSheet(value);setSheetIdentity(identityVersion);setError('');setReadVersion(v=>v+1);}catch(e){if(current===generation.current){setError(errorText(e));if(e instanceof DigitalRequestError&&[401,403,404].includes(e.status??0))setSheet(null);}throw e;}};
 useEffect(()=>{setSheet(null);setError('');snapshots.current.clear();void load().catch(()=>undefined);return()=>{generation.current++;};},[orderId,identityVersion]);
 const guarded=async(action:()=>void|Promise<void>)=>{for(const guard of guards)if(!await guard())return;await action();};
 if(!sheet||sheetIdentity!==identityVersion)return <section className="qc-production-progress"><h3>生产进度与现场照片</h3>{error?<><p role="alert">{error}</p><Button onClick={()=>void load().catch(()=>undefined)}>重新读取</Button></>:<p>正在读取当前厂单与QC指派…</p>}</section>;
 const key=selected??(sheet.executions[0]?.factoryDecisionId??'original'),execution=sheet.executions.find(e=>(e.factoryDecisionId??'original')===key)??snapshots.current.get(key),current=sheet.executions.some(e=>(e.factoryDecisionId??'original')===key);
 return <DocumentGuardContext.Provider value={guards}><section className="qc-production-progress"><header><h3>生产进度与现场照片</h3><Button onClick={()=>void guarded(async()=>{await load();setEpoch(v=>v+1);}).catch(()=>undefined)}>重新读取生产记录</Button></header>{error&&<p role="alert">{error}</p>}<p>负责QC：{sheet.qcName??'待指派'} · 质检负责人：{sheet.qualityLeadName??'待指定'} · {QC_PROGRESS_HOURS.remind}小时提醒QC，{QC_PROGRESS_HOURS.escalate}小时升级；换人、已读和补照片不会重新计时。</p>
  {sheet.canManage&&<Button onClick={()=>{const node=document.getElementById('factory-tasks');node?.setAttribute('open','');node?.scrollIntoView({block:'start'});}}>指派／更换QC</Button>}
  {sheet.executions.length>1&&<label>当前厂单<select value={key} onChange={event=>{const value=event.target.value;void guarded(()=>{setSelected(value);setEpoch(v=>v+1);const url=new URL(window.location.href);if(value==='original')url.searchParams.delete('factoryDecisionId');else url.searchParams.set('factoryDecisionId',value);window.history.replaceState(null,'',url);});}}>{sheet.executions.map(e=><option value={e.factoryDecisionId??'original'} key={e.factoryDecisionId??'original'}>{e.supplierName}</option>)}</select></label>}
  {!current&&<p role="status">当前链接对应的厂单范围已变化；原输入保留，不能自动换到其它厂单。请核对当前厂单或历史。</p>}
  {execution?<><p>{execution.supplierName} · {execution.clock.state==='escalated'?'已有范围超过72小时未更新':execution.clock.state==='due'?'已有范围到达48小时提醒':execution.clock.state==='unknown'?'部分监督起点未知':execution.clock.state==='finished'?'本厂生产已结束':'按各PO最近真实进度监督'}{execution.clock.reason?`；${execution.clock.reason}`:''}</p><QcExecutionEditor key={`${sheet.viewerId}:${key}:${epoch}`} viewerId={sheet.viewerId} orderId={orderId} execution={current?execution:{...execution,canRecord:false}} asOf={sheet.asOf} refresh={load} readVersion={readVersion}/>{sheet.canManage&&!execution.trackingId&&current&&<QcAdoptForm key={`${sheet.viewerId}:adopt:${key}:${epoch}`} sheet={sheet} execution={execution} refresh={load} readVersion={readVersion}/>}<details><summary>本厂单进度与照片历史（{execution.records.length}条）</summary>{execution.records.map(record=><article key={record.recordId}><p>{record.kind==='progress'?`现场采集 ${displayTime(record.collectedAt)}`:'补传原进度照片'} · {record.actorName} · 录入 {displayTime(record.recordedAt)}</p>{record.observations.map(o=><p key={o.lineId}>{execution.lines.find(l=>l.lineId===o.lineId)?.poNumber??'历史PO'} · {execution.lines.find(l=>l.lineId===o.lineId)?.color??''} · 裁剪{o.cuttingPercent??'未核'}%／车缝{o.sewingPercent??'未核'}%／整烫{o.ironingPercent??'未核'}%{o.additionalFinishedQuantity!==undefined?` · 本次成品${o.additionalFinishedQuantity}件`:''} {o.reason}</p>)}{record.attachmentIds.map((id,index)=><a key={id} target="_blank" rel="noreferrer" href={urls.apiUrl(`digital-production/orders/${orderId}/qc-progress/attachments/${id}`)}>查看现场照片{index+1}</a>)}{record.note&&<p>{record.note}</p>}</article>)}</details></>:<p>尚无本单原生产范围。由仓库在原发厂入口记录真实发出，不要求工厂收料或清点。</p>}
  {Boolean(sheet.archivedExecutions?.length)&&<details><summary>已退出当前范围的厂单历史</summary>{sheet.archivedExecutions!.map(archive=><section key={archive.factoryDecisionId??'original'}><h4>{archive.supplierName}</h4><p>仅保留原采集记录，不计入当前待办、时效或可填数量。</p>{archive.records.map(record=><article key={record.recordId}><p>{displayTime(record.collectedAt??record.recordedAt)} · {record.actorName} · {record.kind==='photos'?'原记录照片补充':`${record.observations.length}项PO现场进度`}</p>{record.attachmentIds.map((id,index)=><a key={id} target="_blank" rel="noreferrer" href={urls.apiUrl(`digital-production/orders/${orderId}/qc-progress/attachments/${id}`)}>查看历史照片{index+1}</a>)}{record.note&&<p>{record.note}</p>}</article>)}</section>)}</details>}
  {sheet.canManage&&<QcManagerForm key={`${sheet.viewerId}:settings:${epoch}`} sheet={sheet} people={people} refresh={load} readVersion={readVersion}/>}</section></DocumentGuardContext.Provider>;
}
