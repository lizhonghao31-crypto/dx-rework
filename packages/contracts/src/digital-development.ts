import { InitialCustomerOrderDraftSchema } from "./digital-production.js";
import type {JourneyDocumentMetadata} from "./digital-production-journey.js";
import { z } from "zod";

const text = z.string().trim().max(1000);
const short = z.string().trim().max(100);
export const DEVELOPMENT_MEASUREMENTS = {
  上衣: ["衫长", "胸围", "腰围", "脚围", "袖长", "袖口", "夹圈", "袖肥", "领阔", "前领深", "领高"],
  裤子: ["腰围（自然平放腰顶直量）", "坐围（浪上2 1/2度）", "坐围（浪上2 3/4度）", "坐围（浪上3 1/4度）", "脾围（浪下0）", "脚口", "前浪（连腰）", "后浪（连腰）", "裤长（连腰）"],
} as const;
export const DevelopmentMaterialSchema = z.object({
  materialId: z.string().uuid(), category: z.enum(["主布", "配布", "辅料"]), label: short,
  auxiliaryKind: z.enum(["普通辅料", "拉链", "扁机"]).optional(),
  supplier: short, name: short, width: short, weight: short, composition: short, consumption: short,
  color: short, specification: short, quantity: short, requiredThisRound: z.boolean(),
  available: z.boolean(), expectedDate: z.iso.date().nullable(),
}).strict().superRefine((value, context) => {
  if (value.auxiliaryKind && value.category !== "辅料") context.addIssue({code:"custom",path:["auxiliaryKind"],message:"仅辅料可以设置辅料类型"});
});
export const DevelopmentDocumentSchema = z.object({
  // Missing version belongs to frozen historical documents, never an exemption for new publication.
  documentFormatVersion: z.literal(2).optional(),
  sizeQuantities: z.array(z.number().int().min(0).max(100000).nullable()).max(20).optional(),
  customerOrderDraft: z.object({withOrder:z.boolean(),order:InitialCustomerOrderDraftSchema}).strict().optional(),
  // Draft selection only. Publication still obtains and validates the current price quote.
  patternCategoryId: z.string().uuid().nullable().optional(),
  template: z.enum(["上衣", "裤子"]), quantity: z.number().int().min(1).max(100000).nullable(),
  sampleSize: short, orderDate: z.iso.date().nullable(), returnDate: z.iso.date().nullable(),
  unit: z.enum(["cm", "inch"]), sizes: z.array(short).max(20),
  measurements: z.array(z.object({ name: short, values: z.array(short).max(20) }).strict()).max(100),
  interlining: text, placketInterlining: text, sewingThread: text, buttonholeThread: text,
  stitchDensity: text, washingIroning: text, washingMethod: text.optional(), ironing: text.optional(), packaging: text,
  formalSizes: short, casualSizes: short, mainLabel: z.boolean(), mainLabelMethod: text,
  sizeLabel: z.boolean(), careLabel: z.boolean(), instructions: text,
  craft: z.enum(["无", "印花", "绣花", "印绣花"]), washing: z.enum(["免洗", "内洗", "外洗"]),
  materials: z.array(DevelopmentMaterialSchema).max(100),
  files: z.array(z.object({ attachmentId: z.string().uuid(), kind: z.enum(["款图", "局部图", "菲林", "工艺开发板"]) }).strict()).max(30),
}).strict().superRefine((value, context) => {
  const namedSizes = value.sizes.filter(Boolean);
  if (new Set(namedSizes).size !== namedSizes.length) context.addIssue({ code: "custom", path: ["sizes"], message: "尺码列不能重复" });
  if (value.measurements.some(row => row.values.length !== value.sizes.length)) context.addIssue({ code: "custom", path: ["measurements"], message: "尺寸数值必须对应尺码列" });
  if (value.sizeQuantities && value.sizeQuantities.length !== value.sizes.length) context.addIssue({code:"custom",path:["sizeQuantities"],message:"制作数量必须逐列对应尺码"});
  if (new Set(value.materials.map(row => row.materialId)).size !== value.materials.length) context.addIssue({ code: "custom", path: ["materials"], message: "物料行不能重复" });
  if (new Set(value.files.map(row => row.attachmentId)).size !== value.files.length) context.addIssue({ code: "custom", path: ["files"], message: "附件不能重复" });
});
export const SaveDevelopmentSchema = z.object({ expectedVersion: z.number().int().nonnegative(), document: DevelopmentDocumentSchema }).strict();
export const PublishDevelopmentSchema = z.object({ expectedVersion: z.number().int().positive(), patternOrder:z.object({categoryId:z.string().uuid(),priceVersion:z.number().int().positive()}).strict().optional() }).strict();
export const DevelopmentMaterialEventSchema = z.object({ expectedMaterialRevision: z.number().int().nonnegative(), expectedVersion: z.number().int().positive(), action: z.enum(["到货", "修改预计日期", "确认代用"]), expectedDate: z.iso.date().nullable(), note: text }).strict().superRefine((value, context) => {
  if (value.action === "修改预计日期" && !value.expectedDate) context.addIssue({code:"custom",path:["expectedDate"],message:"请填写预计日期"});
  if (value.action === "确认代用" && !value.note) context.addIssue({code:"custom",path:["note"],message:"请填写代用说明"});
});
export type DevelopmentDocument = z.infer<typeof DevelopmentDocumentSchema>;
export type DevelopmentMaterial = z.infer<typeof DevelopmentMaterialSchema>;
/** Legacy/unclassified auxiliaries remain ordinary; never infer exceptions from a name. */
export function isEarlyMaterialException(material: DevelopmentMaterial): boolean {
  return material.category === "辅料" && (material.auxiliaryKind === "拉链" || material.auxiliaryKind === "扁机");
}
export type DevelopmentMaterialEvent = z.infer<typeof DevelopmentMaterialEventSchema>;
/** Empty template slots are not a declaration that a material is unused. */
export function isDevelopmentMaterialPlaceholder(item:DevelopmentMaterial):boolean {
  return (!item.auxiliaryKind||item.auxiliaryKind==="普通辅料")&&["","主布","配布","辅料","主布A","配布B","配布C"].includes(item.label.replace(/\s/g,""))&&
    ![item.name,item.supplier,item.width,item.weight,item.composition,item.consumption,item.color,item.specification,item.quantity,item.expectedDate].some(Boolean)&&!item.available;
}
export function developmentSizeQuantityIssues(document:DevelopmentDocument):Array<{index:number|null;message:string}>{
  const issues:Array<{index:number|null;message:string}>=[];
  if(document.documentFormatVersion!==2||!document.sizeQuantities||document.sizeQuantities.length!==document.sizes.length){
    return [{index:null,message:"请在尺寸表逐码填写本轮制作数量，0件表示本轮不做，再保存发布"}];
  }
  document.sizeQuantities.forEach((value,index)=>{if(value===null||!Number.isInteger(value)||value<0||value>100000)issues.push({index,message:`${document.sizes[index]||`第${index+1}列`}制作数量须为0—100000整数，0件表示本轮不做`});});
  if(!issues.length){
    const total=document.sizeQuantities.reduce<number>((sum,value)=>sum+(value??0),0);
    if(total===0)issues.push({index:null,message:"至少一个尺码的制作数量须大于0"});
    if(total!==document.quantity)issues.push({index:null,message:`各码制作数量合计${total}件，与本轮打板数量${document.quantity??"未填"}件不一致，请核对尺寸表`});
  }
  return issues;
}
/** Only server-proven frozen same-round corrections may opt into historical reading rules. */
export function developmentPublishErrors(document: DevelopmentDocument, options:{allowLegacySizeQuantities?:boolean;allowMissingOrderDate?:boolean}={}): string[] {
  const errors: string[] = [];
  if (!document.quantity) errors.push("请填写本轮打板数量");
  if(!options.allowLegacySizeQuantities)errors.push(...developmentSizeQuantityIssues(document).map(issue=>issue.message));
  if (!document.sizes.length) errors.push("至少填写一个尺码列，或先保存草稿");
  if (document.sizes.some(size => !size.trim())) errors.push("请填写尺码列名称，或删除不用的列");
  if (!document.orderDate&&!options.allowMissingOrderDate) errors.push("缺少服务器开发下单日期，请重新读取本单资料；不要填写客户下单日期替代");
  if (!document.files.some(file => file.kind === "款图")) errors.push("请上传款图");
  errors.push(...developmentMaterialPublishIssues(document).map(issue=>issue.message));
  if (document.craft === "无" && document.files.some(file => file.kind === "工艺开发板")) errors.push("工艺开发板仅适用于印花或绣花");
  return errors;
}
/** The server must supply the real frozen basis; never accept this eligibility from a request. */
export function developmentAmendmentPublicationOptions(before:DevelopmentDocument,after:DevelopmentDocument){
 const legacy=before.documentFormatVersion===undefined&&before.sizeQuantities===undefined&&after.documentFormatVersion===undefined&&after.sizeQuantities===undefined&&
  JSON.stringify(before.sizes)===JSON.stringify(after.sizes)&&before.quantity===after.quantity&&before.sampleSize===after.sampleSize;
 return {allowLegacySizeQuantities:legacy,allowMissingOrderDate:before.orderDate===null&&after.orderDate===null};
}
export type DevelopmentSheet = {
  developmentCreatedDate?:string;
  metadata?:JourneyDocumentMetadata;
  materialReadiness?:Array<{usage?:"use"|"unused"|"pending";required?:boolean;materialId:string;available:boolean;verified:boolean;missing:string[];evidenceId:string|null}>;
  productionOrderId?:string|null;
  sourceId: string; designStyleNo: string; temporaryStyleNo: string | null; customerCode: string | null;
  developmentType: string; designerName: string; version: number; status: "draft" | "published";
  document: DevelopmentDocument | null; publishedAt: string | null; taskId: string | null; canEdit: boolean;
  canRevise?: boolean; roundNumber?: number; latestRoundNumber?: number;
  materialEvents: Array<{ eventId: string; materialId: string; action: string; expectedDate: string | null; note: string; createdAt: string }>;
};

/** Shared by print, task handoff and native execution. Never invent counts for legacy text. */
export function developmentMakingSizes(document:DevelopmentDocument|null|undefined):string {
  if(!document)return "未登记";
  if(document.documentFormatVersion!==2)return document.sampleSize||"未登记";
  return document.sizes.flatMap((size,index)=>{const value=document.sizeQuantities?.[index];return typeof value==="number"&&value>0?[`${size||"未命名尺码"} ${value}件`]:[];}).join(" / ")||"尚未填写制作数量";
}

export function developmentMaterialPublishIssues(document:DevelopmentDocument):Array<{materialId:string;field:"name"|"specification"|"expectedDate";message:string}>{
 const issues:Array<{materialId:string;field:"name"|"specification"|"expectedDate";message:string}>=[];
 for(const row of document.materials){
  if(isDevelopmentMaterialPlaceholder(row))continue;
  const label=row.label||row.name||row.category;
  if(!row.name.trim())issues.push({materialId:row.materialId,field:"name",message:`${label}缺少品名，请设计师填写材料资料`});
  if(row.category==="主布"&&!row.specification.trim())issues.push({materialId:row.materialId,field:"specification",message:`${label}缺规格，请设计师填写主布规格`});
  if(row.category==="辅料"&&!row.available&&!row.expectedDate)issues.push({materialId:row.materialId,field:"expectedDate",message:`${label}未到，请填写预计日期`});
 }
 return issues;
}
