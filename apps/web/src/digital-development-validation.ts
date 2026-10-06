import { DevelopmentDocumentSchema, developmentPublishErrors, type DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { DevelopmentRevisionSchema, type DevelopmentRevision } from "@dx-rework/contracts/digital-development-rounds";
import type { DocumentIssue } from "./document-editor.js";

const labels:Record<string,string>={quantity:"数量",sampleSize:"样板尺码",orderDate:"下单日期",returnDate:"回版日期",instructions:"制作说明",sizes:"尺码列",measurements:"尺寸表",materials:"面辅料",files:"附件",name:"品名",expectedDate:"预计到料日期",width:"幅宽",weight:"克重",composition:"成分",color:"颜色",consumption:"用量",specification:"规格",supplier:"供应方",label:"名称",craft:"工艺"};
/** Validate the raw integer buffer before it can become null in JSON; all business rules remain the original schemas. */
export function developmentIssues(document:DevelopmentDocument,quantityInput:string,measurementIds:string[],publish=false,revision?:Omit<DevelopmentRevision,"document">|null):DocumentIssue[]{
 const issues:DocumentIssue[]=[];
 if(quantityInput!==""&&(!/^\d+$/.test(quantityInput)||Number(quantityInput)<1||Number(quantityInput)>100000))issues.push({id:"development-quantity",label:"基本资料 · 数量",message:"数量须为1—100000整数或留空"});
 const parsed=DevelopmentDocumentSchema.safeParse(document);
 if(!parsed.success)for(const issue of parsed.error.issues){
  const key=String(issue.path[0]);let id=`development-${key}`,label=labels[key]??key;
  if(key==="materials"&&typeof issue.path[1]==="number"){const row=document.materials[issue.path[1]];const field=String(issue.path[2]??"label");id=`development-${row?.materialId}-${field}`;label=`面辅料 · ${row?.label||row?.category||"物料"} · ${labels[field]??field}`;}
  if(key==="sizes")id=`development-size-${typeof issue.path[1]==="number"?issue.path[1]:0}`;
  if(key==="measurements"&&typeof issue.path[1]==="number"){const index=issue.path[1],field=issue.path[2]==="values"?String(issue.path[3]??0):"name";id=`development-measurement-${measurementIds[index]}-${field}`;label=`尺寸表 · ${document.measurements[index]?.name||`项目${index+1}`} · ${field==="name"?"名称":document.sizes[Number(field)]}`;}
  issues.push({id,label,message:issue.message});
 }
 if(revision){const parsedRevision=DevelopmentRevisionSchema.safeParse({...revision,document});if(!parsedRevision.success)for(const issue of parsedRevision.error.issues)if(issue.path[0]!=="document")issues.push({id:"development-revision",label:"复版修改依据",message:issue.message});}
 if(!publish||!parsed.success||issues.length)return issues;
 for(const message of developmentPublishErrors(parsed.data)){
  if(document.materials.some(row=>row.requiredThisRound&&(message===`${row.label||"物料"}缺少品名`||message===`${row.label||row.name}未到，请填写预计日期`)))continue;
  const key=message.includes("数量")?"quantity":message.includes("样板尺码")?"sampleSize":message.includes("下单日期")?"orderDate":message.includes("仅适用于")?"craft":"files";
  issues.push({id:key==="files"?"development-upload":`development-${key}`,label:labels[key]??key,message});
 }
 for(const row of parsed.data.materials){if(!row.requiredThisRound)continue;if(!row.name)issues.push({id:`development-${row.materialId}-name`,label:`面辅料 · ${row.label||row.category} · 品名`,message:`${row.label||"物料"}缺少品名`});if(row.category==="辅料"&&!row.available&&!row.expectedDate)issues.push({id:`development-${row.materialId}-expectedDate`,label:`面辅料 · ${row.label||row.category} · 预计到料日期`,message:`${row.label||row.name}未到，请填写预计日期`});}
 return issues;
}
