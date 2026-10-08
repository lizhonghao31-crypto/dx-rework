import { z } from "zod";
import { duplicateSourcingLineMessage } from "./sourcing-style-identity.js";

const IdSchema = z.string().uuid();
const ShortTextSchema = z.string().trim().min(1).max(100);
const MoneyInputSchema = z.string().trim().regex(
  /^\d{1,10}(?:\.\d{1,4})?$/,
  "加工单价必须是大于0且最多4位小数的数字",
).refine((value) => Number(value) > 0, "加工单价必须大于0");
// New ordinary quotations use at most two effective decimal places. Keep the
// legacy four-place schema/calculators for history and deferred factory changes.
export const SourcingNewUnitPriceSchema = z.string().trim().regex(
  /^\d{1,10}(?:\.\d{1,4})?$/,
  "新报价必须大于0且最多2位有效小数",
).refine((value) => Number(value) > 0, "新报价必须大于0").refine(
  (value) => !/[1-9]/.test((value.split(".")[1] ?? "").slice(2)),
  "新报价最多2位有效小数，请核对后重新填写",
);
const BusinessDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式无效")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "日期必须是真实的日历日期");
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

export const calculateSourcingLinesTotalExact = (
  lines: readonly Readonly<{ unitPrice: string; quantity: number }>[],
): string => {
  if (!lines.length || lines.length > 20) {
    throw new RangeError("逐款价格必须包含1至20行");
  }
  const cents = lines.reduce((sum, line) => {
    const amount = calculateSourcingTotalExact(line.unitPrice, line.quantity);
    const [whole, fraction] = amount.split(".");
    return sum + BigInt(whole!) * 100n + BigInt(fraction!);
  }, 0n);
  if (cents <= 0n || cents > MAX_TOTAL_CENTS) {
    throw new RangeError("逐款报价总额超出系统允许范围");
  }
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

export const SourcingCaseStatusSchema = z.enum([
  "pending_merchandiser_correction",
  "pending_ie_quote",
  "pending_management_decision",
  "pending_owner_approval",
  "pending_contract",
  "pending_finance_reconciliation",
  "pending_factory_change_verification",
  "pending_exception_verification",
  "closed",
]);

export const MAX_SOURCING_ATTACHMENTS = 20;
export const MAX_SOURCING_PROCESSES = 20;
export const MAX_SOURCING_LINE_ITEMS = 20;
export const SOURCING_IMAGE_SUPPLEMENT_ROLES = [
  "order_merchandiser",
  "ie_reviewer",
  "production_management",
  "owner_group",
  "factory_payables",
] as const;

export const SourcingCaseLineInputSchema = z.object({
  imageAttachmentId: IdSchema.optional(),
  styleNo: ShortTextSchema.optional(),
  alternateStyleNo: ShortTextSchema.optional(),
  color: ShortTextSchema,
  quantity: z.number().int().positive().max(10_000_000),
  // Accepted for old clients only; the service does not record a node-one quote.
  externalUnitPrice: SourcingNewUnitPriceSchema.optional(),
}).strict().refine(line => !!line.styleNo || !!line.alternateStyleNo, "正式款号与代用款号至少填写一个");

export const ReviseSourcingStylesSchema = z.object({
  confirmedDuplicateStyles: z.array(ShortTextSchema).max(40).optional(),
  expectedRevision: z.number().int().nonnegative(),
  lines: z.array(z.object({
    position: z.number().int().min(1).max(MAX_SOURCING_LINE_ITEMS),
    styleNo: ShortTextSchema.nullable(),
    alternateStyleNo: ShortTextSchema.nullable(),
  }).strict().refine(line => !!line.styleNo || !!line.alternateStyleNo, "正式款号与代用款号至少填写一个"))
    .min(1).max(MAX_SOURCING_LINE_ITEMS)
    .refine(lines => new Set(lines.map(line => line.position)).size === lines.length, "款色行不能重复"),
}).strict();
export type ReviseSourcingStyles = z.infer<typeof ReviseSourcingStylesSchema>;

export const calculateSourcingOrderQuantity = (
  lineItems: readonly Readonly<{ quantity: number }>[],
): number => {
  const total = lineItems.reduce((sum, line) => sum + line.quantity, 0);
  if (!Number.isSafeInteger(total) || total < 1 || total > 10_000_000) {
    throw new RangeError("订单总数量必须是1至10000000之间的整数");
  }
  return total;
};

const SourcingCaseInputSchema = z.object({
  confirmedDuplicateStyles: z.array(ShortTextSchema).max(40).optional(),
  gender: z.enum(["男装", "女装"]),
  styleName: ShortTextSchema,
  additionalMerchandiserUserId: IdSchema.optional(),
  estimatedCutPieceSendDate: BusinessDateSchema,
  deliveryDate: BusinessDateSchema,
  lineItems: z.array(SourcingCaseLineInputSchema).min(1).max(MAX_SOURCING_LINE_ITEMS)
    .superRefine((lines, context) => {
      const duplicate = duplicateSourcingLineMessage(lines);
      if (duplicate) context.addIssue({ code: z.ZodIssueCode.custom, message: duplicate });
      try {
        calculateSourcingOrderQuantity(lines);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "订单总数量无效",
        });
      }
    }),
  daxingUnitPrice: SourcingNewUnitPriceSchema,
  attachmentIds: z.array(IdSchema).min(1, "请至少上传一张订单图片").max(MAX_SOURCING_ATTACHMENTS)
    .refine((ids) => new Set(ids).size === ids.length, "订单图片不能重复"),
}).strict();
export const SOURCING_DATE_ORDER_ERROR = "预计裁片发出日期不能晚于要求交货日期";
export const sourcingDatesValid = (send: string | null, delivery: string | null): boolean => !send || !delivery || send <= delivery;
const validLineImages = (order: { lineItems: readonly { imageAttachmentId?: string | undefined }[]; attachmentIds: readonly string[] }) =>
  order.lineItems.every(line => !line.imageAttachmentId || order.attachmentIds.includes(line.imageAttachmentId));
export const CreateSourcingCaseSchema = SourcingCaseInputSchema
  .extend({ digitalBudget: z.object({ productionOrderId: IdSchema, budgetVersion: z.number().int().positive(), orderVersion: z.number().int().positive() }).strict().optional() })
  .refine(validLineImages, "款图必须包含在订单图片中")
  .refine(order => sourcingDatesValid(order.estimatedCutPieceSendDate, order.deliveryDate), { path: ["deliveryDate"], message: SOURCING_DATE_ORDER_ERROR });
export const ReturnSourcingCaseSchema = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(500) }).strict();
export const CorrectSourcingCaseSchema = SourcingCaseInputSchema.omit({ daxingUnitPrice: true, additionalMerchandiserUserId: true }).extend({
  expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(500),
}).strict().refine(validLineImages, "款图必须包含在订单图片中")
  .refine(order => sourcingDatesValid(order.estimatedCutPieceSendDate, order.deliveryDate), { path: ["deliveryDate"], message: SOURCING_DATE_ORDER_ERROR });
export type ReturnSourcingCase = z.infer<typeof ReturnSourcingCaseSchema>;
export type CorrectSourcingCase = z.infer<typeof CorrectSourcingCaseSchema>;


export const CorrectSourcingBudgetPriceSchema = z.object({
  daxingUnitPrice: SourcingNewUnitPriceSchema,
  reason: z.string().trim().min(1, "更正原因不能为空").max(500, "更正原因不能超过500个字符"),
}).strict();

export const SourcingLinePriceInputSchema = z.object({
  position: z.number().int().min(1).max(MAX_SOURCING_LINE_ITEMS),
  unitPrice: MoneyInputSchema,
}).strict();

export const SourcingLinePriceReviewSchema = z.object({
  linePrices: z.array(SourcingLinePriceInputSchema).min(1).max(MAX_SOURCING_LINE_ITEMS)
    .refine(
      (items) => new Set(items.map((item) => item.position)).size === items.length,
      "逐款价格行不能重复",
    ),
  reason: z.string().trim().max(500).optional(),
}).strict();

const NewSourcingLinePriceInputSchema = SourcingLinePriceInputSchema.extend({
  unitPrice: SourcingNewUnitPriceSchema,
});

export const CreateSourcingIeQuoteSchema = z.object({
  linePrices: z.array(NewSourcingLinePriceInputSchema).min(1).max(MAX_SOURCING_LINE_ITEMS)
    .refine(
      (items) => new Set(items.map((item) => item.position)).size === items.length,
      "逐款价格行不能重复",
    ).optional(),
  unitPrice: SourcingNewUnitPriceSchema.optional(),
  quoteReason: z.string().trim().max(500).optional(),
}).strict().superRefine((input, context) => {
  if ((input.linePrices ? 1 : 0) + (input.unitPrice ? 1 : 0) !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "请提交逐款价格" });
  }
}).transform((input) => ({
  linePrices: input.linePrices ?? [{ position: 1, unitPrice: input.unitPrice! }],
  quoteReason: input.quoteReason,
}));

export const SourcingCuttingProcessSchema = z.enum(["in_house", "outsourced", "other"]);

export const RecordSourcingManagementDecisionSchema = z.object({
  craftIds: z.array(IdSchema).min(1).max(MAX_SOURCING_PROCESSES)
    .refine((ids) => new Set(ids).size === ids.length, "工艺及承包范围不能重复"),
  supplierId: IdSchema,
  cuttingProcess: SourcingCuttingProcessSchema.optional(),
  cuttingProcessOther: z.string().trim().min(1).max(100).optional(),
  linePrices: z.array(NewSourcingLinePriceInputSchema).min(1).max(MAX_SOURCING_LINE_ITEMS)
    .refine(
      (items) => new Set(items.map((item) => item.position)).size === items.length,
      "逐款价格行不能重复",
    ).optional(),
  unitPrice: SourcingNewUnitPriceSchema.optional(),
  decisionReason: z.string().trim().max(500).optional(),
}).strict().superRefine((input, context) => {
  if (input.cuttingProcess === "other" && !input.cuttingProcessOther) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cuttingProcessOther"], message: "请填写其它裁床工序" });
  }
  if (input.cuttingProcess !== "other" && input.cuttingProcessOther) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cuttingProcessOther"], message: "仅其它裁床工序可填写说明" });
  }
  if ((input.linePrices ? 1 : 0) + (input.unitPrice ? 1 : 0) !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "请提交逐款价格" });
  }
}).transform((input) => ({
  supplierId: input.supplierId,
  cuttingProcess: input.cuttingProcess,
  cuttingProcessOther: input.cuttingProcessOther,
  craftIds: input.craftIds,
  linePrices: input.linePrices ?? [{ position: 1, unitPrice: input.unitPrice! }],
  decisionReason: input.decisionReason,
}));

export const DecideSourcingOwnerSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    decisionReason: z.string().trim().max(500).optional(),
  }).strict(),
  z.object({
    decision: z.literal("rejected"),
    decisionReason: z.string().trim().max(500).optional(),
  }).strict(),
]);

export const SourcingContractMissingFieldSchema = z.enum([
  "address",
  "contractEntityName",
  "partyBRepresentative",
  "payeeName",
  "bankAccount",
  "bankName",
]);

export const SupplementSourcingContractSchema = z.object({
  address: z.string().trim().min(1).max(300).optional(),
  contractEntityName: z.string().trim().min(1).max(300).optional(),
  partyBRepresentative: z.string().trim().min(1).max(300).optional(),
  payeeName: z.string().trim().min(1).max(300).optional(),
  bankAccount: z.string().trim().min(1).max(300).optional(),
  bankName: z.string().trim().min(1).max(300).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, "请填写至少一项合同补充资料");

export const SourcingContractDocumentSchema = z.object({
  sourcingContractDocumentId: IdSchema,
  sourcingApprovalSnapshotId: IdSchema,
  contractNumber: z.string(),
  contractVersion: z.number().int().positive(),
  templateVersion: z.number().int().positive(),
  status: z.enum([
    "pending_supplement",
    "generation_pending",
    "generating",
    "ready",
    "generation_failed",
  ]),
  missingFields: z.array(SourcingContractMissingFieldSchema),
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  pdfAttachmentId: IdSchema.nullable(),
  pdfSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  failureReason: z.string().nullable(),
  preparedAt: z.string().datetime(),
  generatedAt: z.string().datetime().nullable(),
  canSupplement: z.boolean(),
  canRefreshInformation: z.boolean().optional(),
  canEditContent: z.boolean().optional(),
}).strict();

export const SourcingContractStateResponseSchema = z.object({
  item: SourcingContractDocumentSchema.nullable(),
}).strict();

export const SourcingContractReturnUploadSchema = z.object({
  attachmentIds: z.array(IdSchema).min(1).max(2).refine(ids=>new Set(ids).size===ids.length),
}).strict();
export const SourcingContractReturnResponseSchema = z.object({
  contractReturnMonitoring: z.boolean(),
  contractReturnStatus: z.enum(["pending","returned_on_time","overdue_pending","returned_late"]).nullable(),
  contractGeneratedAt: z.string().datetime().nullable(),
  contractReturnDueAt: z.string().datetime().nullable(),
  contractReturnedAt: z.string().datetime().nullable(),
  contractReturnOverdueHours: z.number().int().nonnegative().nullable(),
  uploadedByName: z.string().nullable(),
  canUpload: z.boolean(),
  uploadedFileCount: z.number().int().nonnegative().optional(),
  uploadedTotalBytes: z.number().int().nonnegative().optional(),
  currentContractReturned: z.boolean().default(false),
  currentContractDocumentId: IdSchema.nullable().default(null),
  signedContractDocumentId: IdSchema.nullable().default(null),
  signedContractVersion: z.number().int().positive().nullable().default(null),
  signedContractNumber: z.string().nullable().default(null),
  attachments: z.array(z.object({
    attachmentId: IdSchema,filename: z.string(),
    mimeType: z.enum(["application/pdf","image/jpeg","image/png"]),
    sizeBytes: z.number().int().positive(),
  }).strict()),
  history: z.array(z.object({
    revision: z.number().int().positive(),
    submittedAt: z.string().datetime(),
    uploadedByName: z.string(),
    signedContractDocumentId: IdSchema.nullable().default(null),
    signedContractVersion: z.number().int().positive().nullable().default(null),
    signedContractNumber: z.string().nullable().default(null),
    attachments: z.array(z.object({
      attachmentId: IdSchema,filename: z.string(),
      mimeType: z.enum(["application/pdf","image/jpeg","image/png"]),
      sizeBytes: z.number().int().positive(),
    }).strict()).min(1).max(10),
  }).strict()).default([]),
}).strict();
export type SourcingContractReturnResponse = z.infer<typeof SourcingContractReturnResponseSchema>;

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
  remainingLines:z.array(z.object({position:z.number().int().positive(),plannedQuantity:z.number().int().nonnegative(),completedQuantity:z.number().int().nonnegative(),quantity:z.number().int().nonnegative()}).strict()).optional(),
}).strict();

export const RecordSourcingFinanceReconciliationSchema = z.object({
  factoryDecisionId:z.string().uuid().optional(),
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
  linePrices: z.array(z.object({
    position: z.number().int().min(1).max(MAX_SOURCING_LINE_ITEMS),
    quantity: z.number().int().positive(),
    unitPrice: z.string(),
    totalAmount: z.string(),
  }).strict()).min(1).max(MAX_SOURCING_LINE_ITEMS).default([]),
  quoteReason: z.string(),
  quotedBy: IdSchema,
  quotedAt: z.string().datetime(),
}).strict();

export const SourcingFactorySchema = z.object({
  supplierId: IdSchema,
  supplierCode: z.string(),
  supplierName: z.string(),
  supportedCrafts: z.array(z.string()).default([]),
  dailyCapacity: z.number().int().positive().nullable().default(null),
  notes: z.string().default(""),
  contractDataMissing: z.array(z.enum([
    "address",
    "contractEntityName",
    "partyBRepresentative",
    "payeeName",
    "bankAccount",
    "bankName",
  ])).default([]),
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
  linePrices: z.array(z.object({
    position: z.number().int().min(1).max(MAX_SOURCING_LINE_ITEMS),
    quantity: z.number().int().positive(),
    unitPrice: z.string(),
    totalAmount: z.string(),
  }).strict()).min(1).max(MAX_SOURCING_LINE_ITEMS).default([]),
  cuttingProcess: SourcingCuttingProcessSchema.nullable().optional(),
  cuttingProcessOther: z.string().nullable().optional(),
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

export const SourcingApprovalSnapshotSchema = z.object({
  gender: z.enum(["男装", "女装"]).nullable().default(null),
  styleName: z.string().nullable().default(null),
  sourcingApprovalSnapshotId: IdSchema,
  sourcingDecisionId: IdSchema,
  decisionVersion: z.number().int().positive(),
  supplierId: IdSchema,
  supplierCode: z.string(),
  supplierName: z.string(),
  quantity: z.number().int().positive(),
  totalAmount: z.string(),
  daxingUnitPrice: z.string().optional(),
  estimatedCutPieceSendDate: BusinessDateSchema.nullable(),
  deliveryDate: BusinessDateSchema.nullable(),
  processes: z.array(z.string()),
  linePrices: z.array(z.object({
    position: z.number().int().min(1).max(MAX_SOURCING_LINE_ITEMS),
    styleNo: z.string(),
    alternateStyleNo: z.string().nullable(),
    color: z.string().nullable(),
    quantity: z.number().int().positive(),
    unitPrice: z.string(),
    totalAmount: z.string(),
  }).strict()).min(1).max(MAX_SOURCING_LINE_ITEMS),
  approvedBy: IdSchema,
  approvedAt: z.string().datetime(),
}).strict();

export const SourcingCraftSnapshotSchema = z.object({
  position: z.number().int().min(1).max(MAX_SOURCING_PROCESSES),
  craftId: IdSchema,
  craftCode: z.string(),
  craftVersion: z.number().int().positive(),
  craftName: z.string(),
}).strict();

export const SourcingCaseLineSchema = z.object({
  imageAttachmentId: IdSchema.nullable().optional(),
  formalStyleNo: z.string().nullable().optional(),
  position: z.number().int().min(1).max(MAX_SOURCING_LINE_ITEMS),
  styleNo: z.string(),
  alternateStyleNo: z.string().nullable(),
  color: z.string().nullable(),
  quantity: z.number().int().positive(),
  externalUnitPrice: z.string().nullable(),
  legacy: z.boolean(),
}).strict();

export const SourcingCaseSummarySchema = z.object({
  identityRevision: z.number().int().nonnegative().optional(),
  gender: z.enum(["男装", "女装"]).nullable().default(null),
  styleName: z.string().nullable().default(null),
  sourcingCaseId: IdSchema,
  erpOrderId: z.string(),
  erpOrderNo: z.string(),
  styleNo: z.string(),
  laneKey: z.literal("garment_processing"),
  orderQuantity: z.number().int().positive(),
  lineItems: z.array(SourcingCaseLineSchema).min(1).max(MAX_SOURCING_LINE_ITEMS),
  daxingUnitPrice: z.string().optional(),
  estimatedCutPieceSendDate: BusinessDateSchema.nullable(),
  deliveryDate: BusinessDateSchema.nullable(),
  processDescription: z.string().nullable(),
  processes: z.array(z.string()).max(MAX_SOURCING_PROCESSES),
  crafts: z.array(SourcingCraftSnapshotSchema).max(MAX_SOURCING_PROCESSES).optional(),
  status: SourcingCaseStatusSchema,
  version: z.number().int().positive(),
  createdBy: IdSchema,
  merchandiserName: z.string().nullable().optional(),
  firstImageAttachmentId: IdSchema.nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  ieQuote: SourcingIeQuoteSchema.nullable(),
  decision: SourcingDecisionSchema.nullable(),
  ownerDecision: SourcingOwnerDecisionSchema.nullable(),
  approvalSnapshot: SourcingApprovalSnapshotSchema.nullable().default(null),
  contractReturnMonitoring: z.boolean().optional(),
  contractReturnStatus: z.enum(["pending","returned_on_time","overdue_pending","returned_late"]).nullable().optional(),
  contractGeneratedAt: z.string().datetime().nullable().optional(),
  contractReturnDueAt: z.string().datetime().nullable().optional(),
  contractReturnedAt: z.string().datetime().nullable().optional(),
  contractReturnOverdueHours: z.number().int().nonnegative().nullable().optional(),
  correctionReason: z.string().nullable().optional(),
  timing: z.object({totalSeconds:z.number().nonnegative(),nodeSeconds:z.record(z.string(),z.number().nonnegative())}).optional(),
}).strict();

export const SourcingMerchandiserOptionsSchema = z.array(z.object({
  userId: IdSchema, displayName: ShortTextSchema,
}).strict());

export const SourcingStyleCatalogSchema = z.array(z.object({
  styleId: IdSchema, styleName: ShortTextSchema,
}).strict()).max(50);

export const SourcingCaseListResponseSchema = z.object({
  items: z.array(SourcingCaseSummarySchema).max(15),
  page: z.number().int().positive(),
  pageSize: z.literal(15),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
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
  pdfAttachmentId: IdSchema.nullable().optional(),
  entryId: IdSchema,
  kind: z.enum([
    "created",
    "style_revision",
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

export type SourcingLinePriceInput = z.infer<typeof SourcingLinePriceInputSchema>;
export type SourcingLinePriceReview = z.infer<typeof SourcingLinePriceReviewSchema>;
export type SourcingCaseLineInput = z.infer<typeof SourcingCaseLineInputSchema>;
export type SourcingCaseLine = z.infer<typeof SourcingCaseLineSchema>;
export type CreateSourcingCase = z.infer<typeof CreateSourcingCaseSchema>;
export type CorrectSourcingBudgetPrice = z.infer<typeof CorrectSourcingBudgetPriceSchema>;
export type CreateSourcingIeQuote = z.input<typeof CreateSourcingIeQuoteSchema>;
export type RecordSourcingContract = z.infer<typeof RecordSourcingContractSchema>;
export type RequestSourcingFactoryChange = z.infer<typeof RequestSourcingFactoryChangeSchema>;
export type DecideSourcingFactoryChange = z.infer<typeof DecideSourcingFactoryChangeSchema>;
export type SourcingFactoryChangeState = z.infer<typeof SourcingFactoryChangeStateSchema>;
export type SourcingFactoryChangeStateResponse = z.infer<typeof SourcingFactoryChangeStateResponseSchema>;
export type RecordSourcingFinanceReconciliation = z.infer<
  typeof RecordSourcingFinanceReconciliationSchema
>;
export type DecideSourcingException = z.infer<typeof DecideSourcingExceptionSchema>;
export type RecordSourcingManagementDecision = z.input<
  typeof RecordSourcingManagementDecisionSchema
>;
export type DecideSourcingOwner = z.infer<typeof DecideSourcingOwnerSchema>;
export type SourcingContractMissingField = z.infer<typeof SourcingContractMissingFieldSchema>;
export type SupplementSourcingContract = z.infer<typeof SupplementSourcingContractSchema>;
export type SourcingContractDocument = z.infer<typeof SourcingContractDocumentSchema>;
export type SourcingContractStateResponse = z.infer<typeof SourcingContractStateResponseSchema>;
export type SourcingFactory = z.infer<typeof SourcingFactorySchema>;
export type SourcingFactoryListResponse = z.infer<typeof SourcingFactoryListResponseSchema>;
export type SourcingDecision = z.infer<typeof SourcingDecisionSchema>;
export type SourcingOwnerDecision = z.infer<typeof SourcingOwnerDecisionSchema>;
export type SourcingApprovalSnapshot = z.infer<typeof SourcingApprovalSnapshotSchema>;
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

// Historical node pages are read-only projections of persisted business facts.
export const SourcingHistoryNodeSchema = z.enum(["created", "ie_quote", "management", "owner", "finance"]);
export const SourcingNodeHistorySchema = z.object({
  item: SourcingCaseSummarySchema,
  node: SourcingHistoryNodeSchema,
  entry: SourcingTimelineEntrySchema,
  versions: z.array(SourcingTimelineEntrySchema),
  relatedEntries: z.array(SourcingTimelineEntrySchema),
  attachments: SourcingAttachmentListResponseSchema.shape.items,
  notices: z.array(z.string()),
  contractReference: z.string().nullable(),
}).strict();
export type SourcingHistoryNode = z.infer<typeof SourcingHistoryNodeSchema>;
export type SourcingNodeHistory = z.infer<typeof SourcingNodeHistorySchema>;

/** Sum actual visits; never change entry timestamps to disguise accumulated time. */
export function cumulativeSourcingTiming(history: readonly {
  to: string | null; changesNode: boolean; enteredAt: string | null; leftAt: string | null;
}[], createdAt: string | null, asOf: string): { totalSeconds: number; nodeSeconds: Record<string, number> } {
  const nodeSeconds: Record<string, number> = {};
  const now = Date.parse(asOf);
  const terminal = history.find(event => event.changesNode && event.to === "closed" && event.enteredAt);
  const end = terminal?.enteredAt ? Math.min(now, Date.parse(terminal.enteredAt)) : now;
  for (const event of history) {
    if (!event.changesNode || !event.to || event.to === "closed" || !event.enteredAt) continue;
    const start = Date.parse(event.enteredAt);
    const left = event.leftAt ? Math.min(end, Date.parse(event.leftAt)) : end;
    if (Number.isFinite(start) && Number.isFinite(left)) nodeSeconds[event.to] = (nodeSeconds[event.to] ?? 0) + Math.max(0,(left-start)/1000);
  }
  const start = createdAt ? Date.parse(createdAt) : Number.NaN;
  return {totalSeconds: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0,(end-start)/1000) : 0,nodeSeconds};
}

export const FactorySettlementsSchema=z.object({items:z.array(z.object({decisionId:z.string().uuid(),supplierName:z.string(),quantity:z.number().int().positive(),totalAmount:z.string(),contractNumber:z.string(),pdfAttachmentId:z.string().uuid().nullable(),result:z.enum(['match','difference']).nullable()}).strict())}).strict();
