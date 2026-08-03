import { z } from "zod";

export const LiveHealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
  timestamp: z.string().datetime(),
});

export const ReadyHealthResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.string().min(1),
  checks: z.object({
    database: z.enum(["up", "down"]),
    schema: z.enum(["current", "drift", "unavailable"]),
  }),
  timestamp: z.string().datetime(),
});

export const VersionResponseSchema = z.object({
  service: z.string().min(1),
  gitSha: z.string().min(1),
  buildTime: z.string().min(1),
  schemaVersion: z.string().nullable(),
  expectedSchemaVersion: z.string().min(1),
});

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});

export type LiveHealthResponse = z.infer<typeof LiveHealthResponseSchema>;
export type ReadyHealthResponse = z.infer<typeof ReadyHealthResponseSchema>;
export type VersionResponse = z.infer<typeof VersionResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const StableErrorCodeSchema = z.enum([
  "AUTH_REQUIRED", "SESSION_INVALID", "NO_BUSINESS_ROLE", "RATE_LIMITED", "FORBIDDEN", "NOT_FOUND", "VALIDATION_ERROR", "CONFLICT",
  "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS", "STORAGE_UNAVAILABLE",
  "ATTACHMENT_NOT_READY", "ATTACHMENT_METADATA_MISMATCH", "INVALID_STATE_TRANSITION", "INTERNAL_ERROR",
]);

const IdSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const CreateUploadIntentSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
  sizeBytes: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict();
export const FinalizeAttachmentSchema = z.object({}).strict();
export const AttachmentParamsSchema = z.object({ attachmentId: IdSchema }).strict();
export const UploadIntentResponseSchema = z.object({
  attachmentId: IdSchema,
  objectKey: z.string(),
  uploadMethod: z.literal("POST"),
  uploadUrl: z.string().url(),
  uploadFields: z.record(z.string().min(1), z.string()),
  expiresAt: z.string().datetime(),
});
export const DownloadIntentResponseSchema = z.object({ downloadUrl: z.string().url(), expiresAt: z.string().datetime() });
export const AttachmentResponseSchema = z.object({ attachmentId: IdSchema, filename: z.string(), mimeType: z.string(), sizeBytes: z.number().int(), sha256: Sha256Schema, status: z.enum(["pending", "ready", "rejected"]), createdAt: z.string().datetime() });

export const CreateExportJobSchema = z.object({ exportType: z.string().min(1).max(100), filters: z.record(z.string(), z.unknown()), idempotencyKey: z.string().min(1).max(200) }).strict();
export const ExportJobParamsSchema = z.object({ exportJobId: IdSchema }).strict();
export const ExportJobResponseSchema = z.object({ exportJobId: IdSchema, exportType: z.string(), filters: z.record(z.string(), z.unknown()), status: z.enum(["pending", "running", "succeeded", "failed"]), resultAttachmentId: IdSchema.nullable(), createdAt: z.string().datetime() });

export type CreateUploadIntent = z.infer<typeof CreateUploadIntentSchema>;
export type UploadIntentResponse = z.infer<typeof UploadIntentResponseSchema>;
export type DownloadIntentResponse = z.infer<typeof DownloadIntentResponseSchema>;
export type AttachmentResponse = z.infer<typeof AttachmentResponseSchema>;
export type CreateExportJob = z.infer<typeof CreateExportJobSchema>;
export type ExportJobResponse = z.infer<typeof ExportJobResponseSchema>;

export const CapabilitySchema = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/);
export const RoleCodeSchema = z.string().regex(/^[a-z][a-z0-9:_-]{2,63}$/);
export const CatalogCodeSchema = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);
const ReasonSchema = z.string().trim().min(1).max(500);

export const AssignRoleSchema = z.object({
  userId: IdSchema,
  roleCode: RoleCodeSchema,
  reason: ReasonSchema,
}).strict();
export const RoleAssignmentParamsSchema = z.object({ assignmentId: IdSchema }).strict();
export const RevokeAccessSchema = z.object({ reason: ReasonSchema }).strict();
export const RoleAssignmentsQuerySchema = z.object({
  userId: IdSchema.optional(),
  includeRevoked: z.enum(["true", "false"]).optional(),
}).strict();

const PersonBaseSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  aliases: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  reason: ReasonSchema,
});
export const CreateBusinessPersonSchema = z.discriminatedUnion("personType", [
  PersonBaseSchema.extend({ personType: z.literal("internal"), appUserId: IdSchema }).strict(),
  PersonBaseSchema.extend({ personType: z.literal("temporary") }).strict(),
]);
export const PersonParamsSchema = z.object({ personId: IdSchema }).strict();
export const PersonAliasParamsSchema = z.object({ aliasId: IdSchema }).strict();
export const CreatePersonAliasSchema = z.object({
  alias: z.string().trim().min(1).max(100),
  reason: ReasonSchema,
}).strict();

export const CreateProcessSchema = z.object({
  processCode: CatalogCodeSchema,
  processName: z.string().trim().min(1).max(100),
  pricingUnit: z.enum(["piece", "hour"]),
  active: z.boolean().default(true),
  changeReason: ReasonSchema,
}).strict();
export const ReviseProcessSchema = CreateProcessSchema.omit({ processCode: true });
export const ProcessParamsSchema = z.object({ processId: IdSchema }).strict();

export const CreateSupplierSchema = z.object({
  supplierCode: CatalogCodeSchema,
  supplierType: z.enum(["factory", "embroidery_washing", "fabric", "other"]),
  supplierName: z.string().trim().min(1).max(200),
  active: z.boolean().default(true),
  changeReason: ReasonSchema,
}).strict();
export const ReviseSupplierSchema = CreateSupplierSchema.omit({ supplierCode: true, supplierType: true });
export const SupplierParamsSchema = z.object({ supplierId: IdSchema }).strict();

export const CreateDelegationSchema = z.object({
  grantorUserId: IdSchema,
  granteeUserId: IdSchema,
  capability: CapabilitySchema,
  scopeType: z.enum(["global", "rework_order", "process", "supplier"]),
  scopeId: z.string().trim().min(1).max(200).optional(),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime(),
  reason: ReasonSchema,
}).strict().superRefine((value, context) => {
  if ((value.scopeType === "global") !== (value.scopeId === undefined)) {
    context.addIssue({ code: "custom", path: ["scopeId"], message: "Global scope must omit scopeId; non-global scope must provide it" });
  }
  if (Date.parse(value.validUntil) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "validUntil must be later than validFrom" });
  }
});
export const DelegationParamsSchema = z.object({ delegationId: IdSchema }).strict();
export const DelegationsQuerySchema = z.object({
  userId: IdSchema.optional(),
  includeRevoked: z.enum(["true", "false"]).optional(),
}).strict();
export const CatalogListQuerySchema = z.object({
  includeInactive: z.enum(["true", "false"]).optional(),
}).strict();
export const PeopleListQuerySchema = CatalogListQuerySchema.extend({
  includeRevokedAliases: z.enum(["true", "false"]).optional(),
}).strict();

export type AssignRole = z.infer<typeof AssignRoleSchema>;
export type CreateBusinessPerson = z.infer<typeof CreateBusinessPersonSchema>;
export type CreatePersonAlias = z.infer<typeof CreatePersonAliasSchema>;
export type CreateProcess = z.infer<typeof CreateProcessSchema>;
export type ReviseProcess = z.infer<typeof ReviseProcessSchema>;
export type CreateSupplier = z.infer<typeof CreateSupplierSchema>;
export type ReviseSupplier = z.infer<typeof ReviseSupplierSchema>;
export type CreateDelegation = z.infer<typeof CreateDelegationSchema>;

export const ReworkOrderStatusSchema = z.enum([
  "draft",
  "pending_process_configuration",
  "pending_ie_review",
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
  "pending_quantity_adjustment_ie_review",
  "pending_responsibility_determination",
  "pending_responsibility_action",
  "cancelled",
]);
export const IdempotencyKeySchema = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

const DraftTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable().optional();
export const ReworkProcessingFactorySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("own_factory") }).strict(),
  z.object({ type: z.literal("supplier"), supplierId: IdSchema }).strict(),
]);
const ReworkAttachmentIdsSchema = z.array(IdSchema).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "attachmentIds cannot contain duplicates" });
  }
});
const ReworkDraftFieldsSchema = z.object({
  styleNo: DraftTextSchema(100),
  orderNo: DraftTextSchema(100),
  merchandiserUserId: IdSchema.nullable().optional(),
  processingFactory: ReworkProcessingFactorySchema.nullable().optional(),
  problemPart: DraftTextSchema(200),
  problemDescription: DraftTextSchema(2000),
  reworkQuantity: z.number().int().positive().nullable().optional(),
  attachmentIds: ReworkAttachmentIdsSchema.optional(),
});

export const CreateReworkDraftSchema = ReworkDraftFieldsSchema.strict();
export const UpdateReworkDraftSchema = ReworkDraftFieldsSchema.extend({
  expectedVersion: z.number().int().positive(),
}).strict();
export const SubmitReworkOrderSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();
export const TransitionReworkOrderSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: ReasonSchema,
}).strict();
export const ReworkOrderParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const ReworkOrdersQuerySchema = z.object({
  status: ReworkOrderStatusSchema.optional(),
}).strict();
export const ReworkOrderResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkNo: z.string().nullable(),
  status: ReworkOrderStatusSchema,
  styleNo: z.string().nullable(),
  orderNo: z.string().nullable(),
  merchandiserUserId: IdSchema.nullable(),
  processingFactory: z.discriminatedUnion("type", [
    z.object({ type: z.literal("own_factory") }).strict(),
    z.object({
      type: z.literal("supplier"),
      supplierId: IdSchema,
      supplierVersion: z.number().int().positive(),
    }).strict(),
  ]).nullable(),
  problemPart: z.string().nullable(),
  problemDescription: z.string().nullable(),
  reworkQuantity: z.number().int().positive().nullable(),
  attachmentIds: z.array(IdSchema),
  hasOtherOpenStyleOrder: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  submittedAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  cancelReason: z.string().nullable(),
});
export const ReworkInitiationOptionsResponseSchema = z.object({
  merchandisers: z.array(z.object({
    userId: IdSchema,
    displayName: z.string().min(1),
  }).strict()),
  factories: z.array(z.object({
    supplierId: IdSchema,
    supplierVersion: z.number().int().positive(),
    supplierName: z.string().min(1),
  }).strict()),
});

export type ReworkOrderStatus = z.infer<typeof ReworkOrderStatusSchema>;
export type ReworkProcessingFactory = z.infer<typeof ReworkProcessingFactorySchema>;
export type CreateReworkDraft = z.infer<typeof CreateReworkDraftSchema>;
export type UpdateReworkDraft = z.infer<typeof UpdateReworkDraftSchema>;
export type SubmitReworkOrder = z.infer<typeof SubmitReworkOrderSchema>;
export type TransitionReworkOrder = z.infer<typeof TransitionReworkOrderSchema>;
export type ReworkOrderResponse = z.infer<typeof ReworkOrderResponseSchema>;
export type ReworkInitiationOptionsResponse = z.infer<typeof ReworkInitiationOptionsResponseSchema>;

export const ProcessPricingUnitSchema = z.enum(["piece", "hour"]);
export const ProcessConfigurationItemSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("catalog"),
    processId: IdSchema,
    plannedQuantity: z.number().finite().positive(),
    pricingUnit: ProcessPricingUnitSchema,
    unitPrice: z.number().finite().positive(),
  }).strict(),
  z.object({
    source: z.literal("custom"),
    customProcessName: z.string().trim().min(1).max(100),
    plannedQuantity: z.number().finite().positive(),
    pricingUnit: ProcessPricingUnitSchema,
    unitPrice: z.number().finite().positive(),
  }).strict(),
]).superRefine((value, context) => {
  if (value.pricingUnit === "piece" && !Number.isInteger(value.plannedQuantity)) {
    context.addIssue({
      code: "custom",
      path: ["plannedQuantity"],
      message: "Piece-based planned quantity must be an integer",
    });
  }
});

export const SaveProcessConfigurationSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  items: z.array(ProcessConfigurationItemSchema).min(1).max(100),
  changeReason: ReasonSchema.optional(),
}).strict().superRefine((value, context) => {
  const duplicateKeys = value.items.map((item) =>
    item.source === "catalog"
      ? `catalog:${item.processId}`
      : `custom:${item.customProcessName.trim().toLocaleLowerCase("zh-CN")}`,
  );
  if (new Set(duplicateKeys).size !== duplicateKeys.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "A process can appear only once in one configuration" });
  }
});

export const SubmitProcessConfigurationSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedConfigurationVersion: z.number().int().positive(),
}).strict();

export const ReviewProcessConfigurationSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedConfigurationVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Rejection reason is required" });
  }
});

export const ProcessConfigurationParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const ProcessConfigurationItemResponseSchema = z.object({
  configurationItemId: IdSchema,
  source: z.enum(["catalog", "custom"]),
  processId: IdSchema.nullable(),
  processVersion: z.number().int().positive().nullable(),
  processName: z.string().min(1),
  pricingUnit: ProcessPricingUnitSchema,
  plannedQuantity: z.number().positive(),
  unitPrice: z.number().positive(),
  promotedProcessId: IdSchema.nullable(),
});
export const ProcessConfigurationResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkNo: z.string().nullable(),
  reworkStatus: ReworkOrderStatusSchema,
  orderVersion: z.number().int().positive(),
  configuration: z.object({
    configurationId: IdSchema,
    configurationVersion: z.number().int().positive(),
    kind: z.enum(["initial", "change"]),
    status: z.enum(["draft", "pending_ie_review", "approved", "rejected", "superseded"]),
    changeReason: z.string().nullable(),
    reviewReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    reviewedAt: z.string().datetime().nullable(),
    items: z.array(ProcessConfigurationItemResponseSchema),
  }).nullable(),
});
export const ProcessConfigurationOptionsResponseSchema = z.object({
  processes: z.array(z.object({
    processId: IdSchema,
    version: z.number().int().positive(),
    processName: z.string().min(1),
    pricingUnit: ProcessPricingUnitSchema,
  }).strict()),
});

export type ProcessConfigurationItem = z.infer<typeof ProcessConfigurationItemSchema>;
export type SaveProcessConfiguration = z.infer<typeof SaveProcessConfigurationSchema>;
export type SubmitProcessConfiguration = z.infer<typeof SubmitProcessConfigurationSchema>;
export type ReviewProcessConfiguration = z.infer<typeof ReviewProcessConfigurationSchema>;
export type ProcessConfigurationResponse = z.infer<typeof ProcessConfigurationResponseSchema>;
export type ProcessConfigurationOptionsResponse = z.infer<typeof ProcessConfigurationOptionsResponseSchema>;

export const WorkTaskModeSchema = z.enum(["individual", "collective"]);
export const WorkTaskMemberSchema = z.object({ personId: IdSchema }).strict();
export const CreateWorkTaskSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  configurationItemId: IdSchema,
  mode: WorkTaskModeSchema,
  members: z.array(WorkTaskMemberSchema).min(1).max(40),
}).strict().superRefine((value, context) => {
  if (new Set(value.members.map((member) => member.personId)).size !== value.members.length) {
    context.addIssue({ code: "custom", path: ["members"], message: "Task members cannot contain duplicates" });
  }
  if (value.mode === "individual" && value.members.length !== 1) {
    context.addIssue({ code: "custom", path: ["members"], message: "An individual task has exactly one worker" });
  }
});
export const WorkTaskParamsSchema = z.object({ workTaskId: IdSchema }).strict();
export const ReworkWorkTasksParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const CreateWorkReportSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  actualQuantity: z.number().finite().positive(),
  completedAt: z.string().datetime(),
  remark: z.string().trim().min(1).max(500).optional(),
  resubmitsWorkReportId: IdSchema.optional(),
}).strict();
export const WorkTaskAssignablePeopleResponseSchema = z.object({
  people: z.array(z.object({
    personId: IdSchema,
    displayName: z.string().min(1),
    personType: z.enum(["internal", "temporary"]),
  }).strict()),
});
export const WorkTaskResponseSchema = z.object({
  workTaskId: IdSchema,
  reworkOrderId: IdSchema,
  configurationItemId: IdSchema,
  processName: z.string().min(1),
  pricingUnit: ProcessPricingUnitSchema,
  plannedQuantity: z.number().positive(),
  unitPrice: z.number().positive(),
  mode: WorkTaskModeSchema,
  version: z.number().int().positive(),
  status: z.enum(["active", "superseded"]),
  canSubmitReport: z.boolean(),
  members: z.array(z.object({ personId: IdSchema, displayName: z.string().min(1), personType: z.enum(["internal", "temporary"]) }).strict()),
  submittedQuantity: z.number().nonnegative(),
  remainingQuantity: z.number().nonnegative(),
});
export const WorkReportResponseSchema = z.object({
  workReportId: IdSchema,
  workTaskId: IdSchema,
  reworkOrderId: IdSchema,
  actualQuantity: z.number().positive(),
  completedAt: z.string().datetime(),
  status: z.literal("submitted"),
  groupAmount: z.number().positive().nullable(),
  memberShares: z.array(z.object({ personId: IdSchema, amount: z.number().positive() }).strict()),
});
export const ReworkWorkTasksResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: ReworkOrderStatusSchema,
  orderVersion: z.number().int().positive(),
  tasks: z.array(WorkTaskResponseSchema),
});
export type CreateWorkTask = z.infer<typeof CreateWorkTaskSchema>;
export type CreateWorkReport = z.infer<typeof CreateWorkReportSchema>;
export type WorkTaskAssignablePeopleResponse = z.infer<typeof WorkTaskAssignablePeopleResponseSchema>;
export type WorkTaskResponse = z.infer<typeof WorkTaskResponseSchema>;
export type WorkReportResponse = z.infer<typeof WorkReportResponseSchema>;
export type ReworkWorkTasksResponse = z.infer<typeof ReworkWorkTasksResponseSchema>;

export const WholeOrderReviewParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const WholeOrderReviewQuerySchema = z.object({ configurationItemId: IdSchema.optional() }).strict();
export const WorkReportRejectionParamsSchema = z.object({ workReportId: IdSchema }).strict();
export const RejectWorkReportSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  rejectedPersonId: IdSchema.nullable(),
  reason: ReasonSchema,
}).strict();
export const ReviewWholeOrderSchema = z.object({ expectedOrderVersion: z.number().int().positive() }).strict();
export const CreateQuantityDecreaseSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  configurationItemId: IdSchema,
  newPlannedQuantity: z.number().finite().positive(),
  reason: ReasonSchema,
}).strict();
export const CreateQuantityIncreaseSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  configurationItemId: IdSchema,
  newPlannedQuantity: z.number().finite().positive(),
  reason: ReasonSchema,
  expiresAt: z.string().datetime(),
  requiresIeReview: z.boolean().default(false),
}).strict();
export const QuantityAdjustmentParamsSchema = z.object({ adjustmentId: IdSchema }).strict();
export const ConfirmQuantityIncreaseSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedAdjustmentVersion: z.number().int().positive(),
  decision: z.enum(["confirmed", "rejected"]),
  actualCutQuantity: z.number().finite().nonnegative(),
  actualReturnQuantity: z.number().finite().nonnegative(),
  allowedMaximumQuantity: z.number().finite().positive(),
  reason: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Rejection reason is required" });
  }
});
export const ReviewQuantityIncreaseSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedAdjustmentVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Rejection reason is required" });
  }
});
export const QuantityAdjustmentResponseSchema = z.object({
  adjustmentId: IdSchema,
  configurationItemId: IdSchema,
  adjustmentVersion: z.number().int().positive(),
  kind: z.enum(["decrease", "increase"]),
  status: z.enum(["effective", "pending_merchandiser_confirmation", "pending_ie_review", "rejected", "expired"]),
  previousPlannedQuantity: z.number().positive(),
  requestedPlannedQuantity: z.number().positive(),
  reason: z.string().min(1),
  requiresIeReview: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
  requestedBy: IdSchema,
  requestedAt: z.string().datetime(),
  confirmedBy: IdSchema.nullable(),
  confirmedAt: z.string().datetime().nullable(),
  reviewedBy: IdSchema.nullable(),
  reviewedAt: z.string().datetime().nullable(),
});
export const WholeOrderReviewResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: ReworkOrderStatusSchema,
  orderVersion: z.number().int().positive(),
  canReview: z.boolean(),
  canAdjustQuantity: z.boolean(),
  canConfirmQuantity: z.boolean(),
  canReviewQuantityIncrease: z.boolean(),
  processes: z.array(z.object({
    configurationItemId: IdSchema,
    processName: z.string().min(1),
    pricingUnit: ProcessPricingUnitSchema,
    plannedQuantity: z.number().positive(),
    completedQuantity: z.number().nonnegative(),
    complete: z.boolean(),
  }).strict()),
  reports: z.array(z.object({
    workReportId: IdSchema,
    workTaskId: IdSchema,
    configurationItemId: IdSchema,
    actualQuantity: z.number().positive(),
    completedAt: z.string().datetime(),
    submittedBy: IdSchema,
    assignmentMode: z.enum(["individual", "collective"]),
    members: z.array(z.object({ personId: IdSchema, displayName: z.string().min(1) }).strict()),
    rejected: z.boolean(),
    rejectedPersonId: IdSchema.nullable(),
    rejectionReason: z.string().nullable(),
    resubmitsWorkReportId: IdSchema.nullable(),
  }).strict()),
  adjustments: z.array(QuantityAdjustmentResponseSchema),
  reviewId: IdSchema.nullable(),
});
export type RejectWorkReport = z.infer<typeof RejectWorkReportSchema>;
export type ReviewWholeOrder = z.infer<typeof ReviewWholeOrderSchema>;
export type CreateQuantityDecrease = z.infer<typeof CreateQuantityDecreaseSchema>;
export type CreateQuantityIncrease = z.infer<typeof CreateQuantityIncreaseSchema>;
export type ConfirmQuantityIncrease = z.infer<typeof ConfirmQuantityIncreaseSchema>;
export type ReviewQuantityIncrease = z.infer<typeof ReviewQuantityIncreaseSchema>;
export type QuantityAdjustmentResponse = z.infer<typeof QuantityAdjustmentResponseSchema>;
export type WholeOrderReviewResponse = z.infer<typeof WholeOrderReviewResponseSchema>;

const responsibilityMultiplierScaled = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0"));
};
const ResponsibilityMultiplierSchema = z.string()
  .regex(/^(?:[1-9]\d{0,4})(?:\.\d{1,3})?$/, "Multiplier must be between 1 and 99999.999 with at most 3 places")
  .refine((value) => responsibilityMultiplierScaled(value) <= 99_999_999n, "Multiplier exceeds database numeric(8,3) range");
export const ResponsibilityOrderParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const ResponsibilityDeterminationParamsSchema = z.object({ determinationId: IdSchema }).strict();
export const ResponsibilityTypeSchema = z.enum(["own_factory", "processing_factory", "embroidery_factory", "washing_factory", "fabric_supplier"]);
export const ResponsibilityAllocationInputSchema = z.object({
  responsibilityType: ResponsibilityTypeSchema,
  shareBps: z.number().int().min(1).max(10_000),
}).strict();
export const ResponsibilityProcessInputSchema = z.object({
  configurationItemId: IdSchema,
  multiplier: ResponsibilityMultiplierSchema,
  highMultiplierReason: ReasonSchema.optional(),
  allocations: z.array(ResponsibilityAllocationInputSchema).min(1).max(5),
}).strict().superRefine((value, context) => {
  if (value.allocations.reduce((sum, row) => sum + row.shareBps, 0) !== 10_000) context.addIssue({ code: "custom", path: ["allocations"], message: "Responsibility shares must total 10000 bps" });
  if (new Set(value.allocations.map((row) => row.responsibilityType)).size !== value.allocations.length) context.addIssue({ code: "custom", path: ["allocations"], message: "Responsibility types cannot repeat" });
  const [whole, fraction = ""] = value.multiplier.split(".");
  if (BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0")) > 2000n && !value.highMultiplierReason) context.addIssue({ code: "custom", path: ["highMultiplierReason"], message: "A reason is required above 2x" });
});
export const CreateResponsibilityDraftSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedCurrentDeterminationVersion: z.number().int().positive().nullable(),
  handlerUserId: IdSchema,
  reason: ReasonSchema.optional(),
  processes: z.array(ResponsibilityProcessInputSchema).min(1),
}).strict();
export const FinalizeResponsibilitySchema = z.object({ expectedOrderVersion: z.number().int().positive(), expectedCurrentDeterminationVersion: z.number().int().positive() }).strict();
export const TransferResponsibilitySchema = z.object({ expectedOrderVersion: z.number().int().positive(), expectedCurrentDeterminationVersion: z.number().int().positive().nullable(), toUserId: IdSchema, reason: ReasonSchema }).strict();
export const TakeoverResponsibilitySchema = z.object({ expectedOrderVersion: z.number().int().positive(), expectedCurrentDeterminationVersion: z.number().int().positive().nullable(), reason: ReasonSchema }).strict();
export const ConfirmHighMultiplierSchema = z.object({ expectedOrderVersion: z.number().int().positive(), expectedCurrentDeterminationVersion: z.number().int().positive(), reason: ReasonSchema }).strict();
export const ResponsibilityDeterminationResponseSchema = z.object({
  reworkOrderId: IdSchema, reworkStatus: ReworkOrderStatusSchema, orderVersion: z.number().int().positive(),
  handlerUserId: IdSchema.nullable(), canDetermine: z.boolean(), canTakeover: z.boolean(), canConfirmHighMultiplier: z.boolean(),
  sourceProcesses: z.array(z.object({ configurationItemId: IdSchema, processName: z.string().min(1), pricingUnit: ProcessPricingUnitSchema, baseAmount: z.string() }).strict()),
  determination: z.object({ determinationId: IdSchema, version: z.number().int().positive(), stage: z.enum(["draft", "finalized"]), reason: z.string().nullable(), calculationTotal: z.string(), highMultiplierConfirmed: z.boolean(), processes: z.array(z.object({ configurationItemId: IdSchema, processName: z.string(), pricingUnit: ProcessPricingUnitSchema, multiplier: z.string(), highMultiplierReason: z.string().nullable(), baseAmount: z.string(), responsibilityAmount: z.string(), allocations: z.array(z.object({ responsibilityType: ResponsibilityTypeSchema, shareBps: z.number().int(), roundedAmount: z.string() })) })) }).nullable(),
});
export type ResponsibilityType = z.infer<typeof ResponsibilityTypeSchema>;
export type CreateResponsibilityDraft = z.infer<typeof CreateResponsibilityDraftSchema>;
export type FinalizeResponsibility = z.infer<typeof FinalizeResponsibilitySchema>;
export type TransferResponsibility = z.infer<typeof TransferResponsibilitySchema>;
export type TakeoverResponsibility = z.infer<typeof TakeoverResponsibilitySchema>;
export type ConfirmHighMultiplier = z.infer<typeof ConfirmHighMultiplierSchema>;
export type ResponsibilityDeterminationResponse = z.infer<typeof ResponsibilityDeterminationResponseSchema>;
