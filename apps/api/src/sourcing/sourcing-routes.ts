import {
  CreateSourcingCaseSchema,
  CreateSourcingIeQuoteSchema,
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
    role: "order_merchandiser" | "ie_reviewer",
    capability: "sourcing:inquiry:create" | "sourcing:price:quote",
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

  app.get<{ Querystring: { q?: string } }>("/sourcing/cases", async (request) => {
    if (request.query.q !== undefined && typeof request.query.q !== "string") {
      validationError("搜索内容无效");
    }
    return dependencies.service.listCases(await readActor(request), request.query.q ?? "");
  });

  app.post("/sourcing/cases", async (request, reply) => {
    const parsed = CreateSourcingCaseSchema.safeParse(request.body);
    if (!parsed.success) {
      validationError(parsed.error.issues[0]?.message ?? "询价信息不完整");
    }
    const result = await dependencies.service.createCase(
      await actionActor(request, "order_merchandiser", "sourcing:inquiry:create"),
      parsed.data,
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/ie-quotes",
    async (request, reply) => {
      const parsed = CreateSourcingIeQuoteSchema.safeParse(request.body);
      if (!parsed.success) {
        validationError(parsed.error.issues[0]?.message ?? "IE报价信息不完整");
      }
      const result = await dependencies.service.quoteIePrice(
        await actionActor(request, "ie_reviewer", "sourcing:price:quote"),
        caseId(request.params.sourcingCaseId),
        parsed.data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );
}
