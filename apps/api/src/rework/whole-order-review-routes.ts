import {
  CorrectWorkReportQuantitySchema,
  IdempotencyKeySchema,
  RejectWorkReportSchema,
  ReviewFinalQuantitySchema,
  ReviewWholeOrderSchema,
  WholeOrderReviewParamsSchema,
  WholeOrderReviewQuerySchema,
  WholeOrderReviewResponseSchema,
  WorkReportRejectionParamsSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  BUSINESS_READ_ALL_CAPABILITY,
  businessActor,
  isRootUser,
} from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
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
  root?: RootAuthority;
}>;

export function registerWholeOrderReviewRoutes(app: FastifyInstance, dependencies: WholeOrderReviewHttpDependencies): void {
  const actor = async (
    request: FastifyRequest,
    capability: string,
    rootActingRole?: string,
  ): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    return businessActor(
      dependencies.root,
      user,
      request.id,
      capability,
      rootActingRole,
    );
  };

  const readActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    const isRoot = await isRootUser(dependencies.root, user.id);
    if (isRoot) {
      const rootActor = await businessActor(
        dependencies.root,
        user,
        request.id,
        "submission:audit",
        "tail_supervisor",
      );
      return {
        ...rootActor,
        actorRoles: [...new Set([...rootActor.actorRoles, "ie_reviewer", "order_merchandiser"])],
        authorizationCapabilities: [
          ...new Set([
            ...(rootActor.authorizationCapabilities ?? []),
            "submission:audit",
            "quantity:adjust",
            "quantity:confirm",
            "process:review",
          ]),
        ],
      };
    }
    if (
      user.businessRoles?.includes("owner_group")
      && user.capabilities.includes(BUSINESS_READ_ALL_CAPABILITY)
    ) {
      return businessActor(dependencies.root, user, request.id, BUSINESS_READ_ALL_CAPABILITY);
    }
    if (
      user.businessRoles?.includes("tail_supervisor")
      && user.capabilities.includes("submission:audit")
    ) {
      return businessActor(dependencies.root, user, request.id, "submission:audit");
    }
    if (
      user.businessRoles?.includes("order_merchandiser")
      && user.capabilities.includes("quantity:confirm")
    ) {
      return businessActor(dependencies.root, user, request.id, "quantity:confirm");
    }
    if (
      user.businessRoles?.includes("ie_reviewer")
      && user.capabilities.includes("process:review")
    ) {
      return businessActor(dependencies.root, user, request.id, "process:review");
    }
    return businessActor(dependencies.root, user, request.id, "submission:audit");
  };

  app.get<{ Params: { reworkOrderId: string }; Querystring: { configurationItemId?: string } }>("/rework-orders/:reworkOrderId/whole-order-review", async (request) => {
    const query = parse(WholeOrderReviewQuerySchema, request.query);
    const serviceActor = await readActor(request);
    const orderId = parse(WholeOrderReviewParamsSchema, request.params).reworkOrderId;
    return WholeOrderReviewResponseSchema.parse(query.configurationItemId
      ? await dependencies.service.get(serviceActor, orderId, query.configurationItemId)
      : await dependencies.service.get(serviceActor, orderId));
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/whole-order-review/approve", async (request, reply) => {
    const result = await dependencies.service.approve(await actor(request, "submission:audit", "tail_supervisor"), parse(WholeOrderReviewParamsSchema, request.params).reworkOrderId, parse(ReviewWholeOrderSchema, request.body), key(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return WholeOrderReviewResponseSchema.parse(result.value);
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/whole-order-review/ie-review", async (request, reply) => {
    const result = await dependencies.service.reviewFinalQuantity(
      await actor(request, "process:review", "ie_reviewer"),
      parse(WholeOrderReviewParamsSchema, request.params).reworkOrderId,
      parse(ReviewFinalQuantitySchema, request.body),
      key(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return WholeOrderReviewResponseSchema.parse(result.value);
  });
  app.post<{ Params: { workReportId: string } }>("/work-reports/:workReportId/reject", async (request, reply) => {
    const result = await dependencies.service.rejectReport(await actor(request, "submission:audit", "tail_supervisor"), parse(WorkReportRejectionParamsSchema, request.params).workReportId, parse(RejectWorkReportSchema, request.body), key(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return WholeOrderReviewResponseSchema.parse(result.value);
  });
  app.post<{ Params: { workReportId: string } }>("/work-reports/:workReportId/effective-quantity", async (request, reply) => {
    const result = await dependencies.service.correctReportQuantity(
      await actor(request, "submission:audit", "tail_supervisor"),
      parse(WorkReportRejectionParamsSchema, request.params).workReportId,
      parse(CorrectWorkReportQuantitySchema, request.body),
      key(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return WholeOrderReviewResponseSchema.parse(result.value);
  });
}
