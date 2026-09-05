import { registerProductionReportingRoutes } from "./production-reporting-routes.js";
import type { ProductionReportingService } from "./production-reporting-service.js";
import {
  CreateSourcingCaseSchema,
  DispatchSourcingOrderSchema,
  SourcingDispatchStateSchema,
  SourcingProductionOrderSchema,
  SourcingProductionOrderListSchema,
  CreateSourcingIeQuoteSchema,
  DeleteSourcingCaseResponseSchema,
  DecideSourcingExceptionSchema,
  DecideSourcingFactoryChangeSchema,
  DecideSourcingOwnerSchema,
  RecordSourcingFinanceReconciliationSchema,
  RecordSourcingManagementDecisionSchema,
  RequestSourcingFactoryChangeSchema,
  SOURCING_IMAGE_SUPPLEMENT_ROLES,
  SourcingContractStateResponseSchema,
  SupplementSourcingContractSchema,
  SupplementSourcingImagesSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor, isRootUser } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { SourcingContractService } from "./sourcing-contract-service.js";
import type { SourcingProductionService } from "./sourcing-production-service.js";
import type { SourcingService } from "./sourcing-service.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((part) => part.trim())
  .find((part) => part.startsWith("dx_rework_session="))
  ?.slice("dx_rework_session=".length);

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "提交缺少有效请求标识", 400);
  }
  return value;
};

const caseId = (value: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "报价选厂询价标识无效", 400);
  }
  return value;
};

const validationError = (message: string): never => {
  throw new ApplicationError("VALIDATION_ERROR", message, 400);
};

export type SourcingHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: SourcingService;
  contracts?: SourcingContractService;
  production?: SourcingProductionService;
  reporting?: ProductionReportingService;
  root?: RootAuthority;
}>;

export function registerSourcingRoutes(
  app: FastifyInstance,
  dependencies: SourcingHttpDependencies,
): void {
  if (dependencies.reporting) registerProductionReportingRoutes(app, { authenticate: dependencies.authenticate, root: dependencies.root, service: dependencies.reporting });
  const readActor = async (request: FastifyRequest) => {
    const user = await dependencies.authenticate(token(request));
    const root = await isRootUser(dependencies.root, user.id);
    if (!root && !user.capabilities.includes("sourcing:view")) {
      throw new ApplicationError("FORBIDDEN", "无权查看报价选厂数据", 403);
    }
    return businessActor(
      dependencies.root,
      user,
      request.id,
      "sourcing:view",
    );
  };

  const actionActor = async (
    request: FastifyRequest,
    role: "order_merchandiser" | "ie_reviewer" | "production_management" | "owner_group" | "factory_payables",
    capability:
      | "sourcing:inquiry:create"
      | "sourcing:price:quote"
      | "sourcing:decision:record"
      | "sourcing:owner:approve"
      | "sourcing:contract:record"
      | "sourcing:factory_change:request"
      | "sourcing:factory_change:verify"
      | "sourcing:finance:reconcile"
      | "sourcing:exception:verify",
  ) => {
    const user = await dependencies.authenticate(token(request));
    const root = await isRootUser(dependencies.root, user.id);
    const allowed = user.businessRoles?.includes(role) === true
      && user.capabilities.includes(capability);
    if (!root && !allowed) {
      throw new ApplicationError("FORBIDDEN", "当前岗位无权执行该报价选厂操作", 403);
    }
    return businessActor(
      dependencies.root,
      user,
      request.id,
      capability,
      root ? role : undefined,
    );
  };

  const supplementalImageActor = async (request: FastifyRequest) => {
    const user = await dependencies.authenticate(token(request));
    const root = await isRootUser(dependencies.root, user.id);
    if (!user.businessRoles?.length && !root) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!root && !user.businessRoles?.some((role) => SOURCING_IMAGE_SUPPLEMENT_ROLES.includes(
      role as (typeof SOURCING_IMAGE_SUPPLEMENT_ROLES)[number],
    ))) {
      throw new ApplicationError("FORBIDDEN", "当前角色无权补充报价选厂订单图片", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    if (root && !actorRoles.includes("root_superuser")) actorRoles.push("root_superuser");
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "tools:user",
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };

  const rootDeleteActor = async (request: FastifyRequest) => {
    const user = await dependencies.authenticate(token(request));
    const root = await isRootUser(dependencies.root, user.id);
    if (!root) {
      throw new ApplicationError("FORBIDDEN", "只有超级用户可以删除报价选厂订单", 403);
    }
    return {
      actorId: user.id,
      actorRoles: [...(user.businessRoles ?? []), "root_superuser"],
      authorizationCapability: "sourcing:delete",
      authorizationCapabilities: [...user.capabilities, "sourcing:delete"],
      requestId: request.id,
    };
  };

  if (dependencies.production) {
    const production = dependencies.production;
    app.get<{ Params: { sourcingCaseId: string } }>("/sourcing/cases/:sourcingCaseId/dispatch", async (request) =>
      SourcingDispatchStateSchema.parse(await production.state(await readActor(request), caseId(request.params.sourcingCaseId))));
    app.post<{ Params: { sourcingCaseId: string } }>("/sourcing/cases/:sourcingCaseId/dispatch", async (request, reply) => {
      const actor = await actionActor(request, "order_merchandiser", "sourcing:contract:record");
      const parsed = DispatchSourcingOrderSchema.safeParse(request.body);
      if (!parsed.success) validationError("请确认派单信息后提交");
      const result = await production.dispatch(actor, caseId(request.params.sourcingCaseId), parsed.data!, idempotencyKey(request));
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(result.statusCode).send(SourcingProductionOrderSchema.parse(result.value));
    });
    app.get<{ Querystring: { page?: string } }>("/sourcing/production-orders", async (request) =>
      SourcingProductionOrderListSchema.parse(await production.list(await readActor(request), Number(request.query.page ?? "1"))));
    app.get<{ Params: { productionOrderId: string } }>("/sourcing/production-orders/:productionOrderId", async (request) =>
      SourcingProductionOrderSchema.parse(await production.get(await readActor(request), caseId(request.params.productionOrderId))));
  }

  app.get("/sourcing/factories", async (request) =>
    dependencies.service.listFactories(await readActor(request)));

  app.get<{ Querystring: { page?: string; q?: string; status?: string } }>("/sourcing/cases", async (request) => {
    if (request.query.q !== undefined && typeof request.query.q !== "string") {
      validationError("搜索内容无效");
    }
    const page = Number(request.query.page ?? "1");
    if (!Number.isInteger(page) || page < 1 || page > 100_000) validationError("分页页码无效");
    const status = request.query.status;
    if (status !== undefined && status !== "pending" && status !== "closed") {
      validationError("订单状态筛选无效");
    }
    const statusFilter = status === "pending" || status === "closed" ? status : "all";
    return dependencies.service.listCases(
      await readActor(request),
      request.query.q ?? "",
      statusFilter,
      page,
    );
  });

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId",
    async (request) => dependencies.service.getCase(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.delete<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId",
    async (request, reply) => {
      const sourcingCaseId = caseId(request.params.sourcingCaseId);
      const result = await dependencies.service.deleteByRoot(
        await rootDeleteActor(request),
        sourcingCaseId,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return DeleteSourcingCaseResponseSchema.parse(result.value);
    },
  );

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/attachments",
    async (request) => dependencies.service.listAttachments(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/supplemental-images",
    async (request, reply) => {
      const parsed = SupplementSourcingImagesSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "补充图片信息无效");
      const result = await dependencies.service.supplementImages(
        await supplementalImageActor(request),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    },
  );

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/timeline",
    async (request) => dependencies.service.listTimeline(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.get<{ Querystring: { q?: string } }>("/sourcing/styles", async (request) =>
    dependencies.service.listStyles(
      await actionActor(request, "order_merchandiser", "sourcing:inquiry:create"),
      typeof request.query.q === "string" ? request.query.q : "",
    ));

  app.post("/sourcing/cases", async (request, reply) => {
    const parsed = CreateSourcingCaseSchema.safeParse(request.body);
    const data = parsed.success
      ? parsed.data
      : validationError(parsed.error.issues[0]?.message ?? "询价信息不完整");
    const result = await dependencies.service.createCase(
      await actionActor(request, "order_merchandiser", "sourcing:inquiry:create"),
      data,
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/ie-quotes",
    async (request, reply) => {
      const parsed = CreateSourcingIeQuoteSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "IE报价信息不完整");
      const result = await dependencies.service.quoteIePrice(
        await actionActor(request, "ie_reviewer", "sourcing:price:quote"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/management-decisions",
    async (request, reply) => {
      const parsed = RecordSourcingManagementDecisionSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "生产管理决定信息不完整");
      const result = await dependencies.service.recordManagementDecision(
        await actionActor(
          request,
          "production_management",
          "sourcing:decision:record",
        ),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/owner-decisions",
    async (request, reply) => {
      const parsed = DecideSourcingOwnerSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "老板审批信息不完整");
      const result = await dependencies.service.decideOwner(
        await actionActor(request, "owner_group", "sourcing:owner:approve"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  if (dependencies.contracts) {
    app.get<{ Params: { sourcingCaseId: string } }>(
      "/sourcing/cases/:sourcingCaseId/contract",
      async (request) => SourcingContractStateResponseSchema.parse(
        await dependencies.contracts!.getCurrent(
          await readActor(request),
          caseId(request.params.sourcingCaseId),
        ),
      ),
    );

    app.post<{ Params: { sourcingCaseId: string } }>(
      "/sourcing/cases/:sourcingCaseId/contract/supplements",
      async (request) => {
        const parsed = SupplementSourcingContractSchema.safeParse(request.body);
        const data = parsed.success
          ? parsed.data
          : validationError(parsed.error.issues[0]?.message ?? "合同补充资料不完整");
        return SourcingContractStateResponseSchema.parse(
          await dependencies.contracts!.supplement(
            await actionActor(request, "order_merchandiser", "sourcing:contract:record"),
            caseId(request.params.sourcingCaseId),
            data,
            idempotencyKey(request),
          ),
        );
      },
    );

    app.post<{ Params: { sourcingCaseId: string } }>(
      "/sourcing/cases/:sourcingCaseId/contract/generate",
      async (request) => SourcingContractStateResponseSchema.parse(
        await dependencies.contracts!.generateIfReady(
          await actionActor(request, "order_merchandiser", "sourcing:contract:record"),
          caseId(request.params.sourcingCaseId),
        ),
      ),
    );
  }

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/current",
    async (request) => dependencies.service.getCurrentFactoryChange(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes",
    async (request, reply) => {
      const parsed = RequestSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "换厂信息不完整");
      const result = await dependencies.service.requestFactoryChange(
        await actionActor(request, "order_merchandiser", "sourcing:factory_change:request"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/management",
    async (request, reply) => {
      const parsed = RequestSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "转厂信息不完整");
      const result = await dependencies.service.requestFactoryChange(
        await actionActor(request, "production_management", "sourcing:decision:record"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/owner",
    async (request, reply) => {
      const parsed = RequestSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "转厂信息不完整");
      const result = await dependencies.service.requestFactoryChange(
        await actionActor(request, "owner_group", "sourcing:owner:approve"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string; factoryChangeRequestId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/:factoryChangeRequestId/decision",
    async (request, reply) => {
      const parsed = DecideSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "换厂核实信息不完整");
      const result = await dependencies.service.decideFactoryChange(
        await actionActor(request, "production_management", "sourcing:factory_change:verify"),
        caseId(request.params.sourcingCaseId),
        caseId(request.params.factoryChangeRequestId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string; factoryChangeRequestId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/:factoryChangeRequestId/owner-decision",
    async (request, reply) => {
      const parsed = DecideSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "老板转厂审批信息不完整");
      const result = await dependencies.service.decideFactoryChange(
        await actionActor(request, "owner_group", "sourcing:owner:approve"),
        caseId(request.params.sourcingCaseId),
        caseId(request.params.factoryChangeRequestId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/finance-reconciliations",
    async (request, reply) => {
      const parsed = RecordSourcingFinanceReconciliationSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "财务核对信息不完整");
      const result = await dependencies.service.recordFinanceReconciliation(
        await actionActor(request, "factory_payables", "sourcing:finance:reconcile"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/exception-decisions",
    async (request, reply) => {
      const parsed = DecideSourcingExceptionSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "差异处理信息不完整");
      const result = await dependencies.service.decideException(
        await actionActor(request, "production_management", "sourcing:exception:verify"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

}
