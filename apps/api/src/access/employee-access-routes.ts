import {
  EmployeeAccessAssignmentParamsSchema,
  EmployeeAccessBootstrapSchema,
  EmployeeAccessGrantRoleSchema,
  EmployeeAccessReasonSchema,
  EmployeeAccessUserParamsSchema,
} from "@dx-rework/contracts/employee-access";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { EmployeeAccessService } from "./employee-access-service.js";

const cookieToken = (request: FastifyRequest): string | undefined =>
  request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("dx_rework_session="))
    ?.slice("dx_rework_session=".length);

const parse = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400);
  return result.data;
};

export type EmployeeAccessHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: EmployeeAccessService;
}>;

export function registerEmployeeAccessRoutes(
  app: FastifyInstance,
  dependencies: EmployeeAccessHttpDependencies,
): void {
  const authenticated = (request: FastifyRequest): Promise<AuthUser> =>
    dependencies.authenticate(cookieToken(request));

  const ownerActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    if (
      user.businessRoles?.includes("owner_group") !== true
      || !user.capabilities.includes("access:admin")
    ) {
      throw new ApplicationError("FORBIDDEN", "仅老板权限组可维护员工权限", 403);
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles,
      authorizationCapability: "access:admin",
      requestId: request.id,
    };
  };

  app.get("/employee-access/employees", async (request) => {
    await ownerActor(request);
    return dependencies.service.listDirectory();
  });

  app.post<{ Params: { userId: string } }>("/employee-access/employees/:userId/roles", async (request, reply) => {
    const actor = await ownerActor(request);
    const params = parse(EmployeeAccessUserParamsSchema, request.params);
    const body = parse(EmployeeAccessGrantRoleSchema, request.body);
    return reply.code(201).send(
      await dependencies.service.grantRole(actor, {
        userId: params.userId,
        roleCode: body.roleCode,
        reason: body.reason,
      }),
    );
  });

  app.delete<{ Params: { assignmentId: string } }>("/employee-access/assignments/:assignmentId", async (request, reply) => {
    const actor = await ownerActor(request);
    const params = parse(EmployeeAccessAssignmentParamsSchema, request.params);
    const body = parse(EmployeeAccessReasonSchema, request.body);
    await dependencies.service.revokeRole(actor, params.assignmentId, body.reason);
    return reply.code(204).send();
  });

  app.post<{ Params: { userId: string } }>("/employee-access/employees/:userId/disable", async (request, reply) => {
    const actor = await ownerActor(request);
    const params = parse(EmployeeAccessUserParamsSchema, request.params);
    const body = parse(EmployeeAccessReasonSchema, request.body);
    await dependencies.service.disableAccess(actor, params.userId, body.reason);
    return reply.code(204).send();
  });

  app.post<{ Params: { userId: string } }>("/employee-access/employees/:userId/restore", async (request, reply) => {
    const actor = await ownerActor(request);
    const params = parse(EmployeeAccessUserParamsSchema, request.params);
    const body = parse(EmployeeAccessReasonSchema, request.body);
    await dependencies.service.restoreAccess(actor, params.userId, body.reason);
    return reply.code(204).send();
  });

  app.post("/employee-access/directory/sync", async (request) =>
    dependencies.service.syncDirectory(await ownerActor(request)));

  app.post("/employee-access/bootstrap", async (request, reply) => {
    const user = await authenticated(request);
    const body = parse(EmployeeAccessBootstrapSchema, request.body);
    return reply.code(201).send(
      await dependencies.service.bootstrapFirstOwner(user, request.id, body),
    );
  });
}
