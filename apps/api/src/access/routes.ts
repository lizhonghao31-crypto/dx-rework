import {
  AssignRoleSchema,
  CatalogListQuerySchema,
  CraftCatalogQuerySchema,
  CraftParamsSchema,
  ConfirmWorkAssignmentsSchema,
  CreateBusinessPersonSchema,
  CreateDelegationSchema,
  CreatePersonAliasSchema,
  CreateProcessSchema,
  CreateSupplierSchema,
  DelegationParamsSchema,
  EnsureCraftsSchema,
  DelegationsQuerySchema,
  IdempotencyKeySchema,
  PeopleListQuerySchema,
  ProcessCatalogPageQuerySchema,
  ProcessParamsSchema,
  ReplaceProcessDefaultWorkersSchema,
  PersonAliasParamsSchema,
  PersonParamsSchema,
  ReviseCraftSchema,
  ReviseProcessSchema,
  ReviseSupplierSchema,
  RevokeAccessSchema,
  RoleAssignmentParamsSchema,
  RoleAssignmentsQuerySchema,
  SupplierParamsSchema,
  SupplierBatchPreviewSchema,
  SupplierBatchApplySchema,
  UpdateTemporaryWorkerProfileSchema,
  WorkTaskParamsSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ROOT_ACTOR_ROLE } from "./business-authority.js";
import type { RootAuthority } from "./root-authority.js";
import type { AccessMasterDataService } from "./service.js";
import { supplierBatchTemplate } from "./supplier-batch-template.js";

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

const idempotencyKey = (request: FastifyRequest): string =>
  parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

type AssignmentCorrectionService = Readonly<{
  removeWorkAssignment(
    actor: TrustedActorContext,
    workTaskId: string,
    expectedOrderVersion: number,
    key: string,
  ): Promise<{ reused: boolean }>;
}>;

export type AccessHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: AccessMasterDataService & Partial<AssignmentCorrectionService>;
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
    if (!user.capabilities.includes(capability) && !isRoot) {
      throw new ApplicationError("FORBIDDEN", "无权执行该操作", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    if (isRoot && !actorRoles.includes(ROOT_ACTOR_ROLE)) actorRoles.push(ROOT_ACTOR_ROLE);
    const authorizationCapabilities = [...user.capabilities];
    if (isRoot && !authorizationCapabilities.includes(capability)) {
      authorizationCapabilities.push(capability);
    }
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: capability,
      authorizationCapabilities,
      requestId: request.id,
    };
  };

  const supplierReadAccess = async (request: FastifyRequest): Promise<{
    includeContractData: boolean;
  }> => {
    const user = await authenticated(request);
    const isRoot = await dependencies.root.isRootUser(user.id);
    if (!user.businessRoles?.length && !isRoot) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    const canReadProfile = user.capabilities.includes("supplier_profile:read")
      || user.capabilities.includes("supplier_catalog:read");
    if (!canReadProfile && !isRoot) {
      throw new ApplicationError("FORBIDDEN", "无权查看供应商资料", 403);
    }
    return {
      includeContractData: isRoot || user.capabilities.includes("supplier_contract_data:read"),
    };
  };

  const supplierWriteActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    const isRoot = await dependencies.root.isRootUser(user.id);
    if (!isRoot) {
      throw new ApplicationError("FORBIDDEN", "供应商资料一期仅允许超级用户维护", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    if (!actorRoles.includes(ROOT_ACTOR_ROLE)) actorRoles.push(ROOT_ACTOR_ROLE);
    const authorizationCapabilities = [...user.capabilities];
    if (!authorizationCapabilities.includes("supplier_profile:write")) {
      authorizationCapabilities.push("supplier_profile:write");
    }
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "supplier_profile:write",
      authorizationCapabilities,
      requestId: request.id,
    };
  };

  const defaultWorkerRosterActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    const isRoot = await dependencies.root.isRootUser(user.id);
    const managesMasterData = user.capabilities.includes("master_data:manage");
    const configuresOrders = user.businessRoles?.includes("tail_supervisor") === true
      && user.capabilities.includes("process:configure")
      && user.capabilities.includes("work:assign");
    if (!isRoot && !managesMasterData && !configuresOrders) {
      throw new ApplicationError("FORBIDDEN", "仅尾部主管可在工序分配区维护默认工人", 403);
    }
    const authorizationCapability = managesMasterData ? "master_data:manage" : "process:configure";
    const actorRoles = [...(user.businessRoles ?? [])];
    if (isRoot && !actorRoles.includes(ROOT_ACTOR_ROLE)) actorRoles.push(ROOT_ACTOR_ROLE);
    const authorizationCapabilities = [...user.capabilities];
    if (isRoot && !authorizationCapabilities.includes(authorizationCapability)) {
      authorizationCapabilities.push(authorizationCapability);
    }
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability,
      authorizationCapabilities,
      requestId: request.id,
    };
  };

  const temporaryWorkerActor = async (
    request: FastifyRequest,
    privateProfile = false,
  ): Promise<TrustedActorContext> => {
    const temporaryActor = await actor(request, "temporary_worker:manage");
    const isRoot = temporaryActor.actorRoles.includes(ROOT_ACTOR_ROLE);
    const permittedRole = temporaryActor.actorRoles.includes("tail_supervisor")
      || temporaryActor.actorRoles.includes("owner_group")
      || isRoot;
    if (!permittedRole) {
      throw new ApplicationError("FORBIDDEN", "当前角色无权管理临时工", 403);
    }
    if (privateProfile
      && !isRoot
      && temporaryActor.authorizationCapabilities?.includes("temporary_worker_private:read") !== true) {
      throw new ApplicationError("FORBIDDEN", "无权查看或修改临时工隐私资料", 403);
    }
    return temporaryActor;
  };

  const craftActor = async (
    request: FastifyRequest,
    mutation = false,
  ): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    const isRoot = await dependencies.root.isRootUser(user.id);
    const managesMasterData = user.capabilities.includes("master_data:manage");
    const createsSourcingOrders = user.businessRoles?.includes("order_merchandiser") === true
      && user.capabilities.includes("sourcing:inquiry:create");
    const managesSourcing = user.businessRoles?.includes("production_management") === true
      && user.capabilities.includes("sourcing:decision:record");
    const readsSourcing = user.capabilities.includes("sourcing:view") || createsSourcingOrders || managesSourcing;
    if (!isRoot && !managesMasterData && (mutation ? !managesSourcing : !readsSourcing)) {
      throw new ApplicationError("FORBIDDEN", mutation ? "仅生产管理可新增工艺及承包范围" : "无权查看工艺数据库", 403);
    }
    if (!user.businessRoles?.length && !isRoot) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    const authorizationCapability = managesMasterData
      ? "master_data:manage"
      : managesSourcing
        ? "sourcing:decision:record"
        : mutation
          ? "master_data:manage"
          : createsSourcingOrders
            ? "sourcing:inquiry:create"
            : "sourcing:view";
    const actorRoles = [...(user.businessRoles ?? [])];
    if (isRoot && !actorRoles.includes(ROOT_ACTOR_ROLE)) actorRoles.push(ROOT_ACTOR_ROLE);
    const authorizationCapabilities = [...user.capabilities];
    if (isRoot && !authorizationCapabilities.includes(authorizationCapability)) {
      authorizationCapabilities.push(authorizationCapability);
    }
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability,
      authorizationCapabilities,
      requestId: request.id,
    };
  };

  const roleManager = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await authenticated(request);
    const isRoot = await dependencies.root.isRootUser(user.id);
    if (!isRoot) {
      throw new ApplicationError("FORBIDDEN", "仅超级用户可管理业务角色", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    if (!actorRoles.includes(ROOT_ACTOR_ROLE)) actorRoles.push(ROOT_ACTOR_ROLE);
    return {
      actorId: user.id,
      actorRoles,
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
    const peopleActor = await actor(request, "people:read");
    const query = parse(PeopleListQuerySchema, request.query);
    return dependencies.service.listPeople({
      includeInactive: query.includeInactive === "true",
      includeRevokedAliases: query.includeRevokedAliases === "true",
    }, peopleActor);
  });

  app.get("/master-data/crafts", async (request) => {
    await craftActor(request);
    const query = parse(CraftCatalogQuerySchema, request.query);
    return dependencies.service.listCrafts(query.q ?? "", query.includeInactive === "true");
  });

  app.post("/master-data/crafts/ensure", async (request) =>
    dependencies.service.ensureCrafts(
      await craftActor(request, true),
      parse(EnsureCraftsSchema, request.body),
    ));

  app.get("/master-data/crafts/:craftId/history", async (request) => {
    await craftActor(request);
    const params = parse(CraftParamsSchema, request.params);
    return dependencies.service.listCraftHistory(params.craftId);
  });

  app.post("/master-data/crafts/:craftId/versions", async (request) => {
    const params = parse(CraftParamsSchema, request.params);
    return dependencies.service.reviseCraft(
      await actor(request, "master_data:manage"),
      params.craftId,
      parse(ReviseCraftSchema, request.body),
    );
  });

  app.get("/master-data/processes", async (request) => {
    await actor(request, "process_catalog:read");
    const query = parse(CatalogListQuerySchema, request.query);
    return dependencies.service.listProcesses(query.includeInactive === "true");
  });

  app.get("/master-data/process-catalog", async (request) => {
    await actor(request, "process_catalog:read");
    const query = parse(ProcessCatalogPageQuerySchema, request.query);
    return dependencies.service.listProcessPage({
      includeInactive: query.includeInactive === "true",
      query: query.q ?? "",
      page: query.page,
    });
  });

  app.get("/master-data/process-default-worker-candidates", async (request) => {
    await actor(request, "master_data:manage");
    return dependencies.service.listProcessDefaultWorkerCandidates();
  });

  app.get("/master-data/suppliers", async (request) => {
    await supplierReadAccess(request);
    const query = parse(CatalogListQuerySchema, request.query);
    return dependencies.service.listSuppliers(query.includeInactive === "true");
  });

  app.get<{ Params: { supplierId: string } }>("/master-data/suppliers/:supplierId", async (request) => {
    const access = await supplierReadAccess(request);
    return dependencies.service.getSupplier(
      parse(SupplierParamsSchema, request.params).supplierId,
      access.includeContractData,
    );
  });

  app.get<{ Params: { supplierId: string } }>("/master-data/suppliers/:supplierId/history", async (request) => {
    const access = await supplierReadAccess(request);
    return dependencies.service.listSupplierHistory(
      parse(SupplierParamsSchema, request.params).supplierId,
      access.includeContractData,
    );
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

  app.post("/master-data/temporary-workers", async (request, reply) => {
    const input = parse(CreateBusinessPersonSchema, request.body);
    if (input.personType !== "temporary") {
      throw new ApplicationError("VALIDATION_ERROR", "该入口只能新增临时工", 400);
    }
    return reply.code(201).send(
      await dependencies.service.createPerson(await temporaryWorkerActor(request), input),
    );
  });

  app.get<{ Params: { personId: string } }>("/master-data/temporary-workers/:personId", async (request) =>
    dependencies.service.getTemporaryWorkerProfile(
      await temporaryWorkerActor(request, true),
      parse(PersonParamsSchema, request.params).personId,
    ));

  app.put<{ Params: { personId: string } }>("/master-data/temporary-workers/:personId", async (request) =>
    dependencies.service.updateTemporaryWorkerProfile(
      await temporaryWorkerActor(request, true),
      parse(PersonParamsSchema, request.params).personId,
      parse(UpdateTemporaryWorkerProfileSchema, request.body),
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

  app.put<{ Params: { processId: string } }>("/master-data/processes/:processId/default-workers", async (request) =>
    dependencies.service.replaceProcessDefaultWorkers(
      await defaultWorkerRosterActor(request),
      parse(ProcessParamsSchema, request.params).processId,
      parse(ReplaceProcessDefaultWorkersSchema, request.body),
    ));

  app.put("/master-data/tail-inspection/default-workers", async (request) =>
    dependencies.service.replaceTailInspectionDefaultWorkers(
      await defaultWorkerRosterActor(request),
      parse(ReplaceProcessDefaultWorkersSchema, request.body),
    ));

  app.post("/master-data/suppliers", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.createSupplier(
        await supplierWriteActor(request),
        parse(CreateSupplierSchema, request.body),
      ),
    ));

  app.get("/master-data/suppliers/import/template.xlsx", async (request, reply) => {
    await supplierWriteActor(request);
    return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", 'attachment; filename="supplier-template.xlsx"').send(supplierBatchTemplate());
  });
  app.post("/master-data/suppliers/import/preview", { bodyLimit: 1024 * 1024 }, async request => {
    const accessActor = await supplierWriteActor(request);
    return dependencies.service.previewSupplierBatch(accessActor, parse(SupplierBatchPreviewSchema, request.body).rows);
  });
  app.post("/master-data/suppliers/import/rows", async (request, reply) => {
    const accessActor = await supplierWriteActor(request);
    const result = await dependencies.service.applySupplierBatchRow(accessActor, parse(SupplierBatchApplySchema, request.body), idempotencyKey(request));
    if (result.reused) reply.header("idempotency-replayed", "true");
    return reply.code(result.statusCode).send(result.response);
  });

  app.post<{ Params: { supplierId: string } }>("/master-data/suppliers/:supplierId/versions", async (request, reply) =>
    reply.code(201).send(
      await dependencies.service.reviseSupplier(
        await supplierWriteActor(request),
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

  const removeWorkAssignment = dependencies.service.removeWorkAssignment;
  if (removeWorkAssignment) {
    app.post<{ Params: { workTaskId: string } }>("/work-tasks/:workTaskId/remove", async (request, reply) => {
      const assignmentActor = await actor(request, "work:assign");
      const permittedRole = assignmentActor.actorRoles.includes("tail_supervisor")
        || assignmentActor.actorRoles.includes(ROOT_ACTOR_ROLE);
      if (!permittedRole) {
        throw new ApplicationError("FORBIDDEN", "当前角色无权调整返工人员分配", 403);
      }
      const params = parse(WorkTaskParamsSchema, request.params);
      const input = parse(ConfirmWorkAssignmentsSchema, request.body);
      const result = await removeWorkAssignment.call(
        dependencies.service,
        assignmentActor,
        params.workTaskId,
        input.expectedOrderVersion,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(204).send();
    });
  }
}
