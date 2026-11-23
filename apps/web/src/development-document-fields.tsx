import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Button as AstryxButton} from '@astryxdesign/core/Button';
import {FileInput} from '@astryxdesign/core/FileInput';
import {Selector} from '@astryxdesign/core/Selector';
import {DevelopmentEntryAction,DevelopmentEntryText} from './development-entry-controls.js';
import {DEVELOPMENT_CRAFT_FILE_TYPES,DevelopmentCraftRequirements} from './development-craft-requirements.js';
import {WorkbenchDevelopmentSheetFields} from './workbench-development-sheet-fields.js';
import {IndependentCraftField} from './independent-craft-field.js';
import {AuxiliaryCatalogDialog} from './auxiliary-catalog-dialog.js';
import type {AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import {AttachmentIdentity,type AttachmentIdentityData} from './attachment-identity.js';
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@dx-rework/ui";
import { DEVELOPMENT_MEASUREMENTS, type DevelopmentDocument, type DevelopmentMaterial, developmentMaterialPriceIdentityIssue, hasDevelopmentMaterialPricing, isDevelopmentMaterialPlaceholder, developmentCraftOptions } from "@dx-rework/contracts/digital-development";
import { washingChoiceLabel } from "./digital-workspace-copy.js";
import { removeDevelopmentSize, moveDevelopmentSize, developmentMakingQuantityError, developmentAttachmentReferences } from "./digital-development-editing.js";
import { createClientRequestId } from "./client-request-id.js";
import { confirmInApp } from "./system-dialog.js";
import { DocumentTableScroll, DocumentField, DocumentSection, DocumentSectionGroup, DocumentAddRow, focusDocumentField } from "./document-editor.js";
type FileKind = DevelopmentDocument["files"][number]["kind"];
type Props = {
 fixedCraft?:boolean;materialFactsReadonly?:boolean;document:DevelopmentDocument;edit:(patch:Partial<DevelopmentDocument>)=>void;readonly:boolean;busy:boolean;
 sizeQuantityInputs:string[];setSizeQuantityInputs:(values:string[])=>void;sectionStart?:number;basicDetailsExternal?:boolean;
 locatingField?:{id:string}|null;
 creationView?:"sheet"|"requirements"|"preorder"|undefined;
 designerInput?:boolean;craftControls?:ReactNode;
 writing:{current:boolean};quantityInput:string;setQuantityInput:(value:string)=>void;
 measurementIds:{current:string[]};successfulUploads:{current:Map<string,string>};
 imageUrl:(id:string)=>string;upload:(files:File[],kind?:FileKind,stepKey?:string)=>Promise<void>;fileKind:FileKind;setFileKind:(value:FileKind)=>void;
 fileIdentity?:((id:string)=>AttachmentIdentityData|undefined)|undefined;metadataPath?:((id:string)=>string|undefined)|undefined;
 issue:(id:string)=>string|undefined;patternSection?:ReactNode;uploadHelp?:string;templateResetKey?:string|number;attachmentPageSize?:number;
};
const material = (category: DevelopmentMaterial["category"], label: string): DevelopmentMaterial => ({materialId:createClientRequestId(),category,label,supplier:"",name:"",width:"",weight:"",composition:"",consumption:"",color:"",specification:"",quantity:"",requiredThisRound:true,available:false,expectedDate:null});
const fileKinds=["款图","局部图","菲林","工艺开发板"] as const;
const fileLabels:Record<FileKind,string>={款图:"主款图",局部图:"局部图",菲林:"菲林图",工艺开发板:"工艺开发板"};
const labels = {interlining:"朴号",placketInterlining:"门筒朴",sewingThread:"车缝线",buttonholeThread:"纽门线",stitchDensity:"针距",washingMethod:"洗水方法",ironing:"整烫方法",packaging:"包装方法",formalSizes:"正装尺码",casualSizes:"休闲尺码",mainLabelMethod:"主唛车法",instructions:"制作说明"} as const;
export function DevelopmentDocumentFields({fixedCraft=false,materialFactsReadonly=false,document,edit,readonly,busy,writing,quantityInput,setQuantityInput,measurementIds,successfulUploads,imageUrl,upload,fileKind:storedFileKind,setFileKind,issue,patternSection,uploadHelp,templateResetKey,attachmentPageSize,fileIdentity,metadataPath,sizeQuantityInputs,setSizeQuantityInputs,sectionStart=1,basicDetailsExternal=false,creationView,designerInput=false,craftControls,locatingField}:Props){
  const [materialDialog,setMaterialDialog]=useState(false),[showAllPictures,setShowAllPictures]=useState(false);
  const [fieldQuery,setFieldQuery]=useState('');
  const [requestedFocus,setRequestedFocus]=useState<{id:string}|null>(null);
  const workbench=creationView!=="preorder"&&Boolean(document.workbenchSheet);
  const compact=workbench&&creationView==="sheet";
  const currentInput=Boolean(creationView)||designerInput;
  const fileKind=currentInput&&storedFileKind==="菲林"?"款图":storedFileKind;
  const visibleFileKinds=currentInput?fileKinds.filter(kind=>kind!=="菲林"):fileKinds;
  const changeCraft=(craft:DevelopmentDocument["craft"],craftSteps?:DevelopmentDocument["craftSteps"])=>{
    const keys=new Set(developmentCraftOptions({craft,craftSteps}).map(step=>step.key));
    edit({craft,craftSteps,...(document.craftRequirements?{craftRequirements:document.craftRequirements.filter(row=>keys.has(row.stepKey))}:{})});
  };
  const materialPreviewCount=3;
  const locate=(id:string)=>setRequestedFocus({id});
  useEffect(()=>{if(locatingField)setRequestedFocus(locatingField);},[locatingField]);
  useEffect(()=>{
    if(!requestedFocus)return;
    const hidden=compact&&document.materials.slice(materialPreviewCount).some(row=>requestedFocus.id.startsWith(`development-${row.materialId}-`));
    if(hidden&&!materialDialog){setMaterialDialog(true);return;}
    const frame=requestAnimationFrame(()=>{
      focusDocumentField(requestedFocus.id);
      setRequestedFocus(null);
    });
    return()=>cancelAnimationFrame(frame);
  },[requestedFocus,compact,materialDialog,document.materials]);
  const [auxiliaryMaterialId,setAuxiliaryMaterialId]=useState<string|null>(null);
  const sizeIds=useRef(document.sizes.map(()=>createClientRequestId()));
  if(sizeIds.current.length!==document.sizes.length)sizeIds.current=document.sizes.map((_,index)=>sizeIds.current[index]??createClientRequestId());
  const removeSize=async(index:number)=>{
    const filled=Boolean(sizeQuantityInputs[index])||Boolean(document.sizes[index]?.trim())||document.measurements.some(row=>row.values[index]?.trim());
    if(filled&&!await confirmInApp("删除这个尺码列及对应的制作数量和尺寸值？"))return;
    if(!writing.current){sizeIds.current.splice(index,1);setSizeQuantityInputs(sizeQuantityInputs.filter((_,position)=>position!==index));edit(removeDevelopmentSize(document,index));}
  };
  const removeMeasurement=async(index:number)=>{
    const row=document.measurements[index];
    if((row?.name.trim()||row?.values.some(value=>value.trim()))&&!await confirmInApp("删除这个尺寸行及全部数值？"))return;
    if(writing.current)return;
    measurementIds.current=measurementIds.current.filter((_,position)=>position!==index);
    edit({measurements:document.measurements.filter((_,position)=>position!==index)});
  };
  const [previousTemplate,setPreviousTemplate]=useState<{template:DevelopmentDocument["template"];sizes:string[];measurements:DevelopmentDocument["measurements"];ids:string[];sizeIds:string[];sizeQuantities:DevelopmentDocument["sizeQuantities"];inputs:string[]}|null>(null);
  useEffect(()=>setPreviousTemplate(null),[templateResetKey]);
  const replaceTemplate=async(value:string)=>{
    const template=value as DevelopmentDocument["template"];
    if(template===document.template)return;
    const filled=document.measurements.some(row=>row.values.some(value=>value.trim()));
    if(!await confirmInApp(`切换为${template}尺寸模板将替换当前尺寸项目${filled?"和已填写的尺寸值":""}。取消保留原内容；替换后可撤回。继续？`)||writing.current)return;
    setPreviousTemplate({template:document.template,sizes:[...document.sizes],measurements:structuredClone(document.measurements),ids:[...measurementIds.current],sizeIds:[...sizeIds.current],sizeQuantities:document.sizeQuantities,inputs:[...sizeQuantityInputs]});
    measurementIds.current=DEVELOPMENT_MEASUREMENTS[template].map(()=>createClientRequestId());
    edit({template,measurements:DEVELOPMENT_MEASUREMENTS[template].map(name=>({name,values:document.sizes.map(()=>"")}))});
  };
  const undoTemplate=async()=>{
    if(!previousTemplate||!await confirmInApp("恢复替换前的尺码列、每码制作数量和尺寸值？替换后的填写将移除。")||writing.current)return;
    measurementIds.current=previousTemplate.ids;sizeIds.current=previousTemplate.sizeIds;setSizeQuantityInputs(previousTemplate.inputs);
    edit({template:previousTemplate.template,sizes:previousTemplate.sizes,...(previousTemplate.sizeQuantities?{sizeQuantities:previousTemplate.sizeQuantities}:{}),measurements:previousTemplate.measurements});setPreviousTemplate(null);
  };
  const changeAvailability=async(index:number,value:boolean)=>{
    const item=document.materials[index];if(!item)return;
    if(value&&item.expectedDate&&!await confirmInApp(`标记已有实物后，预计到料 ${item.expectedDate} 作为原计划保留，当前不再编辑。继续？`))return;
    if(!writing.current)changeMaterial(index,{available:value});
  };
  const changeMaterial=(index:number,patch:Partial<DevelopmentMaterial>)=>edit({materials:document.materials.map((item,i)=>{
    if(i!==index)return item;
    const next={...item,...patch};
    const changedIdentity=(["name","specification","supplier","auxiliaryKind"] as const).some(key=>Object.hasOwn(patch,key)&&patch[key]!==item[key]);
    if(changedIdentity&&!Object.hasOwn(patch,"auxiliaryCatalog")){
      delete next.auxiliaryCatalog;
      if(item.unitPrice!==undefined)next.unitPrice="";
      if(item.pricingUnit!==undefined)next.pricingUnit="";
    }
    return next;
  })});
  const chooseAuxiliary=async(selected:AuxiliaryItem)=>{
    const index=document.materials.findIndex(row=>row.materialId===auxiliaryMaterialId),current=document.materials[index];
    if(!current||writing.current)return false;
    const prior=current.auxiliaryCatalog;
    if(prior?.id===selected.id&&prior.version===selected.version)return true;
    const nextPrice=selected.referencePricing;
    if(prior||current.unitPrice){
      const showPrice=(amount:string|undefined,unit:string|undefined)=>amount?amount+(unit?` 元 / ${unit}`:" 元"):"未记录";
      const before=showPrice(current.unitPrice,current.pricingUnit);
      const after=showPrice(nextPrice?.amount,nextPrice?.unit);
      if(!await confirmInApp(`采用所选辅料版本？本单 ${before} · ${current.supplier||"供应商未记录"} · ${prior?`目录版本 ${prior.version}`:"无目录版本"} → ${after} · ${selected.supplier||"供应商未记录"} · 目录版本 ${selected.version}`)||writing.current)return false;
    }
    changeMaterial(index,{
      name:selected.name,specification:selected.specification,supplier:selected.supplier,auxiliaryKind:selected.auxiliaryKind,
      auxiliaryCatalog:{id:selected.id,version:selected.version,...(nextPrice!==undefined?{referencePricing:nextPrice}:{})},
      ...(nextPrice?{unitPrice:nextPrice.amount,pricingUnit:nextPrice.unit}:{
        ...(current.unitPrice!==undefined?{unitPrice:""}:{}),...(current.pricingUnit!==undefined?{pricingUnit:""}:{}),
      }),
    });
    return true;
  };
  const materialPriceFields=(item:DevelopmentMaterial,index:number)=>{
   const issue=readonly?null:developmentMaterialPriceIdentityIssue(item);
   return <>
    {([['pricingUnit','计价单位'],['unitPrice','材料单价']] as const).map(([field,label])=><div key={field} className="development-visible-material-label">
      <span>{label}</span>
      {readonly?<DocumentField id={`development-${item.materialId}-${field}`} label={`${item.label}${label}`}
        value={item[field]??''} readonly/>
      :<DevelopmentEntryText id={`development-${item.materialId}-${field}`} label={`${item.label}${label}`}
        value={item[field]??''} isDisabled={busy} maxLength={100} inputMode={field==='unitPrice'?'decimal':'text'}
        onChange={value=>changeMaterial(index,{[field]:value})}/>}
    </div>)}
    {issue&&<small role="status">{issue}</small>}
    {item.auxiliaryCatalog?.referencePricing&&<small>目录参考价：{item.auxiliaryCatalog.referencePricing.amount} 元 / {item.auxiliaryCatalog.referencePricing.unit}</small>}
   </>;
  };
  const field=(key:keyof DevelopmentDocument,label:string,maxLength=100,multiline=false)=><label>{label}<DocumentField id={`development-${key}`} label={label} value={String(document[key]??"")} onValue={value=>edit({[key]:value})} readonly={readonly} disabled={busy} maxLength={maxLength} multiline={multiline} issue={issue(`development-${key}`)}/></label>;
  const select=(key:"template"|"unit"|"craft"|"washing",label:string,options:readonly string[],change?:(value:string)=>void)=>{
    const show=(value:string)=>key==="washing"?washingChoiceLabel(value):value;
    const onSelect=(value:string)=>change?change(value):edit({[key]:value});
    const id=`development-${key}`;
    if(creationView&&!readonly)return <Selector id={id} label={label} value={document[key]} size="sm" isDisabled={busy}
      options={options.map(value=>({value,label:show(value)}))} onChange={onSelect}/>;
    return <label>{label}{readonly?<span className="dx-doc-readonly" id={id}>{show(document[key])}</span>
      :<select id={id} aria-label={label} disabled={busy} value={document[key]} onChange={event=>onSelect(event.currentTarget.value)}>
        {options.map(value=><option key={value} value={value}>{show(value)}</option>)}</select>}</label>;
  };
  const flag=(id:string,label:string,value:boolean,onValue:(value:boolean)=>void,locked=readonly,compact=false)=><label className="development-flag">{locked?<span id={id} className="dx-doc-readonly" aria-label={label}>{compact?"":`${label}：`}{value?"有":"无"}</span>:<><input id={id} aria-label={label} type="checkbox" checked={value} disabled={busy} onChange={event=>onValue(event.target.checked)}/>{!compact&&label}</>}</label>;
  const [activePicture,setActivePicture]=useState<string|null>(null);
  const pictures=document.files.filter(file=>file.kind===fileKind);
  const [picturePage,setPicturePage]=useState(1);
  useEffect(()=>{setPicturePage(1);setActivePicture(null);},[fileKind,templateResetKey]);
  const pageSize=compact&&!showAllPictures?6:attachmentPageSize??Math.max(pictures.length,1),currentPage=Math.min(picturePage,Math.max(1,Math.ceil(pictures.length/pageSize))),visiblePictures=pictures.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const heroPicture=pictures.find(file=>file.attachmentId===activePicture)??pictures[0];
  const light=creationView==="preorder",requirements=creationView==="requirements";
  const preorderFabricFields=[['name','面料名称'],['specification','规格'],['quantity','数量与单位'],['supplier','供应商']] as const;
  const templateControl=<>{select("template","尺寸模板",["上衣","裤子"],value=>void replaceTemplate(value))}
    {previousTemplate&&!readonly&&<Button type="button" disabled={busy} onClick={()=>void undoTemplate()}>撤回模板替换</Button>}</>;
  const materialIssueFields=["name","width","composition","supplier","specification","expectedDate","sampleAttachmentId","quantity"] as const;
  const commonMaterialFields=[["supplier","供应商"],["quantity","数量"],["quantityUnit","数量单位"]] as const;
  const showMaterialPricing=!readonly&&(workbench||light||document.quotationMode==="automatic_v1")||document.materials.some(item=>item.unitPrice!==undefined);
  const materialTable=(limit:number)=><section className="development-material-group"><DocumentTableScroll><table className="development-technical-table"><thead><tr>{["类型","材料名称 / 规格",...(compact?["供应商","数量 / 单位"]:[]),...(showMaterialPricing?["材料单价 / 单位"]:[]),"使用范围确认","已有实物","预计到料","操作"].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>
              {document.materials.slice(0,limit).map((item,index)=><Fragment key={item.materialId}><tr data-doc-row><td><span className="development-material-category">{item.category}</span>{item.category==="辅料"&&<small>辅料类型：{item.auxiliaryKind??"普通辅料"}</small>}</td><td>{item.category==="辅料"&&<div className="development-auxiliary-selection"><strong>{item.name||"尚未选择辅料"}</strong>{!readonly&&<Button type="button" aria-label={`选择共享辅料 ${index+1}`} disabled={busy} onClick={()=>setAuxiliaryMaterialId(item.materialId)}>搜索或新增共享辅料</Button>}{item.auxiliaryCatalog&&<small>已保存目录版本 {item.auxiliaryCatalog.version} 的资料快照</small>}</div>}<label className="development-visible-material-label">品名<DocumentField id={`development-${item.materialId}-name`} label={`${item.category}品名（材料资料）`} value={item.name} column="name" readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{name:value})} issue={issue(`development-${item.materialId}-name`)}/></label><label className="development-visible-material-label">规格<DocumentField id={`development-${item.materialId}-specification`} label={`${item.category}规格（${!workbench&&item.category==="主布"?"发布必填":"选填"}）`} value={item.specification} column="specification" readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{specification:value})} issue={issue(`development-${item.materialId}-specification`)}/></label></td>
                {compact&&commonMaterialFields.map(([key,label],column)=>column===2?null:<td key={key}>
                  {(column===0?[[key,label] as const]:commonMaterialFields.slice(1)).map(([field,fieldLabel])=><label key={field} className="development-visible-material-label">{fieldLabel}
                    <DocumentField id={`development-${item.materialId}-${field}`} label={`${item.label} ${fieldLabel}`}
                      value={item[field]??""} readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{[field]:value})}
                      issue={issue(`development-${item.materialId}-${field}`)}/>
                  </label>)}
                </td>)}
                {showMaterialPricing&&<td>{materialPriceFields(item,index)}</td>}
                <td>由文员在核料页确认</td><td>{flag(`development-${item.materialId}-available`,"已有实物",item.available,value=>void changeAvailability(index,value),readonly||workbench||materialFactsReadonly,true)}</td><td>{(workbench||materialFactsReadonly)&&item.category!=='辅料'?<span>{item.expectedDate?`原登记日期：${item.expectedDate}`:'由跟单跟进'}</span>:<DocumentField id={`development-${item.materialId}-expectedDate`} label={`${item.label} 预计到料日期`} type="date" value={item.expectedDate??""} readonly={readonly} disabled={busy||item.available} onValue={value=>changeMaterial(index,{expectedDate:value||null})} issue={issue(`development-${item.materialId}-expectedDate`)}/>} {item.available&&item.expectedDate&&<small className="development-plan-retained">保留原计划</small>}</td>
                <td>{!readonly&&<Button type="button" disabled={busy} onClick={async()=>{if(await confirmInApp(`删除${item.label||item.category}？`)&&!writing.current)edit({materials:document.materials.filter(row=>row.materialId!==item.materialId)});}}>删除</Button>}</td></tr><tr className="development-material-detail-row"><td colSpan={(compact?9:7)+(showMaterialPricing?1:0)}><details className="development-material-details" open={!compact&&["label","width","weight","composition","color","supplier","consumption","quantity","sampleAttachmentId"].some(key=>Boolean(issue(`development-${item.materialId}-${key}`)))||undefined}><summary>技术详情</summary><div>{(["width","weight","composition","color"] as const).map((key,i)=><label key={key}>{["幅宽","克重","成分",workbench?"物料颜色":"颜色"][i]}<DocumentField id={`development-${item.materialId}-${key}`} label={`${item.label} ${["幅宽","克重","成分","颜色"][i]}`} value={item[key]} readonly={readonly} disabled={busy} onValue={value=>changeMaterial(index,{[key]:value})} issue={issue(`development-${item.materialId}-${key}`)}/></label>)}                {(["label","supplier","consumption","quantity"] as const).map((key,i)=>compact&&(key==="supplier"||key==="quantity")?null:<label key={key}>{(workbench?["材料标记","供应商","单件用量","数量"]:["材料标记（选填）","供应方（选填）","用量（选填）","数量（选填）"])[i]}<DocumentField id={`development-${item.materialId}-${key}`} label={`${item.label} ${(workbench?["材料标记","供应商","单件用量","数量"]:["材料标记（选填）","供应方（选填）","用量（选填）","数量（选填）"])[i]}`} value={item[key]} readonly={readonly} disabled={busy} column={key} onValue={value=>changeMaterial(index,{[key]:value})} issue={issue(`development-${item.materialId}-${key}`)}/></label>)}
{workbench&&<>
    {([["garmentColor","款式颜色"],["part","部位"],["quantityUnit","数量单位"]] as const).map(([key,label])=>compact&&key==="quantityUnit"?null:<label key={key}>{label}
      <DocumentField id={`development-${item.materialId}-${key}`} label={`${item.label} ${label}`} value={item[key]??""} readonly={readonly}
        disabled={busy} issue={issue(`development-${item.materialId}-${key}`)} onValue={value=>changeMaterial(index,{[key]:value})}/>
    </label>)}
    {creationView&&!readonly?<Selector id={`development-${item.materialId}-sampleAttachmentId`} label={`${item.label} 实样图片`}
      size="sm" value={item.sampleAttachmentId??""} isDisabled={busy}
      options={[{value:"",label:"不引用图片"},...document.files.filter(file=>file.kind==="局部图").map((file,index)=>({
        value:file.attachmentId,label:[`局部图 ${index+1}`,fileIdentity?.(file.attachmentId)?.filename].filter(Boolean).join(" · "),
      }))]} onChange={value=>changeMaterial(index,{sampleAttachmentId:value||null})}/>
      :<label>贴实样{readonly?item.sampleAttachmentId?<a href={imageUrl(item.sampleAttachmentId)} target="_blank" rel="noreferrer">查看实样</a>:"未登记":
        <select id={`development-${item.materialId}-sampleAttachmentId`} aria-label={`${item.label} 实样图片`} value={item.sampleAttachmentId??""}
          disabled={busy} onChange={event=>changeMaterial(index,{sampleAttachmentId:event.target.value||null})}>
          <option value="">不引用图片</option>{document.files.filter(file=>file.kind==="局部图").map((file,index)=><option key={file.attachmentId} value={file.attachmentId}>
            {fileIdentity?.(file.attachmentId)?.filename??`局部图 ${index+1}`}
          </option>)}
        </select>}
      </label>}
  </>}</div></details></td></tr></Fragment>)}
            </tbody></table></DocumentTableScroll>{!readonly&&<div className="development-actions">{(["主布","配布","辅料"] as const).map(category=><DocumentAddRow key={category} label={`添加${category}`} disabled={busy||document.materials.length>=100} onClick={()=>{const next=material(category,category);edit({materials:[...document.materials,next]});if(compact)locate(`development-${next.materialId}-name`);else requestAnimationFrame(()=>window.document.getElementById(`development-${next.materialId}-name`)?.focus());}}/> )}</div>}</section>;
  const compactSection=(title:string,summary:string,children:ReactNode)=>compact
    ?<details className="development-optional-section"><summary>{title} · {summary}</summary>{children}</details>:children;
  const fieldSearch=fieldQuery.trim().toLocaleLowerCase();
  const matches=fieldSearch?[
    ...(["mainLabel","sizeLabel","careLabel"] as const).map((key,index)=>({id:`development-${key}`,title:["主唛","码唛","洗水唛"][index],value:null})),
    ...Object.entries(labels).map(([key,label])=>({id:`development-${key}`,title:label,value:document[key as keyof typeof labels]})),
    ...document.measurements.map((row,index)=>({id:`development-measurement-${measurementIds.current[index]}-name`,title:row.name,value:row.values.join(" ")})),
    ...document.materials.flatMap(row=>materialIssueFields.map(field=>({id:`development-${row.materialId}-${field}`,title:`${row.name||row.label} · ${{name:"品名",width:"幅宽",composition:"成分",supplier:"供应商",specification:"规格",expectedDate:"预计到料",sampleAttachmentId:"贴实样",quantity:"数量"}[field]}`,value:row[field]}))),
  ].filter(item=>`${item.title} ${item.value??""}`.toLocaleLowerCase().includes(fieldSearch)).slice(0,20):[];
  const dimensions=compactSection("尺寸资料",`${document.template} · ${document.unit} · 已填 ${document.sizes.filter(size=>size.trim()).length} 个尺码`,<DocumentSection id="development-sizes" title="尺寸表（创建开发单选填）" detail={`${document.sizes.length} 尺码 · ${document.measurements.length} 项目`}>
<p>创建及发布开发资料时可暂不填写尺码；技术纸样完成时再提供有效基码尺寸。订购配码在正式确认客户订单时单独核对。</p>
            {readonly&&document.documentFormatVersion!==2&&<p className="development-legacy-making">历史打样尺码：{document.sampleSize||"未登记"}；原单没有逐码制作数量，未推算或改写。</p>}<div className="development-size-controls">{!compact&&templateControl}{select("unit","尺寸单位",["cm","inch"])}{!readonly&&<div className="development-actions"><DocumentAddRow label="添加尺码列" disabled={busy||document.sizes.length>=20} onClick={()=>{sizeIds.current.push(createClientRequestId());setSizeQuantityInputs([...sizeQuantityInputs,""]);edit({documentFormatVersion:2,sizes:[...document.sizes,""],sizeQuantities:[...(document.sizeQuantities??document.sizes.map(()=>null)),null],measurements:document.measurements.map(row=>({...row,values:[...row.values,""]}))});}}/><DocumentAddRow label="添加尺寸行" disabled={busy||document.measurements.length>=100} onClick={()=>{const id=createClientRequestId();measurementIds.current.push(id);edit({measurements:[...document.measurements,{name:"",values:document.sizes.map(()=>"")}]});requestAnimationFrame(()=>window.document.getElementById(`development-measurement-${id}-name`)?.focus());}}/></div>}</div><DocumentTableScroll><table className="development-size-table"><thead><tr><th>测量项目</th>{document.sizes.map((size,index)=><th key={sizeIds.current[index]}><DocumentField id={`development-size-${index}`} label={`制作尺码列 ${index+1}`} value={size} readonly={readonly} disabled={busy} issue={issue(`development-size-${index}`)} onValue={value=>edit({sizes:document.sizes.map((old,i)=>i===index?value:old)})}/>{!readonly&&<Button type="button" className="development-matrix-remove" aria-label={`删除制作尺码列 ${index+1}`} disabled={busy} onClick={()=>void removeSize(index)}>×</Button>}{!readonly&&<span className="development-size-move">{([-1,1] as const).map(delta=><button key={delta} type="button" aria-label={`${document.sizes[index]||`第${index+1}列`}尺码${delta<0?"左移":"右移"}`} disabled={busy||index+delta<0||index+delta>=document.sizes.length} onClick={()=>{const to=index+delta;[sizeIds.current[index],sizeIds.current[to]]=[sizeIds.current[to]!,sizeIds.current[index]!];const inputs=[...sizeQuantityInputs];const value=inputs.splice(index,1)[0]!;inputs.splice(to,0,value);setSizeQuantityInputs(inputs);edit(moveDevelopmentSize(document,index,to));}}>{delta<0?"←":"→"}</button>)}</span>}</th>)}</tr></thead><tbody><tr id="development-size-quantities" tabIndex={-1} className="development-making-quantities"><th>本轮制作数量<small>0件表示本轮不做</small></th>{document.sizes.map((size,index)=><td key={sizeIds.current[index]}><DocumentField id={`development-size-quantity-${index}`} label={`${size||`第${index+1}列`}尺码制作数量`} value={sizeQuantityInputs[index]??""} numeric readonly={readonly} disabled={busy} issue={issue(`development-size-quantity-${index}`)} onValue={value=>{const inputs=[...sizeQuantityInputs];inputs[index]=value;setSizeQuantityInputs(inputs);edit({documentFormatVersion:2,sizeQuantities:document.sizes.map((_,position)=>position===index?(value!==""&&!developmentMakingQuantityError(value)?Number(value):null):document.sizeQuantities?.[position]??null)});}}/></td>)}</tr>{document.measurements.map((row,index)=><tr key={measurementIds.current[index]} data-doc-row><th><DocumentField id={`development-measurement-${measurementIds.current[index]}-name`} label={`尺寸项目 ${index+1}`} value={row.name} readonly={readonly} disabled={busy} column="name" issue={issue(`development-measurement-${measurementIds.current[index]}-name`)} onValue={value=>edit({measurements:document.measurements.map((old,i)=>i===index?{...old,name:value}:old)})}/>{!readonly&&<Button type="button" className="development-matrix-remove" aria-label={`删除尺寸行 ${index+1}`} disabled={busy} onClick={()=>void removeMeasurement(index)}>×</Button>}</th>{row.values.map((value,column)=><td key={column}><DocumentField id={`development-measurement-${measurementIds.current[index]}-${column}`} label={`${row.name} ${document.sizes[column]}`} value={value} readonly={readonly} disabled={busy} column={`size-${column}`} issue={issue(`development-measurement-${measurementIds.current[index]}-${column}`)} onValue={value=>edit({measurements:document.measurements.map((old,i)=>i===index?{...old,values:old.values.map((v,c)=>c===column?value:v)}:old)})}/></td>)}</tr>)}</tbody></table></DocumentTableScroll><p className="development-making-total">各码制作合计：{!document.sizes.length||sizeQuantityInputs.every(value=>value==="")?"待技术补充":sizeQuantityInputs.some(value=>value===""||developmentMakingQuantityError(value))?"待填写":sizeQuantityInputs.reduce((sum,value)=>sum+Number(value),0)}件 · 本轮打板数量：{document.quantity??"待填写"}件{issue("development-size-quantities")&&<span role="alert">{issue("development-size-quantities")}</span>}</p>

          </DocumentSection>);
  const labelSection=<DocumentSection id="development-labels" title="唛类">            <section><div>{(["mainLabel","sizeLabel","careLabel"] as const).map((key,index)=><div key={key}>{flag(`development-${key}`,["主唛","码唛","洗水唛"][index]!,document[key],value=>edit({[key]:value}))}</div>)}{field("mainLabelMethod","主唛车法",1000,true)}</div></section></DocumentSection>;
  return <div className={`development-document-layout development-document-layout--grouped${creationView?" development-document-layout--creation":""}`}>
    {compact&&<div className="development-optional-section">{templateControl}</div>}{auxiliaryMaterialId&&!readonly&&<AuxiliaryCatalogDialog disabled={busy} onClose={()=>setAuxiliaryMaterialId(null)} onSelect={chooseAuxiliary}/>}
<DocumentSectionGroup chapters={["development-images","development-basic","development-labels"]} title={requirements?"开发需求":currentInput?"款图与制作说明":`${sectionStart} · 款图与制作说明`}>
{!requirements&&<DocumentSection id="development-images" title="款图与制作说明" {...((light||workbench)?{detail:`共 ${document.files.length} 个附件`}:{detail:"主款图发布必填；其它附件与说明选填"})}>
            <div className="development-file-tabs" role="group" aria-label="附件分类">{visibleFileKinds.map(kind=>currentInput
              ?<AstryxButton key={kind} type="button" label={`${fileLabels[kind]}（${document.files.filter(file=>file.kind===kind).length}）`}
                size="sm" variant={fileKind===kind?"secondary":"ghost"} aria-pressed={fileKind===kind} onClick={()=>setFileKind(kind)}/>
              :<Button key={kind} type="button" aria-pressed={fileKind===kind} onClick={()=>setFileKind(kind)}>{fileLabels[kind]}（{document.files.filter(file=>file.kind===kind).length}）</Button>)}
              {!readonly&&!currentInput&&<Button type="button" aria-label="添加开发附件" aria-controls="development-upload" disabled={busy||document.files.length>=30} onClick={()=>window.document.getElementById("development-upload")?.click()}>＋</Button>}
            </div>
            <div className="development-picture-layout"><div>
              <div className="development-main-picture">{heroPicture?fileKind==="款图"||fileKind==="局部图"?<a href={imageUrl(heroPicture.attachmentId)} target="_blank" rel="noreferrer"><img src={imageUrl(heroPicture.attachmentId)} alt={fileLabels[fileKind]}/></a>:<object data={imageUrl(heroPicture.attachmentId)} aria-label={`${fileLabels[fileKind]}预览`}><a href={imageUrl(heroPicture.attachmentId)} target="_blank" rel="noreferrer">打开{fileLabels[fileKind]}图片或 PDF</a></object>:<span>尚未上传{fileLabels[fileKind]}</span>}</div>
              <div className="development-thumbnails">{visiblePictures.map((file,index)=><button type="button" key={file.attachmentId} aria-label={`查看${fileLabels[fileKind]} ${(currentPage-1)*pageSize+index+1}`} aria-pressed={heroPicture?.attachmentId===file.attachmentId} onClick={()=>setActivePicture(file.attachmentId)}>{fileKind==="款图"||fileKind==="局部图"?<img src={imageUrl(file.attachmentId)} alt={fileLabels[fileKind]}/>:<span>{fileLabels[fileKind]}<br/>{(currentPage-1)*pageSize+index+1}</span>}</button>)}</div>
            </div></div>
            {!readonly&&(currentInput?<div className="development-picture-upload">
              <FileInput id="development-upload" label="添加开发附件" placeholder="选择图片或文件" value={null} isMultiple
                aria-controls="development-upload" isDisabled={busy||document.files.length>=30}
                accept={fileKind==="工艺开发板"?DEVELOPMENT_CRAFT_FILE_TYPES:"image/jpeg,image/png,image/webp"}
                onChange={files=>{if(files)void upload(Array.isArray(files)?files:[files],fileKind);}}/>
              <span className="development-upload-help">{uploadHelp??"选择后立即上传；成功文件显示在下方。"}工艺开发板支持 PDF。</span>
            </div>:<><input id="development-upload" className="development-native-upload" disabled={busy||document.files.length>=30} type="file" multiple accept={fileKind==="款图"||fileKind==="局部图"?"image/jpeg,image/png,image/webp":DEVELOPMENT_CRAFT_FILE_TYPES} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void upload(files);}}/><span className="development-upload-help">{uploadHelp??"选择后立即上传；成功文件显示在下方。"}菲林图及工艺开发板支持 PDF。</span></>)}
            {compact&&pictures.length>6&&<Button type="button" aria-expanded={showAllPictures} onClick={()=>setShowAllPictures(!showAllPictures)}>{showAllPictures?"收起额外图片":"查看全部图片"}</Button>}
            {!compact&&attachmentPageSize&&pictures.length>pageSize&&<nav aria-label="附件分页"><Button type="button" disabled={currentPage===1} onClick={()=>setPicturePage(currentPage-1)}>上一组附件</Button><span>第 {currentPage} / {Math.ceil(pictures.length/pageSize)} 组</span><Button type="button" disabled={currentPage*pageSize>=pictures.length} onClick={()=>setPicturePage(currentPage+1)}>下一组附件</Button></nav>}
            <div className="development-file-list">{visiblePictures.map((file,index)=><div key={file.attachmentId}><AttachmentIdentity label={`${fileLabels[fileKind]} ${(currentPage-1)*pageSize+index+1}`} local={fileIdentity?.(file.attachmentId)} metadataPath={metadataPath?.(file.attachmentId)}/><div className="development-file-actions"><a href={imageUrl(file.attachmentId)} target="_blank" rel="noreferrer">查看原附件</a>{!readonly&&<Button type="button" disabled={busy} onClick={async()=>{
              const {linked,withoutFile}=developmentAttachmentReferences(document,file.attachmentId);
              if(linked&&!await confirmInApp("移除此附件也会解除材料或工艺对它的引用，确定移除？"))return;
              if(writing.current)return;
              for(const [key,id]of successfulUploads.current)if(id===file.attachmentId)successfulUploads.current.delete(key);
              edit(withoutFile);
            }}>移除</Button>}</div></div>)}</div>
            {currentInput&&document.files.some(file=>file.kind==="菲林")&&<details>
              <summary>原附件</summary>
              {document.files.filter(file=>file.kind==="菲林").map((file,index)=><div key={file.attachmentId}>
                <AttachmentIdentity label={`原菲林图 ${index+1}`} local={fileIdentity?.(file.attachmentId)} metadataPath={metadataPath?.(file.attachmentId)}/>
                <a href={imageUrl(file.attachmentId)} target="_blank" rel="noreferrer">查看原附件</a>
              </div>)}
            </details>}
            {field("instructions","制作说明（选填）",1000,true)}
          </DocumentSection>}
{!light&&creationView!=="sheet"&&<><DocumentSection id="development-basic" title="打板信息"><div className="development-basic-grid">
            {!basicDetailsExternal&&<><label>开发下单日期<DocumentField id="development-orderDate" label="开发下单日期" value={document.orderDate??"首次开发日期未登记"} readonly issue={issue("development-orderDate")}/></label>{fixedCraft?<IndependentCraftField label="工艺" value={document.craft} steps={document.craftSteps} readonly={readonly} disabled={busy} onChange={changeCraft}/>:select("craft","工艺",["无","印花","绣花","印绣花"],value=>changeCraft(value as DevelopmentDocument["craft"]))}</>}
            {patternSection??<label>打板品类<span className="dx-doc-readonly">沿已发布打板执行单</span></label>}
            <label>本轮打板数量（发布必填）<DocumentField id="development-quantity" label="本轮打板数量" value={quantityInput} numeric readonly={readonly} disabled={busy} issue={issue("development-quantity")} onValue={value=>{setQuantityInput(value);edit({quantity:/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=100000?Number(value):null});}}/></label>
            {<label>预计样板完成日期（选填）<DocumentField id="development-returnDate" label="预计样板完成日期" type="date" value={document.returnDate??""} readonly={readonly} disabled={busy} issue={issue("development-returnDate")} onValue={value=>edit({returnDate:value||null})}/></label>}
          </div></DocumentSection>
{!workbench&&labelSection}</>}
</DocumentSectionGroup>
{compact&&<DocumentSection id="development-field-search" title="查找版单字段">
  <label>查找字段<input type="search" value={fieldQuery} onChange={event=>setFieldQuery(event.target.value)}/></label>
  {fieldSearch&&<div>{matches.length?matches.map(item=><Button type="button" key={item.id} onClick={()=>locate(item.id)}>{item.title}</Button>):<p>当前资料没有匹配字段</p>}</div>}
</DocumentSection>}
{workbench&&!creationView&&document.workbenchSheet&&<WorkbenchDevelopmentSheetFields sheet={document.workbenchSheet} readonly={busy||readonly} issue={issue} onChange={workbenchSheet=>edit({workbenchSheet})}/>}
{!requirements&&!light&&<DocumentSectionGroup chapters={["development-sizes","development-materials"]} title={currentInput?"面辅料与尺寸表":`${sectionStart+1} · 面辅料与尺寸表`}>
{!compact&&dimensions}
<DocumentSection id="development-materials" title="面辅料" detail={`技术材料 · 共 ${document.materials.length} 行`}>
            {compact&&<div className="development-material-overview">
              <p>共 {document.materials.length} 行 · 已填 {document.materials.filter(row=>!isDevelopmentMaterialPlaceholder(row)||hasDevelopmentMaterialPricing(row)).length} 行 · 待核 {document.materials.filter(row=>developmentMaterialPriceIdentityIssue(row)||materialIssueFields.some(field=>issue(`development-${row.materialId}-${field}`))).length} 行</p>
              <Button type="button" onClick={()=>setMaterialDialog(true)}>查看全部 / 继续添加面辅料</Button>
            </div>}
            {compact&&materialDialog?
              <Dialog isOpen onOpenChange={setMaterialDialog} className="development-material-dialog" purpose="form" width="min(94vw, 1200px)">
                <DialogHeader title="全部面辅料" onOpenChange={setMaterialDialog}/>
                {materialTable(document.materials.length)}
                <footer><Button type="button" onClick={()=>setMaterialDialog(false)}>返回版单</Button></footer>
              </Dialog>:materialTable(compact?materialPreviewCount:document.materials.length)}
          </DocumentSection>
{compact&&dimensions}
</DocumentSectionGroup>}
{compact&&compactSection("唛头资料",`已填 ${[document.mainLabel,document.mainLabelMethod,document.sizeLabel,document.careLabel].filter(Boolean).length} 项`,labelSection)}
{workbench&&!creationView&&labelSection}
{light&&<DocumentSection id="development-materials" title="备料面料">
  <DocumentTableScroll scrollLabel="备料面料">
    <table className="development-preorder-materials"><thead><tr><th scope="col">类型</th>
      {preorderFabricFields.map(([field,label])=><th scope="col" key={field}>{label}</th>)}
      {showMaterialPricing&&<th scope="col">材料单价 / 单位</th>}
      {!readonly&&<th scope="col">操作</th>}
    </tr></thead><tbody>
      {document.materials.map((item,index)=>item.category!=="辅料"&&<tr key={item.materialId}>
        <th scope="row">{item.category} {index+1}</th>
        {preorderFabricFields.map(([field,label])=><td key={field}>
          {!readonly?<DevelopmentEntryText id={`development-${item.materialId}-${field}`} label={`${item.category} ${label}`}
            value={item[field]} isDisabled={busy} maxLength={100} onChange={value=>changeMaterial(index,{[field]:value})}
            {...(issue(`development-${item.materialId}-${field}`)?{status:{type:'error' as const,message:issue(`development-${item.materialId}-${field}`)!}}:{})}/>
          :<DocumentField id={`development-${item.materialId}-${field}`} label={`${item.category} ${label}`} value={item[field]} readonly/>}
        </td>)}
        {showMaterialPricing&&<td>{materialPriceFields(item,index)}</td>}
        {!readonly&&<td><DevelopmentEntryAction type="button" disabled={busy} onClick={async()=>{
          if(await confirmInApp(`删除${item.name||item.label||item.category}？`)&&!writing.current)
            edit({materials:document.materials.filter(row=>row.materialId!==item.materialId)});
        }}>删除面料</DevelopmentEntryAction></td>}
      </tr>)}
    </tbody></table>
  </DocumentTableScroll>
  {!readonly&&<div className="development-actions">{(["主布","配布"] as const).map(category=><DevelopmentEntryAction className="dx-doc-add-row budget-controls" type="button" key={category} disabled={busy||document.materials.length>=100} onClick={()=>{
    const next=material(category,category);
    edit({materials:[...document.materials,next]});
    requestAnimationFrame(()=>window.document.getElementById(`development-${next.materialId}-name`)?.focus());
  }}>{`＋ 添加${category}`}</DevelopmentEntryAction>)}</div>}
</DocumentSection>}
{!light&&!requirements&&(creationView==="sheet"||designerInput&&!readonly||readonly&&Boolean(document.craftRequirements?.length))&&
  <DevelopmentCraftRequirements document={document} edit={edit} controls={craftControls} readonly={readonly} disabled={busy}
    draftsOnly={creationView==="sheet"&&!readonly} upload={upload} viewFile={imageUrl} fileIdentity={fileIdentity} metadataPath={metadataPath}/>}
{!light&&(!workbench?creationView!=="sheet":creationView!=="requirements")&&compactSection("制作要求",`已填 ${Object.keys(labels).filter(key=>Boolean(document[key as keyof typeof labels])).length} 项`,<DocumentSection id="development-craft" title={currentInput?"制作要求":`${sectionStart+2} · 工艺要求`}><div className="development-craft-groups">
            {([{title:"洗水要求",keys:["washingMethod"]},{title:"整烫与包装",keys:["ironing","packaging"]},{title:"朴料",keys:["interlining","placketInterlining"]},{title:"车缝",keys:["sewingThread","buttonholeThread","stitchDensity"]},{title:"尺码标识",keys:["formalSizes","casualSizes"]}] as const).map(group=><section key={group.title}><h3>{group.title}</h3><div>{group.title==="洗水要求"&&select("washing","洗水",["免洗","内洗","外洗"])}{group.keys.map(key=>key==="washingMethod"&&document.washing==="免洗"?null:<div key={key}>{field(key,labels[key],key==="formalSizes"||key==="casualSizes"?100:1000,key==="washingMethod"||key==="ironing"||key==="packaging")}</div>)}</div></section>)}

            {document.washingIroning&&<section><h3>原洗水整烫说明</h3><p className="dx-doc-readonly">{document.washingIroning}</p></section>}

          </div></DocumentSection>)}
  </div>;
}
