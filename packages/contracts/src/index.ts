import {QueuePageResponseFields} from './queue-page.js';
export * from './queue-page.js';
import { validationFieldLabel } from "./validation-language.js";
import { z } from "zod";
import { OtherCraftDescriptionSchema, SpecialProcessTypeSchema } from "./rework-special-process.js";
export * from "./rework-special-process.js";
export * from "./supplier-batch.js";

export * from "./wages.js";
export * from "./todos.js";
export * from "./todo-presentation.js";
export * from "./admin-audit.js";
export * from "./sourcing.js";
export * from "./contract-management.js";
export * from "./sourcing-style-identity.js";
export * from "./cutting.js";
export * from "./warehouse-access.js";
export * from "./pmc-access.js";
export * from "./samples.js";
export * from "./sample-read.js";
export * from "./sample-create.js";
export * from "./sample-workflow.js";

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
    temporaryPhoneNumber: z.string().trim().regex(/^\+?[0-9]{6,20}$/).optional(),
    temporaryIdentityNumber: z.string().trim().toUpperCase().regex(/^(?:[0-9]{15}|[0-9]{17}[0-9X])$/).optional(),
  }).strict(),
]);
export const PersonParamsSchema = z.object({ personId: IdSchema }).strict();
export const UpdateTemporaryWorkerProfileSchema = z.object({
  temporaryRemark: z.string().trim().min(1).max(100).nullable(),
  temporaryPhoneNumber: z.string().trim().regex(/^\+?[0-9]{6,20}$/).nullable(),
  temporaryIdentityNumber: z.string().trim().toUpperCase().regex(/^(?:[0-9]{15}|[0-9]{17}[0-9X])$/).nullable(),
  reason: ReasonSchema,
}).strict();
export const PersonAliasParamsSchema = z.object({ aliasId: IdSchema }).strict();
export const CreatePersonAliasSchema = z.object({
  alias: z.string().trim().min(1).max(100),
  reason: ReasonSchema,
}).strict();

export const CraftCatalogItemSchema = z.object({
  craftId: IdSchema,
  craftCode: CatalogCodeSchema,
  version: z.number().int().positive(),
  craftName: z.string().trim().min(1).max(100),
  active: z.boolean(),
  createdAt: z.string().datetime(),
});
export const CraftCatalogListResponseSchema = z.array(CraftCatalogItemSchema);
export const CraftCatalogHistoryItemSchema = CraftCatalogItemSchema.extend({
  changeReason: ReasonSchema,
  changedBy: IdSchema,
});
export const CraftCatalogHistoryResponseSchema = z.array(CraftCatalogHistoryItemSchema);
export const CraftCatalogQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  includeInactive: z.enum(["true", "false"]).optional(),
}).strict();
export const EnsureCraftsSchema = z.object({
  craftNames: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
}).strict().superRefine((value, context) => {
  const normalized = value.craftNames.map((name) => name.toLocaleLowerCase("zh-CN"));
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: "custom", path: ["craftNames"], message: "工艺不能重复" });
  }
});
export const ReviseCraftSchema = z.object({
  craftName: z.string().trim().min(1).max(100),
  active: z.boolean(),
  changeReason: ReasonSchema,
}).strict();
export const CraftParamsSchema = z.object({ craftId: IdSchema }).strict();

export const CreateProcessSchema = z.object({
  processCode: CatalogCodeSchema,
  processName: z.string().trim().min(1).max(100),
  pricingUnit: z.enum(["piece", "hour"]),
  active: z.boolean().default(true),
  changeReason: ReasonSchema,
}).strict();
export const ReviseProcessSchema = CreateProcessSchema.omit({ processCode: true });
export const ProcessParamsSchema = z.object({ processId: IdSchema }).strict();
export const ReplaceProcessDefaultWorkersSchema = z.object({
  personIds: z.array(IdSchema).max(200).refine((value) => new Set(value).size === value.length, "人员不能重复"),
  changeReason: ReasonSchema,
}).strict();

const NullableSupplierTextSchema = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength).nullable().optional();
const SupplierNotesSchema = z.string().trim().max(1_000);
const SupplierCraftsSchema = z.array(z.string().trim().min(1).max(100))
  .max(50)
  .refine((value) => new Set(value).size === value.length, "可承接工艺不能重复");

export const CreateSupplierSchema = z.object({
  supplierCode: CatalogCodeSchema,
  supplierType: z.enum(["factory", "embroidery_washing", "fabric", "other"]),
  supplierName: z.string().trim().min(1).max(200),
  active: z.boolean().default(true),
  notes: SupplierNotesSchema.default(""),
  contactPerson: NullableSupplierTextSchema(100),
  contactPhone: NullableSupplierTextSchema(50),
  address: NullableSupplierTextSchema(500),
  contractEntityName: NullableSupplierTextSchema(200),
  partyBRepresentative: NullableSupplierTextSchema(100),
  payeeName: NullableSupplierTextSchema(100),
  bankAccount: NullableSupplierTextSchema(100),
  bankName: NullableSupplierTextSchema(200),
  supportedCrafts: SupplierCraftsSchema.default([]),
  dailyCapacity: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  changeReason: ReasonSchema,
}).strict();
export const ReviseSupplierSchema = z.object({
  supplierName: z.string().trim().min(1).max(200).optional(),
  active: z.boolean().optional(),
  notes: SupplierNotesSchema.optional(),
  contactPerson: NullableSupplierTextSchema(100),
  contactPhone: NullableSupplierTextSchema(50),
  address: NullableSupplierTextSchema(500),
  contractEntityName: NullableSupplierTextSchema(200),
  partyBRepresentative: NullableSupplierTextSchema(100),
  payeeName: NullableSupplierTextSchema(100),
  bankAccount: NullableSupplierTextSchema(100),
  bankName: NullableSupplierTextSchema(200),
  supportedCrafts: SupplierCraftsSchema.optional(),
  dailyCapacity: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  expectedVersion: z.number().int().positive(),
  changeReason: ReasonSchema,
}).strict();
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
    context.addIssue({ code: "custom", path: ["scopeId"], message: `${validationFieldLabel(["scopeId"])}：全局范围不能指定关联对象，其他范围须选择关联对象` });
  }
  if (Date.parse(value.validUntil) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: `${validationFieldLabel(["validUntil"])}：有效结束时间必须晚于开始时间` });
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
export const ProcessCatalogPageQuerySchema = CatalogListQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
}).strict();
export const PeopleListQuerySchema = CatalogListQuerySchema.extend({
  includeRevokedAliases: z.enum(["true", "false"]).optional(),
}).strict();

export type AssignRole = z.infer<typeof AssignRoleSchema>;
export type CreateBusinessPerson = z.infer<typeof CreateBusinessPersonSchema>;
export type UpdateTemporaryWorkerProfile = z.infer<typeof UpdateTemporaryWorkerProfileSchema>;
export type CreatePersonAlias = z.infer<typeof CreatePersonAliasSchema>;
export type CraftCatalogItem = z.infer<typeof CraftCatalogItemSchema>;
export type CraftCatalogHistoryItem = z.infer<typeof CraftCatalogHistoryItemSchema>;
export type EnsureCrafts = z.infer<typeof EnsureCraftsSchema>;
export type ReviseCraft = z.infer<typeof ReviseCraftSchema>;
export type CreateProcess = z.infer<typeof CreateProcessSchema>;
export type ReviseProcess = z.infer<typeof ReviseProcessSchema>;
export type ReplaceProcessDefaultWorkers = z.infer<typeof ReplaceProcessDefaultWorkersSchema>;
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
export const AddTailDefectiveQuantitySchema = z.object({
  expectedVersion: z.number().int().positive(),
  quantity: z.number().int().positive().max(1_000_000),
}).strict();
export const AddIePrecountSchema = z.object({
  configurationItemId: IdSchema,
  quantity: z.number().int().positive().max(1_000_000),
  note: z.string().trim().min(1).max(200).optional(),
}).strict();

const DraftTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable().optional();
export const TailInspectionCostBearerSchema = z.enum([
  "own_factory",
  "processing_factory",
]);
export const TailInspectionCostBearerSourceSchema = z.enum([
  "legacy_default",
  "quality_inspection",
  "production_override",
]);

export const ReworkProcessingFactorySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("own_factory") }).strict(),
  z.object({ type: z.literal("supplier"), supplierId: IdSchema }).strict(),
]);
export const MAX_REWORK_ATTACHMENTS = 8;
export const REWORK_IMAGE_SUPPLEMENT_ROLES = [
  "quality_control",
  "tail_supervisor",
  "production_management",
  "owner_group",
  "order_merchandiser",
] as const;

const ReworkAttachmentIdsSchema = (minimum = 0) => z.array(IdSchema)
  .min(minimum)
  .max(MAX_REWORK_ATTACHMENTS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "附件不能重复选择" });
    }
  });

export const InspectionStageSchema = z.enum(["midline", "final", "warehouse", "reinspection"]);
export const InspectionCheckResultSchema = z.enum(["pass", "fail"]);

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TenthCentimeterSchema = z.number().finite().refine(
  (value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-8,
  "测量值须精确到0.1厘米",
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
    context.addIssue({ code: "custom", path: ["measurements"], message: `${validationFieldLabel(["measurements"])}：测量部位不能重复` });
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
    if (!content) context.addIssue({ code: "custom", path: [field], message: `${validationFieldLabel([field])}：请填写此项` });
  }
  if (!value.inspectionStage) {
    context.addIssue({ code: "custom", path: ["inspectionStage"], message: `${validationFieldLabel(["inspectionStage"])}：请填写此项` });
  }
  if (!value.sampleQuantity) {
    context.addIssue({ code: "custom", path: ["sampleQuantity"], message: `${validationFieldLabel(["sampleQuantity"])}：请填写此项` });
  }
  if (!value.inspectionDate) {
    context.addIssue({ code: "custom", path: ["inspectionDate"], message: `${validationFieldLabel(["inspectionDate"])}：请填写此项` });
  }
  if (value.sizeSamples.length === 0) {
    context.addIssue({ code: "custom", path: ["sizeSamples"], message: `${validationFieldLabel(["sizeSamples"])}：至少填写一条抽检尺码记录` });
  }
  value.sizeSamples.forEach((sample, sampleIndex) => {
    sample.measurements.forEach((measurement, measurementIndex) => {
      if (!measurement.notApplicable && (measurement.actualCm === null || measurement.deviationCm === null)) {
        context.addIssue({
          code: "custom",
          path: ["sizeSamples", sampleIndex, "measurements", measurementIndex],
          message: `${validationFieldLabel(["sizeSamples", sampleIndex, "measurements", measurementIndex])}：除不适用部位外，须填写实测值和偏差`,
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
      message: `${validationFieldLabel(["documentChecks", "exceptionReason"])}：资料缺失时须填写原因`,
    });
  }
  if (!value.fabricMatch) context.addIssue({ code: "custom", path: ["fabricMatch"], message: `${validationFieldLabel(["fabricMatch"])}：请填写此项` });
  if (value.fabricMatch === "mismatch" && !value.fabricMismatchReason) {
    context.addIssue({ code: "custom", path: ["fabricMismatchReason"], message: `${validationFieldLabel(["fabricMismatchReason"])}：请填写此项` });
  }
  if (!value.fitDecision) context.addIssue({ code: "custom", path: ["fitDecision"], message: `${validationFieldLabel(["fitDecision"])}：请填写此项` });
  if (!value.factoryPreparation) context.addIssue({ code: "custom", path: ["factoryPreparation"], message: `${validationFieldLabel(["factoryPreparation"])}：请填写此项` });
  Object.entries(value.materialChecks).forEach(([field, result]) => {
    if (!result) context.addIssue({ code: "custom", path: ["materialChecks", field], message: `${validationFieldLabel(["materialChecks", field])}：请填写此项` });
  });
  if (value.issues.length === 0) {
    context.addIssue({ code: "custom", path: ["issues"], message: `${validationFieldLabel(["issues"])}：至少填写一条问题记录` });
  }
  value.issues.forEach((issue, index) => {
    if (!issue.category) context.addIssue({ code: "custom", path: ["issues", index, "category"], message: `${validationFieldLabel(["issues", index, "category"])}：请填写此项` });
    if (!issue.description) context.addIssue({ code: "custom", path: ["issues", index, "description"], message: `${validationFieldLabel(["issues", index, "description"])}：请填写此项` });
    if (issue.majorCount + issue.minorCount === 0) {
      context.addIssue({ code: "custom", path: ["issues", index], message: `${validationFieldLabel(["issues", index])}：问题数量必须大于0` });
    }
  });
});

export const ReworkKindSchema = z.enum(["qc_rework", "inhouse_finishing"]);

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
  tailInspectionRequired: z.boolean().optional(),
  specialProcessType: SpecialProcessTypeSchema.optional(),
  otherCraftDescription: OtherCraftDescriptionSchema,
  tailInspectionCostBearer: TailInspectionCostBearerSchema.nullable().optional(),
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
export const WaiveTailInspectionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: ReasonSchema,
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
  reworkKind: ReworkKindSchema.optional(),
  receivingBatchId: IdSchema.nullable().optional(),
  originalCraftQuality: z.object({ checkId: IdSchema, unit: z.literal("片"), execution: z.enum(["internal","factory"]) }).strict().optional(),
  originalQualityReportAvailable: z.boolean().optional(),
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
  tailInspectionRequired: z.boolean().default(true),
  specialProcessType: SpecialProcessTypeSchema.nullable().optional(),
  otherCraftDescription: OtherCraftDescriptionSchema,
  tailInspectionCostBearer: TailInspectionCostBearerSchema.nullable().default(null),
  tailInspectionCostBearerSource:
    TailInspectionCostBearerSourceSchema.nullable().default(null),
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
export type ReworkKind = z.infer<typeof ReworkKindSchema>;
export type AddTailDefectiveQuantity = z.infer<typeof AddTailDefectiveQuantitySchema>;
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
export type WaiveTailInspection = z.infer<typeof WaiveTailInspectionSchema>;
export type SubmitReworkOrder = z.infer<typeof SubmitReworkOrderSchema>;
export type TransitionReworkOrder = z.infer<typeof TransitionReworkOrderSchema>;
export type ReworkOrderResponse = z.infer<typeof ReworkOrderResponseSchema>;
export type DeleteReworkOrderResponse = z.infer<typeof DeleteReworkOrderResponseSchema>;
export type ReworkInitiationOptionsResponse = z.infer<typeof ReworkInitiationOptionsResponseSchema>;
export type ExtractInspectionReportImage = z.infer<typeof ExtractInspectionReportImageSchema>;
export type InspectionReportImageExtraction = z.infer<typeof InspectionReportImageExtractionSchema>;

export const ProcessPricingUnitSchema = z.enum(["piece", "hour"]);
export const ProcessExecutionKindSchema = z.enum(["worker", "tail_inspection"]);
const ConfiguredProcessExecutionKindSchema = z.enum([...ProcessExecutionKindSchema.options,"external_craft"]);
export const ProcessConfigurationItemSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("catalog"),
    processId: IdSchema,
    // 计划数量已由整查实物清点取代；保留该字段仅兼容历史审计结构。
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
      message: `${validationFieldLabel(["plannedQuantity"])}：按件计价的计划数量必须为整数`,
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
    context.addIssue({ code: "custom", path: ["items"], message: `${validationFieldLabel(["items"])}：同一配置中每道工序只能出现一次` });
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
    context.addIssue({ code: "custom", path: ["reason"], message: `${validationFieldLabel(["reason"])}：退回时须填写原因` });
  }
});

export const ProcessConfigurationParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const ProcessConfigurationItemResponseSchema = z.object({
  specialProcessType: SpecialProcessTypeSchema.nullable().optional(),
  configurationItemId: IdSchema,
  source: z.enum(["catalog", "custom"]),
  processId: IdSchema.nullable(),
  processVersion: z.number().int().positive().nullable(),
  processName: z.string().min(1),
  executionKind: ConfiguredProcessExecutionKindSchema.optional().default("worker"),
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
  tailInspectionRequired: z.boolean().default(true),
  externalCraftOnly: z.boolean().optional(),
  specialProcessType: SpecialProcessTypeSchema.nullable().optional(),
  otherCraftDescription: OtherCraftDescriptionSchema,
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
    defaultWorkerPersonIds: z.array(IdSchema),
  }).strict()),
  tailDefaultWorkerPersonIds: z.array(IdSchema).optional(),
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
    context.addIssue({ code: "custom", path: ["items"], message: `${validationFieldLabel(["items"])}：每道工序只能计算一次` });
  }
  for (const [index, item] of value.items.entries()) {
    if (item.inspectedQuantity > value.returnedQuantity) {
      context.addIssue({ code: "custom", path: ["items", index, "inspectedQuantity"], message: `${validationFieldLabel(["items", index, "inspectedQuantity"])}：工序数量不能超过回货数量` });
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
    context.addIssue({ code: "custom", path: ["members"], message: `${validationFieldLabel(["members"])}：任务成员不能重复` });
  }
  if (value.mode === "individual" && value.members.length !== 1) {
    context.addIssue({ code: "custom", path: ["members"], message: `${validationFieldLabel(["members"])}：个人任务只能指定一名工人` });
  }
});
export const AddActiveWorkTaskMembersSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  configurationItemId: IdSchema,
  memberIds: z.array(IdSchema).min(1).max(40),
}).strict().superRefine((value, context) => {
  if (new Set(value.memberIds).size !== value.memberIds.length) {
    context.addIssue({ code: "custom", path: ["memberIds"], message: `${validationFieldLabel(["memberIds"])}：工作任务成员不能重复` });
  }
});
export const RemoveActiveWorkTaskSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
}).strict();
export const WorkTaskParamsSchema = z.object({ workTaskId: IdSchema }).strict();
export const ReworkWorkTasksParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const FrontlineTaskKindSchema = z.enum(["worker", "tail_inspection"]);
export const FrontlineTasksQuerySchema = z.object({ kind: FrontlineTaskKindSchema }).strict();
export const FrontlineTaskItemSchema = z.object({
  reworkOrderId: IdSchema,
  reworkNo: z.string().nullable(),
  styleNo: z.string().nullable(),
  orderNo: z.string().nullable(),
  images: z.array(z.object({
    attachmentId: IdSchema,
    filename: z.string().min(1),
  }).strict()),
  processNames: z.array(z.string().min(1)).min(1),
  status: z.literal("in_progress"),
}).strict();
export const FrontlineTasksResponseSchema = z.object({
  kind: FrontlineTaskKindSchema,
  items: z.array(FrontlineTaskItemSchema),
}).strict();
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
const WorkReportBatchItemSchema = CreateWorkReportSchema
  .omit({ expectedOrderVersion: true })
  .extend({ workTaskId: IdSchema })
  .strict();
export const CreateWorkReportsBatchSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  reports: z.array(WorkReportBatchItemSchema).min(1).max(200),
}).strict().superRefine((value, context) => {
  if (new Set(value.reports.map((report) => report.workTaskId)).size !== value.reports.length) {
    context.addIssue({ code: "custom", path: ["reports"], message: `${validationFieldLabel(["reports"])}：同一批次中每个工作任务只能报数一次` });
  }
});
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
  returnedReport: z.object({
    reason: z.string().min(1).max(500),
    originalQuantity: z.number().positive(),
  }).strict().optional(),
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
export const WorkReportsBatchResponseSchema = z.object({
  reworkOrderId: IdSchema,
  reworkStatus: z.enum(["in_progress", "pending_order_review"]),
  orderVersion: z.number().int().positive(),
  reports: z.array(WorkReportResponseSchema).min(1).max(200),
}).strict();
const ExternalCraftPhysicalProgressSchema = z.object({
  requiredQuantity: z.number().int().positive(),
  returnedQuantity: z.number().int().nonnegative(),
  physicalCompletedAt: z.string().datetime().nullable(),
}).strict();
export const ReworkWorkTasksResponseSchema = z.object({
  specialProcessType: SpecialProcessTypeSchema.nullable().optional(),
  otherCraftDescription: OtherCraftDescriptionSchema,
  reworkOrderId: IdSchema,
  reworkStatus: ReworkOrderStatusSchema,
  orderVersion: z.number().int().positive(),
  tasks: z.array(WorkTaskResponseSchema),
  externalRepair: ExternalCraftPhysicalProgressSchema.nullable().optional(),
});
export type CreateWorkTask = z.infer<typeof CreateWorkTaskSchema>;
export type AddActiveWorkTaskMembers = z.infer<typeof AddActiveWorkTaskMembersSchema>;
export type RemoveActiveWorkTask = z.infer<typeof RemoveActiveWorkTaskSchema>;
export type ConfirmWorkAssignments = z.infer<typeof ConfirmWorkAssignmentsSchema>;
export type CreateWorkReport = z.infer<typeof CreateWorkReportSchema>;
export type CreateWorkReportsBatch = z.infer<typeof CreateWorkReportsBatchSchema>;
export type WorkReportsBatchResponse = z.infer<typeof WorkReportsBatchResponseSchema>;
export type WorkTaskAssignablePeopleResponse = z.infer<typeof WorkTaskAssignablePeopleResponseSchema>;
export type WorkTaskResponse = z.infer<typeof WorkTaskResponseSchema>;
export type WorkReportResponse = z.infer<typeof WorkReportResponseSchema>;
export type ReworkWorkTasksResponse = z.infer<typeof ReworkWorkTasksResponseSchema>;
export type FrontlineTaskKind = z.infer<typeof FrontlineTaskKindSchema>;
export type FrontlineTaskItem = z.infer<typeof FrontlineTaskItemSchema>;
export type FrontlineTasksResponse = z.infer<typeof FrontlineTasksResponseSchema>;

export const WholeOrderReviewParamsSchema = z.object({ reworkOrderId: IdSchema }).strict();
export const WholeOrderReviewQuerySchema = z.object({ configurationItemId: IdSchema.optional() }).strict();
export const WorkReportRejectionParamsSchema = z.object({ workReportId: IdSchema }).strict();
export const RejectWorkReportSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  rejectedPersonId: IdSchema.nullable(),
  reason: ReasonSchema,
}).strict();
export const CorrectWorkReportQuantitySchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  effectiveQuantity: z.number().int().positive(),
}).strict();
export const CorrectWorkReportQuantitiesSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  configurationItemId: IdSchema,
  corrections: z.array(z.object({
    workReportId: IdSchema,
    effectiveQuantity: z.number().int().positive(),
  }).strict()).min(1).max(200),
}).strict().superRefine((value, context) => {
  const reportIds = value.corrections.map((correction) => correction.workReportId);
  if (new Set(reportIds).size !== reportIds.length) {
    context.addIssue({ code: "custom", path: ["corrections"], message: `${validationFieldLabel(["corrections"])}：同一批次中每条报数记录只能修正一次` });
  }
});
export const ReviewWholeOrderSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  processPrices: z.array(z.object({
    configurationItemId: IdSchema,
    unitPrice: z.number().finite().positive().max(99_999_999_999.999)
      .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8, "单价最多保留三位小数"),
  }).strict()).optional(),
  temporaryCoefficients: z.array(z.object({
    configurationItemId: IdSchema,
    personId: IdSchema,
    multiplier: z.number().finite().positive().max(10).refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8, "倍数最多保留三位小数"),
    reason: z.string().trim().min(1).max(500).optional(),
  }).strict().superRefine((value, context) => {
    if (value.multiplier !== 1 && !value.reason) {
      context.addIssue({ code: "custom", path: ["reason"], message: `${validationFieldLabel(["reason"])}：使用非默认倍数时须填写原因` });
    }
  })),
}).strict().superRefine((value, context) => {
  const priceIds = value.processPrices?.map((item) => item.configurationItemId) ?? [];
  if (new Set(priceIds).size !== priceIds.length) {
    context.addIssue({ code: "custom", path: ["processPrices"], message: `${validationFieldLabel(["processPrices"])}：工序单价不能重复配置` });
  }
  const coefficientKeys = value.temporaryCoefficients.map((item) => `${item.configurationItemId}:${item.personId}`);
  if (new Set(coefficientKeys).size !== coefficientKeys.length) {
    context.addIssue({ code: "custom", path: ["temporaryCoefficients"], message: `${validationFieldLabel(["temporaryCoefficients"])}：临时工系数不能重复配置` });
  }
});
export const ReviewFinalQuantitySchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: `${validationFieldLabel(["reason"])}：退回时须填写原因` });
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
    context.addIssue({ code: "custom", path: ["reason"], message: `${validationFieldLabel(["reason"])}：退回时须填写原因` });
  }
});
export const ReviewQuantityIncreaseSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedAdjustmentVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: `${validationFieldLabel(["reason"])}：退回时须填写原因` });
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
  tailInspectionRequired: z.boolean().default(true),
  specialProcessType: SpecialProcessTypeSchema.nullable().optional(),
  otherCraftDescription: OtherCraftDescriptionSchema,
  processes: z.array(z.object({
    configurationItemId: IdSchema,
    processName: z.string().min(1),
    pricingUnit: ProcessPricingUnitSchema,
    plannedQuantity: z.number().positive(),
    originalCompletedQuantity: z.number().nonnegative(),
    completedQuantity: z.number().nonnegative(),
    originalTailCheckedQuantity: z.number().int().nonnegative(),
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
    effectiveQuantity: z.number().int().positive(),
    corrected: z.boolean(),
    correctionVersion: z.number().int().positive().nullable(),
    correctedBy: IdSchema.nullable(),
    correctedAt: z.string().datetime().nullable(),
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
  externalRepair: ExternalCraftPhysicalProgressSchema.nullable().optional(),
  finalConfirmation: z.object({
    confirmationId: IdSchema,
    confirmationVersion: z.number().int().positive(),
    status: z.enum(["pending_ie_review", "approved", "rejected"]),
    confirmedBy: IdSchema,
    confirmedAt: z.string().datetime(),
    reviewedBy: IdSchema.nullable(),
    reviewedAt: z.string().datetime().nullable(),
    reviewReason: z.string().nullable(),
    externalRepair: ExternalCraftPhysicalProgressSchema.optional(),
    prices: z.array(z.object({
      configurationItemId: IdSchema,
      originalUnitPrice: z.number().positive(),
      proposedUnitPrice: z.number().positive(),
      changed: z.boolean(),
    }).strict()),
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
export type CorrectWorkReportQuantity = z.infer<typeof CorrectWorkReportQuantitySchema>;
export type CorrectWorkReportQuantities = z.infer<typeof CorrectWorkReportQuantitiesSchema>;
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
  .regex(/^(?:[1-9]\d{0,4})(?:\.\d{1,3})?$/, "责任倍数须在1至99999.999之间，最多保留三位小数")
  .refine((value) => responsibilityMultiplierScaled(value) <= 99_999_999n, "责任倍数不能超过99999.999");
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
  shareBps: z.number().int().min(1).max(10_000),
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
  allocations: z.array(ResponsibilityAllocationInputSchema).min(1).max(5),
}).strict().superRefine((value, context) => {
  if (responsibilityMultiplierScaled(value.multiplier) !== 1_000n) {
    context.addIssue({ code: "custom", path: ["multiplier"], message: `${validationFieldLabel(["multiplier"])}：已停用的责任系数必须保持为1` });
  }
  if (value.highMultiplierReason !== undefined) {
    context.addIssue({ code: "custom", path: ["highMultiplierReason"], message: `${validationFieldLabel(["highMultiplierReason"])}：已停用的责任系数不接受原因填写` });
  }
  const totalShareBps = value.allocations.reduce((sum, allocation) => sum + allocation.shareBps, 0);
  if (totalShareBps !== 10_000) {
    context.addIssue({ code: "custom", path: ["allocations"], message: `${validationFieldLabel(["allocations"])}：责任分摊比例合计必须为100%` });
  }
  const seenTypes = new Set<string>();
  value.allocations.forEach((allocation, index) => {
    if (seenTypes.has(allocation.responsibilityType)) {
      context.addIssue({ code: "custom", path: ["allocations", index, "responsibilityType"], message: `${validationFieldLabel(["allocations", index, "responsibilityType"])}：每道工序的同一责任类型只能选择一次` });
    }
    seenTypes.add(allocation.responsibilityType);
    const multiplier = responsibilityMultiplierScaled(allocation.multiplier ?? (allocation.responsibilityType === "own_factory" ? "1.000" : "1.200"));
    if (allocation.responsibilityType === "own_factory") {
      if (multiplier !== 1_000n) context.addIssue({ code: "custom", path: ["allocations", index, "multiplier"], message: `${validationFieldLabel(["allocations", index, "multiplier"])}：本厂承担的责任倍数必须为1` });
      if (allocation.supplierId) context.addIssue({ code: "custom", path: ["allocations", index, "supplierId"], message: `${validationFieldLabel(["allocations", index, "supplierId"])}：本厂承担不能关联外部供应商` });
    } else {
      if (multiplier < 1_200n) context.addIssue({ code: "custom", path: ["allocations", index, "multiplier"], message: `${validationFieldLabel(["allocations", index, "multiplier"])}：外部扣款倍数不能低于1.2` });
      if (!allocation.supplierId) context.addIssue({ code: "custom", path: ["allocations", index, "supplierId"], message: `${validationFieldLabel(["allocations", index, "supplierId"])}：外部责任须选择实际供应商` });
    }
  });
});
export const CreateResponsibilityDraftSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  expectedCurrentDeterminationVersion: z.number().int().positive().nullable(),
  handlerUserId: IdSchema,
  tailInspectionCostBearer: TailInspectionCostBearerSchema.nullable().optional(),
  reason: ReasonSchema.optional(),
  processes: z.array(ResponsibilityProcessInputSchema).min(1),
}).strict();
export const FinalizeResponsibilitySchema = z.object({ expectedOrderVersion: z.number().int().positive(), expectedCurrentDeterminationVersion: z.number().int().positive() }).strict();
export const TransferResponsibilitySchema = z.object({ expectedOrderVersion: z.number().int().positive(), expectedCurrentDeterminationVersion: z.number().int().positive().nullable(), toUserId: IdSchema, reason: ReasonSchema }).strict();
export const TakeoverResponsibilitySchema = z.object({ expectedOrderVersion: z.number().int().positive(), expectedCurrentDeterminationVersion: z.number().int().positive().nullable(), reason: ReasonSchema }).strict();
export const ConfirmHighMultiplierSchema = z.object({ expectedOrderVersion: z.number().int().positive(), expectedCurrentDeterminationVersion: z.number().int().positive(), reason: ReasonSchema }).strict();
export const ResponsibilityDeterminationResponseSchema = z.object({
  reworkOrderId: IdSchema, reworkStatus: ReworkOrderStatusSchema, orderVersion: z.number().int().positive(),
  processingFactory: ReworkProcessingFactorySchema.nullable().optional(),
  tailInspectionRequired: z.boolean().default(true),
  specialProcessType: SpecialProcessTypeSchema.nullable().optional(),
  otherCraftDescription: OtherCraftDescriptionSchema,
  tailInspectionCostBearer: TailInspectionCostBearerSchema.nullable().default(null),
  tailInspectionCostBearerSource:
    TailInspectionCostBearerSourceSchema.nullable().default(null),
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
  sourceProcesses: z.array(z.object({
    configurationItemId: IdSchema,
    processName: z.string().min(1),
    pricingUnit: ProcessPricingUnitSchema,
    executionKind: ConfiguredProcessExecutionKindSchema,
    includedInResponsibility: z.boolean(),
    baseAmount: z.string(),
  }).strict()),
  determination: z.object({ determinationId: IdSchema, version: z.number().int().positive(), stage: z.enum(["draft", "finalized"]), reason: z.string().nullable(), calculationTotal: z.string(), highMultiplierConfirmed: z.boolean(), processes: z.array(z.object({ configurationItemId: IdSchema, processName: z.string(), pricingUnit: ProcessPricingUnitSchema, multiplier: z.string(), highMultiplierReason: z.string().nullable(), baseAmount: z.string(), responsibilityAmount: z.string(), allocations: z.array(z.object({ responsibilityType: ResponsibilityTypeSchema, shareBps: z.number().int(), roundedAmount: z.string(), multiplier: z.string().default("1.000"), supplier: z.object({ supplierId: IdSchema, version: z.number().int().positive(), code: z.string(), name: z.string(), type: z.enum(["factory", "embroidery_washing", "fabric"]) }).strict().nullable().default(null) })) })) }).nullable(),
});
export const OwnerSignatureCommandSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
}).strict();
export type TailInspectionCostBearer = z.infer<typeof TailInspectionCostBearerSchema>;
export type TailInspectionCostBearerSource =
  z.infer<typeof TailInspectionCostBearerSourceSchema>;
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
  ...QueuePageResponseFields,
}).strict();
export type ApproveOwnFactoryApproval = z.infer<typeof ApproveOwnFactoryApprovalSchema>;
export type RejectOwnFactoryApproval = z.infer<typeof RejectOwnFactoryApprovalSchema>;
export type OwnFactoryApprovalResponse = z.infer<typeof OwnFactoryApprovalResponseSchema>;
export type OwnFactoryApprovalQueueResponse = z.infer<typeof OwnFactoryApprovalQueueResponseSchema>;

// External deduction requests and responses have one canonical implementation.
export * from "./external-responsibility.js";

export * from "./sourcing-production.js";
export * from "./po-delivery-dates.js";

export * from "./production-reporting.js";

export * from "./production-dashboard.js";
export * from "./production-closure.js";

export * from "./sample-disposal.js";

export * from "./sample-import.js";


export * from './sample-analysis.js';

export * from "./receiving-analysis.js";
export * from './receiving-packing-time.js';


export * from "./production-analysis.js";

export * from "./work-analysis.js";
export * from './order-responsibility-revision.js';

export type * from "./fixed-schedule-progress.js";
