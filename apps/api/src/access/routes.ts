import {
  AssignRoleSchema,
  CatalogListQuerySchema,
  CreateBusinessPersonSchema,
  CreateDelegationSchema,
  CreatePersonAliasSchema,
  CreateProcessSchema,
  CreateSupplierSchema,
  DelegationParamsSchema,
  DelegationsQuerySchema,
  PeopleListQuerySchema,
  ProcessParamsSchema,
  PersonAliasParamsSchema,
  PersonParamsSchema,
  ReviseProcessSchema,
  ReviseSupplierSchema,
  RevokeAccessSchema,
  RoleAssignmentParamsSchema,
  RoleAssignmentsQuerySchema,
  SupplierParamsSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { RootAuthority } from "./root-authority.js";
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
  root: RootAuthority;
}>;

export function registerAccessRoutes(app: FastifyInstance, dependencies: AccessHttpDependencies): void {
  const authenticated = (request: FastifyRequest): Promise<AuthUser> =>
    dependencies.authenticate(cookieToken(request));

  const actor = async (request: FastifyRequest, capability: string): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    const isRoot = await dependencies.root.isRootUser(user.id);
    if (!user.businessRoles?.length && !isRoot) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    const rootManagedCapability = capability === "access:admin"
      || capability === "master_data:manage";
    if (!user.capabilities.includes(capability) && !(isRoot && rootManagedCapability)) {
      throw new ApplicationError("FORBIDDEN", "无权执行该操作", 403);
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles ?? [],
      authorizationCapability: capability,
      requestId: request.id,
    };
  };

  const roleManager = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    const isRoot = await dependencies.root.isRootUser(user.id);
    if (!isRoot && user.businessRoles?.includes("owner_group") !== true) {
      throw new ApplicationError("FORBIDDEN", "仅老板或超级用户可管理业务角色", 403);
    }
    if (!isRoot && !user.capabilities.includes("access:admin")) {
      throw new ApplicationError("FORBIDDEN", "无权执行该操作", 403);
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles ?? [],
      authorizationCapability: "access:admin",
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
      isRoot: await dependencies.root.isRootUser(user.id),
    };
  });

  app.get("/access/roles", async (request) => {
    const accessActor = await roleManager(request);
    return dependencies.root.filterAssignableRoles(
      accessActor.actorId,
      await dependencies.service.listRoles(),
    );
  });

  app.get("/access/role-assignments", async (request) => {
    await roleManager(request);
    const query = parse(RoleAssignmentsQuerySchema, request.query);
    return dependencies.service.listRoleAssignments({
      ...(query.userId ? { userId: query.userId } : {}),
      includeRevoked: query.includeRevoked === "true",
    });
  });

  app.get("/access/delegations", async (request) => {
    await actor(request, "delegation:manage");
    const query = parse(DelegationsQuerySchema, request.query);
    return dependencies.service.listDelegations({
      ...(query.userId ? { userId: query.userId } : {}),
      includeRevoked: query.includeRevoked === "true",
    });
  });

  app.get("/master-data/people", async (request) => {
    await actor(request, "people:read");
    const query = parse(PeopleListQuerySchema, request.query);
    return dependencies.service.listPeople({
      includeInactive: query.includeInactive === "true",
      includeRevokedAliases: query.includeRevokedAliases === "true",
    });
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

  app.post("/access/role-assignments", async (request, reply) => {
    const accessActor = await roleManager(request);
    const input = parse(AssignRoleSchema, request.body);
    await dependencies.root.assertProtectedRoleMutation(accessActor.actorId, input.roleCode);
    return reply.code(201).send(
      await dependencies.service.assignRole(accessActor, input),
    );
  });

  app.delete<{ Params: { assignmentId: string } }>("/access/role-assignments/:assignmentId", async (request, reply) => {
    const input = parse(RoleAssignmentParamsSchema, request.params);
    const body = parse(RevokeAccessSchema, request.body);
    const accessActor = await roleManager(request);
    await dependencies.root.assertAssignmentMutation(accessActor.actorId, input.assignmentId);
    await dependencies.service.revokeRole(accessActor, input.assignmentId, body.reason);
    return reply.code(204).send();
  });

  app.post("/master-data/people", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.createPerson(
        await actor(request, "master_data:manage"),
        parse(CreateBusinessPersonSchema, request.body),
      ),
    ));

  app.post<{ Params: { personId: string } }>("/master-data/people/:personId/aliases", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.addPersonAlias(
        await actor(request, "master_data:manage"),
        parse(PersonParamsSchema, request.params).personId,
        parse(CreatePersonAliasSchema, request.body),
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

  app.delete<{ Params: { personId: string } }>("/master-data/people/:personId", async (request, reply) => {
    const input = parse(PersonParamsSchema, request.params);
    const body = parse(RevokeAccessSchema, request.body);
    await dependencies.service.deactivatePerson(
      await actor(request, "master_data:manage"),
      input.personId,
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