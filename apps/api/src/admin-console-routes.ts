import { AdminAttachmentsPageSchema, AdminAttachmentsQuerySchema, AdminDelegationsPageSchema, AdminDelegationsQuerySchema, AdminExceptionRetryBodySchema, AdminExceptionRetryParamsSchema, AdminExceptionRetryResponseSchema, AdminExceptionsPageSchema, AdminExceptionsQuerySchema } from "@dx-rework/contracts/admin-console";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "./auth/service.js";
import { ApplicationError } from "./platform/errors.js";
import type { AdminConsoleService } from "./admin-console-service.js";
import type { TrustedActorContext } from "./tools/repositories.js";

const cookieToken = (request: FastifyRequest): string | undefined => request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400); return result.data; };

export type AdminConsoleHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: AdminConsoleService;
}>;

const requireCapability = (user: AuthUser, capability: "admin:read" | "admin:exception:manage"): void => {
  if (!user.businessRoles?.length) throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
  if (!user.capabilities.includes(capability) || !user.businessRoles.includes("system_admin")) throw new ApplicationError("FORBIDDEN", "Current user lacks administrator capability", 403);
};

export function registerAdminConsoleRoutes(app: FastifyInstance, dependencies: AdminConsoleHttpDependencies): void {
  const authorizeRead = async (request: FastifyRequest): Promise<AuthUser> => {
    const user = await dependencies.authenticate(cookieToken(request));
    requireCapability(user, "admin:read");
    return user;
  };
  const authorizeManage = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    requireCapability(user, "admin:exception:manage");
    return { actorId: user.id, actorRoles: user.businessRoles ?? [], authorizationCapability: "admin:exception:manage", authorizationCapabilities: user.capabilities, requestId: request.id };
  };

  app.get("/admin/attachments", async (request) => {
    await authorizeRead(request);
    return AdminAttachmentsPageSchema.parse(await dependencies.service.attachments(parse(AdminAttachmentsQuerySchema, request.query)));
  });

  app.get<{ Params: { attachmentId: string } }>("/admin/attachments/:attachmentId/download", async () => {
    // Administrator download intentionally does not exist in batch 2; callers must use /tools/attachments/:id/download and its existing business authorization.
    throw new ApplicationError("FORBIDDEN", "Administrators cannot bypass existing attachment download authorization", 403);
  });

  app.delete("/admin/attachments/:attachmentId", async () => { throw new ApplicationError("FORBIDDEN", "Administrators cannot delete attachments", 403); });
  app.patch("/admin/attachments/:attachmentId", async () => { throw new ApplicationError("FORBIDDEN", "Administrators cannot modify attachment facts", 403); });

  app.get("/admin/delegations", async (request) => {
    await authorizeRead(request);
    return AdminDelegationsPageSchema.parse(await dependencies.service.delegations(parse(AdminDelegationsQuerySchema, request.query)));
  });
  app.post("/admin/delegations", async () => { throw new ApplicationError("FORBIDDEN", "Administrators cannot create delegated authorizations from this console", 403); });
  app.delete("/admin/delegations/:delegationId", async () => { throw new ApplicationError("FORBIDDEN", "Administrators cannot revoke delegated authorizations from this console", 403); });

  app.get("/admin/exceptions", async (request) => {
    await authorizeRead(request);
    return AdminExceptionsPageSchema.parse(await dependencies.service.exceptions(parse(AdminExceptionsQuerySchema, request.query)));
  });

  app.post<{ Params: { exceptionType: string; sourceEntityId: string } }>("/admin/exceptions/:exceptionType/:sourceEntityId/retry", async (request) => {
    const actor = await authorizeManage(request);
    const params = parse(AdminExceptionRetryParamsSchema, request.params);
    const body = parse(AdminExceptionRetryBodySchema, request.body);
    const idempotencyKey = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    if (!idempotencyKey) throw new ApplicationError("VALIDATION_ERROR", "Idempotency-Key header is required", 400);
    return AdminExceptionRetryResponseSchema.parse(await dependencies.service.retry(actor, params.exceptionType, params.sourceEntityId, body, idempotencyKey));
  });
}
