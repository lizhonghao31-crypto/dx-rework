import { z } from "zod";

const text = z.string().trim().min(1).max(100);
const optionalText = z.string().trim().max(100).nullable().default(null);
const date = z.iso.date();
export const SalesSeriesSchema = z.enum(["P01","P02","P03","P04","P05","P06","P07","P08","P09","P10","P11","P12"]);
const salesContext = {
  salesYear: z.number().int().min(1000).max(9999).nullable().optional(),
  salesSeries: SalesSeriesSchema.nullable().optional(),
  requiresColorMatching: z.boolean().nullable().optional(),
};
/** Options use the server's business date; an existing year is never silently discarded. */
export function salesYearOptions(serverToday: string | undefined, selected?: number | null): number[] {
  const year = serverToday && /^\d{4}-\d{2}-\d{2}$/.test(serverToday) ? Number(serverToday.slice(0,4)) : null;
  return [...new Set([...(year ? [year, year + 1] : []),...(selected ? [selected] : [])])].sort((a,b)=>a-b);
}
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
    context.addIssue({ code: "custom", path: ["customerWarehouseArrivalDate"], message: "出货日期不能互相矛盾" });
  if (new Set(value.sizes.map(item => item.size)).size !== value.sizes.length)
    context.addIssue({ code: "custom", path: ["sizes"], message: "尺码不能重复" });
  if (value.sizes.reduce((sum, item) => sum + item.quantity, 0) > 10000000)
    context.addIssue({ code: "custom", path: ["sizes"], message: "数量超过上限" });
});
export const DigitalOrderCreateSchema = z.object({
  ...salesContext,
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
export const DigitalDesignCodeCheckSchema = z.object({ code: text }).strict();
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

/** Initial customer-order dates use the server's Shanghai calendar and clamp month-end. */
export function beijingCalendarDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
}
export function customerOrderDateError(orderDate:string,today:string): string|null {
  return orderDate>today?`客户下单日期不能晚于服务器北京时间今日（${today}）`:null;
}
export function minimumInitialCustomerDate(now: Date = new Date()): string {
  const day = beijingCalendarDate(now);
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return `${nextYear}-${String(nextMonth).padStart(2,"0")}-${String(Math.min(date,lastDay)).padStart(2,"0")}`;
}
export function initialCustomerDateErrors(lines: ReadonlyArray<{customerWarehouseArrivalDate?: string | null | undefined; deliveryDate?: string | null | undefined}>, minimum: string = minimumInitialCustomerDate()): string[] {
  return lines.flatMap((line,index) => {
    const date = line.customerWarehouseArrivalDate === undefined ? line.deliveryDate : line.customerWarehouseArrivalDate;
    return !date || date < minimum ? [`PO ${index+1} 出货日期须填写 ${minimum} 或之后的日期（首次确定订单至少一个自然月）`] : [];
  });
}

/** Incomplete PO values belong to the development draft, not a production-order root. */
export const InitialCustomerOrderDraftSchema = z.object({
  ...salesContext,
  customerCode: z.string().max(100), productGroup: z.enum(["男装","女装","男童","女童"]),
  designStyleNo: z.string().max(100), temporaryStyleNo: optionalText,
  orderDate: z.string().max(10), contractDeliveryDate: date.nullable(),
  primaryMerchandiserId: z.string().uuid().nullable().optional(),
  lines: z.array(z.object({
    formalPoNo: optionalText.optional(), poNumber: optionalText, formalStyleNo: optionalText,
    temporaryStyleNo: optionalText, color: z.string().max(100), colorForeign: optionalText,
    deliveryDate: date.nullable(), customerWarehouseArrivalDate: date.nullable().optional(),
    sizes: z.array(z.object({size:z.string().max(100),quantity:z.string().max(30)}).strict()).min(1).max(50),
  }).strict()).min(1).max(50),
}).strict();
export type InitialCustomerOrderDraft = z.infer<typeof InitialCustomerOrderDraftSchema>;

export function initialCustomerOrderInput(draft: InitialCustomerOrderDraft): DigitalOrderInput {
  return {...draft,lines:draft.lines.map((line,index)=>{
    const sizes=line.sizes.map(size=>{
      if(size.quantity!==""&&(!/^\d+$/.test(size.quantity)||!Number.isSafeInteger(Number(size.quantity))||Number(size.quantity)>10000000))
        throw new Error(`PO ${index+1} ${size.size||"尺码"}：数量须为不超过10000000的非负整数（件）`);
      return {...size,quantity:Number(size.quantity||0)};
    }).filter(size=>size.quantity>0);
    if(!sizes.length)throw new Error(`PO ${index+1} 至少填写一项正整数订购数量`);
    return {...line,temporaryStyleNo:line.temporaryStyleNo??draft.temporaryStyleNo,sizes};
  })};
}

/** A published development may retain incomplete ordering details; formal confirmation stays strict. */
export function initialCustomerOrderIsReady(draft: InitialCustomerOrderDraft): boolean {
  try {
    const parsed=DigitalOrderCreateSchema.safeParse(initialCustomerOrderInput(draft));
    // Schema dates are nullable for drafts/legacy reads. Missing customer promises
    // must not freeze the ordering fields before the strict confirmation command.
    return parsed.success && parsed.data.lines.every(line=>Boolean(line.customerWarehouseArrivalDate===undefined?line.deliveryDate:line.customerWarehouseArrivalDate));
  }
  catch { return false; }
}
