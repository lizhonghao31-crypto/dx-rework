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
const urls = createWebUrls(import.meta.env.BASE_URL);
const material = (category: DevelopmentMaterial["category"], label: string): DevelopmentMaterial => ({materialId:createClientRequestId(),category,label,supplier:"",name:"",width:"",weight:"",composition:"",consumption:"",color:"",specification:"",quantity:"",requiredThisRound:true,available:false,expectedDate:null});
const initial = (): DevelopmentDocument => ({template:"上衣",quantity:null,sampleSize:"",orderDate:null,returnDate:null,unit:"cm",sizes:["M","L"],measurements:DEVELOPMENT_MEASUREMENTS.上衣.map(name=>({name,values:["",""]})),interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[material("主布","主布 A"),material("配布","配布 B"),material("配布","配布 C")].map(item=>({...item,requiredThisRound:false})),files:[]});
const inheritedLabels:Record<string,string>={development_materials:"核配",development_pattern:"纸样",development_cutting:"裁板",development_printing:"印花",development_embroidery:"绣花",development_print_embroidery:"印绣花",development_craft_confirmation:"工艺确认",development_sewing:"车板",development_washing:"洗水",development_tail_check:"尾查",development_confirmation:"最终设计确认",development_shipping:"寄样",development_craft_dispatch:"发工艺",development_sewing_transfer:"转交车板",development_washing_dispatch:"送洗"};
const labels = {interlining:"朴号",placketInterlining:"门筒朴",sewingThread:"车缝线",buttonholeThread:"纽门线",stitchDensity:"针距",washingIroning:"洗水整烫方法",packaging:"包装方法",formalSizes:"正装尺码",casualSizes:"休闲尺码",mainLabelMethod:"主唛车法",instructions:"制作说明"} as const;
type RoundHistory={roundNumber:number;origin:string;customerComment:string;internalProblem:string;explanation:string;affectedNodes:string[];inherited:Record<string,{taskId:string;roundNumber:number}>};
type Rounds={rounds:RoundHistory[];draft:{version:number;payload:DevelopmentRevision}|null};
export function DigitalDevelopmentPanel({sourceId,onClose,initialRound}:{sourceId:string;onClose:()=>void;initialRound?:number|undefined}) {
  const [sheet,setSheet]=useState<DevelopmentSheet|null>(null),[document,setDocument]=useState<DevelopmentDocument>(initial);
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);
  const [revision,setRevision]=useState<RevisionFields|null>(null),[draftVersion,setDraftVersion]=useState(0),[rounds,setRounds]=useState<Rounds>({rounds:[],draft:null}),[selectedRound,setSelectedRound]=useState<number|undefined>(initialRound);
  const [fileKind,setFileKind]=useState<DevelopmentDocument["files"][number]["kind"]>("款图");
  const writing=useRef(false),operation=useRef<{payload:string;key:string}|null>(null);
  const base=`sources/${sourceId}/development`;
  useEffect(()=>{let live=true;void digitalRequest<DevelopmentSheet>(`${base}${selectedRound?`?round=${selectedRound}`:""}`).then(value=>{if(live){setSheet(value);setDocument(value.document??initial());setDirty(false);if(value.status==="published")void digitalRequest<Rounds>(`${base}/rounds`).then(data=>{if(live)setRounds(data);}).catch(reason=>{if(live)setError(reason.message);});}}).catch(reason=>{if(live)setError(reason.message);});return()=>{live=false;};},[sourceId,selectedRound]);
  const edit=(patch:Partial<DevelopmentDocument>)=>{setDocument(current=>({...current,...patch}));setDirty(true);};
  const run=async(path:string,body:unknown,method="POST")=>{
    if(writing.current)return;writing.current=true;setBusy(true);setError("");
    const payload=JSON.stringify([path,body,method]);if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
    try{const value=await digitalRequest<DevelopmentSheet>(path,method,body,operation.current.key);setSheet(value);setDocument(value.document??initial());setDirty(false);operation.current=null;}
    catch(reason){setError(reason instanceof Error?reason.message:"操作失败");}finally{writing.current=false;setBusy(false);}
  };
  const beginRevision=()=>{
    const draft=rounds.draft;setDocument(draft?.payload.document??sheet!.document!);
    setRevision(draft?{...draft.payload}:{basedOnRound:sheet!.latestRoundNumber??1,origin:"客户新增要求",customerComment:"",internalProblem:"",explanation:`参考第${sheet!.roundNumber??1}轮资料`,categories:["其他"],affectedNodes:["车板"],outputKind:"整件样板"});
    setDraftVersion(draft?.version??0);setDirty(!draft);
  };
  const revisionAction=async(publish:boolean)=>{
    if(!revision||writing.current)return;writing.current=true;setBusy(true);setError("");
    const body=publish?{expectedDraftVersion:draftVersion,basedOnRound:revision.basedOnRound}:{expectedDraftVersion:draftVersion,revision:{...revision,document}};
    const path=`${base}/${publish?"round-publish":"round-draft"}`,payload=JSON.stringify([path,body]);if(operation.current?.payload!==payload)operation.current={payload,key:createClientRequestId()};
    try{const response=await digitalRequest<{draftVersion?:number}>(path,publish?"POST":"PUT",body,operation.current.key);operation.current=null;setDirty(false);
      if(publish){const next=await digitalRequest<DevelopmentSheet>(base);setSheet(next);setDocument(next.document!);setRevision(null);setSelectedRound(next.roundNumber);const url=new URL(window.location.href);url.searchParams.set("round",String(next.roundNumber??1));window.history.replaceState(null,"",url);setRounds(await digitalRequest<Rounds>(`${base}/rounds`));}
      else{setDraftVersion(response.draftVersion!);setRounds(await digitalRequest<Rounds>(`${base}/rounds`));}
    }catch(reason){setError(reason instanceof Error?reason.message:"复版操作失败");}finally{writing.current=false;setBusy(false);}
  };
  const upload=async(files:File[])=>{
    if(!files?.length||writing.current)return;writing.current=true;setBusy(true);setError("");
    try{
      const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
      for(const file of Array.from(files)){
        if(file.size>limits.maxUploadBytes)throw Error(`${file.name}超过上传大小限制`);
        const intent=await digitalRequest<UploadIntentResponse>(`${base}/upload-intents`,"POST",{filename:file.name,mimeType:file.type,sizeBytes:file.size,sha256:await sha256Hex(file)});
        const form=new FormData();for(const [name,value]of Object.entries(intent.uploadFields))form.append(name,value);form.append("file",file);
        const response=await fetch(intent.uploadUrl,{method:intent.uploadMethod,body:form,credentials:"omit"});if(!response.ok)throw Error(`${file.name}上传失败`);
        await digitalRequest(`${base}/attachments/${intent.attachmentId}/finalize`,"POST",{});
        setDocument(current=>({...current,files:[...current.files,{attachmentId:intent.attachmentId,kind:fileKind}]}));setDirty(true);
      }
    }catch(reason){setError(reason instanceof Error?reason.message:"上传失败");}finally{writing.current=false;setBusy(false);}
  };
  const readonly=revision?!sheet?.canRevise:!sheet?.canEdit||sheet.status==="published";
  const imageUrl=(id:string)=>urls.apiUrl(`digital-production/${base}/attachments/${id}`);
  const changeMaterial=(index:number,patch:Partial<DevelopmentMaterial>)=>edit({materials:document.materials.map((item,i)=>i===index?{...item,...patch}:item)});
  return <Surface><section className="development-editor">
    <div className="pattern-actions development-controls"><Button disabled={busy} onClick={async()=>{if(!dirty||await confirmInApp("有未保存修改，确定离开？"))onClose();}}>返回</Button>
      <Button disabled={!sheet?.document||dirty||busy} onClick={()=>window.print()}>打印 / 保存 PDF</Button>
      <span>{revision?`第${revision.basedOnRound+1}轮复版草稿`:sheet?.status==="published"?"已发布":"草稿"}{(revision?draftVersion:sheet?.version)?` · 版本 ${revision?draftVersion:sheet?.version}`:""}</span></div>
    {sheet?.status==="published"&&<div className="development-controls"><label>查看轮次<select disabled={busy||Boolean(revision)} value={sheet.roundNumber??1} onChange={async event=>{const round=Number(event.target.value);if(!dirty||await confirmInApp("有未保存修改，确定切换轮次？")){setSelectedRound(round);const url=new URL(window.location.href);url.searchParams.set("round",String(round));window.history.replaceState(null,"",url);}}}><option value={1}>第1轮 · 原始开发</option>{rounds.rounds.map(round=><option key={round.roundNumber} value={round.roundNumber}>第{round.roundNumber}轮 · {round.origin}</option>)}</select></label>{sheet.canRevise&&!revision&&<Button disabled={busy} onClick={beginRevision}>{rounds.draft?"继续复版草稿":"发起实际修改 / 复版"}</Button>}
      {rounds.rounds.filter(round=>round.roundNumber===(sheet.roundNumber??1)).map(round=><div key={round.roundNumber}><p>{round.origin} · {round.customerComment||round.internalProblem}</p><p>{round.explanation}</p><p>重做：{round.affectedNodes.join("、")}</p><p>沿用 {Object.keys(round.inherited).length} 项已完成记录</p><ul>{Object.entries(round.inherited).map(([node,reference])=><li key={node}><a href={`${urls.pageUrl("ui/digital-production")}?task=${reference.taskId}`}>{inheritedLabels[node]??"已完成节点"} · 第{reference.roundNumber}轮原记录</a></li>)}</ul></div>)}
    </div>}
    {error&&<p role="alert">{error}</p>}
    {sheet&&<><DevelopmentPrint sheet={revision?{...sheet,status:"draft",roundNumber:revision.basedOnRound+1,version:draftVersion}:sheet} document={document} imageUrl={imageUrl}/><form onSubmit={event=>{event.preventDefault();if(revision)void revisionAction(false);else void run(base,{expectedVersion:sheet.version,document},"PUT");}}>
      {revision&&<DevelopmentRevisionFields value={revision} disabled={busy} onChange={value=>{setRevision(value);setDirty(true);}}/>}
      <fieldset disabled={readonly||busy}>
      <header><h2>广州市达兴制衣有限公司</h2><h3>款式设计与制作说明单</h3></header>
      <div className="development-heading"><span>客户：{sheet.customerCode??"通用开发"}</span><span>款号：{sheet.designStyleNo}</span><span>代用号：{sheet.temporaryStyleNo??"—"}</span><span>{sheet.developmentType}</span><span>设计师：{sheet.designerName}</span></div>
      <div className="pattern-actions"><label>模板<select value={document.template} onChange={async event=>{const template=event.target.value as DevelopmentDocument["template"];if(await confirmInApp("切换模板将重置尺寸项目，继续？"))edit({template,measurements:DEVELOPMENT_MEASUREMENTS[template].map(name=>({name,values:document.sizes.map(()=>"")}))});}}><option>上衣</option><option>裤子</option></select></label>
        <label>数量<input type="number" min={1} max={100000} value={document.quantity??""} onChange={event=>edit({quantity:event.target.value?Number(event.target.value):null})}/></label>
        <label>样板尺码<input value={document.sampleSize} onChange={event=>edit({sampleSize:event.target.value})}/></label>
        <label>下单日期<input type="date" value={document.orderDate??""} onChange={event=>edit({orderDate:event.target.value||null})}/></label>
        <label>回版日期<input type="date" value={document.returnDate??""} onChange={event=>edit({returnDate:event.target.value||null})}/></label></div>
      <div className="development-sheet-layout"><div className="development-images">
        {document.files.filter(file=>file.kind==="款图"||file.kind==="局部图").map(file=><figure key={file.attachmentId}><img src={imageUrl(file.attachmentId)} alt={file.kind}/><figcaption>{file.kind}</figcaption></figure>)}
        {!document.files.some(file=>file.kind==="款图")&&<p>款图</p>}
        <label>制作说明<textarea rows={6} value={document.instructions} onChange={event=>edit({instructions:event.target.value})}/></label>
      </div><div className="development-specifications">
        <label>尺寸单位<select value={document.unit} onChange={event=>edit({unit:event.target.value as "cm"|"inch"})}><option>cm</option><option>inch</option></select></label>
        <div className="development-table-scroll"><table><thead><tr><th>尺码</th>{document.sizes.map((size,index)=><th key={index}><input aria-label={`尺码列 ${index+1}`} value={size} onChange={event=>edit({sizes:document.sizes.map((value,i)=>i===index?event.target.value:value)})}/></th>)}</tr></thead><tbody>{document.measurements.map((row,index)=><tr key={index}><th><input aria-label={`尺寸项目 ${index+1}`} value={row.name} onChange={event=>edit({measurements:document.measurements.map((item,i)=>i===index?{...item,name:event.target.value}:item)})}/></th>{row.values.map((value,column)=><td key={column}><input aria-label={`${row.name} ${document.sizes[column]}`} value={value} onChange={event=>edit({measurements:document.measurements.map((item,i)=>i===index?{...item,values:item.values.map((v,c)=>c===column?event.target.value:v)}:item)})}/></td>)}</tr>)}</tbody></table></div>
        {!readonly&&<div className="pattern-actions development-controls"><Button type="button" disabled={document.sizes.length>=20} onClick={()=>edit({sizes:[...document.sizes,`尺码${document.sizes.length+1}`],measurements:document.measurements.map(row=>({...row,values:[...row.values,""]}))})}>添加尺码列</Button><Button type="button" disabled={document.measurements.length>=100} onClick={()=>edit({measurements:[...document.measurements,{name:"",values:document.sizes.map(()=>"")}]})}>添加尺寸行</Button></div>}
        {Object.entries(labels).filter(([key])=>key!=="instructions").map(([key,label])=><label key={key}>{label}<textarea rows={1} value={document[key as keyof typeof labels]} onChange={event=>edit({[key]:event.target.value})}/></label>)}
        <div className="pattern-actions">{(["mainLabel","sizeLabel","careLabel"] as const).map((key,index)=><label key={key}><input type="checkbox" checked={document[key]} onChange={event=>edit({[key]:event.target.checked})}/>{["主唛","码唛","洗水唛"][index]}</label>)}</div>
      </div></div>
      <div className="pattern-actions"><label>工艺<select value={document.craft} onChange={event=>edit({craft:event.target.value as DevelopmentDocument["craft"]})}>{["无","印花","绣花","印绣花"].map(value=><option key={value}>{value}</option>)}</select></label><label>洗水<select value={document.washing} onChange={event=>edit({washing:event.target.value as DevelopmentDocument["washing"]})}>{["免洗","内洗","外洗"].map(value=><option key={value}>{value}</option>)}</select></label></div>
      <div className="development-materials">{document.materials.map((item,index)=><fieldset key={item.materialId}><legend>{item.label||item.category}</legend>
        <label>名称<input value={item.label} onChange={event=>changeMaterial(index,{label:event.target.value})}/></label>
        <label><input type="checkbox" checked={item.requiredThisRound} onChange={event=>changeMaterial(index,{requiredThisRound:event.target.checked})}/>本轮所需</label>
        {Object.entries({supplier:"布行 / 供应商",name:"品名",width:"幅宽",weight:"克重",composition:"成分",consumption:"用量",color:"颜色",specification:"规格",quantity:"数量"}).map(([key,label])=><label key={key}>{label}<input value={String(item[key as keyof DevelopmentMaterial])} onChange={event=>changeMaterial(index,{[key]:event.target.value})}/></label>)}
        <label><input type="checkbox" checked={item.available} onChange={event=>changeMaterial(index,{available:event.target.checked})}/>已有实物</label>
        <label>预计到料日期<input type="date" value={item.expectedDate??""} onChange={event=>changeMaterial(index,{expectedDate:event.target.value||null})}/></label>
        {!readonly&&<Button type="button" onClick={()=>edit({materials:document.materials.filter((_,i)=>i!==index)})}>删除此行</Button>}
      </fieldset>)}</div>
      {!readonly&&<div className="pattern-actions development-controls">{(["主布","配布","辅料"]as const).map(category=><Button key={category} type="button" disabled={document.materials.length>=100} onClick={()=>edit({materials:[...document.materials,material(category,category)]})}>添加{category}</Button>)}</div>}
      </fieldset>
      <div className="development-controls">{!readonly&&<><label>附件类型<select disabled={busy} value={fileKind} onChange={event=>setFileKind(event.target.value as typeof fileKind)}>{["款图","局部图","菲林","工艺开发板"].map(value=><option key={value}>{value}</option>)}</select></label><label>上传图片 / 文件<input disabled={busy} type="file" multiple accept={fileKind==="款图"||fileKind==="局部图"?"image/jpeg,image/png,image/webp":"image/jpeg,image/png,image/webp,application/pdf"} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void upload(files);}}/></label></>}
      {document.files.map(file=><div className="pattern-actions" key={file.attachmentId}><a href={imageUrl(file.attachmentId)} target="_blank" rel="noreferrer">{file.kind}</a>{!readonly&&<Button type="button" disabled={busy} onClick={()=>edit({files:document.files.filter(item=>item.attachmentId!==file.attachmentId)})}>移除</Button>}</div>)}
      {!readonly&&<div className="pattern-actions"><Button type="submit" disabled={busy}>保存草稿</Button><Button type="button" disabled={busy||dirty||(revision?!draftVersion:!sheet.version)} onClick={()=>{if(revision)void revisionAction(true);else void run(`${base}/publish`,{expectedVersion:sheet.version});}}>{revision?"正式发布本轮修改":"发布开发单"}</Button></div>}</div>
    </form>
    {sheet.status==="published"&&!revision&&(sheet.roundNumber??1)===(sheet.latestRoundNumber??1)&&<DevelopmentExecutionPanel key={sheet.roundNumber??1} sourceId={sourceId}/>}
    {sheet.status==="published"&&!revision&&<section className="development-controls"><h3>本轮物料记录</h3>{document.materials.filter(item=>item.requiredThisRound).map(item=><div key={item.materialId}><h4>{item.label||item.name}</h4><p>{item.available?"发布时已有实物":"发布时未到"} · 原预计：{item.expectedDate??"未定"}</p>{sheet.materialEvents.filter(event=>event.materialId===item.materialId).map(event=><p key={event.eventId}>{event.action} · {event.expectedDate??""} · {event.note} · {new Date(event.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</p>)}
      {sheet.canEdit&&<form onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void run(`${base}/materials/${item.materialId}/events`,{expectedMaterialRevision:sheet.materialEvents.filter(event=>event.materialId===item.materialId).length,expectedVersion:sheet.version,action:form.get("action"),expectedDate:form.get("date")||null,note:form.get("note")});}}><fieldset disabled={busy}><label>操作<select name="action"><option>到货</option><option>修改预计日期</option>{item.category==="辅料"&&<option>确认代用</option>}</select></label><label>预计日期<input type="date" name="date"/></label><label>说明<input name="note" maxLength={1000}/></label><Button type="submit">确认记录</Button></fieldset></form>}</div>)}</section>}
    </>}
  </section></Surface>;
}
