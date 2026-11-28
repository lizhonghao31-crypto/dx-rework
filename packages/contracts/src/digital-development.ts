import { InitialCustomerOrderDraftSchema } from "./digital-production.js";
import {CraftStepChoicesSchema,ProductionRoutePlanSchema,craftLegacyLabel,craftStepIdentity,craftStepLabel,type CraftStepChoice} from './digital-craft.js';
import type {JourneyDocumentMetadata} from "./digital-production-journey.js";
import { z } from "zod";
import {AuxiliaryReferenceSchema} from "./auxiliary-catalog.js";

const text = z.string().trim().max(1000);
const short = z.string().trim().max(100);
export const DEVELOPMENT_MEASUREMENTS = {
  上衣: ["衫长", "胸围", "腰围", "脚围", "袖长", "袖口", "夹圈", "袖肥", "领阔", "前领深", "领高"],
  裤子: ["腰围（自然平放腰顶直量）", "坐围（浪上2 1/2度）", "坐围（浪上2 3/4度）", "坐围（浪上3 1/4度）", "脾围（浪下0）", "脚口", "前浪（连腰）", "后浪（连腰）", "裤长（连腰）"],
} as const;
export const DEVELOPMENT_GARMENTS = ["上衣", "裤子"] as const;
const DevelopmentGarmentSchema = z.enum(DEVELOPMENT_GARMENTS);
const SizeTableUnitSchema = z.enum(["cm", "inch"]);
const SizeTableColumnsSchema = z.array(short).max(20);
const SizeTableRowsSchema = z.array(z.object({ name: short, values: z.array(short).max(20) }).strict()).max(100);
const SizeTableQuantitiesSchema = z.array(z.number().int().min(0).max(100000).nullable()).max(20);
/** An alternate garment is part of the original creation draft, never manufacturing input. */
const DevelopmentAlternateSizeDraftSchema = z.object({
  template: DevelopmentGarmentSchema,
  unit: SizeTableUnitSchema,
  sizes: SizeTableColumnsSchema,
  measurements: SizeTableRowsSchema,
  sampleSize: short,
  sizeQuantities: SizeTableQuantitiesSchema,
  rawQuantities: z.array(z.string().max(100)).max(20),
}).strict().refine(value => value.sizeQuantities.length === value.sizes.length
  && value.rawQuantities.length === value.sizes.length
  && value.measurements.every(row => row.values.length === value.sizes.length), "草稿恢复的尺寸须与原尺码列对应");
export const DEVELOPMENT_SAMPLE_BOARD_TYPES = ["头版", "复版", "产前版", "船头版"] as const;
export const DEVELOPMENT_SAMPLE_GENDERS = ["男装", "女装"] as const;
const WorkbenchDevelopmentSheetSchema = z.object({
  version: z.literal(1),
  styleName: short,
  brand: short,
  gender: z.enum(DEVELOPMENT_SAMPLE_GENDERS).nullable(),
  boardType: z.enum(DEVELOPMENT_SAMPLE_BOARD_TYPES).nullable(),
  processingSelected: z.boolean(),
  referenceNote: short,
  sewingRows: z.array(z.object({
    rowId: z.uuid(), color: short, size: short, quantity: z.number().int().min(1).max(100000).nullable(),
  }).strict()).max(100),
}).strict();
export type WorkbenchDevelopmentSheet = z.infer<typeof WorkbenchDevelopmentSheetSchema>;
// Editable annotations do not alter the preserved published work order or
// authority-bearing identity, customer, dates, quantities, or technical facts.
const DevelopmentWorkbenchBasicFieldsSchema=z.object({brand:short,referenceNote:short}).strict();
export const SaveDevelopmentWorkbenchBasicsSchema=DevelopmentWorkbenchBasicFieldsSchema.extend({
  roundNumber:z.number().int().positive(),documentVersion:z.number().int().positive(),expectedRevision:z.number().int().nonnegative(),
}).strict();
export const DevelopmentWorkbenchBasicsSchema=DevelopmentWorkbenchBasicFieldsSchema.extend({revision:z.number().int().positive()}).strict();
export type DevelopmentWorkbenchBasics=z.infer<typeof DevelopmentWorkbenchBasicsSchema>;
export type SaveDevelopmentWorkbenchBasics=z.infer<typeof SaveDevelopmentWorkbenchBasicsSchema>;

export const SaveDevelopmentDesignerCorrectionSchema=z.object({
 roundNumber:z.number().int().positive(),expectedDocumentVersion:z.number().int().positive(),
 reason:z.string().trim().min(1,'请输入资料订正理由').max(1000),
 styleName:short.optional(),brand:short.optional(),referenceNote:short.optional(),
 materialQuantities:z.array(z.object({materialId:z.uuid(),quantity:short.optional(),quantityUnit:short.optional()}).strict()).max(100).optional(),
}).strict().superRefine((value,ctx)=>{
 const ids=value.materialQuantities?.map(row=>row.materialId)??[];
 if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',path:['materialQuantities'],message:'同一材料只可订正一次'});
});
export type SaveDevelopmentDesignerCorrection=z.infer<typeof SaveDevelopmentDesignerCorrectionSchema>;



export const DevelopmentMaterialSupplierOptionSchema=z.object({
  supplierId:z.uuid(),code:short,name:z.string().min(1).max(200),version:z.number().int().positive(),
}).strict();
export type DevelopmentMaterialSupplierOption=z.infer<typeof DevelopmentMaterialSupplierOptionSchema>;
export const DevelopmentMaterialSchema = z.object({
  pricingUnit: short.optional(),
  unitPrice: z.union([z.literal(""),z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/,"请输入最多六位小数的非负单价")]).optional(),
  lineTotal: z.string().max(128).regex(/^\d+(?:\.\d+)?$/).optional(),
  supplierReference:z.object({supplierId:z.uuid(),version:z.number().int().positive()}).strict().optional(),
  auxiliaryCatalog:AuxiliaryReferenceSchema.optional(),
  garmentColor: short.optional(),
  part: short.optional(),
  quantityUnit: short.optional(),
  sampleAttachmentId: z.uuid().nullable().optional(),
  materialId: z.string().uuid(), category: z.enum(["主布", "配布", "辅料"]), label: short,
  auxiliaryKind: z.enum(["普通辅料", "拉链", "扁机"]).optional(),
  supplier: z.string().trim().max(200), name: short, width: short, weight: short, composition: short, consumption: short,
  color: short, specification: short, quantity: short, requiredThisRound: z.boolean(),
  // Optional design planning only. Never a materials check or receipt fact.
  designerHasMaterial: z.boolean().optional(),
  available: z.boolean(), expectedDate: z.iso.date().nullable(),
}).strict().superRefine((value, context) => {
  if(value.auxiliaryCatalog&&value.category!=="辅料")context.addIssue({code:"custom",path:["auxiliaryCatalog"],message:"仅辅料可以引用共享辅料目录"});
  if (value.auxiliaryKind && value.category !== "辅料") context.addIssue({code:"custom",path:["auxiliaryKind"],message:"仅辅料可以设置辅料类型"});
  if (value.designerHasMaterial!==undefined && value.category !== "辅料") context.addIssue({code:"custom",path:["designerHasMaterial"],message:"仅辅料可以填写设计已有实物计划"});
});
const DevelopmentCraftRequirementSchema=z.object({
  stepKey:z.string().min(1).max(100),
  part:short,
  specification:short,
  instructions:text,
  attachmentIds:z.array(z.uuid()).max(30),
}).strict();
export type DevelopmentCraftRequirement=z.infer<typeof DevelopmentCraftRequirementSchema>;

export function developmentCraftOptions(document:{craft:string;craftSteps?:readonly CraftStepChoice[]|undefined}){
  if(document.craftSteps)return document.craftSteps.map(step=>({
    key:step.specialCraft?`${craftStepIdentity(step)}:${step.specialCraft.version}`:craftStepIdentity(step),
    label:craftStepLabel(step),
  }));
  const printing={key:"printing",label:"印花"},embroidery={key:"embroidery",label:"绣花"};
  if(document.craft==="印花")return [printing];
  if(document.craft==="绣花")return [embroidery];
  return document.craft==="印绣花"?[printing,embroidery]:[];
}

export const DevelopmentDocumentSchema = z.object({
  materialSupplierCatalog:z.literal(true).optional(),
  quotationMode: z.literal('automatic_v1').optional(),
  workbenchSheet: WorkbenchDevelopmentSheetSchema.optional(),
  // Missing version belongs to frozen historical documents, never an exemption for new publication.
  documentFormatVersion: z.literal(2).optional(),
  sizeQuantities: SizeTableQuantitiesSchema.optional(),
  customerOrderDraft: z.object({
    withOrder: z.boolean(),
    stage: z.enum(['preorder','formal']).optional(),
    order: InitialCustomerOrderDraftSchema,
    // Resume the last explicitly saved screen. This field has no effect on publication or order authority.
    wizardStep: z.union([z.literal(1),z.literal(2),z.literal(3)]).optional(),
    wizardConfirmPreorder: z.literal(true).optional(),
  }).strict().optional(),
  // Draft selection only. Publication still obtains and validates the current price quote.
  patternCategoryId: z.string().uuid().nullable().optional(),
  productionPlanning:ProductionRoutePlanSchema.optional(),
  template: DevelopmentGarmentSchema, quantity: z.number().int().min(1).max(100000).nullable(),
  // Legacy documents used a default template even when the designer never chose a garment.
  templateConfirmed: z.literal(true).optional(),
  sizeTableInitialized: z.literal(true).optional(),
  alternateSizeDraft: DevelopmentAlternateSizeDraftSchema.optional(),
  // Creation priority is independent of the existing SLA acceleration approval.
  rush: z.boolean().optional(),
  sampleSize: short, orderDate: z.iso.date().nullable(), returnDate: z.iso.date().nullable(),
  unit: SizeTableUnitSchema, sizes: SizeTableColumnsSchema,
  measurements: SizeTableRowsSchema,
  interlining: text, placketInterlining: text, sewingThread: text, buttonholeThread: text,
  stitchDensity: text, washingIroning: text, washingMethod: text.optional(), ironing: text.optional(), packaging: text,
  formalSizes: short, casualSizes: short, mainLabel: z.boolean(), mainLabelMethod: text,
  sizeLabel: z.boolean(), careLabel: z.boolean(), instructions: text,
  craft: z.enum(["无", "印花", "绣花", "印绣花", "特殊工艺"]), washing: z.enum(["免洗", "内洗", "外洗"]),
  craftSteps: CraftStepChoicesSchema.optional(),
  craftOrderConfirmed: z.literal(true).optional(),
  craftRequirements: DevelopmentCraftRequirementSchema.array().max(64).optional(),
  materials: z.array(DevelopmentMaterialSchema).max(100),
  files: z.array(z.object({ attachmentId: z.string().uuid(), kind: z.enum(["款图", "局部图", "菲林", "工艺开发板"]) }).strict()).max(30),
}).strict().superRefine((value, context) => {
  if(value.craft==='特殊工艺'&&!value.craftSteps?.length)context.addIssue({code:'custom',path:['craftSteps'],message:'请选择具体特殊工艺'});
  if(value.craftSteps&&craftLegacyLabel(value.craftSteps)!==value.craft)context.addIssue({code:'custom',path:['craftSteps'],message:'工艺选择与资料内容不一致，请重新读取后选择'});
  const namedSizes = value.sizes.filter(Boolean);
  if (new Set(namedSizes).size !== namedSizes.length) context.addIssue({ code: "custom", path: ["sizes"], message: "尺码列不能重复" });
  if (value.measurements.some(row => row.values.length !== value.sizes.length)) context.addIssue({ code: "custom", path: ["measurements"], message: "尺寸数值必须对应尺码列" });
  if (value.sizeQuantities && value.sizeQuantities.length !== value.sizes.length) context.addIssue({code:"custom",path:["sizeQuantities"],message:"制作数量必须逐列对应尺码"});
  if (value.alternateSizeDraft && (!value.templateConfirmed || value.alternateSizeDraft.template === value.template))
    context.addIssue({code:"custom",path:["alternateSizeDraft"],message:"仅能在原草稿中保留另一衣类的尺寸"});
  if (new Set(value.materials.map(row => row.materialId)).size !== value.materials.length) context.addIssue({ code: "custom", path: ["materials"], message: "物料行不能重复" });
  if (new Set(value.files.map(row => row.attachmentId)).size !== value.files.length) context.addIssue({ code: "custom", path: ["files"], message: "附件不能重复" });
  if(value.craftRequirements?.length){
    const stepKeys=new Set(developmentCraftOptions(value).map(step=>step.key));
    const craftFiles=new Set(value.files.filter(file=>file.kind==="工艺开发板").map(file=>file.attachmentId));
    const usedKeys=new Set<string>();
    value.craftRequirements.forEach((row,index)=>{
      if(!stepKeys.has(row.stepKey)||usedKeys.has(row.stepKey))context.addIssue({code:"custom",path:["craftRequirements",index,"stepKey"],message:"工艺要求须对应本版所选的具体工艺及库版本"});
      usedKeys.add(row.stepKey);
      if(new Set(row.attachmentIds).size!==row.attachmentIds.length||row.attachmentIds.some(id=>!craftFiles.has(id)))
        context.addIssue({code:"custom",path:["craftRequirements",index,"attachmentIds"],message:"仅可引用本版单中已选的工艺开发板，不可重复引用"});
    });
  }
  if(value.workbenchSheet){
    const rows=value.workbenchSheet.sewingRows;
    if(new Set(rows.map(row=>row.rowId)).size!==rows.length)context.addIssue({code:"custom",path:["workbenchSheet","sewingRows"],message:"颜色尺码行不能重复"});
  }
  const localPictures=new Set(value.files.filter(file=>file.kind==="局部图").map(file=>file.attachmentId));
  value.materials.forEach((row,index)=>{
    if(row.sampleAttachmentId&&!localPictures.has(row.sampleAttachmentId))context.addIssue({code:"custom",path:["materials",index,"sampleAttachmentId"],message:"贴实样仅可引用本版单的局部图"});
  });
  if(value.customerOrderDraft?.wizardConfirmPreorder&&(value.customerOrderDraft.stage!=="preorder"||!value.customerOrderDraft.withOrder))context.addIssue({code:"custom",path:["customerOrderDraft","wizardConfirmPreorder"],message:"仅可继续原预下单的正式确认"});

});
export const SaveDevelopmentSchema = z.object({ expectedVersion: z.number().int().nonnegative(), document: DevelopmentDocumentSchema }).strict();
export const PublishDevelopmentSchema = z.object({ expectedVersion: z.number().int().positive(), patternOrder:z.object({categoryId:z.string().uuid(),priceVersion:z.number().int().positive()}).strict().optional() }).strict();
export const PublishDevelopmentPreorderSchema=PublishDevelopmentSchema.pick({expectedVersion:true});
export const DevelopmentSubmissionReceiptQuerySchema=z.object({operation:z.enum(['publish','publish_preorder','confirm']),key:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)}).strict();
/** Absence of a committed receipt is not proof that a request failed. */
export const DevelopmentSubmissionReceiptSchema=z.union([
 z.object({status:z.literal('unconfirmed')}).strict(),
 z.object({status:z.literal('completed'),operation:z.literal('publish'),sourceId:z.string().uuid(),documentVersion:z.number().int().positive()}).strict(),
 z.object({status:z.literal('completed'),operation:z.literal('publish_preorder'),sourceId:z.string().uuid(),documentVersion:z.number().int().positive(),publishedAt:z.iso.datetime({offset:true})}).strict(),
 z.object({status:z.literal('completed'),operation:z.literal('confirm'),sourceId:z.string().uuid(),productionOrderId:z.string().uuid()}).strict(),
]);
export type DevelopmentSubmissionReceipt=z.infer<typeof DevelopmentSubmissionReceiptSchema>;
export type DevelopmentSubmissionOperation=z.infer<typeof DevelopmentSubmissionReceiptQuerySchema>['operation'];
export const DevelopmentOccurrenceSchema=z.discriminatedUnion('precision',[
 z.object({precision:z.literal('instant'),at:z.iso.datetime({offset:true})}).strict(),
 z.object({precision:z.literal('date'),date:z.iso.date()}).strict(),
 z.object({precision:z.literal('unknown')}).strict(),
]);
export type DevelopmentOccurrence=z.infer<typeof DevelopmentOccurrenceSchema>;
export const DevelopmentMaterialEventSchema = z.object({ actualTime:DevelopmentOccurrenceSchema.optional(),expectedRound: z.number().int().positive().optional(), expectedMaterialRevision: z.number().int().nonnegative(), expectedVersion: z.number().int().positive(), action: z.enum(["到货", "修改预计日期", "确认代用"]), expectedDate: z.iso.date().nullable(), note: text }).strict().superRefine((value, context) => {
  if (value.action === "修改预计日期" && !value.expectedDate) context.addIssue({code:"custom",path:["expectedDate"],message:"请填写预计日期"});
  if (value.action === "确认代用" && !value.note) context.addIssue({code:"custom",path:["note"],message:"请填写代用说明"});
});
export type DevelopmentDocument = z.infer<typeof DevelopmentDocumentSchema>;
export const DEVELOPMENT_STYLE_PICTURE_LIMIT=5;
export const isDevelopmentStylePicture=(kind:DevelopmentDocument['files'][number]['kind'])=>kind==="款图"||kind==="局部图";
export function developmentStylePictureIssue(files:DevelopmentDocument['files'],basis:DevelopmentDocument['files']=[]){
  const next=files.filter(file=>isDevelopmentStylePicture(file.kind));
  if(next.length<=DEVELOPMENT_STYLE_PICTURE_LIMIT)return "";
  // Old versions can retain or remove their originals. They cannot use
  // grandfathered slots to attach new images above the agreed cap.
  const original=new Map(basis.filter(file=>isDevelopmentStylePicture(file.kind)).map(file=>[file.attachmentId,file.kind]));
  return next.every(file=>original.get(file.attachmentId)===file.kind)?"":"款式图最多 5 张，原历史图片不会自动删除。";
}
export const DevelopmentMakingUpgradeSchema=z.object({expectedDocumentVersion:z.number().int().positive(),quantities:z.array(z.number().int().min(0).max(100000)).min(1).max(20)}).strict();
export type DevelopmentMakingUpgrade=z.infer<typeof DevelopmentMakingUpgradeSchema>;
export const DevelopmentMakingBasisSchema=z.object({documentVersion:z.number().int().positive(),quantity:z.number().int().positive().nullable(),sizes:z.array(short).max(20),needsUpgrade:z.boolean()}).strict();
export type DevelopmentMakingBasis=z.infer<typeof DevelopmentMakingBasisSchema>;
export function developmentMakingBasis(document:DevelopmentDocument,documentVersion:number):DevelopmentMakingBasis{return {documentVersion,quantity:document.quantity,sizes:document.sizes,needsUpgrade:developmentSizeQuantityIssues(document).length>0};}
export type DevelopmentMaterial = z.infer<typeof DevelopmentMaterialSchema>;
/** Compare only proven units, then multiply the unrounded decimal strings. */
export function developmentMaterialLineTotal(material:Pick<DevelopmentMaterial,"quantity"|"quantityUnit"|"unitPrice"|"pricingUnit">):string|null{
  const price=material.unitPrice?.trim(),priceUnit=material.pricingUnit?.trim();
  if(!price||!priceUnit||!(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(price)))return null;
  const quantity=material.quantity.trim().match(/^(\d+)(?:\.(\d+))?\s*([^\d.].*)?$/);
  if(!quantity)return null;
  const explicitUnit=material.quantityUnit?.trim(),suffix=quantity[3]?.trim();
  if(explicitUnit&&suffix&&explicitUnit!==suffix||(explicitUnit||suffix)!==priceUnit)return null;
  const [priceWhole,priceFraction=""]=price.split("."),quantityFraction=quantity[2]??"";
  const scale=priceFraction.length+quantityFraction.length;
  const digits=(BigInt(priceWhole!+priceFraction)*BigInt(quantity[1]!+quantityFraction)).toString().padStart(scale+1,"0");
  const fraction=scale?digits.slice(-scale).replace(/0+$/,""):"";
  return (scale?digits.slice(0,-scale):digits)+(fraction?`.${fraction}`:"");
}
export type DevelopmentAlternateSizeDraft = z.infer<typeof DevelopmentAlternateSizeDraftSchema>;
/** Publish only the selected garment, keeping the explicit choice and intentionally empty table. */
export function withoutDevelopmentAlternateSizeDraft(document:DevelopmentDocument):DevelopmentDocument {
  if (!document.alternateSizeDraft) return document;
  const published={...document};
  delete published.alternateSizeDraft;
  return published;
}
/** Previously saved data without this opt-in remains historical, not an explicit no. */
export function usesDevelopmentMaterialPlanning(document:DevelopmentDocument|null|undefined):boolean {
  return Boolean(document?.templateConfirmed||document?.materialSupplierCatalog||document?.materials.some(row=>row.designerHasMaterial!==undefined));
}
/** Legacy/unclassified auxiliaries remain ordinary; never infer exceptions from a name. */
export function isEarlyMaterialException(material: DevelopmentMaterial): boolean {
  return material.category === "辅料" && (material.auxiliaryKind === "拉链" || material.auxiliaryKind === "扁机");
}
export type DevelopmentMaterialEvent = z.infer<typeof DevelopmentMaterialEventSchema>;
/** Empty template slots are not a declaration that a material is unused. */
export function isDevelopmentMaterialPlaceholder(item:DevelopmentMaterial):boolean {
  return (!item.auxiliaryKind||item.auxiliaryKind==="普通辅料")&&["","主布","配布","辅料","主布A","配布B","配布C"].includes(item.label.replace(/\s/g,""))&&
    ![item.name,item.supplier,item.supplierReference,item.width,item.weight,item.composition,item.consumption,item.color,item.specification,item.quantity,item.expectedDate,item.garmentColor,item.part,(item.category==='辅料'||item.quantityUnit!=='米')?item.quantityUnit:null,item.sampleAttachmentId].some(Boolean)&&!item.available;
}
/** Price input makes the row part of the document, independently of physical readiness. */
export function hasDevelopmentMaterialPricing(item:DevelopmentMaterial):boolean {
 return Boolean(item.unitPrice?.trim()||(item.category==='辅料'||item.pricingUnit?.trim()!=='米')&&item.pricingUnit?.trim());
}
export function developmentMaterialPriceIdentityIssue(item:DevelopmentMaterial):string|null {
 return hasDevelopmentMaterialPricing(item)&&!item.name.trim()
  ?`${item.label||item.category}已填写材料单价或计价单位，请先填写材料名称` : null;
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
/** Creation/publication can precede technical sizes. Supplied counts remain fully validated. */
export function developmentPublicationSizeIssues(document:DevelopmentDocument):Array<{index:number|null;message:string}>{
  return document.sizeQuantities?.some(value => value !== null) ? developmentSizeQuantityIssues(document) : [];
}
/** Blank placeholder columns are not measurements. Columns containing real input still need names. */
export function developmentUnlabelledSizeIndex(document:DevelopmentDocument):number{
  return document.sizes.findIndex((size,index)=>!size.trim()&&(
    document.sizeQuantities?.[index]!=null||document.measurements.some(row=>Boolean(row.values[index]?.trim()))
  ));
}
/** Only server-proven frozen same-round corrections may opt into historical reading rules. */
export function developmentPublishErrors(document: DevelopmentDocument, options:{allowLegacySizeQuantities?:boolean;allowMissingOrderDate?:boolean}={}): string[] {
  const errors: string[] = [];
  if(document.customerOrderDraft?.stage==='preorder')errors.push('预下单备料资料仅可保存草稿，请先明确切换为开发单后再发布');
  if (!document.quantity) errors.push("请填写本轮打板数量");
  if(!options.allowLegacySizeQuantities)errors.push(...developmentPublicationSizeIssues(document).map(issue=>issue.message));
  if (developmentUnlabelledSizeIndex(document)>=0) errors.push("请填写尺码列名称，或删除不用的列");
  if (!document.orderDate&&!options.allowMissingOrderDate) errors.push("缺少服务器开发下单日期，请重新读取本单资料；不要填写客户下单日期替代");
  if(document.workbenchSheet)errors.push(...developmentWorkbenchPublishIssues(document.workbenchSheet,{styleNameOptional:document.templateConfirmed===true}).map(issue=>issue.message));
  else if (!document.files.some(file => file.kind === "款图")) errors.push("请上传款图");
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
/** Optional facts from the selected document's own development and execution round. */
export type DevelopmentPrintTiming = {
  executionRoundId: string;
  dispatchedOn?: string;
  returnedOn?: string;
  dispatchedDocumentVersion?: number;
};
export type DevelopmentPrintFeedback = {
  text: string;
  sourceRound: number;
  version?: number;
  recordedOn?: string;
  images?: readonly {attachmentId:string;label?:string;url?:string}[];
};
export type DevelopmentPrintDetails = {
  printTiming?: DevelopmentPrintTiming;
  printFeedback?: DevelopmentPrintFeedback;
  printRevision?: {sourceRound:number;revisionNumber?:number;motherOrderNumber?:string};
};
export type DevelopmentSheet = DevelopmentPrintDetails & {
  orderRush?:true;
  workbenchBasics?:DevelopmentWorkbenchBasics;
  workbenchBasicsEditable?:true;
  designerCorrectionEditable?:true;
  numberedSales?:{year:number;series:string|null};
  preorderPublication?:{at:string;documentVersion:number};
  canConfirmPublishedPreorder?:true;
  numberedIdentity?:{orderNumber:string|null};
  orderTimeEnabled?:boolean;
  timelineSchemaVersion?:2;
  independentRevisions?:boolean;
  revisionSource?:{sourceId:string;parentSourceId:string;rootSourceId:string;revisionNumber:number;parentRound:number;origin:string;customerComment:string;explanation:string;categories:string[];affectedNodes:string[];outputKind:string}|null;
  developmentCreatedDate?:string;
  draftDocumentDate?:string;
  unavailableDraftAttachments?:string[];
  materialForecastOnly?:boolean;
  materialForecastBlocked?:string;
  metadata?:JourneyDocumentMetadata;
  materialReadiness?:Array<{usage?:"use"|"unused"|"pending";required?:boolean;materialId:string;available:boolean;verified:boolean;missing:string[];evidenceId:string|null}>;
  productionOrderId?:string|null;
  sourceId: string; designStyleNo: string; temporaryStyleNo: string | null; customerCode: string | null;
  developmentType: string; designerName: string; version: number; status: "draft" | "published";
  document: DevelopmentDocument | null; publishedAt: string | null; taskId: string | null; canEdit: boolean;
  canRevise?: boolean; roundNumber?: number; latestRoundNumber?: number;
  materialEvents: Array<{ eventId: string; materialId: string; action: string; expectedDate: string | null; note: string; createdAt: string;occurredAt?:string|null;occurredDate?:string|null;timeQuality?:string|null }>;
};

/** A precise published document, without current execution state or edit rights. */
export type DevelopmentPublishedVersion = DevelopmentPrintDetails & {
 sourceId:string;designStyleNo:string;temporaryStyleNo:string|null;customerCode:string|null;
 numberedIdentity?:DevelopmentSheet['numberedIdentity'];
 developmentType:string;designerName:string;roundNumber:number;documentVersion:number;
 document:DevelopmentDocument;publishedAt:string|null;metadata:JourneyDocumentMetadata;
};
export type DevelopmentPublishedVersions = {
 sourceId:string;page:number;pageSize:15;total:number;
 items:Array<{roundNumber:number;documentVersion:number;publishedAt:string;reason:string|null}>;
};

/** Shared by print, task handoff and native execution. Never invent counts for legacy text. */
export function developmentMakingSizes(document:DevelopmentDocument|null|undefined):string {
  if(!document)return "未登记";
  if(document.documentFormatVersion!==2)return document.sampleSize||"未登记";
  return document.sizes.flatMap((size,index)=>{const value=document.sizeQuantities?.[index];return typeof value==="number"&&value>0?[`${size||"未命名尺码"} ${value}件`]:[];}).join(" / ")||"尚未填写制作数量";
}

const workbenchRequiredFields = {
  styleName: "款名", gender: "性别", boardType: "板类", processingSelected: "加工类型",
} as const;
export function developmentWorkbenchPublishIssues(sheet:WorkbenchDevelopmentSheet,options:{styleNameOptional?:boolean}={}){
  return (Object.entries(workbenchRequiredFields) as Array<[keyof typeof workbenchRequiredFields,string]>)
    .filter(([field])=>!sheet[field]&&!(field==='styleName'&&options.styleNameOptional))
    .map(([field,label])=>({field,label,message:`请填写或选择${label}`}));
}

export const DEVELOPMENT_AUXILIARY_QUANTITY_UNITS=['个','米','条','箱'] as const;

/** New submission only. An immutable original can still lack these two fields. */
export function developmentCreationBasicsIssues(document:Pick<DevelopmentDocument,'workbenchSheet'>,effectiveBasics?:Pick<DevelopmentWorkbenchBasics,'brand'>){
 const labels={styleName:'款式（品名）',brand:'品牌'} as const;
 const values={styleName:document.workbenchSheet?.styleName,brand:effectiveBasics?.brand??document.workbenchSheet?.brand};
 return (['styleName','brand'] as const).filter(field=>!values[field]?.trim())
  .map(field=>({field,label:labels[field],message:`请填写${labels[field]}`}));
}

type SewingIssue={rowId:string|null;field:'color'|'size'|'quantity';message:string};
type SewingProjection={issues:SewingIssue[];document?:DevelopmentDocument};
/** The one creation input. Only names of missing production sizes are appended. */
export function projectDevelopmentSewingRows(document:DevelopmentDocument):SewingProjection{
 const rows=document.workbenchSheet?.sewingRows??[],issues:SewingIssue[]=[];
 const selected=new Set<string>(),bySize=new Map<string,number>();
 if(!rows.length)issues.push({rowId:null,field:'quantity',message:'请在打板信息添加样板颜色、开发尺码和制作件数'});
 for(const row of rows){
  const color=row.color.trim(),size=row.size.trim(),quantity=row.quantity;
  if(!color)issues.push({rowId:row.rowId,field:'color',message:'请填写样板颜色'});
  if(!size)issues.push({rowId:row.rowId,field:'size',message:'请填写开发尺码'});
  if(quantity===null||!Number.isSafeInteger(quantity)||quantity<1||quantity>100000)issues.push({rowId:row.rowId,field:'quantity',message:'制作件数须为 1 至 100000 的整数'});
  if(!color||!size||quantity===null)continue;
  const normalized=JSON.stringify([color.toLowerCase(),size]);
  if(selected.has(normalized))issues.push({rowId:row.rowId,field:'size',message:'该颜色和尺码已有一条制作行'});
  selected.add(normalized);
  bySize.set(size,(bySize.get(size)??0)+quantity);
 }
 if(issues.length)return {issues};
 const total=[...bySize.values()].reduce((sum,value)=>sum+value,0);
 if(total>100000)return {issues:[{rowId:null,field:'quantity',message:'本轮合计不得超过 100000 件'}]};
 const sizes=[...document.sizes],measurements=document.measurements.map(row=>({...row,values:[...row.values]}));
 for(const size of bySize.keys())if(!sizes.includes(size)){
  sizes.push(size);
  for(const row of measurements)row.values.push('');
 }
 if(sizes.length>20)return {issues:[{rowId:null,field:'size',message:'制作尺码与现有尺寸表合计超过 20 列，请核对'}]};
 return {issues,document:{...document,documentFormatVersion:2,sizes,measurements,quantity:total,sizeQuantities:sizes.map(size=>bySize.get(size)??0)}};
}

type PreparationMaterialField='name'|'quantity'|'quantityUnit';
/** A physical procurement quantity is not a usage-per-piece or warehouse receipt. */
export function developmentPreparationQuantityIssues(document:Pick<DevelopmentDocument,'materials'>,required:boolean){
 const issues:Array<{materialId:string;field:PreparationMaterialField;message:string}>=[];
 for(const row of document.materials){
  if(isDevelopmentMaterialPlaceholder(row)&&!hasDevelopmentMaterialPricing(row)&&!row.auxiliaryCatalog)continue;
  const label=row.label||row.name||row.category;
  const add=(field:PreparationMaterialField,message:string)=>issues.push({materialId:row.materialId,field,message:`${label}${message}`});
  if(row.category==='辅料'&&!row.name.trim())add('name','须填写辅料品名');
  const quantity=row.quantity.trim(),unit=row.quantityUnit?.trim()??'';
  if(!quantity){if(required)add('quantity','须填写本次备料数量');continue;}
  // Older inputs may contain an explicitly written physical unit, such as “520 米”.
  // Do not take a numeric prefix or infer a unit from the material or supplier name.
  const parts=/^([0-9]+(?:\.[0-9]+)?)\s*([^0-9.\s]*)$/.exec(quantity);
  if(!parts||!Number.isFinite(Number(parts[1]))||Number(parts[1])<=0){add('quantity','备料数量须为正数');continue;}
  const writtenUnit=parts[2]??'',physicalUnit=unit||writtenUnit;
  const valid=row.category==='辅料'?(DEVELOPMENT_AUXILIARY_QUANTITY_UNITS as readonly string[]).includes(physicalUnit):physicalUnit===''||physicalUnit==='米';
  if(!valid||(unit&&writtenUnit&&unit!==writtenUnit))add('quantityUnit',row.category==='辅料'?'请选择有效数量单位（个、米、条、箱），并核对原单位':'面料数量单位为米，请核对原单位');
 }
 return issues;
}

type DevelopmentMaterialPublishField = "name"|"specification"|"expectedDate"|"composition"|"width"|"supplier";
export function developmentAuxiliaryPlanningPublishIssues(document:DevelopmentDocument):Array<{materialId:string;field:"expectedDate";message:string}> {
 return document.materials.filter(row=>row.category==="辅料"&&row.requiredThisRound&&row.designerHasMaterial===false&&!row.expectedDate)
  .map(row=>({materialId:row.materialId,field:"expectedDate",message:`${row.label||row.name||row.category}选择了没有实物，请填写预计日期`}));
}
export function developmentMaterialPublishIssues(document:DevelopmentDocument):Array<{materialId:string;field:DevelopmentMaterialPublishField;message:string}>{
 const issues:Array<{materialId:string;field:DevelopmentMaterialPublishField;message:string}>=developmentAuxiliaryPlanningPublishIssues(document);
 const explicitPlanning=Boolean(document.templateConfirmed||document.materialSupplierCatalog);
 for(const row of document.materials){
  const priceIdentityIssue=developmentMaterialPriceIdentityIssue(row);
  if(priceIdentityIssue){issues.push({materialId:row.materialId,field:'name',message:priceIdentityIssue});continue;}
  if(isDevelopmentMaterialPlaceholder(row))continue;
  const label=row.label||row.name||row.category;
  if(document.workbenchSheet){
   if(row.category==="辅料")continue;
   for(const field of ["name","composition","width","supplier"] as const){
    if(!row[field].trim())issues.push({materialId:row.materialId,field,message:`${label}缺少${{name:"面料名称",composition:"成分",width:"幅宽",supplier:"供应商"}[field]}`});
   }
   continue;
  }
  if(!row.name.trim())issues.push({materialId:row.materialId,field:"name",message:`${label}缺少品名，请设计师填写材料资料`});
  if(row.category==="主布"&&!row.specification.trim())issues.push({materialId:row.materialId,field:"specification",message:`${label}缺规格，请设计师填写主布规格`});
  if(!explicitPlanning&&row.category==="辅料"&&row.designerHasMaterial===undefined&&!row.available&&!row.expectedDate)issues.push({materialId:row.materialId,field:"expectedDate",message:`${label}未到，请填写预计日期`});
 }
 return issues;
}
