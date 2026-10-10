import { washingChoiceLabel } from "./digital-workspace-copy.js";
import { useDigitalDetailNavigationGuard } from "./use-digital-detail-navigation-guard.js";
import {DevelopmentRevisionFields,type RevisionFields} from "./development-revision-fields.js";
import type {DevelopmentRevision} from "@dx-rework/contracts/digital-development-rounds";
import { DevelopmentExecutionPanel } from "./digital-development-execution-panel.js";
import { confirmInApp } from "./system-dialog.js";
import { DevelopmentPrint } from "./digital-development-print.js";
import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { DEVELOPMENT_MEASUREMENTS, type DevelopmentDocument, type DevelopmentMaterial, type DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import type { UploadIntentResponse } from "@dx-rework/contracts";
import { digitalRequest } from "./digital-production-api.js";
import { createClientRequestId } from "./client-request-id.js";
import { sha256Hex } from "./attachment-upload.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development.css";
import { DocumentTableScroll, DocumentToolbar, DocumentAnchors, DocumentErrors, DocumentField, DocumentSection, DocumentAddRow } from "./document-editor.js";
import { developmentIssues } from "./digital-development-validation.js";
const urls = createWebUrls(import.meta.env.BASE_URL);
const material = (category: DevelopmentMaterial["category"], label: string): DevelopmentMaterial => ({materialId:createClientRequestId(),category,label,supplier:"",name:"",width:"",weight:"",composition:"",consumption:"",color:"",specification:"",quantity:"",requiredThisRound:true,available:false,expectedDate:null});
const initial = (): DevelopmentDocument => ({template:"上衣",quantity:null,sampleSize:"",orderDate:null,returnDate:null,unit:"cm",sizes:["M","L"],measurements:DEVELOPMENT_MEASUREMENTS.上衣.map(name=>({name,values:["",""]})),interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[material("主布","主布 A"),material("配布","配布 B"),material("配布","配布 C")].map(item=>({...item,requiredThisRound:false})),files:[]});
const inheritedLabels:Record<string,string>={development_materials:"核配",development_pattern:"纸样",development_cutting:"裁板",development_printing:"印花",development_embroidery:"绣花",development_print_embroidery:"印绣花",development_craft_confirmation:"工艺确认",development_sewing:"车板",development_washing:"洗水",development_tail_check:"尾查",development_confirmation:"最终设计确认",development_shipping:"寄样",development_craft_dispatch:"发工艺",development_sewing_transfer:"转交车板",development_washing_dispatch:"送洗"};
const labels = {interlining:"朴号",placketInterlining:"门筒朴",sewingThread:"车缝线",buttonholeThread:"纽门线",stitchDensity:"针距",washingIroning:"洗水整烫方法",packaging:"包装方法",formalSizes:"正装尺码",casualSizes:"休闲尺码",mainLabelMethod:"主唛车法",instructions:"制作说明"} as const;
type RoundHistory={roundNumber:number;origin:string;customerComment:string;internalProblem:string;explanation:string;affectedNodes:string[];inherited:Record<string,{taskId:string;roundNumber:number}>};
type Rounds={rounds:RoundHistory[];draft:{version:number;payload:DevelopmentRevision}|null};
export function DigitalDevelopmentPanel({sourceId,onClose,initialRound}:{sourceId:string;onClose:()=>void;initialRound?:number|undefined}) {
  const [sheet,setSheet]=useState<DevelopmentSheet|null>(null),[document,setDocument]=useState<DevelopmentDocument>(initial);
  useEffect(() => {
    if (!sheet) return;
    const anchor = window.location.hash.slice(1);
    if (!/^material-[0-9a-f-]{36}$/.test(anchor)) return;
    window.document.getElementById(anchor)?.scrollIntoView({ block: "center" });
  }, [sheet]);
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
    try{const value=await digitalRequest<DevelopmentSheet>(path,method,body,operation.current.key);setSheet(value);installDocument(value.document??initial());setDirty(false);operation.current=null;}
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
    try{const response=await digitalRequest<{draftVersion?:number}>(path,publish?"POST":"PUT",body,operation.current.key);operation.current=null;setDirty(false);
      if(publish){const next=await digitalRequest<DevelopmentSheet>(base);setSheet(next);installDocument(next.document!);setRevision(null);setSelectedRound(next.roundNumber);const url=new URL(window.location.href);url.searchParams.set("round",String(next.roundNumber??1));window.history.replaceState(null,"",url);setRounds(await digitalRequest<Rounds>(`${base}/rounds`));}
      else{setDraftVersion(response.draftVersion!);const refreshed=await digitalRequest<Rounds>(`${base}/rounds`);setRounds(refreshed);if(refreshed.draft)installDocument(refreshed.draft.payload.document);}
    }catch(reason){setError(reason instanceof Error?reason.message:"复版操作失败");}finally{writing.current=false;setBusy(false);}
  };
  const upload=async(files:File[])=>{
    if(!files?.length||writing.current)return;writing.current=true;setBusy(true);setError("");
    try{
      let fileCount=document.files.length;
      const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
      for(const file of Array.from(files)){
        if(file.size>limits.maxUploadBytes)throw Error(`${file.name}超过上传大小限制`);
        const allowed=fileKind==="款图"||fileKind==="局部图"?["image/jpeg","image/png","image/webp"]:["image/jpeg","image/png","image/webp","application/pdf"];
        if(!allowed.includes(file.type))throw Error(`${file.name}的格式不适用于${fileKind}`);
        const hash=await sha256Hex(file),fingerprint=JSON.stringify([fileKind,file.name,file.size,hash]);
        if(successfulUploads.current.has(fingerprint))continue;
        if(fileCount>=30)throw Error("开发单最多30个附件");
        const intent=await digitalRequest<UploadIntentResponse>(`${base}/upload-intents`,"POST",{filename:file.name,mimeType:file.type,sizeBytes:file.size,sha256:hash});
        const form=new FormData();for(const [name,value]of Object.entries(intent.uploadFields))form.append(name,value);form.append("file",file);
        const response=await fetch(intent.uploadUrl,{method:intent.uploadMethod,body:form,credentials:"omit"});if(!response.ok)throw Error(`${file.name}上传失败`);
        await digitalRequest(`${base}/attachments/${intent.attachmentId}/finalize`,"POST",{});
        successfulUploads.current.set(fingerprint,intent.attachmentId);fileCount++;
        setDocument(current=>({...current,files:[...current.files,{attachmentId:intent.attachmentId,kind:fileKind}]}));setDirty(true);
      }
    }catch(reason){setError(reason instanceof Error?reason.message:"上传失败");}finally{writing.current=false;setBusy(false);}
  };
  const readonly=revision?!sheet?.canRevise:!sheet?.canEdit||sheet.status==="published";
  const imageUrl=(id:string)=>urls.apiUrl(`digital-production/${base}/attachments/${id}`);
  const changeMaterial=(index:number,patch:Partial<DevelopmentMaterial>)=>edit({materials:document.materials.map((item,i)=>i===index?{...item,...patch}:item)});
  const issues=validationMode?developmentIssues(document,quantityInput,measurementIds.current,validationMode==="publish",revision):[];
  const issue=(id:string)=>issues.find(value=>value.id===id)?.message;
  const field=(key:keyof DevelopmentDocument,label:string,maxLength=100,multiline=false)=><label>{label}<DocumentField id={`development-${key}`} label={label} value={String(document[key]??"")} onValue={value=>edit({[key]:value})} readonly={readonly} disabled={busy} maxLength={maxLength} multiline={multiline} issue={issue(`development-${key}`)}/></label>;
  const select=(key:"template"|"unit"|"craft"|"washing",label:string,options:readonly string[],change?:(value:string)=>void)=><label>{label}{readonly?<span className="dx-doc-readonly" id={`development-${key}`}>{key==="washing"?washingChoiceLabel(document[key]):document[key]}</span>:<select id={`development-${key}`} aria-label={label} disabled={busy} value={document[key]} onChange={event=>change?change(event.target.value):edit({[key]:event.target.value})}>{options.map(value=><option key={value} value={value}>{key==="washing"?washingChoiceLabel(value):value}</option>)}</select>}</label>;
  const flag=(id:string,label:string,value:boolean,onValue:(value:boolean)=>void,locked=readonly)=><label className="development-flag">{locked?<span id={id} className="dx-doc-readonly">{label}：{value?"有":"无"}</span>:<><input id={id} aria-label={label} type="checkbox" checked={value} disabled={busy} onChange={event=>onValue(event.target.checked)}/>{label}</>}</label>;
  const validate=(publish=false)=>{setValidationMode(publish?"publish":"save");return developmentIssues(document,quantityInput,measurementIds.current,publish,revision).length===0;};
  const save=()=>{if(!validate())return;if(revision)void revisionAction(false);else void run(base,{expectedVersion:sheet!.version,document},"PUT");};
  const publish=()=>{if(!validate(true))return;if(dirty){setError("请先保存当前修改");return;}if(revision)void revisionAction(true);else void run(`${base}/publish`,{expectedVersion:sheet!.version});};
  const reload=async()=>{if(writing.current||dirty&&!await confirmInApp("重新载入将丢弃未保存修改，确定继续？"))return;setBusy(true);try{const value=await digitalRequest<DevelopmentSheet>(`${base}${selectedRound?`?round=${selectedRound}`:""}`);setSheet(value);installDocument(value.document??initial());setRevision(null);setDirty(false);setError("");if(value.status==="published")setRounds(await digitalRequest<Rounds>(`${base}/rounds`));}catch(reason){setError(reason instanceof Error?reason.message:"读取失败");}finally{setBusy(false);}};
  const pictures=document.files.filter(file=>file.kind==="款图"||file.kind==="局部图");
  const savedPrint=revision?rounds.draft?.payload.document:sheet?.document;
  return <Surface><section className="development-editor dx-doc-development">
    <DocumentToolbar title="款式设计与制作说明单" status={busy?"保存中":error&&dirty?"没有保存成功，修改还在":dirty?"未保存修改":`${revision?`第${revision.basedOnRound+1}轮复版草稿`:sheet?.status==="published"?`已发布 · 第${sheet.roundNumber??1}轮${(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)?" · 当前有效轮次":" · 历史轮次"}`:"草稿"} · 版本 ${revision?draftVersion:sheet?.version??0}`}>
      <Button disabled={busy} onClick={onClose}>返回</Button>
      {!readonly&&<><Button disabled={busy} onClick={save}>保存草稿</Button><Button variant="primary" disabled={busy} onClick={publish}>{revision?"正式发布本轮修改":"发布开发单"}</Button></>}
      <Button disabled={!savedPrint||dirty||busy} onClick={()=>window.print()}>打印 / 保存 PDF</Button>
    </DocumentToolbar>
    <DocumentErrors issues={issues} error={error}/>{error&&<Button disabled={busy} onClick={()=>void reload()}>重新载入</Button>}
    {!sheet&&<p>正在读取开发单</p>}
    {sheet&&<>
      {dirty||busy||!savedPrint?<article className="development-print"><p>当前单据不可打印，请先保存当前修改。</p></article>:<DevelopmentPrint sheet={revision?{...sheet,status:"draft",roundNumber:revision.basedOnRound+1,version:draftVersion}:sheet} document={savedPrint} imageUrl={imageUrl}/>}
      <div className="development-heading dx-doc-card"><span>款号：<strong>{sheet.designStyleNo}</strong></span><span>代用号：{sheet.temporaryStyleNo??"—"}</span><span>客户：{sheet.customerCode??"通用开发"}</span><span>设计师：{sheet.designerName}</span><span>{sheet.developmentType} · 第{revision?revision.basedOnRound+1:sheet.roundNumber??1}轮 · 资料版本 {revision?draftVersion:sheet.version}</span></div>
      <DocumentAnchors sections={[{id:"development-basic",label:"基本资料"},{id:"development-materials",label:"面辅料"},{id:"development-sizes",label:"尺寸表"},{id:"development-craft",label:"工艺要求"},{id:"development-handling",label:"办理记录"}]}/>
      <form onSubmit={event=>{event.preventDefault();save();}}>
        {revision&&<section id="development-revision" tabIndex={-1} className="dx-doc-card development-revision"><DevelopmentRevisionFields value={revision} disabled={busy} onChange={value=>{setRevision(value);setDirty(true);}}/></section>}
        <div className="development-document-layout"><div className="development-document-left">
          <DocumentSection id="development-images" title="款图与制作说明"><div className="development-picture-layout"><div>
            <div className="development-main-picture">{pictures[0]?<a href={imageUrl(pictures[0].attachmentId)} target="_blank" rel="noreferrer"><img src={imageUrl(pictures[0].attachmentId)} alt={pictures[0].kind}/></a>:<span>款图</span>}</div>
            {pictures.length>1&&<div className="development-thumbnails">{pictures.slice(1).map(file=><a key={file.attachmentId} href={imageUrl(file.attachmentId)} target="_blank" rel="noreferrer"><img src={imageUrl(file.attachmentId)} alt={file.kind}/><span>{file.kind}</span></a>)}</div>}
          </div>{field("instructions","制作说明",1000,true)}</div></DocumentSection>
          <DocumentSection id="development-materials" title="面辅料" detail={`技术材料 · 共 ${document.materials.length} 行`}>
            {(["主布","配布","辅料"] as const).map(category=><section key={category} className="development-material-group"><h3>{category}</h3><DocumentTableScroll><table className="development-technical-table"><thead><tr>{["类别 / 名称","品名","规格","供应方","用量","数量","本轮所需","实物 / 预计到料","操作"].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>
              {document.materials.map((item,index)=>item.category!==category?null:<tr key={item.materialId} data-doc-row><td><DocumentField id={`development-${item.materialId}-label`} label={`${item.category}名称`} value={item.label} column="label" readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{label:value})} issue={issue(`development-${item.materialId}-label`)}/><details className="development-material-details"><summary>技术详情</summary><div>{(["width","weight","composition","color"] as const).map((key,i)=><label key={key}>{["幅宽","克重","成分","颜色"][i]}<DocumentField id={`development-${item.materialId}-${key}`} label={`${item.label} ${["幅宽","克重","成分","颜色"][i]}`} value={item[key]} readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{[key]:value})} issue={issue(`development-${item.materialId}-${key}`)}/></label>)}</div></details></td>
                {(["name","specification","supplier","consumption","quantity"] as const).map((key,i)=><td key={key}><DocumentField id={`development-${item.materialId}-${key}`} label={`${item.label} ${["品名","规格","供应方","用量","数量"][i]}`} value={item[key]} readonly={readonly} disabled={busy} column={key} onValue={value=>changeMaterial(index,{[key]:value})} issue={issue(`development-${item.materialId}-${key}`)}/></td>)}
                <td>{flag(`development-${item.materialId}-requiredThisRound`,"本轮所需",item.requiredThisRound,value=>changeMaterial(index,{requiredThisRound:value}))}</td><td>{flag(`development-${item.materialId}-available`,"已有实物",item.available,value=>changeMaterial(index,{available:value}))}<DocumentField id={`development-${item.materialId}-expectedDate`} label={`${item.label} 预计到料日期`} type="date" value={item.expectedDate??""} readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{expectedDate:value||null})} issue={issue(`development-${item.materialId}-expectedDate`)}/></td>
                <td>{!readonly&&<Button type="button" disabled={busy} onClick={async()=>{if(await confirmInApp(`删除${item.label||item.category}？`)&&!writing.current)edit({materials:document.materials.filter(row=>row.materialId!==item.materialId)});}}>删除</Button>}</td></tr>)}
            </tbody></table></DocumentTableScroll>{!readonly&&<DocumentAddRow label={`添加${category}`} disabled={busy||document.materials.length>=100} onClick={()=>{const next=material(category,category);edit({materials:[...document.materials,next]});requestAnimationFrame(()=>window.document.getElementById(`development-${next.materialId}-label`)?.focus());}}/>}</section>)}
          </DocumentSection>
          <DocumentSection id="development-sizes" title="尺寸表" detail={`${document.sizes.length} 尺码 · ${document.measurements.length} 项目`}>
            {select("unit","尺寸单位",["cm","inch"])}<DocumentTableScroll><table className="development-size-table"><thead><tr><th>测量项目</th>{document.sizes.map((size,index)=><th key={index}><DocumentField id={`development-size-${index}`} label={`尺码列 ${index+1}`} value={size} readonly={readonly} disabled={busy} issue={issue(`development-size-${index}`)} onValue={value=>edit({sizes:document.sizes.map((old,i)=>i===index?value:old)})}/></th>)}</tr></thead><tbody>{document.measurements.map((row,index)=><tr key={measurementIds.current[index]} data-doc-row><th><DocumentField id={`development-measurement-${measurementIds.current[index]}-name`} label={`尺寸项目 ${index+1}`} value={row.name} readonly={readonly} disabled={busy} column="name" issue={issue(`development-measurement-${measurementIds.current[index]}-name`)} onValue={value=>edit({measurements:document.measurements.map((old,i)=>i===index?{...old,name:value}:old)})}/></th>{row.values.map((value,column)=><td key={column}><DocumentField id={`development-measurement-${measurementIds.current[index]}-${column}`} label={`${row.name} ${document.sizes[column]}`} value={value} readonly={readonly} disabled={busy} column={`size-${column}`} issue={issue(`development-measurement-${measurementIds.current[index]}-${column}`)} onValue={value=>edit({measurements:document.measurements.map((old,i)=>i===index?{...old,values:old.values.map((v,c)=>c===column?value:v)}:old)})}/></td>)}</tr>)}</tbody></table></DocumentTableScroll>
            {!readonly&&<div className="development-actions"><DocumentAddRow label="添加尺码列" disabled={busy||document.sizes.length>=20} onClick={()=>edit({sizes:[...document.sizes,`尺码${document.sizes.length+1}`],measurements:document.measurements.map(row=>({...row,values:[...row.values,""]}))})}/><DocumentAddRow label="添加尺寸行" disabled={busy||document.measurements.length>=100} onClick={()=>{const id=createClientRequestId();measurementIds.current.push(id);edit({measurements:[...document.measurements,{name:"",values:document.sizes.map(()=>"")}]});requestAnimationFrame(()=>window.document.getElementById(`development-measurement-${id}-name`)?.focus());}}/></div>}
          </DocumentSection>
          <DocumentSection id="development-files" title="附件" detail={`${document.files.length} / 30`}>
            {!readonly&&<div className="development-file-controls"><label>附件类型<select aria-label="附件类型" disabled={busy} value={fileKind} onChange={event=>setFileKind(event.target.value as typeof fileKind)}>{["款图","局部图","菲林","工艺开发板"].map(value=><option key={value}>{value}</option>)}</select></label><label>上传图片 / 文件<input id="development-upload" disabled={busy||document.files.length>=30} type="file" multiple accept={fileKind==="款图"||fileKind==="局部图"?"image/jpeg,image/png,image/webp":"image/jpeg,image/png,image/webp,application/pdf"} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void upload(files);}}/></label></div>}
            <div className="development-file-list">{document.files.map(file=><div key={file.attachmentId}><a href={imageUrl(file.attachmentId)} target="_blank" rel="noreferrer">{file.kind}</a>{!readonly&&<Button type="button" disabled={busy} onClick={()=>{for(const [key,id]of successfulUploads.current)if(id===file.attachmentId)successfulUploads.current.delete(key);edit({files:document.files.filter(item=>item.attachmentId!==file.attachmentId)});}}>移除</Button>}</div>)}</div>
          </DocumentSection>
        </div><div className="development-document-right">
          <DocumentSection id="development-basic" title="基本资料"><div className="development-basic-grid">
            {select("template","模板",["上衣","裤子"],async value=>{const template=value as DevelopmentDocument["template"];if(await confirmInApp("切换模板将重置尺寸项目，继续？")&&!writing.current){measurementIds.current=DEVELOPMENT_MEASUREMENTS[template].map(()=>createClientRequestId());edit({template,measurements:DEVELOPMENT_MEASUREMENTS[template].map(name=>({name,values:document.sizes.map(()=>"")}))});}})}
            <label>数量<DocumentField id="development-quantity" label="数量" value={quantityInput} numeric readonly={readonly} disabled={busy} issue={issue("development-quantity")} onValue={value=>{setQuantityInput(value);edit({quantity:/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=100000?Number(value):null});}}/></label>
            {field("sampleSize","样板尺码")}{(["orderDate","returnDate"] as const).map((key,index)=><label key={key}>{["下单日期","回版日期"][index]}<DocumentField id={`development-${key}`} label={["下单日期","回版日期"][index]!} type="date" value={document[key]??""} readonly={readonly} disabled={busy} issue={issue(`development-${key}`)} onValue={value=>edit({[key]:value||null})}/></label>)}
            {select("craft","工艺",["无","印花","绣花","印绣花"])}{select("washing","洗水",["免洗","内洗","外洗"])}
          </div></DocumentSection>
          <DocumentSection id="development-craft" title="工艺要求"><div className="development-craft-groups">
            {([{title:"朴料",keys:["interlining","placketInterlining"]},{title:"车缝",keys:["sewingThread","buttonholeThread","stitchDensity"]},{title:"洗水整烫与包装",keys:["washingIroning","packaging"]},{title:"尺码标识",keys:["formalSizes","casualSizes"]}] as const).map(group=><section key={group.title}><h3>{group.title}</h3><div>{group.keys.map(key=><div key={key}>{field(key,labels[key],key==="formalSizes"||key==="casualSizes"?100:1000,key==="washingIroning"||key==="packaging")}</div>)}</div></section>)}
            <section><h3>唛类</h3><div>{(["mainLabel","sizeLabel","careLabel"] as const).map((key,index)=><div key={key}>{flag(`development-${key}`,["主唛","码唛","洗水唛"][index]!,document[key],value=>edit({[key]:value}))}</div>)}{field("mainLabelMethod","主唛车法",1000,true)}</div></section>
          </div></DocumentSection>
        </div></div>
      </form>
      <DocumentSection id="development-handling" title="办理记录">
        {sheet.status==="published"&&<div className="development-round-controls"><label>查看轮次<select aria-label="查看轮次" disabled={busy||Boolean(revision)} value={sheet.roundNumber??1} onChange={async event=>{const round=Number(event.target.value);if((!dirty||await confirmInApp("有未保存修改，确定切换轮次？"))&&!writing.current){setSelectedRound(round);const url=new URL(window.location.href);url.searchParams.set("round",String(round));window.history.replaceState(null,"",url);}}}><option value={1}>第1轮 · 原始开发</option>{rounds.rounds.map(round=><option key={round.roundNumber} value={round.roundNumber}>第{round.roundNumber}轮 · {round.origin}</option>)}</select></label>{sheet.canRevise&&!revision&&<Button disabled={busy} onClick={beginRevision}>{rounds.draft?"继续复版草稿":"发起实际修改 / 复版"}</Button>}
          {rounds.rounds.filter(round=>round.roundNumber===(sheet.roundNumber??1)).map(round=><div key={round.roundNumber}><p>{round.origin} · {round.customerComment||round.internalProblem}</p><p>{round.explanation}</p><p>重做：{round.affectedNodes.join("、")}</p><p>沿用 {Object.keys(round.inherited).length} 项已完成记录</p><ul>{Object.entries(round.inherited).map(([node,reference])=><li key={node}><a href={`${urls.pageUrl("ui/digital-production")}?task=${reference.taskId}`}>{inheritedLabels[node]??"已完成节点"} · 第{reference.roundNumber}轮原记录</a></li>)}</ul></div>)}
        </div>}
        {sheet.status==="published"&&!revision&&(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)&&<DevelopmentExecutionPanel key={sheet.roundNumber??1} sourceId={sourceId} materialRevision={sheet.materialEvents.length}/>}
        {sheet.status==="published"&&!revision&&<section className="development-material-events"><h3>本轮物料记录</h3>{document.materials.filter(item=>item.requiredThisRound).map(item=><div key={item.materialId} id={`material-${item.materialId}`}><h4>{item.label||item.name}</h4><p>{item.available?"发布时已有实物":"发布时未到"} · 原预计：{item.expectedDate??"未定"}</p>{sheet.materialEvents.filter(event=>event.materialId===item.materialId).map(event=><p key={event.eventId}>{event.action} · {event.expectedDate??""} · {event.note} · {new Date(event.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</p>)}
          {sheet.canEdit&&<form onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void run(`${base}/materials/${item.materialId}/events`,{expectedMaterialRevision:sheet.materialEvents.filter(event=>event.materialId===item.materialId).length,expectedVersion:sheet.version,action:form.get("action"),expectedDate:form.get("date")||null,note:form.get("note")});}}><fieldset disabled={busy}><label>操作<select name="action"><option>到货</option><option>修改预计日期</option>{item.category==="辅料"&&<option>确认代用</option>}</select></label><label>预计日期<input type="date" name="date"/></label><label>说明<input name="note" maxLength={1000}/></label><Button type="submit">确认记录</Button></fieldset></form>}
        </div>)}</section>}
      </DocumentSection>
    </>}
  </section></Surface>;
}
