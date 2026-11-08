import {QueuePageResponseFields} from './queue-page.js';
import { validationFieldLabel } from "./validation-language.js";
import { z } from "zod";

const IdSchema = z.string().uuid();
const ReasonSchema = z.string().trim().min(1).max(500);
const MoneyStringSchema = z.string()
  .regex(/^-?\d+(?:\.\d{1,2})?$/, "金额须填写两位小数");
const AttachmentIdsSchema = z.array(IdSchema).max(50).default([])
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({
        code: "custom",
        message: "附件不能重复选择",
      });
    }
  });
const UniqueIdsSchema = z.array(IdSchema).min(1).max(100)
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({
        code: "custom",
        message: "关联记录不能重复",
      });
    }
  });

export const ExternalResponsibilityTypeSchema = z.enum([
  "processing_factory",
  "embroidery_factory",
  "washing_factory",
  "fabric_supplier",
]);
const FullResponsibilityTypeSchema = z.enum([
  "own_factory",
  "processing_factory",
  "embroidery_factory",
  "washing_factory",
  "fabric_supplier",
]);
export const ExternalResponsibilityCaseStatusSchema = z.enum([
  "pending_business_signoff",
  "pending_payables_confirmation",
  "deduction_follow_up",
  "pending_special_approval",
  "returned",
  "pending_responsibility_revision",
  "closed",
  "superseded",
]);

export const ExternalResponsibilityBatchParamsSchema = z.object({
  batchId: IdSchema,
}).strict();
export const ExternalResponsibilityCaseParamsSchema = z.object({
  caseId: IdSchema,
}).strict();
export const ExternalResponsibilityRevisionParamsSchema = z.object({
  requestId: IdSchema,
}).strict();
export const ExternalResponsibilityOrderParamsSchema = z.object({
  reworkOrderId: IdSchema,
}).strict();

export const CreateExternalTemporarySupplierSchema = z.object({
  supplierType: z.enum(["factory", "embroidery_washing", "fabric"]),
  supplierName: z.string().trim().min(1).max(200),
}).strict();

export const AllocateExternalSuppliersSchema = z.object({
  expectedBatchVersion: z.number().int().positive(),
  allocations: z.array(z.object({
    responsibilityType: ExternalResponsibilityTypeSchema,
    supplierId: IdSchema,
    externalItemIds: UniqueIdsSchema,
    processingFactoryOverrideReason: ReasonSchema.optional(),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  const all = value.allocations.flatMap((item) => item.externalItemIds);
  if (new Set(all).size !== all.length) {
    context.addIssue({
      code: "custom",
      path: ["allocations"],
      message: `${validationFieldLabel(["allocations"])}：同一外部责任明细只能分派一次`,
    });
  }
});

export const SubmitExternalResponsibilityCaseSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  remark: ReasonSchema.optional(),
  attachmentIds: AttachmentIdsSchema,
}).strict();
export const PayablesAcceptExternalResponsibilityCaseSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
}).strict();
export const PayablesReturnExternalResponsibilityCaseSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  reason: ReasonSchema,
  attachmentIds: AttachmentIdsSchema,
}).strict();
export const CreateExternalDeductionFollowUpSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  content: z.string().trim().min(1).max(2000),
  supplierFeedback: z.string().trim().min(1).max(2000).optional(),
  nextFollowUpAt: z.string().datetime().optional(),
  attachmentIds: AttachmentIdsSchema,
}).strict();
export const CreateExternalDeductionEntrySchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  entryType: z.enum(["deduction", "adjustment", "reversal"]),
  amount: MoneyStringSchema.refine(
    (value) => !/^-?0(?:\.0{1,2})?$/.test(value),
    "金额不能为0",
  ),
  deductedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  referenceNo: z.string().trim().min(1).max(200).optional(),
  attachmentIds: AttachmentIdsSchema,
  reversesEntryId: IdSchema.optional(),
  specialApprovalReason: ReasonSchema.optional(),
}).strict().superRefine((value, context) => {
  if (
    value.entryType === "deduction"
    && (value.reversesEntryId !== undefined || value.amount.startsWith("-"))
  ) {
    context.addIssue({
      code: "custom",
      path: ["reversesEntryId"],
      message: `${validationFieldLabel(["reversesEntryId"])}：新增扣款金额必须大于0`,
    });
  }
  if (value.entryType !== "deduction" && value.reversesEntryId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["reversesEntryId"],
      message: `${validationFieldLabel(["reversesEntryId"])}：调整或冲回必须关联原记录`,
    });
  }
});
export const CloseExternalDeductionCaseSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  result: z.enum(["full", "partial", "not_deducted"]),
  reason: ReasonSchema.optional(),
  evidenceAttachmentIds: AttachmentIdsSchema,
  remainingDifferenceDisposition: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (
    value.result === "full"
    && (
      value.reason !== undefined
      || value.evidenceAttachmentIds.length !== 0
      || value.remainingDifferenceDisposition !== undefined
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "全额扣款不能同时填写未扣凭证或剩余差额处理方式",
    });
  }
  if (
    value.result !== "full"
    && (
      value.reason === undefined
      || value.evidenceAttachmentIds.length === 0
      || value.remainingDifferenceDisposition === undefined
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "部分扣款或未扣款须填写原因、已就绪凭证及剩余差额处理方式",
    });
  }
});

export const RequestExternalDeductionSpecialApprovalSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  reason: ReasonSchema,
  attachmentIds: AttachmentIdsSchema,
  requestMode: z.enum(["proposed_entry", "existing_ledger"]).optional(),
  requestedAmount: MoneyStringSchema.refine(value => !value.startsWith("-") && !/^0+(?:\.0{1,2})?$/.test(value), "申请金额必须大于零").optional(),
  deductedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.requestMode === "proposed_entry") {
    if (value.requestedAmount === undefined || value.deductedOn === undefined) context.addIssue({ code: "custom", message: "新金额特批必须提供金额与日期" });
  } else if (value.requestedAmount !== undefined || value.deductedOn !== undefined) {
    context.addIssue({ code: "custom", message: "既有台账特批不得夹带新金额" });
  }
});

export const ApproveExternalDeductionSpecialApprovalSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  expectedRequestVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

export const ReturnExternalDeductionSpecialApprovalSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  expectedRequestVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
}).strict();

const AllocationChangeSchema = z.object({
  responsibilityType: FullResponsibilityTypeSchema,
  shareBps: z.number().int().min(1).max(10_000),
}).strict();
const ProcessAllocationChangeSchema = z.object({
  configurationItemId: IdSchema,
  allocations: z.array(AllocationChangeSchema).min(1).max(5),
}).strict().superRefine((value, context) => {
  if (value.allocations.reduce((sum, item) => sum + item.shareBps, 0) !== 10_000) {
    context.addIssue({
      code: "custom",
      path: ["allocations"],
      message: `${validationFieldLabel(["allocations"])}：责任分摊比例合计必须为100%`,
    });
  }
  if (
    new Set(value.allocations.map((item) => item.responsibilityType)).size
    !== value.allocations.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["allocations"],
      message: `${validationFieldLabel(["allocations"])}：责任类型不能重复选择`,
    });
  }
});
export const ExternalResponsibilityRequestedChangeSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("responsibility_type"),
      configurationItemIds: UniqueIdsSchema,
      targetResponsibilityType: FullResponsibilityTypeSchema,
    }).strict(),
    z.object({
      kind: z.literal("multiplier"),
      configurationItemIds: UniqueIdsSchema,
      targetMultiplier: z.string()
        .regex(/^(?:[1-9]\d{0,4})(?:\.\d{1,3})?$/),
      highMultiplierReason: ReasonSchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal("allocation"),
      processChanges: z.array(ProcessAllocationChangeSchema).min(1).max(100),
    }).strict(),
    z.object({
      kind: z.literal("remaining_difference_to_own_factory"),
      configurationItemIds: UniqueIdsSchema,
    }).strict(),
    z.object({
      kind: z.literal("other"),
      configurationItemIds: UniqueIdsSchema,
      summary: z.string().trim().min(1).max(2000),
    }).strict(),
  ]);

export const CreateExternalResponsibilityRevisionSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  requestedChange: ExternalResponsibilityRequestedChangeSchema,
  reason: z.string().trim().min(1).max(2000),
  attachmentIds: AttachmentIdsSchema,
}).strict();
export const DecideExternalResponsibilityRevisionSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  expectedRevisionVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

const ExternalItemResponseSchema = z.object({
  externalItemId: IdSchema,
  configurationItemId: IdSchema,
  responsibilityType: ExternalResponsibilityTypeSchema,
  processSnapshot: z.record(z.string(), z.unknown()),
  multiplierSnapshot: z.string(),
  shareBpsSnapshot: z.number().int(),
  proposedAmount: z.string(),
  amountLineSnapshot: z.record(z.string(), z.unknown()),
}).strict();
const ExternalDeductionEntryResponseSchema = z.object({
  deductionEntryId: IdSchema,
  entryType: z.enum(["deduction", "adjustment", "reversal"]),
  amount: z.string(),
  deductedOn: z.string(),
  referenceNo: z.string().nullable(),
  attachmentIds: z.array(IdSchema),
  reversesEntryId: IdSchema.nullable(),
  recordedBy: IdSchema,
  createdAt: z.string().datetime(),
}).strict();
const ExternalRevisionResponseSchema = z.object({
  revisionRequestId: IdSchema,
  revisionVersion: z.number().int().positive(),
  status: z.enum(["pending", "approved", "rejected"]),
  reason: z.string(),
  requestedChange: ExternalResponsibilityRequestedChangeSchema,
  requestedBy: IdSchema,
  decidedBy: IdSchema.nullable(),
  decisionReason: z.string().nullable(),
  seededDeterminationId: IdSchema.nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
}).strict();

const ExternalSpecialApprovalResponseSchema = z.object({
    requestId: IdSchema,
    requestVersion: z.number().int().positive(),
    reason: z.string(),
    attachmentIds: z.array(IdSchema),
    proposedAmount: z.string(),
    actualDeductedAmount: z.string(),
    remainingAmount: z.string(),
    requestedBy: IdSchema,
    requestedAt: z.string().datetime(),
    requestMode: z.enum(["proposed_entry", "existing_ledger"]).optional(),
    requestedAmount: z.string().nullable().optional(),
    deductedOn: z.string().nullable().optional(),
    decision: z.object({
      decision: z.enum(["approved", "returned"]),
      reason: z.string().nullable(),
      decidedBy: IdSchema,
      decidedAt: z.string().datetime(),
    }).strict().nullable(),
  }).strict();

export const ExternalResponsibilityCaseResponseSchema = z.object({
  caseId: IdSchema,
  batchId: IdSchema,
  reworkOrderId: IdSchema,
  responsibilityType: ExternalResponsibilityTypeSchema,
  supplier: z.object({
    supplierId: IdSchema,
    version: z.number().int().positive(),
    code: z.string(),
    name: z.string(),
    type: z.enum(["factory", "embroidery_washing", "fabric"]),
  }).strict(),
  businessHandlerUserId: IdSchema,
  payablesHandlerRole: z.string(),
  proposedDeductionAmount: z.string(),
  actualDeductedAmount: z.string(),
  remainingAmount: z.string(),
  caseVersion: z.number().int().positive(),
  status: ExternalResponsibilityCaseStatusSchema,
  submittedAt: z.string().datetime().nullable(),
  payablesConfirmedAt: z.string().datetime().nullable(),
  canSign: z.boolean(),
  canPayablesConfirm: z.boolean(),
  canFollowUp: z.boolean(),
  canRecordDeduction: z.boolean(),
  canClose: z.boolean(),
  canRequestSpecialApproval: z.boolean(),
  canDecideSpecialApproval: z.boolean(),
  canRequestRevision: z.boolean(),
  canApproveRevision: z.boolean(),
  items: z.array(ExternalItemResponseSchema),
  deductions: z.array(ExternalDeductionEntryResponseSchema),
  evidenceAttachments: z.array(z.object({ attachmentId: IdSchema, filename: z.string(), mimeType: z.string() }).strict()).optional(),
  followUps: z.array(z.object({
    followUpId: IdSchema,
    content: z.string(),
    supplierFeedback: z.string().nullable(),
    nextFollowUpAt: z.string().datetime().nullable(),
    attachmentIds: z.array(IdSchema),
    createdBy: IdSchema,
    createdAt: z.string().datetime(),
  }).strict()),
  closure: z.object({
    result: z.enum(["full", "partial", "not_deducted", "over_deducted"]),
    proposedAmount: z.string(),
    actualDeductedAmount: z.string(),
    remainingAmount: z.string(),
    reason: z.string().nullable(),
    evidenceAttachmentIds: z.array(IdSchema),
    remainingDifferenceDisposition: z.string().nullable(),
    closedBy: IdSchema,
    closedAt: z.string().datetime(),
  }).strict().nullable(),
  specialApproval: ExternalSpecialApprovalResponseSchema.nullable(),
  specialApprovalHistory: z.array(ExternalSpecialApprovalResponseSchema).optional(),
  revisionRequests: z.array(ExternalRevisionResponseSchema),
}).strict();

export const ExternalResponsibilityBatchResponseSchema = z.object({
  batchId: IdSchema,
  reworkOrderId: IdSchema,
  finalizedDeterminationId: IdSchema,
  finalizedDeterminationVersion: z.number().int().positive(),
  batchVersion: z.number().int().positive(),
  status: z.enum(["active", "superseded"]),
  sourceSnapshot: z.record(z.string(), z.unknown()),
  items: z.array(ExternalItemResponseSchema),
  cases: z.array(ExternalResponsibilityCaseResponseSchema),
  historicalCases: z.array(ExternalResponsibilityCaseResponseSchema).optional(),
  canAllocateSuppliers: z.boolean().optional(),
}).strict().nullable();

export const ExternalResponsibilityQueueResponseSchema = z.object({
  items: z.array(z.object({
    caseId: IdSchema,
    reworkOrderId: IdSchema,
    reworkNo: z.string().nullable(),
    styleNo: z.string().nullable(),
    orderNo: z.string().nullable(),
    problemPart: z.string().nullable(),
    responsibilityType: ExternalResponsibilityTypeSchema,
    supplierName: z.string(),
    status: ExternalResponsibilityCaseStatusSchema,
    proposedDeductionAmount: z.string(),
    actualDeductedAmount: z.string(),
    remainingAmount: z.string(),
    caseVersion: z.number().int().positive(),
    overdue: z.boolean(),
    canAct: z.boolean(),
  }).strict()),
  ...QueuePageResponseFields,
}).strict();

export type CreateExternalTemporarySupplier =
  z.infer<typeof CreateExternalTemporarySupplierSchema>;
export type AllocateExternalSuppliers =
  z.infer<typeof AllocateExternalSuppliersSchema>;
export type SubmitExternalResponsibilityCase =
  z.infer<typeof SubmitExternalResponsibilityCaseSchema>;
export type PayablesAcceptExternalResponsibilityCase =
  z.infer<typeof PayablesAcceptExternalResponsibilityCaseSchema>;
export type PayablesReturnExternalResponsibilityCase =
  z.infer<typeof PayablesReturnExternalResponsibilityCaseSchema>;
export type CreateExternalDeductionFollowUp =
  z.infer<typeof CreateExternalDeductionFollowUpSchema>;
export type CreateExternalDeductionEntry =
  z.infer<typeof CreateExternalDeductionEntrySchema>;
export type CloseExternalDeductionCase =
  z.infer<typeof CloseExternalDeductionCaseSchema>;
export type RequestExternalDeductionSpecialApproval =
  z.infer<typeof RequestExternalDeductionSpecialApprovalSchema>;
export type ApproveExternalDeductionSpecialApproval =
  z.infer<typeof ApproveExternalDeductionSpecialApprovalSchema>;
export type ReturnExternalDeductionSpecialApproval =
  z.infer<typeof ReturnExternalDeductionSpecialApprovalSchema>;
export type CreateExternalResponsibilityRevision =
  z.infer<typeof CreateExternalResponsibilityRevisionSchema>;
export type DecideExternalResponsibilityRevision =
  z.infer<typeof DecideExternalResponsibilityRevisionSchema>;
export type ExternalResponsibilityRequestedChange =
  z.infer<typeof ExternalResponsibilityRequestedChangeSchema>;
export type ExternalResponsibilityCaseResponse =
  z.infer<typeof ExternalResponsibilityCaseResponseSchema>;
export type ExternalResponsibilityBatchResponse =
  z.infer<typeof ExternalResponsibilityBatchResponseSchema>;
export type ExternalResponsibilityQueueResponse =
  z.infer<typeof ExternalResponsibilityQueueResponseSchema>;

/** Existing external queue wording also defines its searchable status text. */
export const ExternalResponsibilityQueueStatusLabels = {pending_business_signoff:"待交财务",pending_payables_confirmation:"待扣款",deduction_follow_up:"扣款中",pending_special_approval:"待财务总监特批",returned:"资料退回",pending_responsibility_revision:"待重判",closed:"扣款完成",superseded:"历史台账"} as const;
