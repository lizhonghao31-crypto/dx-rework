import type {DevelopmentTechnicalState,DevelopmentUploadPurpose} from '@dx-rework/contracts/digital-development-technical';
import {DEVELOPMENT_PURPOSE_TASK_KIND} from '@dx-rework/contracts/digital-development-technical';
import {DevelopmentTechnicalNode,DevelopmentTechnicalSummary,DevelopmentFinalFeedback,technicalInspectionDocument} from './development-technical-workspace.js';
import {DevelopmentInspectionMeasurements,inspectionMeasurementsFromForm} from "./development-inspection-measurements.js";
import {uploadAttachmentWithRecovery} from "./attachment-upload-recovery.js";
import {DevelopmentMaterialReopenReceiptSchema} from '@dx-rework/contracts/digital-development-execution';
import {useTodoContentRead} from './todo-content-read.js';
import {developmentMakingBasis} from '@dx-rework/contracts/digital-development';
import {DevelopmentMakingUpgradeFields,makingUpgradeFromForm} from './development-making-upgrade.js';
import {developmentMakingSizes} from "@dx-rework/contracts/digital-development";
import {DevelopmentAmendmentPanel} from "./development-amendment-panel.js";
import type {MaterialVerification} from "@dx-rework/contracts/digital-development-execution";
import {DevelopmentFabricDecisions,type FabricCase} from "./development-fabric-decisions.js";
import type {DevelopmentArrangement} from "@dx-rework/contracts/development-arrangement";
import {navigateInternalPage} from "./internal-navigation.js";
import {roleLabel} from "./components.js";
import {useDigitalDetailNavigationGuard} from "./use-digital-detail-navigation-guard.js";
import {developmentActionReceipt} from "./digital-operation-feedback.js";
import {submittedDevelopmentUploads,settleDevelopmentUploads} from './development-submitted-uploads.js';
import {DigitalReadFailure,asDigitalReadError} from './digital-read-failure.js';
import {DevelopmentAssignmentTable} from "./development-assignment-table.js";
import {DevelopmentMaterialCheck} from "./development-material-check.js";
import {WorkbenchAction} from "./workbench-action.js";
import {DevelopmentResultUpload} from "./development-result-upload.js";
import {useDocumentUploadPreviews,type UploadFailureSnapshot} from "./document-upload-previews.js";
import {DevelopmentFabricReport} from "./development-fabric-report.js";
import {DocumentEntryScope,DocumentEntry} from "./document-entry-scope.js";
import { SearchableSelect } from "./search-select.js";
import { digitalTaskDisplayStatus } from "./digital-workspace-copy.js";
import {DEVELOPMENT_REVISION_NODES,DEVELOPMENT_PROBLEM_CATEGORIES} from "@dx-rework/contracts/digital-development-rounds";
import {DevelopmentExternalPattern} from "./development-external-pattern.js";
import {DevelopmentPatternLink} from "./development-pattern-link.js";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {Button} from "@dx-rework/ui";
import type {DigitalTask} from "@dx-rework/contracts/digital-production-tasks";
import {type DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import {digitalRequest,DigitalRequestError} from "./digital-production-api.js";
import {createClientRequestId} from "./client-request-id.js";
import {createWebUrls} from "../url-contract.js";
import {DevelopmentOccurrenceInput,developmentTimeFromForm} from './development-occurrence-input.js';
type RouteFact={factId:string;kind:string;routeVersion:number;taskId:string|null;payload:{inspection?:{phase:string;unit:string;sizes:string[];measurements:Array<{name:string;values:string[]}>};note?:string;sentDate?:string;trackingNo?:string;attachmentIds?:string[];actualCompletedAt?:string|null;actualCompletedDate?:string|null;timeQuality?:string};recordedAt:string};
export type ExternalPatternRecord={requestId:string;roundNumber:number;actualDeparture?:string|null;intervalVersion?:number;actualDepartureQuality?:string|null;departureHistory?:Array<{version:number;departedAt:string|null;quality:string;note:string;recordedAt:string;recordedBy:string}>;requestedAt:string;requestedBy:string;receivedAt:string|null;receivedBy:string|null;note:string;receiptNote:string|null;attachmentIds:string[]|null;taskId:string};
type State={technical?:DevelopmentTechnicalState;externalPatterns?:ExternalPatternRecord[];canRequestExternalPattern?:boolean;sewingRecipientName?:string|null;slaEnrolled?:boolean;fixedCutting?:{version:number;assigneeId:string|null;assigneeName:string|null;valid:boolean;canConfigure:boolean}|null;reopenMaterialCheck?:{taskId:string;supplyTaskId:string;roundNumber:number;expectedDocumentVersion:number;expectedVerificationVersion:number}|null;materialVerification?:MaterialVerification|null;fabricCases?:FabricCase[];unifiedArrangement?:boolean;arrangement?:DevelopmentArrangement|null;materialReadiness?:Array<{usage?:"use"|"unused"|"pending";required?:boolean;materialId:string;available:boolean;verified:boolean;missing:string[];evidenceId:string|null}>;supplementCheckTaskId?:string|null;nextSteps?:Array<{taskId:string;label:string}>;canConfirmExecution?:boolean;patternPreparation?:{version:number;roundId:string;roundType:string;status:string;categorySaved:boolean;priceSaved:boolean;workerId:string|null;workerName:string|null}|null;patternOrder:{orderId:string}|null;routeFacts:RouteFact[];sheet:DevelopmentSheet;dispatch:{version:number;patternWorkerId:string;cuttingWorkerId:string;sewingWorkerId:string}|null;tasks:DigitalTask[];facts:{factId:string;taskId:string|null;kind:string;payload:{note?:string;recommendation?:string;decision?:string;attachmentIds?:string[];items?:Array<{materialId:string;physical:boolean;quantity:boolean;color:boolean;specification:boolean}>};recordedAt:string}[];canReportFabric:boolean;canDispatch:boolean;canDecideFabric:boolean;qrAvailable:boolean};
export function useDevelopmentExecution({sourceId,materialRevision=0,taskId,onChanged,workspace=false,onPatternOrderLoaded,onPreassignedSewingLoaded}:{sourceId:string;materialRevision?:number;taskId?:string|undefined;onChanged?:((notice?:string)=>void)|undefined;workspace?:boolean;prioritizeMaterialCheck?:boolean;onPatternOrderLoaded?:((id:string|null)=>void)|undefined;onPreassignedSewingLoaded?:((person:{id:string;name:string}|null)=>void)|undefined}){
  const previews=useDocumentUploadPreviews({onFailureRemoved:message=>setError(current=>current===message?'':current)});
  const [state,setState]=useState<State|null>(null),[people,setPeople]=useState<{id:string;displayName:string;roles:string[]}[]>([]),[peopleFor,setPeopleFor]=useState<string|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [technicalUploads,setTechnicalUploads]=useState<Partial<Record<DevelopmentUploadPurpose,string[]>>>({});
  // Compatibility fields are views of the same pending-reference state.
  const craftFiles=[...new Set([...(technicalUploads['工艺开发板']??[]),...(technicalUploads['纸样成果']??[])])],reportFiles=technicalUploads['面料报告']??[],sewingFiles=technicalUploads['车板成果']??[],tailFiles=technicalUploads['尾查照片']??[],externalFiles=technicalUploads['外部纸样']??[];
  const [uncertainWrite,setUncertainWrite]=useState(false),[committedWrite,setCommittedWrite]=useState<{path:string;key:string}|null>(null);
  const [writeOutcome,setWriteOutcome]=useState<{path:string;phase:'writing'|'committed'|'complete'|'unknown'|'rejected'}|null>(null);
  const [reopenReceipt,setReopenReceipt]=useState<{taskId:string;target:string}|null>(null);
  const [checkReceipt,setCheckReceipt]=useState<{round:number;target:string}|null>(null),[navigationFailed,setNavigationFailed]=useState(false);
  useEffect(()=>{if(!checkReceipt||busy)return;void navigateInternalPage(checkReceipt.target).then(ok=>{if(!ok)setNavigationFailed(true);}).catch(()=>setNavigationFailed(true));},[checkReceipt,busy]);
  useEffect(()=>{if(reopenReceipt&&!busy)void navigateInternalPage(reopenReceipt.target).catch(()=>undefined);},[reopenReceipt,busy]);
  useEffect(()=>{setReopenReceipt(null);},[sourceId]);
  const uncertainWritePending=useRef(false),unresolvedWrite=useRef(false);
  const [readError,setReadError]=useState<Error|null>(null),[peopleError,setPeopleError]=useState<Error|null>(null),[reading,setReading]=useState(false),[peopleReading,setPeopleReading]=useState(false);
  const [tailReturn,setTailReturn]=useState<Record<string,boolean>>({});
  const writing=useRef(false),operation=useRef<{payload:string;key:string;path:string;body:unknown;method:string;uploadSource:string;uploadEpoch:number;uploadTaskId:string|undefined;uploadFailures:UploadFailureSnapshot}|null>(null),base=`sources/${sourceId}/execution`,urls=createWebUrls(import.meta.env.BASE_URL);
  useDigitalDetailNavigationGuard(uncertainWrite,busy,writing,"本次办理已提交但最新状态未确认；离开会丢失本页未保存输入与重试记录，仍要离开？");
  const loadVersion=useRef(0);
  const uploadEpoch=useRef(0),activeUpload=useRef(false);
  useEffect(()=>{uploadEpoch.current++;previews.reset();setTechnicalUploads({});if(activeUpload.current){activeUpload.current=false;writing.current=false;setBusy(false);}return()=>{uploadEpoch.current++;};},[sourceId,taskId,state?.sheet.roundNumber]);
  const loadPeople=async(next:State,version=loadVersion.current)=>{
    setPeopleError(null);setPeopleReading(true);
    try{const candidates=await digitalRequest<typeof people>('access/candidates');if(version!==loadVersion.current)return;setPeople(candidates);setPeopleFor(`${sourceId}:${next.arrangement?.version??next.dispatch?.version??0}`);const sewing=candidates.find(person=>person.id===next.dispatch?.sewingWorkerId);onPreassignedSewingLoaded?.(sewing?{id:sewing.id,name:sewing.displayName}:null);}
    catch(reason){if(version===loadVersion.current)setPeopleError(asDigitalReadError(reason));}
    finally{if(version===loadVersion.current)setPeopleReading(false);}
  };
  const retryPeople=()=>state&&!writing.current?loadPeople(state):Promise.resolve();
  const load=async()=>{
    const version=++loadVersion.current;setReadError(null);setReading(true);setPeopleReading(false);
    try{
      const next=await digitalRequest<State>(base);if(version!==loadVersion.current)return;
      setState(next);setReading(false);onPatternOrderLoaded?.(next.patternOrder?.orderId??null);
      const checkingMaterials=workspace&&next.tasks.some(task=>task.taskId===taskId&&['development_materials','development_material_recheck'].includes(task.taskKind));
      if(!checkingMaterials&&(next.canDispatch||next.sheet.canEdit))await loadPeople(next,version);else{setPeopleError(null);setPeopleReading(false);}
      if(version!==loadVersion.current)return;
      if(uncertainWritePending.current){uncertainWritePending.current=false;setUncertainWrite(false);operation.current=null;setError("");}
      return next;
    }catch(reason){if(version===loadVersion.current)setReadError(asDigitalReadError(reason));}
    finally{if(version===loadVersion.current)setReading(false);}
  };
  useEffect(()=>{void load();return()=>{loadVersion.current++;};},[sourceId,materialRevision]);
  useEffect(()=>{if(typeof window==="undefined"||!state)return;const id=taskId??new URLSearchParams(window.location.search).get("task");if(id)document.getElementById(`development-task-${id}`)?.scrollIntoView({block:"nearest"});},[taskId,state]);
  const settleCompletedFailures=(prior:NonNullable<typeof operation.current>,next:State)=>{
    if(prior.uploadSource!==next.sheet.sourceId||prior.uploadEpoch!==uploadEpoch.current||!prior.uploadTaskId)return;
    if(next.tasks.some(task=>task.taskId===prior.uploadTaskId&&task.state==='completed'))previews.settleFailures(prior.uploadFailures);
  };
  const recheck=async()=>{if(writing.current)return;if(unresolvedWrite.current&&operation.current){const prior=operation.current;return run(prior.path,prior.body,prior.method,true);}writing.current=true;setBusy(true);try{const prior=operation.current,updated=await load();if(updated&&prior&&(committedWrite?.key===prior.key&&committedWrite.path===prior.path||prior.path==='material-verification')){settleCompletedFailures(prior,updated);setWriteOutcome({path:prior.path,phase:'complete'});onChanged?.(workspace?developmentActionReceipt(prior.path,prior.body as {result?:unknown},undefined,updated.tasks):undefined);}return updated;}finally{writing.current=false;setBusy(false);}};
  const run=async(path:string,body:unknown,method="POST",retry=false):Promise<State|undefined>=>{
    if(writing.current)return;
    if(unresolvedWrite.current&&!retry){setError("上次提交结果尚未确认，请先核对并重试原提交；不会重复产生业务记录。");return;}
    if(uncertainWritePending.current){setError("本次办理已提交，请先重新读取办理状态。");return;}
    const hadUnknown=unresolvedWrite.current;
    writing.current=true;setBusy(true);setError("");setWriteOutcome({path,phase:"writing"});
    const payload=JSON.stringify([path,body,method]);
    const submittedUploads=submittedDevelopmentUploads(path,body),input=body as {taskId?:string;action?:string;requestId?:string}|null;
    const uploadTaskId=input?.taskId??(path==='external-pattern'&&input?.action==='receive'?state?.externalPatterns?.find(record=>record.requestId===input.requestId)?.taskId:undefined);
    if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId(),path,body,method,uploadSource:sourceId,uploadEpoch:uploadEpoch.current,uploadTaskId,uploadFailures:previews.failedSnapshot(submittedUploads.purposes,uploadTaskId)};
    const submittedOperation=operation.current;
    try{
      const receipt=await digitalRequest(`${base}/${path}`,method,body,operation.current.key);
      if(path==='reopen-materials'){
        const parsed=DevelopmentMaterialReopenReceiptSchema.safeParse(receipt),input=body as {taskId:string;roundNumber:number};
        if(!parsed.success||parsed.data.roundNumber!==input.roundNumber||parsed.data.taskId===input.taskId)throw new DigitalRequestError('未收到可核对的重核回执，请核对原提交，不要重复建立任务',null);
        setReopenReceipt({taskId:parsed.data.taskId,target:`${urls.pageUrl("ui/digital-production")}?task=${parsed.data.taskId}`});
      }
      setCommittedWrite({path,key:operation.current.key});setWriteOutcome({path,phase:"committed"});
      unresolvedWrite.current=false;uncertainWritePending.current=true;setUncertainWrite(true);
      if(submittedUploads.ids.length){previews.saved(submittedUploads.ids,submittedUploads.purposes);setTechnicalUploads(current=>settleDevelopmentUploads(current,submittedUploads));}
      const submitted=state?.tasks.find(task=>task.taskId===(body as {taskId?:string})?.taskId);
      const completedCheck=path==="check"&&(body as {result?:string}).result==="通过";
      if(path==="reopen-materials"){uncertainWritePending.current=false;setUncertainWrite(false);}
      if(completedCheck){
        const round=submitted?.routeVersion??state?.sheet.roundNumber??1;
        try{sessionStorage.setItem(`development-check:${sourceId}:${round}`,"completed");}catch{/* The confirmed receipt remains on this page even if browser storage is unavailable. */}
        uncertainWritePending.current=false;setUncertainWrite(false);operation.current=null;onChanged?.("核料已完成");
        setCheckReceipt({round,target:`${urls.pageUrl("ui/digital-production")}?arrangement=${sourceId}&round=${round}`});
      }
      const updated=await load();
      if(!updated){setError(completedCheck?"核料已完成，正在打开本轮委派页。":"本次办理已提交，但最新资料暂未读取到，请重新读取；不要重复提交。");return;}
      settleCompletedFailures(submittedOperation,updated);
      operation.current=null;setWriteOutcome({path,phase:"complete"});
      onChanged?.(workspace?developmentActionReceipt(path,body as {result?:unknown},submitted,updated.tasks):undefined);
      return updated;
    }catch(reason){
      if(!(reason instanceof DigitalRequestError)||reason.resultUnknown||(path==="reopen-materials"&&hadUnknown)){setWriteOutcome({path,phase:"unknown"});unresolvedWrite.current=true;setUncertainWrite(true);setError(`${reason instanceof Error?reason.message+"；":""}尚未确认本次提交是否成功。请核对并重试原提交，系统沿用同一操作标识，避免重复保存。`);}
      else{setWriteOutcome({path,phase:"rejected"});unresolvedWrite.current=false;setUncertainWrite(false);operation.current=null;setError(reason.message);}
    }finally{writing.current=false;setBusy(false);}
  };
  const upload=async(selected:File[],purpose:DevelopmentUploadPurpose,forTaskId=taskId)=>{
    if(!selected.length||writing.current)return;const context=uploadEpoch.current;activeUpload.current=true;previews.start(selected,purpose,files=>upload(files,purpose,forTaskId),forTaskId);writing.current=true;setBusy(true);setError('');
    try{const limit=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
      for(const file of selected){if(context!==uploadEpoch.current)return;try{
        if(file.size>limit.maxUploadBytes)throw Error('文件超过原上传大小限制');
        const actualFile=purpose==='纸样成果'&&state?.technical?.enrolled&&/\.plt$/i.test(file.name)?new File([file],file.name,{type:'application/octet-stream',lastModified:file.lastModified}):file;
        const ready=await uploadAttachmentWithRecovery(actualFile,`execution:${base}:${forTaskId??''}:${state?.sheet.roundNumber??1}:${purpose}`,{
          createIntent:input=>digitalRequest(`${base}/upload-intents`,'POST',{...input,purpose,...(DEVELOPMENT_PURPOSE_TASK_KIND[purpose]?{taskId:forTaskId}:{})}),
          finalize:id=>digitalRequest(`${base}/attachments/${id}/finalize`,'POST',{}),
        },undefined,undefined,file);
        if(context!==uploadEpoch.current)return;previews.uploaded(file,ready.attachmentId);
        setTechnicalUploads(current=>({...current,[purpose]:[...new Set([...(current[purpose]??[]),ready.attachmentId])]}));
      }catch(reason){if(context!==uploadEpoch.current)return;const message=reason instanceof Error?reason.message:'附件尚未取得就绪回执';previews.failed(file,message);setError(message);}}
    }catch(reason){if(context===uploadEpoch.current){const message=reason instanceof Error?reason.message:'附件授权未完成';for(const file of selected)previews.failed(file,message);setError(message);}}
    finally{if(context===uploadEpoch.current){activeUpload.current=false;writing.current=false;setBusy(false);}}
  };
  return {reopenReceipt,writeOutcome,committedWrite,checkReceipt,navigationFailed,load,recheck,uncertainWrite,retryPeople,reading,readError,peopleError,peopleReading,writeError:error,previews,state,people,peopleFor,error:error||(readError?.message??'')||(peopleError?.message??''),busy,technicalUploads,craftFiles,reportFiles,sewingFiles,tailFiles,externalFiles,tailReturn,setTailReturn,base,urls,run,upload,writing};
}
type ExecutionProps=Parameters<typeof useDevelopmentExecution>[0];
export function DevelopmentExecutionPanel(props:ExecutionProps){const controller=useDevelopmentExecution(props);return <DevelopmentExecutionBody {...props} controller={controller}/>;}
export function DevelopmentExecutionBody({sourceId,taskId,workspace=false,taskOnly=false,separateCustomer=false,controller}:{controller:ReturnType<typeof useDevelopmentExecution>;taskOnly?:boolean;separateCustomer?:boolean}&ExecutionProps){
  const {state,people,error,writeError,readError,peopleError,reading,peopleReading,recheck,retryPeople,busy,uncertainWrite,craftFiles,sewingFiles,tailFiles,tailReturn,setTailReturn,base,urls,run}=controller;
  const [reopenNote,setReopenNote]=useState("");
  const readTask=state?.tasks.find(task=>task.taskId===taskId);
  const readRef=useTodoContentRead({routeName:'digital_production_task',entityId:taskId??'',developmentRound:readTask?.routeVersion},Boolean(state&&readTask&&!readError&&readTask.taskKind!=='development_material_supply'&&(!['development_materials','development_material_recheck'].includes(readTask.taskKind)||state.materialVerification)));
  if(!state)return readError?<DigitalReadFailure error={readError} onRetry={()=>void recheck()} retryLabel="重试读取办理记录" busy={reading}/>:error?<p role="alert">{error}</p>:<p role="status">正在读取办理记录…</p>;
  const selectedTask=state.tasks.find(task=>task.taskId===taskId);
  const materialCheck=workspace&&Boolean(selectedTask&&["development_materials","development_material_recheck"].includes(selectedTask.taskKind));
  const inspectionDoc=technicalInspectionDocument(state.sheet.document,state.technical);
  const assignmentControls=<DevelopmentAssignmentTable controller={controller}/>;
  const wrap=(content:ReactNode)=>taskOnly?content:<DocumentEntryScope taskId={taskId} sourceId={sourceId} round={selectedTask?.routeVersion??state.sheet.roundNumber??1}>{content}</DocumentEntryScope>;
  return wrap(<section ref={readRef} className="development-controls" data-material-check={materialCheck||undefined}>{!taskOnly&&controller.checkReceipt&&<p role="status">核料已完成。{controller.navigationFailed?"委派页暂未打开；无需再次提交核料。":"正在打开本轮委派页…"}<a href={controller.checkReceipt.target}>重新打开本轮委派页</a></p>}{!taskOnly&&<h3>{materialCheck?"核料办理":"开发办理"}</h3>}{!taskOnly&&!materialCheck&&(state.patternPreparation?<p>原执行品类 / 价格快照：{state.patternPreparation.categorySaved&&state.patternPreparation.priceSaved?"已保存":"待补齐"}；车板执行归属：{state.patternPreparation.workerName??"待安排与真实前置齐备后衔接"}</p>:<p>原打板执行准备：{state.patternOrder?"状态待读取":"尚未建立，请原设计师提交品类与执行价"}</p>)}{!taskOnly&&writeError&&<p role="alert">{writeError}</p>}{!taskOnly&&reading&&<p role="status">正在更新办理资料…</p>}{!taskOnly&&readError&&<><DigitalReadFailure error={readError} onRetry={()=>void recheck()} retryLabel="重试读取办理记录" busy={reading}/><p>当前显示上次成功读取的资料。</p></>}{!taskOnly&&peopleReading&&<p role="status">正在读取岗位选项…</p>}{!taskOnly&&peopleError&&<DigitalReadFailure error={peopleError} onRetry={()=>void retryPeople()} retryLabel="重试读取岗位选项" busy={peopleReading}/>}{!taskOnly&&uncertainWrite&&<Button disabled={busy} onClick={()=>void recheck()}>重新读取办理状态</Button>}
    {!taskOnly&&!workspace&&(state.patternOrder?<p><a href={urls.pageUrl(`ui/pattern-room/orders/${state.patternOrder.orderId}`)}>查看原执行记录 / 特殊费用处理</a></p>:state.sheet.canEdit&&<DevelopmentPatternLink busy={busy} onSubmit={input=>void run("pattern-order",input)}/>)}
    {!taskOnly&&!materialCheck&&assignmentControls}
    {!taskOnly&&!materialCheck&&state.technical?.enrolled&&<DevelopmentTechnicalSummary controller={controller}/>}
    {state.slaEnrolled&&(!taskId||selectedTask?.taskKind==='development_pattern')&&<details><summary>外部纸样</summary><DevelopmentExternalPattern controller={controller}/></details>}
    {selectedTask?.taskKind==='development_external_pattern'&&<DevelopmentExternalPattern controller={controller}/>}
    {taskId&&!state.tasks.some(task=>task.taskId===taskId)&&<p>该任务已转入历史。请通过任务历史或对应开发轮次查看。</p>}
    {!taskOnly&&workspace&&taskId&&<DevelopmentTaskBasis state={state} taskId={taskId}/>}
    {state.tasks.filter(task=>!taskId||task.taskId===taskId).map(task=><section key={task.taskId} id={`development-task-${task.taskId}`}>{!taskOnly&&!materialCheck&&<h4>第{task.routeVersion}轮 · {task.label} · {digitalTaskDisplayStatus(task)} · {task.assigneeName??"待派工"}</h4>}
      {!taskOnly&&state.qrAvailable&&<details><summary>随单码</summary><img width={160} height={160} alt={`${task.label}随单码`} src={urls.apiUrl(`digital-production/${base}/tasks/${task.taskId}/qr`)}/><p><a href={`${urls.pageUrl("ui/digital-production")}?task=${task.taskId}`}>直接打开本任务</a></p></details>}
      {task.canExecute&&task.state==="ready"&&["development_materials","development_material_recheck"].includes(task.taskKind)&&<DevelopmentMaterialCheck controller={controller} task={task}/>}
      {task.canExecute&&task.state==="ready"&&task.taskKind==="development_material_supply"&&<DevelopmentAmendmentPanel sourceId={sourceId} taskId={task.taskId} onSubmitted={()=>controller.load()}/>}
      {state.technical?.enrolled&&<DevelopmentTechnicalNode controller={controller} task={task}/>}
      {task.canExecute&&task.state==="ready"&&(task.taskKind==="development_cutting"||(!state.technical?.enrolled&&task.taskKind==="development_pattern"))&&<form onSubmit={event=>{event.preventDefault();void run("complete",{taskId:task.taskId,note:new FormData(event.currentTarget).get("note"),attachmentIds:craftFiles});}}><fieldset disabled={busy}>{task.taskKind==="development_pattern"&&<DocumentEntry category="results" label="工序成果上传"><DevelopmentResultUpload controller={controller} task={task}/></DocumentEntry>}<p>{craftFiles.length?`本次已上传 ${craftFiles.length} 个文件`:task.taskKind==="development_pattern"?"缺少本任务纸样成果，请到本单资料上传；历史开发图不能代替。":"裁板沿原完成条件办理。"}</p>{task.taskKind==="development_cutting"&&state.slaEnrolled&&<p>接收车板师傅：{state.sewingRecipientName??"待文员安排"}</p>}<label>备注<textarea aria-label="办理备注" name="note" maxLength={1000} rows={3}/></label><WorkbenchAction disabled={busy} type="submit" variant="primary">{task.taskKind==="development_pattern"?"纸样完成，交给下一位":"裁板做好，交给下一位"}</WorkbenchAction></fieldset></form>}
      {task.canExecute&&task.state==="ready"&&task.taskKind==="development_washing_dispatch"&&<WorkbenchAction type="button" disabled={busy} onClick={()=>void run("send-washing",{taskId:task.taskId,note:`${state.sheet.document!.washing}实际送出`})}>登记实际送洗</WorkbenchAction>}
      {task.canExecute&&task.state==="ready"&&["development_craft_dispatch","development_printing","development_embroidery","development_print_embroidery","development_craft_confirmation","development_sewing_transfer","development_sewing","development_washing","development_pre_wash_check","development_tail_check","development_confirmation","development_shipping"].includes(task.taskKind)&&<form onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void run("route",{actualTime:developmentTimeFromForm(form),attachmentIds:task.taskKind==="development_sewing"?sewingFiles:task.taskKind==="development_tail_check"&&state.slaEnrolled?tailFiles:["development_printing","development_embroidery","development_print_embroidery"].includes(task.taskKind)?controller.technicalUploads["工艺回样照片"]??[]:[],...(state.slaEnrolled&&inspectionDoc&&(inspectionDoc.washing!=="免洗"||state.technical?.enrolled&&task.taskKind==="development_tail_check")&&["development_pre_wash_check","development_tail_check"].includes(task.taskKind)?{measurements:inspectionMeasurementsFromForm(inspectionDoc!,form)}:{}),...(task.taskKind==="development_tail_check"&&form.get("result")==="退回"&&state.sheet.document&&!state.technical?.enrolled?{making:makingUpgradeFromForm(form,developmentMakingBasis(state.sheet.document,state.sheet.version))}:{}),returnNodes:form.getAll("returnNodes"),problemCategories:form.getAll("problemCategories"),craftExecution:form.get("craftExecution")||null,taskId:task.taskId,note:form.get("note")||"",result:form.get("result")||"通过",nextAssigneeId:form.get("nextAssigneeId")||null,sentDate:form.get("sentDate")||null,trackingNo:form.get("trackingNo")||null});}}><fieldset disabled={busy}>
        {state.technical?.enrolled&&["development_printing","development_embroidery","development_print_embroidery"].includes(task.taskKind)&&<label>实际工艺回样照片 *<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void controller.upload(files,"工艺回样照片",task.taskId);}}/>{controller.previews.viewFor(['工艺回样照片'])}</label>}
        {task.taskKind==="development_sewing"&&!sewingFiles.length&&<p>缺少本任务实际完成照片，请到本单资料上传车板成果。</p>}{task.taskKind==="development_sewing"&&<DocumentEntry category="results" label="车板成果上传"><DevelopmentResultUpload controller={controller} task={task}/></DocumentEntry>}
        {state.slaEnrolled&&inspectionDoc&&(inspectionDoc.washing!=="免洗"||state.technical?.enrolled&&task.taskKind==="development_tail_check")&&["development_pre_wash_check","development_tail_check"].includes(task.taskKind)&&<DevelopmentInspectionMeasurements document={inspectionDoc!} phase={task.taskKind==="development_pre_wash_check"?"洗前":inspectionDoc!.washing==="免洗"?"尾查":"洗后"}/>}
        {state.slaEnrolled&&task.taskKind==="development_tail_check"&&<DocumentEntry category="results" label="尾查照片上传"><DevelopmentResultUpload controller={controller} task={task}/></DocumentEntry>}
        {task.taskKind==="development_craft_dispatch"&&!state.unifiedArrangement&&<label>工艺办理人 *<SearchableSelect name="nextAssigneeId" required><option value="">请选择</option>{people.filter(person=>person.roles.includes("pattern_room_worker")).map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}</SearchableSelect></label>}
        {task.taskKind==="development_craft_dispatch"&&<label>工艺制作方式<select name="craftExecution"><option>内部</option><option>外发</option></select></label>}
        {task.taskKind==="development_tail_check"&&<label>尾查结果<select name="result" onChange={event=>setTailReturn(current=>({...current,[task.taskId]:event.target.value==="退回"}))}><option value="通过">合格</option><option value="退回">退回修改</option></select></label>}
        {task.taskKind==="development_tail_check"&&<>{state.sheet.document&&!state.technical?.enrolled&&<div hidden={!tailReturn[task.taskId]}><DevelopmentMakingUpgradeFields basis={developmentMakingBasis(state.sheet.document,state.sheet.version)} disabled={busy||!tailReturn[task.taskId]}/></div>}<fieldset hidden={!tailReturn[task.taskId]} disabled={!tailReturn[task.taskId]}><legend>退回时选择问题节点</legend>{DEVELOPMENT_REVISION_NODES.map(node=><label key={node}><input type="checkbox" name="returnNodes" value={node}/>{node}</label>)}</fieldset><fieldset hidden={!tailReturn[task.taskId]} disabled={!tailReturn[task.taskId]}><legend>问题分类</legend>{DEVELOPMENT_PROBLEM_CATEGORIES.map(category=><label key={category}><input type="checkbox" name="problemCategories" value={category}/>{category}</label>)}</fieldset></>}
        {task.taskKind!=="development_shipping"&&<DevelopmentOccurrenceInput/>}
        {task.taskKind==="development_shipping"&&<><label>实际寄出日期 *<input type="date" name="sentDate" required/></label><label>快递号 *<input name="trackingNo" required maxLength={100}/></label></>}
        <label>{task.taskKind==="development_tail_check"?"内部问题 / 备注":"备注"}{task.taskKind==="development_tail_check"&&Boolean(tailReturn[task.taskId]) ? " *" : "（选填）"}<textarea aria-label="办理备注" name="note" maxLength={2000} required={task.taskKind==="development_tail_check"&&Boolean(tailReturn[task.taskId])}/></label><WorkbenchAction disabled={busy} type="submit" variant="primary">{task.taskKind==="development_confirmation"?(state.slaEnrolled?"记录最终设计确认":"最终设计确认并交寄样"):task.taskKind==="development_craft_confirmation"?"确认工艺并衔接车板":task.taskKind==="development_shipping"?"记录寄出":task.taskKind==="development_tail_check"?(tailReturn[task.taskId]?"退回修改":"尾查合格，交给设计师"):task.taskKind==="development_sewing"?"车板完成，交给下一位":"完成并交出"}</WorkbenchAction>
      </fieldset></form>}
      {workspace&&<div className="development-action-destination" aria-label="后续办理人">{task.taskKind==="development_tail_check"&&tailReturn[task.taskId]?<span>提交后按所选问题工序退回修改。</span>:state.tasks.some(item=>item.taskId!==task.taskId&&item.routeVersion===task.routeVersion&&["pending","ready"].includes(item.state))?<details><summary>后续任务与办理人（按实际前置启动）</summary>{state.tasks.filter(item=>item.taskId!==task.taskId&&item.routeVersion===task.routeVersion&&["pending","ready"].includes(item.state)).map(item=><p key={item.taskId}>{item.label}：{item.assigneeName??"待安排与真实前置齐备后衔接"} · {digitalTaskDisplayStatus(item)}</p>)}</details>:<span>{task.taskKind==="development_tail_check"&&tailReturn[task.taskId]?"提交后按所选问题工序退回修改。":state.nextSteps?.find(step=>step.taskId===task.taskId)?`下一岗位：${state.nextSteps.find(step=>step.taskId===task.taskId)!.label}；人员按实际分派安排，未分派时等待主管。`:"后续按本轮实际路线办理；人员未确定时等待主管分派。"}</span>}</div>}
    </section>)}

    {!taskOnly&&<DevelopmentFabricDecisions controller={controller}/>}
    {!taskOnly&&!materialCheck&&state.canReportFabric&&<DocumentEntry category="materials" label="面料检测报告"><DevelopmentFabricReport controller={controller}/></DocumentEntry>}
    {!taskOnly&&!materialCheck&&!separateCustomer&&<DevelopmentCustomerConfirmation controller={controller}/>}
    {!taskOnly&&<details><summary>工艺至寄样记录</summary>{state.routeFacts.map(fact=><div key={fact.factId}><p>第 {fact.routeVersion} 轮 · {fact.kind} · {fact.payload.sentDate??""} {fact.payload.trackingNo??""} · {fact.payload.note??""}</p>{fact.payload.inspection&&<details><summary>{fact.payload.inspection.phase}实际尺寸（{fact.payload.inspection.unit}）</summary>{fact.payload.inspection.measurements.map((row,index)=><p key={index}>{row.name}：{row.values.map((value,column)=>`${fact.payload.inspection!.sizes[column]} ${value}`).join(" / ")}</p>)}</details>}</div>)}</details>}
    {controller.reopenReceipt&&!taskOnly&&<p role="status">已接回文员重新核料，尚未确认通过。<a href={controller.reopenReceipt.target}>打开本轮核料页</a></p>}
    {state.reopenMaterialCheck&&!controller.reopenReceipt&&!taskOnly&&<form onSubmit={event=>{event.preventDefault();void run("reopen-materials",{...state.reopenMaterialCheck,note:reopenNote});}}><h3>文员重新确认本轮用途</h3><p>沟通后用途有变，由文员接回原核料页重新确认。原补正／补料将结束并保留记录；尚未重新核料通过，工序不会自动放行。资料缺错与质量问题仍须处理。</p><label>重新核料说明<textarea required maxLength={1000} value={reopenNote} disabled={busy||uncertainWrite} onChange={event=>setReopenNote(event.target.value)}/></label><Button type="submit" disabled={busy||uncertainWrite}>接回文员重新核料</Button></form>}
    {state.supplementCheckTaskId&&<Button type="button" disabled={busy} onClick={()=>void run("supplement-check",{taskId:state.supplementCheckTaskId})}>补充核验本轮材料</Button>}
    {!taskOnly&&<details><summary>办理历史</summary>{state.facts.map(fact=><div key={fact.factId}><p>{fact.kind} · {new Date(fact.recordedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})} · {fact.payload.recommendation??fact.payload.decision??""} · {fact.payload.note??""}</p>{fact.payload.attachmentIds?.map(id=><a key={id} href={urls.apiUrl(`digital-production/sources/${sourceId}/development/attachments/${id}`)} target="_blank" rel="noreferrer">查看附件 </a>)}</div>)}</details>}
  </section>);
}

function DevelopmentTaskBasis({state,taskId}:{state:State;taskId:string}){
 const task=state.tasks.find(item=>item.taskId===taskId),doc=state.sheet.document;
 if(!task||!doc)return null;
 const sizing=["development_pattern","development_cutting","development_sewing","development_pre_wash_check","development_tail_check"].includes(task.taskKind);
 return <section className="development-task-basis" aria-label="本轮办理依据"><h3>本轮办理依据</h3><div className="development-handoff-facts"><span>开发资料：第{task.routeVersion}轮 · v{state.sheet.version}</span><span>打板数量：{doc.quantity??"未登记"}</span><span>各码制作：{developmentMakingSizes(doc)}</span><span>要求完成：{doc.returnDate??"未登记"}</span></div>
 {task.taskKind==="development_sewing"&&<div className="development-sewing-prerequisites"><section><h4>裁板交入</h4><p>{state.tasks.find(item=>item.routeVersion===task.routeVersion&&item.taskKind==="development_cutting")?.state==="completed"?"本轮裁板已完成":"以实际前置状态为准"}</p></section><section><h4>面辅料核配</h4><p>{state.facts.some(fact=>fact.kind==="核配通过"&&state.tasks.some(item=>item.taskId===fact.taskId&&item.routeVersion===task.routeVersion))?"本轮核配已通过":"暂无本轮核配通过记录"}</p></section><section><h4>车板执行安排</h4><p>{state.patternPreparation?.workerName?`已指派：${state.patternPreparation.workerName}`:state.unifiedArrangement?"尚无有效车板执行安排，请文员在本单总委派核对人员及上方缺项；正常首轮无需主管另行派工":"尚无原执行单派工记录，请技术主管在原执行单核对历史安排"}</p></section></div>}
 {task.unmetConditions?.length?<ul aria-label="未满足条件">{task.unmetConditions.map((item,index)=><li key={`${item.condition}:${index}`}><strong>{item.name}</strong>：{item.missing}；负责岗位：{roleLabel(item.responsibleRole)}{item.action?`；可处理：${item.action}`:""}</li>)}</ul>:task.blockedReason&&<p role="status">前置情况：{task.blockedReason}</p>}
 {state.tasks.some(item=>item.routeVersion===task.routeVersion&&item.state==="completed")&&<p>本轮已完成：{state.tasks.filter(item=>item.routeVersion===task.routeVersion&&item.state==="completed").map(item=>item.label).join("、")}</p>}
 {["development_materials","development_material_recheck","development_cutting"].includes(task.taskKind)&&<details open><summary>本轮材料事实（只读）</summary><div className="development-table-scroll"><table className="development-task-material-facts"><thead><tr><th>材料 / 规格</th><th>本轮所需</th><th>发布时实物</th><th>本轮到料事实</th><th>预计到料</th></tr></thead><tbody>{doc.materials.map(item=><tr key={item.materialId}><th>{item.name||item.label}<small>{item.category}{item.label&&item.label!==item.name?` · ${item.label}`:''} · {item.specification||"规格未登记"}</small></th><td>{state.materialVerification?(state.materialReadiness?.find(row=>row.materialId===item.materialId)?.usage==="use"?"已提交核料：使用":state.materialReadiness?.find(row=>row.materialId===item.materialId)?.usage==="unused"?"已提交核料：不用":"尚无有效使用确认（保存草稿不生效）"):(item.requiredThisRound?"所需":"历史资料标记不需")}</td><td>{item.available?"已有实物":"发布时未到"}</td><td>{state.materialReadiness?.find(row=>row.materialId===item.materialId)?.available?"本轮有效可用（核验 / 到料 / 代用）":state.materialReadiness?.find(row=>row.materialId===item.materialId)?.missing.join("、")||"尚未逐项核验"}</td><td>{state.sheet.materialEvents.filter(event=>event.materialId===item.materialId&&event.action==="修改预计日期").at(-1)?.expectedDate??item.expectedDate??"未登记"}</td></tr>)}</tbody></table>{!doc.materials.length&&<p>本轮未登记材料明细。</p>}</div></details>}
 {sizing&&<section className="development-task-requirements"><h4>本轮尺寸与制作要求（只读）</h4><div className="development-table-scroll"><table className="development-task-size-table"><thead><tr><th>测量项目（{doc.unit}）</th>{doc.sizes.map((size,index)=><th key={index}>{size||"未填尺码"}</th>)}</tr></thead><tbody>{doc.measurements.map((row,index)=><tr key={index}><th>{row.name}</th>{row.values.map((value,column)=><td key={column}>{value||"—"}</td>)}</tr>)}</tbody></table></div><p>{doc.instructions||"本轮未登记制作说明"}</p><p>洗水：{doc.washing}{doc.washing!=="免洗"&&doc.washingMethod?` · ${doc.washingMethod}`:""} · 整烫：{doc.ironing||"未登记"}</p><p>工艺：{doc.craft} · 包装：{doc.packaging||"未登记"}</p></section>}

 </section>;
}

/** Original customer decision, separate from task completion and never automatic. */
export function DevelopmentCustomerConfirmation({controller,direct=false}:{controller:ReturnType<typeof useDevelopmentExecution>;direct?:boolean}){
 const {state,busy,run}=controller;
 if(!state)return null;
 if(state.technical?.enrolled)return <DevelopmentFinalFeedback controller={controller} direct={direct}/>;
 const round=state.sheet.roundNumber??1;
 const recorded=state.routeFacts.filter(fact=>fact.routeVersion===round&&fact.kind==='客户样板确认').at(-1);
 const finalDesign=state.routeFacts.filter(fact=>fact.kind==='最终设计确认'&&(!direct||fact.routeVersion===round&&!recorded));
 const editor=<>{state.sheet.canEdit&&finalDesign.map(fact=><form key={fact.factId} onSubmit={event=>{
  event.preventDefault();
  const form=new FormData(event.currentTarget);
  void run('customer-sample',{routeVersion:fact.routeVersion,note:form.get('note'),actualTime:developmentTimeFromForm(form)});
 }}><fieldset disabled={busy||state.routeFacts.some(item=>item.kind==='客户样板确认'&&item.routeVersion===fact.routeVersion)}>
  <legend>第 {fact.routeVersion} 轮客户样板确认</legend>
  <DevelopmentOccurrenceInput label="客户实际确认时间"/>
  <label>客户确认记录 *<textarea aria-label="办理备注" name="note" required maxLength={2000}/></label>
  <Button type="submit">记录客户已确认本轮样板</Button>
 </fieldset></form>)}</>;
 if(!direct)return editor;
 const evidence=recorded?.payload;
 const trusted=evidence?.timeQuality&&['现场登记','已核实','补报未核实'].includes(evidence.timeQuality);
 const time=trusted?(evidence.actualCompletedDate??(evidence.actualCompletedAt
  ?new Date(evidence.actualCompletedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):null)):null;
 return <section aria-label="客户意见">
  <h3>客户意见</h3>
  {recorded?<article><h4>原客户样板确认</h4>{evidence?.note&&<p>{evidence.note}</p>}
   <p>实际发生：{time??'时间待核'}{time&&evidence?.timeQuality==='补报未核实'?'（未核实）':''}</p>
   <p>登记：{new Date(recorded.recordedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p>
  </article>:<p>本轮暂无已登记的客户样板确认。</p>}
  {editor}
 </section>;
}
