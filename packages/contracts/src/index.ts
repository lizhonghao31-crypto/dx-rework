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

const PersonBaseSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  aliases: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});
export const CreateBusinessPersonSchema = z.discriminatedUnion("personType", [
  PersonBaseSchema.extend({ personType: z.literal("internal"), appUserId: IdSchema }).strict(),
  PersonBaseSchema.extend({ personType: z.literal("temporary") }).strict(),
]);
export const PersonParamsSchema = z.object({ personId: IdSchema }).strict();

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
export const CatalogListQuerySchema = z.object({
  includeInactive: z.enum(["true", "false"]).optional(),
}).strict();

export type AssignRole = z.infer<typeof AssignRoleSchema>;
export type CreateBusinessPerson = z.infer<typeof CreateBusinessPersonSchema>;
export type CreateProcess = z.infer<typeof CreateProcessSchema>;
export type ReviseProcess = z.infer<typeof ReviseProcessSchema>;
export type CreateSupplier = z.infer<typeof CreateSupplierSchema>;
export type ReviseSupplier = z.infer<typeof ReviseSupplierSchema>;
export type CreateDelegation = z.infer<typeof CreateDelegationSchema>;
