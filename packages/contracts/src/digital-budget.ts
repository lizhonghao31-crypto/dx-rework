import { z } from "zod";

const short = z.string().trim().max(100);
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/, "请输入最多六位小数的非负数字");
const optionalDecimal = z.union([decimal, z.literal("")]);
export const BUDGET_SECTIONS = ["主料", "辅料", "外发工序"] as const;
export const BudgetRowSchema = z.object({
  rowId: z.string().uuid(), section: z.enum(BUDGET_SECTIONS), category: short,
  name: short, specification: short, unit: short, supplier: short,
  consumption: optionalDecimal, unitPrice: optionalDecimal,
}).strict();
export const BudgetDocumentSchema = z.object({
  fabricType: short, productCategory: short, monthSeries: short,
  date: z.iso.date().nullable(), currency: z.literal("人民币"),
  rows: z.array(BudgetRowSchema).max(300), freight: optionalDecimal,
  cm: optionalDecimal, salePrice: optionalDecimal,
  outsourcingScope: z.string().trim().max(1000), outsourcingUnitPrice: optionalDecimal,
  imageAttachmentIds: z.array(z.string().uuid()).max(8),
}).strict().superRefine((doc, ctx) => {
  if (new Set(doc.rows.map(row => row.rowId)).size !== doc.rows.length)
    ctx.addIssue({ code: "custom", path: ["rows"], message: "预算明细行不能重复" });
  if (new Set(doc.imageAttachmentIds).size !== doc.imageAttachmentIds.length)
    ctx.addIssue({ code: "custom", path: ["imageAttachmentIds"], message: "图片不能重复" });
});
export const SaveBudgetSchema = z.object({ expectedVersion: z.number().int().nonnegative(), document: BudgetDocumentSchema }).strict();
export const PublishBudgetSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export type BudgetDocument = z.infer<typeof BudgetDocumentSchema>;
export type BudgetRow = z.infer<typeof BudgetRowSchema>;

// Keep the existing sourcing fixed-point convention, with six-place inputs and
// twelve-place products so no detail is rounded before section/cost totals.
const INPUT_SCALE = 1_000_000n;
const PRODUCT_SCALE = INPUT_SCALE * INPUT_SCALE;
function scaled(value: string): bigint {
  if (value === "") return 0n;
  decimal.parse(value);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * INPUT_SCALE + BigInt(fraction.padEnd(6, "0"));
}
function exact(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const positive = value < 0n ? -value : value;
  const fraction = (positive % PRODUCT_SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return `${sign}${positive / PRODUCT_SCALE}${fraction ? `.${fraction}` : ""}`;
}
export function budgetDisplayAmount(value: string): string {
  if (!/^-?\d+(?:\.\d{1,12})?$/.test(value)) throw new Error("Invalid budget amount");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const raw = BigInt(whole!) * PRODUCT_SCALE + BigInt(fraction.padEnd(12, "0"));
  const cents = (raw + 5_000_000_000n) / 10_000_000_000n;
  const grouped = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative && cents !== 0n ? "-" : ""}${grouped}.${(cents % 100n).toString().padStart(2, "0")}`;
}
export function calculateBudget(document: BudgetDocument) {
  const totals: Record<BudgetRow["section"], bigint> = { 主料: 0n, 辅料: 0n, 外发工序: 0n };
  const rows = document.rows.map(row => {
    const amount = scaled(row.consumption) * scaled(row.unitPrice);
    totals[row.section] += amount;
    return { rowId: row.rowId, amount: exact(amount) };
  });
  const cost = totals.主料 + totals.辅料 + totals.外发工序 + (scaled(document.freight) + scaled(document.cm)) * INPUT_SCALE;
  return { rows, main: exact(totals.主料), accessories: exact(totals.辅料), processes: exact(totals.外发工序),
    cost: exact(cost), profit: document.salePrice === "" ? null : exact(scaled(document.salePrice) * INPUT_SCALE - cost) };
}
export function budgetPublishErrors(document: BudgetDocument): string[] {
  const errors: string[] = [];
  if (!document.productCategory) errors.push("请填写产品类别");
  if (!document.fabricType) errors.push("请填写面料属性");
  if (!document.date) errors.push("请填写预算日期");
  if (!document.outsourcingScope) errors.push("请填写本次实际外发范围");
  if (!document.outsourcingUnitPrice || scaled(document.outsourcingUnitPrice) <= 0n) errors.push("请填写本次实际外发预算价");
  // The receiving sourcing field accepts two effective decimal places.
  if (document.outsourcingUnitPrice && !/^\d+(?:\.\d{1,2}0*)?$/.test(document.outsourcingUnitPrice)) errors.push("外发预算价最多两位有效小数");
  for (const row of document.rows) {
    const active = [row.name, row.specification, row.consumption, row.unitPrice].some(Boolean);
    if (active && (!row.name || row.consumption === "" || row.unitPrice === "")) errors.push("有内容的预算行须填写物料或工序、单件用量和单价");
  }
  return errors;
}
export type BudgetSheet = {
  productionOrderId: string; version: number; status: "draft" | "published";
  document: BudgetDocument | null; totals: ReturnType<typeof calculateBudget> | null;
  canEdit: boolean; canSubmitSourcing: boolean; sourcingCaseId: string | null;
  publishedAt: string | null; designerName: string; merchandiserName: string | null;
};
export type BudgetSourcingPreparation = {
  productionOrderId: string; budgetVersion: number; orderVersion: number;
  gender: "男装" | "女装"; styleName: string; contractDeliveryDate: string | null;
  daxingUnitPrice: string;
  lineItems: Array<{ lineId: string; styleNo: string; alternateStyleNo: string; color: string; quantity: number; customerWarehouseArrivalDate?: string | null }>;
  images: Array<{ attachmentId: string; filename: string; mimeType: string }>;
};
