import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Button } from "@dx-rework/ui";
import { DEVELOPMENT_MEASUREMENTS, type DevelopmentDocument, type DevelopmentMaterial } from "@dx-rework/contracts/digital-development";
import { washingChoiceLabel } from "./digital-workspace-copy.js";
import { removeDevelopmentSize } from "./digital-development-editing.js";
import { createClientRequestId } from "./client-request-id.js";
import { confirmInApp } from "./system-dialog.js";
import { DocumentTableScroll, DocumentField, DocumentSection, DocumentAddRow } from "./document-editor.js";
type FileKind = DevelopmentDocument["files"][number]["kind"];
type Props = {
 document:DevelopmentDocument;edit:(patch:Partial<DevelopmentDocument>)=>void;readonly:boolean;busy:boolean;
 writing:{current:boolean};quantityInput:string;setQuantityInput:(value:string)=>void;
 measurementIds:{current:string[]};successfulUploads:{current:Map<string,string>};
 imageUrl:(id:string)=>string;upload:(files:File[])=>Promise<void>;fileKind:FileKind;setFileKind:(value:FileKind)=>void;
 issue:(id:string)=>string|undefined;patternSection?:ReactNode;uploadHelp?:string;templateResetKey?:string|number;attachmentPageSize?:number;
};
const material = (category: DevelopmentMaterial["category"], label: string): DevelopmentMaterial => ({materialId:createClientRequestId(),category,label,supplier:"",name:"",width:"",weight:"",composition:"",consumption:"",color:"",specification:"",quantity:"",requiredThisRound:true,available:false,expectedDate:null});
const fileKinds=["款图","局部图","菲林","工艺开发板"] as const;
const fileLabels:Record<FileKind,string>={款图:"主款图",局部图:"局部图",菲林:"菲林图",工艺开发板:"工艺开发板"};
const labels = {interlining:"朴号",placketInterlining:"门筒朴",sewingThread:"车缝线",buttonholeThread:"纽门线",stitchDensity:"针距",washingMethod:"洗水方法",ironing:"整烫方法",packaging:"包装方法",formalSizes:"正装尺码",casualSizes:"休闲尺码",mainLabelMethod:"主唛车法",instructions:"制作说明"} as const;
export function DevelopmentDocumentFields({document,edit,readonly,busy,writing,quantityInput,setQuantityInput,measurementIds,successfulUploads,imageUrl,upload,fileKind,setFileKind,issue,patternSection,uploadHelp,templateResetKey,attachmentPageSize}:Props){
  const removeSize=async(index:number)=>{
    const filled=Boolean(document.sizes[index]?.trim())||document.measurements.some(row=>row.values[index]?.trim());
    if(filled&&!await confirmInApp("删除这个尺码列及对应的尺寸值？"))return;
    if(!writing.current)edit(removeDevelopmentSize(document,index));
  };
  const removeMeasurement=async(index:number)=>{
    const row=document.measurements[index];
    if((row?.name.trim()||row?.values.some(value=>value.trim()))&&!await confirmInApp("删除这个尺寸行及全部数值？"))return;
    if(writing.current)return;
    measurementIds.current=measurementIds.current.filter((_,position)=>position!==index);
    edit({measurements:document.measurements.filter((_,position)=>position!==index)});
  };
  const [previousTemplate,setPreviousTemplate]=useState<{template:DevelopmentDocument["template"];sizes:string[];measurements:DevelopmentDocument["measurements"];ids:string[]}|null>(null);
  useEffect(()=>setPreviousTemplate(null),[templateResetKey]);
  const [choosingKind,setChoosingKind]=useState(false);
  const replaceTemplate=async(value:string)=>{
    const template=value as DevelopmentDocument["template"];
    if(template===document.template)return;
    const filled=document.measurements.some(row=>row.values.some(value=>value.trim()));
    if(!await confirmInApp(`切换为${template}尺寸模板将替换当前尺寸项目${filled?"和已填写的尺寸值":""}。取消保留原内容；替换后可撤回。继续？`)||writing.current)return;
    setPreviousTemplate({template:document.template,sizes:[...document.sizes],measurements:structuredClone(document.measurements),ids:[...measurementIds.current]});
    measurementIds.current=DEVELOPMENT_MEASUREMENTS[template].map(()=>createClientRequestId());
    edit({template,measurements:DEVELOPMENT_MEASUREMENTS[template].map(name=>({name,values:document.sizes.map(()=>"")}))});
  };
  const undoTemplate=async()=>{
    if(!previousTemplate||!await confirmInApp("恢复替换前的尺码列和尺寸值？替换后的尺寸填写将移除。")||writing.current)return;
    measurementIds.current=previousTemplate.ids;
    edit({template:previousTemplate.template,sizes:previousTemplate.sizes,measurements:previousTemplate.measurements});setPreviousTemplate(null);
  };
  const changeAvailability=async(index:number,value:boolean)=>{
    const item=document.materials[index];if(!item)return;
    if(value&&item.expectedDate&&!await confirmInApp(`标记已有实物后，预计到料 ${item.expectedDate} 作为原计划保留，当前不再编辑。继续？`))return;
    if(!writing.current)changeMaterial(index,{available:value});
  };
  const pickKind=(kind:FileKind)=>{setFileKind(kind);setChoosingKind(false);requestAnimationFrame(()=>window.document.getElementById("development-upload")?.click());};
  const changeMaterial=(index:number,patch:Partial<DevelopmentMaterial>)=>edit({materials:document.materials.map((item,i)=>i===index?{...item,...patch}:item)});
  const field=(key:keyof DevelopmentDocument,label:string,maxLength=100,multiline=false)=><label>{label}<DocumentField id={`development-${key}`} label={label} value={String(document[key]??"")} onValue={value=>edit({[key]:value})} readonly={readonly} disabled={busy} maxLength={maxLength} multiline={multiline} issue={issue(`development-${key}`)}/></label>;
  const select=(key:"template"|"unit"|"craft"|"washing",label:string,options:readonly string[],change?:(value:string)=>void)=><label>{label}{readonly?<span className="dx-doc-readonly" id={`development-${key}`}>{key==="washing"?washingChoiceLabel(document[key]):document[key]}</span>:<select id={`development-${key}`} aria-label={label} disabled={busy} value={document[key]} onChange={event=>change?change(event.target.value):edit({[key]:event.target.value})}>{options.map(value=><option key={value} value={value}>{key==="washing"?washingChoiceLabel(value):value}</option>)}</select>}</label>;
  const flag=(id:string,label:string,value:boolean,onValue:(value:boolean)=>void,locked=readonly,compact=false)=><label className="development-flag">{locked?<span id={id} className="dx-doc-readonly" aria-label={label}>{compact?"":`${label}：`}{value?"有":"无"}</span>:<><input id={id} aria-label={label} type="checkbox" checked={value} disabled={busy} onChange={event=>onValue(event.target.checked)}/>{!compact&&label}</>}</label>;
  const [activePicture,setActivePicture]=useState<string|null>(null);
  const pictures=document.files.filter(file=>file.kind===fileKind);
  const [picturePage,setPicturePage]=useState(1);
  useEffect(()=>{setPicturePage(1);setActivePicture(null);},[fileKind,templateResetKey]);
  const pageSize=attachmentPageSize??Math.max(pictures.length,1),currentPage=Math.min(picturePage,Math.max(1,Math.ceil(pictures.length/pageSize))),visiblePictures=pictures.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const heroPicture=pictures.find(file=>file.attachmentId===activePicture)??pictures[0];
  return <div className="development-document-layout">
<DocumentSection id="development-images" title="款图与制作说明" detail="主款图发布必填；其它附件与说明选填">
            <div className="development-file-tabs" role="group" aria-label="附件分类">{fileKinds.map(kind=><Button key={kind} type="button" aria-pressed={fileKind===kind} onClick={()=>setFileKind(kind)}>{fileLabels[kind]}（{document.files.filter(file=>file.kind===kind).length}）</Button>)}</div>
            <div className="development-picture-layout"><div>
              <div className="development-main-picture">{heroPicture?fileKind==="款图"||fileKind==="局部图"?<a href={imageUrl(heroPicture.attachmentId)} target="_blank" rel="noreferrer"><img src={imageUrl(heroPicture.attachmentId)} alt={fileLabels[fileKind]}/></a>:<object data={imageUrl(heroPicture.attachmentId)} aria-label={`${fileLabels[fileKind]}预览`}><a href={imageUrl(heroPicture.attachmentId)} target="_blank" rel="noreferrer">打开{fileLabels[fileKind]}图片或 PDF</a></object>:<span>尚未上传{fileLabels[fileKind]}</span>}</div>
              <div className="development-thumbnails">{visiblePictures.map((file,index)=><button type="button" key={file.attachmentId} aria-label={`查看${fileLabels[fileKind]} ${(currentPage-1)*pageSize+index+1}`} aria-pressed={heroPicture?.attachmentId===file.attachmentId} onClick={()=>setActivePicture(file.attachmentId)}>{fileKind==="款图"||fileKind==="局部图"?<img src={imageUrl(file.attachmentId)} alt={fileLabels[fileKind]}/>:<span>{fileLabels[fileKind]}<br/>{(currentPage-1)*pageSize+index+1}</span>}</button>)}{!readonly&&<Button type="button" aria-label="添加开发附件" disabled={busy||document.files.length>=30} onClick={()=>setChoosingKind(true)}>＋</Button>}</div>
            </div></div>
            {!readonly&&<><input id="development-upload" className="development-native-upload" disabled={busy||document.files.length>=30} type="file" multiple accept={fileKind==="款图"||fileKind==="局部图"?"image/jpeg,image/png,image/webp":"image/jpeg,image/png,image/webp,application/pdf"} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void upload(files);}}/>{choosingKind&&<div className="development-file-kind-picker" role="dialog" aria-label="选择附件类型"><p>先选择类型，再选择文件</p>{fileKinds.map(kind=><Button key={kind} type="button" onClick={()=>pickKind(kind)}>{fileLabels[kind]}</Button>)}<Button type="button" onClick={()=>setChoosingKind(false)}>取消</Button></div>}<span className="development-upload-help">{uploadHelp??"选择后立即上传；成功文件显示在下方。"}菲林图及工艺开发板支持 PDF。</span></>}
            {attachmentPageSize&&pictures.length>pageSize&&<nav aria-label="附件分页"><Button type="button" disabled={currentPage===1} onClick={()=>setPicturePage(currentPage-1)}>上一组附件</Button><span>第 {currentPage} / {Math.ceil(pictures.length/pageSize)} 组</span><Button type="button" disabled={currentPage*pageSize>=pictures.length} onClick={()=>setPicturePage(currentPage+1)}>下一组附件</Button></nav>}
            <div className="development-file-list">{visiblePictures.map((file,index)=><div key={file.attachmentId}><a href={imageUrl(file.attachmentId)} target="_blank" rel="noreferrer">{fileLabels[fileKind]} {(currentPage-1)*pageSize+index+1}</a>{!readonly&&<Button type="button" disabled={busy} onClick={()=>{for(const [key,id]of successfulUploads.current)if(id===file.attachmentId)successfulUploads.current.delete(key);edit({files:document.files.filter(item=>item.attachmentId!==file.attachmentId)});}}>移除</Button>}</div>)}</div>
            {field("instructions","制作说明（选填）",1000,true)}
          </DocumentSection>
<DocumentSection id="development-basic" title="打板信息"><div className="development-basic-grid">
            {patternSection??<label>打板品类<span className="dx-doc-readonly">沿已发布打板执行单</span></label>}
            <label>本轮打板数量（发布必填）<DocumentField id="development-quantity" label="本轮打板数量" value={quantityInput} numeric readonly={readonly} disabled={busy} issue={issue("development-quantity")} onValue={value=>{setQuantityInput(value);edit({quantity:/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=100000?Number(value):null});}}/></label>
            {field("sampleSize","本轮打样尺码（发布必填）")}{<label>预计样板完成日期（选填）<DocumentField id="development-returnDate" label="预计样板完成日期" type="date" value={document.returnDate??""} readonly={readonly} disabled={busy} issue={issue("development-returnDate")} onValue={value=>edit({returnDate:value||null})}/></label>}
          </div></DocumentSection>
<DocumentSection id="development-materials" title="面辅料" detail={`技术材料 · 共 ${document.materials.length} 行`}>
            <section className="development-material-group"><DocumentTableScroll><table className="development-technical-table"><thead><tr>{["类型","材料名称 / 规格","本轮所需","已有实物","预计到料","操作"].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>
              {document.materials.map((item,index)=><Fragment key={item.materialId}><tr data-doc-row><td><span className="development-material-category">{item.category}</span>{item.category==="辅料"&&(readonly?<small>{item.auxiliaryKind??"普通辅料"}</small>:<label>辅料类型<select aria-label={`${item.label||item.name}辅料类型`} disabled={busy} value={item.auxiliaryKind??"普通辅料"} onChange={event=>changeMaterial(index,{auxiliaryKind:event.target.value as "普通辅料"|"拉链"|"扁机"})}>{["普通辅料","拉链","扁机"].map(kind=><option key={kind}>{kind}</option>)}</select></label>)}</td><td><DocumentField id={`development-${item.materialId}-name`} label={`${item.category}品名${item.requiredThisRound?"（发布必填）":"（选填）"}`} value={item.name} column="name" readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{name:value})} issue={issue(`development-${item.materialId}-name`)}/><DocumentField id={`development-${item.materialId}-specification`} label={`${item.category}规格（选填）`} value={item.specification} column="specification" readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{specification:value})} issue={issue(`development-${item.materialId}-specification`)}/></td>
                <td>{flag(`development-${item.materialId}-requiredThisRound`,"本轮所需",item.requiredThisRound,value=>changeMaterial(index,{requiredThisRound:value}),readonly,true)}</td><td>{flag(`development-${item.materialId}-available`,"已有实物",item.available,value=>void changeAvailability(index,value),readonly,true)}</td><td><DocumentField id={`development-${item.materialId}-expectedDate`} label={`${item.label} 预计到料日期`} type="date" value={item.expectedDate??""} readonly={readonly} disabled={busy||item.available} onValue={value=>changeMaterial(index,{expectedDate:value||null})} issue={issue(`development-${item.materialId}-expectedDate`)}/>{item.available&&item.expectedDate&&<small className="development-plan-retained">保留原计划</small>}</td>
                <td>{!readonly&&<Button type="button" disabled={busy} onClick={async()=>{if(await confirmInApp(`删除${item.label||item.category}？`)&&!writing.current)edit({materials:document.materials.filter(row=>row.materialId!==item.materialId)});}}>删除</Button>}</td></tr><tr className="development-material-detail-row"><td colSpan={6}><details className="development-material-details" open={["label","width","weight","composition","color","supplier","consumption","quantity"].some(key=>Boolean(issue(`development-${item.materialId}-${key}`)))||undefined}><summary>技术详情</summary><div>{(["width","weight","composition","color"] as const).map((key,i)=><label key={key}>{["幅宽（选填）","克重（选填）","成分（选填）","颜色（选填）"][i]}<DocumentField id={`development-${item.materialId}-${key}`} label={`${item.label} ${["幅宽","克重","成分","颜色"][i]}`} value={item[key]} readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{[key]:value})} issue={issue(`development-${item.materialId}-${key}`)}/></label>)}                {(["label","supplier","consumption","quantity"] as const).map((key,i)=><label key={key}>{["自定义称呼（选填）","供应方（选填）","用量（选填）","数量（选填）"][i]}<DocumentField id={`development-${item.materialId}-${key}`} label={`${item.label} ${["自定义称呼（选填）","供应方（选填）","用量（选填）","数量（选填）"][i]}`} value={item[key]} readonly={readonly} disabled={busy} column={key} onValue={value=>changeMaterial(index,{[key]:value})} issue={issue(`development-${item.materialId}-${key}`)}/></label>)}
</div></details></td></tr></Fragment>)}
            </tbody></table></DocumentTableScroll>{!readonly&&<div className="development-actions">{(["主布","配布","辅料"] as const).map(category=><DocumentAddRow key={category} label={`添加${category}`} disabled={busy||document.materials.length>=100} onClick={()=>{const next=material(category,category);edit({materials:[...document.materials,next]});requestAnimationFrame(()=>window.document.getElementById(`development-${next.materialId}-name`)?.focus());}}/> )}</div>}</section>
          </DocumentSection>
<DocumentSection id="development-sizes" title="尺寸表" detail={`${document.sizes.length} 尺码 · ${document.measurements.length} 项目`}>
            <div className="development-size-controls">{select("template","尺寸模板",["上衣","裤子"],value=>void replaceTemplate(value))}{previousTemplate&&!readonly&&<Button type="button" disabled={busy} onClick={()=>void undoTemplate()}>撤回模板替换</Button>}{select("unit","尺寸单位",["cm","inch"])}{!readonly&&<div className="development-actions"><DocumentAddRow label="添加尺码列" disabled={busy||document.sizes.length>=20} onClick={()=>edit({sizes:[...document.sizes,""],measurements:document.measurements.map(row=>({...row,values:[...row.values,""]}))})}/><DocumentAddRow label="添加尺寸行" disabled={busy||document.measurements.length>=100} onClick={()=>{const id=createClientRequestId();measurementIds.current.push(id);edit({measurements:[...document.measurements,{name:"",values:document.sizes.map(()=>"")}]});requestAnimationFrame(()=>window.document.getElementById(`development-measurement-${id}-name`)?.focus());}}/></div>}</div><DocumentTableScroll><table className="development-size-table"><thead><tr><th>测量项目</th>{document.sizes.map((size,index)=><th key={index}><DocumentField id={`development-size-${index}`} label={`尺码列 ${index+1}`} value={size} readonly={readonly} disabled={busy} issue={issue(`development-size-${index}`)} onValue={value=>edit({sizes:document.sizes.map((old,i)=>i===index?value:old)})}/>{!readonly&&<Button type="button" className="development-matrix-remove" aria-label={`删除尺码列 ${index+1}`} disabled={busy} onClick={()=>void removeSize(index)}>×</Button>}</th>)}</tr></thead><tbody>{document.measurements.map((row,index)=><tr key={measurementIds.current[index]} data-doc-row><th><DocumentField id={`development-measurement-${measurementIds.current[index]}-name`} label={`尺寸项目 ${index+1}`} value={row.name} readonly={readonly} disabled={busy} column="name" issue={issue(`development-measurement-${measurementIds.current[index]}-name`)} onValue={value=>edit({measurements:document.measurements.map((old,i)=>i===index?{...old,name:value}:old)})}/>{!readonly&&<Button type="button" className="development-matrix-remove" aria-label={`删除尺寸行 ${index+1}`} disabled={busy} onClick={()=>void removeMeasurement(index)}>×</Button>}</th>{row.values.map((value,column)=><td key={column}><DocumentField id={`development-measurement-${measurementIds.current[index]}-${column}`} label={`${row.name} ${document.sizes[column]}`} value={value} readonly={readonly} disabled={busy} column={`size-${column}`} issue={issue(`development-measurement-${measurementIds.current[index]}-${column}`)} onValue={value=>edit({measurements:document.measurements.map((old,i)=>i===index?{...old,values:old.values.map((v,c)=>c===column?value:v)}:old)})}/></td>)}</tr>)}</tbody></table></DocumentTableScroll>

          </DocumentSection>
<DocumentSection id="development-labels" title="唛类">            <section><div>{(["mainLabel","sizeLabel","careLabel"] as const).map((key,index)=><div key={key}>{flag(`development-${key}`,["主唛","码唛","洗水唛"][index]!,document[key],value=>edit({[key]:value}))}</div>)}{field("mainLabelMethod","主唛车法",1000,true)}</div></section></DocumentSection>
<DocumentSection id="development-craft" title="工艺要求"><div className="development-craft-groups">
            {([{title:"洗水要求",keys:["washingMethod"]},{title:"整烫与包装",keys:["ironing","packaging"]},{title:"朴料",keys:["interlining","placketInterlining"]},{title:"车缝",keys:["sewingThread","buttonholeThread","stitchDensity"]},{title:"尺码标识",keys:["formalSizes","casualSizes"]}] as const).map(group=><section key={group.title}><h3>{group.title}</h3><div>{group.title==="洗水要求"&&select("washing","洗水",["免洗","内洗","外洗"])}{group.keys.map(key=>key==="washingMethod"&&document.washing==="免洗"?null:<div key={key}>{field(key,labels[key],key==="formalSizes"||key==="casualSizes"?100:1000,key==="washingMethod"||key==="ironing"||key==="packaging")}</div>)}</div></section>)}
            <section><h3>开发资料</h3><div><label>开发下单日期（发布必填）<DocumentField id="development-orderDate" label="开发下单日期" type="date" value={document.orderDate??""} readonly={readonly} disabled={busy} issue={issue("development-orderDate")} onValue={value=>edit({orderDate:value||null})}/></label>{select("craft","工艺",["无","印花","绣花","印绣花"])}</div></section>
            {document.washingIroning&&<section><h3>原洗水整烫说明</h3><p className="dx-doc-readonly">{document.washingIroning}</p></section>}

          </div></DocumentSection>
  </div>;
}
