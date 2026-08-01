import {
  AssignRoleSchema,
  CatalogListQuerySchema,
  CreateBusinessPersonSchema,
  CreateDelegationSchema,
  CreateProcessSchema,
  CreateSupplierSchema,
  DelegationParamsSchema,
  ProcessParamsSchema,
  PersonAliasParamsSchema,
  ReviseProcessSchema,
  ReviseSupplierSchema,
  RevokeAccessSchema,
  RoleAssignmentParamsSchema,
  SupplierParamsSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { AccessMasterDataService } from "./service.js";

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

export type AccessHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: AccessMasterDataService;
}>;

export function registerAccessRoutes(app: FastifyInstance, dependencies: AccessHttpDependencies): void {
  const authenticated = (request: FastifyRequest): Promise<AuthUser> =>
    dependencies.authenticate(cookieToken(request));

  const actor = async (request: FastifyRequest, capability: string): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    if (!user.businessRoles?.length) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!user.capabilities.includes(capability)) {
      throw new ApplicationError("FORBIDDEN", "无权执行该操作", 403);
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles,
      authorizationCapability: capability,
      requestId: request.id,
    };
  };

  app.get("/access/me", async (request) => {
    const user = await authenticated(request);
    return {
      userId: user.id,
      displayName: user.displayName,
      businessRoles: user.businessRoles ?? [],
      capabilities: user.capabilities,
    };
  });

  app.get("/access/roles", async (request) => {
    await actor(request, "access:admin");
    return dependencies.service.listRoles();
  });

  app.get("/master-data/people", async (request) => {
    await actor(request, "people:read");
    const query = parse(CatalogListQuerySchema, request.query);
    return dependencies.service.listPeople(query.includeInactive === "true");
  });

  app.get("/master-data/processes", async (request) => {
    await actor(request, "process_catalog:read");
    const query = parse(CatalogListQuerySchema, request.query);
    return dependencies.service.listProcesses(query.includeInactive === "true");
  });

  app.get("/master-data/suppliers", async (request) => {
    await actor(request, "supplier_catalog:read");
    const query = parse(CatalogListQuerySchema, request.query);
    return dependencies.service.listSuppliers(query.includeInactive === "true");
  });

  app.post("/access/role-assignments", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.assignRole(
        await actor(request, "access:admin"),
        parse(AssignRoleSchema, request.body),
      ),
    ));

  app.delete<{ Params: { assignmentId: string } }>("/access/role-assignments/:assignmentId", async (request, reply) => {
    const input = parse(RoleAssignmentParamsSchema, request.params);
    const body = parse(RevokeAccessSchema, request.body);
    await dependencies.service.revokeRole(await actor(request, "access:admin"), input.assignmentId, body.reason);
    return reply.code(204).send();
  });

  app.post("/master-data/people", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.createPerson(
        await actor(request, "master_data:manage"),
        parse(CreateBusinessPersonSchema, request.body),
      ),
    ));

  app.delete<{ Params: { aliasId: string } }>("/master-data/people/aliases/:aliasId", async (request, reply) => {
    const input = parse(PersonAliasParamsSchema, request.params);
    const body = parse(RevokeAccessSchema, request.body);
    await dependencies.service.revokePersonAlias(
      await actor(request, "master_data:manage"),
      input.aliasId,
      body.reason,
    );
    return reply.code(204).send();
  });

  app.post("/master-data/processes", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.createProcess(
        await actor(request, "master_data:manage"),
        parse(CreateProcessSchema, request.body),
      ),
    ));

  app.post<{ Params: { processId: string } }>("/master-data/processes/:processId/versions", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.reviseProcess(
        await actor(request, "master_data:manage"),
        parse(ProcessParamsSchema, request.params).processId,
        parse(ReviseProcessSchema, request.body),
      ),
    ));

  app.post("/master-data/suppliers", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.createSupplier(
        await actor(request, "master_data:manage"),
        parse(CreateSupplierSchema, request.body),
      ),
    ));

  app.post<{ Params: { supplierId: string } }>("/master-data/suppliers/:supplierId/versions", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.reviseSupplier(
        await actor(request, "master_data:manage"),
        parse(SupplierParamsSchema, request.params).supplierId,
        parse(ReviseSupplierSchema, request.body),
      ),
    ));

  app.post("/access/delegations", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.createDelegation(
        await actor(request, "delegation:manage"),
        parse(CreateDelegationSchema, request.body),
      ),
    ));

  app.delete<{ Params: { delegationId: string } }>("/access/delegations/:delegationId", async (request, reply) => {
    const input = parse(DelegationParamsSchema, request.params);
    const body = parse(RevokeAccessSchema, request.body);
    await dependencies.service.revokeDelegation(await actor(request, "delegation:manage"), input.delegationId, body.reason);
    return reply.code(204).send();
  });
}
