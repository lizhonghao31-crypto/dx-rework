import { z } from "zod";

const text = z.string().trim().min(1).max(100);
const optionalText = z.string().trim().max(100).nullable().default(null);
const date = z.iso.date();
export const DigitalSourceCreateSchema = z.object({
  developmentType: z.enum(["头版", "开发板"]),
  designStyleNo: text,
  temporaryStyleNo: optionalText,
  customerCode: text.nullable().default(null),
}).strict();
export const DigitalPoInputSchema = z.object({
  poNumber: optionalText,
  formalStyleNo: optionalText,
  temporaryStyleNo: optionalText,
  color: text,
  colorForeign: optionalText,
  deliveryDate: date.nullable().default(null),
  sizes: z.array(z.object({ size: text, quantity: z.number().int().min(1).max(10000000) }).strict()).min(1).max(50),
}).strict().superRefine((value, context) => {
  if (new Set(value.sizes.map(item => item.size)).size !== value.sizes.length)
    context.addIssue({ code: "custom", path: ["sizes"], message: "尺码不能重复" });
  if (value.sizes.reduce((sum, item) => sum + item.quantity, 0) > 10000000)
    context.addIssue({ code: "custom", path: ["sizes"], message: "数量超过上限" });
});
export const DigitalOrderCreateSchema = z.object({
  customerCode: text,
  productGroup: z.enum(["男装", "女装", "男童", "女童"]),
  designStyleNo: text,
  temporaryStyleNo: optionalText,
  orderDate: date,
  contractDeliveryDate: date.nullable().default(null),
  lines: z.array(DigitalPoInputSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  if (new Set(value.lines.map(line => line.color.trim().toLowerCase())).size !== value.lines.length)
    context.addIssue({ code: "custom", path: ["lines"], message: "同一母单颜色不能重复" });
});
export const DigitalNumberCorrectionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  poNumber: optionalText,
  formalStyleNo: optionalText,
}).strict();
export const DigitalIdSchema = z.string().uuid();
export const DigitalPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(100).default(""),
}).strict();
export type DigitalSourceInput = z.infer<typeof DigitalSourceCreateSchema>;
export type DigitalOrderInput = z.infer<typeof DigitalOrderCreateSchema>;
export type DigitalNumberCorrection = z.infer<typeof DigitalNumberCorrectionSchema>;
export type DigitalCustomer = { code: string; name: string; productGroups: string[] };
export type DigitalSource = DigitalSourceInput & { sourceId: string; createdBy: string; createdAt: string; productionOrderId: string | null };
export type DigitalOrder = Omit<DigitalOrderInput, "lines"> & {
  productionOrderId: string; sourceId: string | null; createdBy: string; createdAt: string;
  status: "waiting_development" | "development_linked"; version: number;
  workflowGeneration: "digital_production_v1"; notificationPolicy: "IN_APP_ONLY";
  lines: Array<z.infer<typeof DigitalPoInputSchema> & { lineId: string }>;
};
