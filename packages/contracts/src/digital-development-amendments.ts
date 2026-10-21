import {z} from "zod";
import {DevelopmentDocumentSchema,type DevelopmentDocument,isDevelopmentMaterialPlaceholder} from "./digital-development.js";
export const MATERIAL_RETURN_FIELDS=["physical","quantity","color","specification","name","supplier","width","weight","composition","consumption","expectedDate","other"] as const;
export const DOCUMENT_RETURN_FIELDS=["files","instructions","other"] as const;
export const DEVELOPMENT_RETURN_FIELD_LABELS:Record<string,string>={physical:"实物未到",quantity:"数量不符",color:"颜色不符",specification:"规格不符 / 资料错误",name:"品名资料",supplier:"供应方资料",width:"幅宽资料",weight:"克重资料",composition:"成分资料",consumption:"用量资料",expectedDate:"预计到料日期",files:"附件资料",instructions:"制作说明",other:"其他具体资料问题"};
export const DevelopmentReturnIssueSchema=z.object({need:z.enum(["document","supply"]).optional(),materialId:z.string().uuid().nullable(),field:z.enum([...MATERIAL_RETURN_FIELDS,...DOCUMENT_RETURN_FIELDS]),reason:z.string().trim().min(1,"请说明具体问题").max(1000)}).strict().superRefine((v,c)=>{
 if(v.need==="supply"&&!v.materialId)c.addIssue({code:"custom",path:["need"],message:"实物待补须指出具体材料"});
 if(v.field==="physical"&&v.need==="document")c.addIssue({code:"custom",path:["need"],message:"实物未到请选实物待补；资料错误请另选具体字段"});
 if(!(v.materialId?MATERIAL_RETURN_FIELDS:DOCUMENT_RETURN_FIELDS).some(field=>field===v.field))c.addIssue({code:"custom",path:["field"],message:"请选择对应材料或资料区域的问题位置"});
});
export type DevelopmentReturnIssue=z.infer<typeof DevelopmentReturnIssueSchema>;
export const developmentReturnNeed=(issue:DevelopmentReturnIssue)=>issue.need??(issue.field==="physical"?"supply":"document");
export const SaveDevelopmentAmendmentSchema=z.object({taskId:z.string().uuid(),roundNumber:z.number().int().positive(),expectedDocumentVersion:z.number().int().positive(),expectedDraftVersion:z.number().int().nonnegative(),document:DevelopmentDocumentSchema,reason:z.string().trim().max(1000)}).strict();
export const SubmitDevelopmentAmendmentSchema=SaveDevelopmentAmendmentSchema.omit({document:true,reason:true}).extend({expectedDraftVersion:z.number().int().nonnegative()});
export type SaveDevelopmentAmendment=z.infer<typeof SaveDevelopmentAmendmentSchema>;
export type SubmitDevelopmentAmendment=z.infer<typeof SubmitDevelopmentAmendmentSchema>;
export type DevelopmentAmendmentContext={sourceId:string;taskId:string;roundNumber:number;documentVersion:number;document:DevelopmentDocument;issues:DevelopmentReturnIssue[];directSupplyMode:"legacy"|"structured"|null;note:string;draft:{version:number;document:DevelopmentDocument;reason:string}|null};
/** JSONB and HTTP parsers may reorder object keys. Arrays and actual values remain exact. */
function sameDocumentValue(before:unknown,after:unknown):boolean{
 if(before===after)return true;
 if(before===null||after===null||typeof before!=="object"||typeof after!=="object")return false;
 if(Array.isArray(before)||Array.isArray(after))return Array.isArray(before)&&Array.isArray(after)&&before.length===after.length&&before.every((value,index)=>sameDocumentValue(value,after[index]));
 const left=before as Record<string,unknown>,right=after as Record<string,unknown>,keys=Object.keys(left);
 return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&sameDocumentValue(left[key],right[key]));
}
/** A correction cannot silently become a production revision or an arrival fact. */
export function developmentAmendmentErrors(before:DevelopmentDocument,after:DevelopmentDocument):string[]{
 const errors:string[]=[];
 for(const key of Object.keys({...before,...after}) as Array<keyof DevelopmentDocument>){
  if(["materials","files","instructions"].includes(key))continue;
  if(!sameDocumentValue(before[key],after[key]))errors.push(`本次补正不能改变${({quantity:"打板数量",sampleSize:"制作尺码",sizes:"尺码列",measurements:"尺寸值",craft:"工艺",washing:"洗水",template:"模板",unit:"尺寸单位"} as Record<string,string>)[key]??"已发布制作依据"}；请通过实际修改 / 复版处理`);
 }
 for(const material of before.materials){
  const next=after.materials.find(row=>row.materialId===material.materialId);
  if(!isDevelopmentMaterialPlaceholder(material)&&(!next||isDevelopmentMaterialPlaceholder(next)))errors.push(`${material.name||material.label||"原材料"}：不能通过删除或清空资料代替文员的本轮不用确认；请保留材料，由文员在复核时记录不用及确认说明`);
 }
 for(const material of after.materials){
  const old=before.materials.find(row=>row.materialId===material.materialId);
  if(old&&(old.available!==material.available||old.requiredThisRound!==material.requiredThisRound)||!old&&material.available)errors.push(`${material.name||material.label||"新增材料"}：补正不能改写实物到货或文员使用确认；实物请登记到货，本轮使用由文员复核`);
 }
 return errors;
}
