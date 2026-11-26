import {IndependentCraftField} from './independent-craft-field.js';
import {useInstructionRecovery} from './use-instruction-recovery.js';
import {instructionEnvelopeRequestBody,type InstructionRecoveryEnvelope} from './instruction-recovery-state.js';
import {registerSessionInvalidator} from './auth-session.js';
import {useOrderTimeApplication} from './order-time-application.js';
import {PreparationWindows} from './production-readiness-panel.js';
import {uploadAttachmentWithRecovery} from "./attachment-upload-recovery.js";
import {instructionFeedbackProjection} from './document-feedback-projections.js';
import {instructionCommandMatches} from './command-receipt-content.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import {instructionActionReceipt} from "./digital-operation-feedback.js";
import {useDocumentUploadPreviews} from "./document-upload-previews.js";
import { customerPoDateLabel } from "./digital-workspace-copy.js";
import { InstructionSourceReviewPanel } from "./instruction-source-review.js";
import { PoCustomerDates } from "./po-customer-dates.js";
import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { MATERIAL_COUNT_TERM, instructionSourceLabels, type InstructionDocument, type InstructionSheet } from "@dx-rework/contracts/production-instruction";
import {DigitalRequestError, digitalRequest } from "./digital-production-api.js";
import { createClientRequestId } from "./client-request-id.js";
import { sha256Hex } from "./attachment-upload.js";
import { useDigitalDetailNavigationGuard } from "./use-digital-detail-navigation-guard.js";
import { alertInApp, confirmInApp } from "./system-dialog.js";
import { DocumentTableScroll, DocumentToolbar, DocumentField, DocumentSection, DocumentAddRow } from "./document-editor.js";
import { ProductionInstructionPrint } from "./production-instruction-print.js";
import { instructionTabs, instructionLabels, instructionAccessoryLabels, instructionIssues, type InstructionTab } from "./production-instruction-validation.js";
import { createWebUrls } from "../url-contract.js";
import "./production-instruction.css";
const urls = createWebUrls(import.meta.env.BASE_URL);
const kinds = ["款图", "主唛", "腰卡", "吊牌", "洗水唛", "二维码唛", "包装辅料", "其它工艺"] as const;
const tabKeys = Object.keys(instructionTabs) as InstructionTab[];


export async function instructionRequest(path:string,method='GET',body?:unknown,key?:string,before?:InstructionSheet):Promise<InstructionSheet>{
 const value=await digitalRequest<InstructionSheet>(path,method,body,key),orderId=path.match(/^orders\/([^/]+)\/instruction/)?.[1];
 const valid=instructionFeedbackProjection.safeParse(value).success&&value.order.productionOrderId===orderId
  &&(method==='GET'||Boolean(before&&instructionCommandMatches(value,before,path.slice(`orders/${orderId}/instruction`.length),method,body)));
 if(!valid)throw new DigitalRequestError(method==='GET'?'制单资料尚未取得完整回执，请重新读取':'原制单提交结果尚未确认，请保留输入并核对原提交',200,'INVALID_RESPONSE');
 return value;
}
export function ProductionInstructionPanel({ orderId, initialVersion, onClose, embedded=false,contained=false,onVersionChange,originalSnapshot }: { originalSnapshot?:InstructionSheet|undefined;orderId: string; initialVersion?: number | undefined; onClose: () => void; onVersionChange?:((version:number|undefined)=>void)|undefined; contained?:boolean;embedded?:boolean }) {
  const previews=useDocumentUploadPreviews({onFailureRemoved:message=>setError(current=>current===message?'':current)});
  const [sheet, setSheet] = useState<InstructionSheet | null>(null), [doc, setDoc] = useState<InstructionDocument | null>(null), [version, setVersion] = useState<number | undefined>(initialVersion);
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState("");
  const [sourceReviewOpen,setSourceReviewOpen]=useState(false);
  const [receipt,setReceipt]=useState("");
  const [tab, setTab] = useState<InstructionTab>("main");
  const [validationMode, setValidationMode] = useState<"save" | "publish" | null>(null), [saveBlocked, setSaveBlocked] = useState(false), [confirming, setConfirming] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null), [reloadCount, setReloadCount] = useState(0), [uploadKind, setUploadKind] = useState<typeof kinds[number]>("款图");
  const writing = useRef(false), operation = useRef<{ payload: string; key: string } | null>(null), generation = useRef(0), successfulUploads = useRef(new Map<string, string>());
  const recovery=useInstructionRecovery(orderId),docRef=useRef(doc);docRef.current=doc;
  const [readRequired,setReadRequired]=useState(false);
  const timeApplication=useOrderTimeApplication(()=>setDirty(false));
  const checkingPublication=useRef<symbol|null>(null),[publicationForecast,setPublicationForecast]=useState('');
  const submission=useRef(new SubmissionAttempt()),contextVersion=useRef(0);const [uncertain,setUncertain]=useState(false);
  useDigitalDetailNavigationGuard(dirty||uncertain, busy, writing, uncertain?"原提交结果尚未确认，离开不会撤销提交；原标识保留在本页恢复资料中，请勿另提。仍要离开？":"仍有未保存修改，确定返回？");
  const base = `orders/${orderId}/instruction`;
  useEffect(() => {
    let live = true;previews.reset();writing.current=false;checkingPublication.current=null;contextVersion.current++;recovery.mask();submission.current=new SubmissionAttempt();setUncertain(false); setReceipt(""); setSheet(null); setDoc(null);docRef.current=null; setError("");setPublicationForecast(''); setBusy(true);setReadRequired(false);
    void (originalSnapshot?Promise.resolve(originalSnapshot):instructionRequest(base + (version ? `?version=${version}` : ""))).then(async value => {
      if(!live)return;const restored=await recovery.load(value,!embedded&&!version);if(!live)return;
      setSheet(value);setDoc(restored.document);docRef.current=restored.document;generation.current=restored.generation;setDirty(restored.dirty);setUncertain(restored.pending);setReceipt(restored.receipt??'');setSaveBlocked(false);setValidationMode(null);setSourceReviewOpen(false);operation.current=null;successfulUploads.current.clear();
    }).catch(async e => {
      if(!live)return;setError(e.message);
      if(!embedded&&!version)try{const saved=await recovery.loadUnavailable();if(live){setDirty(saved.dirty);setUncertain(saved.pending);setReceipt(saved.receipt);}}catch{/* No current object-read proof: leave stored bytes intact and private. */}
    }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [base, version, reloadCount,originalSnapshot]);
  useEffect(()=>registerSessionInvalidator(()=>{contextVersion.current++;recovery.mask();setSheet(null);setDoc(null);docRef.current=null;setReloadCount(value=>value+1);}),[]);
  useEffect(() => {
    if (!focusId) return;
    const frame = window.requestAnimationFrame(() => { const target = document.getElementById(focusId); if (target) { if (!/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName)) target.tabIndex = -1; target.scrollIntoView({ block: "center" }); target.focus(); setFocusId(null); } });
    return () => window.cancelAnimationFrame(frame);
  }, [focusId, tab, doc]);
  useEffect(() => {
    const beforePrint = () => { if (!sheet?.isPublishedSnapshot || dirty || busy) void alertInApp("请先保存当前修改，并打开已发布版本后打印。"); };
    window.addEventListener("beforeprint", beforePrint); return () => window.removeEventListener("beforeprint", beforePrint);
  }, [sheet, dirty, busy]);
  const remember=(document:InstructionDocument)=>{
    docRef.current=document;setDoc(document);setDirty(true);
    if(sheet)try{recovery.edit(document,sheet,generation.current);}catch(reason){setError(reason instanceof Error?reason.message:'修改保留在当前页面，恢复资料未能保存');}
  };
  const change = (patch: Partial<InstructionDocument>) => {if(originalSnapshot||uncertain||!docRef.current)return;setReceipt("");generation.current++;if(!saveBlocked)setError("");remember({...docRef.current,...patch});};
  const recoverCommand=async(kind:'save'|'decision')=>{
    if(writing.current)return false;const context=contextVersion.current;writing.current=true;setBusy(true);setError('');
    try{
      if(!await recovery.check(kind)||context!==contextVersion.current)return false;
      submission.current.markConfirmed();setUncertain(recovery.hasUnresolved);setReceipt(kind==='save'?'原制单保存已确认成功。':'原客户交期决定已确认成功。');setReadRequired(true);
      if(!recovery.hasDraft){setDirty(false);previews.saved();}
      try{const latest=await instructionRequest(base);if(context===contextVersion.current){setSheet(latest);recovery.observe(latest);if(!recovery.hasDraft){setDoc(latest.document);docRef.current=latest.document;}setReadRequired(false);}}
      catch(error){if(context===contextVersion.current){if(error instanceof DigitalRequestError&&[401,403,404].includes(error.status??0)){recovery.mask();setSheet(null);setDoc(null);docRef.current=null;}setError('原提交已确认成功，最新资料尚未读取；原草稿仍保留。'+(error instanceof Error?error.message:''));}}
      return true;
    }catch(error){if(context===contextVersion.current){if(error instanceof DigitalRequestError&&[401,403,404].includes(error.status??0)){recovery.mask();setSheet(null);setDoc(null);docRef.current=null;}setError(error instanceof Error?error.message:'原提交回执尚未取得，原输入和标识保留');}return false;}
    finally{if(context===contextVersion.current){writing.current=false;setBusy(false);}}
  };
  const act = async (path:string,method:string,body:unknown,recover=false,manualSave=false,onTimeRequired?:()=>void) => {
    if(originalSnapshot)return false;
    if(recover&&(recovery.savePending||recovery.decisionPending))return recoverCommand(recovery.savePending?'save':'decision');
    if(writing.current||uncertain&&!recover||!recover&&(readRequired||recovery.blocked||recovery.conflict||!recovery.ready))return false;
    writing.current=true;setBusy(true);setSaving(path===''&&method==='PUT');setError('');setReceipt('');
    const payload=JSON.stringify([path,body]);if(!recover&&operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
    const editGeneration=generation.current,context=contextVersion.current,attempt=submission.current,originalKey=operation.current?.key;
    let envelope:InstructionRecoveryEnvelope|null=null;
    try{if(!recover)envelope=await recovery.begin(path,method,body,editGeneration,originalKey!,sheet!,manualSave);}catch(error){writing.current=false;setBusy(false);setSaving(false);setError(error instanceof Error?error.message:'原恢复资料未保存，尚未提交');return false;}
    const submittedBody=envelope?instructionEnvelopeRequestBody(envelope):body;
    const execute=async()=>{try{
      const value=await instructionRequest(base+path,method,submittedBody,originalKey,sheet??undefined);if(context!==contextVersion.current)return;
      if(envelope)try{await recovery.confirmed(envelope,value);}catch(error){throw new DigitalRequestError(error instanceof Error?error.message:'原提交回执尚未匹配',200,'INVALID_RESPONSE');}
      attempt.markConfirmed();if(path==='/source-review')recovery.clearSavedDraft(editGeneration);setUncertain(recovery.hasUnresolved);setSheet(value);recovery.observe(value);if(editGeneration===generation.current){setDoc(value.document);docRef.current=value.document;setDirty(false);previews.saved();}setSaveBlocked(false);setValidationMode(null);operation.current=null;setReceipt(instructionActionReceipt(path,method,value));
    }catch(error){if(error instanceof DigitalRequestError&&!error.resultUnknown){if(envelope&&!recover)recovery.rejected(envelope);
      if(!recover&&context===contextVersion.current&&path==='/publish'&&error.status===409&&error.code==='ORDER_TIME_REQUEST_REQUIRED')onTimeRequired?.();
      throw new SubmissionRequestError(error.message,error.code,error.status??500);}throw error;}};
    try{const result=recover?await attempt.retry():await attempt.run(execute);if(context!==contextVersion.current)return false;
      if(result.kind==='failure'){setError(result.failure.message+(result.uncertain?'；原制单结果待确认，请使用原内容核对，不要改后另提。':''));setUncertain(result.uncertain);setSaveBlocked(true);return false;}
      if(result.kind==='expired'){setError('原制单提交已超过安全恢复期限，请在原版本历史核对，不再重发。');return false;}return result.kind==='success';
    }finally{if(context===contextVersion.current){writing.current=false;setBusy(false);setSaving(false);}}
  };
  const save = (manual=false) => {
    if (!sheet?.canEdit || sheet.cutStarted || !doc || writing.current||uncertain||readRequired||recovery.blocked||recovery.conflict||!recovery.ready||recovery.restored&&!manual) return;
    setValidationMode("save");
    const issues = instructionIssues(doc, sheet.order);
    if (issues.length) { setError("请核对以下内容，修改尚未保存"); return; }
    void act("", "PUT", { expectedVersion: sheet.version, orderVersion: sheet.order.version, sourceRound:sheet.sourceRound, document: doc },false,manual);
  };
  useEffect(() => {
    if (embedded || !dirty || busy || error || saveBlocked || confirming || sourceReviewOpen || !sheet?.canEdit || sheet.cutStarted || !doc||uncertain||readRequired||recovery.restored||recovery.blocked||recovery.conflict||!recovery.ready) return;
    const timer = window.setTimeout(()=>save(false), 1200); return () => window.clearTimeout(timer);
  }, [doc, dirty, busy, error, saveBlocked, confirming, sourceReviewOpen, sheet,uncertain,readRequired,recovery.restored,recovery.blocked,recovery.conflict,recovery.ready]);
  const discard = async (message: string) => {
    if (writing.current || busy) return false;
    if (!dirty) return true;
    setConfirming(true);
    try { return await confirmInApp(message) && !writing.current; } finally { setConfirming(false); }
  };
  const chooseVersion = async (next: number | undefined) => {
    if (embedded||uncertain) return;
    if (!await discard("切换版本将丢弃未保存修改，确定继续？")) return;
    try{recovery.discardDraft();}catch(error){setError(error instanceof Error?error.message:'本页草稿尚未保留');return;}
    setDirty(false); setVersion(next); setValidationMode(null);
    const url = new URL(window.location.href); if (next) url.searchParams.set("instructionVersion", String(next)); else url.searchParams.delete("instructionVersion"); window.history.replaceState(window.history.state, "", url);onVersionChange?.(next);
  };
  const reload = async () => {
    if(uncertain||readRequired){const context=contextVersion.current;try{
      const value=await instructionRequest(base);if(context===contextVersion.current){if(uncertain)setError(`当前读取到制单 v${value.version}；原提交回执仍未确认，原输入与标识保留。`);else{setSheet(value);recovery.observe(value);if(!recovery.hasDraft){setDoc(value.document);docRef.current=value.document;}setReadRequired(false);setError('');}}
    }catch(error){if(context===contextVersion.current)setError(error instanceof Error?error.message:'制单尚未读取');}return;}
    if(await discard("重新载入将丢弃未保存修改，确定继续？")){try{recovery.discardDraft();setDirty(false);setReloadCount(value=>value+1);}catch(error){setError(error instanceof Error?error.message:'恢复资料尚未保留，未重新载入');}}
  };
  const upload = async (files: File[]) => {
    if(originalSnapshot)return;
    if (uncertain||readRequired||recovery.blocked||recovery.conflict||!recovery.ready||!files.length || !doc || !sheet?.canEdit || sheet.cutStarted || writing.current) return;previews.start(files,undefined,upload);
    const uploadContext=contextVersion.current;writing.current = true; setBusy(true); setError("");
    try {
      let count = doc.images.length;
      const limits = await digitalRequest<{ maxUploadBytes: number }>(base + "/upload-limits");
      for (const file of files) {try{
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > limits.maxUploadBytes) throw Error(`${file.name}：请选择符合大小限制的 JPG、PNG、WebP 图片`);
        const hash = await sha256Hex(file), fingerprint = JSON.stringify([uploadKind, file.name, file.size, hash]);
        if (successfulUploads.current.has(fingerprint)){previews.uploaded(file,successfulUploads.current.get(fingerprint)!);continue;}
        if (count >= 60) throw Error("图片最多60张");
        const ready=await uploadAttachmentWithRecovery(file,`instruction:${base}:${version??'current'}:${uploadKind}`,{
          createIntent:input=>digitalRequest(`${base}/upload-intents`,'POST',input),
          finalize:id=>digitalRequest(`${base}/attachments/${id}/finalize`,'POST',{}),
        },hash);
        if(uploadContext!==contextVersion.current)return;const intent=ready;
        previews.uploaded(file,intent.attachmentId);successfulUploads.current.set(fingerprint, intent.attachmentId); count++; generation.current++;
        if(docRef.current)remember({...docRef.current,images:[...docRef.current.images,{attachmentId:intent.attachmentId,kind:uploadKind,description:''}]});
      }catch(reason){if(uploadContext!==contextVersion.current)return;const message=reason instanceof Error?reason.message:"上传失败";previews.failed(file,message);setError(message);}}
    } catch (e) {if(uploadContext===contextVersion.current){const message=e instanceof Error?e.message:"上传失败";for(const file of files)previews.failed(file,message);setError(message);setSaveBlocked(true);}}
    finally { if(uploadContext===contextVersion.current){writing.current = false; setBusy(false);} }
  };
  const recoveryNotice=<>{recovery.message&&<p role={recovery.blocked||recovery.conflict?'alert':'status'}>{recovery.message}</p>}{recovery.savePending&&<Button type="button" disabled={busy} onClick={()=>void recoverCommand('save')}>只读核对原制单保存结果</Button>}{recovery.decisionPending&&<Button type="button" disabled={busy} onClick={()=>void recoverCommand('decision')}>只读核对原交期决定结果</Button>}</>;
  if (!sheet || !doc||!recovery.ready) return <Surface>{receipt&&<p role="status">{receipt}</p>}{recovery.ready&&recoveryNotice}{error ? <p role="alert">{error}</p> : <p role="status">正在读取制单…</p>}{error&&<Button type="button" disabled={busy} onClick={()=>setReloadCount(value=>value+1)}>重新读取原制单</Button>}{!embedded&&!contained&&<Button onClick={onClose}>返回</Button>}</Surface>;
  if (!sheet.canEdit && !sheet.isPublishedSnapshot && sheet.publishedVersion === null) {
    return <Surface className="dx-doc-instruction"><DocumentToolbar title="大货制单" status="尚未发布有效制单">{!embedded&&!contained&&<Button onClick={onClose}>返回</Button>}</DocumentToolbar>{recoveryNotice}<DocumentSection id="instruction-unpublished" title="尚未发布有效制单"><p>该母单尚无已发布的有效制单。请联系订单跟单发布后查看。</p></DocumentSection><PoCustomerDates sheet={sheet} busy={busy||uncertain||readRequired||recovery.blocked||recovery.conflict} dirty={dirty} historical={embedded||Boolean(version)} onAct={act}/>{receipt&&!busy&&<p role="status">{receipt}</p>}{error&&<p role="alert">{error}</p>}</Surface>;
  }
  const order = sheet.order, readonly = uncertain||embedded || !sheet.canEdit || sheet.cutStarted, inputDisabled = uncertain||busy && !saving || sourceReviewOpen;
  const total = order.lines.reduce((n, line) => n + line.sizes.reduce((m, size) => m + size.quantity, 0), 0);
  const orderSizes = [...new Set(order.lines.flatMap(line => line.sizes.map(size => size.size)))];
  const issues = validationMode ? instructionIssues(doc, order, validationMode === "publish") : [];
  const imageUrl = (id: string) => urls.apiUrl(`digital-production/${base}${originalSnapshot?`/original-versions/${originalSnapshot.version}`:''}/attachments/${id}`);
  const publishedImage = (id: string) => sheet.document.images.some(image => image.attachmentId === id);
  const mainImage = doc.images.find(image => image.kind === "款图");
  const mode = sheet.isPublishedSnapshot ? `已发布制单版本 ${sheet.version}` : `制单草稿 · 版本 ${sheet.version}`;
  const status = busy ? saving ? "保存中…" : "处理中…" : uncertain?"原制单提交结果待确认，原输入已保留": dirty ? saveBlocked || error ? "保存失败，修改未保存" : "未保存修改" : mode;
  const issueText = (id: string) => issues.find(issue => issue.id === id)?.message;
  const cell = (id: string, label: string, value: string, savedValue: string, onValue: (value: string) => void, column?: string, multiline = false, maxLength = multiline ? 5000 : 200, type = "text") => <DocumentField id={id} label={label} value={value} savedValue={savedValue} savedRevision={sheet.version} onValue={onValue} readonly={readonly} disabled={inputDisabled} multiline={multiline} maxLength={maxLength} {...(column ? { column } : {})} type={type} issue={issueText(id)} />;
  const field = (key: Exclude<keyof typeof instructionLabels, "date" | "preshrink" | "secondaryCraft">, multiline = false) => <label>{instructionLabels[key]}{cell(`instruction-${key}`, instructionLabels[key], doc[key], sheet.document[key], value => change({ [key]: value }), undefined, multiline)}</label>;
  const select = (key: "preshrink" | "secondaryCraft" | "unit", label: string, options: ReadonlyArray<{ value: string; label: string }>) => <label>{label}{readonly ? <span id={`instruction-${key}`} className="dx-doc-readonly">{options.find(option => option.value === doc[key])?.label ?? doc[key]}</span> : <select id={`instruction-${key}`} aria-label={label} aria-invalid={Boolean(issueText(`instruction-${key}`))} aria-describedby={issueText(`instruction-${key}`) ? `instruction-${key}-error` : undefined} disabled={inputDisabled} value={doc[key]} onChange={event => change({ [key]: event.target.value })}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}{issueText(`instruction-${key}`) && <small className="dx-doc-field-error" id={`instruction-${key}-error`}>{issueText(`instruction-${key}`)}</small>}</label>;
  const focus = (next: InstructionTab, id: string) => { setTab(next); setFocusId(id); };
  const publish = () => {
    if (readonly || writing.current||checkingPublication.current||uncertain||readRequired||recovery.blocked||recovery.conflict) return;
    setValidationMode("publish");
    const validation = instructionIssues(doc, order, true);
    if (dirty) { setError("请先保存当前修改"); if (validation[0]) focus(validation[0].tab, validation[0].id); return; }
    if (validation.length) { setError("请核对发布所需资料"); focus(validation[0]!.tab, validation[0]!.id); return; }
    const input={ expectedVersion: sheet.version, orderVersion: order.version,...(sheet.readiness?{expectedReadinessRevision:sheet.readiness.revision}:{}) };
    const proposal={kind:'instruction_publish' as const,orderId,input},turn=Symbol(),context=contextVersion.current,edit=generation.current;
    checkingPublication.current=turn;setBusy(true);setError('');setPublicationForecast('');
    const current=()=>checkingPublication.current===turn&&contextVersion.current===context&&generation.current===edit;
    void (async()=>{
      try{
        if(sheet.orderTimeEnabled){
          try{
            const check=await timeApplication.readCheck(proposal);
            if(!current())return;
            if(check.feasibility==='unknown')setPublicationForecast(['发布前预查：本单时效暂无法确认',...check.coverage].join('；'));
          }catch(reason){if(current())setError('时效检查未返回，尚未提交；草稿保留。'+(reason instanceof Error?reason.message:''));return;}
        }
        if(!current())return;
        let rejectedForTime=false;
        const success=await act('/publish','POST',input,false,false,()=>{rejectedForTime=true;});
        if(!success&&rejectedForTime&&current()){
          setPublicationForecast('');
          if(!await timeApplication.checkInstructionShortage(proposal,current)&&current())setError('发布未被接受，当前时效已变化；草稿保留，请重新核对后发布。');
        }
      }catch(reason){if(current())setError('制单草稿保留；请重新读取本单时效。'+(reason instanceof Error?reason.message:''));}
      finally{if(checkingPublication.current===turn){checkingPublication.current=null;if(contextVersion.current===context)setBusy(false);}}
    })();
  };
  const remove = async (message: string, nonempty: boolean, action: () => void) => {
    if (inputDisabled) return;
    if (!nonempty) { action(); return; }
    setConfirming(true);
    try { if (await confirmInApp(message) && !writing.current) action(); } finally { setConfirming(false); }
  };
  const accessory = (group: "车缝" | "包装") => {
    const key = group === "车缝" ? "sewing" : "packaging";
    return <DocumentSection id={`instruction-${key}`} title={`${group}辅料`} detail={`两类辅料合计 ${doc.accessories.length} / 400 行`}>
      <DocumentTableScroll><table className="instruction-accessory-table"><thead><tr>{Object.values(instructionAccessoryLabels).map(label => <th key={label}>{label}</th>)}{!readonly && <th>操作</th>}</tr></thead><tbody>{doc.accessories.filter(row => row.group === group).map(row => <tr key={row.id} data-doc-row>{(Object.keys(instructionAccessoryLabels) as Array<keyof typeof instructionAccessoryLabels>).map(field => <td key={field}>{cell(`instruction-accessory-${row.id}-${field}`, `${group} · ${row.name || "辅料"} · ${instructionAccessoryLabels[field]}`, row[field], sheet.document.accessories.find(item => item.id === row.id)?.[field] ?? "", value => change({ accessories: doc.accessories.map(item => item.id === row.id ? { ...item, [field]: value } : item) }), field, field === "remarks")}</td>)}{!readonly && <td><Button type="button" disabled={busy} onClick={() => void remove(`删除${row.name || group + "辅料"}？`, Object.values(instructionAccessoryLabels).some((_, index) => Boolean(row[(Object.keys(instructionAccessoryLabels) as Array<keyof typeof instructionAccessoryLabels>)[index]!])), () => change({ accessories: doc.accessories.filter(item => item.id !== row.id) }))}>删除</Button></td>}</tr>)}</tbody></table></DocumentTableScroll>
      {!doc.accessories.some(row => row.group === group) && <p className="instruction-empty">暂无明细</p>}
      {!readonly && <DocumentAddRow label={`添加${group}辅料`} disabled={inputDisabled || doc.accessories.length >= 400} onClick={() => { const id = createClientRequestId(); change({ accessories: [...doc.accessories, { id, group, garmentColors: order.lines.map(line => line.color).join("、"), materialColor: "", name: "", category: "", part: "", specification: "", consumption: "", remarks: "" }] }); setFocusId(`instruction-accessory-${id}-garmentColors`); }} />}
      {group === "包装" && <p className="instruction-note">{MATERIAL_COUNT_TERM}</p>}
    </DocumentSection>;
  };
  const printable = sheet.isPublishedSnapshot && !dirty && !busy;
  return <Surface><article className="dx-doc-instruction">
    {publicationForecast&&<p role="status">{publicationForecast}</p>}{timeApplication.dialog}
    <div className="instruction-screen">
      <DocumentToolbar title="大货制单" status={status}>
        {!embedded&&!contained&&<Button type="button" disabled={busy} onClick={onClose}>返回</Button>}
        {!readonly && <><Button type="button" disabled={busy||readRequired||recovery.blocked||recovery.conflict} onClick={()=>save(true)}>保存草稿</Button><Button type="button" disabled={busy||readRequired||recovery.blocked||recovery.conflict || sheet.publishedVersion === sheet.version && !dirty} onClick={publish}>发布有效制单</Button></>}
        <Button type="button" disabled={!printable} title={!printable ? "请先保存并打开已发布版本后打印" : "打印当前已发布快照的全部六类内容"} onClick={() => window.print()}>打印 / 保存 PDF</Button>
      </DocumentToolbar>
      {recoveryNotice}{uncertain&&!recovery.savePending&&!recovery.decisionPending&&<Button disabled={busy} onClick={()=>void act("","PUT",undefined,true)}>使用原内容核对制单提交</Button>}{previews.view}<header className="instruction-summary dx-doc-card">
        <div className="instruction-summary-image">{mainImage && publishedImage(mainImage.attachmentId) ? <a href={imageUrl(mainImage.attachmentId)} target="_blank" rel="noreferrer"><img src={imageUrl(mainImage.attachmentId)} alt="款图" /></a> : <span>{mainImage ? "保存后预览" : "暂无款图"}</span>}</div>
        <div className="instruction-summary-details"><h2>{order.designStyleNo}</h2><dl><div><dt>客户</dt><dd>{order.customerCode}</dd></div><div><dt>款名</dt><dd>{doc.styleName || "—"}</dd></div><div><dt>跟单</dt><dd>{sheet.merchandiserName || "待指派"}</dd></div><div><dt>类型</dt><dd>{doc.category || "—"}</dd></div><div><dt>年份季节</dt><dd>{doc.season || "—"}</dd></div><div><dt>当前{customerPoDateLabel}</dt><dd>{[...new Set((sheet.customerPoDates??[]).map(line=>line.date).filter(Boolean))].sort().join("、")||"未登记"}</dd></div></dl></div>
        <div className="instruction-po-summary"><h3>PO / 颜色概要</h3><p>{new Set(order.lines.map(line => line.poNumber).filter(Boolean)).size} 个 PO · {order.lines.length} 个款色 · 总数 <strong>{total.toLocaleString()}</strong> 件</p>{order.lines.slice(0, 2).map(line => <div key={line.lineId}><span>{line.color}{line.colorForeign ? ` / ${line.colorForeign}` : ""}</span><strong>{line.sizes.reduce((n, size) => n + size.quantity, 0).toLocaleString()} 件</strong></div>)}{order.lines.length > 2 && <button type="button" onClick={() => focus("main", "instruction-quantities")}>查看全部 {order.lines.length} 个款色</button>}</div>
      </header>
      {sheet.readiness&&!version&&!embedded&&<><PreparationWindows state={sheet.readiness}/>{sheet.readiness.finalReasons.length>0&&<p className="instruction-notice">正式发布前：{sheet.readiness.finalReasons.join("；")}。可先保存草稿。</p>}</>}{receipt&&!busy&&<p role="status">{receipt}</p>}
      {sheet.cutStarted && <p className="instruction-notice">已开裁，制单内容只读；编号补齐请使用原母单入口。</p>}
      {!readonly&&sheet.technicalSizeTable&&<Button type="button" variant="secondary" disabled={busy||inputDisabled} onClick={()=>{const table=sheet.technicalSizeTable!;change({unit:table.unit,sizes:table.sizes,measurements:table.measurements.map(row=>({id:createClientRequestId(),name:row.name,tolerance:row.tolerance,method:row.method,values:row.values}))});}}>采用当前技术尺寸表</Button>}
      {sheet.sourceRound !== sheet.latestSourceRound && <div className="instruction-notice">开发单有新资料，请核对（第 {sheet.latestSourceRound ?? "—"} 轮）。保存正文不会更新采用记录。{!readonly&&sheet.sourceComparison&&<Button type="button" disabled={busy} onClick={()=>setSourceReviewOpen(true)}>查看改变并核对</Button>}</div>}
      {sourceReviewOpen&&<InstructionSourceReviewPanel key={`${sheet.sourceComparison?.sourceRound}:${sheet.sourceComparison?.sourceVersion}`} sheet={sheet} document={doc} busy={busy} imageUrl={imageUrl} onClose={()=>setSourceReviewOpen(false)} onReview={decisions=>{const comparison=sheet.sourceComparison;if(comparison)void act("/source-review","POST",{expectedVersion:sheet.version,orderVersion:sheet.order.version,sourceRound:comparison.sourceRound,sourceVersion:comparison.sourceVersion,document:doc,decisions}).then(success=>{if(success)setSourceReviewOpen(false);});}}/>}
      {sheet.sourceReview&&<p className="instruction-note">制单版本 {sheet.sourceReview.instructionVersion} 由 {sheet.sourceReview.reviewedBy||"跟单"} 于 {new Date(sheet.sourceReview.reviewedAt).toLocaleString()} 核对开发第 {sheet.sourceReview.sourceRound} 轮：{sheet.sourceReview.decisions.map(item=>`${instructionSourceLabels[item.group]}${item.action==="retain"?"保留本单原值":"采用新开发值"}`).join("；")||"技术资料未变化"}。</p>}
      {sheet.sourceReview?.priorMeasurements&&<details className="instruction-note"><summary>单位变更前尺寸参考（{sheet.sourceReview.priorMeasurements.unit==='inch'?'英寸':'厘米'}）</summary><p>保留变更前人工尺寸和公差，供按新单位重新核对填写；本次发布使用当前尺寸表。</p>{sheet.sourceReview.priorMeasurements.measurements.map(row=><p key={row.id}>{row.name}：{row.values.map((value,index)=>`${sheet.sourceReview!.priorMeasurements!.sizes[index]??''} ${value||'空'}`).join('；')} · 公差 {row.tolerance||'未填写'} · {row.method}</p>)}</details>}

      {(error || issues.length > 0) && <div className="dx-doc-errors" role="alert"><strong>{error || "请核对以下内容"}</strong>{issues.length > 0 && <ul>{issues.map((issue, index) => <li key={`${issue.id}-${index}`}><button type="button" onClick={() => focus(issue.tab, issue.id)}>{issue.label}：{issue.message}</button></li>)}</ul>}<Button type="button" disabled={busy} onClick={() => void reload()}>重新载入最新版本</Button></div>}
      <nav className="instruction-tabs" role="tablist" aria-label="制单内容">{tabKeys.map((key, index) => <button key={key} type="button" id={`instruction-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls="instruction-tabpanel" tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={event => { const next = event.key === "ArrowRight" ? (index + 1) % tabKeys.length : event.key === "ArrowLeft" ? (index + tabKeys.length - 1) % tabKeys.length : event.key === "Home" ? 0 : event.key === "End" ? tabKeys.length - 1 : null; if (next !== null) { event.preventDefault(); const nextTab = tabKeys[next]!; setTab(nextTab); document.getElementById(`instruction-tab-${nextTab}`)?.focus(); } }}>{instructionTabs[key]}</button>)}</nav>
      <div className="instruction-document-layout"><form className="instruction-document-main" onSubmit={event => { event.preventDefault(); save(true); }}>
        <div id="instruction-tabpanel" role="tabpanel" aria-labelledby={`instruction-tab-${tab}`}>
          {tab === "main" && <>
            <DocumentSection id="instruction-quantities" title="一、PO / 颜色 / 尺码数量" detail="母单订购量，只读"><DocumentTableScroll><table className="instruction-quantity-table"><thead><tr><th>款号</th><th>客户 PO</th><th>颜色</th><th>颜色（外）</th>{orderSizes.map(size => <th className="instruction-number" key={size}>{size}</th>)}<th className="instruction-number">合计</th></tr></thead><tbody>{order.lines.map(line => <tr key={line.lineId}><td>{line.formalStyleNo || line.temporaryStyleNo || order.temporaryStyleNo || "待补正式号"}</td><td>{line.poNumber || "待补"}</td><td>{line.color}</td><td>{line.colorForeign || "—"}</td>{orderSizes.map(size => <td className="instruction-number" key={size}>{(line.sizes.find(item => item.size === size)?.quantity ?? 0).toLocaleString()}</td>)}<td className="instruction-number">{line.sizes.reduce((n, size) => n + size.quantity, 0).toLocaleString()}</td></tr>)}<tr><th colSpan={4}>合计</th>{orderSizes.map(size => <td className="instruction-number" key={size}>{order.lines.reduce((n, line) => n + (line.sizes.find(item => item.size === size)?.quantity ?? 0), 0).toLocaleString()}</td>)}<td className="instruction-number">{total.toLocaleString()}</td></tr></tbody></table></DocumentTableScroll></DocumentSection>
            <DocumentSection id="instruction-main" title="二、生产要求"><div className="instruction-form-grid">{field("styleName")}{field("category")}{field("season")}{field("fabricType")}{field("patternMaker")}<label>制单日期{cell("instruction-date", "制单日期", doc.date ?? "", sheet.document.date ?? "", value => change({ date: value || null }), undefined, false, 200, "date")}</label>{sheet.timelineSchemaVersion===2?<><label><input type="checkbox" disabled={readonly||inputDisabled} checked={doc.secondaryCraft==="沿用开发"} onChange={event=>change({secondaryCraft:event.target.checked?"沿用开发":"无",craftSteps:event.target.checked?undefined:[]})}/>沿用开发工艺</label>{doc.secondaryCraft!=="沿用开发"&&<IndependentCraftField label="大货工艺" value={doc.secondaryCraft??"无"} steps={doc.craftSteps} readonly={readonly} disabled={inputDisabled} onChange={(secondaryCraft,craftSteps)=>change({secondaryCraft,craftSteps})}/>}</>:select("secondaryCraft", "大货印绣路线", ["沿用开发", "无", "印花", "绣花", "印绣花"].map(value => ({ value, label: value })))}{select("preshrink", "预缩", ["待确认", "需要预缩", "无需预缩"].map(value => ({ value, label: value })))}</div>{field("composition", true)}{field("process", true)}{field("shipSample", true)}<p className="instruction-note">请按各 PO {version?"客户仓到货日":customerPoDateLabel}提前10个自然日寄出船样。此款接受加裁5%，请注意！！</p></DocumentSection>
            <DocumentSection id="instruction-requirements" title="三、制单说明 / 特别要求">{field("sewingRequirements", true)}{field("comments", true)}</DocumentSection>
            <DocumentSection id="instruction-related" title="四、相关表单内容"><div className="instruction-related-tabs">{tabKeys.map(key => <button type="button" key={key} onClick={() => focus(key, `instruction-${key === "main" ? "quantities" : key}`)}><strong>{instructionTabs[key]}</strong><small>{key === "main" ? "母单资料" : key === "fabrics" ? `${doc.fabrics.length} 行` : key === "images" ? `${doc.images.length} 张` : key === "measurements" ? `${doc.measurements.length} 个部位` : `${doc.accessories.filter(row => row.group === (key === "sewing" ? "车缝" : "包装")).length} 行`}</small></button>)}</div></DocumentSection>
          </>}
          {tab === "fabrics" && <DocumentSection id="instruction-fabrics" title="大货面料" detail={`${doc.fabrics.length} / 200 行 · 面料小样仅做颜色参考`}><DocumentTableScroll><table className="instruction-fabric-table"><thead><tr><th>物料名称</th><th>用料部位</th>{order.lines.map(line => <th key={line.lineId}>{line.color}<small>{line.colorForeign || "—"} · {line.poNumber || "待补 PO"}</small></th>)}<th>备注</th>{!readonly && <th>操作</th>}</tr></thead><tbody>{doc.fabrics.map(row => <tr key={row.id} data-doc-row>{(["name", "part"] as const).map(key => <td key={key}>{cell(`instruction-fabric-${row.id}-${key}`, `面料 · ${key === "name" ? "名称" : "部位"}`, row[key], sheet.document.fabrics.find(item => item.id === row.id)?.[key] ?? "", value => change({ fabrics: doc.fabrics.map(item => item.id === row.id ? { ...item, [key]: value } : item) }), key)}</td>)}{order.lines.map(line => <td key={line.lineId}>{cell(`instruction-fabric-${row.id}-color-${line.lineId}`, `${row.name || "面料"} · ${line.color} · ${line.poNumber || "待补 PO"}`, row.colors[line.lineId] ?? "", sheet.document.fabrics.find(item => item.id === row.id)?.colors[line.lineId] ?? "", value => change({ fabrics: doc.fabrics.map(item => item.id === row.id ? { ...item, colors: { ...item.colors, [line.lineId]: value } } : item) }), `color-${line.lineId}`)}</td>)}<td>{cell(`instruction-fabric-${row.id}-remarks`, "面料备注", row.remarks, sheet.document.fabrics.find(item => item.id === row.id)?.remarks ?? "", value => change({ fabrics: doc.fabrics.map(item => item.id === row.id ? { ...item, remarks: value } : item) }), "remarks", true)}</td>{!readonly && <td><Button type="button" disabled={busy} onClick={() => void remove(`删除${row.name || "面料明细"}？`, Boolean(row.name || row.part || row.remarks || Object.values(row.colors).some(Boolean)), () => change({ fabrics: doc.fabrics.filter(item => item.id !== row.id) }))}>删除</Button></td>}</tr>)}</tbody></table></DocumentTableScroll>{!doc.fabrics.length && <p className="instruction-empty">暂无明细</p>}{!readonly && <DocumentAddRow label="添加面料" disabled={inputDisabled || doc.fabrics.length >= 200} onClick={() => { const id = createClientRequestId(); change({ fabrics: [...doc.fabrics, { id, name: "", part: "", colors: Object.fromEntries(order.lines.map(line => [line.lineId, ""])), remarks: "" }] }); setFocusId(`instruction-fabric-${id}-name`); }} />}</DocumentSection>}
          {tab === "sewing" && accessory("车缝")}{tab === "packaging" && accessory("包装")}
          {tab === "images" && <DocumentSection id="instruction-images" title="工艺图文" detail={`已添加 ${doc.images.length} 张，最多 60 张（容量上限）`}>
            <div className="instruction-document-images">{doc.images.map(image => <figure key={image.attachmentId}><h3>{image.kind}</h3>{publishedImage(image.attachmentId) ? <a href={imageUrl(image.attachmentId)} target="_blank" rel="noreferrer"><img src={imageUrl(image.attachmentId)} alt={image.kind} /></a> : <div className="instruction-image-pending">保存后预览</div>}<label>车法、位置或包装说明{cell(`instruction-image-${image.attachmentId}-description`, `${image.kind} · 车法、位置或包装说明`, image.description, sheet.document.images.find(item => item.attachmentId === image.attachmentId)?.description ?? "", value => change({ images: doc.images.map(item => item.attachmentId === image.attachmentId ? { ...item, description: value } : item) }), undefined, true)}</label>{!readonly && <Button type="button" disabled={busy} onClick={() => void remove(`移除这张${image.kind}？历史版本保留原图片。`, true, () => { for (const [key, id] of successfulUploads.current) if (id === image.attachmentId) successfulUploads.current.delete(key); change({ images: doc.images.filter(item => item.attachmentId !== image.attachmentId) }); })}>移除</Button>}</figure>)}</div>
            {!doc.images.length && <p className="instruction-empty">暂无图片</p>}{!readonly && <div className="instruction-upload"><label>图片分类<select aria-label="图片分类" disabled={busy} value={uploadKind} onChange={event => setUploadKind(event.target.value as typeof kinds[number])}>{kinds.map(kind => <option key={kind}>{kind}</option>)}</select></label><label>上传{uploadKind}<input id="instruction-upload" type="file" multiple disabled={busy || doc.images.length >= 60} accept="image/jpeg,image/png,image/webp" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void upload(files); }} /></label><p className="instruction-note">JPG / PNG / WebP，单张大小沿用原上传限制；说明最多5000字。</p></div>}
          </DocumentSection>}
          {tab === "measurements" && <DocumentSection id="instruction-measurements" title="大货齐码尺寸表" detail={`${doc.measurements.length} / 200 个部位 · ${doc.sizes.length} / 50 尺码`}>{select("unit", "尺寸单位", [{ value: "inch", label: "英寸" }, { value: "cm", label: "厘米" }])}<DocumentTableScroll><table className="instruction-measurement-table"><thead><tr><th>部位</th><th>＋－公差</th><th>量法 / 备注</th>{doc.sizes.map(size => <th key={size}>{size}</th>)}{!readonly && <th>操作</th>}</tr></thead><tbody>{doc.measurements.map(row => <tr key={row.id} data-doc-row>{(["name", "tolerance", "method"] as const).map(key => <td key={key}>{cell(`instruction-measurement-${row.id}-${key}`, `${row.name || "尺寸项目"} · ${key === "name" ? "部位" : key === "tolerance" ? "公差" : "量法"}`, row[key], sheet.document.measurements.find(item => item.id === row.id)?.[key] ?? "", value => change({ measurements: doc.measurements.map(item => item.id === row.id ? { ...item, [key]: value } : item) }), key, key === "method")}</td>)}{doc.sizes.map((size, index) => <td key={size}>{cell(`instruction-measurement-${row.id}-value-${index}`, `${row.name || "尺寸项目"} ${size}`, row.values[index] ?? "", sheet.document.measurements.find(item => item.id === row.id)?.values[index] ?? "", value => change({ measurements: doc.measurements.map(item => item.id === row.id ? { ...item, values: item.values.map((previous, column) => column === index ? value : previous) } : item) }), `value-${index}`)}</td>)}{!readonly && <td><Button type="button" disabled={busy} onClick={() => void remove(`删除${row.name || "测量部位"}？`, Boolean(row.name || row.tolerance || row.method || row.values.some(Boolean)), () => change({ measurements: doc.measurements.filter(item => item.id !== row.id) }))}>删除</Button></td>}</tr>)}</tbody></table></DocumentTableScroll>{!doc.measurements.length && <p className="instruction-empty">暂无测量部位</p>}{!readonly && <DocumentAddRow label="添加测量部位" disabled={inputDisabled || doc.measurements.length >= 200} onClick={() => { const id = createClientRequestId(); change({ measurements: [...doc.measurements, { id, name: "", tolerance: "", method: "", values: doc.sizes.map(() => "") }] }); setFocusId(`instruction-measurement-${id}-name`); }} />}</DocumentSection>}
        </div>
      </form><aside className="instruction-document-side">
        <DocumentSection id="instruction-versions" title="版本与状态"><label>查看版本<select id="instruction-version" aria-label="查看版本" value={version ?? ""} disabled={busy||embedded} onChange={event => void chooseVersion(event.target.value ? Number(event.target.value) : undefined)}>{!embedded&&<option value="">{sheet.canEdit ? "当前草稿" : "当前有效版本"}</option>}{sheet.versions.map(value => <option key={value} value={value}>已发布版本 {value}</option>)}</select></label><dl><div><dt>当前制单</dt><dd>{mode}</dd></div><div><dt>已发布制单</dt><dd>{sheet.publishedVersion ? `版本 ${sheet.publishedVersion}` : "尚未发布"}</dd></div><div><dt>采用开发资料</dt><dd>{sheet.sourceRound ? `第 ${sheet.sourceRound} 轮` : "无开发来源"}</dd></div></dl>{!sheet.isPublishedSnapshot && sheet.publishedVersion && <Button type="button" disabled={busy} onClick={() => void chooseVersion(sheet.publishedVersion!)}>查看已发布版本</Button>}{!readonly && <p className="instruction-note">空闲1200ms自动保存，或使用保存草稿；发布需单独操作。</p>}</DocumentSection>
        <DocumentSection id="instruction-files" title="相关图片" detail={`${doc.images.length} 张`}><ul className="instruction-file-list">{doc.images.map((image, index) => <li key={image.attachmentId}>{publishedImage(image.attachmentId) ? <a href={imageUrl(image.attachmentId)} target="_blank" rel="noreferrer">{image.kind} · 图片 {index + 1}</a> : <span>{image.kind} · 保存后可查看</span>}</li>)}</ul>{!doc.images.length && <p className="instruction-empty">暂无图片</p>}<Button type="button" onClick={() => focus("images", readonly ? "instruction-images" : "instruction-upload")}>{readonly ? "查看工艺图文" : "上传图片 / 编辑说明"}</Button></DocumentSection>
        <DocumentSection id="instruction-notes" title="关键备注">{field("remarks", true)}</DocumentSection>
        <PoCustomerDates sheet={sheet} busy={busy||uncertain||readRequired||recovery.blocked||recovery.conflict} dirty={dirty} historical={embedded||Boolean(version)} onAct={act}/>
      </aside></div>
    </div>
    {printable ? <ProductionInstructionPrint sheet={sheet} imageUrl={imageUrl} /> : <p className="instruction-print-warning">请先保存当前修改，并打开已发布版本后打印。</p>}
  </article></Surface>;
}
