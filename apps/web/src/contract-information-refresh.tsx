import {useDigitalDetailNavigationGuard} from "./use-digital-detail-navigation-guard.js";
import {feedbackFetch,feedbackJson} from "./request-response-feedback.js";
import {SubmissionAttempt} from "./submission-attempt.js";
import {SubmissionRequestError} from "./submission-validation.js";
import { ContractContentEditor } from "./contract-content-editor.js";
import { useEffect, useRef, useState } from "react";
import { CONTRACT_REFRESH_FIELDS, ContractRefreshPreviewSchema, ContractInformationRefreshResponseSchema,
  type ContractRefreshPreview } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import "./contract-settings.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

export function contractInformationRefreshReceipt(value:unknown,expected:{caseId:string;documentId:string;fingerprint:string;key:string}){
  const state=ContractInformationRefreshResponseSchema.parse(value),receipt=state.refreshReceipt,item=state.item;
  if(!item||receipt.sourcingCaseId!==expected.caseId||receipt.previousDocumentId!==expected.documentId||receipt.informationFingerprint!==expected.fingerprint||receipt.idempotencyKey!==expected.key
    ||receipt.documentId===expected.documentId||item.sourcingContractDocumentId!==receipt.documentId||item.contractVersion!==receipt.contractVersion||receipt.contractVersion!==receipt.previousVersion+1||item.sourcingApprovalSnapshotId!==receipt.sourcingApprovalSnapshotId)throw new Error('原合同更新回执不匹配');
  return state;
}

export function ContractInformationRefresh({ caseId, disabled, canEditContent, onUpdated }: {
  caseId:string; disabled:boolean; canEditContent:boolean; onUpdated():Promise<void>;
}) {
  const [choosing,setChoosing] = useState(false);
  const [editing,setEditing] = useState(false);
  const choiceDialog = useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(choosing)choiceDialog.current?.showModal();},[choosing]);
  const [preview,setPreview] = useState<ContractRefreshPreview | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const key = useRef<string | null>(null);
  const writing=useRef(false);
  const guard = useRef(false),attempt=useRef(new SubmissionAttempt()),generation=useRef(0),commandError=useRef("");
  const [uncertain,setUncertain]=useState(false),[saved,setSaved]=useState(false),[refreshPending,setRefreshPending]=useState(false);
  useEffect(()=>{generation.current++;attempt.current=new SubmissionAttempt();key.current=null;guard.current=false;writing.current=false;setPreview(null);setChoosing(false);setEditing(false);setUncertain(false);setSaved(false);setRefreshPending(false);setError("");setBusy(false);return()=>{generation.current++;};},[caseId]);
  useEffect(()=>{if(preview) dialog.current?.showModal();},[preview]);
  useDigitalDetailNavigationGuard(uncertain,false,writing,"原合同更新结果尚未确认，离开不会撤销更新并会丢失本页原标识。确定离开？");
  const endpoint = `sourcing/cases/${caseId}/contract/refresh`;
  const load = async () => {
    if (guard.current||attempt.current.hasPending||refreshPending) return;
    const version=generation.current;guard.current=true;setBusy(true);setError("");
    try {
      const response=await feedbackFetch(apiUrl(endpoint),{credentials:"include",cache:"no-store"});
      const body=await feedbackJson(response,"GET",value=>ContractRefreshPreviewSchema.parse(value));
      if(version!==generation.current)return;setPreview(body);key.current=createClientRequestId();
    } catch(e) {if(version===generation.current)setError(e instanceof Error?e.message:"供应商资料尚未读取，请重新查看差异");}
    finally {if(version===generation.current){guard.current=false;setBusy(false);}}
  };
  const refreshOnly=async()=>{if(guard.current)return;const version=generation.current;guard.current=true;setBusy(true);try{await onUpdated();if(version===generation.current){setRefreshPending(false);setError("");}}catch(e){if(version===generation.current)setError(e instanceof Error?e.message:"最新订单资料尚未读取，请仅重读");}finally{if(version===generation.current){guard.current=false;setBusy(false);}}};
  const save = async (recover=false) => {
    if(guard.current||!recover&&(!preview||preview.missingFields.length||!preview.changes.length))return;
    const version=generation.current,operation=attempt.current;guard.current=true;writing.current=true;setBusy(true);setError("");commandError.current="";
    const path=apiUrl(endpoint),originalKey=key.current!,body=JSON.stringify({sourcingContractDocumentId:preview?.sourcingContractDocumentId,informationFingerprint:preview?.informationFingerprint});
    const execute=async()=>{
      try{
        const response=await feedbackFetch(path,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","idempotency-key":originalKey},body});
        await feedbackJson(response,"POST",value=>contractInformationRefreshReceipt(value,{caseId,documentId:preview!.sourcingContractDocumentId,fingerprint:preview!.informationFingerprint,key:originalKey}),(message,code,status)=>new SubmissionRequestError(message,code,status));
        operation.markConfirmed();if(version!==generation.current)return;
        setUncertain(false);setPreview(null);key.current=null;setSaved(true);setRefreshPending(true);
        await onUpdated();if(version===generation.current)setRefreshPending(false);
      }catch(e){if(version===generation.current)commandError.current=e instanceof Error?e.message:"结果尚未确认";throw e;}
    };
    try{const result=recover?await operation.retry():await operation.run(execute);if(version!==generation.current)return;
      if(result.kind==='failure'){setUncertain(result.uncertain);setError(result.confirmed?'合同信息更新已保存；最新订单资料暂未读取，请仅重新读取，不重复更新。':result.uncertain?`${commandError.current||result.failure.message}；原更新结果仍未确认，请先核对原合同或使用原内容核对，不要重复生成新版。`:result.failure.message);}
      else if(result.kind==='needs-recovery')setError('原合同更新结果尚未确认，请使用原内容核对结果');
      else if(result.kind==='expired')setError('原更新已超过安全恢复期限，不能重发；请在原合同版本历史核对，仍不明确请管理员核查');
    }finally{if(version===generation.current){guard.current=false;writing.current=false;setBusy(false);}}
  };
  const recovery=uncertain?<button type="button" disabled={busy} onClick={()=>void save(true)}>使用原内容核对更新结果</button>:null;
  return <>
    <button className="dx-button dx-button--secondary" type="button" disabled={disabled||busy||uncertain||refreshPending} onClick={()=>setChoosing(true)}>
      {busy&&!preview?"正在读取…":"更新合同信息"}
    </button>
    {choosing?<dialog ref={choiceDialog} className="system-dialog" aria-label="更新合同信息" onCancel={event=>{event.preventDefault();setChoosing(false);}}>
      <div className="system-dialog__copy"><h2>更新合同信息</h2></div>
      <div className="contract-template-actions">
        <button className="dx-button dx-button--primary" type="button" onClick={()=>{setChoosing(false);void load();}}>更新供应商以及合同信息</button>
        {canEditContent?<button className="dx-button dx-button--secondary" type="button" onClick={()=>{setChoosing(false);setEditing(true);}}>修改合同内容</button>:null}
      </div>
      <div className="system-dialog__actions"><button className="dx-button dx-button--secondary" type="button" onClick={()=>setChoosing(false)}>取消</button></div>
    </dialog>:null}
    {editing?<ContractContentEditor caseId={caseId} onClose={()=>setEditing(false)} onUpdated={onUpdated}/>:null}
    {saved?<p role="status">合同信息更新已保存，原合同与回签历史保留。</p>:null}{refreshPending?<button type="button" disabled={busy} onClick={()=>void refreshOnly()}>仅重新读取订单资料</button>:null}
    {error&&!preview?<span role="alert">{error}{recovery}</span>:null}
    {preview?<dialog ref={dialog} className="system-dialog contract-supplier-dialog" aria-label="更新合同信息"
      onCancel={event=>{event.preventDefault();if(!busy)setPreview(null);}}>
      <div className="system-dialog__copy"><h2>更新合同信息</h2>
        {preview.returned?<p>此合同已回传。将生成新版，原合同和回签文件保留。</p>:null}
      </div>
      {preview.changes.length?<div className="contract-supplier-changes">
        {preview.changes.map(change=><div className="contract-supplier-change" key={change.field}>
          <strong>{CONTRACT_REFRESH_FIELDS[change.field]}</strong>
          <span>原：{change.before||"未维护"}</span><span>新：{change.after||"未维护"}</span>
        </div>)}
      </div>:<p>供应商资料及模板与合同一致，无需更新。</p>}
      {preview.missingFields.length?<p role="alert">供应商合同资料缺少：{preview.missingFields.map(field=>CONTRACT_REFRESH_FIELDS[field as keyof typeof CONTRACT_REFRESH_FIELDS]??"待核实资料项").join("、")}；请有原资料维护权限的人员到供应商中心「资料维护」补齐，再回本单合同页重新查看差异。</p>:null}
      {error?<p role="alert">{error}{recovery}</p>:null}
      <div className="system-dialog__actions">
        <button className="dx-button dx-button--secondary" disabled={busy} type="button" onClick={()=>setPreview(null)}>取消</button>
        <button className="dx-button dx-button--primary" disabled={busy||uncertain||!preview.changes.length||!!preview.missingFields.length}
          type="button" onClick={()=>void save()}>{busy?"正在更新…":"确认更新合同"}</button>
      </div>
    </dialog>:null}
  </>;
}
