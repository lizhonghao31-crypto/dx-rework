import { z } from "zod";

export const SampleStatusSchema = z.enum([
  "borrowed", "return_pending", "in_stock", "borrow_pending", "disposal_pending",
  "loss_payment_pending", "sold", "gifted", "scrapped", "lost", "archived",
]);
export type SampleStatus = z.infer<typeof SampleStatusSchema>;
export const SampleDisposalTypeSchema = z.enum(["sale", "gift", "scrap", "loss"]);
export const SampleMoneySchema = z.string().regex(/^(0|[1-9]\d{0,11})\.\d{2}$/);
export const SampleCapabilitySchema = z.enum([
  "sample:view_basic", "sample:view_finance", "sample:view_audit",
  "sample:create", "sample:batch_create", "sample:borrow_request", "sample:borrow_confirm",
  "sample:return_request", "sample:return_confirm", "sample:update_basic", "sample:update_location",
  "sample:correct_finance", "sample:dispose_request", "sample:dispose_approve", "sample:loss_close",
  "sample:archive",
]);
export type SampleCapability = z.infer<typeof SampleCapabilitySchema>;

export const SampleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  view: z.enum(["borrowed", "in_stock", "managed", "pending", "disposed"]).default("borrowed"),
  search: z.string().trim().max(100).default(""),
  purchaseYear: z.coerce.number().int().min(1900).max(9999).optional(),
  holderUserId: z.string().uuid().optional(),
  brand: z.string().trim().max(100).optional(),
  department: z.string().trim().max(100).optional(),
}).strict();

export const SampleBasicSchema = z.object({
  sampleId: z.string().uuid(), sampleCode: z.string().min(1),
  status: SampleStatusSchema, version: z.number().int().positive(),
  brand: z.string(), styleName: z.string(), styleNo: z.string(), category: z.string(),
  color: z.string(), size: z.string(), department: z.string(), purchaseDate: z.string(),
  purchaserUserId: z.string().uuid(), purchaserName: z.string(),
  holderUserId: z.string().uuid().nullable(), holderName: z.string().nullable(),
  purpose: z.string().nullable(), borrowedAt: z.string().nullable(),
  storageLocation: z.string().nullable(), remark: z.string(),
  createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type SampleBasic = z.infer<typeof SampleBasicSchema>;
export const SampleFinanceSchema = z.object({
  purchasePrice: SampleMoneySchema,
  receiptAttachmentIds: z.array(z.string().uuid()),
}).strict();
export const SampleViewSchema = SampleBasicSchema.extend({ finance: SampleFinanceSchema.optional() }).strict();
export type SampleView = z.infer<typeof SampleViewSchema>;
export const SAMPLE_PAGE_SIZE = 15;

// A deliberate allowlist: adding fields to a database row cannot leak them to basic readers.
export function projectSampleView(input: unknown, viewFinance: boolean): SampleView {
  const basic = SampleBasicSchema.strip().parse(input);
  if (!viewFinance) return basic;
  const finance = z.object({ finance: SampleFinanceSchema }).parse(input).finance;
  return { ...basic, finance };
}
