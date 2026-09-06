import { z } from "zod";
import { SampleListQuerySchema, SampleStatusSchema, SampleViewSchema, SampleDisposalTypeSchema } from "./samples.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const SampleReadQuerySchema = SampleListQuerySchema.extend({
  status: SampleStatusSchema.optional(),
  disposalType: SampleDisposalTypeSchema.optional(),
  disposedFrom: date.optional(), disposedTo: date.optional(),
  personUserId: z.string().uuid().optional(),
}).refine(q => !q.disposedFrom || !q.disposedTo || q.disposedFrom <= q.disposedTo, "处置日期范围无效");
export type SampleReadQuery = z.infer<typeof SampleReadQuerySchema>;
export const SampleHistoryQuerySchema = z.object({
  kind: z.enum(["custody", "disposal", "audit"]).default("custody"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
}).strict();
const count = z.number().int().nonnegative();
export const SampleListResponseSchema = z.object({
  items: z.array(SampleViewSchema).max(15), page: z.number().int().positive(), totalCount: count,
  counts: z.object({ borrowed: count, inStock: count, pending: count }),
}).strict();
export type SampleListResponse = z.infer<typeof SampleListResponseSchema>;
export const SampleDetailResponseSchema = z.object({
  item: SampleViewSchema, canViewAudit: z.boolean(),
}).strict();
export type SampleDetailResponse = z.infer<typeof SampleDetailResponseSchema>;
export const SampleHistoryEntrySchema = z.object({
  id: z.string().uuid(), occurredAt: z.string(), actorName: z.string(),
  kind: z.string(), purpose: z.string().optional(), returnedAt: z.string().nullable().optional(),
  recipient: z.string().nullable().optional(), status: z.string().optional(),
  amount: z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/).nullable().optional(),
}).strict();
export const SampleHistoryResponseSchema = z.object({
  items: z.array(SampleHistoryEntrySchema).max(15), page: z.number().int().positive(), totalCount: count,
}).strict();
export type SampleHistoryResponse = z.infer<typeof SampleHistoryResponseSchema>;
export const SampleOptionsSchema = z.object({
  brands: z.array(z.string()), departments: z.array(z.string()), purchaseYears: z.array(z.number().int()),
  people: z.array(z.object({ userId: z.string().uuid(), name: z.string() }).strict()),
}).strict();
export type SampleOptions = z.infer<typeof SampleOptionsSchema>;
const total = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/);
export const SampleAmountsSchema = z.object({
  purchaseTotal: total, managedOriginalValue: total, disposedOriginalValue: total,
  saleReceipts: total, lossCompensation: total,
}).strict();
export type SampleAmounts = z.infer<typeof SampleAmountsSchema>;
