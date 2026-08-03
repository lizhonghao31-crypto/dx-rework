import {
  ConfirmQuantityIncreaseSchema,
  CreateQuantityDecreaseSchema,
  CreateQuantityIncreaseSchema,
  IdempotencyKeySchema,
  QuantityAdjustmentParamsSchema,
  QuantityAdjustmentResponseSchema,
  RejectWorkReportSchema,
  ReviewQuantityIncreaseSchema,
  ReviewWholeOrderSchema,
  WholeOrderReviewParamsSchema,
  WholeOrderReviewQuerySchema,
  WholeOrderReviewResponseSchema,
  WorkReportRejectionParamsSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { WholeOrderReviewService } from "./whole-order-review-service.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
const parse = <T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400);
  return result.data;
};
const key = (request: FastifyRequest): string => parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

export type WholeOrderReviewHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: WholeOrderReviewService;
}>;

export function registerWholeOrderReviewRoutes(app: FastifyInstance, dependencies: WholeOrderReviewHttpDependencies): void {
  const actor = async (request: FastifyRequest, capability: string): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    if (!user.businessRoles?.length) throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    return {
      actorId: user.id,
      actorRoles: user.businessRoles,
      authorizationCapability: capability,
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };
  app.get<{ Params: { reworkOrderId: string }; Querystring: { configurationItemId?: string } }>("/rework-orders/:reworkOrderId/whole-order-review", async (request) => {
    const query = parse(WholeOrderReviewQuerySchema, request.query);
    const serviceActor = await actor(request, "submission:audit");
    const orderId = parse(WholeOrderReviewParamsSchema, request.params).reworkOrderId;
    return WholeOrderReviewResponseSchema.parse(query.configurationItemId
      ? await dependencies.service.get(serviceActor, orderId, query.configurationItemId)
      : await dependencies.service.get(serviceActor, orderId));
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/whole-order-review/approve", async (request, reply) => {
    const result = await dependencies.service.approve(await actor(request, "submission:audit"), parse(WholeOrderReviewParamsSchema, request.params).reworkOrderId, parse(ReviewWholeOrderSchema, request.body), key(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return WholeOrderReviewResponseSchema.parse(result.value);
  });
  app.post<{ Params: { workReportId: string } }>("/work-reports/:workReportId/reject", async (request, reply) => {
    const result = await dependencies.service.rejectReport(await actor(request, "submission:audit"), parse(WorkReportRejectionParamsSchema, request.params).workReportId, parse(RejectWorkReportSchema, request.body), key(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return WholeOrderReviewResponseSchema.parse(result.value);
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/quantity-adjustments/decrease", async (request, reply) => {
    const result = await dependencies.service.decrease(await actor(request, "quantity:adjust"), parse(WholeOrderReviewParamsSchema, request.params).reworkOrderId, parse(CreateQuantityDecreaseSchema, request.body), key(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(QuantityAdjustmentResponseSchema.parse(result.value));
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/quantity-adjustments/increase", async (request, reply) => {
    const result = await dependencies.service.requestIncrease(await actor(request, "quantity:adjust"), parse(WholeOrderReviewParamsSchema, request.params).reworkOrderId, parse(CreateQuantityIncreaseSchema, request.body), key(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(QuantityAdjustmentResponseSchema.parse(result.value));
  });
  app.post<{ Params: { adjustmentId: string } }>("/quantity-adjustments/:adjustmentId/confirm", async (request, reply) => {
    const result = await dependencies.service.confirmIncrease(await actor(request, "quantity:confirm"), parse(QuantityAdjustmentParamsSchema, request.params).adjustmentId, parse(ConfirmQuantityIncreaseSchema, request.body), key(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return QuantityAdjustmentResponseSchema.parse(result.value);
  });
  app.post<{ Params: { adjustmentId: string } }>("/quantity-adjustments/:adjustmentId/ie-review", async (request, reply) => {
    const result = await dependencies.service.reviewIncrease(await actor(request, "process:review"), parse(QuantityAdjustmentParamsSchema, request.params).adjustmentId, parse(ReviewQuantityIncreaseSchema, request.body), key(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return QuantityAdjustmentResponseSchema.parse(result.value);
  });
}
