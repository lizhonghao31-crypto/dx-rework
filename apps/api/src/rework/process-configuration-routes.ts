import {
  IdempotencyKeySchema,
  ProcessConfigurationOptionsResponseSchema,
  ProcessConfigurationParamsSchema,
  ProcessConfigurationResponseSchema,
  ReviewProcessConfigurationSchema,
  SaveProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ProcessConfigurationService } from "./process-configuration-service.js";

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

export type ProcessConfigurationHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: ProcessConfigurationService;
}>;

export function registerProcessConfigurationRoutes(
  app: FastifyInstance,
  dependencies: ProcessConfigurationHttpDependencies,
): void {
  const actor = async (
    request: FastifyRequest,
    mode: "read" | "configure" | "review",
  ): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isSupervisor = user.businessRoles?.includes("tail_supervisor")
      && user.capabilities.includes("process:configure");
    const isReviewer = user.businessRoles?.includes("ie_reviewer")
      && user.capabilities.includes("process:review");
    if (
      !user.businessRoles?.length
      || (mode === "configure" && !isSupervisor)
      || (mode === "review" && !isReviewer)
      || (mode === "read" && !isSupervisor && !isReviewer)
    ) {
      throw new ApplicationError("FORBIDDEN", "当前角色无权处理工序配置", 403);
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles,
      authorizationCapability: mode === "review"
        ? "process:review"
        : isSupervisor ? "process:configure" : "process:review",
      requestId: request.id,
    };
  };

  app.get("/rework-process-configurations/options", async (request) =>
    ProcessConfigurationOptionsResponseSchema.parse(
      await dependencies.service.options(await actor(request, "configure")),
    ));

  app.get<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration",
    async (request) => ProcessConfigurationResponseSchema.parse(
      await dependencies.service.get(
        await actor(request, "read"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
      ),
    ),
  );

  app.put<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration/draft",
    async (request, reply) => {
      const result = await dependencies.service.saveDraft(
        await actor(request, "configure"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
        parse(SaveProcessConfigurationSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(ProcessConfigurationResponseSchema.parse(result.value));
    },
  );

  app.post<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration/submit",
    async (request, reply) => {
      const result = await dependencies.service.submit(
        await actor(request, "configure"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
        parse(SubmitProcessConfigurationSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return ProcessConfigurationResponseSchema.parse(result.value);
    },
  );

  app.post<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration/review",
    async (request, reply) => {
      const result = await dependencies.service.review(
        await actor(request, "review"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
        parse(ReviewProcessConfigurationSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return ProcessConfigurationResponseSchema.parse(result.value);
    },
  );
}
