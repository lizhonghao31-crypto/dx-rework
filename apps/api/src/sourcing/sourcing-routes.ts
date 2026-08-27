import {
  CreateSourcingCaseSchema,
  CreateSourcingIeQuoteSchema,
  DecideSourcingOwnerSchema,
  RecordSourcingManagementDecisionSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor, isRootUser } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
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
  root?: RootAuthority;
}>;

export function registerSourcingRoutes(
  app: FastifyInstance,
  dependencies: SourcingHttpDependencies,
): void {
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
    role: "order_merchandiser" | "ie_reviewer" | "production_management" | "owner_group",
    capability:
      | "sourcing:inquiry:create"
      | "sourcing:price:quote"
      | "sourcing:decision:record"
      | "sourcing:owner:approve",
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

  app.get("/sourcing/factories", async (request) =>
    dependencies.service.listFactories(await readActor(request)));

  app.get<{ Querystring: { q?: string } }>("/sourcing/cases", async (request) => {
    if (request.query.q !== undefined && typeof request.query.q !== "string") {
      validationError("搜索内容无效");
    }
    return dependencies.service.listCases(await readActor(request), request.query.q ?? "");
  });

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId",
    async (request) => dependencies.service.getCase(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/attachments",
    async (request) => dependencies.service.listAttachments(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/timeline",
    async (request) => dependencies.service.listTimeline(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

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

}
