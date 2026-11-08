import {QueuePageQuerySchema} from "@dx-rework/contracts";
import { requestValidationMessage } from "@dx-rework/contracts/validation-language";
import {
  ApproveOwnFactoryApprovalSchema,
  IdempotencyKeySchema,
  OwnFactoryApprovalOrderParamsSchema,
  OwnFactoryApprovalParamsSchema,
  OwnFactoryApprovalQueueResponseSchema,
  OwnFactoryApprovalResponseSchema,
  RejectOwnFactoryApprovalSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { OwnFactoryApprovalApplicationService } from "./own-factory-approval-application-service.js";

type HttpService = Pick<OwnFactoryApprovalApplicationService, "listQueue" | "get" | "approve" | "reject">;
const token = (request: FastifyRequest): string | undefined => request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith("dx_rework_session="))?.slice(18);
const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } } }, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", requestValidationMessage(result), 400); return result.data; };

export type OwnFactoryApprovalHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: HttpService;
  root?: RootAuthority;
}>;

export function registerOwnFactoryApprovalRoutes(app: FastifyInstance, dependencies: OwnFactoryApprovalHttpDependencies): void {
  const actor = async (request: FastifyRequest, capability: string): Promise<TrustedActorContext> =>
    businessActor(dependencies.root, await dependencies.authenticate(token(request)), request.id, capability, "owner_group");
  const key = (request: FastifyRequest): string => parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

  app.get("/own-factory-approvals/queue", async (request) => {
    const currentActor=await actor(request,"own_factory:view");
    const query=parse(QueuePageQuerySchema,request.query);
    return OwnFactoryApprovalQueueResponseSchema.parse(await (Object.keys(query).length ? dependencies.service.listQueue(currentActor,query) : dependencies.service.listQueue(currentActor)));
  });
  app.get("/rework-orders/:reworkOrderId/own-factory-approval", async (request) => OwnFactoryApprovalResponseSchema.parse(await dependencies.service.get(await actor(request, "own_factory:view"), parse(OwnFactoryApprovalOrderParamsSchema, request.params).reworkOrderId)));
  app.post("/own-factory-approvals/:approvalId/approve", async (request, reply) => { const result = await dependencies.service.approve(await actor(request, "own_factory:approve"), parse(OwnFactoryApprovalParamsSchema, request.params).approvalId, parse(ApproveOwnFactoryApprovalSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return OwnFactoryApprovalResponseSchema.parse(result.value); });
  app.post("/own-factory-approvals/:approvalId/reject", async (request, reply) => { const result = await dependencies.service.reject(await actor(request, "own_factory:approve"), parse(OwnFactoryApprovalParamsSchema, request.params).approvalId, parse(RejectOwnFactoryApprovalSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return OwnFactoryApprovalResponseSchema.parse(result.value); });
}
