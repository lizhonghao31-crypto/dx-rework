import {AuxiliaryCatalogDialog} from "./auxiliary-catalog-dialog.js";
import {Entries} from "./document-entry-scope.js";
import {rememberDigitalDetailContext} from "./digital-detail-context.js";
import "./development-amendment.css";
import {uploadDevelopmentMaterial} from "./digital-development-upload.js";
import {createWebUrls} from "../url-contract.js";
const urls=createWebUrls(import.meta.env.BASE_URL);
import {useContext,useEffect,useRef,useState} from "react";
import {Button} from "@dx-rework/ui";
import {developmentReturnNeed,developmentAmendmentErrors,type DevelopmentAmendmentContext} from "@dx-rework/contracts/digital-development-amendments";
import {developmentAmendmentPublicationOptions,isDevelopmentMaterialPlaceholder,developmentPublishErrors,type DevelopmentDocument,type DevelopmentMaterial} from "@dx-rework/contracts/digital-development";
import {digitalRequest,DigitalRequestError} from "./digital-production-api.js";
import {createClientRequestId} from "./client-request-id.js";
import {useDigitalDetailNavigationGuard} from "./use-digital-detail-navigation-guard.js";
import {RETURN_FIELD_LABELS} from "./development-return-issues.js";
const fields=["name","label","specification","quantity","color","supplier","width","weight","composition","consumption"] as const;
const labels:Record<typeof fields[number],string>={name:"品名",label:"材料标记",specification:"规格",quantity:"数量",color:"颜色",supplier:"供应方",width:"幅宽",weight:"克重",composition:"成分",consumption:"用量"};
export function DevelopmentAmendmentPanel({sourceId,taskId,onSubmitted}:{sourceId:string;taskId:string;onSubmitted:()=>Promise<unknown>}){
 const documentEntries=useContext(Entries);
 const [context,setContext]=useState<DevelopmentAmendmentContext|null>(null),[document,setDocument]=useState<DevelopmentDocument|null>(null),[reason,setReason]=useState(""),[draftVersion,setDraftVersion]=useState(0),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[submitted,setSubmitted]=useState(false);
 const [fileKind,setFileKind]=useState<DevelopmentDocument["files"][number]["kind"]>("款图");
 const [uncertain,setUncertain]=useState(false),[auxiliaryMaterialId,setAuxiliaryMaterialId]=useState<string|null>(null);
 const writing=useRef(false),command=useRef<{payload:string;key:string;path:string;method:string;body:unknown;submit:boolean}|null>(null),base=`sources/${sourceId}/development/amendment`;
 useDigitalDetailNavigationGuard(dirty||uncertain,busy,writing,"补正资料尚未保存，确定离开？");
 const load=async()=>{setBusy(true);try{const next=await digitalRequest<DevelopmentAmendmentContext>(`${base}?taskId=${taskId}`);setContext(next);setDocument(next.draft?.document??next.document);setReason(next.draft?.reason??"");setDraftVersion(next.draft?.version??0);setDirty(false);setError("");}catch(cause){setError(cause instanceof Error?cause.message:"补正资料未读取成功，请重试");}finally{setBusy(false);}};
 useEffect(()=>{let active=true;void digitalRequest<DevelopmentAmendmentContext>(`${base}?taskId=${taskId}`).then(next=>{if(active){setContext(next);setDocument(next.draft?.document??next.document);setReason(next.draft?.reason??"");setDraftVersion(next.draft?.version??0);setDirty(false);setError("");}}).catch(cause=>{if(active)setError(cause.message);});return()=>{active=false;};},[sourceId,taskId]);
 const change=(patch:Partial<DevelopmentDocument>)=>{setDocument(current=>current?{...current,...patch}:current);setDirty(true);setNotice("");};
 const material=(id:string,patch:Partial<DevelopmentMaterial>)=>change({materials:document!.materials.map(m=>{if(m.materialId!==id)return m;const next={...m,...patch};if(!Object.hasOwn(patch,"auxiliaryCatalog")&&["name","specification","supplier","auxiliaryKind","category"].some(key=>Object.hasOwn(patch,key)))delete next.auxiliaryCatalog;return next;})});
 const upload=async(files:File[])=>{
  if(writing.current||!document||!files.length)return;writing.current=true;setBusy(true);setError("");
  try{const base=`sources/${sourceId}/development`,limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);let count=document.files.length;
   for(const file of files){if(count>=30)throw Error("开发资料最多30个附件，已成功上传的保留在本页");const attachmentId=await uploadDevelopmentMaterial(base,file,fileKind,limits.maxUploadBytes);setDocument(current=>current?{...current,files:[...current.files,{attachmentId,kind:fileKind}]}:current);setDirty(true);count++;}
  }catch(cause){setError(cause instanceof Error?cause.message:"附件未上传成功，已成功文件仍保留，请核实后重试剩余文件");}finally{writing.current=false;setBusy(false);}
 };
 type Receipt={draftVersion?:number;documentVersion:number};
 const applyReceipt=async(result:Receipt,submit:boolean)=>{
  command.current=null;setUncertain(false);setDirty(false);
  if(submit){setSubmitted(true);setNotice(`本次补正 / 补料已提交，按资料修订 ${result.documentVersion}。文员从我的待办复核后继续制作。`);try{await onSubmitted();}catch{setError("补正已提交，当前页面未刷新。请重新读取任务；无需重复提交补正。");}}
  else{setDraftVersion(result.draftVersion!);setNotice("补正草稿已保存，正式资料和核验事实尚未改变。请核实后提交文员复核。");}
 };
 const execute=async(pending:NonNullable<typeof command.current>)=>{
  if(writing.current)return;writing.current=true;setBusy(true);setError("");setNotice("");
  try{await applyReceipt(await digitalRequest<Receipt>(pending.path,pending.method,pending.body,pending.key),pending.submit);}
  catch(cause){const unknown=uncertain||!(cause instanceof DigitalRequestError&&cause.status!==null&&cause.status>=400&&cause.status<500);setUncertain(unknown);setError(`${cause instanceof Error?cause.message:"未收到操作结果"}${unknown?"；本次结果尚未确认。输入和原操作标识已保留，请先核对回执，不要另建提交。":"；本页输入仍保留，请核实问题后重试。"}`);}
  finally{writing.current=false;setBusy(false);}
 };
 const recheck=async()=>{
  const pending=command.current;if(!pending||writing.current)return;writing.current=true;setBusy(true);setError("");
  try{const result=await digitalRequest<{receipt:Receipt|null}>(`${base}/receipt?taskId=${taskId}&operation=${pending.submit?"submit":"save"}&key=${encodeURIComponent(pending.key)}`);if(result.receipt)await applyReceipt(result.receipt,pending.submit);else setError("暂未找到本次回执，不能据此认定没有提交。请稍后再核对，或使用下方原操作标识重试同一请求。");}
  catch(cause){setError(cause instanceof Error?cause.message:"回执尚未读取成功，请保留原操作记录后重试读取");}
  finally{writing.current=false;setBusy(false);}
 };
 const openMaterialRecords=()=>{
  if(dirty){setError("请先保存本页补正草稿，再打开物料记录；本页输入仍保留");return;}
  rememberDigitalDetailContext({documentKind:"development",documentCategory:"development",documentChapter:"development-handling"});documentEntries?.open("development");
 };
 const supplyOnly=Boolean(context?.directSupplyMode==="legacy"||context?.issues.length&&context.issues.every(issue=>developmentReturnNeed(issue)==="supply"));
 const quickSupply=Boolean(supplyOnly&&!dirty&&document&&JSON.stringify(document)===JSON.stringify(context?.document));
 const run=async(submit:boolean)=>{
  if(writing.current||uncertain||!context||!document)return;
  if(context.sourceId!==sourceId||context.taskId!==taskId){setError("办理对象已切换，请先重新读取本任务的补正资料");return;}
  const validation=[...developmentAmendmentErrors(context.document,document),...(submit&&!quickSupply?developmentPublishErrors(document,developmentAmendmentPublicationOptions(context.document,document)):[])];
  if(validation.length){setError(validation.join("；"));return;}if(submit&&dirty){setError("请先保存本页补正草稿，再提交文员复核");return;}
  const body={taskId,roundNumber:context.roundNumber,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:draftVersion,...(!submit?{document,reason}:{})},payload=JSON.stringify([submit,body]);
  if(command.current?.payload!==payload)command.current={payload,key:createClientRequestId(),body:structuredClone(body),path:submit?`${base}/submit`:base,method:submit?"POST":"PUT",submit};
  await execute(command.current);
 };

 return <section className="dx-doc-card development-amendment-editor"><h3>补改资料 / 补料后提交复核</h3>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{!context||!document?<><p>补正资料尚未读取，请重新读取；读取成功前不能修改。</p><Button type="button" disabled={busy} onClick={()=>void load()}>重新读取补正资料</Button></>:<>
 <p>本次制作第 {context.roundNumber} 轮 · 当前资料修订 {context.documentVersion}。保存草稿不改正式资料；提交后仍由文员复核。制作数量、尺码、工艺和已执行事实不能在此覆盖，实际变更请走原复版入口。</p><p>原退回说明：{context.note}</p><ul>{context.issues.map((issue,index)=><li key={index}><a href={`#amendment-${issue.materialId?(fields.some(field=>field===issue.field)?`${issue.materialId}-${issue.field}`:issue.materialId):issue.field==="files"?"files":issue.field==="instructions"?"instructions":"reason"}`} onClick={event=>{event.preventDefault();const target=window.document.getElementById(event.currentTarget.hash.slice(1));target?.scrollIntoView({block:"center"});target?.focus({preventScroll:true});}}>{issue.materialId?context.document.materials.find(m=>m.materialId===issue.materialId)?.name||"原材料":"本单资料"} · {RETURN_FIELD_LABELS[issue.field]}</a>：{issue.reason}</li>)}</ul>
 {uncertain&&<div role="status"><p>本次操作结果未知，暂时保留输入与原操作，核对完成前不能另存或另提。</p><Button type="button" disabled={busy} onClick={()=>void recheck()}>核对本次操作回执</Button><Button type="button" disabled={busy} onClick={()=>{if(command.current)void execute(command.current);}}>使用原操作标识重试</Button></div>}
 {!submitted&&<div><p>实物到货登记位置：本任务“本单资料 → 开发单 → 轮次与记录 → 本轮物料记录”。登记后返回当前办理，再提交文员复核。</p>{documentEntries&&<Button type="button" disabled={busy||uncertain} onClick={openMaterialRecords}>打开本单物料记录</Button>}</div>}
 {!submitted&&quickSupply&&<div><p>{context.directSupplyMode==="legacy"?"旧退回未分项，保留原补料后交文员复核路径；不会改写正式资料，也不代表原资料问题已解决。":"本次只需补齐 / 更换实物，无需另存资料草稿。"}请先在本单物料记录登记，再提交文员复核。</p><Button type="button" variant="primary" disabled={busy||uncertain} onClick={()=>void run(true)}>补料已记录，交文员复核</Button></div>}
 {!submitted&&auxiliaryMaterialId&&<AuxiliaryCatalogDialog disabled={busy||uncertain} onClose={()=>setAuxiliaryMaterialId(null)} onSelect={selected=>{if(!writing.current&&!uncertain)material(auxiliaryMaterialId,{name:selected.name,specification:selected.specification,supplier:selected.supplier,auxiliaryKind:selected.auxiliaryKind,auxiliaryCatalog:{id:selected.id,version:selected.version}});}}/>}{!submitted&&<fieldset disabled={busy||uncertain}><div className="development-material-group">{document.materials.map(m=><section key={m.materialId} id={`amendment-${m.materialId}`} tabIndex={-1}><h4>{m.name||m.label||m.category}</h4><label>材料类型<select value={m.category} onChange={event=>{const category=event.target.value as DevelopmentMaterial["category"];const next={...m,category};if(category!=="辅料"){delete next.auxiliaryKind;delete next.auxiliaryCatalog;}change({materials:document.materials.map(row=>row.materialId===m.materialId?next:row)});}}>{["主布","配布","辅料"].map(value=><option key={value}>{value}</option>)}</select></label>{m.category==="辅料"&&<label>辅料种类<select value={m.auxiliaryKind??"普通辅料"} onChange={event=>material(m.materialId,{auxiliaryKind:event.target.value as NonNullable<DevelopmentMaterial["auxiliaryKind"]>})}>{["普通辅料","拉链","扁机"].map(value=><option key={value}>{value}</option>)}</select></label>}
 <div className="development-basic-grid">{m.category==="辅料"&&<div className="development-auxiliary-selection"><strong>{m.name||"尚未选择辅料"}</strong><Button type="button" disabled={busy||uncertain} onClick={()=>setAuxiliaryMaterialId(m.materialId)}>搜索或新增共享辅料</Button>{m.auxiliaryCatalog&&<small>已保存目录版本 {m.auxiliaryCatalog.version} 的资料快照</small>}</div>}{fields.map(field=><label key={field}>{labels[field]}<input id={`amendment-${m.materialId}-${field}`} aria-label={`补正 ${m.label||m.category} ${labels[field]}`} maxLength={100} value={m[field]} onChange={event=>material(m.materialId,{[field]:event.target.value})}/></label>)}<label>预计到料日期<input type="date" value={m.expectedDate??""} onChange={event=>material(m.materialId,{expectedDate:event.target.value||null})}/></label></div><p>到料与使用确认沿原记录；需要补实物时，请在本单“物料记录”登记到货，文员再核实四项。</p>{context.document.materials.some(original=>original.materialId===m.materialId&&!isDevelopmentMaterialPlaceholder(original))?<small>原材料资料保留给文员确认本轮使用 / 不用；不通过删除资料表示不用。</small>:<Button type="button" onClick={()=>change({materials:document.materials.filter(row=>row.materialId!==m.materialId)})}>移除尚未发布的材料资料</Button>}</section>)}</div>
 <div className="development-amendment-actions">{(["主布","配布","辅料"] as const).map(category=><Button key={category} type="button" disabled={document.materials.length>=100} onClick={()=>change({materials:[...document.materials,{materialId:createClientRequestId(),category,label:category,name:"",specification:"",quantity:"",color:"",supplier:"",width:"",weight:"",composition:"",consumption:"",requiredThisRound:false,available:false,expectedDate:null}]})}>添加{category}资料</Button>)}</div>
 <section id="amendment-files" tabIndex={-1}><h4>补正附件资料</h4><ul>{document.files.map(file=><li key={file.attachmentId}><a href={urls.apiUrl(`digital-production/sources/${sourceId}/development/attachments/${file.attachmentId}`)} target="_blank" rel="noreferrer">查看{file.kind}</a><Button type="button" onClick={()=>change({files:document.files.filter(row=>row.attachmentId!==file.attachmentId)})}>移除此附件引用</Button></li>)}</ul><label>附件用途<select value={fileKind} onChange={event=>setFileKind(event.target.value as typeof fileKind)}>{["款图","局部图","菲林","工艺开发板"].map(kind=><option key={kind}>{kind}</option>)}</select></label><label>上传补正附件<input type="file" multiple accept={fileKind==="款图"||fileKind==="局部图"?"image/jpeg,image/png,image/webp":"image/jpeg,image/png,image/webp,application/pdf"} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void upload(files);}}/></label></section>
 <label>制作说明<textarea id="amendment-instructions" value={document.instructions} maxLength={1000} onChange={event=>change({instructions:event.target.value})}/></label>
 <label>本次具体补正 / 澄清说明<textarea id="amendment-reason" value={reason} maxLength={1000} onChange={event=>{setReason(event.target.value);setDirty(true);}}/></label><p>草稿 {draftVersion}{dirty?" · 有未保存修改":""}</p><div className="development-amendment-actions"><Button type="button" onClick={()=>void run(false)}>保存补正草稿</Button>{!quickSupply&&<Button type="button" variant="primary" onClick={()=>void run(true)}>提交补正并交文员复核</Button>}</div>
 </fieldset>}</> }</section>;
}
