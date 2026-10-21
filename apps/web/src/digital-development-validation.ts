import { DevelopmentDocumentSchema, developmentPublishErrors, developmentSizeQuantityIssues, developmentMaterialPublishIssues, type DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import {developmentMakingQuantityError} from "./digital-development-editing.js";
import { DevelopmentRevisionSchema, type DevelopmentRevision } from "@dx-rework/contracts/digital-development-rounds";
import type { DocumentIssue } from "./document-editor.js";

const labels:Record<string,string>={quantity:"本轮打板数量",sampleSize:"本轮打样尺码",orderDate:"开发下单日期",returnDate:"预计样板完成日期",instructions:"制作说明",sizes:"尺码列",measurements:"尺寸表",materials:"面辅料",files:"附件",name:"品名",expectedDate:"预计到料日期",width:"幅宽",weight:"克重",composition:"成分",color:"颜色",consumption:"用量",specification:"规格",supplier:"供应方",label:"名称",craft:"工艺"};
/** Validate the raw integer buffer before it can become null in JSON; all business rules remain the original schemas. */
export function developmentIssues(document:DevelopmentDocument,quantityInput:string,measurementIds:string[],publish=false,revision?:Omit<DevelopmentRevision,"document">|null,sizeQuantityInputs?:string[],allowMissingOrderDate=false):DocumentIssue[]{
 const issues:DocumentIssue[]=[];
 sizeQuantityInputs?.forEach((value,index)=>{const message=developmentMakingQuantityError(value);if(message)issues.push({id:`development-size-quantity-${index}`,label:`尺寸表 · ${document.sizes[index]||`第${index+1}列`}制作数量`,message});});
 if(quantityInput!==""&&(!/^\d+$/.test(quantityInput)||Number(quantityInput)<1||Number(quantityInput)>100000))issues.push({id:"development-quantity",label:"基本资料 · 数量",message:"数量须为1—100000整数或留空"});
 const parsed=DevelopmentDocumentSchema.safeParse(document);
 if(!parsed.success)for(const issue of parsed.error.issues){
  const key=String(issue.path[0]);let id=`development-${key}`,label=labels[key]??key;
  if(key==="materials"&&typeof issue.path[1]==="number"){const row=document.materials[issue.path[1]];const field=String(issue.path[2]??"label");id=`development-${row?.materialId}-${field}`;label=`面辅料 · ${row?.label||row?.category||"物料"} · ${labels[field]??field}`;}
  if(key==="sizes")id=`development-size-${typeof issue.path[1]==="number"?issue.path[1]:0}`;
  if(key==="sizeQuantities"){id=typeof issue.path[1]==="number"?`development-size-quantity-${issue.path[1]}`:"development-size-quantities";label="尺寸表 · 制作数量";}
  if(key==="measurements"&&typeof issue.path[1]==="number"){const index=issue.path[1],field=issue.path[2]==="values"?String(issue.path[3]??0):"name";id=`development-measurement-${measurementIds[index]}-${field}`;label=`尺寸表 · ${document.measurements[index]?.name||`项目${index+1}`} · ${field==="name"?"名称":document.sizes[Number(field)]}`;}
  issues.push({id,label,message:issue.message});
 }
 if(revision){const parsedRevision=DevelopmentRevisionSchema.safeParse({...revision,document});if(!parsedRevision.success)for(const issue of parsedRevision.error.issues)if(issue.path[0]!=="document")issues.push({id:"development-revision",label:"复版修改依据",message:issue.message});}
 if(!publish||!parsed.success||issues.length)return issues;
 for(const message of developmentPublishErrors(parsed.data,{allowMissingOrderDate})){
  if(developmentSizeQuantityIssues(parsed.data).some(issue=>issue.message===message))continue;
  if(developmentMaterialPublishIssues(parsed.data).some(issue=>issue.message===message))continue;
  const key=message.includes("数量")?"quantity":message.includes("打样尺码")?"sampleSize":message.includes("尺码列")?"sizes":message.includes("下单日期")?"orderDate":message.includes("仅适用于")?"craft":"files";
  issues.push({id:key==="files"?"development-upload":key==="sizes"?document.sizes.length?`development-size-${document.sizes.findIndex(size=>!size.trim())}`:"development-sizes":`development-${key}`,label:labels[key]??key,message});
 }
 for(const issue of developmentSizeQuantityIssues(parsed.data))issues.push({id:issue.index===null?"development-size-quantities":`development-size-quantity-${issue.index}`,label:"尺寸表 · 制作数量",message:issue.message});
 for(const issue of developmentMaterialPublishIssues(parsed.data)){const row=parsed.data.materials.find(row=>row.materialId===issue.materialId)!;issues.push({id:`development-${row.materialId}-${issue.field}`,label:`面辅料 · ${row.label||row.category} · ${labels[issue.field]}`,message:issue.message});}
 return issues;
}

/** Resolve before mounting the destination chapter; keep the existing form and its inputs. */
export function developmentFieldChapter(id:string):string|undefined{
 if(/^development-[0-9a-f]{8}-[0-9a-f-]{27}-/.test(id)||id==='development-materials')return 'development-materials';
 if(/^development-(size(?:-|s$)|measurement-|template$|unit$)/.test(id))return 'development-sizes';
 if(/^development-(mainLabel|mainLabelMethod|sizeLabel|careLabel)$/.test(id))return 'development-labels';
 if(/^development-(washing|washingMethod|washingIroning|ironing|packaging|interlining|placketInterlining|sewingThread|buttonholeThread|stitchDensity|formalSizes|casualSizes)$/.test(id))return 'development-craft';
 if(/^development-(quantity|returnDate|orderDate|craft|pattern-preparation)$/.test(id))return 'development-basic';
 if(/^development-(upload|files|instructions)$/.test(id))return 'development-images';
 return undefined;
}
