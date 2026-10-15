import { requestValidationMessage } from "@dx-rework/contracts/validation-language";
import { assertFinanceWageAccess, type WageAccessCapability } from "./wage-access.js";
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
import type { WageService } from "./wage-service.js";
import type { WageExportService } from "./wage-export-service.js";

const token = (request: FastifyRequest) => request.headers.cookie
  ?.split(";")
  .map((value) => value.trim())
  .find((value) => value.startsWith("dx_rework_session="))
  ?.slice(18);

const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", requestValidationMessage(result), 400);
  return result.data;
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

  const actor = async (request: FastifyRequest, capability: WageAccessCapability): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    const trusted = await businessActor(dependencies.root, user, request.id, capability, actingRole(capability));
    assertFinanceWageAccess(trusted, capability);
    if (capability === "wage:view" && await isRootUser(dependencies.root, user.id)) {
      return {
        ...trusted,
        authorizationCapabilities: [...new Set([
          ...(trusted.authorizationCapabilities ?? []),
          "wage:export",
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
