import { z } from "zod";

const text = z.string().trim().min(1).max(100);
const optionalText = z.string().trim().max(100).nullable().default(null);
const date = z.iso.date();
// Match normalize_sourcing_style_key: trim and ASCII case folding only.
export const digitalPoKey = (value: string | null | undefined): string =>
  (value?.trim() ?? "").replace(/[A-Z]/g, letter => letter.toLowerCase());
export const digitalFormalPoNo = (line: { formalPoNo?: string | null | undefined; formalStyleNo?: string | null | undefined; poNumber?: string | null | undefined }): string | null =>
  [line.formalPoNo, line.formalStyleNo, line.poNumber].find(value => value?.trim())?.trim() ?? null;
const validatePoIdentity = (value: { formalPoNo?: string | null | undefined; formalStyleNo?: string | null | undefined; poNumber?: string | null | undefined }, context: z.RefinementCtx) => {
  const values = [value.formalPoNo, value.formalStyleNo, value.poNumber].map(digitalPoKey).filter(Boolean);
  if (new Set(values).size > 1) context.addIssue({ code: "custom", path: ["formalPoNo"], message: "正式款号（PO）只能有一个有效值" });
};
export const DigitalSourceCreateSchema = z.object({
  developmentType: z.enum(["头版", "开发板"]),
  designStyleNo: text,
  temporaryStyleNo: optionalText,
  customerCode: text.nullable().default(null),
}).strict();
export const DigitalPoInputSchema = z.object({
  formalPoNo: z.string().trim().max(100).nullable().optional(),
  poNumber: optionalText,
  formalStyleNo: optionalText,
  temporaryStyleNo: optionalText,
  color: text,
  colorForeign: optionalText,
  deliveryDate: date.nullable().default(null),
  customerWarehouseArrivalDate: date.nullable().optional(),
  sizes: z.array(z.object({ size: text, quantity: z.number().int().min(1).max(10000000) }).strict()).min(1).max(50),
}).strict().superRefine((value, context) => {
  validatePoIdentity(value, context);
  if (value.customerWarehouseArrivalDate !== undefined && value.deliveryDate !== null && value.customerWarehouseArrivalDate !== value.deliveryDate)
    context.addIssue({ code: "custom", path: ["customerWarehouseArrivalDate"], message: "客户仓到货日不能互相矛盾" });
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
  primaryMerchandiserId: z.string().uuid().nullable().optional(),
  lines: z.array(DigitalPoInputSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  const keys = value.lines.map(line => digitalPoKey(digitalFormalPoNo(line))).filter(Boolean);
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: "custom", path: ["lines"], message: "同一母单正式款号（PO）不能重复" });
  if (new Set(value.lines.map(line => line.color.trim().toLowerCase())).size !== value.lines.length)
    context.addIssue({ code: "custom", path: ["lines"], message: "同一母单颜色不能重复" });
});
export const DigitalNumberCorrectionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  poNumber: optionalText,
  formalStyleNo: optionalText,
  formalPoNo: z.string().trim().max(100).nullable().optional(),
}).strict().superRefine(validatePoIdentity);
export const DigitalIdSchema = z.string().uuid();
export const DigitalPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(100).default(""),
}).strict();
export type DigitalSourceInput = z.infer<typeof DigitalSourceCreateSchema>;
export type DigitalOrderInput = z.infer<typeof DigitalOrderCreateSchema>;
export type DigitalNumberCorrection = z.infer<typeof DigitalNumberCorrectionSchema>;
export type DigitalCustomer = { code: string; name: string; productGroups: string[]; defaultMerchandiserId?: string | null; defaultMerchandiserName?: string | null };
export type DigitalSource = DigitalSourceInput & { sourceId: string; createdBy: string; createdAt: string; productionOrderId: string | null };
export type DigitalOrder = Omit<DigitalOrderInput, "lines"> & {
  productionOrderId: string; sourceId: string | null; createdBy: string; createdAt: string;
  status: "waiting_development" | "development_linked"; version: number;
  workflowGeneration: "digital_production_v1"; notificationPolicy: "IN_APP_ONLY";
  lines: Array<z.infer<typeof DigitalPoInputSchema> & {
    lineId: string; poIdentityConflict?: boolean;
    factoryDeliveryDate?: string | null;
    customerDateVersion?: number; factoryDateVersion?: number;
    customerDateSource?: "initial_po" | "approved_customer_change" | "legacy_unregistered";
    factoryDateSource?: "approved_factory_change" | "legacy_unregistered";
  }>;
};
