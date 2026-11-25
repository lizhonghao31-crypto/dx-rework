import {useEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Selector} from '@astryxdesign/core/Selector';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import {createWebUrls} from '../url-contract.js';
import {createClientRequestId} from './client-request-id.js';
import {digitalDetailReturnUrl} from './digital-detail-route.js';
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {DigitalRequestError,digitalRequest} from './digital-production-api.js';
import {FactoryBatchPanel} from './factory-batch-panel.js';
import type {qualityRecordTarget} from './quality-workbench-route.js';

type Target=Extract<ReturnType<typeof qualityRecordTarget>,{kind:'craft'}>;
type Remedy={reworkId:string;execution:'factory'|'internal';status:string;quantity:number;canConfirmReinspection:boolean;
 remainingExternalQuantity?:number;priorReworks?:Array<{reworkId:string;quantity:number}>};
const urls=createWebUrls(import.meta.env.BASE_URL);
type Props={sheet:FactoryFlowSheet;target:Target;busy:boolean;paused:boolean;parentWriting:RefObject<boolean>;save:(path:string,body:Record<string,unknown>)=>Promise<void>;
 upload:(key:string,files:File[])=>Promise<void>;images:Record<string,string[]>;previews:Record<string,Array<{attachmentId:string;url:string}>>;
 failedUploads:Record<string,File[]>;removePendingPhoto:(key:string,id:string)=>void;clearFailed:(key:string)=>void};
export function CraftOriginalQuality({sheet,target,busy,paused,parentWriting,save,upload,images,previews,failedUploads,removePendingPhoto,clearFailed}:Props){
 const task=sheet.tasks.find(row=>row.taskKind==='bulk_qc'&&row.taskId===target.taskId&&(row.stepRef??null)===target.stepRef);
 const batch=sheet.batches?.find(row=>row.factId===target.returnFactId&&(row.stepRef??null)===target.stepRef);
 const line=sheet.lines.find(row=>row.lineId===target.lineId),actual=batch?.rows.find(row=>row.lineId===target.lineId);
 const original=sheet.facts.find(row=>row.kind==='工艺回仓'&&row.factId===target.returnFactId);
 const outgoing=sheet.facts.find(row=>row.kind==='工艺发出'&&row.factId===original?.payload.sendFactId);
 const factory=(original?.payload.warehouseMotion as {factoryId?:string}|undefined)?.factoryId;
 const canCount=Boolean(target.stepRef&&original?.payload.stepRef===target.stepRef&&outgoing?.payload.stepRef===target.stepRef&&factory&&
  (outgoing?.payload.warehouseMotion as {factoryId?:string}|undefined)?.factoryId===factory);
 const history=sheet.checks.filter(row=>row.returnFactId===target.returnFactId&&row.lineId===target.lineId);
 const replaced=new Set(history.flatMap(row=>row.supersedesCheckId?[row.supersedesCheckId]:[]));
 const problems=history.filter(row=>row.quantityScope?.problemQuantity&&!replaced.has(row.checkId));
 const [selectedCheckId,setSelectedCheckId]=useState('');
 const latest=problems.find(row=>row.checkId===selectedCheckId)??problems.at(-1);
 const [inspected,setInspected]=useState(''),[qualified,setQualified]=useState(''),[problem,setProblem]=useState(''),[mode,setMode]=useState('factory'),[amount,setAmount]=useState('');
 const [localError,setLocalError]=useState(''),[created,setCreated]=useState<{checkId:string;reworkId:string}|null>(null),[posting,setPosting]=useState(false),[unknown,setUnknown]=useState(false);
 const reworkId=created&&created.checkId===latest?.checkId?created.reworkId:null;
 const draftAttempt=useRef<{body:string;key:string}|null>(null),writing=useRef(false);
 const pendingWrite=useMemo(()=>({get current(){return writing.current||parentWriting.current;}}),[parentWriting]);
 const photoKey=`quality:${target.returnFactId}:${target.lineId}`;
 const failed=failedUploads[photoKey]??[];
 const proofPath=task?.canExecute&&target.stepRef&&sheet.preparationId&&latest?.quantityScope?.problemQuantity?
  `orders/${sheet.orderId}/factory-flow/craft-remediation?`+new URLSearchParams({preparationId:sheet.preparationId,stepRef:target.stepRef,
   returnFactId:target.returnFactId,lineId:target.lineId,checkId:latest.checkId}):null;
 const proofKey=proofPath?`${proofPath}:${sheet.revision}`:null;
 const [remedyRead,setRemedyRead]=useState<{key:string;item:Remedy|null;error?:string}|null>(null),[refresh,setRefresh]=useState(0);
 const remedy=remedyRead?.key===proofKey?remedyRead.item:null;
 const remedyError=remedyRead?.key===proofKey?remedyRead.error:undefined;
 useEffect(()=>{setInspected('');setQualified('');setProblem('');},[history.length,target.returnFactId,target.lineId]);
 useEffect(()=>{
  if(!proofPath||!proofKey)return;
  const abort=new AbortController();
  void digitalRequest<{item:Remedy|null}>(proofPath,'GET',undefined,undefined,{signal:abort.signal})
   .then(({item})=>{if(!abort.signal.aborted)setRemedyRead({key:proofKey,item});})
   .catch(error=>{if(!abort.signal.aborted)setRemedyRead({key:proofKey,item:null,error:error instanceof Error?error.message:'原返工资料尚未读取'});});
  return()=>abort.abort();
 },[proofPath,proofKey,refresh]);
 const remaining=actual?.uninspectedQuantity??(!history.length?actual?.returned??0:0);
 useDigitalDetailNavigationGuard(unknown||!canCount&&Boolean(images[target.lineId]?.length)||(remaining>0||Boolean(remedy?.canConfirmReinspection))&&Boolean(images[photoKey]?.length||failed.length),posting,pendingWrite,'本次检查的图片或原返工草稿回执尚未确认，仍要离开？');
 if(!task||!batch||!line||!actual||!original)return <p role="alert">原工艺检查的任务、回仓或 PO 范围已变化，请返回质量中心重新读取。</p>;
 const canWrite=task.canExecute&&task.state==='ready'&&!task.paused&&!sheet.dispatched&&!paused;
 const continuation=remedy?.execution==='factory'&&(remedy.remainingExternalQuantity??0)>0?remedy.reworkId:null;
 const max=remedy?(continuation?remedy.remainingExternalQuantity??0:0):latest?.quantityScope?.problemQuantity??0;
 const eligible=Boolean(canWrite&&max&&target.stepRef&&sheet.preparationId&&original.payload.warehouseMotion&&remedyRead?.key===proofKey&&!remedyError);
 const create=async()=>{
  if(!eligible||!latest||writing.current)return;
  const quantity=Number(amount);
  if(!Number.isInteger(quantity)||quantity<=0||quantity>max){setLocalError(`请输入 1 至 ${max} 的实际返工片数。`);return;}
  const body=JSON.stringify({scope:{orderId:sheet.orderId,preparationId:sheet.preparationId,stepRef:target.stepRef,
   returnFactId:target.returnFactId,lineId:target.lineId,checkId:latest.checkId},execution:continuation?'factory':mode,quantity,
   ...(continuation?{continueAfterReworkId:continuation}:{})});
  if(draftAttempt.current?.body!==body)draftAttempt.current={body,key:createClientRequestId()};
  writing.current=true;setPosting(true);setLocalError('');
  try{
   const response=await feedbackFetch(urls.apiUrl('rework-orders/craft-quality/drafts'),{method:'POST',credentials:'include',cache:'no-store',
    headers:{'content-type':'application/json','idempotency-key':draftAttempt.current.key},body});
   const result=await feedbackJson(response,'POST',value=>value as {reworkOrderId:string},(message,code,status)=>new DigitalRequestError(message,status,code));
   if(!DigitalIdSchema.safeParse(result.reworkOrderId).success)throw new DigitalRequestError('未确认原返工单回执，保留本次资料重试。',200,'INVALID_RESPONSE');
   setCreated({checkId:latest.checkId,reworkId:result.reworkOrderId});setUnknown(false);
  }catch(error){setUnknown(!(error instanceof DigitalRequestError)||error.resultUnknown);
   setLocalError(error instanceof Error?error.message:'未确认原返工单回执，保留本次资料重试。');}
  finally{writing.current=false;setPosting(false);}
 };
 const back=digitalDetailReturnUrl(window.location.pathname+window.location.search,urls.base);
 return <section aria-label="本批原工艺检查">
  <h3>{line.poNumber??'PO 待核'} · {line.color}</h3><p>本批实际回仓 {actual.returned} 片</p>
  {localError&&<p role="alert">{localError}</p>}
  {remedyError&&<p role="alert">{remedyError} <Button type="button" label="重试原返工读取" onClick={()=>setRefresh(value=>value+1)}/></p>}
  {history.map((record,index)=><div key={record.checkId}><p>第 {index+1} 次：{record.result} · {record.problem||'无已登记问题'}{replaced.has(record.checkId)?' · 已有本范围复检记录':''}</p>
   {record.quantityScope&&<p>实际已检 {record.quantityScope.inspectedQuantity} 片 · 合格 {record.quantityScope.qualifiedQuantity} 片 · 问题 {record.quantityScope.problemQuantity} 片</p>}
   {record.attachmentIds.map((id,index)=><a key={id} href={urls.apiUrl(`digital-production/orders/${sheet.orderId}/factory-flow/original-attachments/${id}?`+
    new URLSearchParams({checkId:record.checkId,returnFactId:batch.factId,lineId:line.lineId,stepRef:batch.stepRef??'original'}))} target="_blank" rel="noreferrer">查看原检查图片 {index+1}</a>)}
  </div>)}
  {problems.length>1&&<Selector label="原问题检查范围" value={latest?.checkId??''} isDisabled={posting||unknown}
   options={problems.map(row=>({value:row.checkId,label:`第 ${history.indexOf(row)+1} 次检查 · ${row.quantityScope!.problemQuantity} 片问题`}))}
   onChange={value=>{setSelectedCheckId(value);setAmount('');setLocalError('');}}/>}
  {canWrite&&canCount&&remaining>0&&target.stepRef&&<form onSubmit={event=>{
   event.preventDefault();if(failed.length)return;setLocalError('');const total=Number(inspected),passed=Number(qualified);
   if(!inspected||!qualified||!Number.isInteger(total)||!Number.isInteger(passed)||total<=0||total>remaining||passed<0||passed>total||total>passed&&!problem.trim()){
    setLocalError('请填写实际检查片数、合格片数及问题说明，不能超过本批未检查的实际片数。');return;
   }
   void save('/qc',{stepRef:target.stepRef,returnFactId:batch.factId,checks:[{lineId:line.lineId,result:total>passed?'需处理':'合格',problem,
    treatment:'',attachmentIds:images[photoKey]??[],quantityScope:{inspectedQuantity:total,qualifiedQuantity:passed,problemQuantity:total-passed,unit:'片'}}]});
  }}><fieldset disabled={busy}><legend>登记实际工艺检查</legend><p>本批还有 {remaining} 片未检查</p>
   <TextInput label="本次实际检查片数" value={inspected} onChange={setInspected}/><TextInput label="本次实际合格片数" value={qualified} onChange={setQualified}/>
   <TextInput label="质量问题" value={problem} onChange={setProblem}/>
   <label>上传质检报告图片<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event=>void upload(photoKey,Array.from(event.target.files??[]))}/></label>
   {previews[photoKey]?.map((photo,index)=><div key={photo.attachmentId}><img className="qc-upload-preview" alt={`待提交质检报告 ${index+1}`} src={photo.url}/>
    <Button type="button" label={`移除本次图片 ${index+1}`} variant="secondary" onClick={()=>removePendingPhoto(photoKey,photo.attachmentId)}/></div>)}
   {failed.length>0&&<div role="alert">尚有 {failed.length} 张图片未上传
    <Button type="button" label="重试未上传图片" onClick={()=>void upload(photoKey,failed)}/>
    <Button type="button" label="移除失败图片" variant="secondary" onClick={()=>clearFailed(photoKey)}/></div>}
   <Button type="submit" label="保存本批检查" isDisabled={failed.length>0}/>
  </fieldset></form>}
  {canWrite&&!canCount&&<FactoryBatchPanel sheet={sheet} busy={busy} paused={paused} action="qc" save={save} upload={upload} images={images} previews={previews}
   qcSource={{stepRef:target.stepRef,returnFactId:target.returnFactId,lineId:target.lineId}}/>}
  {eligible&&!reworkId&&<form onSubmit={event=>{event.preventDefault();void create();}}><fieldset disabled={posting}>
   <legend>{continuation?'续办本批剩余外厂返修':'按本次已核实问题发起原返工'}</legend>
   <p>{continuation?'同批剩余可返修':'原问题范围'} {max} 片，开草稿不占用或放行实物。</p>
   {!continuation&&<Selector label="返工办理方" value={mode} isDisabled={unknown} options={[{value:'factory',label:'原工艺厂返修'},{value:'internal',label:'本厂尾部返工'}]} onChange={value=>{if(value==='factory'||value==='internal')setMode(value);}}/>}
   <TextInput label="本次实际返工片数" value={amount} isDisabled={unknown} onChange={setAmount}/><Button type="submit" label={unknown?'核对原返工草稿回执':'打开原返工草稿'}/>
  </fieldset></form>}
  {remedy?.canConfirmReinspection&&canWrite&&<form onSubmit={event=>{
   event.preventDefault();if(failed.length)return;
   void save('/qc',{internalReworkId:remedy.reworkId,stepRef:target.stepRef,returnFactId:target.returnFactId,checks:[{lineId:target.lineId,result:'合格',
    attachmentIds:images[photoKey]??[],quantityScope:{inspectedQuantity:remedy.quantity,qualifiedQuantity:remedy.quantity,problemQuantity:0,unit:'片'}}]});
  }}><fieldset disabled={busy}><legend>本厂返工已完成，待复检</legend><p>本次原返工实际数量 {remedy.quantity} 片，其他未检或未返工范围不受影响。</p>
    <Button type="submit" label="确认本批原返工复检合格"/>
  </fieldset></form>}
  {(reworkId??remedy?.reworkId)&&<a href={urls.pageUrl(`ui/tasks/${reworkId??remedy!.reworkId}`)+(back?'?'+new URLSearchParams({returnTo:back}):'')}>查看原返工单</a>}
  {remedy?.priorReworks?.map(row=><a key={row.reworkId} href={urls.pageUrl(`ui/tasks/${row.reworkId}`)+(back?'?'+new URLSearchParams({returnTo:back}):'')}>查看此前返工（{row.quantity} 片）</a>)}
 </section>;
}
