import {
  WageItemParamsSchema,
  WagePeriodParamsSchema,
} from "@dx-rework/contracts/wages";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { businessActor, isRootUser } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { WageService, WageSettlementFilters } from "./wage-service.js";
import type { WageExportService } from "./wage-export-service.js";

const token = (request: FastifyRequest) => request.headers.cookie
  ?.split(";")
  .map((value) => value.trim())
  .find((value) => value.startsWith("dx_rework_session="))
  ?.slice(18);

const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400);
  return result.data;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const settlementFilters = (input: unknown): WageSettlementFilters => {
  if (!input || typeof input !== "object") {
    throw new ApplicationError("VALIDATION_ERROR", "工资结算筛选条件无效", 400);
  }
  const value = input as Record<string, unknown>;
  const from = value.from;
  const to = value.to;
  const q = typeof value.q === "string" ? value.q.trim() : "";
  const personType = value.personType;
  if (typeof from !== "string" || !datePattern.test(from) || typeof to !== "string" || !datePattern.test(to) || from > to) {
    throw new ApplicationError("VALIDATION_ERROR", "工资结算日期范围无效", 400);
  }
  if (q.length > 100) throw new ApplicationError("VALIDATION_ERROR", "工资搜索内容不能超过100个字符", 400);
  if (personType !== undefined && personType !== "internal" && personType !== "temporary") {
    throw new ApplicationError("VALIDATION_ERROR", "工人类型无效", 400);
  }
  return {
    from,
    to,
    ...(q ? { q } : {}),
    ...(personType === "internal" || personType === "temporary" ? { personType } : {}),
  };
};

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "工资结算标记缺少有效请求标识", 400);
  }
  return value;
};

export type WageHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: WageService;
  exportService: WageExportService;
  root?: RootAuthority;
}>;

export function registerWageRoutes(app: FastifyInstance, dependencies: WageHttpDependencies): void {
  const actingRole = (capability: string): string | undefined =>
    capability === "wage:export" ? "finance_read" : undefined;

  const actor = async (request: FastifyRequest, capability: string): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    const trusted = await businessActor(dependencies.root, user, request.id, capability, actingRole(capability));
    if (capability === "wage:view" && await isRootUser(dependencies.root, user.id)) {
      return {
        ...trusted,
        authorizationCapabilities: [...new Set([
          ...(trusted.authorizationCapabilities ?? []),
          "wage:export",
          "wage:settlement_mark",
        ])],
      };
    }
    return trusted;
  };

  app.get("/wage-periods", async (request) =>
    dependencies.service.list(await actor(request, "wage:view")));

  app.get("/wage-periods/:periodId", async (request) =>
    dependencies.service.get(
      await actor(request, "wage:view"),
      parse(WagePeriodParamsSchema, request.params).periodId,
    ));

  app.get("/wage-periods/:periodId/items", async (request) =>
    (await dependencies.service.get(
      await actor(request, "wage:view"),
      parse(WagePeriodParamsSchema, request.params).periodId,
    )).items);

  app.get("/wage-items/:wageItemId", async (request) =>
    dependencies.service.item(
      await actor(request, "wage:view"),
      parse(WageItemParamsSchema, request.params).wageItemId,
    ));

  app.get<{ Querystring: Record<string, unknown> }>("/wage-settlements/summary", async (request) =>
    dependencies.service.settlementSummary(
      await actor(request, "wage:settlement_mark"),
      settlementFilters(request.query),
    ));

  app.post<{ Body: Record<string, unknown> }>("/wage-settlements", async (request) =>
    dependencies.service.settleFiltered(
      await actor(request, "wage:settlement_mark"),
      settlementFilters(request.body),
      idempotencyKey(request),
    ));

  app.get("/wage-periods/:periodId/export.xlsx", async (request, reply) => {
    const params = parse(WagePeriodParamsSchema, request.params);
    const result = await dependencies.exportService.export(
      await actor(request, "wage:export"),
      params.periodId,
    );
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
      .send(result.content);
  });
}
