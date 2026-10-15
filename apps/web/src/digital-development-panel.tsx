import {useDocumentUploadPreviews} from "./document-upload-previews.js";
import { ResumeDevelopmentCreateForm } from "./digital-development-create-form.js";
import { DevelopmentDocumentFields } from "./development-document-fields.js";
import { useDigitalDetailNavigationGuard } from "./use-digital-detail-navigation-guard.js";
import {DevelopmentRevisionFields,type RevisionFields} from "./development-revision-fields.js";
import type {DevelopmentRevision} from "@dx-rework/contracts/digital-development-rounds";
import {DevelopmentPatternLink,type DevelopmentPatternChoice} from "./development-pattern-link.js";
import { DevelopmentExecutionPanel } from "./digital-development-execution-panel.js";
import { confirmInApp } from "./system-dialog.js";
import { DevelopmentPrint } from "./digital-development-print.js";
import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { type DevelopmentDocument, type DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { initialDevelopmentDocument } from "./digital-development-editing.js";
import { uploadDevelopmentMaterial } from "./digital-development-upload.js";
import { digitalRequest } from "./digital-production-api.js";
import { createClientRequestId } from "./client-request-id.js";
import { sha256Hex } from "./attachment-upload.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development.css";
import { DocumentToolbar, DocumentErrors, DocumentSection } from "./document-editor.js";
import { developmentIssues } from "./digital-development-validation.js";
const urls = createWebUrls(import.meta.env.BASE_URL);
const initial = initialDevelopmentDocument;
const inheritedLabels:Record<string,string>={development_materials:"核配",development_pattern:"纸样",development_cutting:"裁板",development_printing:"印花",development_embroidery:"绣花",development_print_embroidery:"印绣花",development_craft_confirmation:"工艺确认",development_sewing:"车板",development_washing:"洗水",development_tail_check:"尾查",development_confirmation:"最终设计确认",development_shipping:"寄样",development_craft_dispatch:"发工艺",development_sewing_transfer:"转交车板",development_washing_dispatch:"送洗"};
type RoundHistory={roundNumber:number;origin:string;customerComment:string;internalProblem:string;explanation:string;affectedNodes:string[];inherited:Record<string,{taskId:string;roundNumber:number}>};
type Rounds={rounds:RoundHistory[];draft:{version:number;payload:DevelopmentRevision}|null};
export function DigitalDevelopmentPanel({sourceId,onClose,initialRound,embedded=false,contained=false}:{sourceId:string;onClose:()=>void;initialRound?:number|undefined;contained?:boolean;embedded?:boolean}) {
  const previews=useDocumentUploadPreviews();
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
  const [quantityInput,setQuantityInput]=useState(""),[validationMode,setValidationMode]=useState<"save"|"publish"|null>(null);
  const measurementIds=useRef<string[]>([]),successfulUploads=useRef(new Map<string,string>());
  const installDocument=(value:DevelopmentDocument)=>{setDocument(value);setQuantityInput(value.quantity===null?"":String(value.quantity));measurementIds.current=value.measurements.map(()=>createClientRequestId());setValidationMode(null);};
  if(measurementIds.current.length!==document.measurements.length)measurementIds.current=document.measurements.map((_,index)=>measurementIds.current[index]??createClientRequestId());
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);
  const [revision,setRevision]=useState<RevisionFields|null>(null),[draftVersion,setDraftVersion]=useState(0),[rounds,setRounds]=useState<Rounds>({rounds:[],draft:null}),[selectedRound,setSelectedRound]=useState<number|undefined>(initialRound);
  const [fileKind,setFileKind]=useState<DevelopmentDocument["files"][number]["kind"]>("款图");
  const writing=useRef(false),operation=useRef<{payload:string;key:string}|null>(null);
  useDigitalDetailNavigationGuard(dirty, busy, writing, "有未保存修改，确定离开？");
  const base=`sources/${sourceId}/development`;
  useEffect(()=>{let live=true;void digitalRequest<DevelopmentSheet>(`${base}${selectedRound?`?round=${selectedRound}`:""}`).then(value=>{if(live){setSheet(value);installDocument(value.document??initial());setDirty(false);setError("");if(value.status==="published")void digitalRequest<Rounds>(`${base}/rounds`).then(data=>{if(live)setRounds(data);}).catch(reason=>{if(live)setError(reason.message);});}}).catch(reason=>{if(live)setError(reason.message);});return()=>{live=false;};},[sourceId,selectedRound]);
  const edit=(patch:Partial<DevelopmentDocument>)=>{setDocument(current=>({...current,...patch}));setDirty(true);};
  const run=async(path:string,body:unknown,method="POST")=>{
    if(writing.current)return;writing.current=true;setBusy(true);setError("");
    const payload=JSON.stringify([path,body,method]);if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
    try{const value=await digitalRequest<DevelopmentSheet>(path,method,body,operation.current.key);setSheet(value);installDocument(value.document??initial());setDirty(false);previews.saved();operation.current=null;}
    catch(reason){setError(reason instanceof Error?reason.message:"操作失败");}finally{writing.current=false;setBusy(false);}
  };
  const beginRevision=()=>{
    const draft=rounds.draft;installDocument(draft?.payload.document??sheet!.document!);
    setRevision(draft?{...draft.payload}:{basedOnRound:sheet!.latestRoundNumber??1,origin:"客户新增要求",customerComment:"",internalProblem:"",explanation:`参考第${sheet!.roundNumber??1}轮资料`,categories:["其他"],affectedNodes:["车板"],outputKind:"整件样板"});
    setDraftVersion(draft?.version??0);setDirty(!draft);
  };
  const revisionAction=async(publish:boolean)=>{
    if(!revision||writing.current)return;writing.current=true;setBusy(true);setError("");
    const body=publish?{expectedDraftVersion:draftVersion,basedOnRound:revision.basedOnRound}:{expectedDraftVersion:draftVersion,revision:{...revision,document}};
    const path=`${base}/${publish?"round-publish":"round-draft"}`,payload=JSON.stringify([path,body]);if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
    try{const response=await digitalRequest<{draftVersion?:number}>(path,publish?"POST":"PUT",body,operation.current.key);operation.current=null;setDirty(false);previews.saved();
      if(publish){const next=await digitalRequest<DevelopmentSheet>(base);setSheet(next);installDocument(next.document!);setRevision(null);setSelectedRound(next.roundNumber);const url=new URL(window.location.href);url.searchParams.set("round",String(next.roundNumber??1));window.history.replaceState(null,"",url);setRounds(await digitalRequest<Rounds>(`${base}/rounds`));}
      else{setDraftVersion(response.draftVersion!);const refreshed=await digitalRequest<Rounds>(`${base}/rounds`);setRounds(refreshed);if(refreshed.draft)installDocument(refreshed.draft.payload.document);}
    }catch(reason){setError(reason instanceof Error?reason.message:"复版操作失败");}finally{writing.current=false;setBusy(false);}
  };
  const upload=async(files:File[])=>{
    if(!files?.length||writing.current)return;previews.start(files);writing.current=true;setBusy(true);setError("");
    try{
      let fileCount=document.files.length;
      const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
      for(const file of Array.from(files)){try{
        if(file.size>limits.maxUploadBytes)throw Error(`${file.name}超过上传大小限制`);
        const hash=await sha256Hex(file),fingerprint=JSON.stringify([fileKind,file.name,file.size,hash]);
        if(successfulUploads.current.has(fingerprint)){previews.uploaded(file,successfulUploads.current.get(fingerprint)!);continue;}
        if(fileCount>=30)throw Error("开发单最多30个附件");
        const attachmentId=await uploadDevelopmentMaterial(base,file,fileKind,limits.maxUploadBytes);
        previews.uploaded(file,attachmentId);successfulUploads.current.set(fingerprint,attachmentId);fileCount++;
        setDocument(current=>({...current,files:[...current.files,{attachmentId,kind:fileKind}]}));setDirty(true);
      }catch(reason){const message=reason instanceof Error?reason.message:"上传失败";previews.failed(file,message);setError(message);}}
    }catch(reason){const message=reason instanceof Error?reason.message:"上传失败";for(const file of files)previews.failed(file,message);setError(message);}finally{writing.current=false;setBusy(false);}
  };
  const readonly=embedded|| (revision?!sheet?.canRevise:!sheet?.canEdit||sheet.status==="published");
  const imageUrl=(id:string)=>previews.url(id,urls.apiUrl(`digital-production/${base}/attachments/${id}`));
  const issues=validationMode?developmentIssues(document,quantityInput,measurementIds.current,validationMode==="publish",revision):[];
  const issue=(id:string)=>issues.find(value=>value.id===id)?.message;
  const validate=(publish=false)=>{setValidationMode(publish?"publish":"save");return developmentIssues(document,quantityInput,measurementIds.current,publish,revision).length===0;};
  const save=()=>{if(!validate())return;if(revision)void revisionAction(false);else void run(base,{expectedVersion:sheet!.version,document},"PUT");};
  const publish=()=>{if(!validate(true))return;if(dirty){setError("请先保存当前修改");return;}if(revision)void revisionAction(true);else{if(!patternChoice){setError("请先选择有效打板品类与执行价，再正式提交开发单");window.document.getElementById("development-pattern-preparation")?.scrollIntoView({block:"center"});return;}void run(`${base}/publish`,{expectedVersion:sheet!.version,patternOrder:patternChoice});}};
  const reload=async()=>{if(writing.current||dirty&&!await confirmInApp("重新载入将丢弃未保存修改，确定继续？"))return;setBusy(true);try{const value=await digitalRequest<DevelopmentSheet>(`${base}${selectedRound?`?round=${selectedRound}`:""}`);setSheet(value);installDocument(value.document??initial());setRevision(null);setDirty(false);setError("");if(value.status==="published")setRounds(await digitalRequest<Rounds>(`${base}/rounds`));}catch(reason){setError(reason instanceof Error?reason.message:"读取失败");}finally{setBusy(false);}};
  const savedPrint=revision?rounds.draft?.payload.document:sheet?.document;
  if(!embedded&&sheet?.canEdit&&!revision&&(sheet.status==="draft"||(!showPublishedDocument&&sheet.document?.customerOrderDraft?.withOrder&&!sheet.productionOrderId)))return <ResumeDevelopmentCreateForm contained={contained} key={`${sheet.sourceId}:${sheet.version}`} sheet={sheet} onClose={onClose} onCreated={()=>void reload()} onViewPublished={()=>setShowPublishedDocument(true)}/>;
  return <Surface><section className="development-editor dx-doc-development">
    <DocumentToolbar title={sheet?`开发单 · ${sheet.designStyleNo}`:"开发单"} status={busy?"保存中":error&&dirty?"没有保存成功，修改还在":dirty?"未保存修改":`${revision?`第${revision.basedOnRound+1}轮复版草稿`:sheet?.status==="published"?`已发布 · 第${sheet.roundNumber??1}轮${(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)?" · 当前有效轮次":" · 历史轮次"}`:"草稿"} · 版本 ${revision?draftVersion:sheet?.version??0}`}>
      {!embedded&&!contained&&<Button disabled={busy} onClick={onClose}>返回</Button>}
      {!readonly&&<><Button disabled={busy} onClick={save}>保存草稿</Button><Button variant="primary" disabled={busy} onClick={publish}>{revision?"正式发布本轮修改":"发布开发单"}</Button></>}
      <Button disabled={!savedPrint||dirty||busy} onClick={()=>window.print()}>打印 / 保存 PDF</Button>
    </DocumentToolbar>
    {previews.view}<DocumentErrors issues={issues} error={error}/>{error&&<Button disabled={busy} onClick={()=>void reload()}>重新载入</Button>}
    {!sheet&&<p>正在读取开发单</p>}
    {sheet&&<>
      {dirty||busy||!savedPrint?<article className="development-print"><p>当前单据不可打印，请先保存当前修改。</p></article>:<DevelopmentPrint sheet={revision?{...sheet,status:"draft",roundNumber:revision.basedOnRound+1,version:draftVersion}:sheet} document={savedPrint} imageUrl={imageUrl}/>}
      <div className="development-heading dx-doc-card"><span>款号：<strong>{sheet.designStyleNo}</strong></span><span>代用号：{sheet.temporaryStyleNo??"—"}</span><span>客户：{sheet.customerCode??"通用开发"}</span><span>设计师：{sheet.designerName}</span><span>{sheet.developmentType} · 第{revision?revision.basedOnRound+1:sheet.roundNumber??1}轮 · 资料版本 {revision?draftVersion:sheet.version}</span></div>


      <form onSubmit={event=>{event.preventDefault();save();}}>
        {revision&&<section id="development-revision" tabIndex={-1} className="dx-doc-card development-revision"><DevelopmentRevisionFields value={revision} disabled={busy} onChange={value=>{setRevision(value);setDirty(true);}}/></section>}
        <DevelopmentDocumentFields {...((embedded||contained)?{attachmentPageSize:6}:{})} key={`${sourceId}:${revision?`revision-${revision.basedOnRound}`:"initial"}`} templateResetKey={revision?draftVersion:sheet.version} document={document} edit={edit} readonly={readonly} busy={busy} writing={writing} quantityInput={quantityInput} setQuantityInput={setQuantityInput} measurementIds={measurementIds} successfulUploads={successfulUploads} imageUrl={imageUrl} upload={upload} fileKind={fileKind} setFileKind={setFileKind} issue={issue} patternSection={sheet.status==="draft"&&!revision&&sheet.canEdit?<div id="development-pattern-preparation"><DevelopmentPatternLink busy={busy} preparing onSelection={setPatternChoice}/></div>:null}/>
      </form>
      {sheet.status==="published"&&<DocumentSection id="development-handling" title="办理记录">
        {sheet.status==="published"&&<div className="development-round-controls"><label>查看轮次<select aria-label="查看轮次" disabled={busy||embedded||Boolean(revision)} value={sheet.roundNumber??1} onChange={async event=>{if(embedded)return;const round=Number(event.target.value);if((!dirty||await confirmInApp("有未保存修改，确定切换轮次？"))&&!writing.current){setSelectedRound(round);const url=new URL(window.location.href);url.searchParams.set("round",String(round));window.history.replaceState(null,"",url);}}}><option value={1}>第1轮 · 原始开发</option>{rounds.rounds.map(round=><option key={round.roundNumber} value={round.roundNumber}>第{round.roundNumber}轮 · {round.origin}</option>)}</select></label>{!embedded&&sheet.canRevise&&!revision&&<Button disabled={busy} onClick={beginRevision}>{rounds.draft?"继续复版草稿":"发起实际修改 / 复版"}</Button>}
          {rounds.rounds.filter(round=>round.roundNumber===(sheet.roundNumber??1)).map(round=><div key={round.roundNumber}><p>{round.origin} · {round.customerComment||round.internalProblem}</p><p>{round.explanation}</p><p>重做：{round.affectedNodes.join("、")}</p><p>沿用 {Object.keys(round.inherited).length} 项已完成记录</p><ul>{Object.entries(round.inherited).map(([node,reference])=><li key={node}><a href={`${urls.pageUrl("ui/digital-production")}?task=${reference.taskId}`}>{inheritedLabels[node]??"已完成节点"} · 第{reference.roundNumber}轮原记录</a></li>)}</ul></div>)}
        </div>}
        {!contained&&sheet.status==="published"&&!revision&&(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)&&<DevelopmentExecutionPanel key={sheet.roundNumber??1} sourceId={sourceId} materialRevision={sheet.materialEvents.length}/>}
        {!embedded&&sheet.status==="published"&&!revision&&<section className="development-material-events"><h3>本轮物料记录</h3>{document.materials.filter(item=>item.requiredThisRound).map(item=><div key={item.materialId} id={`material-${item.materialId}`}><h4>{item.label||item.name}</h4><p>{item.available?"发布时已有实物":"发布时未到"} · 原预计：{item.expectedDate??"未定"}</p>{sheet.materialEvents.filter(event=>event.materialId===item.materialId).map(event=><p key={event.eventId}>{event.action} · {event.expectedDate??""} · {event.note} · {new Date(event.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</p>)}
          {!embedded&&sheet.canEdit&&<form onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void run(`${base}/materials/${item.materialId}/events`,{expectedMaterialRevision:sheet.materialEvents.filter(event=>event.materialId===item.materialId).length,expectedVersion:sheet.version,action:form.get("action"),expectedDate:form.get("date")||null,note:form.get("note")});}}><fieldset disabled={busy}><label>操作<select name="action"><option>到货</option><option>修改预计日期</option>{item.category==="辅料"&&<option>确认代用</option>}</select></label><label>预计日期<input type="date" name="date"/></label><label>说明<input name="note" maxLength={1000}/></label><Button type="submit">确认记录</Button></fieldset></form>}
        </div>)}</section>}
      </DocumentSection>}
    </>}
  </section></Surface>;
}
