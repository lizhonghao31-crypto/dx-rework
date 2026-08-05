import { z } from "zod";

const IdSchema = z.string().uuid();
const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]{8,512}$/);
const LimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const DateTimeSchema = z.string().datetime({ offset: true });
const OptionalEntityIdSchema = z.string().min(1).max(200).optional();
const TextFilterSchema = z.string().min(1).max(128);
const JsonValueSchema: z.ZodType<unknown> = z.unknown();

export const AdminAttachmentsQuerySchema = z.object({
  attachmentId: IdSchema.optional(),
  uploadedBy: IdSchema.optional(),
  entityType: TextFilterSchema.optional(),
  entityId: OptionalEntityIdSchema,
  status: z.enum(["pending", "ready", "rejected"]).optional(),
  mimeType: z.string().min(1).max(120).optional(),
  from: DateTimeSchema.optional(),
  to: DateTimeSchema.optional(),
  cursor: CursorSchema.optional(),
  limit: LimitSchema,
}).strict();

export const AdminAttachmentSchema = z.object({
  attachmentId: IdSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.string(),
  sha256: z.string(),
  uploadedBy: IdSchema,
  uploaderDisplayName: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  status: z.enum(["pending", "ready", "rejected"]),
  rejectionReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  readyAt: z.string().datetime().nullable(),
}).strict();

export const AdminAttachmentsPageSchema = z.object({ items: z.array(AdminAttachmentSchema), nextCursor: z.string().nullable() }).strict();

export const AdminDelegationsQuerySchema = z.object({
  grantorUserId: IdSchema.optional(),
  granteeUserId: IdSchema.optional(),
  capability: TextFilterSchema.optional(),
  scopeType: TextFilterSchema.optional(),
  scopeId: OptionalEntityIdSchema,
  activeAt: DateTimeSchema.optional(),
  includeRevoked: z.coerce.boolean().default(false),
  cursor: CursorSchema.optional(),
  limit: LimitSchema,
}).strict();

const UserRefSchema = z.object({ userId: IdSchema, displayName: z.string().nullable() }).strict();
export const AdminDelegationSchema = z.object({
  delegationId: IdSchema,
  grantor: UserRefSchema,
  grantee: UserRefSchema,
  capability: z.string(),
  scopeType: z.string(),
  scopeId: z.string().nullable(),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime(),
  grantedBy: IdSchema,
  grantReason: z.string(),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  revokedBy: IdSchema.nullable(),
  revokeReason: z.string().nullable(),
  effectiveNow: z.boolean(),
}).strict();
export const AdminDelegationsPageSchema = z.object({ items: z.array(AdminDelegationSchema), nextCursor: z.string().nullable() }).strict();

export const AdminExceptionsQuerySchema = z.object({
  exceptionType: TextFilterSchema.optional(),
  sourceEntityType: TextFilterSchema.optional(),
  retryable: z.coerce.boolean().optional(),
  cursor: CursorSchema.optional(),
  limit: LimitSchema,
}).strict();

export const AdminExceptionSchema = z.object({
  exceptionType: z.string(),
  sourceEntityType: z.string(),
  sourceEntityId: z.string(),
  status: z.string(),
  occurredAt: z.string().datetime(),
  lastUpdatedAt: z.string().datetime(),
  safeError: z.string().nullable(),
  retryable: z.boolean(),
  deepLink: z.string().nullable(),
  details: JsonValueSchema,
}).strict();
export const AdminExceptionsPageSchema = z.object({ items: z.array(AdminExceptionSchema), nextCursor: z.string().nullable() }).strict();

export const AdminExceptionRetryParamsSchema = z.object({ exceptionType: TextFilterSchema, sourceEntityId: z.string().min(1).max(200) }).strict();
export const AdminExceptionRetryBodySchema = z.object({ expectedVersion: z.coerce.number().int().min(0), reason: z.string().min(1).max(500) }).strict();
export const AdminExceptionRetryResponseSchema = z.object({ retried: z.boolean(), exceptionType: z.string(), sourceEntityId: z.string(), operationEventId: IdSchema.nullable(), status: z.string() }).strict();

export type AdminAttachmentsQuery = z.infer<typeof AdminAttachmentsQuerySchema>;
export type AdminAttachment = z.infer<typeof AdminAttachmentSchema>;
export type AdminAttachmentsPage = z.infer<typeof AdminAttachmentsPageSchema>;
export type AdminDelegationsQuery = z.infer<typeof AdminDelegationsQuerySchema>;
export type AdminDelegation = z.infer<typeof AdminDelegationSchema>;
export type AdminDelegationsPage = z.infer<typeof AdminDelegationsPageSchema>;
export type AdminExceptionsQuery = z.infer<typeof AdminExceptionsQuerySchema>;
export type AdminException = z.infer<typeof AdminExceptionSchema>;
export type AdminExceptionsPage = z.infer<typeof AdminExceptionsPageSchema>;
export type AdminExceptionRetryBody = z.infer<typeof AdminExceptionRetryBodySchema>;
export type AdminExceptionRetryResponse = z.infer<typeof AdminExceptionRetryResponseSchema>;
