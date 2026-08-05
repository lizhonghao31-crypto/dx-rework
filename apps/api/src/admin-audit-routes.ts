import { AdminAuditEventsPageSchema, AdminAuditEventsQuerySchema, AdminAuditExportsPageSchema, AdminAuditExportsQuerySchema } from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "./auth/service.js";
import { ApplicationError } from "./platform/errors.js";
import type { AdminAuditService } from "./admin-audit-service.js";

const cookieToken = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((value) => value.trim())
  .find((value) => value.startsWith("dx_rework_session="))
  ?.slice("dx_rework_session=".length);

const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400);
  return result.data;
};

export type AdminAuditHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: AdminAuditService;
}>;

export function registerAdminAuditRoutes(app: FastifyInstance, dependencies: AdminAuditHttpDependencies): void {
  const authorize = async (request: FastifyRequest): Promise<void> => {
    const user = await dependencies.authenticate(cookieToken(request));
    if (!user.businessRoles?.length) throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    if (!user.capabilities.includes("audit:read") || !user.businessRoles.includes("system_admin")) {
      throw new ApplicationError("FORBIDDEN", "Current user lacks audit read capability", 403);
    }
  };

  app.get("/admin/audit/events", async (request) => {
    await authorize(request);
    return AdminAuditEventsPageSchema.parse(await dependencies.service.events(parse(AdminAuditEventsQuerySchema, request.query)));
  });

  app.get("/admin/audit/exports", async (request) => {
    await authorize(request);
    return AdminAuditExportsPageSchema.parse(await dependencies.service.exports(parse(AdminAuditExportsQuerySchema, request.query)));
  });
}
