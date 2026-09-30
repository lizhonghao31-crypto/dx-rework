import { z } from "zod";

const text = z.string().trim().max(1000);
const short = z.string().trim().max(100);
export const DEVELOPMENT_MEASUREMENTS = {
  上衣: ["衫长", "胸围", "腰围", "脚围", "袖长", "袖口", "夹圈", "袖肥", "领阔", "前领深", "领高"],
  裤子: ["腰围（自然平放腰顶直量）", "坐围（浪上2 1/2度）", "坐围（浪上2 3/4度）", "坐围（浪上3 1/4度）", "脾围（浪下0）", "脚口", "前浪（连腰）", "后浪（连腰）", "裤长（连腰）"],
} as const;
export const DevelopmentMaterialSchema = z.object({
  materialId: z.string().uuid(), category: z.enum(["主布", "配布", "辅料"]), label: short,
  supplier: short, name: short, width: short, weight: short, composition: short, consumption: short,
  color: short, specification: short, quantity: short, requiredThisRound: z.boolean(),
  available: z.boolean(), expectedDate: z.iso.date().nullable(),
}).strict();
export const DevelopmentDocumentSchema = z.object({
  template: z.enum(["上衣", "裤子"]), quantity: z.number().int().min(1).max(100000).nullable(),
  sampleSize: short, orderDate: z.iso.date().nullable(), returnDate: z.iso.date().nullable(),
  unit: z.enum(["cm", "inch"]), sizes: z.array(short.min(1)).max(20),
  measurements: z.array(z.object({ name: short, values: z.array(short).max(20) }).strict()).max(100),
  interlining: text, placketInterlining: text, sewingThread: text, buttonholeThread: text,
  stitchDensity: text, washingIroning: text, packaging: text,
  formalSizes: short, casualSizes: short, mainLabel: z.boolean(), mainLabelMethod: text,
  sizeLabel: z.boolean(), careLabel: z.boolean(), instructions: text,
  craft: z.enum(["无", "印花", "绣花", "印绣花"]), washing: z.enum(["免洗", "内洗", "外洗"]),
  materials: z.array(DevelopmentMaterialSchema).max(100),
  files: z.array(z.object({ attachmentId: z.string().uuid(), kind: z.enum(["款图", "局部图", "菲林", "工艺开发板"]) }).strict()).max(30),
}).strict().superRefine((value, context) => {
  if (new Set(value.sizes).size !== value.sizes.length) context.addIssue({ code: "custom", path: ["sizes"], message: "尺码列不能重复" });
  if (value.measurements.some(row => row.values.length !== value.sizes.length)) context.addIssue({ code: "custom", path: ["measurements"], message: "尺寸数值必须对应尺码列" });
  if (new Set(value.materials.map(row => row.materialId)).size !== value.materials.length) context.addIssue({ code: "custom", path: ["materials"], message: "物料行不能重复" });
  if (new Set(value.files.map(row => row.attachmentId)).size !== value.files.length) context.addIssue({ code: "custom", path: ["files"], message: "附件不能重复" });
});
export const SaveDevelopmentSchema = z.object({ expectedVersion: z.number().int().nonnegative(), document: DevelopmentDocumentSchema }).strict();
export const PublishDevelopmentSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const DevelopmentMaterialEventSchema = z.object({ expectedVersion: z.number().int().positive(), action: z.enum(["到货", "修改预计日期", "确认代用"]), expectedDate: z.iso.date().nullable(), note: text }).strict().superRefine((value, context) => {
  if (value.action === "修改预计日期" && !value.expectedDate) context.addIssue({code:"custom",path:["expectedDate"],message:"请填写预计日期"});
  if (value.action === "确认代用" && !value.note) context.addIssue({code:"custom",path:["note"],message:"请填写代用说明"});
});
export type DevelopmentDocument = z.infer<typeof DevelopmentDocumentSchema>;
export type DevelopmentMaterial = z.infer<typeof DevelopmentMaterialSchema>;
export type DevelopmentMaterialEvent = z.infer<typeof DevelopmentMaterialEventSchema>;
export function developmentPublishErrors(document: DevelopmentDocument): string[] {
  const errors: string[] = [];
  if (!document.quantity) errors.push("请填写数量");
  if (!document.sampleSize) errors.push("请填写样板尺码");
  if (!document.orderDate) errors.push("请填写下单日期");
  if (!document.files.some(file => file.kind === "款图")) errors.push("请上传款图");
  for (const item of document.materials) {
    if (!item.requiredThisRound) continue;
    if (!item.name) errors.push(`${item.label || "物料"}缺少品名`);
    if (item.category === "辅料" && !item.available && !item.expectedDate) errors.push(`${item.label || item.name}未到，请填写预计日期`);
  }
  if (document.craft === "无" && document.files.some(file => file.kind === "工艺开发板")) errors.push("工艺开发板仅适用于印花或绣花");
  return errors;
}
export type DevelopmentSheet = {
  sourceId: string; designStyleNo: string; temporaryStyleNo: string | null; customerCode: string | null;
  developmentType: string; designerName: string; version: number; status: "draft" | "published";
  document: DevelopmentDocument | null; publishedAt: string | null; taskId: string | null; canEdit: boolean;
  materialEvents: Array<{ eventId: string; materialId: string; action: string; expectedDate: string | null; note: string; createdAt: string }>;
};
