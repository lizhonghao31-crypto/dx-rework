import {Step,Stepper} from '@astryxdesign/core/Stepper';
import {DevelopmentDocumentSchema,developmentWorkbenchPublishIssues,developmentMaterialPublishIssues} from '@dx-rework/contracts/digital-development';
import {WorkbenchDevelopmentSheetFields,emptyWorkbenchDevelopmentSheet} from './workbench-development-sheet-fields.js';
import {DEVELOPMENT_WIZARD_STEPS,type DevelopmentWizardStep} from './development-creation-wizard.js';
import {developmentSubmissionResult,recoverDevelopmentSubmission,type PendingDevelopmentSubmission} from './development-submit-recovery.js';
import type {CreationDraftSnapshot} from './development-creation-draft.js';
import type {CreationOutgoing} from './use-development-creation-draft.js';
import {IndependentCraftField} from './independent-craft-field.js';
import {useOrderTimeApplication} from './order-time-application.js';
import {OrderTimeProductionRoute} from './order-time-production-route.js';
import {ProductionReadinessPanel} from './production-readiness-panel.js';
import {ShortLeadPanel} from './short-lead-panel.js';
import {matchingShortLeadApproval,type ShortLeadState} from '@dx-rework/contracts/short-commitment';
import {quotationHref} from './digital-quotation-panel.js';
import {DocumentToolbar,DocumentErrors} from "./document-editor.js";
import { DevelopmentDocumentFields } from "./development-document-fields.js";
import { DevelopmentPatternLink, type DevelopmentPatternChoice } from "./development-pattern-link.js";
import { developmentFieldChapter, developmentIssues } from "./digital-development-validation.js";
import { customerOrderDateError, initialCustomerDateErrors, digitalPoKey, initialCustomerOrderIsReady, salesYearOptions, SalesSeriesSchema } from "@dx-rework/contracts/digital-production";
import { createWebUrls } from "../url-contract.js";
import "./digital-development.css";
import { SearchableSelect } from "./search-select.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useId } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { DigitalIdSchema,DigitalOrderCreateSchema, DigitalSourceCreateSchema, type DigitalCustomer, type DigitalOrder, type DigitalOrderInput, type DigitalSource, type CustomerOrderCalendar } from "@dx-rework/contracts/digital-production";
import type { OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { digitalRequest, DigitalRequestError } from "./digital-production-api.js";
import { initialDigitalProductGroup } from "./digital-production-defaults.js";
import { createClientRequestId } from "./client-request-id.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";
import { changePoDate, inheritPoDate, removePoDateOverride } from "./po-date-input-defaults.js";
import type { DevelopmentSheet, DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { sameDevelopmentDocument, editableDevelopmentDocument, developmentSizeQuantityInputs, developmentOrderInput, developmentQuantityError, developmentQuantityTotal, initialDevelopmentDocument, type DevelopmentOrderDraft } from "./digital-development-editing.js";
import { preparePatternMaterial } from "./pattern-material-upload.js";
import { uploadDevelopmentMaterial } from "./digital-development-upload.js";
import { verifySession } from "./auth.js";
import { DocumentGuardContext } from "./use-digital-detail-navigation-guard.js";

import {customerPoDateLabel} from "./digital-workspace-copy.js";

type CreatePicture = {id: string; file: File; preview: string; kind: DevelopmentDocument["files"][number]["kind"]; attachmentId?: string; error?: string | undefined};

export type DevelopmentCreateIntent = "development" | "certain_order" | "confirm_order";
type SubmissionPhase='preparing'|'publish_check'|'publish'|'confirm_check'|'confirm';
export const developmentOrderOptionsPath=(sourceId:string|null)=>sourceId?`options?sourceId=${encodeURIComponent(sourceId)}`:'options';
const newLine = (): DevelopmentOrderDraft["lines"][number] => ({formalPoNo:null, customerWarehouseArrivalDate:null, poNumber: null, formalStyleNo: null, temporaryStyleNo: null, color: "", colorForeign: null, deliveryDate: null, sizes: [{size: "", quantity: ""}]});
export function initialDevelopmentOrder(customers: DigitalCustomer[], source?: OrderJourney): DevelopmentOrderDraft {
  return {customerCode: source?.customer ?? "", designStyleNo: source?.designStyleNo ?? "", temporaryStyleNo: source?.temporaryStyleNo ?? null,
    productGroup: initialDigitalProductGroup(customers, source?.customer ?? undefined),
    primaryMerchandiserId: customers.find(customer => customer.code === source?.customer)?.defaultMerchandiserId ?? null,
    orderDate: new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date()), contractDeliveryDate: null, lines: [newLine()]};
}

/** A facade over the existing source and order commands; no sample approval or route writes. */
export type DevelopmentCreationBridge={viewId:string;actorId:string;snapshot?:CreationDraftSnapshot|undefined;onSnapshot:(id:string,value:CreationDraftSnapshot)=>void;started:(id:string,outgoing:CreationOutgoing)=>void;acknowledged:(id:string,outgoing:CreationOutgoing,sourceId:string,version:number|null)=>void;refused:(id:string,outgoing:CreationOutgoing)=>void};
export function DevelopmentCreateForm({intent, source, customers, onCancel, onCreated, onIntentChange, existingDraft, independentCraftsEnabled=false, orderTimeEnabled=false, minimumDate, serverToday, calendarSourceId, contained=false, cancelLabel="返回列表",creation,guidedCreation=false,initialPreorder=false}: {
  independentCraftsEnabled?:boolean|undefined;orderTimeEnabled?:boolean|undefined;contained?:boolean; intent: DevelopmentCreateIntent; source?: OrderJourney; existingDraft?: DevelopmentSheet; minimumDate?:string|undefined; serverToday?:string|undefined; calendarSourceId?:string|null; customers: DigitalCustomer[];
  onCancel: (canReturnToServer?:boolean) => void; onCreated: (sourceId: string, orderId: string | null) => void; cancelLabel?:string;
  onIntentChange?: (intent: "development" | "certain_order") => void;
  creation?:DevelopmentCreationBridge|undefined;
  guidedCreation?:boolean;initialPreorder?:boolean;
}) {
  const formId=useId();
  const creationRef=useRef(creation);creationRef.current=creation;
  const [form, setForm] = useState(() => creation?.snapshot?.form??existingDraft?.document?.customerOrderDraft?.order ?? {...initialDevelopmentOrder(customers, source),...(serverToday?{orderDate:serverToday}:{}),...(existingDraft?{customerCode:existingDraft.customerCode??"",designStyleNo:existingDraft.designStyleNo,temporaryStyleNo:existingDraft.temporaryStyleNo}:{} )});
  const [fixedCraft,setFixedCraft]=useState(creation?.snapshot?.fixedCraft??(existingDraft?existingDraft.timelineSchemaVersion===2:independentCraftsEnabled));
  const [document,setDocument]=useState<DevelopmentDocument>(()=>creation?.snapshot?.document??(existingDraft?.document?(existingDraft.status==="published"?existingDraft.document:{...editableDevelopmentDocument(existingDraft.document),orderDate:existingDraft.document.orderDate??existingDraft.draftDocumentDate??existingDraft.developmentCreatedDate??null}):{...initialDevelopmentDocument(),orderDate:existingDraft?.draftDocumentDate??serverToday??null,...(guidedCreation&&!source&&!existingDraft&&!initialPreorder?{workbenchSheet:emptyWorkbenchDevelopmentSheet()}: {})}));
  const [sizeQuantityInputs,setSizeQuantityInputs]=useState(()=>creation?.snapshot?.sizeQuantityInputs??developmentSizeQuantityInputs(document));
  const [quantityInput,setQuantityInput]=useState(()=>creation?.snapshot?.quantityInput??(document.quantity===null?"":String(document.quantity)));
  const [stepValidation,setStepValidation]=useState(false);
  const [validationMode,setValidationMode]=useState<"save"|"publish"|null>(null);
  const [patternChoice,setPatternChoice]=useState<DevelopmentPatternChoice|null>(creation?.snapshot?.patternChoice??null);
  const guided=guidedCreation&&!source&&!existingDraft?.revisionSource;
  const [preorder,setPreorder]=useState(creation?.snapshot?.preorder??(existingDraft?.document?existingDraft.document.customerOrderDraft?.stage==='preorder'&&!existingDraft.document.customerOrderDraft.wizardConfirmPreorder:initialPreorder));
  const withOrder=intent!=='development';
  const stepCount=preorder?1:withOrder?3:2;
  const [locatingField,setLocatingField]=useState<{id:string}|null>(null);
  const [wizardStep,setWizardStep]=useState<DevelopmentWizardStep>(()=>Math.min(stepCount,creation?.snapshot?.wizardStep??existingDraft?.document?.customerOrderDraft?.wizardStep??1) as DevelopmentWizardStep);
  const stepHeading=useRef<HTMLHeadingElement>(null);
  const [published,setPublished]=useState(existingDraft?.status==="published");
  const [publishedOrder,setPublishedOrder]=useState(existingDraft?.status==="published"&&existingDraft.document?.customerOrderDraft?.withOrder?existingDraft.document.customerOrderDraft.order:null);
  const loadedVersion=useRef<number|null>(existingDraft?.version??null);
  const [fileKind,setFileKind]=useState<DevelopmentDocument["files"][number]["kind"]>(creation?.snapshot?.fileKind??"款图");
  const measurementIds=useRef(creation?.snapshot?.measurementIds??document.measurements.map(()=>createClientRequestId()));
  const [sharedPoColumns,setSharedPoColumns]=useState(creation?.snapshot?.sharedPoColumns??form.lines.every(row=>row.sizes.length===form.lines[0]!.sizes.length&&row.sizes.every((size,index)=>size.size===form.lines[0]!.sizes[index]!.size)));
  const maxPoSizeCount=Math.max(...form.lines.map(row=>row.sizes.length));
  const poSizeIds=useRef(creation?.snapshot?.poSizeIds??Array.from({length:maxPoSizeCount},()=>createClientRequestId()));
  const successfulUploads=useRef(new Map<string,string>()),publishKey=useRef<{payload:string;key:string}|null>(null);
  const edit=(patch:Partial<DevelopmentDocument>)=>setDocument(current=>({...current,...patch}));
  const validationDocument:DevelopmentDocument=document.customerOrderDraft&&validationMode==="publish"&&!preorder
    ?{...document,customerOrderDraft:{withOrder,stage:"formal",order:form}}
    :document;
  const workbenchCraftControl=guided&&document.workbenchSheet?"development-workbench-processingSelected":undefined;
  const issues=validationMode?developmentIssues(validationDocument,quantityInput,measurementIds.current,validationMode==="publish",null,sizeQuantityInputs,false,stepValidation)
    .map(issue=>workbenchCraftControl&&(issue.id==="development-craft"||issue.id==="development-craftSteps")?{...issue,id:workbenchCraftControl}:issue):[];
  const [designerName, setDesignerName] = useState<string | null>(existingDraft?.designerName ?? source?.designer ?? null);
  useEffect(() => {
    if (source || existingDraft) return;
    let live = true;
    void verifySession().then(session => {if (live && session !== "denied" && session.status === "authorized") setDesignerName(session.user.displayName);});
    return () => {live = false;};
  }, [source,existingDraft]);
  const [pictures, setPictures] = useState<CreatePicture[]>([]);
  const picturesRef = useRef<CreatePicture[]>([]), previews = useRef<string[]>([]);
  const draftSaveKey = useRef<{payload: string; key: string} | null>(null);
  useEffect(() => () => {for (const url of previews.current) URL.revokeObjectURL(url);}, []);
  const customerDateOverrides = useRef(new Set<number>(creation?.snapshot?.dateOverrides??form.lines.flatMap((line,index)=>index>0&&line.customerWarehouseArrivalDate!==form.lines[0]?.customerWarehouseArrivalDate?[index]:[])));
  const [developmentType, setDevelopmentType] = useState<"头版" | "开发板">(creation?.snapshot?.developmentType??(existingDraft?.developmentType==="开发板"?"开发板":"头版"));
  const [createdSource, setCreatedSource] = useState<string | null>(existingDraft?.sourceId ?? source?.sourceId ?? null);
  const [fixedCustomer, setFixedCustomer] = useState<string | null>(existingDraft?.customerCode ?? source?.customer ?? null);
  const [busy, setBusy] = useState(false), [error, setErrorState] = useState("");
  const [failedPhase,setFailedPhase]=useState<SubmissionPhase|null>(null);
  const setError=useCallback((message:string)=>{setFailedPhase(null);setErrorState(message);},[]);
  const [errorField,setErrorField]=useState<string|null>(null);
  const [duplicateSource,setDuplicateSource]=useState<string|null>(null),sourceSearchSequence=useRef(0);
  const findExistingSource=async(value:string)=>{
    const sequence=++sourceSearchSequence.current;setDuplicateSource(null);
    if(createdSource||!value.trim())return;
    try{const result=await digitalRequest<{items:DigitalSource[]}>(`sources?search=${encodeURIComponent(value.trim())}`);
      if(sequence!==sourceSearchSequence.current)return;
      const existing=result.items.find(item=>digitalPoKey(item.designStyleNo)===digitalPoKey(value));
      if(existing){setDuplicateSource(existing.sourceId);setError("该编号已有开发档案，请打开原档案继续办理");}
    }catch{ /* Submission still enforces the authoritative duplicate check. */ }
  };
  const [codeCheck,setCodeCheck]=useState<{code:string;available:boolean}|null>(null);
  const [checkingCode,setCheckingCode]=useState(false);
  const checkCode=async()=>{
    const value=form.designStyleNo.trim(),sequence=++sourceSearchSequence.current;
    if(!value||createdSource)return;
    setCheckingCode(true);setCodeCheck(null);
    try {const result=await digitalRequest<{code:string;available:boolean}>(`design-codes/check?code=${encodeURIComponent(value)}`);if(sequence===sourceSearchSequence.current)setCodeCheck(result);}
    catch(reason){if(sequence===sourceSearchSequence.current)setError(reason instanceof Error?reason.message:'编号读取失败，请重试');}
    finally{setCheckingCode(false);}
  };
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const writing = useRef(false), sourceKey = useRef<{payload: string; key: string} | null>(null), orderKey = useRef<{payload: string; key: string} | null>(null);
  const pendingSubmission=useRef<PendingDevelopmentSubmission|null>(null),[submissionUnknown,setSubmissionUnknown]=useState(false);
  const recoverSubmission=async(replay=false)=>{
    const command=pendingSubmission.current;if(!command||writing.current)return;
    writing.current=true;setBusy(true);setError('');
    try{
      const receipt=await recoverDevelopmentSubmission(command,replay);
      if(receipt.status==='unconfirmed'){setError('尚未查到已提交成功的回执；这不代表原请求失败。原资料和操作标识仍保留，可稍后只读核对，或沿原命令继续核对。');return;}
      pendingSubmission.current=null;setSubmissionUnknown(false);completed.current=true;writing.current=false;
      onCreated(command.sourceId,receipt.operation==='confirm'?receipt.productionOrderId:null);
    }catch(reason){setError(reason instanceof Error?reason.message:'尚未取得原提交结果，输入和原操作标识仍保留。');}
    finally{writing.current=false;setBusy(false);}
  };
  const draftSnapshot = (items: CreatePicture[], value=document, order=form, quantity=quantityInput) => JSON.stringify({intent, preorder, form:order, developmentType, document:value, quantityInput:quantity, sizeQuantityInputs, pictures: items.map(item => [item.id, item.attachmentId ?? null])});
  const currentSnapshot = draftSnapshot(pictures);
  const initial = useRef(creation?.snapshot?.baseline??currentSnapshot), dirty = useRef(false), completed = useRef(false);
  const unavailableDraftAttachments=(existingDraft?.unavailableDraftAttachments??[]).filter(id=>document.files.some(file=>file.attachmentId===id));
  const lostLocalFiles=useRef(creation?.snapshot?.localFiles??[]).current.filter(file=>document.files.some(row=>row.attachmentId===file.id));
  useLayoutEffect(()=>{
    const bridge=creationRef.current;if(!bridge||intent==='confirm_order')return;
    const snapshot:CreationDraftSnapshot={intent,form,document,quantityInput,sizeQuantityInputs,developmentType,preorder,...(guided?{wizardStep}:{}),fixedCraft,measurementIds:measurementIds.current,poSizeIds:poSizeIds.current,sharedPoColumns,dateOverrides:[...customerDateOverrides.current],fileKind,patternChoice,baseline:initial.current,localFiles:[...lostLocalFiles,...picturesRef.current.filter(file=>!file.attachmentId&&document.files.some(row=>row.attachmentId===file.id)).map(file=>({id:file.id,name:file.file.name,type:file.file.type,size:file.file.size,kind:file.kind}))]};
    try{bridge.onSnapshot(bridge.viewId,snapshot);}catch(reason){setError(reason instanceof Error?reason.message:'本页草稿未能保留，当前输入仍在，尚未提交');}
  },[creation?.viewId,currentSnapshot,patternChoice,fileKind,fixedCraft,guided,wizardStep,sharedPoColumns]);
  const timeApplication=useOrderTimeApplication(()=>{completed.current=true;dirty.current=false;});
  type Calendar={sourceId:string|null;serverToday:string;minimumInitialCustomerDate:string;orderTimeEnabled?:boolean};
  const preloadedCalendar=Boolean(serverToday&&minimumDate&&(createdSource===null||calendarSourceId===createdSource));
  const [calendar,setCalendar]=useState<Calendar|null>(()=>preloadedCalendar?{sourceId:createdSource,serverToday:serverToday!,minimumInitialCustomerDate:minimumDate!,orderTimeEnabled:existingDraft?.orderTimeEnabled??orderTimeEnabled}:null);
  const [calendarError,setCalendarError]=useState(''),[calendarRefresh,setCalendarRefresh]=useState(0);
  const preloadedCalendarConsumed=useRef(false);
  const initialCalendarSource=useRef(createdSource),calendarInitialized=useRef<{sourceId:string|null}|null>(preloadedCalendar||creation?.snapshot?{sourceId:createdSource}:null);
  const calendarReady=calendar?.sourceId===createdSource;
  const calendarToday=calendarReady?calendar!.serverToday:undefined;
  const dateMinimum=calendarReady?calendar!.minimumInitialCustomerDate:undefined;
  const [shortState,setShortState]=useState<ShortLeadState|null>(null);
  let shortInput:DigitalOrderInput|undefined;try{shortInput=DigitalOrderCreateSchema.parse(developmentOrderInput(form));}catch{/* Incomplete ordering drafts remain editable. */}
  const shortApproval=shortInput&&shortState?matchingShortLeadApproval(shortInput,shortState.requests):null;
  const approvedCalendar=shortApproval?{requestId:shortApproval.requestId,facts:shortApproval.facts,commitmentDay:shortApproval.commitmentDay}:null;
  const confirmationCalendar=calendarReady?{...calendar!,approvedShortLead:approvedCalendar}:undefined;
  const boundOrder=publishedOrder&&initialCustomerOrderIsReady(publishedOrder,confirmationCalendar)?publishedOrder:null;
  useEffect(()=>{
    let live=true;const abort=new AbortController();
    const refresh=()=>setCalendarRefresh(value=>value+1);
    window.addEventListener('focus',refresh);window.addEventListener('acceptance-clock-changed',refresh);
    if(busy||writing.current)return()=>{live=false;abort.abort();window.removeEventListener('focus',refresh);window.removeEventListener('acceptance-clock-changed',refresh);};
    if(preloadedCalendar&&calendarRefresh===0&&!preloadedCalendarConsumed.current){preloadedCalendarConsumed.current=true;setCalendarError('');setCalendar({sourceId:createdSource,serverToday:serverToday!,minimumInitialCustomerDate:minimumDate!,orderTimeEnabled:existingDraft?.orderTimeEnabled??orderTimeEnabled});}
    else {
      setCalendarError('');
      void digitalRequest<Omit<Calendar,'sourceId'>>(developmentOrderOptionsPath(createdSource),'GET',undefined,undefined,{signal:abort.signal}).then(next=>{
        if(!live)return;
        if(!next.serverToday||!next.minimumInitialCustomerDate)throw new Error('未取得本单日期，请重新读取；输入仍保留');
        // Initialize once before editing; later clock/date refreshes retain every entered fact.
        if(calendarInitialized.current?.sourceId!==createdSource){
          if(createdSource===initialCalendarSource.current&&!existingDraft?.document?.customerOrderDraft)setForm(current=>{const updated={...current,orderDate:next.serverToday};initial.current=draftSnapshot(picturesRef.current,document,updated,quantityInput);return updated;});
          calendarInitialized.current={sourceId:createdSource};
        }
        setCalendar({...next,sourceId:createdSource});
      }).catch(reason=>{if(live&&reason?.name!=='AbortError')setCalendarError(reason instanceof Error?reason.message:'本单日期读取失败');});
    }
    return()=>{live=false;abort.abort();window.removeEventListener('focus',refresh);window.removeEventListener('acceptance-clock-changed',refresh);};
  },[createdSource,calendarRefresh,calendarSourceId,serverToday,minimumDate,busy]);
  dirty.current = currentSnapshot !== initial.current;
  const documentGuards = useContext(DocumentGuardContext);
  useEffect(() => {
    const guard = async () => {
      if (writing.current) return false;
      if(pendingSubmission.current)return await confirmInApp('原提交结果尚未确定；离开会丢失本页原命令核对入口，仍要离开？')&&!writing.current;
      if (completed.current || !dirty.current) return true;
      return await confirmInApp("有未保存开发资料或订购信息，确定离开？") && !writing.current;
    };
    const unregister = registerInternalNavigationGuard(guard);
    documentGuards?.add(guard);
    const unload = (event: BeforeUnloadEvent) => {if (writing.current || pendingSubmission.current || (!completed.current && dirty.current)) {event.preventDefault(); event.returnValue = "";}};
    window.addEventListener("beforeunload", unload);
    return () => {unregister(); documentGuards?.delete(guard); window.removeEventListener("beforeunload", unload);};
  }, [documentGuards]);
  const developmentPublished=published||Boolean(source);
  const publishStatus=submissionUnknown?(pendingSubmission.current?.operation==='publish'?'开发发布结果待核对':'客户订单确认结果待核对'):preorder&&!developmentPublished?`预下单草稿 · ${dirty.current?"有未保存修改":"可继续补充资料"}`:developmentPublished?(withOrder?"开发单已发布 · 客户订单待核对确认":"开发单已发布 · 尚无确定客户订单"):`开发草稿 · ${dirty.current?"有未保存修改":savedDraft||existingDraft?.document?"已保存，可继续填写":"尚未保存"}`;
  const submitLabel=preorder&&!published?"保存预下单备料资料":guided?withOrder?"提交并确认订单":"提交开发单":intent==="confirm_order"?"确认下单":published?(withOrder?"确认客户订单":"返回已发布档案"):"发布开发单";
  const title = preorder&&!published?"预下单备料 · 资料可后补":existingDraft?.revisionSource?`复版 ${existingDraft.revisionSource.revisionNumber} · ${existingDraft.designStyleNo}`:intent === "confirm_order" ? "客户确定订单 · 补订购信息" : withOrder ? "产品开发（有确定订单）" : "产品开发（无确定订单）";
  const line = (index: number, patch: Partial<DevelopmentOrderDraft["lines"][number]>) => setForm(current => ({...current, lines: current.lines.map((value, i) => i === index ? {...value, ...patch} : value)}));
  const selectPictures = async (files: File[]) => {
    if (writing.current || !files.length) return;
    writing.current = true; setBusy(true); setError("");
    try {
      let fileCount=document.files.length;
      for (const original of files) {
        if (fileCount >= 30) throw new Error("开发单最多30个附件，请先移除不用的文件");
        const file = original.type === "application/pdf" ? original : await preparePatternMaterial(original);
        if (["款图","局部图"].includes(fileKind) && !file.type.startsWith("image/")) throw new Error("款图和局部图请使用 JPG、PNG 或 WebP");
        const preview = URL.createObjectURL(file); previews.current.push(preview);
        fileCount++; const id=createClientRequestId();
        picturesRef.current = [...picturesRef.current, {id, file, preview,kind:fileKind}];
        setDocument(current=>({...current,files:[...current.files,{attachmentId:id,kind:fileKind}]}));
        setPictures(picturesRef.current);
      }
    } catch (reason) {setError(reason instanceof Error ? reason.message : "图片无法读取，请换一张或重试；其它资料仍保留");}
    finally {writing.current = false; setBusy(false);}
  };
  const customerDate = (index: number, date: string | null) => {
    const overrides = new Set(customerDateOverrides.current);
    if (index > 0) overrides.add(index);
    customerDateOverrides.current = overrides;
    setForm(current => ({...current, lines: changePoDate(current.lines, "customerWarehouseArrivalDate", index, date, overrides)}));
  };
  const removeLine = (index: number) => {
    customerDateOverrides.current = removePoDateOverride(customerDateOverrides.current, index);
    setForm(current => ({...current, lines: current.lines.length > 1 ? current.lines.filter((_, position) => position !== index) : current.lines}));
  };
  const save = async (draftOnly = false):Promise<boolean> => {
    if (writing.current || pendingSubmission.current) return false;
    if(unavailableDraftAttachments.length){setError('此草稿含失效附件，请移除原附件并重新上传后再保存或发布。');return false;}
    if(lostLocalFiles.length){setError('本页原本地附件尚未上传，刷新后须重新选择或移除这些本地项；未开始提交，其他资料仍保留。');return false;}
    const creationScope=creationRef.current;
    const requestCreation=async<T,>(path:string,method:'POST'|'PUT',body:unknown,key:string,sourceId:string|null,beforeVersion:number|null,proof:(value:T)=>{sourceId:string;version:number|null},native?:PendingDevelopmentSubmission):Promise<T>=>{
      const outgoing:CreationOutgoing={path,method,key,body:JSON.stringify(body),sourceId,beforeVersion,...(native?{native}:{})};creationScope?.started(creationScope.viewId,outgoing);
      try{
        const value=await digitalRequest<T>(path,method,body,key);
        if(creationScope){let result:{sourceId:string;version:number|null};try{result=proof(value);}catch{throw new DigitalRequestError('原创建操作回执尚未匹配，原资料和标识已保留；请勿另提',200,'INVALID_RESPONSE');}creationScope.acknowledged(creationScope.viewId,outgoing,result.sourceId,result.version);}
        return value;
      }catch(reason){if(reason instanceof DigitalRequestError&&!reason.resultUnknown)creationScope?.refused(creationScope.viewId,outgoing);throw reason;}
    };
    writing.current = true; setBusy(true); setError("");setErrorField(null);
    let phase:SubmissionPhase='preparing';
    try {
      if(!form.designStyleNo.trim())throw new Error("请填写设计款号");
      if(withOrder&&!preorder&&!draftOnly&&!form.customerCode)throw new Error("请选择客户");
      const sourceInput = DigitalSourceCreateSchema.parse({developmentType, designStyleNo: form.designStyleNo, temporaryStyleNo: form.temporaryStyleNo, customerCode: form.customerCode || null});
      let effectiveApproval=shortApproval;
      if(!calendar?.orderTimeEnabled&&!draftOnly&&createdSource&&shortInput&&dateMinimum&&initialCustomerDateErrors(shortInput.lines,dateMinimum).length){
        const actual=await digitalRequest<ShortLeadState>(`sources/${createdSource}/short-lead-requests`);setShortState(actual);effectiveApproval=matchingShortLeadApproval(shortInput,actual.requests);
      }
      const effectiveApprovedCalendar=effectiveApproval?{requestId:effectiveApproval.requestId,facts:effectiveApproval.facts,commitmentDay:effectiveApproval.commitmentDay}:null;
      const effectiveConfirmationCalendar=calendarReady?{...calendar!,approvedShortLead:effectiveApprovedCalendar}:undefined;
      const shouldConfirmOrder=withOrder&&!draftOnly&&(guided||intent==="confirm_order"||published||Boolean(source)||initialCustomerOrderIsReady(form,effectiveConfirmationCalendar));
      const orderInput = shouldConfirmOrder ? DigitalOrderCreateSchema.parse({...developmentOrderInput(form),...(document.productionPlanning?{productionPlanning:document.productionPlanning}:{}),...(!calendar?.orderTimeEnabled&&effectiveApproval?{shortLeadApprovalId:effectiveApproval.requestId}:{})}) : null;
      let liveConfirmationCalendar:CustomerOrderCalendar|undefined=effectiveConfirmationCalendar;
      const savedWizardStep=guided&&draftOnly?wizardStep:document.customerOrderDraft?.wizardStep;
      const keepPreorder=guided&&draftOnly&&!preorder&&document.customerOrderDraft?.stage==='preorder';
      const submissionDocument:DevelopmentDocument={...document,customerOrderDraft:{
        withOrder,stage:preorder||keepPreorder?'preorder':'formal',order:form,
        ...(keepPreorder?{wizardConfirmPreorder:true as const}:{}),
        ...(savedWizardStep===undefined?{}:{wizardStep:savedWizardStep}),
      }};
      if(orderInput){
        const calendar=await digitalRequest<{serverToday:string;minimumInitialCustomerDate:string;orderTimeEnabled?:boolean}>(developmentOrderOptionsPath(createdSource));
        if(!calendar.serverToday||!calendar.minimumInitialCustomerDate)throw new Error("未取得服务器日期，请重试；输入仍保留");
        liveConfirmationCalendar={...calendar,approvedShortLead:effectiveApprovedCalendar};setCalendar({...calendar,sourceId:createdSource});
        const dateError=customerOrderDateError(orderInput.orderDate,calendar.serverToday);
        if(dateError)throw new Error(dateError);
        const errors=calendar.orderTimeEnabled?[]:initialCustomerDateErrors(orderInput.lines,calendar.minimumInitialCustomerDate);if(errors.length&&!effectiveApproval)throw new Error(errors.join("；"));
      }
      if(!source&&!published){setStepValidation(false);setValidationMode(draftOnly?"save":"publish");if(developmentIssues(submissionDocument,quantityInput,measurementIds.current,!draftOnly,null,sizeQuantityInputs).length)return false;if(!draftOnly&&!patternChoice&&existingDraft?.revisionSource?.outputKind!=='工艺布片')throw new Error("请先选择有效打板品类与执行价，再发布开发单");}
      let id = createdSource;
      if (!id) {
        const payload = JSON.stringify(sourceInput);
        if (sourceKey.current?.payload !== payload) sourceKey.current = {payload, key: createClientRequestId()};
        // The original creation acknowledgement intentionally contains only
        // sourceId. Retain that known identity before the separate sheet read;
        // a failed read must never authorize creating another source.
        const next = await requestCreation<Pick<DigitalSource,'sourceId'>>("sources/drafts", "POST", sourceInput, sourceKey.current.key,null,null,value=>{
          if(!DigitalIdSchema.safeParse(value?.sourceId).success)throw Error('SOURCE_RESPONSE_MISMATCH');
          setCreatedSource(value.sourceId);setFixedCustomer(sourceInput.customerCode);return {sourceId:value.sourceId,version:null};
        });
        id = next.sourceId; setCreatedSource(id); setFixedCustomer(sourceInput.customerCode);
      }
      let persistedDocument=document;
      if (!source) {
        const base = `sources/${id}/development`;
        let sheet = await digitalRequest<DevelopmentSheet>(base);setFixedCraft(sheet.timelineSchemaVersion===2);
        if(loadedVersion.current===null)loadedVersion.current=sheet.version;
        if (sheet.status !== "published") {
          if (!sheet.canEdit) throw new Error("当前没有修改开发单的权限");
          const desired=new Set(document.files.map(file=>file.attachmentId));
          const pending=picturesRef.current.filter(picture=>desired.has(picture.id)||Boolean(picture.attachmentId&&desired.has(picture.attachmentId)));
          if(pending.some(picture=>!picture.attachmentId)){
            const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
            for(const picture of pending){
              if(picture.attachmentId)continue;
              try{const attachmentId=await uploadDevelopmentMaterial(base,picture.file,picture.kind,limits.maxUploadBytes);
                picturesRef.current=picturesRef.current.map(item=>item.id===picture.id?{...item,attachmentId,error:undefined}:item);setPictures(picturesRef.current);
              }catch(reason){const message=reason instanceof Error?reason.message:"上传失败，请重试";picturesRef.current=picturesRef.current.map(item=>item.id===picture.id?{...item,error:message}:item);setPictures(picturesRef.current);throw reason;}
            }
          }
          const uploaded=new Map(picturesRef.current.flatMap(picture=>picture.attachmentId?[[picture.id,picture.attachmentId] as const]:[]));
          const preparedDocument:DevelopmentDocument={...submissionDocument,
            orderDate:sheet.document?.orderDate??sheet.draftDocumentDate??sheet.developmentCreatedDate??document.orderDate,
            files:document.files.map(file=>({...file,attachmentId:uploaded.get(file.attachmentId)??file.attachmentId})),
            materials:document.materials.map(material=>material.sampleAttachmentId&&uploaded.has(material.sampleAttachmentId)
              ?{...material,sampleAttachmentId:uploaded.get(material.sampleAttachmentId)!}:material),
          };
          persistedDocument=guided&&document.workbenchSheet?DevelopmentDocumentSchema.parse(preparedDocument):preparedDocument;
          if(loadedVersion.current!==null&&sheet.version!==loadedVersion.current&&!sameDevelopmentDocument(sheet.document,persistedDocument))throw new Error("开发单已更新，请重新打开后再保存；当前填写仍保留");
          if(!sameDevelopmentDocument(sheet.document,persistedDocument)){
            const body={expectedVersion:sheet.version,document:persistedDocument},payload=JSON.stringify(body);
            if(draftSaveKey.current?.payload!==payload)draftSaveKey.current={payload,key:createClientRequestId()};
            sheet=await requestCreation<DevelopmentSheet>(base,"PUT",body,draftSaveKey.current.key,id!,sheet.version,value=>{
              if(value.sourceId!==id||value.version!==body.expectedVersion+1||!sameDevelopmentDocument(value.document,persistedDocument))throw Error('DEVELOPMENT_SAVE_RESPONSE_MISMATCH');return {sourceId:id!,version:value.version};
            });
          }
          loadedVersion.current=sheet.version;
          if(sheet.document){
            persistedDocument=sheet.document;
            const savedOrder=sheet.document.customerOrderDraft?.order??form;
            const savedQuantity=sheet.document.quantity===null?"":String(sheet.document.quantity);
            setDocument(sheet.document);setSizeQuantityInputs(developmentSizeQuantityInputs(sheet.document));setForm(savedOrder);setQuantityInput(savedQuantity);
            const snapshot=draftSnapshot(picturesRef.current,sheet.document,savedOrder,savedQuantity);
            initial.current=snapshot;dirty.current=false;setSavedDraft(snapshot);
          }
          if(!draftOnly){
            const body={expectedVersion:sheet.version,...(existingDraft?.revisionSource?.outputKind==='工艺布片'||!patternChoice?{}:{patternOrder:patternChoice})},payload=JSON.stringify(body);
            if(publishKey.current?.payload!==payload)publishKey.current={payload,key:createClientRequestId()};
            phase='publish_check';
            if(!await timeApplication.inspect({kind:'development_publish',sourceId:id,input:{expectedVersion:body.expectedVersion,...(body.patternOrder?{patternOrder:body.patternOrder}:{})}},Boolean(sheet.orderTimeEnabled??calendar?.orderTimeEnabled)))return false;
            phase='publish';
            const command:PendingDevelopmentSubmission={operation:'publish',sourceId:id,key:publishKey.current.key,body:structuredClone(body)};
            let publishedSheet:DevelopmentSheet;
            try{publishedSheet=await requestCreation<DevelopmentSheet>(`${base}/publish`,"POST",command.body,command.key,id!,sheet.version,value=>{developmentSubmissionResult(command,value);return {sourceId:id!,version:value.version};},command);if(!creationScope)developmentSubmissionResult(command,publishedSheet);}
            catch(reason){if(reason instanceof DigitalRequestError&&reason.resultUnknown){pendingSubmission.current=command;setSubmissionUnknown(true);}throw reason;}
            setPublished(true);
            if(publishedSheet.document?.customerOrderDraft?.withOrder){const draft=publishedSheet.document.customerOrderDraft.order;setPublishedOrder(draft);setForm(draft);}
          }
        } else {setPublished(true);if(sheet.document?.customerOrderDraft?.withOrder){const draft=sheet.document.customerOrderDraft.order;setPublishedOrder(draft);if(initialCustomerOrderIsReady(draft,liveConfirmationCalendar))setForm(draft);}if(draftOnly)throw new Error("开发单已发布，请继续确认客户订单或重新打开查看");persistedDocument=sheet.document??document;}
      }
      let orderId: string | null = null;
      if (orderInput) {
        phase='confirm_check';
        if(!await timeApplication.inspect({kind:'confirm_order',sourceId:id,input:orderInput},Boolean(calendar?.orderTimeEnabled)))return false;
        const payload = JSON.stringify(orderInput);
        if (orderKey.current?.payload !== payload) orderKey.current = {payload, key: createClientRequestId()};
        let order:DigitalOrder;
        const command:PendingDevelopmentSubmission={operation:'confirm',sourceId:id,body:structuredClone(orderInput),key:orderKey.current.key};
        phase='confirm';
        try{order=await requestCreation<DigitalOrder>(`sources/${id}/confirm`, "POST", command.body,command.key,id!,loadedVersion.current,value=>{developmentSubmissionResult(command,value);return {sourceId:id!,version:loadedVersion.current};},command);if(!creationScope)developmentSubmissionResult(command,order);}
        catch(reason){if(reason instanceof DigitalRequestError&&reason.resultUnknown){pendingSubmission.current=command;setSubmissionUnknown(true);}throw reason;}
        orderId = order.productionOrderId;
      }
      if (draftOnly) {
        return true;
      }
      completed.current = true; writing.current = false; onCreated(id, orderId);return true;
    } catch (reason) {
      const validation = reason as {issues?: Array<{message:string;path:Array<string|number>}>};
      const issue=validation.issues?.[0];
      const field=issue?.path.at(-1),labels:Record<string,string>={designStyleNo:"设计款号",customerCode:"客户",productGroup:"产品分组",orderDate:"下单日期",color:"颜色",size:"尺码",quantity:"订购数量",lines:"PO 明细"};
      const prefix=issue?.path[0]==="lines"&&typeof issue.path[1]==="number"?`PO ${issue.path[1]+1} `:"";
      setError(issue?( /[\u3400-\u9fff]/.test(issue.message)?issue.message:`${prefix}${labels[String(field)]??"订购资料"}填写有误，请核实必填内容与允许范围`):(reason instanceof Error?reason.message.replaceAll("出货日期",customerPoDateLabel):"保存失败"));
      setFailedPhase(phase);
      const message=reason instanceof Error?reason.message:"";
      const po=message.match(/PO (\d+)/)?.[1],index=typeof issue?.path[1]==='number'?issue.path[1]+1:null;
      const target=message.includes('客户下单日期')?'development-customer-order-date':field==='designStyleNo'||message.includes('设计款号')?'development-create-style':field==='customerCode'||message.includes('请选择客户')?'development-create-customer':po?`development-po-date-${po}`:index&&field==='color'?`development-po-color-${index}`:null;
      setErrorField(target);if(target)requestAnimationFrame(()=>window.document.getElementById(target)?.focus());return false;
    } finally {writing.current = false; setBusy(false);}
  };
  const changeStep=(step:DevelopmentWizardStep)=>{
    setWizardStep(step);
    setError('');
    setErrorField(null);
    requestAnimationFrame(()=>stepHeading.current?.focus());
  };
  const locateStep=(id:string)=>{
    if(!guided||preorder)return;
    setLocatingField({id});
    const chapter=developmentFieldChapter(id);
    if(id.startsWith('development-workbench-')||id==='development-create-style'||chapter==='development-images'||chapter==='development-sizes'||chapter==='development-materials')setWizardStep(1);
    else if(chapter)setWizardStep(2);
    else if(withOrder)setWizardStep(3);
  };
  const beginPreorderConfirmation=async()=>{
    if(!await confirmInApp("客户已确认订单？在原预下单上补齐正式资料；保存草稿不会正式下单。")||writing.current)return;
    setPreorder(false);
    changeStep(1);
  };
  const advance=()=>{
    if(wizardStep===1&&!form.designStyleNo.trim()){
      setError('请填写设计款号');
      setErrorField('development-create-style');
      window.document.getElementById('development-create-style')?.focus();
      return;
    }
    if(wizardStep===1&&document.workbenchSheet){
      const shape=DevelopmentDocumentSchema.safeParse(validationDocument);
      const first=developmentWorkbenchPublishIssues(document.workbenchSheet)[0];
      const fabric=developmentMaterialPublishIssues(document)[0];
      if(first||fabric||!shape.success){
        setValidationMode('save');
        setStepValidation(true);
        const id=first?`development-workbench-${first.field}`:fabric?`development-${fabric.materialId}-${fabric.field}`:undefined;
        if(id)setLocatingField({id});
        return;
      }
    }
    setStepValidation(false);
    if(wizardStep===2&&document.workbenchSheet&&!published&&(!patternChoice||!document.quantity)){
      const id=document.quantity?"development-pattern-preparation":"development-quantity";
      setError(document.quantity?"请选择打板品类与有效执行价":"请填写本轮打板数量");
      setErrorField(id);
      setLocatingField({id});
      return;
    }
    if(wizardStep<stepCount)changeStep(wizardStep===1?2:3);
  };
  const rowTotals = form.lines.map(row => developmentQuantityTotal(row.sizes));
  const totalQuantity = rowTotals.some(total => total === null) ? null : rowTotals.reduce<number>((sum, total) => sum + (total ?? 0), 0);
  const returnToList = async () => {
    if(pendingSubmission.current){if(!writing.current&&await confirmInApp('原提交结果尚未确定；离开会丢失本页原命令核对入口，仍要离开？'))onCancel();return;}
    if ((!dirty.current || await confirmInApp("有未保存开发资料或订购信息，确定离开？")) && !writing.current) onCancel(!dirty.current&&loadedVersion.current!==null);
  };
  const changeCraft=(craft:DevelopmentDocument["craft"],craftSteps?:DevelopmentDocument["craftSteps"])=>{
    edit({craft,...(craftSteps?{craftSteps}:{}),...(document.workbenchSheet?{workbenchSheet:{...document.workbenchSheet,processingSelected:true}}:{})});
  };
  const basicDevelopment=<><div><label>开发下单日期（固定）<input id="development-orderDate" aria-label="开发下单日期" readOnly value={document.orderDate??(published?"历史未登记":"保存后由服务器确定")}/></label>{fixedCraft?<IndependentCraftField label="工艺" firstControlId={workbenchCraftControl} value={document.craft} steps={document.craftSteps} readonly={published} disabled={busy} onChange={changeCraft}/>:<label>工艺<select id={workbenchCraftControl} aria-label="工艺" disabled={published} value={document.workbenchSheet&&!document.workbenchSheet.processingSelected?"":document.craft} onChange={event=>changeCraft(event.target.value as DevelopmentDocument["craft"])}>{document.workbenchSheet&&<option value="" disabled>选择加工类型</option>}{["无","印花","绣花","印绣花"].map(value=><option key={value}>{value}</option>)}</select></label>}
    {fixedCraft&&document.workbenchSheet&&document.craft==="无"&&!published&&
      <label><input type="checkbox" checked={document.workbenchSheet.processingSelected} onChange={event=>edit({workbenchSheet:{...document.workbenchSheet!,processingSelected:event.target.checked}})}/>无加工工艺</label>}
    </div></>;
  return <Surface className={`development-create development-create-reference dx-doc-development${guided?" development-create-wizard":""}`}><form id={formId} noValidate onKeyDown={event=>{if(event.key==="Enter"&&event.nativeEvent.isComposing)event.preventDefault();}} onSubmit={event => {event.preventDefault(); if(guided&&wizardStep<stepCount)advance();else void save(preorder&&!published);}}>
    {creation?.snapshot&&<p role="status">已恢复本页开发资料和订购草稿；未创建新档案、未自动提交。</p>}
    {unavailableDraftAttachments.length>0&&<p role="alert">此草稿有 {unavailableDraftAttachments.length} 份已保存附件已失效，请在附件列表移除原附件并重新上传。</p>}
    {lostLocalFiles.length>0&&<p role="alert">原本地附件尚未上传，浏览器刷新未保留文件内容：{lostLocalFiles.map(file=>file.name).join('、')}。请重新选择，或沿附件列表明确移除原本地项后再办理；其他输入仍保留。</p>}
    <DocumentToolbar title={title} status={busy?"保存中":publishStatus}>{!contained&&<Button type="button" disabled={busy} onClick={()=>void returnToList()}>{cancelLabel}</Button>}{!source&&!published&&!preorder&&<Button type="button" disabled={busy||submissionUnknown||!calendarReady||Boolean(calendarError)} onClick={()=>void save(true)}>保存开发资料草稿</Button>}<Button form={formId} type="submit" variant="primary" disabled={busy||submissionUnknown||!calendarReady||Boolean(calendarError)||(!guided&&!source&&!published&&!preorder&&existingDraft?.revisionSource?.outputKind!=="工艺布片"&&!patternChoice)}>{busy?"保存中…":guided&&wizardStep<stepCount?"下一步":submitLabel}</Button>{guided&&wizardStep>1&&<Button type="button" disabled={busy||submissionUnknown} onClick={()=>changeStep(wizardStep===3?2:1)}>上一步</Button>}{guided&&preorder&&createdSource&&Boolean(loadedVersion.current)&&!published&&
      <Button type="button" disabled={busy||submissionUnknown} onClick={()=>void beginPreorderConfirmation()}>客户确认下单</Button>}
      {guided&&!preorder&&!published&&document.customerOrderDraft?.stage==='preorder'&&
      <Button type="button" disabled={busy||submissionUnknown} onClick={()=>{setPreorder(true);setStepValidation(false);changeStep(1);}}>返回预下单备料</Button>}
    </DocumentToolbar>
    {guided&&!preorder&&<section aria-label="建单步骤"><Stepper label="建单进度" className="development-creation-steps" activeStep={wizardStep-1}>
      {DEVELOPMENT_WIZARD_STEPS.slice(0,stepCount).map((label,index)=><Step key={label} step={index} label={label}/>)}
    </Stepper><h2 ref={stepHeading} tabIndex={-1}>{DEVELOPMENT_WIZARD_STEPS[wizardStep-1]}</h2></section>}
    {preorder?<p className="dx-doc-hint">先记录已知的面料及备料信息，其余客户、PO和配码资料在正式下单时补齐。</p>:!guided&&withOrder&&!published&&!initialCustomerOrderIsReady(form,confirmationCalendar)&&<p className="dx-doc-hint">订购信息待核实，可先发布开发资料；正式确认订单时再核对PO、颜色、尺码数量及客户约定出货日期。</p>}

    {!guided&&!source&&!existingDraft?.revisionSource&&<div className="development-order-intent" role="group" aria-label="确定客户订单">{([['development','无确定客户订单'],['preorder','预下单备料'],['certain_order','有确定客户订单']] as const).map(([value,label])=><Button key={value} type="button" aria-pressed={preorder?value==='preorder':intent===value} disabled={busy||published||submissionUnknown||!onIntentChange} onClick={()=>{setPreorder(value==='preorder');onIntentChange?.(value==='preorder'?'certain_order':value);}}>{label}</Button>)}</div>}
    {guided&&wizardStep===2&&document.workbenchSheet&&<p>
      {form.designStyleNo} · {document.workbenchSheet.styleName} · {document.workbenchSheet.boardType} · {document.template} · 工艺：{document.craft} · 附件 {document.files.length} 个
    </p>}
    {source && <p>沿用第 {source.adoptedRound ?? source.selectedRound ?? 1} 轮开发资料；头版/开发板与已有工序保持原档案。</p>}
    {error && <DocumentErrors error={error} issues={errorField?[{id:errorField,label:"定位需核实字段",message:error}]:[]} onLocateField={locateStep}/>}
    {calendarError?<p role="alert">{calendarError}</p>:!calendarReady&&<p role="status">正在读取本单日期…</p>}
    {(createdSource||calendarError)&&<Button type="button" disabled={busy} onClick={()=>setCalendarRefresh(value=>value+1)}>重新读取本单日期</Button>}
    {duplicateSource&&<a href={createWebUrls(import.meta.env.BASE_URL).pageUrl(`ui/digital-production?development=${duplicateSource}`)}>打开已有开发档案</a>}
    {!busy&&!published&&!submissionUnknown&&savedDraft === currentSnapshot && <p role="status">开发资料与订购草稿已保存，可返回列表后继续填写；发布和确认订单分别办理。</p>}
    {createdSource&&error&&<p role="status">{failedPhase==='confirm_check'?"本单时效检查未完成，本次客户订单确认尚未发送；资料仍保留，请重新检查。":failedPhase==='publish_check'?"本单时效检查未完成，本次开发发布尚未发送；草稿仍保留，请重新检查。":submissionUnknown||failedPhase==='confirm'||failedPhase==='publish'?developmentPublished?withOrder?"开发单已发布；本次客户订单确认未取得成功回执，请先核对原档案，再继续确认。":"开发单已发布，请打开原档案核对。":savedDraft===currentSnapshot?"当前草稿已保存；发布尚未取得成功回执，请先核对原档案再继续。":"当前填写尚未取得保存成功回执，输入仍保留；重试会沿用此档案。":developmentPublished?"开发资料已发布；本次办理尚未完成，请按上方原因处理。":"本次办理尚未完成；已保存内容在原档案，当前输入仍保留。"} <a className="dx-button dx-button--secondary" href={createWebUrls(import.meta.env.BASE_URL).pageUrl(`ui/digital-production?development=${createdSource}`)}>打开原开发档案</a></p>}
    {boundOrder&&<p role="status">订购草稿已随开发资料发布；确认与重试沿用已发布的 PO、数量和日期。</p>}
    {submissionUnknown&&<section aria-label="原提交结果待核对"><p role="status">{pendingSubmission.current?.operation==='publish'?'开发发布结果尚未确定，不能据此继续确认下单。':'正式确认结果尚未确定，尚不能显示已下单。'}原资料和操作标识已保留；先只读核对回执，查不到仍保持待核。</p><Button disabled={busy} onClick={()=>void recoverSubmission()}>只读核对原提交结果</Button><Button disabled={busy} onClick={()=>void recoverSubmission(true)}>沿原命令继续核对</Button></section>}
    <fieldset disabled={busy||!calendarReady||submissionUnknown}><fieldset disabled={Boolean(boundOrder)} className="development-order-fields"><div className="development-create-layout development-create-layout-existing">
    <div className="development-create-order"><section className="development-create-card" hidden={guided&&wizardStep===2}><h3>{guided&&wizardStep===3?"客户资料":"1 · 基本资料"}</h3><div className="development-create-grid" hidden={guided&&wizardStep!==1}>
      {intent !== "confirm_order" && <label>开发类型<select aria-label="开发类型" disabled={Boolean(createdSource)} value={developmentType} onChange={event => setDevelopmentType(event.target.value as "头版" | "开发板")}><option>头版</option><option>开发板</option></select></label>}
      <label>设计款号 / 业务ID（必填）<input id="development-create-style" aria-label="设计款号" required maxLength={100} value={form.designStyleNo} readOnly={Boolean(createdSource)} onBlur={event=>void findExistingSource(event.target.value)} onChange={event => {sourceSearchSequence.current++;setDuplicateSource(null);setCodeCheck(null);setForm({...form, designStyleNo: event.target.value});}}/>{!createdSource&&<div className="development-code-check"><Button type="button" disabled={busy||checkingCode||!form.designStyleNo.trim()} onClick={()=>void checkCode()}>{checkingCode?'检查编号中…':'检查业务ID'}</Button><small role="status">{codeCheck?.code===form.designStyleNo.trim()?(codeCheck.available?'该编号当前可用，提交时将再次检查':'该编号已有档案，请使用原档案或核对设计编号'):'填入设计业务ID后可检查是否已使用。'}</small></div>}</label>
      <label>代用款号（选填）<input maxLength={100} value={form.temporaryStyleNo ?? ""} readOnly={Boolean(createdSource)} onChange={event => setForm({...form, temporaryStyleNo: event.target.value || null})}/></label>
      <label>设计师（只读）<input aria-label="设计师（只读）" readOnly value={designerName ?? "正在确认身份…"}/></label>
{guided&&!preorder&&basicDevelopment}</div><div className="development-create-grid development-create-grid-secondary" hidden={guided&&(preorder||withOrder&&wizardStep===1)}>
      <label>客户{withOrder&&!preorder ? "（必填）" : "（选填）"}<SearchableSelect id="development-create-customer" aria-label="客户" required={withOrder&&!preorder} disabled={Boolean(createdSource && (fixedCustomer || !withOrder))} value={form.customerCode} onChange={event => {const customer = customers.find(customer => customer.code === event.target.value); setForm({...form, customerCode: event.target.value, primaryMerchandiserId: customer?.defaultMerchandiserId ?? null, productGroup: initialDigitalProductGroup(customers, event.target.value)});}}><option value="">通用开发 / 请选择</option>{customers.map(customer => <option key={customer.code} value={customer.code}>{customer.code} · {customer.name}</option>)}</SearchableSelect></label>
{(withOrder||guided&&Boolean(document.workbenchSheet)) && <><label>产品分组<select aria-label="产品分组" value={form.productGroup} onChange={event => setForm({...form, productGroup: event.target.value as DigitalOrderInput["productGroup"]})}>{(customers.find(customer => customer.code === form.customerCode)?.productGroups ?? [form.productGroup]).map(group => <option key={group}>{group}</option>)}</select></label>
        <label>销售年份<select aria-label="销售年份" value={form.salesYear??""} onChange={event=>setForm({...form,salesYear:event.target.value?Number(event.target.value):null})}><option value="">请选择年份</option>{salesYearOptions(calendarToday,form.salesYear).map(year=><option key={year} value={year}>{year}</option>)}</select></label>
        <label>销售系列<select aria-label="销售系列" value={form.salesSeries??""} onChange={event=>setForm({...form,salesSeries:event.target.value?SalesSeriesSchema.parse(event.target.value):null})}><option value="">请选择系列</option>{SalesSeriesSchema.options.map(series=><option key={series} value={series}>{series} · {Number(series.slice(1))}月上架</option>)}</select></label>
        <label>辅料是否需要对色<select aria-label="辅料是否需要对色" value={form.requiresColorMatching===true?'yes':form.requiresColorMatching===false?'no':''} onChange={event=>setForm({...form,requiresColorMatching:event.target.value===''?null:event.target.value==='yes'})}><option value="">尚未确定</option><option value="yes">需要对色（A路线）</option><option value="no">无需对色（B路线）</option></select></label>
        {withOrder&&<label>客户下单日期（必填）<input id="development-customer-order-date" aria-label="客户下单日期" required max={calendarToday} type="date" value={form.orderDate} onChange={event => setForm({...form, orderDate: event.target.value})}/></label>}
</>}{!guided&&basicDevelopment}</div></section>
    {withOrder&&(!guided||!preorder&&wizardStep===3) && <section className="development-create-card development-create-details"><h3>2 · 客户订单明细 <small>默认主跟单：{customers.find(customer=>customer.code===form.customerCode)?.defaultMerchandiserName??"未配置，待主管指派"}</small></h3>
      {guided&&sharedPoColumns&&form.lines.length>1&&!boundOrder&&<Button type="button" onClick={()=>setSharedPoColumns(false)}>分别编辑各 PO 尺码</Button>}
      {!sharedPoColumns&&<p className="development-legacy-po-note">各 PO 尺码按原行保留；修改尺码只影响该 PO，订购数量不会并入其它尺码。</p>}
      <div className="development-table-scroll" role="region" aria-label="PO 明细，可左右滑动查看全部列" tabIndex={0}>
        <table className="development-create-po-table" style={{minWidth:600+maxPoSizeCount*240+(form.lines.length>1?90:0)}}><thead><tr>
          <th className="development-po-index">PO</th><th className="development-po-number">正式款号 / PO</th><th className="development-po-color">颜色 *</th>
          {Array.from({length:maxPoSizeCount},(_,sizeIndex)=><th className="development-size-column" key={poSizeIds.current[sizeIndex]}><span className="development-size-label">尺码与订购数量 · {sizeIndex+1}</span>{sharedPoColumns&&form.lines[0]!.sizes.length>1&&<button type="button" aria-label={`删除尺码列 ${sizeIndex+1}`} onClick={async()=>{if(await confirmInApp("删除这个尺码列及所有 PO 对应订购数量？")&&!writing.current){poSizeIds.current.splice(sizeIndex,1);setForm(current=>({...current,lines:current.lines.map(row=>({...row,sizes:row.sizes.filter((_,i)=>i!==sizeIndex)}))}));}}}>×</button>}</th>)}
          <th className="development-row-total">合计（件）</th><th className="development-po-date">{customerPoDateLabel}</th>{form.lines.length > 1 && <th className="development-po-actions">删除 PO</th>}
        </tr></thead><tbody>{form.lines.map((value, index) => <tr key={index}>
          <th className="development-po-index">{index + 1}</th>
          <td className="development-po-number"><input aria-label={`PO ${index + 1} 正式款号 / PO`} placeholder="选填，可后补" maxLength={100} value={value.formalPoNo ?? ""} onChange={event => line(index, {formalPoNo: event.target.value || null})}/></td>
          <td className="development-po-color"><input id={`development-po-color-${index+1}`} aria-label={`PO ${index + 1} 颜色`} placeholder="颜色（必填）" required maxLength={100} value={value.color} onChange={event => line(index, {color: event.target.value})}/><input aria-label={`PO ${index + 1} 颜色外文`} placeholder="颜色外文（选填）" maxLength={100} value={value.colorForeign ?? ""} onChange={event => line(index, {colorForeign: event.target.value || null})}/></td>
          {value.sizes.map((size, sizeIndex) => {
            const quantityError = developmentQuantityError(size.quantity), errorId = `development-quantity-error-${index}-${sizeIndex}`;
            return <td className="development-size-column" key={poSizeIds.current[sizeIndex]}><div className="development-po-size-pair"><label><span>尺码</span>{(index===0||!sharedPoColumns)?<input aria-label={index===0?`尺码列 ${sizeIndex+1}`:`PO ${index+1} 尺码 ${sizeIndex+1}`} placeholder="如 M / 36" required maxLength={100} value={size.size} onChange={event=>setForm(current=>({...current,lines:current.lines.map((row,rowIndex)=>sharedPoColumns||rowIndex===index?{...row,sizes:row.sizes.map((item,i)=>i===sizeIndex?{...item,size:event.target.value}:item)}:row)}))}/>:<span className="development-po-shared-size" aria-label={`PO ${index+1} 尺码 ${sizeIndex+1}`}>{size.size||"待首行填写"}</span>}{!sharedPoColumns&&value.sizes.length>1&&<button type="button" aria-label={`删除 PO ${index+1} 尺码项 ${sizeIndex+1}`} onClick={async()=>{if(await confirmInApp(`删除 PO ${index+1} 的 ${size.size||`第${sizeIndex+1}项尺码`} 及其订购数量？`)&&!writing.current)line(index,{sizes:value.sizes.filter((_,position)=>position!==sizeIndex)});}}>×</button>}</label><label className="development-quantity-field"><span>数量</span><input aria-label={`PO ${index+1} 订购数量 ${sizeIndex+1}`} type="text" inputMode="numeric" maxLength={8} placeholder="件数" value={size.quantity} aria-invalid={quantityError!==null} aria-describedby={quantityError?errorId:undefined} onChange={event=>line(index,{sizes:value.sizes.map((item,i)=>i===sizeIndex?{...item,quantity:event.target.value}:item)})}/></label></div>{quantityError&&<small className="development-quantity-error" id={errorId} role="alert">{quantityError}</small>}</td>;
          })}{Array.from({length:maxPoSizeCount-value.sizes.length},(_,position)=><td className="development-size-column" key={`absent-${position}`} aria-label={`PO ${index+1} 无此尺码项`}>{!sharedPoColumns&&position===0?<Button type="button" disabled={value.sizes.length>=50} onClick={()=>line(index,{sizes:[...value.sizes,{size:"",quantity:""}]})}>补充本 PO 尺码</Button>:"—"}</td>)}
          <td className="development-row-total">{rowTotals[index] === null ? <span className="development-quantity-error">请修正数量</span> : rowTotals[index]?.toLocaleString()}</td>
          <td className="development-po-date"><input id={`development-po-date-${index+1}`} aria-label={`PO ${index + 1} ${customerPoDateLabel}`} type="date" min={dateMinimum} value={value.customerWarehouseArrivalDate ?? ""} onChange={event => customerDate(index, event.target.value || null)}/></td>
          {form.lines.length > 1 && <td className="development-po-actions"><Button type="button" onClick={async () => {if (await confirmInApp("删除这个 PO 和全部订购数量？") && !writing.current) removeLine(index);}}>删除 PO</Button></td>}
        </tr>)}</tbody></table>
      </div>
      <div className="development-create-line-actions"><Button type="button" disabled={form.lines.length >= 50} onClick={() => setForm(current => ({...current, lines: [...current.lines, inheritPoDate({...newLine(), sizes: current.lines[0]!.sizes.map(size => ({size:size.size, quantity:""}))}, current.lines[0], "customerWarehouseArrivalDate")]}))}>添加款色 / PO</Button>
        <Button type="button" disabled={maxPoSizeCount >= 50} onClick={() => {poSizeIds.current.push(createClientRequestId());setForm(current => ({...current, lines: current.lines.map(row => ({...row, sizes: [...row.sizes, {size:"", quantity:""}]}))}));}}>添加尺码列</Button>
        <strong className="development-total-quantity" role="status">总订购数量：{totalQuantity === null ? <span className="development-quantity-error">请修正数量</span> : `${totalQuantity.toLocaleString()} 件`}</strong>
      </div></section>}
    </div></div></fieldset>
    {!source&&<div className="development-editor dx-doc-development">
      <DocumentErrors issues={issues} onLocateField={locateStep}/>
      {pictures.filter(picture=>picture.error).map(picture=><p key={picture.id} role="alert">{picture.file.name}：{picture.error}</p>)}
      {guided&&!preorder&&wizardStep===1&&document.workbenchSheet&&
        <WorkbenchDevelopmentSheetFields sheet={document.workbenchSheet} readonly={busy||published} issue={id=>issues.find(value=>value.id===id)?.message}
          onChange={workbenchSheet=>edit({workbenchSheet})}/>}
      <div hidden={guided&&wizardStep===3}><DevelopmentDocumentFields locatingField={locatingField} creationView={guided?(preorder?"preorder":wizardStep===1?"sheet":"requirements"):undefined} fixedCraft={fixedCraft} materialFactsReadonly={Boolean(creation||existingDraft?.draftDocumentDate||existingDraft?.materialForecastOnly)} sectionStart={withOrder?3:2} basicDetailsExternal uploadHelp="选择后可预览，保存草稿或发布时上传；失败资料仍保留。" document={document} edit={edit} readonly={published} busy={busy} writing={writing} sizeQuantityInputs={sizeQuantityInputs} setSizeQuantityInputs={setSizeQuantityInputs} quantityInput={quantityInput} setQuantityInput={setQuantityInput} measurementIds={measurementIds} successfulUploads={successfulUploads} fileIdentity={id=>{const picture=picturesRef.current.find(picture=>picture.id===id||picture.attachmentId===id);const missing=lostLocalFiles.find(file=>file.id===id);return picture?{filename:picture.file.name,mimeType:picture.file.type,sizeBytes:picture.file.size}:missing?{filename:missing.name,mimeType:missing.type,sizeBytes:missing.size}:undefined;}} metadataPath={id=>createdSource&&!lostLocalFiles.some(file=>file.id===id)&&!picturesRef.current.some(picture=>picture.id===id&&!picture.attachmentId)?`sources/${createdSource}/development/attachments/${id}/metadata`:undefined} imageUrl={id=>lostLocalFiles.some(file=>file.id===id)?'':picturesRef.current.find(picture=>picture.id===id||picture.attachmentId===id)?.preview??createWebUrls(import.meta.env.BASE_URL).apiUrl(`digital-production/sources/${createdSource}/development/attachments/${id}`)} upload={selectPictures} fileKind={fileKind} setFileKind={setFileKind} issue={id=>issues.find(value=>value.id===id)?.message} patternSection={!published&&existingDraft?.revisionSource?.outputKind!=='工艺布片'?<div id="development-pattern-preparation"><DevelopmentPatternLink busy={busy} preparing selectedCategoryId={document.patternCategoryId??""} onCategoryChange={categoryId=>edit({patternCategoryId:categoryId||null})} onSelection={setPatternChoice}/></div>:null}/></div>
    </div>}
    </fieldset>
    {calendar?.orderTimeEnabled&&withOrder&&!preorder&&(!guided||wizardStep===3)&&<OrderTimeProductionRoute value={document.productionPlanning} disabled={busy} onChange={productionPlanning=>edit({productionPlanning})}/>}
    {timeApplication.dialog}
    {!calendar?.orderTimeEnabled&&withOrder&&!preorder&&(!guided||wizardStep===3)&&shortInput&&dateMinimum&&initialCustomerDateErrors(shortInput.lines,dateMinimum).length>0&&<ShortLeadPanel key={createdSource??'new'} sourceId={createdSource} order={shortInput} onState={setShortState} readOnly={submissionUnknown} {...(!source&&!published?{saveDraft:async()=>{if(!await save(true))throw new Error("原开发草稿尚未保存成功；请先核对表单错误，再提交本来源的特批申请。");}}:{})}/>}
  </form>{createdSource&&preorder&&(!guided||Boolean(loadedVersion.current))&&<ProductionReadinessPanel resource={{kind:"source",id:createdSource}} {...(guided?{focusKind:"design_handover",handoverSubmitLabel:"提交备料交接"}:{})} sourceDocumentVersion={loadedVersion.current??undefined} readonly={busy||dirty.current}/>}</Surface>;
}

export function ResumeDevelopmentCreateForm({sheet,onClose,onCreated,onViewPublished,contained=false}:{contained?:boolean;sheet:DevelopmentSheet;onClose:()=>void;onCreated:(sourceId:string,orderId:string|null)=>void;onViewPublished?:()=>void}) {
  const [options,setOptions]=useState<{customers:DigitalCustomer[];minimumInitialCustomerDate?:string;serverToday?:string;orderTimeEnabled?:boolean}|null>(null);
  const [error,setError]=useState("");
  const [intent,setIntent]=useState<"development"|"certain_order">(sheet.document?.customerOrderDraft?.withOrder?"certain_order":"development");
  useEffect(()=>{let live=true;setOptions(null);setError('');void digitalRequest<{customers:DigitalCustomer[];minimumInitialCustomerDate?:string;serverToday?:string;orderTimeEnabled?:boolean}>(developmentOrderOptionsPath(sheet.sourceId)).then(value=>{if(live)setOptions(value);}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:"读取客户资料失败");});return()=>{live=false;};},[sheet.sourceId]);
  return error?<p role="alert">{error}</p>:!options?<p role="status">正在读取开发草稿…</p>:<>{sheet.status==="published"&&onViewPublished&&<Button type="button" onClick={onViewPublished}>查看已发布资料、版本与办理</Button>}<DevelopmentCreateForm contained={contained} existingDraft={sheet} guidedCreation={sheet.status==="draft"&&sheet.document?.customerOrderDraft?.wizardStep!==undefined} orderTimeEnabled={options.orderTimeEnabled} intent={intent} customers={options.customers} minimumDate={options.minimumInitialCustomerDate} serverToday={options.serverToday} calendarSourceId={sheet.sourceId} onIntentChange={setIntent} onCancel={onClose} onCreated={onCreated}/>{sheet.canEdit&&<a className="dx-button dx-button--secondary" href={quotationHref({kind:"source",id:sheet.sourceId},window.location.pathname+window.location.search)}>客户报价协作</a>}</>;
}
