import { z } from "zod";

export * from "./wages.js";
export * from "./todos.js";
export * from "./todo-presentation.js";
export * from "./admin-audit.js";

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
  PersonBaseSchema.extend({
    personType: z.literal("temporary"),
    temporaryRemark: z.string().trim().min(1).max(100).optional(),
  }).strict(),
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
  "pending_final_quantity_ie_review",
  "pending_quantity_adjustment_ie_review",
  "pending_responsibility_determination",
  "pending_owner_signature",
  "pending_responsibility_action",
  "completed",
  "cancelled",
  "deleted",
]);
export const IdempotencyKeySchema = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

const DraftTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable().optional();
export const ReworkProcessingFactorySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("own_factory") }).strict(),
  z.object({ type: z.literal("supplier"), supplierId: IdSchema }).strict(),
]);
export const MAX_REWORK_ATTACHMENTS = 6;

const ReworkAttachmentIdsSchema = (minimum = 0) => z.array(IdSchema)
  .min(minimum)
  .max(MAX_REWORK_ATTACHMENTS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "attachmentIds cannot contain duplicates" });
    }
  });

export const InspectionStageSchema = z.enum(["midline", "final", "warehouse", "reinspection"]);
export const InspectionCheckResultSchema = z.enum(["pass", "fail"]);

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TenthCentimeterSchema = z.number().finite().refine(
  (value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-8,
  "Measurement must use 0.1 cm precision",
);

export const InspectionMeasurementSchema = z.object({
  partName: z.string().trim().min(1).max(50),
  actualCm: TenthCentimeterSchema.nonnegative().nullable(),
  deviationCm: TenthCentimeterSchema.nullable(),
  notApplicable: z.boolean(),
}).strict();

export const InspectionSizeSampleSchema = z.object({
  sampleId: IdSchema,
  sizeLabel: z.string().trim().min(1).max(20),
  sampleLabel: z.string().trim().min(1).max(30),
  measurements: z.array(InspectionMeasurementSchema).min(1).max(30),
}).strict().superRefine((value, context) => {
  if (new Set(value.measurements.map((item) => item.partName)).size !== value.measurements.length) {
    context.addIssue({ code: "custom", path: ["measurements"], message: "Measurement parts cannot contain duplicates" });
  }
});

export const InspectionIssueSchema = z.object({
  issueId: IdSchema,
  category: z.string().trim().max(100).nullable(),
  description: z.string().trim().max(500).nullable(),
  majorCount: z.number().int().nonnegative(),
  minorCount: z.number().int().nonnegative(),
}).strict();

export const InspectionReportDraftSchema = z.object({
  schemaVersion: z.literal(1),
  styleName: z.string().trim().max(100).nullable().optional(),
  inspectionStage: InspectionStageSchema.nullable(),
  inspectionLocation: z.string().trim().max(200).nullable(),
  color: z.string().trim().max(100).nullable(),
  sampleQuantity: z.number().int().positive().nullable(),
  measurementUnit: z.literal("cm"),
  measurementPrecision: z.literal(0.1),
  sizeSamples: z.array(InspectionSizeSampleSchema).max(60),
  documentChecks: z.object({
    confirmationSample: z.boolean(),
    approvalCard: z.boolean(),
    supplierSelfInspection: z.boolean(),
    bulkFabricInspection: z.boolean(),
    exceptionReason: z.string().trim().max(500).nullable(),
  }).strict(),
  fabricMatch: z.enum(["match", "mismatch"]).nullable(),
  fabricMismatchReason: z.string().trim().max(500).nullable(),
  fitDecision: z.enum(["accepted", "recheck_after_rework", "rejected"]).nullable(),
  factoryPreparation: z.enum(["strict", "not_done", "perfunctory"]).nullable(),
  materialChecks: z.object({
    physicalPerformance: InspectionCheckResultSchema.nullable(),
    washTest: InspectionCheckResultSchema.nullable(),
    productMarking: InspectionCheckResultSchema.nullable(),
  }).strict(),
  issues: z.array(InspectionIssueSchema).max(20),
  nonconformanceCause: z.string().trim().max(1000).nullable(),
  approvalOpinion: z.string().trim().max(1000).nullable(),
  supplierSignatoryName: z.string().trim().max(100).nullable(),
  supplierSignedOn: DateOnlySchema.nullable(),
  inspectionDate: DateOnlySchema.nullable(),
  disposition: z.literal("rework"),
}).strict();

export const InspectionReportSchema = InspectionReportDraftSchema.superRefine((value, context) => {
  const requiredText: Array<[string, string | null]> = [
    ["inspectionLocation", value.inspectionLocation],
    ["color", value.color],
    ["nonconformanceCause", value.nonconformanceCause],
  ];
  for (const [field, content] of requiredText) {
    if (!content) context.addIssue({ code: "custom", path: [field], message: "Required" });
  }
  if (!value.inspectionStage) {
    context.addIssue({ code: "custom", path: ["inspectionStage"], message: "Required" });
  }
  if (!value.sampleQuantity) {
    context.addIssue({ code: "custom", path: ["sampleQuantity"], message: "Required" });
  }
  if (!value.inspectionDate) {
    context.addIssue({ code: "custom", path: ["inspectionDate"], message: "Required" });
  }
  if (value.sizeSamples.length === 0) {
    context.addIssue({ code: "custom", path: ["sizeSamples"], message: "At least one size sample is required" });
  }
  value.sizeSamples.forEach((sample, sampleIndex) => {
    sample.measurements.forEach((measurement, measurementIndex) => {
      if (!measurement.notApplicable && (measurement.actualCm === null || measurement.deviationCm === null)) {
        context.addIssue({
          code: "custom",
          path: ["sizeSamples", sampleIndex, "measurements", measurementIndex],
          message: "Actual and deviation are required unless the part is not applicable",
        });
      }
    });
  });
  const documents = value.documentChecks;
  if (
    (!documents.confirmationSample
      || !documents.approvalCard
      || !documents.supplierSelfInspection
      || !documents.bulkFabricInspection)
    && !documents.exceptionReason
  ) {
    context.addIssue({
      code: "custom",
      path: ["documentChecks", "exceptionReason"],
      message: "Reason is required when a document is missing",
    });
  }
  if (!value.fabricMatch) context.addIssue({ code: "custom", path: ["fabricMatch"], message: "Required" });
  if (value.fabricMatch === "mismatch" && !value.fabricMismatchReason) {
    context.addIssue({ code: "custom", path: ["fabricMismatchReason"], message: "Required" });
  }
  if (!value.fitDecision) context.addIssue({ code: "custom", path: ["fitDecision"], message: "Required" });
  if (!value.factoryPreparation) context.addIssue({ code: "custom", path: ["factoryPreparation"], message: "Required" });
  Object.entries(value.materialChecks).forEach(([field, result]) => {
    if (!result) context.addIssue({ code: "custom", path: ["materialChecks", field], message: "Required" });
  });
  if (value.issues.length === 0) {
    context.addIssue({ code: "custom", path: ["issues"], message: "At least one issue is required" });
  }
  value.issues.forEach((issue, index) => {
    if (!issue.category) context.addIssue({ code: "custom", path: ["issues", index, "category"], message: "Required" });
    if (!issue.description) context.addIssue({ code: "custom", path: ["issues", index, "description"], message: "Required" });
    if (issue.majorCount + issue.minorCount === 0) {
      context.addIssue({ code: "custom", path: ["issues", index], message: "Issue count must be greater than zero" });
    }
  });
});

const ReworkDraftFieldsSchema = z.object({
  styleNo: DraftTextSchema(100),
  customerSupplyCode: DraftTextSchema(100),
  factoryStyleNo: DraftTextSchema(100),
  orderNo: DraftTextSchema(100),
  orderQuantity: z.number().int().positive().nullable().optional(),
  merchandiserUserId: IdSchema.nullable().optional(),
  processingFactory: ReworkProcessingFactorySchema.nullable().optional(),
  reworkReason: DraftTextSchema(500),
  reworkProcess: DraftTextSchema(500),
  problemPart: DraftTextSchema(200),
  problemDescription: DraftTextSchema(2000),
  reworkQuantity: z.number().int().positive().nullable().optional(),
  inspectionReport: InspectionReportDraftSchema.nullable().optional(),
  attachmentIds: ReworkAttachmentIdsSchema().optional(),
});

export const CreateReworkDraftSchema = ReworkDraftFieldsSchema.strict();
export const UpdateReworkDraftSchema = ReworkDraftFieldsSchema.extend({
  expectedVersion: z.number().int().positive(),
}).strict();
export const SupplementReworkOrderImagesSchema = z.object({
  expectedVersion: z.number().int().positive(),
  attachmentIds: ReworkAttachmentIdsSchema(1),
}).strict();
export const SubmitReworkOrderSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();
export const TransitionReworkOrderSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: ReasonSchema,
}).strict();
export const ReworkOrderParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const DeleteReworkOrderResponseSchema = z.object({
  reworkOrderId: IdSchema,
  deleted: z.literal(true),
}).strict();
export const ReworkOrdersQuerySchema = z.object({
  status: ReworkOrderStatusSchema.optional(),
}).strict();
export const ReworkOrderResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkNo: z.string().nullable(),
  status: ReworkOrderStatusSchema,
  styleNo: z.string().nullable(),
  customerSupplyCode: z.string().nullable(),
  factoryStyleNo: z.string().nullable(),
  orderNo: z.string().nullable(),
  orderQuantity: z.number().int().positive().nullable(),
  merchandiserUserId: IdSchema.nullable(),
  processingFactory: z.discriminatedUnion("type", [
    z.object({ type: z.literal("own_factory") }).strict(),
    z.object({
      type: z.literal("supplier"),
      supplierId: IdSchema,
      supplierVersion: z.number().int().positive(),
    }).strict(),
  ]).nullable(),
  reworkReason: z.string().nullable(),
  reworkProcess: z.string().nullable(),
  problemPart: z.string().nullable(),
  problemDescription: z.string().nullable(),
  reworkQuantity: z.number().int().positive().nullable(),
  inspectionReport: InspectionReportDraftSchema.nullable(),
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
    personalUsageCount: z.number().int().nonnegative().optional(),
    globalUsageCount: z.number().int().nonnegative().optional(),
    lastUsedAt: z.string().datetime().nullable().optional(),
  }).strict()),
  colorSuggestions: z.array(z.object({
    value: z.string().trim().min(1).max(100),
    personalUsageCount: z.number().int().nonnegative(),
    globalUsageCount: z.number().int().nonnegative(),
    lastUsedAt: z.string().datetime().nullable(),
  }).strict()).optional(),
});

export const ExtractInspectionReportImageSchema = z.object({
  attachmentId: IdSchema,
}).strict();

export const InspectionReportImageExtractionSchema = z.object({
  supplierName: z.string().trim().max(100).nullable(),
  styleNo: z.string().trim().max(100).nullable(),
  styleName: z.string().trim().max(100).nullable(),
  color: z.string().trim().max(100).nullable(),
  inspectionStage: InspectionStageSchema.nullable(),
  inspectionLocation: z.string().trim().max(200).nullable(),
  orderQuantity: z.number().int().positive().nullable(),
  sampleQuantity: z.number().int().positive().nullable(),
}).strict();

export type ReworkOrderStatus = z.infer<typeof ReworkOrderStatusSchema>;
export type ReworkProcessingFactory = z.infer<typeof ReworkProcessingFactorySchema>;
export type InspectionStage = z.infer<typeof InspectionStageSchema>;
export type InspectionMeasurement = z.infer<typeof InspectionMeasurementSchema>;
export type InspectionSizeSample = z.infer<typeof InspectionSizeSampleSchema>;
export type InspectionIssue = z.infer<typeof InspectionIssueSchema>;
export type InspectionReportDraft = z.infer<typeof InspectionReportDraftSchema>;
export type InspectionReport = z.infer<typeof InspectionReportSchema>;
export type CreateReworkDraft = z.infer<typeof CreateReworkDraftSchema>;
export type UpdateReworkDraft = z.infer<typeof UpdateReworkDraftSchema>;
export type SupplementReworkOrderImages = z.infer<typeof SupplementReworkOrderImagesSchema>;
export type SubmitReworkOrder = z.infer<typeof SubmitReworkOrderSchema>;
export type TransitionReworkOrder = z.infer<typeof TransitionReworkOrderSchema>;
export type ReworkOrderResponse = z.infer<typeof ReworkOrderResponseSchema>;
export type DeleteReworkOrderResponse = z.infer<typeof DeleteReworkOrderResponseSchema>;
export type ReworkInitiationOptionsResponse = z.infer<typeof ReworkInitiationOptionsResponseSchema>;
export type ExtractInspectionReportImage = z.infer<typeof ExtractInspectionReportImageSchema>;
export type InspectionReportImageExtraction = z.infer<typeof InspectionReportImageExtractionSchema>;

export const ProcessPricingUnitSchema = z.enum(["piece", "hour"]);
export const ProcessExecutionKindSchema = z.enum(["worker", "tail_inspection"]);
export const ProcessConfigurationItemSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("catalog"),
    processId: IdSchema,
    // 计划数量已由尾查实物清点取代；保留该字段仅兼容历史审计结构。
    plannedQuantity: z.number().finite().positive().optional().default(1),
    pricingUnit: z.literal("piece"),
    unitPrice: z.number().finite().positive(),
    executionKind: ProcessExecutionKindSchema.optional().default("worker"),
  }).strict(),
  z.object({
    source: z.literal("custom"),
    customProcessName: z.string().trim().min(1).max(100),
    plannedQuantity: z.number().finite().positive().optional().default(1),
    pricingUnit: z.literal("piece"),
    unitPrice: z.number().finite().positive(),
    executionKind: ProcessExecutionKindSchema.optional().default("worker"),
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
  executionKind: ProcessExecutionKindSchema.optional().default("worker"),
  pricingUnit: ProcessPricingUnitSchema,
  plannedQuantity: z.number().positive(),
  // Historical configurations created before N02 pricing was mandatory may
  // still have no price. New writes remain strict in
  // ProcessConfigurationItemSchema; this nullable response only keeps those
  // immutable old orders readable.
  unitPrice: z.number().positive().nullable(),
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
    unifiedExecutionRequired: z.boolean().optional().default(false),
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

export const TailInspectionAssignmentSchema = z.object({
  assignmentId: IdSchema,
  tailInspectorUserId: IdSchema,
  tailInspectorName: z.string().min(1),
  boxScope: z.string().nullable(),
  status: z.enum(["active", "revoked"]),
  returnedQuantity: z.number().int().positive().nullable(),
  submittedAt: z.string().datetime().nullable(),
  canSubmit: z.boolean(),
}).strict();
export const TailInspectionItemSchema = z.object({
  configurationItemId: IdSchema,
  processName: z.string().min(1),
  inspectedQuantity: z.number().int().nonnegative(),
}).strict();
export const TailInspectionResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: ReworkOrderStatusSchema,
  assignments: z.array(TailInspectionAssignmentSchema),
  processes: z.array(TailInspectionItemSchema),
}).strict();
export const TailInspectionOptionsResponseSchema = z.object({
  inspectors: z.array(z.object({ userId: IdSchema, personId: IdSchema.optional(), displayName: z.string().min(1) }).strict()),
}).strict();
export const SubmitTailInspectionReportSchema = z.object({
  returnedQuantity: z.number().int().positive(),
  items: z.array(z.object({
    configurationItemId: IdSchema,
    inspectedQuantity: z.number().int().nonnegative(),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.items.map((item) => item.configurationItemId)).size !== value.items.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "Each process may be counted once" });
  }
  for (const [index, item] of value.items.entries()) {
    if (item.inspectedQuantity > value.returnedQuantity) {
      context.addIssue({ code: "custom", path: ["items", index, "inspectedQuantity"], message: "Process count cannot exceed returned quantity" });
    }
  }
});
export const TailInspectionAssignmentParamsSchema = z.object({ assignmentId: IdSchema }).strict();
export type TailInspectionResponse = z.infer<typeof TailInspectionResponseSchema>;
export type TailInspectionOptionsResponse = z.infer<typeof TailInspectionOptionsResponseSchema>;
export type SubmitTailInspectionReport = z.infer<typeof SubmitTailInspectionReportSchema>;

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
export const ConfirmWorkAssignmentsSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
}).strict();
export const CreateWorkReportSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  actualQuantity: z.number().finite().positive(),
  completedAt: z.string().datetime().optional(),
  remark: z.string().trim().min(1).max(500).optional(),
  resubmitsWorkReportId: IdSchema.optional(),
}).strict();
export const WorkTaskAssignablePeopleResponseSchema = z.object({
  people: z.array(z.object({
    personId: IdSchema,
    displayName: z.string().min(1),
    personType: z.enum(["internal", "temporary"]),
    eligibleExecutionKinds: z.array(ProcessExecutionKindSchema).min(1),
  }).strict()),
});
export const WorkTaskResponseSchema = z.object({
  workTaskId: IdSchema,
  reworkOrderId: IdSchema,
  configurationItemId: IdSchema,
  processName: z.string().min(1),
  executionKind: ProcessExecutionKindSchema.optional().default("worker"),
  pricingUnit: ProcessPricingUnitSchema,
  plannedQuantity: z.number().positive(),
  unitPrice: z.number().positive().nullable(),
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
  groupAmount: z.number().nonnegative().nullable(),
  memberShares: z.array(z.object({ personId: IdSchema, amount: z.number().nonnegative() }).strict()),
});
export const ReworkWorkTasksResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: ReworkOrderStatusSchema,
  orderVersion: z.number().int().positive(),
  tasks: z.array(WorkTaskResponseSchema),
});
export type CreateWorkTask = z.infer<typeof CreateWorkTaskSchema>;
export type ConfirmWorkAssignments = z.infer<typeof ConfirmWorkAssignmentsSchema>;
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
export const ReviewWholeOrderSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  finalQuantities: z.array(z.object({
    configurationItemId: IdSchema,
    finalConfirmedQuantity: z.number().int().positive(),
  }).strict()).min(1),
  temporaryCoefficients: z.array(z.object({
    configurationItemId: IdSchema,
    personId: IdSchema,
    multiplier: z.number().finite().positive().max(10).refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8, "Multiplier keeps at most three decimals"),
    reason: z.string().trim().min(1).max(500).optional(),
  }).strict().superRefine((value, context) => {
    if (value.multiplier !== 1 && !value.reason) {
      context.addIssue({ code: "custom", path: ["reason"], message: "Non-default multiplier requires a reason" });
    }
  })),
}).strict().superRefine((value, context) => {
  const coefficientKeys = value.temporaryCoefficients.map((item) => `${item.configurationItemId}:${item.personId}`);
  if (new Set(coefficientKeys).size !== coefficientKeys.length) {
    context.addIssue({ code: "custom", path: ["temporaryCoefficients"], message: "Temporary worker coefficients cannot contain duplicates" });
  }
  const quantityKeys = value.finalQuantities.map((item) => item.configurationItemId);
  if (new Set(quantityKeys).size !== quantityKeys.length) {
    context.addIssue({ code: "custom", path: ["finalQuantities"], message: "Final quantities cannot contain duplicates" });
  }
});
export const ReviewFinalQuantitySchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Rejection reason is required" });
  }
});
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
  canIeReview: z.boolean(),
  canAdjustQuantity: z.boolean(),
  canConfirmQuantity: z.boolean(),
  canReviewQuantityIncrease: z.boolean(),
  unifiedExecutionRequired: z.boolean().optional().default(false),
  processes: z.array(z.object({
    configurationItemId: IdSchema,
    processName: z.string().min(1),
    pricingUnit: ProcessPricingUnitSchema,
    plannedQuantity: z.number().positive(),
    completedQuantity: z.number().nonnegative(),
    tailCheckedQuantity: z.number().int().nonnegative(),
    countGap: z.number().int(),
    complete: z.boolean(),
    finalUnitPrice: z.number().positive().nullable(),
  }).strict()),
  reports: z.array(z.object({
    workReportId: IdSchema,
    workTaskId: IdSchema,
    configurationItemId: IdSchema,
    actualQuantity: z.number().positive(),
    completedAt: z.string().datetime(),
    submittedBy: IdSchema,
    assignmentMode: z.enum(["individual", "collective"]),
    executionKind: ProcessExecutionKindSchema.optional().default("worker"),
    members: z.array(z.object({ personId: IdSchema, displayName: z.string().min(1) }).strict()),
    rejected: z.boolean(),
    rejectedPersonId: IdSchema.nullable(),
    rejectionReason: z.string().nullable(),
    resubmitsWorkReportId: IdSchema.nullable(),
  }).strict()),
  adjustments: z.array(QuantityAdjustmentResponseSchema),
  temporaryWorkers: z.array(z.object({
    configurationItemId: IdSchema,
    processName: z.string().min(1),
    personId: IdSchema,
    displayName: z.string().min(1),
    multiplier: z.number().positive(),
    reason: z.string().nullable(),
  }).strict()),
  reviewId: IdSchema.nullable(),
  finalConfirmation: z.object({
    confirmationId: IdSchema,
    confirmationVersion: z.number().int().positive(),
    status: z.enum(["pending_ie_review", "approved", "rejected"]),
    confirmedBy: IdSchema,
    confirmedAt: z.string().datetime(),
    reviewedBy: IdSchema.nullable(),
    reviewedAt: z.string().datetime().nullable(),
    reviewReason: z.string().nullable(),
    quantities: z.array(z.object({
      configurationItemId: IdSchema,
      workerReportedQuantity: z.number().int().nonnegative(),
      tailReportedQuantity: z.number().int().nonnegative(),
      finalConfirmedQuantity: z.number().int().positive(),
      changed: z.boolean(),
    }).strict()),
  }).strict().nullable(),
});
export type RejectWorkReport = z.infer<typeof RejectWorkReportSchema>;
export type ReviewWholeOrder = z.infer<typeof ReviewWholeOrderSchema>;
export type ReviewFinalQuantity = z.infer<typeof ReviewFinalQuantitySchema>;
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
export const ResponsibilitySupplierOptionsResponseSchema = z.object({
  items: z.array(z.object({
    supplierId: IdSchema,
    supplierType: z.enum(["factory", "embroidery_washing", "fabric"]),
    supplierName: z.string(),
  }).strict()),
}).strict();
export const ResponsibilityAllocationInputSchema = z.object({
  responsibilityType: ResponsibilityTypeSchema,
  shareBps: z.number().int().min(0).max(10_000),
  // V2 keeps the commercial rule on the responsible party rather than on the
  // process.  The two fields stay optional at the wire level so old, immutable
  // snapshots can still be read; a V2 submission is validated by the service.
  multiplier: ResponsibilityMultiplierSchema.optional(),
  supplierId: IdSchema.nullable().optional(),
}).strict();
export const ResponsibilityProcessInputSchema = z.object({
  configurationItemId: IdSchema,
  multiplier: ResponsibilityMultiplierSchema,
  highMultiplierReason: ReasonSchema.optional(),
  allocations: z.array(ResponsibilityAllocationInputSchema).length(1),
}).strict().superRefine((value, context) => {
  if (responsibilityMultiplierScaled(value.multiplier) !== 1_000n) {
    context.addIssue({ code: "custom", path: ["multiplier"], message: "The retired responsibility coefficient must remain 1" });
  }
  if (value.highMultiplierReason !== undefined) {
    context.addIssue({ code: "custom", path: ["highMultiplierReason"], message: "The retired responsibility coefficient reason is not accepted" });
  }
  const allocation = value.allocations[0]!;
  if (allocation.shareBps !== 10_000) context.addIssue({ code: "custom", path: ["allocations", 0, "shareBps"], message: "The selected responsible party must bear 100%" });
  const multiplier = responsibilityMultiplierScaled(allocation.multiplier ?? (allocation.responsibilityType === "own_factory" ? "1.000" : "1.200"));
  if (allocation.responsibilityType === "own_factory") {
    if (multiplier !== 1_000n) context.addIssue({ code: "custom", path: ["allocations", 0, "multiplier"], message: "Own-factory responsibility multiplier must be 1" });
    if (allocation.supplierId) context.addIssue({ code: "custom", path: ["allocations", 0, "supplierId"], message: "Own-factory responsibility cannot carry a supplier" });
  } else {
    if (multiplier < 1_200n) context.addIssue({ code: "custom", path: ["allocations", 0, "multiplier"], message: "External deduction multiplier cannot be lower than 1.2" });
    if (!allocation.supplierId) context.addIssue({ code: "custom", path: ["allocations", 0, "supplierId"], message: "External responsibility requires the actual supplier" });
  }
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
  canOwnerSign: z.boolean().default(false),
  ownerSignature: z.object({
    determinationId: IdSchema,
    decision: z.enum(["approved", "rejected"]),
    signedBy: IdSchema,
    signedAt: z.string().datetime(),
    multiplierAdjustments: z.array(z.object({
      configurationItemId: IdSchema,
      responsibilityType: z.enum(["processing_factory", "embroidery_factory", "washing_factory", "fabric_supplier"]),
      multiplier: z.string(),
      reason: z.string(),
    }).strict()).default([]),
  }).strict().nullable().default(null),
  sourceProcesses: z.array(z.object({ configurationItemId: IdSchema, processName: z.string().min(1), pricingUnit: ProcessPricingUnitSchema, baseAmount: z.string() }).strict()),
  determination: z.object({ determinationId: IdSchema, version: z.number().int().positive(), stage: z.enum(["draft", "finalized"]), reason: z.string().nullable(), calculationTotal: z.string(), highMultiplierConfirmed: z.boolean(), processes: z.array(z.object({ configurationItemId: IdSchema, processName: z.string(), pricingUnit: ProcessPricingUnitSchema, multiplier: z.string(), highMultiplierReason: z.string().nullable(), baseAmount: z.string(), responsibilityAmount: z.string(), allocations: z.array(z.object({ responsibilityType: ResponsibilityTypeSchema, shareBps: z.number().int(), roundedAmount: z.string(), multiplier: z.string().default("1.000"), supplier: z.object({ supplierId: IdSchema, version: z.number().int().positive(), code: z.string(), name: z.string(), type: z.enum(["factory", "embroidery_washing", "fabric"]) }).strict().nullable().default(null) })) })) }).nullable(),
});
export const OwnerSignatureCommandSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
}).strict();
export type ResponsibilityType = z.infer<typeof ResponsibilityTypeSchema>;
export type ResponsibilitySupplierOptionsResponse = z.infer<typeof ResponsibilitySupplierOptionsResponseSchema>;
export type CreateResponsibilityDraft = z.infer<typeof CreateResponsibilityDraftSchema>;
export type FinalizeResponsibility = z.infer<typeof FinalizeResponsibilitySchema>;
export type TransferResponsibility = z.infer<typeof TransferResponsibilitySchema>;
export type TakeoverResponsibility = z.infer<typeof TakeoverResponsibilitySchema>;
export type ConfirmHighMultiplier = z.infer<typeof ConfirmHighMultiplierSchema>;
export type OwnerSignatureCommand = z.infer<typeof OwnerSignatureCommandSchema>;
export type ResponsibilityDeterminationResponse = z.infer<typeof ResponsibilityDeterminationResponseSchema>;

export const OwnFactoryApprovalParamsSchema = z.object({ approvalId: IdSchema }).strict();
export const OwnFactoryApprovalOrderParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
const OwnFactoryApprovalVersionSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedApprovalVersion: z.number().int().positive(),
}).strict();
export const ApproveOwnFactoryApprovalSchema = OwnFactoryApprovalVersionSchema.extend({
  opinion: ReasonSchema.optional(),
}).strict();
export const RejectOwnFactoryApprovalSchema = OwnFactoryApprovalVersionSchema.extend({
  opinion: ReasonSchema,
}).strict();
export const OwnFactoryApprovalDecisionSchema = z.object({
  decisionId: IdSchema,
  decision: z.enum(["approved", "rejected"]),
  actedBy: IdSchema,
  actorRoleSnapshot: z.array(z.string().min(1)).min(1),
  opinion: z.string().nullable(),
  decidedAt: z.string().datetime(),
  otherOwnersNotified: z.boolean(),
}).strict();
export const OwnFactoryApprovalSourceProcessSchema = z.object({
  configurationItemId: IdSchema,
  processName: z.string().min(1),
  pricingUnit: ProcessPricingUnitSchema,
  baseAmount: z.string(),
  responsibilityAmount: z.string(),
  multiplier: z.string(),
  ownFactoryShareBps: z.number().int().min(0).max(10_000),
  ownFactoryRoundedAmount: z.string(),
}).strict();
export const OwnFactoryApprovalSourceSnapshotSchema = z.object({
  finalizedDetermination: z.object({
    determinationId: IdSchema,
    determinationVersion: z.number().int().positive(),
    sourceOrderReviewId: IdSchema,
    calculationTotal: z.string(),
    determinedBy: IdSchema,
    highMultiplierConfirmation: z.object({
      confirmationId: IdSchema,
      confirmedBy: IdSchema,
      confirmedAt: z.string().datetime(),
      reason: z.string().min(1),
      snapshot: z.unknown(),
    }).strict().nullable(),
  }).strict(),
  qualityControl: z.object({
    initiatedBy: IdSchema,
    initiatedAt: z.string().datetime(),
  }).strict(),
  wholeOrderReview: z.object({
    orderReviewId: IdSchema,
    reviewedBy: IdSchema,
    reviewedAt: z.string().datetime(),
    reviewSnapshot: z.unknown(),
  }).strict(),
  order: z.object({
    reworkOrderId: IdSchema,
    reworkNo: z.string().nullable(),
    styleNo: z.string().nullable(),
    orderNo: z.string().nullable(),
    problemPart: z.string().nullable(),
    problemDescription: z.string().nullable(),
  }).strict(),
  processes: z.array(OwnFactoryApprovalSourceProcessSchema),
  amountLines: z.array(z.object({
    configurationItemId: IdSchema,
    workReportId: IdSchema,
    personId: IdSchema,
    baseMemberShareAmount: z.string(),
    multiplier: z.string(),
    shareBps: z.number().int().min(0).max(10_000),
    roundedAmount: z.string(),
    workerDisplayName: z.string(),
    taskMode: WorkTaskModeSchema,
    memberSnapshot: z.unknown(),
    reportSnapshot: z.unknown(),
  }).strict()),
}).strict();
export const OwnFactoryApprovalResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: ReworkOrderStatusSchema,
  orderVersion: z.number().int().positive(),
  canView: z.boolean(),
  canDecide: z.boolean(),
  approval: z.object({
    approvalId: IdSchema,
    finalizedDeterminationId: IdSchema,
    finalizedDeterminationVersion: z.number().int().positive(),
    approvalVersion: z.number().int().positive(),
    status: z.enum(["pending", "approved", "rejected"]),
    ownFactoryTotalAmount: z.string(),
    sourceSnapshot: OwnFactoryApprovalSourceSnapshotSchema,
    createdAt: z.string().datetime(),
    decision: OwnFactoryApprovalDecisionSchema.nullable(),
  }).strict().nullable(),
  history: z.array(z.object({
    approvalId: IdSchema,
    finalizedDeterminationId: IdSchema,
    finalizedDeterminationVersion: z.number().int().positive(),
    approvalVersion: z.number().int().positive(),
    status: z.enum(["pending", "approved", "rejected"]),
    ownFactoryTotalAmount: z.string(),
    createdAt: z.string().datetime(),
    decision: OwnFactoryApprovalDecisionSchema.nullable(),
  }).strict()),
}).strict();
export const OwnFactoryApprovalQueueResponseSchema = z.object({
  items: z.array(z.object({
    approvalId: IdSchema,
    reworkOrderId: IdSchema,
    reworkNo: z.string().nullable(),
    styleNo: z.string().nullable(),
    orderNo: z.string().nullable(),
    problemPart: z.string().nullable(),
    orderVersion: z.number().int().positive(),
    approvalVersion: z.number().int().positive(),
    status: z.enum(["pending", "approved", "rejected"]),
    ownFactoryTotalAmount: z.string(),
    canDecide: z.boolean(),
  }).strict()),
}).strict();
export type ApproveOwnFactoryApproval = z.infer<typeof ApproveOwnFactoryApprovalSchema>;
export type RejectOwnFactoryApproval = z.infer<typeof RejectOwnFactoryApprovalSchema>;
export type OwnFactoryApprovalResponse = z.infer<typeof OwnFactoryApprovalResponseSchema>;
export type OwnFactoryApprovalQueueResponse = z.infer<typeof OwnFactoryApprovalQueueResponseSchema>;

// PR-11 keeps the PR-09 responsibility snapshot, proposed deduction,
// financial acceptance and actual deduction ledger as independent facts.
export const ExternalResponsibilityTypeSchema = z.enum([
  "processing_factory",
  "embroidery_factory",
  "washing_factory",
  "fabric_supplier",
]);
export const ExternalResponsibilityCaseStatusSchema = z.enum([
  "pending_business_signoff",
  "pending_payables_confirmation",
  "deduction_follow_up",
  "returned",
  "pending_responsibility_revision",
  "closed",
  "superseded",
]);
export const ExternalResponsibilityBatchParamsSchema = z.object({ batchId: IdSchema }).strict();
export const ExternalResponsibilityCaseParamsSchema = z.object({ caseId: IdSchema }).strict();
export const ExternalResponsibilityRevisionParamsSchema = z.object({ requestId: IdSchema }).strict();
export const ExternalResponsibilityOrderParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
const MoneyStringSchema = z.string().regex(/^-?\d+(?:\.\d{1,2})?$/, "Amount must be a 2-decimal string");
const AttachmentIdsSchema = z.array(IdSchema).max(50).default([]).superRefine((value, context) => {
  if (new Set(value).size !== value.length) context.addIssue({ code: "custom", message: "attachmentIds cannot contain duplicates" });
});
export const AllocateExternalSuppliersSchema = z.object({
  expectedBatchVersion: z.number().int().positive(),
  allocations: z.array(z.object({
    responsibilityType: ExternalResponsibilityTypeSchema,
    supplierId: IdSchema,
    externalItemIds: z.array(IdSchema).min(1).max(100).superRefine((value, context) => {
      if (new Set(value).size !== value.length) context.addIssue({ code: "custom", message: "externalItemIds cannot contain duplicates" });
    }),
    processingFactoryOverrideReason: ReasonSchema.optional(),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  const all = value.allocations.flatMap((item) => item.externalItemIds);
  if (new Set(all).size !== all.length) context.addIssue({ code: "custom", path: ["allocations"], message: "An external item can only be assigned once" });
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
  amount: MoneyStringSchema.refine((value) => !/^-?0(?:\.0{1,2})?$/.test(value), "Amount must be non-zero"),
  deductedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  referenceNo: z.string().trim().min(1).max(200).optional(),
  attachmentIds: AttachmentIdsSchema,
  reversesEntryId: IdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.entryType === "deduction" && (value.reversesEntryId !== undefined || value.amount.startsWith("-"))) context.addIssue({ code: "custom", path: ["reversesEntryId"], message: "A deduction must be a positive new entry" });
  if (value.entryType !== "deduction" && value.reversesEntryId === undefined) context.addIssue({ code: "custom", path: ["reversesEntryId"], message: "An adjustment or reversal must reference an entry" });
});
export const CloseExternalDeductionCaseSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  result: z.enum(["full", "partial", "not_deducted"]),
  reason: ReasonSchema.optional(),
  evidenceAttachmentIds: AttachmentIdsSchema,
  remainingDifferenceDisposition: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.result === "full" && (value.reason !== undefined || value.evidenceAttachmentIds.length !== 0 || value.remainingDifferenceDisposition !== undefined)) context.addIssue({ code: "custom", message: "A full deduction cannot provide failure evidence or a remaining-difference disposition" });
  if (value.result !== "full" && (value.reason === undefined || value.evidenceAttachmentIds.length === 0 || value.remainingDifferenceDisposition === undefined)) context.addIssue({ code: "custom", message: "Partial and failed deductions require a reason, ready evidence, and a remaining-difference disposition" });
});
export const CreateExternalResponsibilityRevisionSchema = z.object({
  expectedCaseVersion: z.number().int().positive(),
  requestedChange: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, "requestedChange is required"),
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
const ExternalCaseResponseSchema = z.object({
  caseId: IdSchema,
  batchId: IdSchema,
  reworkOrderId: IdSchema,
  responsibilityType: ExternalResponsibilityTypeSchema,
  supplier: z.object({ supplierId: IdSchema, version: z.number().int().positive(), code: z.string(), name: z.string(), type: z.enum(["factory", "embroidery_washing", "fabric"]) }).strict(),
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
  canRequestRevision: z.boolean(),
  items: z.array(ExternalItemResponseSchema),
  deductions: z.array(ExternalDeductionEntryResponseSchema),
  followUps: z.array(z.object({ followUpId: IdSchema, content: z.string(), supplierFeedback: z.string().nullable(), nextFollowUpAt: z.string().datetime().nullable(), attachmentIds: z.array(IdSchema), createdBy: IdSchema, createdAt: z.string().datetime() }).strict()),
  closure: z.object({ result: z.enum(["full", "partial", "not_deducted"]), proposedAmount: z.string(), actualDeductedAmount: z.string(), remainingAmount: z.string(), reason: z.string().nullable(), evidenceAttachmentIds: z.array(IdSchema), remainingDifferenceDisposition: z.string().nullable(), closedBy: IdSchema, closedAt: z.string().datetime() }).strict().nullable(),
  canApproveRevision: z.boolean(),
  revisionRequests: z.array(z.object({ revisionRequestId: IdSchema, revisionVersion: z.number().int().positive(), status: z.enum(["pending", "approved", "rejected"]), reason: z.string(), requestedChange: z.record(z.string(), z.unknown()), requestedBy: IdSchema, decidedBy: IdSchema.nullable(), decisionReason: z.string().nullable(), createdAt: z.string().datetime(), decidedAt: z.string().datetime().nullable() }).strict()),
}).strict();
export const ExternalResponsibilityCaseResponseSchema = ExternalCaseResponseSchema;
export const ExternalResponsibilityBatchResponseSchema = z.object({
  batchId: IdSchema,
  reworkOrderId: IdSchema,
  finalizedDeterminationId: IdSchema,
  finalizedDeterminationVersion: z.number().int().positive(),
  batchVersion: z.number().int().positive(),
  status: z.enum(["active", "superseded"]),
  sourceSnapshot: z.record(z.string(), z.unknown()),
  items: z.array(ExternalItemResponseSchema),
  cases: z.array(ExternalCaseResponseSchema),
}).strict().nullable();
export const ExternalResponsibilityQueueResponseSchema = z.object({
  items: z.array(z.object({
    caseId: IdSchema, reworkOrderId: IdSchema, reworkNo: z.string().nullable(), styleNo: z.string().nullable(), orderNo: z.string().nullable(), problemPart: z.string().nullable(),
    responsibilityType: ExternalResponsibilityTypeSchema, supplierName: z.string(), status: ExternalResponsibilityCaseStatusSchema, proposedDeductionAmount: z.string(), actualDeductedAmount: z.string(), remainingAmount: z.string(), caseVersion: z.number().int().positive(), overdue: z.boolean(), canAct: z.boolean(),
  }).strict()),
}).strict();
export type AllocateExternalSuppliers = z.infer<typeof AllocateExternalSuppliersSchema>;
export type SubmitExternalResponsibilityCase = z.infer<typeof SubmitExternalResponsibilityCaseSchema>;
export type PayablesAcceptExternalResponsibilityCase = z.infer<typeof PayablesAcceptExternalResponsibilityCaseSchema>;
export type PayablesReturnExternalResponsibilityCase = z.infer<typeof PayablesReturnExternalResponsibilityCaseSchema>;
export type CreateExternalDeductionFollowUp = z.infer<typeof CreateExternalDeductionFollowUpSchema>;
export type CreateExternalDeductionEntry = z.infer<typeof CreateExternalDeductionEntrySchema>;
export type CloseExternalDeductionCase = z.infer<typeof CloseExternalDeductionCaseSchema>;
export type CreateExternalResponsibilityRevision = z.infer<typeof CreateExternalResponsibilityRevisionSchema>;
export type DecideExternalResponsibilityRevision = z.infer<typeof DecideExternalResponsibilityRevisionSchema>;
export type ExternalResponsibilityCaseResponse = z.infer<typeof ExternalResponsibilityCaseResponseSchema>;
export type ExternalResponsibilityBatchResponse = z.infer<typeof ExternalResponsibilityBatchResponseSchema>;
export type ExternalResponsibilityQueueResponse = z.infer<typeof ExternalResponsibilityQueueResponseSchema>;
