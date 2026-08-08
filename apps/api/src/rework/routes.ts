import {
  CreateReworkDraftSchema,
  IdempotencyKeySchema,
  ReworkOrderParamsSchema,
  ReworkOrdersQuerySchema,
  SubmitReworkOrderSchema,
  TransitionReworkOrderSchema,
  UpdateReworkDraftSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { registerErpIntegrationRoutes, type ErpIntegrationHttpDependencies } from "../erp/erp-integration-routes.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ReworkInitiationService } from "./service.js";

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
  if (!result.success) {
    throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400);
  }
  return result.data;
};

const idempotencyKey = (request: FastifyRequest): string =>
  parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

export type ReworkHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: ReworkInitiationService;
  root?: RootAuthority;
  erp?: Omit<ErpIntegrationHttpDependencies, "authenticateSession">;
}>;

export function registerReworkRoutes(
  app: FastifyInstance,
  dependencies: ReworkHttpDependencies,
): void {
  const actor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    if (!user.businessRoles?.length && !isRoot) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (
      !isRoot
      && (
        !user.businessRoles?.includes("quality_control")
        || !user.capabilities.includes("rework:initiate")
      )
    ) {
      throw new ApplicationError("FORBIDDEN", "只有品控人员可以发起和维护返工单", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    if (isRoot) {
      actorRoles.push("root_superuser");
      if (!actorRoles.includes("quality_control")) actorRoles.push("quality_control");
    }
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "rework:initiate",
      requestId: request.id,
    };
  };

  app.post("/rework-orders/drafts", async (request, reply) => {
    const result = await dependencies.service.createDraft(
      await actor(request),
      parse(CreateReworkDraftSchema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });

  app.put<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/draft",
    async (request, reply) => {
      const params = parse(ReworkOrderParamsSchema, request.params);
      const result = await dependencies.service.updateDraft(
        await actor(request),
        params.reworkOrderId,
        parse(UpdateReworkDraftSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    },
  );

  app.post<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/submit",
    async (request, reply) => {
      const params = parse(ReworkOrderParamsSchema, request.params);
      const result = await dependencies.service.submit(
        await actor(request),
        params.reworkOrderId,
        parse(SubmitReworkOrderSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    },
  );

  app.post<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/withdraw",
    async (request, reply) => {
      const params = parse(ReworkOrderParamsSchema, request.params);
      const result = await dependencies.service.withdraw(
        await actor(request),
        params.reworkOrderId,
        parse(TransitionReworkOrderSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    },
  );

  app.post<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/cancel",
    async (request, reply) => {
      const params = parse(ReworkOrderParamsSchema, request.params);
      const result = await dependencies.service.cancel(
        await actor(request),
        params.reworkOrderId,
        parse(TransitionReworkOrderSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    },
  );

  app.get("/rework-orders/initiation-options", async (request) =>
    dependencies.service.listInitiationOptions(await actor(request)));

  app.get<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId",
    async (request) => dependencies.service.getOwn(
      await actor(request),
      parse(ReworkOrderParamsSchema, request.params).reworkOrderId,
    ),
  );

  app.get("/rework-orders", async (request) => {
    const query = parse(ReworkOrdersQuerySchema, request.query);
    return dependencies.service.listOwn(
      await actor(request),
      query.status,
    );
  });

  if (dependencies.erp) {
    registerErpIntegrationRoutes(app, {
      authenticateSession: dependencies.authenticate,
      ...dependencies.erp,
    });
  }
}
