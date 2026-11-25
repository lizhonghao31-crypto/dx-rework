import {BulkWashingPanel} from './bulk-washing-panel.js';
import {useFactoryFlowRead} from './factory-flow-read.js';
import {FactoryFlowOriginal,readFactoryOriginalSearch} from './factory-flow-original.js';
import {factoryFlowProductionHref} from './factory-flow-navigation.js';
import {QcProductionProgressPanel} from './qc-production-progress-panel.js';
import {DocumentGuardContext} from './use-digital-detail-navigation-guard.js';
import {FactoryDispatchTimeInput,factoryDispatchTime} from './factory-dispatch-time-input.js';
import {acceptanceInputNow} from './acceptance-business-time.js';
import {FactoryProductionQcPanel} from './factory-production-qc-panel.js';
import {qualityRecordTarget} from './quality-workbench-route.js';
import {CraftOriginalQuality} from './craft-original-quality.js';
import {FactoryBatchPanel} from './factory-batch-panel.js';
import {roleLabel} from "./components.js";
import { digitalTaskDisplayStatus } from "./digital-workspace-copy.js";
import {DocumentEntryScope,DocumentEntry} from "./document-entry-scope.js";
import { SearchableSelect } from "./search-select.js";
import { customerPoDateLabel } from "./digital-workspace-copy.js";
import "./factory-flow-panel.css";
import { productionWorkspaceDomainHref } from "./digital-detail-route.js";
import {useContext,useEffect,useMemo,useRef,useState} from 'react';
import {Button,Surface} from '@dx-rework/ui';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import type {UploadIntentResponse} from '@dx-rework/contracts';
import {digitalRequest} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {factoryTaskTarget} from './factory-task-target.js';
import {prepareImageUploadCandidate,sha256Hex,uploadImageWithNormalizationRetry} from './attachment-upload.js';
import {createWebUrls} from '../url-contract.js';
const urls=createWebUrls(import.meta.env.BASE_URL);
type Props={orderId:string;onClose:()=>void;warehouseDispatchTask?:string};
export function FactoryFlowPanel(props:Props){
 const target=readFactoryOriginalSearch(window.location.search);
 return target===undefined?<CurrentFactoryFlowPanel {...props}/>:<FactoryFlowOriginal {...props} target={target}/>;
}
function CurrentFactoryFlowPanel({orderId,onClose,warehouseDispatchTask}:Props){
 const base=`orders/${orderId}/factory-flow`,[error,setError]=useState(''),[working,setBusy]=useState(false);
 const inheritedGuards=useContext(DocumentGuardContext),ownGuards=useRef(new Set<()=>Promise<boolean>>()),guards=inheritedGuards??ownGuards.current;
 const [readEpoch,setReadEpoch]=useState(0);
 const guarded=async(action:()=>void|Promise<void>)=>{if(writing.current)return;for(const guard of guards)if(!await guard())return;if(!writing.current)await action();};
 const eventTime=useRef<{signature:string;value:string}|null>(null);
 const previewUrls=useRef(new Set<string>());
 const [failedUploads,setFailedUploads]=useState<Record<string,File[]>>({});
 const [previews,setPreviews]=useState<Record<string,Array<{attachmentId:string;url:string}>>>({});
 useEffect(()=>()=>{for(const url of previewUrls.current)URL.revokeObjectURL(url);previewUrls.current.clear();},[]);
 const search=window.location.search,target=useMemo(()=>warehouseDispatchTask?{action:'dispatch' as const,lineId:null,error:null}:factoryTaskTarget(search),[search,warehouseDispatchTask]);
 const {sheet,people,loading,readError,peopleError,reload,accept:setSheet}=useFactoryFlowRead(orderId,target.action!=='washing'&&!target.error);
 const busy=working||loading;
 const [images,setImages]=useState<Record<string,string[]>>({}),writing=useRef(false),pending=useRef<{payload:string;key:string}|null>(null);
 const save=async(path:string,body:Record<string,unknown>,outside=false)=>{if(writing.current||loading||!sheet)return;writing.current=true;setBusy(true);setError('');const data=outside?body:{...body,expectedRevision:sheet.revision};const payload=JSON.stringify([path,data]);if(pending.current?.payload!==payload)pending.current={payload,key:createClientRequestId()};try{const response=await digitalRequest<FactoryFlowSheet>(outside?path:base+path,'POST',data,pending.current.key);if(outside)await reload();else setSheet(response);pending.current=null;eventTime.current=null;if(path==='/qc'){
 const acknowledged=new Set((body.checks as Array<{attachmentIds?:string[]}>).flatMap(check=>check.attachmentIds??[]));
 setImages(current=>Object.fromEntries(Object.entries(current).map(([scope,ids])=>[scope,ids.filter(id=>!acknowledged.has(id))])));
 setPreviews(current=>Object.fromEntries(Object.entries(current).map(([scope,photos])=>[scope,photos.filter(photo=>{
  if(!acknowledged.has(photo.attachmentId))return true;
  URL.revokeObjectURL(photo.url);previewUrls.current.delete(photo.url);return false;
 })])));
}}catch(e){setError(e instanceof Error?e.message:'办理失败');}finally{writing.current=false;setBusy(false);}};
 const at=(f:FormData)=>{if(f.get('unknown')==='on')return null;if(f.get('at'))return new Date(`${String(f.get('at'))}+08:00`).toISOString();const signature=JSON.stringify([...f.entries()]);if(eventTime.current?.signature!==signature)eventTime.current={signature,value:acceptanceInputNow().toISOString()};return eventTime.current.value;};
 const upload=async(lineId:string,files:File[])=>{
  if(writing.current||loading||!files.length)return;
  writing.current=true;setBusy(true);setError('');
  let remaining=files;
  setFailedUploads(current=>({...current,[lineId]:[]}));
  try{
   if((images[lineId]?.length??0)+files.length>10)throw Error('每项检查最多10张图片');
   const limits=await digitalRequest<{maxUploadBytes:number}>(base+'/upload-limits');
   for(const selected of files){
    const prepared=await prepareImageUploadCandidate(selected);
    const result=await uploadImageWithNormalizationRetry(selected,prepared,async file=>{
     if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>limits.maxUploadBytes)throw Error('请选择符合大小限制的JPG、PNG、WebP');
     const intent=await digitalRequest<UploadIntentResponse>(base+'/upload-intents','POST',{filename:file.name,mimeType:file.type,sizeBytes:file.size,sha256:await sha256Hex(file)});
     const form=new FormData();for(const [key,value]of Object.entries(intent.uploadFields))form.append(key,value);form.append('file',file);
     if(!(await fetch(intent.uploadUrl,{method:intent.uploadMethod,body:form,credentials:'omit'})).ok)throw Error('上传失败');
     await digitalRequest(base+`/attachments/${intent.attachmentId}/finalize`,'POST',{});
     return {attachmentId:intent.attachmentId,file};
    });
    setImages(current=>({...current,[lineId]:[...(current[lineId]??[]),result.attachmentId]}));
    const url=URL.createObjectURL(result.file);previewUrls.current.add(url);
    setPreviews(current=>({...current,[lineId]:[...(current[lineId]??[]),{attachmentId:result.attachmentId,url}]}));
    remaining=remaining.slice(1);
   }
  }catch(e){setFailedUploads(current=>({...current,[lineId]:remaining}));setError(e instanceof Error?e.message:'上传失败');}
  finally{writing.current=false;setBusy(false);}
 };
 const removePendingPhoto=(key:string,id:string)=>{
  const preview=previews[key]?.find(photo=>photo.attachmentId===id);
  if(preview){URL.revokeObjectURL(preview.url);previewUrls.current.delete(preview.url);}
  setImages(current=>({...current,[key]:(current[key]??[]).filter(attachment=>attachment!==id)}));
  setPreviews(current=>({...current,[key]:(current[key]??[]).filter(photo=>photo.attachmentId!==id)}));
 };
 useEffect(()=>{if(!sheet||target.error||target.lineId&&!sheet.lines.some(line=>line.lineId===target.lineId))return;const elementId=target.lineId?`factory-qc-line-${target.lineId}`:`factory-${target.action}`;const frame=window.requestAnimationFrame(()=>document.getElementById(elementId)?.scrollIntoView({block:'start'}));return()=>window.cancelAnimationFrame(frame);},[sheet?.revision,target]);
 const time=(unknown=false)=><><label>真实发生时间（北京时间，留空为当前）<input name="at" type="datetime-local"/></label>{unknown&&<label><input name="unknown" type="checkbox"/>真实时间暂不明确</label>}</>;
 if(target.error)return <Surface><Button onClick={()=>void guarded(onClose)}>返回这张订单</Button><p role="alert">{target.error}</p></Surface>;
 if(target.action==='washing')return <DocumentGuardContext.Provider value={guards}><Surface className="factory-flow"><Button onClick={()=>void guarded(onClose)}>返回</Button><h2>大货洗水</h2><BulkWashingPanel orderId={orderId} initialOpen target={{lineId:target.lineId,reference:target.washingWindow??null,factoryId:target.factoryId}}/></Surface></DocumentGuardContext.Provider>;
 if(target.error||sheet&&target.lineId&&!sheet.lines.some(line=>line.lineId===target.lineId))return <Surface><Button onClick={onClose}>返回这张订单</Button><p role="alert">{target.error||"本单不存在指定PO，请从原订单刷新进入"}</p></Surface>;
 if(warehouseDispatchTask&&sheet&&!sheet.tasks.some(task=>task.taskKind==='warehouse_dispatch'&&task.taskId===warehouseDispatchTask))
  return <Surface><Button onClick={onClose}>返回来源</Button><p role="alert">该发厂任务已变更，请从仓库中心重新核对。</p></Surface>;
 const paused=Boolean(sheet?.tasks.some(task=>task.paused&&!['completed','cancelled'].includes(task.state)));
 const qualityTarget=qualityRecordTarget(new URLSearchParams(search));
 // Close delegates to the internal router, which already calls the registered
 // photo guard. Only the in-place refresh uses the local guard directly.
 const closeQuality=()=>{if(!writing.current)onClose();};
 if(qualityTarget?.kind==='craft')return <DocumentGuardContext.Provider value={guards}><Surface className="factory-flow">
  <div className="pattern-actions"><Button disabled={working} onClick={closeQuality}>返回来源</Button>
   <Button disabled={busy} onClick={()=>void guarded(reload).catch(()=>undefined)}>刷新原检查</Button></div>
  <h2>二次工艺回仓检查</h2>{error&&<p role="alert">{error}</p>}{readError&&<p role="alert">{readError}</p>}
  {loading&&<p role="status">正在读取原工艺检查…</p>}
  {sheet&&<CraftOriginalQuality key={`${qualityTarget.returnFactId}:${qualityTarget.lineId}`} sheet={sheet} target={qualityTarget} busy={busy} paused={paused} parentWriting={writing}
   save={save} upload={upload} images={images} previews={previews} failedUploads={failedUploads}
   removePendingPhoto={removePendingPhoto} clearFailed={key=>setFailedUploads(current=>({...current,[key]:[]}))}/>}
 </Surface></DocumentGuardContext.Provider>;
 if(qualityTarget?.kind==='factory')return <DocumentGuardContext.Provider value={guards}><Surface className="factory-flow">
  <div className="pattern-actions"><Button disabled={working} onClick={closeQuality}>返回来源</Button>
   <Button disabled={busy} onClick={()=>void guarded(reload).catch(()=>undefined)}>刷新原检查</Button></div>
  <h2>加工检查</h2>{error&&<p role="alert">{error}</p>}{readError&&<p role="alert">{readError}</p>}
  {loading&&<p role="status">正在读取原加工检查…</p>}
  {sheet&&<FactoryProductionQcPanel sheet={sheet} busy={busy} paused={paused} open save={save} focus={qualityTarget}/>}
 </Surface></DocumentGuardContext.Provider>;
 const qcDisabled=busy||paused||Boolean(target.error)||Boolean(target.lineId&&!sheet?.lines.some(line=>line.lineId===target.lineId))||Boolean(sheet?.inTransit)||sheet?.tasks.find(t=>t.taskKind==='bulk_qc')?.state!=='ready';
 const wholeDispatch=sheet&&!sheet.batchMode&&sheet.canWarehouse&&!sheet.dispatched&&<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('/dispatch',{...factoryDispatchTime(f),supplierId:sheet.supplierId,note:String(f.get('note')??'')});}}><fieldset disabled={busy||paused||!sheet.allQc||!sheet.supplierId}><legend id="factory-dispatch">仓库整款实际发厂</legend><p>全部PO一起发给 {sheet.supplierName}。登记实际发出后启动原生产监控。</p><FactoryDispatchTimeInput/><label>发厂说明<textarea name="note" maxLength={2000}/></label><Button type="submit">确认整款已实际发厂</Button></fieldset></form>;
 if(warehouseDispatchTask)return <DocumentGuardContext.Provider value={guards}><DocumentEntryScope orderId={orderId}>
  <Surface className="factory-flow"><section aria-label="仓库实际发厂"><div className="pattern-actions">
   <Button disabled={working} onClick={()=>void guarded(onClose)}>返回来源</Button>
   <Button disabled={busy} onClick={()=>void guarded(reload).catch(()=>undefined)}>刷新</Button>
  </div><h2>仓库实际发厂</h2>{error&&<p role="alert">{error}</p>}{readError&&<p role="alert">原发厂资料暂不可读：{readError}</p>}
  {loading&&<p role="status">正在读取工厂资料…</p>}
  {sheet&&<div inert={loading}><p>{sheet.tasks.find(task=>task.taskId===warehouseDispatchTask)?.identity?.designStyleNo??'原订单'} · 当前批准加工厂：{sheet.supplierName??'待批准'}</p>
   {sheet.reasons.map(reason=><p key={reason}>{reason}</p>)}
   {!sheet.canWarehouse&&<p role="status">当前岗位或派工已变化，只能查看原发厂事实。</p>}
   {wholeDispatch}
   {sheet.batchMode&&<FactoryBatchPanel sheet={sheet} busy={busy} paused={paused} action="dispatch" save={save} upload={upload} images={images} previews={previews}/>}
   <h3>实际发厂记录</h3>{sheet.facts.filter(fact=>fact.kind==='仓库实际发厂').map(fact=><p key={fact.factId}>{fact.occurredAt?new Date(fact.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'时间待核'} · {fact.actorName} · {String(fact.payload.note??'')}</p>)}
  </div>}</section></Surface></DocumentEntryScope></DocumentGuardContext.Provider>;
 return <DocumentGuardContext.Provider value={guards}><DocumentEntryScope orderId={orderId}><Surface className="factory-flow"><section aria-label="工厂流程资料"><div className="pattern-actions"><Button disabled={busy} onClick={()=>void guarded(onClose)}>返回</Button><Button disabled={busy||loading} onClick={()=>void guarded(async()=>{await reload();setReadEpoch(v=>v+1);}).catch(()=>undefined)}>刷新</Button></div><h2>{{overview:'裁后工艺、QC与发厂',logistics:'裁后工艺物流',qc:'工艺QC',dispatch:'仓库实际发厂',followup:'工厂跟进',productionQc:'工厂成衣QC',productionProgress:'工厂生产跟踪'}[target.action]}</h2>{error&&<p role="alert">{error}</p>}{readError&&<p role="alert">工厂流程资料暂不可读：{readError}</p>}{peopleError&&<p role="alert">办理人员读取失败：{peopleError}</p>}{loading&&<p role="status">正在读取工厂资料…</p>}{sheet&&<div inert={loading}>
 {target.error||target.lineId&&!sheet.lines.some(line=>line.lineId===target.lineId)?<p role="alert">{target.error||'本单不存在指定PO；请从原订单刷新进入，不能沿用其它单的编号'}</p>:null}
 {target.action!=='overview'&&!({logistics:sheet.canLogistics,qc:sheet.canQc,dispatch:sheet.canWarehouse,followup:sheet.canFollowup||sheet.canRecordShipSample,productionQc:sheet.canProductionQc,productionProgress:true})[target.action]&&<p role="status">当前岗位可以查看原事实，但无权办理此项动作；以服务端对应岗位和派工权限为准。</p>}
 {target.action==='productionProgress'&&<QcProductionProgressPanel key={`${orderId}:${readEpoch}`} orderId={orderId} people={people}/>}
 <p><a href={productionWorkspaceDomainHref(`${urls.pageUrl('ui/digital-production')}?factory=${orderId}&factoryAction=productionProgress`,window.location.search)}>办理QC生产进度、成品量与现场照片</a></p>
 <details open={!['followup','productionQc','productionProgress'].includes(target.action)}><summary>产前与裁后状态</summary><p>整款实裁：{sheet.allCut?'全部PO完成':'未完成'} · 大货印绣：{sheet.secondaryCraft??'待前置完成'} · 工艺QC：{sheet.secondaryCraft==='无'?'不适用':sheet.allQc?'全部范围可发':'仍有未放行范围'}</p>{sheet.reasons.map(r=><p key={r}>{r}</p>)}
 <p>款号：{[...new Set(sheet.tasks.flatMap(task=>task.identity?.designStyleNo?[task.identity.designStyleNo]:[]))].join('、')||'未记录'} · 当前批准加工厂：{sheet.supplierName??'待批准'} · {sheet.dispatched?'已登记实际发厂':'尚未实际发厂'}</p><a href={productionWorkspaceDomainHref(`${urls.pageUrl('ui/digital-production')}?bulk=${orderId}`,window.location.search)}>查看原实裁与产前事实</a>{sheet.productionId&&(sheet.canManage||sheet.canRecordShipSample)&&<p>{factoryFlowProductionHref(sheet,window.location.search)&&<a href={factoryFlowProductionHref(sheet,window.location.search)!}>打开原实时生产</a>}{factoryFlowProductionHref(sheet,window.location.search)&&' · '}{factoryFlowProductionHref(sheet,window.location.search,'reporting',target.lineId)&&<a href={factoryFlowProductionHref(sheet,window.location.search,'reporting',target.lineId)!}>查看原产量、完工与发回记录</a>}</p>}
 </details><details id="factory-tasks"><summary>任务与办理人</summary>{sheet.tasks.map(t=><section key={t.taskId}><h3>{t.label} · {!t.paused&&t.taskKind==='bulk_qc'&&t.state==='ready'&&sheet.inTransit&&!sheet.batchMode?'等待整款工艺回仓':digitalTaskDisplayStatus(t)}</h3><p>主办：{t.assigneeName??'待指派'} · {t.dueAt?`截止 ${new Date(t.dueAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`:t.enteredAt?'记录实际停留，无预设SLA':'尚未开始计时'}</p><ul aria-label={`${t.label}待处理原因`}>{t.unmetConditions?.map((item,index)=><li key={`${item.condition}:${index}`}><strong>{item.name}</strong>：{item.missing}；负责岗位：{roleLabel(item.responsibleRole)}{item.action?`；${item.action}`:''}</li>)}</ul>{sheet.canManage&&!['bulk_ship_sample'].includes(t.taskKind)&&(t.state!=='cancelled'&&(t.state!=='completed'||t.taskKind==='factory_production_qc'))&&<form onSubmit={e=>{e.preventDefault();void save(`tasks/${t.taskId}/reassign`,{assigneeId:String(new FormData(e.currentTarget).get('assignee'))},true);}}><label>办理人 *<SearchableSelect name="assignee" required defaultValue={t.assigneeId??''}><option value="">请选择在职对应岗位</option>{people.filter(p=>p.roles.includes(t.requiredRole)).map(p=><option key={p.id} value={p.id}>{p.displayName}</option>)}</SearchableSelect></label><Button type="submit" disabled={busy}>保存办理人</Button></form>}</section>)}</details>
 {!sheet.batchMode&&sheet.canLogistics&&!sheet.dispatched&&<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('/logistics',{kind:String(f.get('kind')),occurredAt:at(f),supplier:String(f.get('supplier')??''),note:String(f.get('note')??'')});}}><fieldset disabled={busy||paused}><legend id="factory-logistics">工艺跟单整款收发与沟通</legend><label>操作<select name="kind"><option>工艺沟通</option><option>工艺发出</option><option>工艺回仓</option></select></label><label>实际工艺供应厂<input name="supplier" maxLength={200}/></label>{time(true)}<label>沟通／处理记录<textarea name="note" maxLength={2000}/></label><Button type="submit">登记整款事实</Button><p>物流岗位登记收发和沟通，检查结论由现有QC岗位填写。</p></fieldset></form>}
 {!sheet.batchMode&&!['followup','productionQc','productionProgress'].includes(target.action)&&<><h3 id="factory-qc">各PO工艺检查</h3><p>{sheet.currentReturn?`本次回仓：${sheet.currentReturn.occurredAt?new Date(sheet.currentReturn.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'真实时间未知'}，检查与复查仅对应本次回仓。`:'尚无可检查的本次回仓事实'}</p>{sheet.canQc&&!sheet.dispatched?<form key={sheet.revision} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget),checks=sheet.lines.filter(l=>(!target.lineId||l.lineId===target.lineId)&&f.get(`result:${l.lineId}`)).map(l=>({lineId:l.lineId,result:String(f.get(`result:${l.lineId}`)),problem:String(f.get(`problem:${l.lineId}`)??''),treatment:String(f.get(`treatment:${l.lineId}`)??''),attachmentIds:images[l.lineId]??[]}));if(!checks.length){setError('请选择本次检查的PO及结果');return;}void save('/qc',{checks,note:''});}}><fieldset disabled={qcDisabled}><legend>QC检查／复查</legend>{sheet.lines.filter(l=>!target.lineId||l.lineId===target.lineId).map(l=><section key={l.lineId} id={`factory-qc-line-${l.lineId}`} className={target.lineId===l.lineId?"factory-po-focused":undefined}><h4>{l.poNumber??'待补PO'} · {l.color} · 当前{l.result??'未检查'}</h4><label>本次结论<select name={`result:${l.lineId}`} defaultValue=""><option value="">本次不登记</option><option>合格</option><option>需处理</option></select></label><label>问题及处理要求<textarea name={`problem:${l.lineId}`} maxLength={2000}/></label><label>处理结果／复查说明<textarea name={`treatment:${l.lineId}`} maxLength={2000}/></label><DocumentEntry category="results" label={`${l.poNumber??"待补PO"} · ${l.color} 检查图片`}><fieldset disabled={qcDisabled}><legend>{l.poNumber??"待补PO"} · {l.color} 检查图片</legend><label>可选图片<input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={e=>{const files=Array.from(e.currentTarget.files??[]);e.currentTarget.value='';void upload(l.lineId,files);}}/></label>{failedUploads[l.lineId]?.length?<Button type="button" onClick={()=>void upload(l.lineId,failedUploads[l.lineId]??[])}>重试未上传图片（{failedUploads[l.lineId]?.length}张）</Button>:null}<p>本次已上传{images[l.lineId]?.length??0}张</p><div className="factory-qc-images">{previews[l.lineId]?.map(photo=><a key={photo.attachmentId} href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={"本次检查图片"}/></a>)}</div><p>已上传图片待返回当前检查提交，上传不代表检查合格。</p></fieldset></DocumentEntry></section>)}<Button type="submit">保存检查／复查</Button></fieldset></form>:sheet.lines.map(l=><p key={l.lineId}>{l.poNumber??'待补PO'} · {l.color}：{l.result??'未检查'} {l.problem} {l.treatment}</p>)}</>}
 {wholeDispatch}
 {sheet.batchMode&&!['followup','productionQc','productionProgress'].includes(target.action)&&<FactoryBatchPanel sheet={sheet} busy={busy} paused={paused} action={target.action} save={save} upload={upload} images={images} previews={previews}/>}
 {Boolean(sheet.returnLogistics?.length)&&<details><summary>工厂发回仓物流预计</summary>{sheet.returnLogistics!.map(r=><p key={`${r.productionId}:${r.factoryDecisionId}`}>{r.supplierName} · 已登记发货日期 {r.shippedOn} · {r.hasReceived||r.firstReceivedAt?'已有实际到仓记录，余量请在原回货区核对':r.arrivalRange?`预计到仓范围 ${new Date(r.arrivalRange.fromInclusive).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}—${new Date(Date.parse(r.arrivalRange.toExclusive)-1).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}${r.estimateExpired?'（预计范围已过，请跟进实际物流）':''}`:'物流标准未知'}。原记录仅有日期，未记录实际时刻；此为物流预计。</p>)}</details>}
 {Boolean(sheet.productionChecks?.length)&&<FactoryProductionQcPanel sheet={sheet} busy={busy} paused={paused} open={target.action==='productionQc'} save={save}/>}
 <p><a href={productionWorkspaceDomainHref(`${urls.pageUrl("ui/digital-production")}?closure=${orderId}`,window.location.search)}>查看原回货、返工、装箱与结案</a></p><details><summary>船样记录</summary><p>船样目标寄出日：{sheet.sampleTargetDate??`${customerPoDateLabel}未登记`}（各 PO {customerPoDateLabel}前{sheet.sampleAdvanceDays??10}个自然日，按最早目标跟进）。船样记录不作为其它生产动作的额外门槛。</p><ul>{sheet.lines.map(line=><li key={line.lineId}>{line.poNumber||'待补 PO'} / {line.color}：{customerPoDateLabel} {line.customerWarehouseArrivalDate||'未登记'} · 船样目标 {line.sampleTargetDate||'未登记'}</li>)}</ul>{sheet.canRecordShipSample&&<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('/followup',{kind:'船样寄出',lineIds:f.getAll('sampleLine'),occurredAt:at(f),trackingNumber:String(f.get('tracking')??''),note:String(f.get('note')??'')});}}><fieldset disabled={busy||paused}><legend>船样寄出记录</legend><p>大货生产前安排寄出。</p>{sheet.lines.filter(l=>!sheet.shipSamples?.some(r=>r.lineIds.includes(l.lineId))).map(l=><label key={l.lineId}><input type="checkbox" name="sampleLine" value={l.lineId} defaultChecked/>{l.poNumber||'待补PO'} · {l.color}</label>)}<div className="ship-sample-fields">{time()}<label>快递单号<input name="tracking" required maxLength={200}/></label><label>说明<input name="note" maxLength={2000}/></label></div><Button type="submit" disabled={sheet.lines.every(l=>sheet.shipSamples?.some(r=>r.lineIds.includes(l.lineId)))}>记录已寄出</Button></fieldset></form>}{sheet.shipSamples?.map(r=><p key={r.eventId}>已寄出 · {r.occurredAt?new Date(r.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'实际时间未知'} · {r.operatorName} · {r.trackingNumber}</p>)}
 </details><details><summary>事实与检查历史</summary>{sheet.facts.map(f=><p key={f.factId} id={`fact-${f.factId}`}>{f.kind} · {f.actorName} · {f.occurredAt?new Date(f.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'真实时间未知'} · {String(f.payload.note??'')}{f.payload.trackingNumber?` · 快递单号 ${String(f.payload.trackingNumber)}`:''}</p>)}{sheet.checks.map(c=><section key={c.checkId} id={`check-${c.checkId}`}><p>{sheet.lines.find(l=>l.lineId===c.lineId)?.poNumber||"待补PO"} / {sheet.lines.find(l=>l.lineId===c.lineId)?.color} · {c.returnFactId===sheet.currentReturn?.factId?"本次回仓":"历史回仓"} · {c.result} · {c.checkedBy} · {new Date(c.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p><p>{c.problem} {c.treatment}</p>{c.attachmentIds.map(a=><a key={a} href={urls.apiUrl(`digital-production/${base}/attachments/${a}`)} target="_blank" rel="noreferrer">查看检查图片</a>)}</section>)}
 </details></div>}</section><BulkWashingPanel orderId={orderId}/></Surface></DocumentEntryScope></DocumentGuardContext.Provider>;
}
