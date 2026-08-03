import {
  ConfirmHighMultiplierSchema,
  CreateResponsibilityDraftSchema,
  FinalizeResponsibilitySchema,
  IdempotencyKeySchema,
  ResponsibilityDeterminationParamsSchema,
  ResponsibilityDeterminationResponseSchema,
  ResponsibilityOrderParamsSchema,
  TakeoverResponsibilitySchema,
  TransferResponsibilitySchema,
} from "@dx-rework/contracts";
import { ResponsibilityQueueResponseSchema } from "@dx-rework/contracts/responsibility-queue";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ResponsibilityDeterminationApplicationService } from "./responsibility-determination-application-service.js";

type ResponsibilityDeterminationHttpService = Pick<
  ResponsibilityDeterminationApplicationService,
  | "listQueue"
  | "get"
  | "saveDraft"
  | "finalize"
  | "transfer"
  | "takeover"
  | "confirmHighMultiplier"
>;

const token = (request: FastifyRequest): string | undefined =>
  request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("dx_rework_session="))
    ?.slice(18);

const parse = <T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false };
  },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      "Request validation failed",
      400,
    );
  }
  return result.data;
};

export type ResponsibilityDeterminationHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: ResponsibilityDeterminationHttpService;
}>;

export function registerResponsibilityDeterminationRoutes(
  app: FastifyInstance,
  dependencies: ResponsibilityDeterminationHttpDependencies,
): void {
  const actor = async (
    request: FastifyRequest,
    capability: string,
  ): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    if (!user.businessRoles?.length) {
      throw new ApplicationError(
        "NO_BUSINESS_ROLE",
        "未分配业务角色",
        403,
      );
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles,
      authorizationCapability: capability,
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };
  const key = (request: FastifyRequest): string =>
    parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

  app.get("/responsibility-determinations/queue", async (request) =>
    ResponsibilityQueueResponseSchema.parse(
      await dependencies.service.listQueue(
        await actor(request, "responsibility:determine"),
      ),
    ));

  app.get(
    "/rework-orders/:reworkOrderId/responsibility-determination",
    async (request) => {
      const currentActor = await actor(request, "responsibility:determine");
      const result = await dependencies.service.get(
        currentActor,
        parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId,
      );
      return ResponsibilityDeterminationResponseSchema.parse({
        ...result,
        handlerUserId:
          result.handlerUserId ??
          (result.canDetermine ? currentActor.actorId : null),
      });
    },
  );
  app.post(
    "/rework-orders/:reworkOrderId/responsibility-determinations/drafts",
    async (request, reply) => {
      const result = await dependencies.service.saveDraft(
        await actor(request, "responsibility:determine"),
        parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId,
        parse(CreateResponsibilityDraftSchema, request.body),
        key(request),
      );
      if (result.reused) reply.header("idempotency-replayed", "true");
      return reply
        .code(201)
        .send(ResponsibilityDeterminationResponseSchema.parse(result.value));
    },
  );
  app.post(
    "/rework-orders/:reworkOrderId/responsibility-determinations/finalize",
    async (request, reply) => {
      const result = await dependencies.service.finalize(
        await actor(request, "responsibility:determine"),
        parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId,
        parse(FinalizeResponsibilitySchema, request.body),
        key(request),
      );
      if (result.reused) reply.header("idempotency-replayed", "true");
      return ResponsibilityDeterminationResponseSchema.parse(result.value);
    },
  );
  app.post(
    "/rework-orders/:reworkOrderId/responsibility-determinations/transfer",
    async (request, reply) => {
      const result = await dependencies.service.transfer(
        await actor(request, "responsibility:determine"),
        parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId,
        parse(TransferResponsibilitySchema, request.body),
        key(request),
      );
      if (result.reused) reply.header("idempotency-replayed", "true");
      return ResponsibilityDeterminationResponseSchema.parse(result.value);
    },
  );
  app.post(
    "/rework-orders/:reworkOrderId/responsibility-determinations/takeover",
    async (request, reply) => {
      const result = await dependencies.service.takeover(
        await actor(request, "responsibility:takeover"),
        parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId,
        parse(TakeoverResponsibilitySchema, request.body),
        key(request),
      );
      if (result.reused) reply.header("idempotency-replayed", "true");
      return ResponsibilityDeterminationResponseSchema.parse(result.value);
    },
  );
  app.post(
    "/responsibility-determinations/:determinationId/high-multiplier-confirm",
    async (request, reply) => {
      const result = await dependencies.service.confirmHighMultiplier(
        await actor(request, "responsibility:confirm_high_multiplier"),
        parse(ResponsibilityDeterminationParamsSchema, request.params)
          .determinationId,
        parse(ConfirmHighMultiplierSchema, request.body),
        key(request),
      );
      if (result.reused) reply.header("idempotency-replayed", "true");
      return ResponsibilityDeterminationResponseSchema.parse(result.value);
    },
  );
}
