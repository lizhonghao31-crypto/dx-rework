import {RevisionCommentIntentContext,type RevisionCommentIntent} from './development-revision-comment-intent.js';
import {DevelopmentAccessoryForecastForm,DevelopmentMaterialEventForm} from './development-material-event-form.js';
import {ProductionReadinessPanel} from './production-readiness-panel.js';
import {useOrderTimeApplication} from './order-time-application.js';
import {useTodoContentRead} from './todo-content-read.js';
import {quotationHref} from './digital-quotation-panel.js';
import {DevelopmentAmendmentHistory} from "./development-amendment-history.js";
import {developmentInheritedLabels as inheritedLabels} from './development-round-context.js';
import {useDocumentUploadPreviews} from "./document-upload-previews.js";
import { ResumeDevelopmentCreateForm } from "./digital-development-create-form.js";
import { DevelopmentDocumentFields } from "./development-document-fields.js";
import { useDigitalDetailNavigationGuard } from "./use-digital-detail-navigation-guard.js";
import {DevelopmentRevisionFields,type RevisionFields} from "./development-revision-fields.js";
import type {DevelopmentRevision} from "@dx-rework/contracts/digital-development-rounds";
import type {DevelopmentTechnicalState} from '@dx-rework/contracts/digital-development-technical';
import {DevelopmentPatternLink,type DevelopmentPatternChoice} from "./development-pattern-link.js";
import { DevelopmentExecutionPanel } from "./digital-development-execution-panel.js";
import { confirmInApp } from "./system-dialog.js";
import { DevelopmentPrint } from "./digital-development-print.js";
import {developmentPrintAttachmentMime,useDevelopmentPrint} from "./development-print-preview.js";
import { useContext, useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import type { DevelopmentDocument, DevelopmentMaterialEvent, DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { initialDevelopmentDocument, editableDevelopmentDocument, developmentSizeQuantityInputs, attachDevelopmentCraftFile } from "./digital-development-editing.js";
import { uploadDevelopmentMaterial } from "./digital-development-upload.js";
import { DigitalRequestError,digitalRequest } from "./digital-production-api.js";
import { createClientRequestId } from "./client-request-id.js";
import { sha256Hex } from "./attachment-upload.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development.css";
import { DocumentToolbar, DocumentErrors, DocumentSection } from "./document-editor.js";
import { developmentIssues } from "./digital-development-validation.js";
import {productionWorkspaceDomainHref} from "./digital-detail-route.js";
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import {sessionCacheVersion} from './auth-session.js';
const urls = createWebUrls(import.meta.env.BASE_URL);
const initial = initialDevelopmentDocument;
type RoundHistory={roundNumber:number;origin:string;customerComment:string;internalProblem:string;explanation:string;affectedNodes:string[];inherited:Record<string,{taskId:string;roundNumber:number}>};
type Rounds={rounds:RoundHistory[];draft:{version:number;payload:DevelopmentRevision}|null};
const sameOriginalComment=(a:RevisionCommentIntent['ref'],b:RevisionCommentIntent['ref'])=>a.commentId===b.commentId
  &&a.version===b.version&&a.sourceId===b.sourceId&&a.roundNumber===b.roundNumber&&a.scopeRef===b.scopeRef;
export type DevelopmentSheetRead=(sheet:DevelopmentSheet,requestedRound:number|undefined)=>void;
export function DigitalDevelopmentPanel({sourceId,onClose,initialRound,embedded=false,contained=false,directEdit=false,onVersionChange,onRead}:{sourceId:string;onClose:()=>void;onVersionChange?:((version:number|undefined)=>void)|undefined;onRead?:DevelopmentSheetRead|undefined;initialRound?:number|undefined;contained?:boolean;embedded?:boolean;directEdit?:boolean}) {
  const print=useDevelopmentPrint();
  const previews=useDocumentUploadPreviews({onFailureRemoved:message=>setError(current=>current===message?'':current)});
  const [sheet,setSheet]=useState<DevelopmentSheet|null>(null),[document,setDocument]=useState<DevelopmentDocument>(initial);
  const [showPublishedDocument,setShowPublishedDocument]=useState(false);
  useEffect(()=>setShowPublishedDocument(false),[sourceId]);
  useEffect(() => {
    if (!sheet) return;
    const anchor = window.location.hash.slice(1);
    if (!/^material-[0-9a-f-]{36}$/.test(anchor)) return;
    window.document.getElementById(anchor)?.scrollIntoView({ block: "center" });
  }, [sheet]);
  const [patternChoice,setPatternChoice]=useState<DevelopmentPatternChoice|null>(null);
  const [sizeQuantityInputs,setSizeQuantityInputs]=useState<string[]>([]);
  const [quantityInput,setQuantityInput]=useState(""),[validationMode,setValidationMode]=useState<"save"|"publish"|null>(null);
  const measurementIds=useRef<string[]>([]),successfulUploads=useRef(new Map<string,string>());
  const installDocument=(value:DevelopmentDocument)=>{setDocument(value);setSizeQuantityInputs(developmentSizeQuantityInputs(value));setQuantityInput(value.quantity===null?"":String(value.quantity));measurementIds.current=value.measurements.map(()=>createClientRequestId());setValidationMode(null);};
  if(measurementIds.current.length!==document.measurements.length)measurementIds.current=document.measurements.map((_,index)=>measurementIds.current[index]??createClientRequestId());
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);
  const [revision,setRevision]=useState<RevisionFields|null>(null),[draftVersion,setDraftVersion]=useState(0),[rounds,setRounds]=useState<Rounds>({rounds:[],draft:null}),[selectedRound,setSelectedRound]=useState<number|undefined>(initialRound);
  const [roundsRead,setRoundsRead]=useState(false);
  const [revisionReceipt,setRevisionReceipt]=useState('');
  const commentIntent=useContext(RevisionCommentIntentContext);
  const [revisionComment,setRevisionComment]=useState<RevisionCommentIntent|null>(null);
  const commentRef=revision?.customerCommentRef,repeatBase=revision?.repeatOriginalComment,revisionRound=revision?.basedOnRound;
  const linkedComment=revisionComment&&commentRef&&sameOriginalComment(revisionComment.ref,commentRef)?revisionComment:null;
  const publishCurrent=Boolean(commentRef&&(linkedComment||repeatBase?.sourceId===sourceId));
  const applyingComment=useRef<RevisionCommentIntent|null>(null);
  const [fileKind,setFileKind]=useState<DevelopmentDocument["files"][number]["kind"]>("款图");
  const writing=useRef(false),operation=useRef<{payload:string;key:string}|null>(null);
  const revisionAttempt=useRef(new SubmissionAttempt());
  const pendingRevision=revisionAttempt.current.hasPending;
  const timeApplication=useOrderTimeApplication(()=>{setDirty(false);});
  useDigitalDetailNavigationGuard(dirty||pendingRevision, busy, writing, pendingRevision?'复版提交结果尚未确认，离开不会撤销原请求。':'有未保存修改，确定离开？');
  const base=`sources/${sourceId}/development`;
  const applySheet=(value:DevelopmentSheet)=>{setSheet(value);onRead?.(value,selectedRound);};
  useEffect(()=>{
    let live=true;
    if(directEdit)setRoundsRead(false);
    void digitalRequest<DevelopmentSheet>(`${base}${selectedRound?`?round=${selectedRound}`:""}`).then(value=>{
      if(!live)return;
      applySheet(value);
      installDocument(value.document??initial());
      setDirty(false);
      setError("");
      if(value.status==="published")void digitalRequest<Rounds>(`${base}/rounds`).then(data=>{
        if(!live)return;
        setRounds(data);
        if(directEdit)setRoundsRead(true);
      }).catch(reason=>{if(live)setError(reason.message);});
    }).catch(reason=>{if(live)setError(reason.message);});
    return()=>{live=false;};
  },[sourceId,selectedRound,onRead,directEdit]);
  const edit=(patch:Partial<DevelopmentDocument>)=>{setDocument(current=>({...current,...patch}));setDirty(true);};
  const run=async(path:string,body:unknown,method="POST")=>{
    if(writing.current)return false;writing.current=true;setBusy(true);setError("");
    const payload=JSON.stringify([path,body,method]);if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
    try{if(path===base+'/publish'&&!await timeApplication.inspect({kind:'development_publish',sourceId,input:body as {expectedVersion:number;patternOrder?:DevelopmentPatternChoice}},Boolean(sheet?.orderTimeEnabled)))return false;
      const value=await digitalRequest<DevelopmentSheet>(path,method,body,operation.current.key);applySheet(value);installDocument(value.document??initial());setDirty(false);previews.saved();operation.current=null;return true;}
    catch(reason){setError(reason instanceof Error?reason.message:"操作失败");return false;}finally{writing.current=false;setBusy(false);}
  };
  const beginRevision=()=>{
    setRevisionComment(null);setPatternChoice(null);
    const draft=rounds.draft;installDocument(editableDevelopmentDocument(draft?.payload.document??sheet!.document!));
    setRevision(draft?{...draft.payload}:{basedOnRound:sheet!.latestRoundNumber??1,origin:"客户新增要求",customerComment:"",internalProblem:"",explanation:`参考第${sheet!.roundNumber??1}轮资料`,categories:["其他"],affectedNodes:["车板"],outputKind:"整件样板"});
    setDraftVersion(draft?.version??0);setDirty(!draft);
  };
  useEffect(()=>{
    if(linkedComment||!commentRef||repeatBase?.sourceId!==sourceId||!revisionRound)return;
    const abort=new AbortController();
    void digitalRequest<DevelopmentTechnicalState>(`sources/${sourceId}/execution/technical?roundNumber=${revisionRound}`,
      'GET',undefined,undefined,{signal:abort.signal}).then(state=>{
      const original=state.inheritedRevisionComment;
      if(!abort.signal.aborted&&original?.previousRoundNumber===repeatBase.roundNumber&&sameOriginalComment(original.ref,commentRef))
        setRevisionComment({ref:original.ref,text:original.text,evidenceRefs:original.evidenceRefs,repeatBase});
    }).catch(()=>{/* The saved draft remains editable if the original attachment read is unavailable. */});
    return()=>abort.abort();
  },[sourceId,linkedComment,commentRef,repeatBase,revisionRound]);
  useEffect(()=>{
    const intent=commentIntent?.target;
    if(!intent||!roundsRead||!sheet?.canRevise||sheet.status!=='published'||
       (intent.repeatBase?intent.repeatBase.sourceId!==sourceId:intent.ref.sourceId!==sourceId||intent.ref.roundNumber!==(sheet.roundNumber??1))||busy||pendingRevision||writing.current||applyingComment.current===intent)return;
    applyingComment.current=intent;
    void (async()=>{
      if(dirty&&!await confirmInApp('有未保存的修改，确定改用这条原客户评语？')){
        commentIntent.clear(intent);return;
      }
      if(writing.current)return;
      beginRevision();
      setRevision(current=>current?{...current,origin:'客户新增要求',internalProblem:'',
        customerComment:intent.text,customerCommentRef:intent.ref,repeatOriginalComment:intent.repeatBase}:null);
      setRevisionComment(intent);setDirty(true);
      commentIntent.clear(intent);
      requestAnimationFrame(()=>{
        const form=window.document.getElementById('development-revision');
        form?.scrollIntoView({block:'start'});form?.focus({preventScroll:true});
      });
    })();
  },[commentIntent,roundsRead,sheet,sourceId,busy,pendingRevision,dirty]);
  const submitAdoptedRevision=async(input?:{expectedDraftVersion:number;basedOnRound:number;revision:DevelopmentRevision;
    publishCurrent?:true;expectedBasisVersion?:number;patternOrder?:DevelopmentPatternChoice})=>{
    if(writing.current||input&&revisionAttempt.current.hasPending)return;
    writing.current=true;setBusy(true);setError('');setRevisionReceipt('');
    try{
      const key=input?createClientRequestId():undefined,actor=sessionCacheVersion();
      const send=async()=>{
        if(actor!==sessionCacheVersion())throw new SubmissionRequestError('登录身份已变化，请使用原账号核对。','FORBIDDEN',403);
        let result:{sourceId:string;roundNumber:number;status?:'published'|'draft'|'needs_time_request'|'needs_inputs';
          documentVersion?:number;reason?:string;patternOrder?:DevelopmentPatternChoice};
        try{result=await digitalRequest(`${base}/round-publish`,'POST',input,key);}
        catch(reason){if(reason instanceof DigitalRequestError&&!reason.resultUnknown)throw new SubmissionRequestError(reason.message,reason.code,reason.status??500);throw reason;}
        if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(result?.sourceId??'')||!Number.isSafeInteger(result?.roundNumber)||result.roundNumber!==(result.sourceId===sourceId?input!.basedOnRound+1:1))throw Error('未确认本轮复版的正式回执');
        revisionAttempt.current.markConfirmed();setRevision(null);setDirty(false);previews.saved();
        if(result.sourceId!==sourceId){
          if(result.status==='needs_time_request'&&result.documentVersion){
            setRevisionReceipt('独立复版单已保留，尚未发布。请沿原时效申请继续。');
            await timeApplication.inspect({kind:'development_publish',sourceId:result.sourceId,
              input:{expectedVersion:result.documentVersion,...(result.patternOrder?{patternOrder:result.patternOrder}:{})}},true);
            return;
          }
          if(result.status==='needs_inputs'){setRevisionReceipt(`独立复版单尚未发布。${result.reason??'请补齐本次实际前置。'}`);return;}
          window.location.assign(urls.pageUrl(`ui/digital-production?development=${result.sourceId}`));return;
        }
        setRevisionReceipt('本轮复版已发布，正在读取原版单。');
        setSelectedRound(result.roundNumber);
        const location=new URL(window.location.href);location.searchParams.set('round',String(result.roundNumber));window.history.replaceState(window.history.state,'',location);
        const next=await digitalRequest<DevelopmentSheet>(`${base}?round=${result.roundNumber}`);
        applySheet(next);installDocument(next.document??initial());
        setRevisionReceipt('本轮复版已发布。');
      };
      const result=input?await revisionAttempt.current.run(send):await revisionAttempt.current.retry();
      if(result.kind==='failure'){
        if(result.confirmed){setRevisionReceipt('本轮复版已发布，读取原版单失败。请重新读取，不必再提交。');setError('未能读取已发布的复版资料。');}
        else setError(result.failure.message);
      }else if(result.kind==='expired')setError('已超过原请求安全恢复期限，请先核对原复版单。');
    }finally{writing.current=false;setBusy(false);}
  };
  const revisionAction=async(publish:boolean)=>{
    if(publish&&revision?.customerCommentRef){
      await submitAdoptedRevision({expectedDraftVersion:draftVersion,basedOnRound:revision.basedOnRound,revision:{...revision,document},
        ...(publishCurrent&&sheet?{publishCurrent:true as const,expectedBasisVersion:sheet.version,...(patternChoice?{patternOrder:patternChoice}:{})}:{})});return;
    }
    if(!revision||writing.current)return;writing.current=true;setBusy(true);setError("");
    try{
      let version=draftVersion;
      if(publish&&dirty){
        const draftBody={expectedDraftVersion:version,revision:{...revision,document}};
        const draftPath=base+'/round-draft',draftSignature=JSON.stringify([draftPath,draftBody,'PUT']);
        if(operation.current?.payload!==draftSignature)operation.current={payload:draftSignature,key:createClientRequestId()};
        const saved=await digitalRequest<{draftVersion:number}>(draftPath,'PUT',draftBody,operation.current.key);
        version=saved.draftVersion;setDraftVersion(version);setDirty(false);operation.current=null;
      }
      const body=publish?{expectedDraftVersion:version,basedOnRound:revision.basedOnRound}:{expectedDraftVersion:version,revision:{...revision,document}};
      const path=`${base}/${publish?"round-publish":"round-draft"}`,payload=JSON.stringify([path,body]);
      if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
      if(publish&&revision.origin==='内部发现'&&!await timeApplication.inspect({kind:'development_revision',sourceId,input:{expectedDraftVersion:version,basedOnRound:revision.basedOnRound}},Boolean(sheet?.orderTimeEnabled)))return;
      const response=await digitalRequest<{draftVersion?:number;sourceId?:string}>(path,publish?"POST":"PUT",body,operation.current.key);operation.current=null;setDirty(false);previews.saved();
      if(publish&&response.sourceId&&response.sourceId!==sourceId){
        setRevision(null);setDirty(false);window.location.assign(urls.pageUrl(`ui/digital-production?development=${response.sourceId}`));return;
      }
      if(publish){const next=await digitalRequest<DevelopmentSheet>(base);setSheet(next);installDocument(next.document!);setRevision(null);setSelectedRound(next.roundNumber);const url=new URL(window.location.href);url.searchParams.set("round",String(next.roundNumber??1));window.history.replaceState(window.history.state,"",url);setRounds(await digitalRequest<Rounds>(`${base}/rounds`));}
      else{setDraftVersion(response.draftVersion!);const refreshed=await digitalRequest<Rounds>(`${base}/rounds`);setRounds(refreshed);if(refreshed.draft)installDocument(refreshed.draft.payload.document);}
    }catch(reason){setError(reason instanceof Error?reason.message:"复版操作失败");}finally{writing.current=false;setBusy(false);}
  };
  const uploadContext=useRef(0),uploadWriter=useRef(false);
  useEffect(()=>{uploadContext.current++;if(uploadWriter.current){uploadWriter.current=false;writing.current=false;setBusy(false);}previews.reset();successfulUploads.current.clear();return()=>{uploadContext.current++;};},[sourceId,selectedRound]);
  const upload=async(files:File[],kind=fileKind,stepKey?:string)=>{
    if(!files?.length||writing.current)return;
    previews.start(files,kind,selected=>upload(selected,kind,stepKey));
    const currentUploadContext=uploadContext.current;uploadWriter.current=true;writing.current=true;setBusy(true);setError("");
    try{
      let fileCount=document.files.length;
      const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
      for(const file of Array.from(files)){try{
        if(file.size>limits.maxUploadBytes)throw Error(`${file.name}超过上传大小限制`);
        const hash=await sha256Hex(file),fingerprint=JSON.stringify([kind,file.name,file.size,hash]);
        const existing=successfulUploads.current.get(fingerprint);
        if(existing){
          previews.uploaded(file,existing);
          if(stepKey){setDocument(current=>({...current,craftRequirements:attachDevelopmentCraftFile(current,stepKey,existing)}));setDirty(true);}
          continue;
        }
        if(fileCount>=30)throw Error("开发单最多30个附件");
        const attachmentId=await uploadDevelopmentMaterial(base,file,kind,limits.maxUploadBytes);
        if(currentUploadContext!==uploadContext.current)return;previews.uploaded(file,attachmentId);successfulUploads.current.set(fingerprint,attachmentId);fileCount++;
        setDocument(current=>({...current,files:[...current.files,{attachmentId,kind}],
          ...(stepKey?{craftRequirements:attachDevelopmentCraftFile(current,stepKey,attachmentId)}:{})}));setDirty(true);
      }catch(reason){if(currentUploadContext!==uploadContext.current)return;const message=reason instanceof Error?reason.message:"上传失败";previews.failed(file,message);setError(message);}}
    }catch(reason){if(currentUploadContext===uploadContext.current){const message=reason instanceof Error?reason.message:"上传失败";for(const file of files)previews.failed(file,message);setError(message);}}finally{if(currentUploadContext===uploadContext.current){uploadWriter.current=false;writing.current=false;setBusy(false);}}
  };
  const readonly=embedded||pendingRevision|| (revision?!sheet?.canRevise:!sheet?.canEdit||sheet.status==="published");
  const imageUrl=(id:string)=>previews.url(id,urls.apiUrl(`digital-production/${base}/attachments/${id}`));
  const issues=validationMode?developmentIssues(document,quantityInput,measurementIds.current,validationMode==="publish",revision,sizeQuantityInputs,Boolean(revision&&sheet?.document?.orderDate===null)):[];
  const issue=(id:string)=>issues.find(value=>value.id===id)?.message;
  const validate=(publish=false)=>{setValidationMode(publish?"publish":"save");return developmentIssues(document,quantityInput,measurementIds.current,publish,revision,sizeQuantityInputs,Boolean(revision&&sheet?.document?.orderDate===null)).length===0;};
  const save=()=>{if(!validate())return;if(revision)void revisionAction(false);else void run(base,{expectedVersion:sheet!.version,document},"PUT");};
  const publish=()=>{if(!validate(true))return;if(dirty&&!revision){setError("请先保存当前修改");return;}if(revision)void revisionAction(true);else{if(!patternChoice&&sheet?.revisionSource?.outputKind!=='工艺布片'){setError("请先选择有效打板品类与执行价，再正式提交开发单");window.document.getElementById("development-pattern-preparation")?.scrollIntoView({block:"center"});return;}void run(`${base}/publish`,{expectedVersion:sheet!.version,...(sheet?.revisionSource?.outputKind==='工艺布片'?{}:{patternOrder:patternChoice})});}};
  const reload=async()=>{if(writing.current||dirty&&!await confirmInApp("重新载入将丢弃未保存修改，确定继续？"))return;setBusy(true);try{const value=await digitalRequest<DevelopmentSheet>(`${base}${selectedRound?`?round=${selectedRound}`:""}`);applySheet(value);installDocument(value.document??initial());setRevision(null);setDirty(false);setError("");if(value.status==="published")setRounds(await digitalRequest<Rounds>(`${base}/rounds`));}catch(reason){setError(reason instanceof Error?reason.message:"读取失败");}finally{setBusy(false);}};
  const readRef=useTodoContentRead({routeName:'digital_development',entityId:sourceId,developmentRound:sheet?.roundNumber??1},Boolean(sheet?.document));
  const savedPrint=revision?rounds.draft?.payload.document:sheet?.document;
  const printVersion=!revision&&sheet?.status==="published"?{base:`${base}/versions/${sheet.version}`,round:sheet.roundNumber??1}:null;
  const printImage=(id:string)=>printVersion?urls.apiUrl(`digital-production/${printVersion.base}/attachments/${id}?round=${printVersion.round}`):imageUrl(id);
  const printMime=developmentPrintAttachmentMime(id=>printVersion?`${printVersion.base}/attachments/${id}/metadata?round=${printVersion.round}`:`${base}/attachments/${id}/metadata`);
  const directRevision=directEdit&&!embedded&&!revision&&roundsRead&&sheet?.status==='published'
    &&sheet.canEdit&&sheet.canRevise&&Boolean(sheet.document)&&(selectedRound===undefined||selectedRound===(sheet.roundNumber??1));
  if(!embedded&&sheet?.canEdit&&!revision&&(sheet.status==="draft"||(!directEdit&&!showPublishedDocument&&sheet.document?.customerOrderDraft?.withOrder&&!sheet.productionOrderId)))return <ResumeDevelopmentCreateForm contained={contained} key={`${sheet.sourceId}:${sheet.version}`} sheet={sheet} onClose={onClose} onCreated={()=>void reload()} onViewPublished={()=>setShowPublishedDocument(true)}/>;
  return <Surface><section ref={readRef} className="development-editor dx-doc-development">
    <DocumentToolbar title={sheet?`开发单 · ${sheet.designStyleNo}`:"开发单"} status={busy?"保存中":pendingRevision?'复版提交结果待确认':error&&dirty?"没有保存成功，修改还在":dirty?"未保存修改":`${revision?`第${revision.basedOnRound+1}轮复版草稿`:sheet?.status==="published"?`已发布 · 第${sheet.roundNumber??1}轮${(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)?" · 当前有效轮次":" · 历史轮次"}`:"草稿"} · ${revision?"复版草稿版本":"资料版本"} ${revision?draftVersion:sheet?.version??0}`}>
      {!embedded&&!contained&&<Button disabled={busy} onClick={onClose}>返回</Button>}
      {directRevision&&<Button variant="primary" disabled={busy} title={rounds.draft?'继续修订草稿':undefined} onClick={beginRevision}>编辑版单</Button>}
      {!readonly&&<><Button disabled={busy} onClick={save}>保存草稿</Button><Button variant="primary" disabled={busy||(!revision&&sheet?.revisionSource?.outputKind!=="工艺布片"&&!patternChoice)||Boolean(publishCurrent&&sheet?.independentRevisions&&revision?.outputKind==="整件样板"&&!patternChoice)} onClick={publish}>{revision?(sheet?.independentRevisions&&revision.origin!=="内部发现"?"建立独立复版单":"正式发布本轮修改"):"发布开发单"}</Button></>}
      {pendingRevision&&!busy&&<Button onClick={()=>void submitAdoptedRevision()}>使用原内容核对复版提交</Button>}
      <Button disabled={!savedPrint||dirty||busy||print.busy} onClick={()=>void print.preview(printMime)}>{print.busy?"正在准备打印…":"打印 / 保存 PDF"}</Button>
    </DocumentToolbar>
    {sheet?.canEdit&&!embedded&&!directEdit&&<a className="dx-button dx-button--secondary" href={quotationHref({kind:'source',id:sourceId},window.location.pathname+window.location.search)}>客户报价协作</a>}{previews.view}<DocumentErrors issues={issues} error={error}/>{error&&!pendingRevision&&<Button disabled={busy} onClick={()=>void reload()}>重新载入</Button>}{revisionReceipt&&<p role="status">{revisionReceipt}</p>}{timeApplication.dialog}
    {print.error&&<p role="alert">{print.error}</p>}
    {!sheet&&<p>正在读取开发单</p>}
    {sheet&&<>
      {dirty||busy||!savedPrint?<article className="development-print"><p>当前单据不可打印，请先保存当前修改。</p></article>:<DevelopmentPrint printRef={print.ref} sheet={revision?{...sheet,status:"draft",roundNumber:revision.basedOnRound+1,version:draftVersion}:sheet} document={savedPrint} imageUrl={printImage}/>}
      {sheet.revisionSource&&<details><summary>复版 {sheet.revisionSource.revisionNumber} · 原单与原因</summary><p><a href={urls.pageUrl(`ui/digital-production?development=${sheet.revisionSource.parentSourceId}`)}>查看来源开发单</a> · 参考第 {sheet.revisionSource.parentRound} 轮</p><p>{sheet.revisionSource.origin} · {sheet.revisionSource.customerComment}</p><p>{sheet.revisionSource.categories.join('、')} · {sheet.revisionSource.explanation}</p></details>}
      <div className="development-heading dx-doc-card"><span>款号：<strong>{sheet.designStyleNo}</strong></span><span>代用号：{sheet.temporaryStyleNo??"—"}</span><span>客户：{sheet.customerCode??"通用开发"}</span><span>设计师：{sheet.designerName}</span><span>{sheet.developmentType} · 第{revision?revision.basedOnRound+1:sheet.roundNumber??1}轮 · 资料版本 {revision?draftVersion:sheet.version}</span></div>


      <form onSubmit={event=>{event.preventDefault();save();}}>
        {revision&&<section id="development-revision" tabIndex={-1} className="dx-doc-card development-revision">{linkedComment&&linkedComment.evidenceRefs.length>0&&
          <ul aria-label="已带出的原客户意见附件">{linkedComment.evidenceRefs.map((id,index)=><li key={id}>
            <a href={urls.apiUrl(`digital-production/sources/${linkedComment.ref.sourceId}/development/attachments/${id}`)}>原意见附件 {index+1}</a>
          </li>)}</ul>}
          <DevelopmentRevisionFields value={revision} disabled={busy||pendingRevision} {...(directEdit?{sourceId}:{})} onChange={value=>{setRevision(value);setDirty(true);}}/>
          {publishCurrent&&sheet.independentRevisions&&revision.origin!=='内部发现'&&revision.outputKind==='整件样板'&&
            <DevelopmentPatternLink busy={busy||pendingRevision} preparing selectedCategoryId={document.patternCategoryId??''}
              onCategoryChange={categoryId=>edit({patternCategoryId:categoryId||null})} onSelection={setPatternChoice}/>}
         </section>}
        <DevelopmentDocumentFields designerInput={directEdit&&!readonly} fixedCraft={sheet.timelineSchemaVersion===2} materialFactsReadonly={directEdit||Boolean(sheet.materialForecastOnly)} {...((embedded||contained)?{attachmentPageSize:6}:{})} key={`${sourceId}:${revision?`revision-${revision.basedOnRound}`:"initial"}`} templateResetKey={revision?draftVersion:sheet.version} document={document} edit={edit} readonly={readonly} busy={busy} writing={writing} sizeQuantityInputs={sizeQuantityInputs} setSizeQuantityInputs={setSizeQuantityInputs} quantityInput={quantityInput} setQuantityInput={setQuantityInput} measurementIds={measurementIds} successfulUploads={successfulUploads} fileIdentity={previews.identity} metadataPath={id=>`${base}/attachments/${id}/metadata`} imageUrl={imageUrl} upload={upload} fileKind={fileKind} setFileKind={setFileKind} issue={issue} patternSection={sheet.status==="draft"&&!revision&&sheet.canEdit?<div id="development-pattern-preparation"><DevelopmentPatternLink busy={busy} preparing onSelection={setPatternChoice}/></div>:null}/>
      </form>
      {sheet.status==="published"&&<DevelopmentAmendmentHistory key={`${sheet.sourceId}:${sheet.roundNumber}:${sheet.version}`} sheet={sheet}/>}
      {sheet.status==="published"&&!embedded&&!directEdit&&!revision&&(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)&&<ProductionReadinessPanel resource={{kind:"source",id:sourceId}} sourceDocumentVersion={sheet.version}/>}
      {sheet.status==="published"&&<DocumentSection id="development-handling" title="办理记录">
        {sheet.status==="published"&&<div className="development-round-controls"><label>查看轮次<select aria-label="查看轮次" disabled={busy||embedded||Boolean(revision)} value={sheet.roundNumber??1} onChange={async event=>{if(embedded)return;const round=Number(event.target.value);if((!dirty||await confirmInApp("有未保存修改，确定切换轮次？"))&&!writing.current){setSelectedRound(round);const url=new URL(window.location.href);url.searchParams.set("round",String(round));window.history.replaceState(window.history.state,"",url);onVersionChange?.(round);}}}><option value={1}>第1轮 · 原始开发</option>{rounds.rounds.map(round=><option key={round.roundNumber} value={round.roundNumber}>第{round.roundNumber}轮 · {round.origin}</option>)}</select></label>{!directEdit&&!embedded&&sheet.canRevise&&!revision&&<Button disabled={busy} onClick={beginRevision}>{rounds.draft?"继续复版草稿":"发起实际修改 / 复版"}</Button>}
          {rounds.rounds.filter(round=>round.roundNumber===(sheet.roundNumber??1)).map(round=><div key={round.roundNumber}><p>{round.origin} · {round.customerComment||round.internalProblem}</p><p>{round.explanation}</p><p>重做：{round.affectedNodes.join("、")}</p><p>沿用 {Object.keys(round.inherited).length} 项已完成记录</p><ul>{Object.entries(round.inherited).map(([node,reference])=><li key={node}><a href={productionWorkspaceDomainHref(`${urls.pageUrl("ui/digital-production")}?task=${reference.taskId}&taskView=read`,window.location.search)}>{inheritedLabels[node]??"已完成节点"} · 第{reference.roundNumber}轮原记录</a></li>)}</ul></div>)}
        </div>}
        {!contained&&sheet.status==="published"&&!revision&&(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)&&<DevelopmentExecutionPanel key={sheet.roundNumber??1} sourceId={sourceId} materialRevision={sheet.materialEvents.length}/>}
        {!embedded&&sheet.status==="published"&&!revision&&<section className="development-material-events"><h3>本轮物料记录</h3>{document.materials.filter(item=>sheet.materialReadiness?.find(row=>row.materialId===item.materialId)?.required??item.requiredThisRound).map(item=>{
          const events=sheet.materialEvents.filter(event=>event.materialId===item.materialId);
          const expectedDate=events.filter(event=>event.action==='修改预计日期').at(-1)?.expectedDate??item.expectedDate;
          const onSubmit=(input:DevelopmentMaterialEvent)=>run(`${base}/materials/${item.materialId}/events`,input);
          return <div key={item.materialId} id={`material-${item.materialId}`}><h4>{item.name||item.label}</h4><p>{item.category}{item.label&&item.label!==item.name?` · ${item.label}`:''} · {item.specification||'规格未登记'} · {item.quantity||'数量未登记'}</p><p>{item.available?"发布时已有实物":"发布时未到"} · 原预计：{item.expectedDate??"未定"}</p>{events.map(event=><p key={event.eventId}>{event.action} · {event.expectedDate??""} · {event.note} · {event.action==='修改预计日期'?'':event.occurredAt?`实际：${new Date(event.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · `:event.occurredDate?`实际：${event.occurredDate} · `:'实际时间未登记 · '}登记：{new Date(event.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</p>)}
            {sheet.canEdit&&(directEdit||sheet.materialForecastOnly?item.category==='辅料'&&(sheet.materialForecastBlocked?<p>{sheet.materialForecastBlocked}</p>:<DevelopmentAccessoryForecastForm busy={busy} round={sheet.roundNumber??1} version={sheet.version} revision={events.length} expectedDate={expectedDate} onSubmit={onSubmit}/>)
              :<DevelopmentMaterialEventForm accessory={item.category==='辅料'} busy={busy} revision={events.length} version={sheet.version} onSubmit={input=>{void onSubmit(input);}}/>)}
          </div>;
        })}</section>}
      </DocumentSection>}
    </>}
  </section></Surface>;
}
