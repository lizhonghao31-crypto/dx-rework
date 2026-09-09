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
import { businessActor } from "./business-authority.js";
import type { EmployeeAccessService } from "./employee-access-service.js";
import type { RootAuthority } from "./root-authority.js";

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
  root: RootAuthority;
}>;

export function registerEmployeeAccessRoutes(
  app: FastifyInstance,
  dependencies: EmployeeAccessHttpDependencies,
): void {
  const authenticated = (request: FastifyRequest): Promise<AuthUser> =>
    dependencies.authenticate(cookieToken(request));

  const rootActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    if (!await dependencies.root.isRootUser(user.id)) {
      throw new ApplicationError("FORBIDDEN", "仅Root可维护员工权限", 403);
    }
    return businessActor(
      dependencies.root,
      user,
      request.id,
      "access:admin",
    );
  };

  app.get("/employee-access/employees", async (request) => {
    await rootActor(request);
    return dependencies.service.listDirectory();
  });

  app.post<{ Params: { userId: string } }>("/employee-access/employees/:userId/roles", async (request, reply) => {
    const actor = await rootActor(request);
    const params = parse(EmployeeAccessUserParamsSchema, request.params);
    const body = parse(EmployeeAccessGrantRoleSchema, request.body);
    await dependencies.root.assertProtectedRoleMutation(actor.actorId, body.roleCode);
    return reply.code(201).send(
      await dependencies.service.grantRole(actor, {
        userId: params.userId,
        roleCode: body.roleCode,
        reason: body.reason,
      }),
    );
  });

  app.delete<{ Params: { assignmentId: string } }>("/employee-access/assignments/:assignmentId", async (request, reply) => {
    const actor = await rootActor(request);
    const params = parse(EmployeeAccessAssignmentParamsSchema, request.params);
    const body = parse(EmployeeAccessReasonSchema, request.body);
    await dependencies.root.assertAssignmentMutation(actor.actorId, params.assignmentId);
    await dependencies.service.revokeRole(actor, params.assignmentId, body.reason);
    return reply.code(204).send();
  });

  app.post<{ Params: { userId: string } }>("/employee-access/employees/:userId/disable", async (request, reply) => {
    const actor = await rootActor(request);
    const params = parse(EmployeeAccessUserParamsSchema, request.params);
    const body = parse(EmployeeAccessReasonSchema, request.body);
    await dependencies.root.assertTargetAccessMutation(actor.actorId, params.userId);
    await dependencies.service.disableAccess(actor, params.userId, body.reason);
    return reply.code(204).send();
  });

  app.post<{ Params: { userId: string } }>("/employee-access/employees/:userId/restore", async (request, reply) => {
    const actor = await rootActor(request);
    const params = parse(EmployeeAccessUserParamsSchema, request.params);
    const body = parse(EmployeeAccessReasonSchema, request.body);
    await dependencies.root.assertTargetAccessMutation(actor.actorId, params.userId);
    await dependencies.service.restoreAccess(actor, params.userId, body.reason);
    return reply.code(204).send();
  });

  app.post("/employee-access/directory/sync", async (request) =>
    dependencies.service.syncDirectory(await rootActor(request)));

  app.post("/employee-access/bootstrap", async (request, reply) => {
    const user = await authenticated(request);
    const body = parse(EmployeeAccessBootstrapSchema, request.body);
    return reply.code(201).send(
      await dependencies.service.bootstrapFirstOwner(user, request.id, body),
    );
  });
}
