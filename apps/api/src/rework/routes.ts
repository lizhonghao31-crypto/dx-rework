import { requestValidationMessage } from "@dx-rework/contracts/validation-language";
import { FinanceNodeParamsSchema } from "@dx-rework/contracts/reporting";
import {OriginalCraftReworkDraftSchema} from '@dx-rework/contracts/factory-flow';
import {GarmentReworkSourceSchema} from '@dx-rework/contracts/order-closure';
import {
  AddIePrecountSchema,
  AddTailDefectiveQuantitySchema,
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
  WaiveTailInspectionSchema,
  type CreateReworkDraft,
  type ReworkInitiationOptionsResponse,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
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
type CreateReworkDraftWithReceivingBatch = CreateReworkDraft & Readonly<{ receivingBatchId: string }>;
const CreateReworkDraftWithReceivingBatchSchema = {
  safeParse(value: unknown):
    | { success: true; data: CreateReworkDraftWithReceivingBatch }
    | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false, error: { issues: [{ path: ["receivingBatchId"], message: "请选择有效收货批次" }] } };
    const { receivingBatchId, ...draft } = value as Record<string, unknown>;
    if (typeof receivingBatchId !== "string" || !UUID_PATTERN.test(receivingBatchId)) {
      return { success: false, error: { issues: [{ path: ["receivingBatchId"], message: "请选择有效收货批次" }] } };
    }
    const parsed = CreateReworkDraftSchema.safeParse(draft);
    if (!parsed.success) return parsed;
    return {
      success: true,
      data: {
        ...parsed.data,
        receivingBatchId,
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
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", requestValidationMessage(result), 400);
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
  attachments?: AttachmentService;
  inspectionImageExtractor?: InspectionImageExtractionService;
  originalCraftQuality?:boolean;
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

  const finishingActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    const isOwner = user.businessRoles?.includes("owner_group") === true;
    const supervisor = user.businessRoles?.includes("tail_supervisor") === true
      && user.capabilities.includes("process:configure");
    if (!user.businessRoles?.length && !isRoot) throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    if (!isRoot && !isOwner && !supervisor) throw new ApplicationError("FORBIDDEN", "只有尾部主管、老板或超级用户可以发起本厂做尾", 403);
    return {
      actorId: user.id,
      actorRoles: [...new Set([...(user.businessRoles ?? []), ...((isOwner || isRoot) ? ["tail_supervisor"] : []), ...(isRoot ? ["root_superuser"] : [])])],
      authorizationCapability: "process:configure",
      authorizationCapabilities: [...new Set([...user.capabilities, ...((isOwner || isRoot) ? ["process:configure"] : [])])],
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

  const tailWaiverActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    const allowedRole = user.businessRoles?.some((role) =>
      role === "owner_group" || role === "production_management") === true;
    if (!user.businessRoles?.length && !isRoot) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!isRoot && (!allowedRole || !user.capabilities.includes("tail_inspection:waive"))) {
      throw new ApplicationError("FORBIDDEN", "只有老板、供应链总监或超级用户可以改为无需整查", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    const authorizationCapabilities = [...user.capabilities];
    if (isRoot && !actorRoles.includes("root_superuser")) actorRoles.push("root_superuser");
    if (isRoot && !authorizationCapabilities.includes("tail_inspection:waive")) {
      authorizationCapabilities.push("tail_inspection:waive");
    }
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "tail_inspection:waive",
      authorizationCapabilities,
      requestId: request.id,
    };
  };

  const iePrecountActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    const isIe = user.businessRoles?.includes("ie_reviewer") === true
      && user.capabilities.includes("process:review");
    if (!user.businessRoles?.length && !isRoot) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!isRoot && !isIe) {
      throw new ApplicationError("FORBIDDEN", "只有IE或Root可以记录IE预核数", 403);
    }
    return {
      actorId: user.id,
      actorRoles: [
        ...new Set([
          ...(user.businessRoles ?? []),
          ...(isRoot ? ["root_superuser", "ie_reviewer"] : []),
        ]),
      ],
      authorizationCapability: "process:review",
      authorizationCapabilities: [
        ...new Set([
          ...user.capabilities,
          ...(isRoot ? ["process:review"] : []),
        ]),
      ],
      requestId: request.id,
    };
  };

  app.get<{ Params: { receivingBatchId: string } }>(
    "/rework-orders/finishing/receiving-entry/:receivingBatchId",
    async (request) => {
      const trustedActor = await finishingActor(request);
      if (!UUID_PATTERN.test(request.params.receivingBatchId)) throw new ApplicationError("VALIDATION_ERROR", "提交资料格式不正确，请检查关联记录和填写内容", 400);
      return dependencies.service.getReceivingEntry(request.params.receivingBatchId, trustedActor);
    },
  );
  app.get("/rework-orders/finishing/initiation-options", async (request) =>
    dependencies.service.listInitiationOptions(await finishingActor(request), "inhouse_finishing"));
  app.get<{ Params: { reworkOrderId: string } }>("/rework-orders/finishing/drafts/:reworkOrderId", async (request) =>
    dependencies.service.getFinishingDraft(await finishingActor(request), parse(ReworkOrderParamsSchema, request.params).reworkOrderId));
  app.post("/rework-orders/finishing/drafts", async (request, reply) => {
    const input = parse(CreateReworkDraftWithReceivingBatchSchema, request.body);
    const result = await dependencies.service.createDraft(await finishingActor(request), input, idempotencyKey(request), "inhouse_finishing");
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });
  if(dependencies.originalCraftQuality)app.post('/rework-orders/craft-quality/drafts',async(request,reply)=>{
    const result=await dependencies.service.createCraftDraft(await actor(request),parse(OriginalCraftReworkDraftSchema,request.body),idempotencyKey(request));
    if(result.reused)reply.header('idempotency-replayed','true');
    return reply.code(201).send(result.value);
  });
  if(dependencies.originalCraftQuality)app.post('/rework-orders/garment-quality/drafts',async(request,reply)=>{
    const result=await dependencies.service.createGarmentDraft(await actor(request),parse(GarmentReworkSourceSchema,request.body),idempotencyKey(request));
    if(result.reused)reply.header('idempotency-replayed','true');
    return reply.code(201).send(result.value);
  });
  app.post("/rework-orders/drafts", async (request, reply) => {
    const result = await dependencies.service.createDraft(
      await actor(request),
      parse(CreateReworkDraftWithReceivingBatchSchema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });
  app.get<{ Params: { receivingBatchId: string } }>(
    "/rework-orders/receiving-entry/:receivingBatchId",
    async (request) => {
      await actor(request);
      if (!UUID_PATTERN.test(request.params.receivingBatchId)) {
        throw new ApplicationError("VALIDATION_ERROR", "提交资料格式不正确，请检查关联记录和填写内容", 400);
      }
      return dependencies.service.getReceivingEntry(request.params.receivingBatchId);
    },
  );
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
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/waive-tail-inspection", async (request, reply) => {
    const params = parse(ReworkOrderParamsSchema, request.params);
    const result = await dependencies.service.waiveTailInspection(
      await tailWaiverActor(request),
      params.reworkOrderId,
      parse(WaiveTailInspectionSchema, request.body),
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
    app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/finishing/submit-v2", async (request, reply) => {
      const params = parse(ReworkOrderParamsSchema, request.params);
      try {
        const result = await dependencies.v2SubmissionService!.submit(
          await finishingActor(request), params.reworkOrderId,
          parse(SubmitReworkOrderSchema, request.body), idempotencyKey(request), "inhouse_finishing",
        );
        if (result.reused) void reply.header("idempotency-replayed", "true");
        return result.value;
      } catch (error: unknown) {
        return translateTodoRoutingError(error);
      }
    });
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
    app.get<{ Params: { reworkOrderId: string; node: string }; Querystring: { entryId?: string } }>("/rework-orders/:reworkOrderId/history/:node", async (request) => {
      const params = parse(FinanceNodeParamsSchema, request.params);
      return dependencies.businessDetailService!.history(await authenticatedActor(request), params.reworkOrderId, params.node, request.query.entryId);
    });
    app.get<{ Params: { reworkOrderId: string }; Querystring:{originalNodes?:string} }>("/rework-orders/:reworkOrderId/business-detail", async (request) => {
      const actor=await authenticatedActor(request),{reworkOrderId}=parse(ReworkOrderParamsSchema, request.params);
      const service=dependencies.businessDetailService!;
      return request.query.originalNodes==='true'?service.get(actor,reworkOrderId,true):service.get(actor,reworkOrderId);
    });
    app.post<{
      Params: { reworkOrderId: string };
      Body: unknown;
    }>("/rework-orders/:reworkOrderId/ie-precounts", async (request, reply) => {
      const result = await dependencies.businessDetailService!.addIePrecount(
        await iePrecountActor(request),
        parse(ReworkOrderParamsSchema, request.params).reworkOrderId,
        parse(AddIePrecountSchema, request.body),
        idempotencyKey(request),
      );
      return reply.code(result.reused ? 200 : 201).send(result.value);
    });
    app.post<{
      Params: { reworkOrderId: string };
      Body: unknown;
    }>("/rework-orders/:reworkOrderId/tail-defective-quantity", async (request, reply) => {
      const result = await dependencies.businessDetailService!.addTailDefectiveQuantity(
        await authenticatedActor(request),
        parse(ReworkOrderParamsSchema, request.params).reworkOrderId,
        parse(AddTailDefectiveQuantitySchema, request.body),
        idempotencyKey(request),
      );
      return reply.code(result.reused ? 200 : 201).send(result.value);
    });
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
}
