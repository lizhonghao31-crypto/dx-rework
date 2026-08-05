import { z } from "zod";

const IdSchema = z.string().uuid();
const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]{8,512}$/);
const LimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const DateTimeSchema = z.string().datetime({ offset: true });

export const AdminAuditEventsQuerySchema = z.object({
  from: DateTimeSchema.optional(),
  to: DateTimeSchema.optional(),
  actorId: IdSchema.optional(),
  action: z.string().min(1).max(128).optional(),
  entityType: z.string().min(1).max(128).optional(),
  entityId: z.string().min(1).max(200).optional(),
  authorizationCapability: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  cursor: CursorSchema.optional(),
  limit: LimitSchema,
}).strict();

export const AdminAuditExportsQuerySchema = z.object({
  from: DateTimeSchema.optional(),
  to: DateTimeSchema.optional(),
  actorId: IdSchema.optional(),
  exportType: z.string().min(1).max(128).optional(),
  reportType: z.string().min(1).max(128).optional(),
  cursor: CursorSchema.optional(),
  limit: LimitSchema,
}).strict();

const JsonValueSchema: z.ZodType<unknown> = z.unknown();

export const AdminAuditEventSchema = z.object({
  eventId: IdSchema,
  requestId: z.string(),
  actorId: IdSchema,
  actorDisplayName: z.string().nullable(),
  actorRoles: z.array(z.string()),
  authorizationCapability: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  beforeState: JsonValueSchema.nullable(),
  afterState: JsonValueSchema.nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const AdminAuditEventsPageSchema = z.object({
  items: z.array(AdminAuditEventSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const AdminAuditExportSchema = AdminAuditEventSchema.extend({
  exportType: z.string().nullable(),
  reportType: z.string().nullable(),
}).strict();

export const AdminAuditExportsPageSchema = z.object({
  items: z.array(AdminAuditExportSchema),
  nextCursor: z.string().nullable(),
}).strict();

export type AdminAuditEventsQuery = z.infer<typeof AdminAuditEventsQuerySchema>;
export type AdminAuditExportsQuery = z.infer<typeof AdminAuditExportsQuerySchema>;
export type AdminAuditEvent = z.infer<typeof AdminAuditEventSchema>;
export type AdminAuditEventsPage = z.infer<typeof AdminAuditEventsPageSchema>;
export type AdminAuditExport = z.infer<typeof AdminAuditExportSchema>;
export type AdminAuditExportsPage = z.infer<typeof AdminAuditExportsPageSchema>;
