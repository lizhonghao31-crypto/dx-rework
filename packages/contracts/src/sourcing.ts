import { z } from "zod";

const IdSchema = z.string().uuid();
const ShortTextSchema = z.string().trim().min(1).max(100);
const SourcingProcessSchema = z.string().trim().min(1, "工艺不能为空").max(100);
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

export const MAX_SOURCING_ATTACHMENTS = 8;
export const MAX_SOURCING_PROCESSES = 20;
export const SOURCING_IMAGE_SUPPLEMENT_ROLES = [
  "order_merchandiser",
  "ie_reviewer",
  "production_management",
  "owner_group",
  "factory_payables",
] as const;

export const CreateSourcingCaseSchema = z.object({
  erpOrderNo: ShortTextSchema,
  styleNo: ShortTextSchema,
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "交货日期格式无效"),
  processes: z.array(SourcingProcessSchema).min(1).max(MAX_SOURCING_PROCESSES)
    .refine((items) => new Set(items).size === items.length, "工艺不能重复")
    .optional(),
  processDescription: z.string().trim().min(1).max(500).optional(),
  orderQuantity: z.number().int().positive().max(10_000_000),
  attachmentIds: z.array(IdSchema).max(MAX_SOURCING_ATTACHMENTS)
    .refine((ids) => new Set(ids).size === ids.length, "订单图片不能重复")
    .optional(),
}).strict().superRefine((value, context) => {
  if (!value.processes?.length && !value.processDescription) {
    context.addIssue({ code: "custom", path: ["processes"], message: "请至少填写一项工艺" });
  }
  if (value.processes?.length && value.processDescription) {
    context.addIssue({
      code: "custom",
      path: ["processes"],
      message: "工艺清单与旧工艺字段不能同时提交",
    });
  }
});

export const CreateSourcingIeQuoteSchema = z.object({
  unitPrice: MoneyInputSchema,
  quoteReason: z.string().trim().max(500).optional(),
}).strict();

export const RecordSourcingManagementDecisionSchema = z.object({
  supplierId: IdSchema,
  unitPrice: MoneyInputSchema,
  decisionReason: z.string().trim().max(500).optional(),
}).strict();

export const DecideSourcingOwnerSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    decisionReason: z.string().trim().max(500).optional(),
  }).strict(),
  z.object({
    decision: z.literal("rejected"),
    decisionReason: z.string().trim().min(1, "驳回原因不能为空").max(500),
  }).strict(),
]);

export const RecordSourcingContractSchema = z.object({
  contractReference: z.string().trim().min(1).max(200),
  signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "合同日期格式无效"),
  executionReason: z.string().trim().max(500).optional(),
}).strict();

export const RequestSourcingFactoryChangeSchema = z.object({
  supplierId: IdSchema,
  unitPrice: MoneyInputSchema,
  changeReason: z.string().trim().min(1, "换厂原因不能为空").max(500),
}).strict();

export const DecideSourcingFactoryChangeSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  verificationReason: z.string().trim().min(1, "核实说明不能为空").max(500),
}).strict();

export const SourcingFactoryChangeStateSchema = z.object({
  factoryChangeRequestId: IdSchema,
  fromDecisionId: IdSchema,
  initiatorRole: z.enum(["order_merchandiser", "production_management", "owner_group"]),
  proposedSupplierId: IdSchema,
  proposedSupplierName: z.string(),
  proposedUnitPrice: z.string(),
  proposedQuantity: z.number().int().positive(),
  proposedTotalAmount: z.string(),
  changeReason: z.string(),
  requiresOwnerApproval: z.boolean(),
  status: z.enum(["pending_management", "pending_owner", "effective", "rejected"]),
  requestedBy: IdSchema,
  requestedAt: z.string().datetime(),
}).strict();

export const SourcingFactoryChangeStateResponseSchema = z.object({
  item: SourcingFactoryChangeStateSchema.nullable(),
}).strict();

export const RecordSourcingFinanceReconciliationSchema = z.object({
  result: z.enum(["match", "difference"]),
  differenceFields: z.array(z.enum(["supplier", "unit_price", "quantity", "total_amount"])).max(4).optional(),
  differenceReason: z.string().trim().max(500).optional(),
}).strict().superRefine((input, context) => {
  if (input.result === "difference" && !input.differenceFields?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["differenceFields"], message: "请选择发现差异的项目" });
  }
  if (input.result === "difference" && !input.differenceReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["differenceReason"], message: "发现差异时必须填写说明" });
  }
  if (input.result === "match" && (input.differenceFields?.length || input.differenceReason)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "一致确认不能提交差异信息" });
  }
});

export const DecideSourcingExceptionSchema = z.object({
  resolution: z.enum(["close", "reconcile_again"]),
  resolutionReason: z.string().trim().min(1, "差异处理说明不能为空").max(500),
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

export const SourcingFactorySchema = z.object({
  supplierId: IdSchema,
  supplierCode: z.string(),
  supplierName: z.string(),
}).strict();

export const SourcingFactoryListResponseSchema = z.object({
  items: z.array(SourcingFactorySchema),
}).strict();

export const SourcingDecisionSchema = z.object({
  sourcingDecisionId: IdSchema,
  decisionVersion: z.number().int().positive(),
  sourceType: z.enum(["initial", "management_revision", "factory_change"]),
  sourceIeQuoteId: IdSchema.nullable(),
  supersedesDecisionId: IdSchema.nullable(),
  supplierId: IdSchema,
  supplierCode: z.string(),
  supplierName: z.string(),
  unitPrice: z.string(),
  quantity: z.number().int().positive(),
  totalAmount: z.string(),
  decisionReason: z.string(),
  decidedBy: IdSchema,
  decidedAt: z.string().datetime(),
}).strict();

export const SourcingOwnerDecisionSchema = z.object({
  sourcingOwnerDecisionId: IdSchema,
  sourcingDecisionId: IdSchema,
  decision: z.enum(["approved", "rejected"]),
  decisionReason: z.string(),
  decidedBy: IdSchema,
  decidedAt: z.string().datetime(),
}).strict();

export const SourcingCaseSummarySchema = z.object({
  sourcingCaseId: IdSchema,
  erpOrderId: z.string(),
  erpOrderNo: z.string(),
  styleNo: z.string(),
  laneKey: z.literal("garment_processing"),
  orderQuantity: z.number().int().positive(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  processDescription: z.string().nullable(),
  processes: z.array(z.string()).max(MAX_SOURCING_PROCESSES),
  status: SourcingCaseStatusSchema,
  version: z.number().int().positive(),
  createdBy: IdSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  ieQuote: SourcingIeQuoteSchema.nullable(),
  decision: SourcingDecisionSchema.nullable(),
  ownerDecision: SourcingOwnerDecisionSchema.nullable(),
}).strict();

export const SourcingCaseListResponseSchema = z.object({
  items: z.array(SourcingCaseSummarySchema),
}).strict();

export const DeleteSourcingCaseResponseSchema = z.object({
  sourcingCaseId: IdSchema,
  deleted: z.literal(true),
}).strict();

export const SourcingAttachmentSchema = z.object({
  attachmentId: IdSchema,
  filename: z.string(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
}).strict();

export const SourcingAttachmentListResponseSchema = z.object({
  items: z.array(SourcingAttachmentSchema),
}).strict();

export const SupplementSourcingImagesSchema = z.object({
  attachmentIds: z.array(IdSchema).min(1).max(MAX_SOURCING_ATTACHMENTS)
    .refine((ids) => new Set(ids).size === ids.length, "订单图片不能重复"),
}).strict();

export const SourcingTimelineEntrySchema = z.object({
  entryId: IdSchema,
  kind: z.enum([
    "created",
    "ie_quote",
    "management_decision",
    "owner_decision",
    "contract",
    "factory_change_request",
    "factory_change_verification",
    "finance_reconciliation",
    "exception_verification",
  ]),
  version: z.number().int().positive(),
  handledBy: z.string(),
  handledAt: z.string().datetime(),
  reason: z.string(),
  unitPrice: z.string().nullable(),
  totalAmount: z.string().nullable(),
  supplierName: z.string().nullable(),
  decision: z.enum(["approved", "rejected"]).nullable(),
  contractReference: z.string().nullable(),
  signedOn: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
  differenceFields: z.array(z.enum(["supplier", "unit_price", "quantity", "total_amount"])),
  result: z.enum(["match", "difference"]).nullable(),
  resolution: z.enum(["close", "reconcile_again"]).nullable(),
}).strict();

export const SourcingTimelineResponseSchema = z.object({
  items: z.array(SourcingTimelineEntrySchema),
}).strict();

export type CreateSourcingCase = z.infer<typeof CreateSourcingCaseSchema>;
export type CreateSourcingIeQuote = z.infer<typeof CreateSourcingIeQuoteSchema>;
export type RecordSourcingContract = z.infer<typeof RecordSourcingContractSchema>;
export type RequestSourcingFactoryChange = z.infer<typeof RequestSourcingFactoryChangeSchema>;
export type DecideSourcingFactoryChange = z.infer<typeof DecideSourcingFactoryChangeSchema>;
export type SourcingFactoryChangeState = z.infer<typeof SourcingFactoryChangeStateSchema>;
export type SourcingFactoryChangeStateResponse = z.infer<typeof SourcingFactoryChangeStateResponseSchema>;
export type RecordSourcingFinanceReconciliation = z.infer<
  typeof RecordSourcingFinanceReconciliationSchema
>;
export type DecideSourcingException = z.infer<typeof DecideSourcingExceptionSchema>;
export type RecordSourcingManagementDecision = z.infer<
  typeof RecordSourcingManagementDecisionSchema
>;
export type DecideSourcingOwner = z.infer<typeof DecideSourcingOwnerSchema>;
export type SourcingFactory = z.infer<typeof SourcingFactorySchema>;
export type SourcingFactoryListResponse = z.infer<typeof SourcingFactoryListResponseSchema>;
export type SourcingDecision = z.infer<typeof SourcingDecisionSchema>;
export type SourcingOwnerDecision = z.infer<typeof SourcingOwnerDecisionSchema>;
export type SourcingCaseStatus = z.infer<typeof SourcingCaseStatusSchema>;
export type SourcingIeQuote = z.infer<typeof SourcingIeQuoteSchema>;
export type SourcingCaseSummary = z.infer<typeof SourcingCaseSummarySchema>;
export type SourcingCaseListResponse = z.infer<typeof SourcingCaseListResponseSchema>;
export type DeleteSourcingCaseResponse = z.infer<typeof DeleteSourcingCaseResponseSchema>;
export type SourcingAttachment = z.infer<typeof SourcingAttachmentSchema>;
export type SourcingAttachmentListResponse = z.infer<typeof SourcingAttachmentListResponseSchema>;
export type SupplementSourcingImages = z.infer<typeof SupplementSourcingImagesSchema>;
export type SourcingTimelineEntry = z.infer<typeof SourcingTimelineEntrySchema>;
export type SourcingTimelineResponse = z.infer<typeof SourcingTimelineResponseSchema>;
