import { useEffect, useRef, useState } from "react";
import { CONTRACT_TERM_LABELS, ContractContentStateSchema, SaveContractContentSchema, SourcingContractStateResponseSchema,
  UploadIntentResponseSchema, AttachmentResponseSchema, type ContractContentState, type ContractContent } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { isImageUploadCandidate, prepareImageUploadCandidate, sha256Hex } from "./attachment-upload.js";

const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
const fields = {
  contractTitle:"合同标题",partyARepresentative:"甲方代表",partyASigningDate:"甲方签署日期",partyBSigningDate:"乙方签署日期",
  contractNumber:"合同编号",contractDate:"合同日期",signingPlace:"签订地点",partyAName:"甲方名称",partyAAddress:"甲方地址",
  partyBName:"乙方名称",partyBAddress:"乙方地址",partyBRepresentative:"乙方代表",payeeName:"收款人",bankAccount:"银行账号",bankName:"开户行",
  gender:"性别",styleName:"款式",estimatedCutPieceSendDate:"发裁片时间",deliveryDate:"货期",
} as const;
const lineFields={styleNo:"款号",alternateStyleNo:"代用款号",color:"颜色",quantity:"数量",unitPrice:"单价",totalAmount:"金额"} as const;
export function ContractContentEditor({caseId,onClose,onUpdated}:{caseId:string;onClose():void;onUpdated():Promise<void>}) {
  const [draft,setDraft]=useState<ContractContentState | null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [preview,setPreview]=useState<string | null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const guard=useRef(false);
  const key=useRef(createClientRequestId());
  const endpoint=`sourcing/cases/${caseId}/contract/content`;
  useEffect(()=>{
    dialog.current?.showModal();
    const abort=new AbortController();
    void (async()=>{
      try {
        const response=await fetch(apiUrl(endpoint),{credentials:"include",cache:"no-store",signal:abort.signal});
        const body=await response.json();
        if(!response.ok)throw new Error(body?.error?.message ?? "合同内容读取失败");
        setDraft(ContractContentStateSchema.parse(body));
      }catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:"合同内容读取失败");}
    })();
    return ()=>abort.abort();
  },[endpoint]);
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview);},[preview]);
  const update=(transform:(content:ContractContent)=>ContractContent)=>{
    setDraft(current=>current?{...current,content:transform(current.content)}:current);
    key.current=createClientRequestId();setPreview(null);setError("");
  };
  const submit=async (mode:"save"|"preview")=>{
    if(!draft || guard.current)return;
    guard.current=true;setBusy(true);setError("");
    try {
      const parsed=SaveContractContentSchema.safeParse(draft);
      if(!parsed.success)throw new Error(parsed.error.issues[0]?.message ?? "合同内容不完整");
      const response=await fetch(apiUrl(endpoint+(mode==="preview"?"/preview":"")),{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json","idempotency-key":key.current},body:JSON.stringify(parsed.data)});
      if(!response.ok){const body=await response.json();throw new Error(body?.error?.message ?? "合同更新失败");}
      if(mode==="preview")setPreview(URL.createObjectURL(await response.blob()));
      else {SourcingContractStateResponseSchema.parse(await response.json());await onUpdated();onClose();}
    }catch(e){setError(e instanceof Error?e.message:"合同更新失败");}
    finally{guard.current=false;setBusy(false);}
  };
  const upload=async(index:number,file:File|undefined)=>{
    if(!file || guard.current)return;
    guard.current=true;setBusy(true);setError("");
    try {
      if(!isImageUploadCandidate(file))throw new Error("请选择 JPG、PNG 或 WebP 图片");
      const candidate=await prepareImageUploadCandidate(file);
      const intentResponse=await fetch(apiUrl("tools/attachments/upload-intents"),{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({filename:candidate.name,mimeType:candidate.type,sizeBytes:candidate.size,sha256:await sha256Hex(candidate)})});
      const intentBody=await intentResponse.json();
      if(!intentResponse.ok)throw new Error(intentBody?.error?.message ?? "图片上传失败");
      const intent=UploadIntentResponseSchema.parse(intentBody);
      const form=new FormData();for(const [name,value]of Object.entries(intent.uploadFields))form.append(name,value);form.append("file",candidate);
      if(!(await fetch(intent.uploadUrl,{method:"POST",body:form})).ok)throw new Error("图片上传失败");
      const finalResponse=await fetch(apiUrl(`tools/attachments/${intent.attachmentId}/finalize`),{method:"POST",credentials:"include"});
      const finalBody=await finalResponse.json();if(!finalResponse.ok)throw new Error(finalBody?.error?.message ?? "图片确认失败");
      const attachment=AttachmentResponseSchema.parse(finalBody);if(attachment.status!=="ready")throw new Error("图片尚未上传完成");
      update(content=>({...content,lines:content.lines.map((line,i)=>i===index?{...line,imageAttachmentId:attachment.attachmentId,imageSha256:attachment.sha256}:line)}));
    }catch(e){setError(e instanceof Error?e.message:"图片上传失败");}
    finally{guard.current=false;setBusy(false);}
  };
  return <dialog ref={dialog} className="system-dialog contract-supplier-dialog contract-content-editor" aria-label="修改合同内容"
    onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <div className="system-dialog__copy"><h2>修改合同内容</h2><p>仅修改本单合同，不改变原订单和审批数据。保存后生成新版，旧合同和回签保留；财务核对后不能修改。</p></div>
    {draft?<fieldset className="contract-template-fields" disabled={busy}>
      {Object.entries(fields).map(([name,label])=><label key={name}>{label}<input value={draft.content[name as keyof typeof fields] ?? ""}
        onChange={event=>update(content=>({...content,[name]:event.target.value}))}/></label>)}
      <label>工艺（每行一项）<textarea value={draft.content.processes.join("\n")} onChange={event=>update(content=>({...content,processes:event.target.value.split("\n")}))}/></label>
      {draft.content.lines.map((line,index)=><fieldset key={index} className="contract-template-fields"><legend>第 {index+1} 行加工明细</legend>
        {Object.entries(lineFields).map(([name,label])=><label key={name}>{label}<input type={name==="quantity"?"number":"text"} value={line[name as keyof typeof lineFields] ?? ""}
          onChange={event=>update(content=>({...content,lines:content.lines.map((item,i)=>i===index?{...item,[name]:name==="quantity"?Number(event.target.value):event.target.value}:item)}))}/></label>)}
        <label>款图 {line.imageAttachmentId?"（已选，可替换）":"（未提供）"}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>{void upload(index,event.target.files?.[0]);event.target.value="";}}/></label>
        {line.imageAttachmentId?<img className="contract-content-image" src={apiUrl(`tools/attachments/${line.imageAttachmentId}/download?mode=preview`)} alt={`第 ${index+1} 行款图`}/>:null}
        {line.imageAttachmentId?<button className="dx-button dx-button--secondary" type="button" onClick={()=>update(content=>({...content,lines:content.lines.map((item,i)=>i===index?{...item,imageAttachmentId:null,imageSha256:undefined}:item)}))}>移除款图</button>:null}
        <button className="dx-button dx-button--secondary" type="button" disabled={draft.content.lines.length===1} onClick={()=>update(content=>({...content,lines:content.lines.filter((_,i)=>i!==index).map((item,i)=>({...item,position:i+1}))}))}>删除此行</button>
      </fieldset>)}
      <button className="dx-button dx-button--secondary" type="button" disabled={draft.content.lines.length>=100} onClick={()=>update(content=>({...content,lines:[...content.lines,{position:content.lines.length+1,styleNo:"",alternateStyleNo:null,color:null,quantity:0,unitPrice:"0",totalAmount:"0"}]}))}>添加加工明细</button>
      <label>合计数量<input type="number" value={draft.content.totalQuantity} onChange={event=>update(content=>({...content,totalQuantity:Number(event.target.value)}))}/></label>
      <label>合计金额<input value={draft.content.totalAmount} onChange={event=>update(content=>({...content,totalAmount:event.target.value}))}/></label>
      <button className="dx-button dx-button--secondary" type="button" onClick={()=>update(content=>({...content,totalQuantity:content.lines.reduce((sum,line)=>sum+line.quantity,0),
        totalAmount:(content.lines.reduce((sum,line)=>sum+Number(line.totalAmount),0)).toFixed(2)}))}>按明细汇总合计</button>
      {Object.entries(CONTRACT_TERM_LABELS).map(([name,label])=><label key={name}>{label}<textarea rows={4} value={draft.content.terms[name as keyof typeof CONTRACT_TERM_LABELS]}
        onChange={event=>update(content=>({...content,terms:{...content.terms,[name]:event.target.value}}))}/></label>)}
    </fieldset>:!error?<p>正在读取合同内容…</p>:null}
    {error?<p role="alert">{error}</p>:null}
    {preview?<a className="dx-button dx-button--secondary" href={preview} target="_blank" rel="noreferrer">打开修改后的 PDF 预览</a>:null}
    <div className="system-dialog__actions">
      <button className="dx-button dx-button--secondary" type="button" disabled={busy} onClick={onClose}>取消</button>
      <button className="dx-button dx-button--secondary" type="button" disabled={busy||!draft} onClick={()=>void submit("preview")}>预览合同</button>
      <button className="dx-button dx-button--primary" type="button" disabled={busy||!draft} onClick={()=>void submit("save")}>{busy?"正在处理…":"保存并生成新版合同"}</button>
    </div>
  </dialog>;
}
