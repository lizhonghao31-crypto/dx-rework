import {QueuePageQuerySchema} from "@dx-rework/contracts";
import { requestValidationMessage } from "@dx-rework/contracts/validation-language";
import { IdempotencyKeySchema } from "@dx-rework/contracts";
import {
  AllocateExternalSuppliersSchema,
  ApproveExternalDeductionSpecialApprovalSchema,
  CloseExternalDeductionCaseSchema,
  CreateExternalTemporarySupplierSchema,
  CreateExternalDeductionEntrySchema,
  CreateExternalDeductionFollowUpSchema,
  CreateExternalResponsibilityRevisionSchema,
  DecideExternalResponsibilityRevisionSchema,
  ExternalResponsibilityBatchParamsSchema,
  ExternalResponsibilityBatchResponseSchema,
  ExternalResponsibilityCaseParamsSchema,
  ExternalResponsibilityCaseResponseSchema,
  ExternalResponsibilityOrderParamsSchema,
  ExternalResponsibilityQueueResponseSchema,
  ExternalResponsibilityRevisionParamsSchema,
  PayablesAcceptExternalResponsibilityCaseSchema,
  PayablesReturnExternalResponsibilityCaseSchema,
  RequestExternalDeductionSpecialApprovalSchema,
  ReturnExternalDeductionSpecialApprovalSchema,
  SubmitExternalResponsibilityCaseSchema,
} from "@dx-rework/contracts/external-responsibility";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ExternalResponsibilityApplicationService } from "./external-responsibility-application-service.js";

type HttpService = Pick<ExternalResponsibilityApplicationService, "listQueue" | "listSupplierOptions" | "createTemporarySupplier" | "get" | "getCase" | "allocateSuppliers" | "submit" | "payablesAccept" | "payablesReturn" | "followUp" | "recordDeduction" | "close" | "requestSpecialApproval" | "approveSpecialApproval" | "returnSpecialApproval" | "requestRevision" | "approveRevision" | "rejectRevision">;
const token = (request: FastifyRequest): string | undefined => request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith("dx_rework_session="))?.slice(18);
const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } } }, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", requestValidationMessage(result), 400); return result.data; };

export type ExternalResponsibilityHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: HttpService;
  root?: RootAuthority;
}>;

export function registerExternalResponsibilityRoutes(app: FastifyInstance, dependencies: ExternalResponsibilityHttpDependencies): void {
  const actor = async (request: FastifyRequest, capability: string): Promise<TrustedActorContext> =>
    businessActor(
      dependencies.root,
      await dependencies.authenticate(token(request)),
      request.id,
      capability,
    );
  const key = (request: FastifyRequest) => parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

  app.get("/external-responsibilities/queue", async (request) => {
    const currentActor=await actor(request,"external_responsibility:view");
    const query=parse(QueuePageQuerySchema,request.query);
    return ExternalResponsibilityQueueResponseSchema.parse(await (Object.keys(query).length ? dependencies.service.listQueue(currentActor,query) : dependencies.service.listQueue(currentActor)));
  });
  app.get("/rework-orders/:reworkOrderId/external-responsibilities", async (request) => ExternalResponsibilityBatchResponseSchema.parse(await dependencies.service.get(await actor(request, "external_responsibility:view"), parse(ExternalResponsibilityOrderParamsSchema, request.params).reworkOrderId)));
  app.get("/rework-orders/:reworkOrderId/external-responsibilities/supplier-options", async (request) => dependencies.service.listSupplierOptions(await actor(request, "external_responsibility:sign"), parse(ExternalResponsibilityOrderParamsSchema, request.params).reworkOrderId));
  app.post("/rework-orders/:reworkOrderId/external-responsibilities/temporary-suppliers", async (request, reply) => {
    const result = await dependencies.service.createTemporarySupplier(
      await actor(request, "external_responsibility:sign"),
      parse(ExternalResponsibilityOrderParamsSchema, request.params).reworkOrderId,
      parse(CreateExternalTemporarySupplierSchema, request.body),
      key(request),
    );
    if (result.reused) reply.header("idempotency-replayed", "true");
    return reply.code(result.reused ? 200 : 201).send(result.value);
  });
  app.get("/external-responsibility-cases/:caseId", async (request) => ExternalResponsibilityCaseResponseSchema.parse(await dependencies.service.getCase(await actor(request, "external_responsibility:view"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId)));
  app.post("/external-responsibility-batches/:batchId/allocate-suppliers", async (request, reply) => { const result = await dependencies.service.allocateSuppliers(await actor(request, "external_responsibility:sign"), parse(ExternalResponsibilityBatchParamsSchema, request.params).batchId, parse(AllocateExternalSuppliersSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityBatchResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/submit", async (request, reply) => { const result = await dependencies.service.submit(await actor(request, "external_responsibility:sign"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(SubmitExternalResponsibilityCaseSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/payables-accept", async (request, reply) => { const result = await dependencies.service.payablesAccept(await actor(request, "external_responsibility:payables_confirm"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(PayablesAcceptExternalResponsibilityCaseSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/payables-return", async (request, reply) => { const result = await dependencies.service.payablesReturn(await actor(request, "external_responsibility:payables_confirm"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(PayablesReturnExternalResponsibilityCaseSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/follow-ups", async (request, reply) => { const result = await dependencies.service.followUp(await actor(request, "external_deduction:follow_up"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(CreateExternalDeductionFollowUpSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/deductions", async (request, reply) => { const result = await dependencies.service.recordDeduction(await actor(request, "external_deduction:record"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(CreateExternalDeductionEntrySchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/close", async (request, reply) => { const result = await dependencies.service.close(await actor(request, "external_deduction:close"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(CloseExternalDeductionCaseSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/special-approval-requests", async (request, reply) => { const result = await dependencies.service.requestSpecialApproval(await actor(request, "external_deduction:close"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(RequestExternalDeductionSpecialApprovalSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return reply.code(result.reused ? 200 : 201).send(ExternalResponsibilityCaseResponseSchema.parse(result.value)); });
  app.post("/external-responsibility-cases/:caseId/special-approval/approve", async (request, reply) => { const result = await dependencies.service.approveSpecialApproval(await actor(request, "external_deduction:special_approve"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(ApproveExternalDeductionSpecialApprovalSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/special-approval/return", async (request, reply) => { const result = await dependencies.service.returnSpecialApproval(await actor(request, "external_deduction:special_approve"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(ReturnExternalDeductionSpecialApprovalSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-cases/:caseId/revision-requests", async (request, reply) => { const result = await dependencies.service.requestRevision(await actor(request, "external_responsibility:request_revision"), parse(ExternalResponsibilityCaseParamsSchema, request.params).caseId, parse(CreateExternalResponsibilityRevisionSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-revision-requests/:requestId/approve", async (request, reply) => { const result = await dependencies.service.approveRevision(await actor(request, "external_responsibility:approve_revision"), parse(ExternalResponsibilityRevisionParamsSchema, request.params).requestId, parse(DecideExternalResponsibilityRevisionSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
  app.post("/external-responsibility-revision-requests/:requestId/reject", async (request, reply) => { const result = await dependencies.service.rejectRevision(await actor(request, "external_responsibility:approve_revision"), parse(ExternalResponsibilityRevisionParamsSchema, request.params).requestId, parse(DecideExternalResponsibilityRevisionSchema, request.body), key(request)); if (result.reused) reply.header("idempotency-replayed", "true"); return ExternalResponsibilityCaseResponseSchema.parse(result.value); });
}
