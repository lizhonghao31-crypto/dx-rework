import { requestValidationMessage } from "@dx-rework/contracts/validation-language";
import {
  ReopenOrderResponsibilitySchema,
  ConfirmHighMultiplierSchema,
  CreateResponsibilityDraftSchema,
  FinalizeResponsibilitySchema,
  IdempotencyKeySchema,
  OwnerSignatureCommandSchema,
  ResponsibilityDeterminationParamsSchema,
  ResponsibilityDeterminationResponseSchema,
  ResponsibilityOrderParamsSchema,
  ResponsibilitySupplierOptionsResponseSchema,
  TakeoverResponsibilitySchema,
  TransferResponsibilitySchema,
} from "@dx-rework/contracts";
import { ResponsibilityQueueResponseSchema } from "@dx-rework/contracts/responsibility-queue";
import { ResponsibilityTransferOptionsResponseSchema } from "@dx-rework/contracts/responsibility-transfer";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { businessActor, isRootUser } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ResponsibilityDeterminationApplicationService } from "./responsibility-determination-application-service.js";

type ResponsibilityDeterminationHttpService = Pick<ResponsibilityDeterminationApplicationService, "revisions" | "listQueue" | "get" | "listTransferCandidates" | "listSupplierOptions" | "saveDraft" | "finalize" | "transfer" | "takeover" | "confirmHighMultiplier" | "approveOwnerSignature" | "rejectOwnerSignature">;
const token = (request: FastifyRequest): string | undefined => request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith("dx_rework_session="))?.slice(18);
const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } } }, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", requestValidationMessage(result), 400); return result.data; };

export type ResponsibilityDeterminationHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: ResponsibilityDeterminationHttpService;
  root?: RootAuthority;
}>;

export function registerResponsibilityDeterminationRoutes(app: FastifyInstance, dependencies: ResponsibilityDeterminationHttpDependencies): void {
  const actor = async (request: FastifyRequest, capability: string): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    if (request.method === "GET" && user.businessRoles?.includes("pmc") && user.capabilities.includes("external_responsibility:view")
      && !user.capabilities.includes(capability)) capability = "external_responsibility:view";
    const trusted = await businessActor(
      dependencies.root,
      user,
      request.id,
      capability,
      "owner_group",
    );
    if (!(await isRootUser(dependencies.root, user.id))) return trusted;
    return {
      ...trusted,
      authorizationCapabilities: [
        ...new Set([
          ...(trusted.authorizationCapabilities ?? []),
          "responsibility:determine",
          "responsibility:takeover",
          "responsibility:confirm_high_multiplier",
          "responsibility:owner_sign",
        ]),
      ],
    };
  };
  const key = (request: FastifyRequest): string => parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

  app.get("/rework-orders/:reworkOrderId/responsibility-revisions", async request => dependencies.service.revisions.get(await actor(request,"responsibility:determine"),parse(ResponsibilityOrderParamsSchema,request.params).reworkOrderId));
  app.post("/rework-orders/:reworkOrderId/responsibility-revisions", async (request,reply) => {
    const result=await dependencies.service.revisions.reopen(await actor(request,"responsibility:determine"),parse(ResponsibilityOrderParamsSchema,request.params).reworkOrderId,parse(ReopenOrderResponsibilitySchema,request.body),key(request));
    if(result.reused)reply.header("idempotency-replayed","true");return reply.code(201).send(result.value);
  });
  app.get("/responsibility-determinations/queue", async (request) => ResponsibilityQueueResponseSchema.parse(await dependencies.service.listQueue(await actor(request, "responsibility:determine"))));
  app.get("/rework-orders/:reworkOrderId/responsibility-determination", async (request) => {
    const currentActor = await actor(request, "responsibility:determine");
    const result = await dependencies.service.get(currentActor, parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId);
    return ResponsibilityDeterminationResponseSchema.parse(result);
  });
  app.get("/rework-orders/:reworkOrderId/responsibility-determinations/transfer-options", async (request) => {
    const result = await dependencies.service.listTransferCandidates(
      await actor(request, "responsibility:determine"),
      parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId,
    );
    return ResponsibilityTransferOptionsResponseSchema.parse(result);
  });
  app.get("/rework-orders/:reworkOrderId/responsibility-determinations/supplier-options", async (request) =>
    ResponsibilitySupplierOptionsResponseSchema.parse(await dependencies.service.listSupplierOptions(
      await actor(request, "responsibility:determine"),
      parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId,
    )));
  app.post("/rework-orders/:reworkOrderId/responsibility-determinations/drafts", async (request, reply) => { const result = await dependencies.service.saveDraft(await actor(request, "responsibility:determine"), parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId, parse(CreateResponsibilityDraftSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return reply.code(201).send(ResponsibilityDeterminationResponseSchema.parse(result.value)); });
  app.post("/rework-orders/:reworkOrderId/responsibility-determinations/finalize", async (request, reply) => { const result = await dependencies.service.finalize(await actor(request, "responsibility:determine"), parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId, parse(FinalizeResponsibilitySchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ResponsibilityDeterminationResponseSchema.parse(result.value); });
  app.post("/rework-orders/:reworkOrderId/responsibility-determinations/transfer", async (request, reply) => { const result = await dependencies.service.transfer(await actor(request, "responsibility:determine"), parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId, parse(TransferResponsibilitySchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ResponsibilityDeterminationResponseSchema.parse(result.value); });
  app.post("/rework-orders/:reworkOrderId/responsibility-determinations/takeover", async (request, reply) => { const result = await dependencies.service.takeover(await actor(request, "responsibility:takeover"), parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId, parse(TakeoverResponsibilitySchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ResponsibilityDeterminationResponseSchema.parse(result.value); });
  app.post("/responsibility-determinations/:determinationId/high-multiplier-confirm", async (request, reply) => { const result = await dependencies.service.confirmHighMultiplier(await actor(request, "responsibility:confirm_high_multiplier"), parse(ResponsibilityDeterminationParamsSchema, request.params).determinationId, parse(ConfirmHighMultiplierSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ResponsibilityDeterminationResponseSchema.parse(result.value); });
  app.post("/rework-orders/:reworkOrderId/responsibility-owner-signature/approve", async (request, reply) => { const result = await dependencies.service.approveOwnerSignature(await actor(request, "responsibility:owner_sign"), parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId, parse(OwnerSignatureCommandSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ResponsibilityDeterminationResponseSchema.parse(result.value); });
  app.post("/rework-orders/:reworkOrderId/responsibility-owner-signature/reject", async (request, reply) => { const result = await dependencies.service.rejectOwnerSignature(await actor(request, "responsibility:owner_sign"), parse(ResponsibilityOrderParamsSchema, request.params).reworkOrderId, parse(OwnerSignatureCommandSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ResponsibilityDeterminationResponseSchema.parse(result.value); });
}
