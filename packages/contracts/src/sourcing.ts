import { z } from "zod";

const IdSchema = z.string().uuid();
const ShortTextSchema = z.string().trim().min(1).max(100);
const MoneyInputSchema = z.string().trim().regex(
  /^\d{1,10}(?:\.\d{1,4})?$/,
  "加工单价必须是大于0且最多4位小数的数字",
).refine((value) => Number(value) > 0, "加工单价必须大于0");

const MAX_TOTAL_CENTS = 999_999_999_999_999_999n;

export const calculateSourcingTotalExact = (
  unitPrice: string,
  quantity: number,
): string => {
  const normalized = unitPrice.trim();
  if (!/^\d{1,10}(?:\.\d{1,4})?$/.test(normalized) || Number(normalized) <= 0) {
    throw new RangeError("加工单价必须大于0且最多4位小数");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000_000) {
    throw new RangeError("订单数量必须是1至10000000之间的整数");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const scaled = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  const cents = (scaled * BigInt(quantity) + 50n) / 100n;
  if (cents <= 0n || cents > MAX_TOTAL_CENTS) {
    throw new RangeError("报价总额超出系统允许范围");
  }
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

export const SourcingCaseStatusSchema = z.enum([
  "pending_ie_quote",
  "pending_management_decision",
  "pending_owner_approval",
  "pending_contract",
  "pending_finance_reconciliation",
  "pending_factory_change_verification",
  "pending_exception_verification",
  "closed",
]);

export const CreateSourcingCaseSchema = z.object({
  erpOrderNo: ShortTextSchema,
  styleNo: ShortTextSchema,
  orderQuantity: z.number().int().positive().max(10_000_000),
}).strict();

export const CreateSourcingIeQuoteSchema = z.object({
  unitPrice: MoneyInputSchema,
  quoteReason: z.string().trim().max(500).optional(),
}).strict();

export const SourcingIeQuoteSchema = z.object({
  sourcingIeQuoteId: IdSchema,
  quoteVersion: z.number().int().positive(),
  unitPrice: z.string(),
  quantity: z.number().int().positive(),
  totalAmount: z.string(),
  quoteReason: z.string(),
  quotedBy: IdSchema,
  quotedAt: z.string().datetime(),
}).strict();

export const SourcingCaseSummarySchema = z.object({
  sourcingCaseId: IdSchema,
  erpOrderId: z.string(),
  erpOrderNo: z.string(),
  styleNo: z.string(),
  laneKey: z.literal("garment_processing"),
  orderQuantity: z.number().int().positive(),
  status: SourcingCaseStatusSchema,
  version: z.number().int().positive(),
  createdBy: IdSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  ieQuote: SourcingIeQuoteSchema.nullable(),
}).strict();

export const SourcingCaseListResponseSchema = z.object({
  items: z.array(SourcingCaseSummarySchema),
}).strict();

export type CreateSourcingCase = z.infer<typeof CreateSourcingCaseSchema>;
export type CreateSourcingIeQuote = z.infer<typeof CreateSourcingIeQuoteSchema>;
export type SourcingCaseStatus = z.infer<typeof SourcingCaseStatusSchema>;
export type SourcingIeQuote = z.infer<typeof SourcingIeQuoteSchema>;
export type SourcingCaseSummary = z.infer<typeof SourcingCaseSummarySchema>;
export type SourcingCaseListResponse = z.infer<typeof SourcingCaseListResponseSchema>;
