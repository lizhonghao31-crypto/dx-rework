import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
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
  const guard = useRef(false),writing=useRef(false),attempt=useRef(new SubmissionAttempt());
  const [readback,setReadback]=useState<ContractTemplateState|null>(null);
  const [uncertain,setUncertain]=useState(false);useDigitalDetailNavigationGuard(uncertain,busy,writing,"原合同模板保存结果尚未确认；离开不会撤销保存，请先核对原版本。仍要离开？");
  useEffect(()=>{
    let mounted=true;
    void verifySession().then(async session=>{
      if(session==="denied"||session.user.isRoot!==true) {if(mounted)setMessage("仅Root可设置合同模板");return;}
      if(mounted)setAllowed(true);
      const response = await feedbackFetch(apiUrl("sourcing/contract-template"),{credentials:"include",cache:"no-store"});
      const loaded=await feedbackJson(response,'GET',value=>ContractTemplateStateSchema.parse(value));
      if(mounted){setState(loaded);setDraft(content(loaded.item));setSelectedVersion(String(loaded.item.templateVersion));}
    }).catch(e=>{if(mounted)setMessage(e instanceof Error?e.message:"模板加载失败");});
    return ()=>{mounted=false;};
  },[]);
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview.url);},[preview]);
  const inspect=async()=>{if(guard.current)return;guard.current=true;setBusy(true);try{const response=await feedbackFetch(apiUrl('sourcing/contract-template'),{credentials:'include',cache:'no-store'});setReadback(await feedbackJson(response,'GET',value=>ContractTemplateStateSchema.parse(value)));}catch(error){setMessage(error instanceof Error?error.message:'模板版本尚未读取');}finally{guard.current=false;setBusy(false);}};
  const edit = (value: ContractTemplateContent) => {if(uncertain||guard.current)return;attempt.current=new SubmissionAttempt();setDraft(value);key.current=null;setMessage("");};
  const submit = async (mode:"preview"|"save",recover=false) => {
    if(!draft||!state||guard.current||uncertain&&!recover)return;
    const parsed=ContractTemplateContentSchema.safeParse(draft);
    if(!parsed.success){setMessage(parsed.error.issues[0]?.message??"请完整填写模板");return;}
    guard.current=true;writing.current=mode==="save";setBusy(true);setMessage("");
    const serialized=JSON.stringify(parsed.data);
    try {
      if(mode==="save" && preview?.content!==serialized) throw new Error("请先预览本次修改的合同");
      key.current??=createClientRequestId();
      const originalKey=key.current,expectedVersion=state.item.templateVersion,payload=JSON.stringify(mode==='preview'?parsed.data:{...parsed.data,expectedVersion});
      const execute=async()=>{
       const response=await feedbackFetch(apiUrl(`sourcing/contract-template${mode==='preview'?'/preview':''}`),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json',...(mode==='save'?{'idempotency-key':originalKey}:{})},body:payload});
       if(mode==='preview'){
        if(!response.ok)await feedbackJson(response,'POST',value=>value);
        if(!response.headers.get('content-type')?.toLowerCase().includes('application/pdf'))throw Error('预览尚未取得有效PDF文件，请保留输入重新预览；没有保存模板');
        const file=await response.blob();if(!(await file.slice(0,5).text()).startsWith('%PDF-'))throw Error('预览返回文件格式异常，请重新预览；没有保存模板');
        setPreview({url:URL.createObjectURL(file),content:serialized});
       }else{
        const loaded=await feedbackJson(response,'POST',value=>{const result=ContractTemplateStateSchema.parse(value);if(result.item.templateVersion!==expectedVersion+1)throw Error('wrong template receipt');return result;},(message,code,status)=>new SubmissionRequestError(message,code,status));
        attempt.current.markConfirmed();setUncertain(false);setState(loaded);setDraft(content(loaded.item));setSelectedVersion(String(loaded.item.templateVersion));key.current=null;setMessage('模板已保存，后续生成的合同使用新版本。');
       }
      };
      if(mode==='preview')await execute();
      else{const result=recover?await attempt.current.retry():await attempt.current.run(execute);
       if(result.kind==='failure'){setUncertain(result.uncertain);setMessage(result.failure.message+(result.uncertain?'；原模板保存结果待确认，请沿原内容核对，不要修改后另存。':''));}
       else if(result.kind==='expired')setMessage('原模板保存已超过安全恢复期限，请核对原模板版本历史，不再重发。');
      }
    } catch(e){setMessage(e instanceof Error?e.message:"模板操作失败");}
    finally{guard.current=false;writing.current=false;setBusy(false);}
  };
  return <main className="contract-template-settings"><Surface className="admin-card">
    <h1>合同模板设置</h1>
    {allowed&&draft&&state?<>
      <label><span>模板版本</span><select disabled={busy||uncertain} value={selectedVersion} onChange={event=>{
        const item=[state.item,...state.history].find(row=>String(row.templateVersion)===event.target.value);
        if(item){setSelectedVersion(event.target.value);edit(content(item));}
      }}>{[state.item,...state.history].map(item=><option key={item.templateVersion} value={item.templateVersion}>
        V{item.templateVersion} · {item.templateName}{item.templateVersion===state.item.templateVersion?"（当前）":""}
      </option>)}</select></label>
      <form onSubmit={event=>{event.preventDefault();void submit("save");}}>
        <fieldset disabled={busy||uncertain} className="contract-template-fields">
          {([ ["templateName","模板名称"],["partyAName","甲方名称"],["partyAAddress","甲方地址"],["signingPlace","签订地点"] ] as const).map(([field,label])=>
            <label key={field}><span>{label} *</span><input required value={draft[field]} maxLength={field==="partyAAddress"?500:field==="templateName"?100:200}
              onChange={event=>edit({...draft,[field]:event.target.value})}/></label>)}
          {(Object.keys(CONTRACT_TERM_LABELS) as (keyof typeof CONTRACT_TERM_LABELS)[]).map(field=>
            <label key={field}><span>{CONTRACT_TERM_LABELS[field]} *</span><textarea required value={draft.terms[field]} maxLength={4000}
              rows={field==="qualityRequirements"?5:3} onChange={event=>edit({...draft,terms:{...draft.terms,[field]:event.target.value}})}/></label>)}
        </fieldset>
        <div className="contract-template-actions">
          <button className="dx-button dx-button--secondary" disabled={busy||uncertain} type="button" onClick={()=>void submit("preview")}>生成预览</button>
          {preview&&preview.content===JSON.stringify(ContractTemplateContentSchema.safeParse(draft).data)?<a className="dx-button dx-button--secondary" href={preview.url} target="_blank" rel="noreferrer">查看合同预览</a>:null}
          <button className="dx-button dx-button--primary" disabled={busy||uncertain||!preview||preview.content!==JSON.stringify(ContractTemplateContentSchema.safeParse(draft).data)} type="submit">
            {busy?"处理中…":Number(selectedVersion)!==state.item.templateVersion?"恢复此版本并保存":"保存生效"}
          </button>
        </div>
      </form>
    </>:null}
    {uncertain&&<><button type="button" disabled={busy} onClick={()=>void submit("save",true)}>使用原内容核对模板保存</button><button type="button" disabled={busy} onClick={()=>void inspect()}>仅重新读取模板版本</button>{readback&&<p role="status">当前读取到模板 V{readback.item.templateVersion} · {readback.item.templateName}；原提交回执仍未确认，原输入和请求标识保留。</p>}</>}
    {message?<p role="status">{message}</p>:null}
  </Surface></main>;
}
