import { useEffect, useRef, useState } from "react";
import { Surface } from "@dx-rework/ui";
import { CONTRACT_TERM_LABELS, ContractTemplateContentSchema, ContractTemplateStateSchema,
  type ContractTemplateContent, type ContractTemplateState } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import { verifySession } from "./auth.js";
import { createClientRequestId } from "./client-request-id.js";
import "./admin-console.css";
import "./contract-settings.css";

const {apiUrl} = createWebUrls(import.meta.env.BASE_URL);
const content = (value: ContractTemplateContent): ContractTemplateContent => ({
  templateName:value.templateName,partyAName:value.partyAName,partyAAddress:value.partyAAddress,
  signingPlace:value.signingPlace,terms:{...value.terms},
});
export function ContractTemplateSettingsPage() {
  const [state,setState] = useState<ContractTemplateState|null>(null);
  const [draft,setDraft] = useState<ContractTemplateContent|null>(null);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const [preview,setPreview] = useState<{url:string;content:string}|null>(null);
  const [selectedVersion,setSelectedVersion] = useState("");
  const [allowed,setAllowed] = useState(false);
  const key = useRef<string|null>(null);
  const guard = useRef(false);
  useEffect(()=>{
    let mounted=true;
    void verifySession().then(async session=>{
      if(session==="denied"||session.user.isRoot!==true) {if(mounted)setMessage("仅Root可设置合同模板");return;}
      if(mounted)setAllowed(true);
      const response = await fetch(apiUrl("sourcing/contract-template"),{credentials:"include",cache:"no-store"});
      const body=await response.json();
      if(!response.ok) throw new Error(body?.error?.message??"模板加载失败");
      const loaded=ContractTemplateStateSchema.parse(body);
      if(mounted){setState(loaded);setDraft(content(loaded.item));setSelectedVersion(String(loaded.item.templateVersion));}
    }).catch(e=>{if(mounted)setMessage(e instanceof Error?e.message:"模板加载失败");});
    return ()=>{mounted=false;};
  },[]);
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview.url);},[preview]);
  const edit = (value: ContractTemplateContent) => {setDraft(value);key.current=null;setMessage("");};
  const submit = async (mode:"preview"|"save") => {
    if(!draft||!state||guard.current)return;
    const parsed=ContractTemplateContentSchema.safeParse(draft);
    if(!parsed.success){setMessage(parsed.error.issues[0]?.message??"请完整填写模板");return;}
    guard.current=true;setBusy(true);setMessage("");
    const serialized=JSON.stringify(parsed.data);
    try {
      if(mode==="save" && preview?.content!==serialized) throw new Error("请先预览本次修改的合同");
      key.current??=createClientRequestId();
      const response=await fetch(apiUrl(`sourcing/contract-template${mode==="preview"?"/preview":""}`),{
        method:"POST",credentials:"include",headers:{"Content-Type":"application/json",...(mode==="save"?{"idempotency-key":key.current}: {})},
        body:JSON.stringify(mode==="preview"?parsed.data:{...parsed.data,expectedVersion:state.item.templateVersion}),
      });
      if(!response.ok){const body=await response.json();throw new Error(body?.error?.message??"模板操作失败");}
      if(mode==="preview")setPreview({url:URL.createObjectURL(await response.blob()),content:serialized});
      else {
        const loaded=ContractTemplateStateSchema.parse(await response.json());
        setState(loaded);setDraft(content(loaded.item));setSelectedVersion(String(loaded.item.templateVersion));key.current=null;
        setMessage("模板已保存，后续生成的合同使用新版本。");
      }
    } catch(e){setMessage(e instanceof Error?e.message:"模板操作失败");}
    finally{guard.current=false;setBusy(false);}
  };
  return <main className="contract-template-settings"><Surface className="admin-card">
    <h1>合同模板设置</h1>
    {allowed&&draft&&state?<>
      <label><span>模板版本</span><select disabled={busy} value={selectedVersion} onChange={event=>{
        const item=[state.item,...state.history].find(row=>String(row.templateVersion)===event.target.value);
        if(item){setSelectedVersion(event.target.value);edit(content(item));}
      }}>{[state.item,...state.history].map(item=><option key={item.templateVersion} value={item.templateVersion}>
        V{item.templateVersion} · {item.templateName}{item.templateVersion===state.item.templateVersion?"（当前）":""}
      </option>)}</select></label>
      <form onSubmit={event=>{event.preventDefault();void submit("save");}}>
        <fieldset disabled={busy} className="contract-template-fields">
          {([ ["templateName","模板名称"],["partyAName","甲方名称"],["partyAAddress","甲方地址"],["signingPlace","签订地点"] ] as const).map(([field,label])=>
            <label key={field}><span>{label} *</span><input required value={draft[field]} maxLength={field==="partyAAddress"?500:field==="templateName"?100:200}
              onChange={event=>edit({...draft,[field]:event.target.value})}/></label>)}
          {(Object.keys(CONTRACT_TERM_LABELS) as (keyof typeof CONTRACT_TERM_LABELS)[]).map(field=>
            <label key={field}><span>{CONTRACT_TERM_LABELS[field]} *</span><textarea required value={draft.terms[field]} maxLength={4000}
              rows={field==="qualityRequirements"?5:3} onChange={event=>edit({...draft,terms:{...draft.terms,[field]:event.target.value}})}/></label>)}
        </fieldset>
        <div className="contract-template-actions">
          <button className="dx-button dx-button--secondary" disabled={busy} type="button" onClick={()=>void submit("preview")}>生成预览</button>
          {preview&&preview.content===JSON.stringify(ContractTemplateContentSchema.safeParse(draft).data)?<a className="dx-button dx-button--secondary" href={preview.url} target="_blank" rel="noreferrer">查看合同预览</a>:null}
          <button className="dx-button dx-button--primary" disabled={busy||!preview||preview.content!==JSON.stringify(ContractTemplateContentSchema.safeParse(draft).data)} type="submit">
            {busy?"处理中…":Number(selectedVersion)!==state.item.templateVersion?"恢复此版本并保存":"保存生效"}
          </button>
        </div>
      </form>
    </>:null}
    {message?<p role="status">{message}</p>:null}
  </Surface></main>;
}
