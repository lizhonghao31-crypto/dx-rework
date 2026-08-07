import { z } from "zod";

const IdSchema = z.string().uuid();
const RoleCodeSchema = z.string().regex(/^[a-z][a-z0-9:_-]{2,63}$/);
const ReasonSchema = z.string().trim().min(1).max(500);

export const EmployeeAccessUserParamsSchema = z.object({
  userId: IdSchema,
}).strict();

export const EmployeeAccessAssignmentParamsSchema = z.object({
  assignmentId: IdSchema,
}).strict();

export const EmployeeAccessGrantRoleSchema = z.object({
  roleCode: RoleCodeSchema,
  reason: ReasonSchema,
}).strict();

export const EmployeeAccessReasonSchema = z.object({
  reason: ReasonSchema,
}).strict();

export const EmployeeAccessBootstrapSchema = z.object({
  secret: z.string().min(32).max(1024),
  reason: ReasonSchema,
}).strict();

export const EmployeeRoleHistorySchema = z.object({
  assignmentId: IdSchema,
  roleCode: RoleCodeSchema,
  grantedAt: z.string().datetime(),
  grantedBy: IdSchema,
  grantReason: z.string().min(1).max(500),
  revokedAt: z.string().datetime().nullable(),
  revokedBy: IdSchema.nullable(),
  revokeReason: z.string().nullable(),
}).strict();

export const EmployeeAccessEmployeeSchema = z.object({
  userId: IdSchema,
  providerUserId: z.string().min(1),
  displayName: z.string().min(1),
  departments: z.array(z.string().min(1)),
  active: z.boolean(),
  employed: z.boolean(),
  enabled: z.boolean(),
  lastVerifiedAt: z.string().datetime(),
  hasLoggedIn: z.boolean(),
  businessRoles: z.array(RoleCodeSchema),
  roleHistory: z.array(EmployeeRoleHistorySchema),
}).strict();

export const EmployeeAccessDirectorySchema = z.object({
  lastDirectorySyncedAt: z.string().datetime().nullable(),
  employees: z.array(EmployeeAccessEmployeeSchema),
}).strict();

export const EmployeeAccessSyncResponseSchema = z.object({
  scanned: z.number().int().nonnegative(),
  upserted: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  syncedAt: z.string().datetime(),
}).strict();

export const EmployeeAccessRoleMutationResponseSchema = z.object({
  assignmentId: IdSchema,
}).strict();

export const EmployeeAccessBootstrapResponseSchema = z.object({
  assignmentId: IdSchema,
}).strict();

export type EmployeeAccessGrantRole = z.infer<typeof EmployeeAccessGrantRoleSchema>;
export type EmployeeAccessReason = z.infer<typeof EmployeeAccessReasonSchema>;
export type EmployeeAccessBootstrap = z.infer<typeof EmployeeAccessBootstrapSchema>;
export type EmployeeRoleHistory = z.infer<typeof EmployeeRoleHistorySchema>;
export type EmployeeAccessEmployee = z.infer<typeof EmployeeAccessEmployeeSchema>;
export type EmployeeAccessDirectory = z.infer<typeof EmployeeAccessDirectorySchema>;
export type EmployeeAccessSyncResponse = z.infer<typeof EmployeeAccessSyncResponseSchema>;
export type EmployeeAccessRoleMutationResponse = z.infer<typeof EmployeeAccessRoleMutationResponseSchema>;
export type EmployeeAccessBootstrapResponse = z.infer<typeof EmployeeAccessBootstrapResponseSchema>;
