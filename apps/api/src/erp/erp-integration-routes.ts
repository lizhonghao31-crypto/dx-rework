import { IdempotencyKeySchema } from "@dx-rework/contracts";
import {
  ErpEmergencyLinkV1Schema,
  ErpEmergencyReworkIntakeV1Schema,
  ErpReworkIntakeV1Schema,
  ErpReworkOrderParamsSchema,
} from "@dx-rework/contracts/erp-integration";
import { IntegrationDisabledError, type ErpAdapter } from "@dx-rework/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ErpIntegrationService } from "./erp-integration-service.js";

const cookieToken = (request: FastifyRequest): string | undefined => request.headers.cookie
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

export type ErpIntegrationHttpDependencies = Readonly<{
  authenticateSession(token: string | undefined): Promise<AuthUser>;
  authenticateIntegration?: (request: FastifyRequest) => Promise<TrustedActorContext>;
  adapter: ErpAdapter;
  service: ErpIntegrationService;
}>;

const integrationDisabled = (): ApplicationError =>
  new ApplicationError("INTEGRATION_DISABLED", "ERP生产接入尚未启用", 503);

export function registerErpIntegrationRoutes(
  app: FastifyInstance,
  dependencies: ErpIntegrationHttpDependencies,
): void {
  const integrationActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const status = await dependencies.adapter.status();
    if (!status.enabled || status.mode === "disabled" || !dependencies.authenticateIntegration) {
      throw integrationDisabled();
    }
    return dependencies.authenticateIntegration(request);
  };

  const adminActor = async (
    request: FastifyRequest,
    capability: "erp:emergency_intake" | "erp:result:read",
  ): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticateSession(cookieToken(request));
    if (!user.businessRoles?.length) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!user.businessRoles.includes("system_admin") || !user.capabilities.includes(capability)) {
      throw new ApplicationError("FORBIDDEN", "当前管理员缺少ERP接入能力", 403);
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles,
      authorizationCapability: capability,
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };

  app.post("/integrations/erp/v1/rework-orders", async (request, reply) => {
    const input = parse(ErpReworkIntakeV1Schema, request.body);
    const actor = await integrationActor(request);
    try {
      await dependencies.adapter.acceptSourceRecord(input);
    } catch (error: unknown) {
      if (error instanceof IntegrationDisabledError) throw integrationDisabled();
      throw error;
    }
    const result = await dependencies.service.intakeFromErp(
      actor,
      input,
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });

  app.post<{ Params: { reworkOrderId: string } }>(
    "/integrations/erp/v1/rework-orders/:reworkOrderId/link",
    async (request, reply) => {
      const params = parse(ErpReworkOrderParamsSchema, request.params);
      const result = await dependencies.service.linkEmergency(
        await integrationActor(request),
        params.reworkOrderId,
        parse(ErpEmergencyLinkV1Schema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    },
  );

  app.get<{ Params: { reworkOrderId: string } }>(
    "/integrations/erp/v1/rework-orders/:reworkOrderId/result",
    async (request) => {
      const params = parse(ErpReworkOrderParamsSchema, request.params);
      return dependencies.service.result(await integrationActor(request), params.reworkOrderId);
    },
  );

  app.post("/admin/erp-emergency/v1/rework-orders", async (request, reply) => {
    const result = await dependencies.service.emergencyIntake(
      await adminActor(request, "erp:emergency_intake"),
      parse(ErpEmergencyReworkIntakeV1Schema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });

  app.get<{ Params: { reworkOrderId: string } }>(
    "/admin/erp/v1/rework-orders/:reworkOrderId/result",
    async (request) => {
      const params = parse(ErpReworkOrderParamsSchema, request.params);
      return dependencies.service.result(
        await adminActor(request, "erp:result:read"),
        params.reworkOrderId,
      );
    },
  );
}
