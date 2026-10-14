import { requestValidationMessage } from "@dx-rework/contracts/validation-language";
import { AdminAuditEventsPageSchema, AdminAuditEventsQuerySchema, AdminAuditExportsPageSchema, AdminAuditExportsQuerySchema } from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RootAuthority } from "./access/root-authority.js";
import type { AuthUser } from "./auth/service.js";
import { ApplicationError } from "./platform/errors.js";
import type { AdminAuditService } from "./admin-audit-service.js";

const cookieToken = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((value) => value.trim())
  .find((value) => value.startsWith("dx_rework_session="))
  ?.slice("dx_rework_session=".length);

const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", requestValidationMessage(result), 400);
  return result.data;
};

export type AdminAuditHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: AdminAuditService;
  root?: Pick<RootAuthority, "isRootUser"> | undefined;
}>;

export function registerAdminAuditRoutes(app: FastifyInstance, dependencies: AdminAuditHttpDependencies): void {
  const authorize = async (request: FastifyRequest): Promise<void> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const root = await dependencies.root?.isRootUser(user.id) === true;
    if (!user.businessRoles?.length && !root) throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    const administrator = user.businessRoles?.includes("system_admin") === true && user.capabilities.includes("audit:read");
    if (!root && !administrator) {
      throw new ApplicationError("FORBIDDEN", "当前用户无权查看审计日志", 403);
    }
  };

  app.get("/admin/audit/diagnostics", async (request,reply) => {
    await authorize(request);
    reply.header("cache-control","no-store");
    return dependencies.service.diagnostics(request.query);
  });

  app.get("/admin/audit/events", async (request) => {
    await authorize(request);
    return AdminAuditEventsPageSchema.parse(await dependencies.service.events(parse(AdminAuditEventsQuerySchema, request.query)));
  });

  app.get("/admin/audit/exports", async (request) => {
    await authorize(request);
    return AdminAuditExportsPageSchema.parse(await dependencies.service.exports(parse(AdminAuditExportsQuerySchema, request.query)));
  });
}
