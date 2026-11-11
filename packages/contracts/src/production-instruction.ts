import type {TechnicalSizeTable} from "./digital-development-technical.js";
import {CraftStepChoicesSchema,craftLegacyLabel} from './digital-craft.js';
import type {ProductionReadinessState} from "./production-readiness.js";
import { z } from "zod";
import type {JourneyDocumentMetadata} from "./digital-production-journey.js";
import type { DigitalOrder } from "./digital-production.js";
const short = z.string().trim().max(200), text = z.string().trim().max(5000);
export const SEWING_REQUIREMENTS = [
  "1、针距一英寸12针，线迹良好，不可有跳针断线，面线不可有明显接驳线迹。尺寸跟足尺寸表，控制在误差范围内；",
  "2、大货车缝线色及粗细需按样板配好，不接受色差，退线只接受退三针，不能有接线、断线、跳针问题；",
  "3、各部位缝合要平整，不能有褶皱、起拱或扭曲，压线要顺直，宽窄一致；",
  "4、整件完成不可有色差、污渍、断线、破洞，线头要清理干净，各部位整烫平服；注意门禁拉链不能起拱，不同码数拉链长度不同，扣子、钩扣需定好位再打，不能错位，扣子、钩扣需牢固，左右袋需对称，大小一致。",
] as const;
export const MATERIAL_COUNT_TERM = "大货面、辅料到贵公司，请在48小时之内清点数量，并确认收到的面、辅料是否正确，数量是否对数，如不正确，及时跟我司沟通，并及时补齐数量，如贵司不能及时清点数量，由贵司承担相应责任，感谢贵司的支持及配合！";
export const InstructionDocumentSchema = z.object({
  styleName: short, category: short, season: short, fabricType: short, composition: text,
  date: z.iso.date().nullable(), process: text, secondaryCraft:z.enum(["沿用开发","无","印花","绣花","印绣花"]).default("沿用开发"), remarks: text, patternMaker: short,
  craftSteps:CraftStepChoicesSchema.optional(),
  preshrink: z.enum(["待确认", "需要预缩", "无需预缩"]), shipSample: text,
  sewingRequirements: text, comments: text,
  fabrics: z.array(z.object({ id: z.string().uuid(), name: short, part: short, colors: z.record(z.string().uuid(), short), remarks: text }).strict()).max(200),
  accessories: z.array(z.object({ id: z.string().uuid(), group: z.enum(["车缝", "包装"]), garmentColors: short, materialColor: short, name: short, category: short, part: short, specification: short, consumption: short, remarks: text }).strict()).max(400),
  images: z.array(z.object({ attachmentId: z.string().uuid(), kind: z.enum(["款图", "主唛", "腰卡", "吊牌", "洗水唛", "二维码唛", "包装辅料", "其它工艺"]), description: text }).strict()).max(60),
  unit: z.enum(["inch", "cm"]), sizes: z.array(short.min(1)).max(50),
  measurements: z.array(z.object({ id: z.string().uuid(), name: short, tolerance: short, method: text, values: z.array(short).max(50) }).strict()).max(200),
}).strict().superRefine((doc, ctx) => {
  if(doc.craftSteps&&(doc.secondaryCraft==='沿用开发'||craftLegacyLabel(doc.craftSteps)!==doc.secondaryCraft))ctx.addIssue({code:'custom',path:['craftSteps'],message:'请明确沿用开发工艺或本制单独立工艺选择'});
  if (new Set(doc.sizes).size !== doc.sizes.length) ctx.addIssue({ code: "custom", message: "尺码列不能重复", path: ["sizes"] });
  if (doc.measurements.some(row => row.values.length !== doc.sizes.length)) ctx.addIssue({ code: "custom", message: "尺寸须对应尺码列", path: ["measurements"] });
  for (const key of ["fabrics", "accessories", "measurements"] as const)
    if (new Set(doc[key].map(row => row.id)).size !== doc[key].length) ctx.addIssue({ code: "custom", message: "明细行不能重复", path: [key] });
  if (new Set(doc.images.map(row => row.attachmentId)).size !== doc.images.length) ctx.addIssue({ code: "custom", message: "图片不能重复", path: ["images"] });
});
export type InstructionDocument = z.infer<typeof InstructionDocumentSchema>;
export const SaveInstructionSchema = z.object({ expectedVersion: z.number().int().nonnegative(), orderVersion: z.number().int().positive(), sourceRound:z.number().int().positive().nullable().optional(), document: InstructionDocumentSchema }).strict();
export const INSTRUCTION_SOURCE_GROUPS = ["craft", "comments", "measurements", "images", "fabrics", "accessories", "composition"] as const;
export type InstructionSourceGroup = typeof INSTRUCTION_SOURCE_GROUPS[number];
export const instructionSourceLabels:Record<InstructionSourceGroup,string> = {craft:"工艺路线",comments:"技术说明",measurements:"尺码与尺寸",images:"开发附图",fabrics:"面料",accessories:"辅料",composition:"成分"};
export const ReviewInstructionSourceSchema=z.object({expectedVersion:z.number().int().nonnegative(),orderVersion:z.number().int().positive(),sourceRound:z.number().int().positive(),sourceVersion:z.number().int().positive(),document:InstructionDocumentSchema,
 decisions:z.array(z.object({group:z.enum(INSTRUCTION_SOURCE_GROUPS),action:z.enum(["adopt","retain"])}).strict()).max(INSTRUCTION_SOURCE_GROUPS.length)
}).strict().superRefine((value,ctx)=>{if(new Set(value.decisions.map(item=>item.group)).size!==value.decisions.length)ctx.addIssue({code:"custom",path:["decisions"],message:"每组资料只能选择一次"});});
export type InstructionSourceReview=z.infer<typeof ReviewInstructionSourceSchema>;
export const instructionSourceFields:Record<InstructionSourceGroup,ReadonlyArray<keyof InstructionDocument>>={craft:["secondaryCraft","craftSteps","process"],comments:["comments"],measurements:["unit","sizes","measurements"],images:["images"],fabrics:["fabrics"],accessories:["accessories"],composition:["composition"]};
export function instructionSourceValue(document:InstructionDocument,group:InstructionSourceGroup){return Object.fromEntries(instructionSourceFields[group].map(field=>[field,document[field]]));}
const withoutRowIds=(value:unknown):unknown=>Array.isArray(value)?value.map(withoutRowIds):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).filter(([key])=>key!=="id").map(([key,item])=>[key,withoutRowIds(item)])):value;
export function changedInstructionSourceGroups(before:InstructionDocument,after:InstructionDocument){return INSTRUCTION_SOURCE_GROUPS.filter(group=>JSON.stringify(withoutRowIds(instructionSourceValue(before,group)))!==JSON.stringify(withoutRowIds(instructionSourceValue(after,group))));}
export function applyInstructionSourceReview(current:InstructionDocument,proposed:InstructionDocument,decisions:InstructionSourceReview["decisions"],before?:InstructionDocument){
 const result=structuredClone(current);
 for(const decision of decisions){if(decision.action!=="adopt")continue;
  if(decision.group==="images")result.images=[...result.images,...proposed.images.filter(image=>!result.images.some(existing=>existing.attachmentId===image.attachmentId))];
  else if(decision.group==="measurements"){
   const existing=result.measurements,sizes=result.sizes,unitChanged=current.unit!==proposed.unit,used=new Set<string>();
   const count=(rows:InstructionDocument['measurements'],name:string)=>rows.filter(row=>row.name===name).length;
   // Ambiguous same-name rows remain intact. Only a unique existing/source row can be matched.
   const eligible=existing.filter(row=>count(existing,row.name)===1&&(!before||count(before.measurements,row.name)===1));
   result.unit=proposed.unit;result.sizes=[...proposed.sizes];
   result.measurements=proposed.measurements.map(row=>{
    const manual=eligible.find(item=>item.name===row.name&&!used.has(item.id));
    if(manual){used.add(manual.id);return {...row,id:manual.id,tolerance:unitChanged?'':manual.tolerance,method:manual.method};}
    return {...row,id:existing.some(item=>item.id===row.id)?globalThis.crypto.randomUUID():row.id};
   });
   result.measurements.push(...existing.filter(row=>!used.has(row.id)).map(row=>({...row,tolerance:unitChanged?'':row.tolerance,values:proposed.sizes.map(size=>unitChanged?'':row.values[sizes.indexOf(size)]??'')})));

  }
  else Object.assign(result,instructionSourceValue(proposed,decision.group));
 }
 return InstructionDocumentSchema.parse(result);
}
export const PublishInstructionSchema = z.object({ expectedReadinessRevision:z.string().min(1).optional(), expectedVersion: z.number().int().positive(), orderVersion: z.number().int().positive() }).strict();
export const InstructionDateRequestSchema = z.object({
  orderVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(500),
  changes: z.array(z.object({lineId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),date:z.iso.date()}).strict()).min(1).max(50),
}).strict().superRefine((value,ctx)=>{if(new Set(value.changes.map(change=>change.lineId)).size!==value.changes.length)ctx.addIssue({code:"custom",path:["changes"],message:"PO 不可重复"});});
export type InstructionDateRequest = z.infer<typeof InstructionDateRequestSchema>;
export type CustomerDateHistory = {
  requestId:string; legacy?:boolean; source:"po"|"instruction"|"delivery"; oldDate:string|null; date:string;
  reason:string; status:string; requestedBy:string; requestedAt:string; decidedBy:string|null; decidedAt:string|null;
  changes:Array<{lineId:string;poNumber:string|null;color:string;oldDate:string|null;date:string;expectedVersion:number}>;
  approvalBlockedReason:string|null;
};
export function initialInstruction(): InstructionDocument {
  return { styleName: "", category: "", season: "", fabricType: "", composition: "", date: null, process: "", secondaryCraft:"沿用开发", remarks: "", patternMaker: "", preshrink: "待确认", shipSample: "", sewingRequirements: SEWING_REQUIREMENTS.join("\n"), comments: "", fabrics: [], accessories: [], images: [], unit: "inch", sizes: [], measurements: [] };
}
export function instructionErrors(doc: InstructionDocument, order: DigitalOrder): string[] {
  const errors: string[] = [];
  if (!doc.styleName || !doc.category || !doc.date) errors.push("请填写款名、类型、制单日期");
  if (doc.preshrink === "待确认") errors.push("请选择是否预缩");
  if (!doc.images.some(image => image.kind === "款图")) errors.push("请上传或沿用款图");
  if (order.lines.some(line => line.sizes.some(size => !doc.sizes.includes(size.size)))) errors.push("尺寸表须包含母单全部尺码");
  if (!doc.measurements.length) errors.push("请填写齐码尺寸");
  if(doc.measurements.some(row=>!row.name.trim()||row.values.length!==doc.sizes.length||row.values.some(value=>!value.trim())))errors.push("每个尺寸项目须有名称，所有尺码须填写尺寸值");
  if (doc.fabrics.some(row => Object.keys(row.colors).some(id => !order.lines.some(line => line.lineId === id)))) errors.push("面料颜色必须对应母单款色");
  return errors;
}
export type InstructionSheet = {
  orderTimeEnabled?:boolean;
  timelineSchemaVersion?:2;
  technicalSizeTable?:TechnicalSizeTable;
  readiness?:ProductionReadinessState;
  metadata?:JourneyDocumentMetadata;
  order: DigitalOrder; currentOrderVersion: number; currentDeliveryDate: string | null; document: InstructionDocument; version: number; publishedVersion: number | null;
  versions: number[]; isPublishedSnapshot: boolean; canEdit: boolean; cutStarted: boolean; merchandiserName: string | null;
  sourceRound: number | null; latestSourceRound: number | null; canApproveDate: boolean; printedBy: string;
  sourceComparison?:{sourceRound:number;sourceVersion:number;before:InstructionDocument;proposed:InstructionDocument;groups:InstructionSourceGroup[]};
  sourceReview?:{sourceRound:number;sourceVersion?:number;instructionVersion:number;decisions:InstructionSourceReview["decisions"];reviewedAt:string;reviewedBy:string;priorMeasurements?:Pick<InstructionDocument,"unit"|"sizes"|"measurements">};
  canRequestDate?:boolean;
  customerPoDates?:Array<{lineId:string;poNumber:string|null;color:string;date:string|null;registeredDate:string|null;version:number;source:string|null;factoryDate:string|null}>;
  dateRequests: CustomerDateHistory[];
};
