import {
  CreateReworkDraftSchema,
  DeleteReworkOrderResponseSchema,
  ExtractInspectionReportImageSchema,
  IdempotencyKeySchema,
  ReworkOrderParamsSchema,
  ReworkOrdersQuerySchema,
  REWORK_IMAGE_SUPPLEMENT_ROLES,
  SubmitReworkOrderSchema,
  SupplementReworkOrderImagesSchema,
  TransitionReworkOrderSchema,
  UpdateReworkDraftSchema,
  type CreateReworkDraft,
  type ReworkInitiationOptionsResponse,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { registerErpIntegrationRoutes, type ErpIntegrationHttpDependencies } from "../erp/erp-integration-routes.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { ReworkBusinessDetailService } from "./rework-business-detail-service.js";
import type { InspectionImageExtractionService } from "./inspection-image-extraction-service.js";
import type { ReworkInitiationService } from "./service.js";
import { registerReworkSupplyContextRoutes } from "./supply-context-routes.js";
import type { ReworkSupplyContextService } from "./supply-context-service.js";
import { registerReworkV2DraftRoutes } from "./v2-draft-routes.js";
import type { ReworkV2DraftService } from "./v2-draft-service.js";
import type { ReworkV2SubmissionService } from "./v2-submission-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CreateReworkDraftWithReceivingBatch = CreateReworkDraft & Readonly<{ receivingBatchId?: string }>;
const CreateReworkDraftWithReceivingBatchSchema = {
  safeParse(value: unknown):
    | { success: true; data: CreateReworkDraftWithReceivingBatch }
    | { success: false } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false };
    const { receivingBatchId, ...draft } = value as Record<string, unknown>;
    if (receivingBatchId !== undefined && (typeof receivingBatchId !== "string" || !UUID_PATTERN.test(receivingBatchId))) {
      return { success: false };
    }
    const parsed = CreateReworkDraftSchema.safeParse(draft);
    if (!parsed.success) return { success: false };
    return {
      success: true,
      data: {
        ...parsed.data,
        ...(typeof receivingBatchId === "string" ? { receivingBatchId } : {}),
      },
    };
  },
};

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
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400);
  return result.data;
};
const idempotencyKey = (request: FastifyRequest): string => parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

const translateTodoRoutingError = (error: unknown): never => {
  if (error instanceof ApplicationError && error.code === "CONFLICT" && error.message.includes("Todo recipient is not uniquely routable")) {
    throw new ApplicationError("CONFLICT", "尾部主管接收人尚未唯一配置，请在权限管理确认“尾部主管”角色后重试", 409);
  }
  throw error;
};

export type ReworkHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: ReworkInitiationService;
  v2DraftService?: ReworkV2DraftService;
  v2SubmissionService?: ReworkV2SubmissionService;
  businessDetailService?: ReworkBusinessDetailService;
  supplyContextService?: ReworkSupplyContextService;
  root?: RootAuthority;
  listInitiationOptions?: () => Promise<ReworkInitiationOptionsResponse>;
  erp?: Omit<ErpIntegrationHttpDependencies, "authenticateSession">;
  attachments?: AttachmentService;
  inspectionImageExtractor?: InspectionImageExtractionService;
}>;

export function registerReworkRoutes(app: FastifyInstance, dependencies: ReworkHttpDependencies): void {
  const authenticatedActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    if (!user.businessRoles?.length && !isRoot) throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    const actorRoles = [...(user.businessRoles ?? [])];
    if (isRoot && !actorRoles.includes("root_superuser")) actorRoles.push("root_superuser");
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "business:detail:read",
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };

  const actor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    const isOwner = user.businessRoles?.includes("owner_group") === true;
    const isQualityControl = user.businessRoles?.includes("quality_control") === true && user.capabilities.includes("rework:initiate");
    if (!user.businessRoles?.length && !isRoot) throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    if (!isRoot && !isOwner && !isQualityControl) throw new ApplicationError("FORBIDDEN", "只有品控、老板或超级用户可以发起和维护返工单", 403);
    const actorRoles = [...(user.businessRoles ?? [])];
    const authorizationCapabilities = [...user.capabilities];
    if (isRoot && !actorRoles.includes("root_superuser")) actorRoles.push("root_superuser");
    if ((isRoot || isOwner) && !actorRoles.includes("quality_control")) actorRoles.push("quality_control");
    if ((isRoot || isOwner) && !authorizationCapabilities.includes("rework:initiate")) authorizationCapabilities.push("rework:initiate");
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "rework:initiate",
      authorizationCapabilities,
      requestId: request.id,
    };
  };

  const supplementalImageActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    if (!user.businessRoles?.length && !isRoot) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!isRoot && !user.businessRoles?.some((role) => REWORK_IMAGE_SUPPLEMENT_ROLES.includes(
      role as (typeof REWORK_IMAGE_SUPPLEMENT_ROLES)[number],
    ))) {
      throw new ApplicationError("FORBIDDEN", "当前角色无权补充返工单图片", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    if (isRoot && !actorRoles.includes("root_superuser")) actorRoles.push("root_superuser");
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "tools:user",
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };

  const rootDeleteActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    if (!isRoot) throw new ApplicationError("FORBIDDEN", "只有超级用户可以删除返工单", 403);
    return {
      actorId: user.id,
      actorRoles: [...(user.businessRoles ?? []), "root_superuser"],
      authorizationCapability: "rework:delete",
      authorizationCapabilities: [...user.capabilities, "rework:delete"],
      requestId: request.id,
    };
  };

  app.post("/rework-orders/drafts", async (request, reply) => {
    const result = await dependencies.service.createDraft(
      await actor(request),
      parse(CreateReworkDraftWithReceivingBatchSchema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });
  if (dependencies.attachments && dependencies.inspectionImageExtractor) {
    app.post("/rework-orders/inspection-report-extractions", async (request) => {
      const trustedActor = await actor(request);
      const { attachmentId } = parse(ExtractInspectionReportImageSchema, request.body);
      const image = await dependencies.attachments!.createDownloadIntent(
        trustedActor,
        attachmentId,
        undefined,
        "inline",
      );
      return dependencies.inspectionImageExtractor!.extract(image.downloadUrl);
    });
  }
  app.put<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/draft", async (request, reply) => {
    const params = parse(ReworkOrderParamsSchema, request.params);
    const result = await dependencies.service.updateDraft(await actor(request), params.reworkOrderId, parse(UpdateReworkDraftSchema, request.body), idempotencyKey(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return result.value;
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/supplemental-images", async (request, reply) => {
    const params = parse(ReworkOrderParamsSchema, request.params);
    const result = await dependencies.service.supplementOrderImages(
      await supplementalImageActor(request),
      params.reworkOrderId,
      parse(SupplementReworkOrderImagesSchema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return result.value;
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/submit", async (request, reply) => {
    const params = parse(ReworkOrderParamsSchema, request.params);
    try {
      const result = await dependencies.service.submit(await actor(request), params.reworkOrderId, parse(SubmitReworkOrderSchema, request.body), idempotencyKey(request));
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    } catch (error: unknown) {
      return translateTodoRoutingError(error);
    }
  });
  if (dependencies.v2SubmissionService) {
    app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/submit-v2", async (request, reply) => {
      const params = parse(ReworkOrderParamsSchema, request.params);
      try {
        const result = await dependencies.v2SubmissionService!.submit(
          await actor(request),
          params.reworkOrderId,
          parse(SubmitReworkOrderSchema, request.body),
          idempotencyKey(request),
        );
        if (result.reused) void reply.header("idempotency-replayed", "true");
        return result.value;
      } catch (error: unknown) {
        return translateTodoRoutingError(error);
      }
    });
  }
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/withdraw", async (request, reply) => {
    const params = parse(ReworkOrderParamsSchema, request.params);
    const result = await dependencies.service.withdraw(await actor(request), params.reworkOrderId, parse(TransitionReworkOrderSchema, request.body), idempotencyKey(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return result.value;
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/cancel", async (request, reply) => {
    const params = parse(ReworkOrderParamsSchema, request.params);
    const result = await dependencies.service.cancel(await actor(request), params.reworkOrderId, parse(TransitionReworkOrderSchema, request.body), idempotencyKey(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return result.value;
  });
  app.delete<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId", async (request, reply) => {
    const params = parse(ReworkOrderParamsSchema, request.params);
    const result = await dependencies.service.deleteByRoot(await rootDeleteActor(request), params.reworkOrderId, idempotencyKey(request));
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return DeleteReworkOrderResponseSchema.parse(result.value);
  });
  app.get("/rework-orders/initiation-options", async (request) => {
    const accessActor = await actor(request);
    const rankedOptions = await dependencies.service.listInitiationOptions(accessActor);
    if (!dependencies.listInitiationOptions) return rankedOptions;
    const masterOptions = await dependencies.listInitiationOptions();
    const usageBySupplierId = new Map(rankedOptions.factories.map((factory) => [factory.supplierId, factory]));
    return {
      merchandisers: masterOptions.merchandisers,
      factories: masterOptions.factories.map((factory) => {
        const usage = usageBySupplierId.get(factory.supplierId);
        return {
          ...factory,
          personalUsageCount: usage?.personalUsageCount ?? 0,
          globalUsageCount: usage?.globalUsageCount ?? 0,
          lastUsedAt: usage?.lastUsedAt ?? null,
        };
      }),
      colorSuggestions: rankedOptions.colorSuggestions ?? [],
    };
  });
  if (dependencies.businessDetailService) {
    app.get<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/business-detail", async (request) =>
      dependencies.businessDetailService!.get(
        await authenticatedActor(request),
        parse(ReworkOrderParamsSchema, request.params).reworkOrderId,
      ));
  }
  app.get<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId", async (request) => dependencies.service.getOwn(await actor(request), parse(ReworkOrderParamsSchema, request.params).reworkOrderId));
  app.get("/rework-orders", async (request) => {
    const query = parse(ReworkOrdersQuerySchema, request.query);
    return dependencies.service.listOwn(await actor(request), query.status);
  });

  if (dependencies.v2DraftService) {
    registerReworkV2DraftRoutes(app, {
      authenticate: dependencies.authenticate,
      service: dependencies.v2DraftService,
      ...(dependencies.root ? { root: dependencies.root } : {}),
    });
  }
  if (dependencies.supplyContextService) {
    registerReworkSupplyContextRoutes(app, {
      authenticate: dependencies.authenticate,
      service: dependencies.supplyContextService,
      ...(dependencies.root ? { root: dependencies.root } : {}),
    });
  }
  if (dependencies.erp) registerErpIntegrationRoutes(app, { authenticateSession: dependencies.authenticate, ...dependencies.erp });
}
