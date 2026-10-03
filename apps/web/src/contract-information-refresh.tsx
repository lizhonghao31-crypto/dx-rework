import { ContractContentEditor } from "./contract-content-editor.js";
import { useEffect, useRef, useState } from "react";
import { CONTRACT_REFRESH_FIELDS, ContractRefreshPreviewSchema, SourcingContractStateResponseSchema,
  type ContractRefreshPreview } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import "./contract-settings.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

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
  const guard = useRef(false);
  useEffect(()=>{if(preview) dialog.current?.showModal();},[preview]);
  const endpoint = `sourcing/cases/${caseId}/contract/refresh`;
  const load = async () => {
    if (guard.current) return;
    guard.current=true;setBusy(true);setError("");
    try {
      const response = await fetch(apiUrl(endpoint),{credentials:"include",cache:"no-store"});
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "供应商资料加载失败");
      setPreview(ContractRefreshPreviewSchema.parse(body));key.current=createClientRequestId();
    } catch(e) {setError(e instanceof Error?e.message:"供应商资料加载失败");}
    finally {guard.current=false;setBusy(false);}
  };
  const save = async () => {
    if(!preview || guard.current || preview.missingFields.length || !preview.changes.length) return;
    guard.current=true;setBusy(true);setError("");
    try {
      const response = await fetch(apiUrl(endpoint),{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json","idempotency-key":key.current!},
        body:JSON.stringify({sourcingContractDocumentId:preview.sourcingContractDocumentId,informationFingerprint:preview.informationFingerprint})});
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "合同更新失败，可重试");
      SourcingContractStateResponseSchema.parse(body);
      setPreview(null);key.current=null;
      await onUpdated();
    } catch(e) {setError(e instanceof Error?e.message:"合同更新失败，可重试");}
    finally {guard.current=false;setBusy(false);}
  };
  return <>
    <button className="dx-button dx-button--secondary" type="button" disabled={disabled||busy} onClick={()=>setChoosing(true)}>
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
    {error&&!preview?<span role="alert">{error}</span>:null}
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
      {preview.missingFields.length?<p role="alert">供应商合同资料不完整，请由有维护权限的人员补齐后更新。</p>:null}
      {error?<p role="alert">{error}</p>:null}
      <div className="system-dialog__actions">
        <button className="dx-button dx-button--secondary" disabled={busy} type="button" onClick={()=>setPreview(null)}>取消</button>
        <button className="dx-button dx-button--primary" disabled={busy||!preview.changes.length||!!preview.missingFields.length}
          type="button" onClick={()=>void save()}>{busy?"正在更新…":"确认更新合同"}</button>
      </div>
    </dialog>:null}
  </>;
}
