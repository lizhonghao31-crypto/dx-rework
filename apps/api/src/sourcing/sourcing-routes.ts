import { z } from "zod";
import { registerProductionClosureRoutes } from "./production-closure-routes.js";
import type { ProductionClosureService } from "./production-closure-service.js";
import { registerProductionDashboardRoutes } from "./production-dashboard-routes.js";
import type { ProductionDashboardService } from "./production-dashboard-service.js";
import { registerProductionReportingRoutes } from "./production-reporting-routes.js";
import type { ProductionReportingService } from "./production-reporting-service.js";
import {
  CorrectSourcingCaseSchema, ReturnSourcingCaseSchema,
  CreateSourcingCaseSchema,
  CorrectSourcingBudgetPriceSchema,
  SourcingHistoryNodeSchema,
  ReviseSourcingStylesSchema,
  DispatchSourcingOrderSchema,
  SourcingDispatchStateSchema,
  SourcingProductionOrderSchema,
  SourcingProductionOrderListSchema,
  CreateSourcingIeQuoteSchema,
  DeleteSourcingCaseResponseSchema,
  DecideSourcingExceptionSchema,
  DecideSourcingFactoryChangeSchema,
  DecideSourcingOwnerSchema,
  RecordSourcingFinanceReconciliationSchema,
  RecordSourcingManagementDecisionSchema,
  RequestSourcingFactoryChangeSchema,
  RequestSourcingPriceReapplicationSchema,DecideSourcingPriceReapplicationSchema,SourcingPriceReapplicationStateSchema,
  SOURCING_IMAGE_SUPPLEMENT_ROLES,
  SourcingContractStateResponseSchema,ContractInformationRefreshResponseSchema,
  SourcingContractReturnUploadSchema,
  SourcingContractReturnResponseSchema,
  SourcingMerchandiserOptionsSchema,
  SupplementSourcingContractSchema,
  SupplementSourcingImagesSchema,
  ContractTemplateContentSchema, ContractTemplateStateSchema, SaveContractTemplateSchema,
  ContractRefreshPreviewSchema, RefreshContractInformationSchema, ContractContentStateSchema, SaveContractContentSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor, isRootUser } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import { authenticateForRequest, type RequestAuthenticator } from "../auth/request-identity-context.js";
import { ApplicationError } from "../platform/errors.js";
import type { SourcingContractService } from "./sourcing-contract-service.js";
import type { SourcingContractReturnService } from "./sourcing-contract-return-service.js";
import type { SourcingProductionService } from "./sourcing-production-service.js";
import type { SourcingService } from "./sourcing-service.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((part) => part.trim())
  .find((part) => part.startsWith("dx_rework_session="))
  ?.slice("dx_rework_session=".length);

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "提交缺少有效请求标识", 400);
  }
  return value;
};

const caseId = (value: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "报价选厂询价标识无效", 400);
  }
  return value;
};

const validationError = (message: string): never => {
  throw new ApplicationError("VALIDATION_ERROR", message, 400);
};

export type SourcingHttpDependencies = Readonly<{
  authenticate: RequestAuthenticator;
  service: SourcingService;
  contracts?: SourcingContractService;
  contractReturns?: SourcingContractReturnService;
  production?: SourcingProductionService;
  reporting?: ProductionReportingService;
  dashboard?: ProductionDashboardService;
  closure?: ProductionClosureService;
  root?: RootAuthority;
}>;

export function registerSourcingRoutes(
  app: FastifyInstance,
  dependencies: SourcingHttpDependencies,
): void {
  if (dependencies.closure) registerProductionClosureRoutes(app, {authenticate:dependencies.authenticate,root:dependencies.root,service:dependencies.closure});
  if (dependencies.reporting) registerProductionReportingRoutes(app, { authenticate: dependencies.authenticate, root: dependencies.root, service: dependencies.reporting });
  if (dependencies.dashboard) registerProductionDashboardRoutes(app, { authenticate: dependencies.authenticate, root: dependencies.root, service: dependencies.dashboard });
  const readActor = async (request: FastifyRequest) => {
    const user = await authenticateForRequest(dependencies.authenticate, token(request), request, "handler");
    const root = await isRootUser(dependencies.root, user.id);
    if (!root && !user.capabilities.includes("sourcing:view")) {
      throw new ApplicationError("FORBIDDEN", "无权查看报价选厂数据", 403);
    }
    return businessActor(
      dependencies.root,
      user,
      request.id,
      "sourcing:view",
    );
  };

  const actionActor = async (
    request: FastifyRequest,
    role: "order_merchandiser" | "ie_reviewer" | "production_management" | "owner_group" | "factory_payables",
    capability:
      | "sourcing:inquiry:create"
      | "sourcing:price:quote"
      | "sourcing:decision:record"
      | "sourcing:owner:approve"
      | "sourcing:contract:record"
      | "sourcing:factory_change:request"
      | "sourcing:factory_change:verify"
      | "sourcing:finance:reconcile"
      | "sourcing:exception:verify",
  ) => {
    const user = await authenticateForRequest(dependencies.authenticate, token(request), request, "handler");
    const root = await isRootUser(dependencies.root, user.id);
    const allowed = user.businessRoles?.includes(role) === true
      && user.capabilities.includes(capability);
    if (!root && !allowed) {
      throw new ApplicationError("FORBIDDEN", "当前岗位无权执行该报价选厂操作", 403);
    }
    return businessActor(
      dependencies.root,
      user,
      request.id,
      capability,
      root ? role : undefined,
    );
  };

  const supplementalImageActor = async (request: FastifyRequest) => {
    const user = await authenticateForRequest(dependencies.authenticate, token(request), request, "handler");
    const root = await isRootUser(dependencies.root, user.id);
    if (!user.businessRoles?.length && !root) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!root && !user.businessRoles?.some((role) => SOURCING_IMAGE_SUPPLEMENT_ROLES.includes(
      role as (typeof SOURCING_IMAGE_SUPPLEMENT_ROLES)[number],
    ))) {
      throw new ApplicationError("FORBIDDEN", "当前角色无权补充报价选厂订单图片", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    if (root && !actorRoles.includes("root_superuser")) actorRoles.push("root_superuser");
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "tools:user",
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };

  const rootBudgetCorrectionActor = async (request: FastifyRequest) => {
    const user = await authenticateForRequest(dependencies.authenticate, token(request), request, "handler");
    const root = await isRootUser(dependencies.root, user.id);
    if (!root) {
      throw new ApplicationError("FORBIDDEN", "只有超级用户可以更正预算价", 403);
    }
    return businessActor(
      dependencies.root,
      user,
      request.id,
      "sourcing:inquiry:create",
    );
  };

  const rootDeleteActor = async (request: FastifyRequest) => {
    const user = await authenticateForRequest(dependencies.authenticate, token(request), request, "handler");
    const root = await isRootUser(dependencies.root, user.id);
    if (!root) {
      throw new ApplicationError("FORBIDDEN", "只有超级用户可以删除报价选厂订单", 403);
    }
    return {
      actorId: user.id,
      actorRoles: [...(user.businessRoles ?? []), "root_superuser"],
      authorizationCapability: "sourcing:delete",
      authorizationCapabilities: [...user.capabilities, "sourcing:delete"],
      requestId: request.id,
    };
  };

  app.post<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/return-to-merchandiser",async(request,reply)=>{
    const actor=await actionActor(request,"owner_group","sourcing:owner:approve");
    const parsed=ReturnSourcingCaseSchema.safeParse(request.body);
    if(!parsed.success) validationError(parsed.error.issues[0]?.message ?? "请填写退回原因");
    const result=await dependencies.service.returnToMerchandiser(actor,caseId(request.params.sourcingCaseId),parsed.data!,idempotencyKey(request));
    return reply.code(200).send(result.value);
  });
  app.post<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/corrections",async(request,reply)=>{
    const actor=await actionActor(request,"order_merchandiser","sourcing:inquiry:create");
    const parsed=CorrectSourcingCaseSchema.safeParse(request.body);
    if(!parsed.success) validationError(parsed.error.issues[0]?.message ?? "修改资料无效");
    const result=await dependencies.service.correctCase(actor,caseId(request.params.sourcingCaseId),parsed.data!,idempotencyKey(request));
    return reply.code(200).send(result.value);
  });

  if (dependencies.production) {
    const production = dependencies.production;
    app.get<{ Params: { sourcingCaseId: string } }>("/sourcing/cases/:sourcingCaseId/dispatch", async (request) =>
      SourcingDispatchStateSchema.parse(await production.state(await readActor(request), caseId(request.params.sourcingCaseId))));
    app.post<{ Params: { sourcingCaseId: string } }>("/sourcing/cases/:sourcingCaseId/dispatch", async (request, reply) => {
      const actor = await actionActor(request, "order_merchandiser", "sourcing:contract:record");
      const parsed = DispatchSourcingOrderSchema.safeParse(request.body);
      if (!parsed.success) validationError("请确认派单信息后提交");
      const result = await production.dispatch(actor, caseId(request.params.sourcingCaseId), parsed.data!, idempotencyKey(request));
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(result.statusCode).send(SourcingProductionOrderSchema.parse(result.value));
    });
    app.get<{ Querystring: { page?: string } }>("/sourcing/production-orders", async (request) =>
      SourcingProductionOrderListSchema.parse(await production.list(await readActor(request), Number(request.query.page ?? "1"))));
    app.get<{ Params: { productionOrderId: string } }>("/sourcing/production-orders/:productionOrderId", async (request) =>
      SourcingProductionOrderSchema.parse(await production.get(await readActor(request), caseId(request.params.productionOrderId))));
  }

  app.post<{ Params: { sourcingCaseId: string } }>("/sourcing/cases/:sourcingCaseId/styles", async (request, reply) => {
    const user = await authenticateForRequest(dependencies.authenticate, token(request), request, "handler");
    const root = await isRootUser(dependencies.root,user.id);
    const manager = user.businessRoles?.includes("production_management") && user.capabilities.includes("sourcing:decision:record");
    if (!root && !manager && !(user.businessRoles?.includes("order_merchandiser") && user.capabilities.includes("sourcing:inquiry:create"))) {
      throw new ApplicationError("FORBIDDEN","当前岗位无权修改款号",403);
    }
    const parsed = ReviseSourcingStylesSchema.safeParse(request.body);
    if (!parsed.success) validationError(parsed.error.issues[0]?.message ?? "款号修改信息无效");
    const actor = await businessActor(dependencies.root,user,request.id,manager ? "sourcing:decision:record" : "sourcing:inquiry:create");
    const result = await dependencies.service.reviseStyles(actor,caseId(request.params.sourcingCaseId),parsed.data!,idempotencyKey(request));
    if (result.reused) void reply.header("idempotency-replayed","true");
    return result.value;
  });

  app.get("/sourcing/analysis", async (request,reply) => {
    const actor = await readActor(request);
    reply.header("cache-control","no-store");
    return dependencies.service.analysis(actor,request.query);
  });

  app.get("/sourcing/factories", async (request) =>
    dependencies.service.listFactories(await readActor(request)));

  app.get<{ Querystring: {
    page?: string;
    q?: string;
    status?: string;
    stage?: string;
    gender?: string;
    styleName?: string;
    contractReturn?: string;
  } }>("/sourcing/cases", async (request) => {
    for (const [value, message] of [
      [request.query.q, "搜索内容无效"],
      [request.query.stage, "流程状态筛选无效"],
      [request.query.gender, "性别筛选无效"],
      [request.query.styleName, "款式类别筛选无效"],
      [request.query.contractReturn, "合同回签状态筛选无效"],
    ] as const) {
      if (value !== undefined && typeof value !== "string") validationError(message);
    }
    const page = Number(request.query.page ?? "1");
    if (!Number.isInteger(page) || page < 1 || page > 100_000) validationError("分页页码无效");
    const status = request.query.status;
    if (status !== undefined && status !== "pending" && status !== "closed") {
      validationError("订单状态筛选无效");
    }
    const stage = request.query.stage ?? "all";
    if (!["all","ie","management","owner","finance","factory_change","exception"].includes(stage)) {
      validationError("流程状态筛选无效");
    }
    const gender = request.query.gender ?? "all";
    if (!["all","男装","女装","missing"].includes(gender)) validationError("性别筛选无效");
    if ((request.query.styleName ?? "").length > 100) validationError("款式类别不能超过100个字符");
    const contractReturn = request.query.contractReturn;
    if (contractReturn !== undefined && !["all","pending","returned_on_time","overdue_pending","returned_late","all_overdue"].includes(contractReturn)) validationError("合同回签状态筛选无效");
    const statusFilter = status === "pending" || status === "closed" ? status : "all";
    return dependencies.service.listCases(
      await readActor(request),
      request.query.q ?? "",
      statusFilter,
      page,
      {
        stage: stage as "all"|"ie"|"management"|"owner"|"finance"|"factory_change"|"exception",
        gender: gender as "all"|"男装"|"女装"|"missing",
        styleName: request.query.styleName ?? "",
        ...(contractReturn !== undefined ? { contractReturn: contractReturn as "all"|"pending"|"returned_on_time"|"overdue_pending"|"returned_late"|"all_overdue" } : {}),
      },
    );
  });

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId",
    async (request) => dependencies.service.getCase(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.get<{Params:{sourcingCaseId:string}}>('/sourcing/cases/:sourcingCaseId/detail-sections',async request =>
    dependencies.service.readDetailSections(await readActor(request),caseId(request.params.sourcingCaseId)));

  app.delete<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId",
    async (request, reply) => {
      const sourcingCaseId = caseId(request.params.sourcingCaseId);
      const result = await dependencies.service.deleteByRoot(
        await rootDeleteActor(request),
        sourcingCaseId,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return DeleteSourcingCaseResponseSchema.parse(result.value);
    },
  );

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/attachments",
    async (request) => dependencies.service.listAttachments(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/supplemental-images",
    async (request, reply) => {
      const parsed = SupplementSourcingImagesSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "补充图片信息无效");
      const result = await dependencies.service.supplementImages(
        await supplementalImageActor(request),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    },
  );

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/timeline",
    async (request) => dependencies.service.listTimeline(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.get<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/contract-directory",async(request,reply)=>{
    reply.header("cache-control","no-store");return dependencies.service.contractDirectory(await readActor(request),caseId(request.params.sourcingCaseId));
  });
  app.get<{ Params: { sourcingCaseId: string; node: string }; Querystring: { entryId?: string } }>(
    "/sourcing/cases/:sourcingCaseId/history/:node",
    async (request) => {
      const node = SourcingHistoryNodeSchema.safeParse(request.params.node);
      if (!node.success) return validationError("历史节点无效");
      return dependencies.service.nodeHistory(await readActor(request), caseId(request.params.sourcingCaseId),
        node.data, typeof request.query.entryId === "string" ? request.query.entryId : undefined);
    },
  );

  app.get("/sourcing/merchandisers", async (request) =>
    SourcingMerchandiserOptionsSchema.parse(await dependencies.service.listMerchandisers(
      await actionActor(request, "order_merchandiser", "sourcing:inquiry:create"),
    )));

  app.get<{ Querystring: { q?: string } }>("/sourcing/styles", async (request) =>
    dependencies.service.listStyles(
      await actionActor(request, "order_merchandiser", "sourcing:inquiry:create"),
      typeof request.query.q === "string" ? request.query.q : "",
    ));

  app.post("/sourcing/cases", async (request, reply) => {
    const parsed = CreateSourcingCaseSchema.safeParse(request.body);
    const data = parsed.success
      ? parsed.data
      : validationError(parsed.error.issues[0]?.message ?? "询价信息不完整");
    const result = await dependencies.service.createCase(
      await actionActor(request, "order_merchandiser", "sourcing:inquiry:create"),
      data,
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/budget-price-corrections",
    async (request, reply) => {
      const parsed = CorrectSourcingBudgetPriceSchema.safeParse(request.body);
      const data = parsed.success ? parsed.data : validationError(parsed.error.issues[0]?.message ?? "预算价更正信息不完整");
      const result = await dependencies.service.correctBudgetPrice(
        await rootBudgetCorrectionActor(request),
        caseId(request.params.sourcingCaseId), data, idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(200).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/ie-quotes",
    async (request, reply) => {
      const parsed = CreateSourcingIeQuoteSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "IE报价信息不完整");
      const result = await dependencies.service.quoteIePrice(
        await actionActor(request, "ie_reviewer", "sourcing:price:quote"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/management-decisions",
    async (request, reply) => {
      const parsed = RecordSourcingManagementDecisionSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "供应链总监决定信息不完整");
      const result = await dependencies.service.recordManagementDecision(
        await actionActor(
          request,
          "production_management",
          "sourcing:decision:record",
        ),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/owner-decisions",
    async (request, reply) => {
      const parsed = DecideSourcingOwnerSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "老板审批信息不完整");
      const result = await dependencies.service.decideOwner(
        await actionActor(request, "owner_group", "sourcing:owner:approve"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  if (dependencies.contracts) {
    const templateActor = async (request: FastifyRequest) => {
      const user = await authenticateForRequest(dependencies.authenticate, token(request), request, "handler");
      if (!await isRootUser(dependencies.root,user.id)) throw new ApplicationError("FORBIDDEN","仅Root可设置合同模板",403);
      return businessActor(dependencies.root,user,request.id,"sourcing:contract:record");
    };
    const refreshActor = async (request: FastifyRequest) => {
      const actor = await readActor(request);
      const capabilities = actor.authorizationCapabilities ?? [];
      if (actor.actorRoles.includes("root_superuser")) return {...actor,authorizationCapability:"sourcing:contract:record"};
      if (actor.actorRoles.includes("production_management") && capabilities.includes("sourcing:decision:record")) return {...actor,authorizationCapability:"sourcing:decision:record"};
      if (actor.actorRoles.includes("order_merchandiser") && capabilities.includes("sourcing:contract:record")) return {...actor,authorizationCapability:"sourcing:contract:record"};
      throw new ApplicationError("FORBIDDEN","当前岗位无权更新合同信息",403);
    };
    app.get("/sourcing/contract-template",async request => ContractTemplateStateSchema.parse(
      await dependencies.contracts!.management.templates(await templateActor(request))));
    app.post("/sourcing/contract-template",async request => {
      const actor = await templateActor(request);
      const parsed = SaveContractTemplateSchema.safeParse(request.body);
      if (!parsed.success) validationError(parsed.error.issues[0]?.message ?? "模板资料不完整");
      return ContractTemplateStateSchema.parse(await dependencies.contracts!.management.saveTemplate(actor,parsed.data!,idempotencyKey(request)));
    });
    app.post("/sourcing/contract-template/preview",async (request,reply) => {
      const actor = await templateActor(request);
      const parsed = ContractTemplateContentSchema.safeParse(request.body);
      if (!parsed.success) validationError(parsed.error.issues[0]?.message ?? "模板资料不完整");
      return reply.type("application/pdf").header("Content-Disposition","inline; filename=contract-template-preview.pdf")
        .send(await dependencies.contracts!.management.previewTemplate(actor,parsed.data!));
    });
    const contentActor = async (request:FastifyRequest) => {
      const user = await authenticateForRequest(dependencies.authenticate, token(request), request, "handler");
      if (!await isRootUser(dependencies.root,user.id)) throw new ApplicationError("FORBIDDEN","仅Root可修改合同内容",403);
      return businessActor(dependencies.root,user,request.id,"sourcing:contract:record");
    };
    app.post<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/contract-return/retry-todos",async request=>{
      const actor=await contentActor(request);
      const parsed=z.object({documentId:z.string().uuid()}).strict().safeParse(request.body);
      if(!parsed.success) validationError("请指定当前合同文档");
      return dependencies.contracts!.retryReturnTodos(actor,caseId(request.params.sourcingCaseId),parsed.data!.documentId,idempotencyKey(request));
    });
    app.get<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/contract/content",async request =>
      ContractContentStateSchema.parse(await dependencies.contracts!.content.get(await contentActor(request),caseId(request.params.sourcingCaseId))));
    app.post<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/contract/content",{bodyLimit:4*1024*1024},async request => {
      const actor=await contentActor(request);
      const parsed=SaveContractContentSchema.safeParse(request.body);
      if (!parsed.success) validationError(parsed.error.issues[0]?.message ?? "合同内容不完整");
      const id=caseId(request.params.sourcingCaseId);
      const documentId=await dependencies.contracts!.content.save(actor,id,parsed.data!,idempotencyKey(request));
      return SourcingContractStateResponseSchema.parse(await dependencies.contracts!.generateIfReady(actor,id,documentId));
    });
    app.post<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/contract/content/preview",{bodyLimit:4*1024*1024},async (request,reply) => {
      const actor=await contentActor(request);
      const parsed=SaveContractContentSchema.safeParse(request.body);
      if (!parsed.success) validationError(parsed.error.issues[0]?.message ?? "合同内容不完整");
      return reply.type("application/pdf").header("Content-Disposition","inline; filename=contract-content-preview.pdf")
        .send(await dependencies.contracts!.content.preview(actor,caseId(request.params.sourcingCaseId),parsed.data!));
    });
    app.get<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/contract/refresh",async request =>
      ContractRefreshPreviewSchema.parse(await dependencies.contracts!.management.previewInformation(
        await refreshActor(request),caseId(request.params.sourcingCaseId))));
    app.post<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/contract/refresh",async request => {
      const actor = await refreshActor(request);
      const parsed = RefreshContractInformationSchema.safeParse(request.body);
      if (!parsed.success) validationError(parsed.error.issues[0]?.message ?? "请先查看供应商资料差异");
      const id = caseId(request.params.sourcingCaseId);
      const key=idempotencyKey(request),documentId = await dependencies.contracts!.management.refreshInformation(actor,id,parsed.data!,key);
      const state=await dependencies.contracts!.generateIfReady(actor,id,documentId);
      const refreshReceipt=await dependencies.contracts!.management.informationRefreshReceipt(actor,id,parsed.data!,key,documentId);
      if(state.item?.sourcingContractDocumentId!==documentId)throw new ApplicationError('INVALID_RESPONSE','原合同更新文档尚未核实，请保留原提交核对。',502);
      return ContractInformationRefreshResponseSchema.parse({...state,refreshReceipt});
    });
    app.get<{ Params: { sourcingCaseId: string } }>(
      "/sourcing/cases/:sourcingCaseId/contract",
      async (request) => SourcingContractStateResponseSchema.parse(
        await dependencies.contracts!.getCurrent(
          await readActor(request),
          caseId(request.params.sourcingCaseId),
        ),
      ),
    );

    app.post<{ Params: { sourcingCaseId: string } }>(
      "/sourcing/cases/:sourcingCaseId/contract/supplements",
      async (request) => {
        const parsed = SupplementSourcingContractSchema.safeParse(request.body);
        const data = parsed.success
          ? parsed.data
          : validationError(parsed.error.issues[0]?.message ?? "合同补充资料不完整");
        return SourcingContractStateResponseSchema.parse(
          await dependencies.contracts!.supplement(
            await actionActor(request, "order_merchandiser", "sourcing:contract:record"),
            caseId(request.params.sourcingCaseId),
            data,
            idempotencyKey(request),
          ),
        );
      },
    );

    app.post<{ Params: { sourcingCaseId: string } }>(
      "/sourcing/cases/:sourcingCaseId/contract/generate",
      async (request) => SourcingContractStateResponseSchema.parse(
        await dependencies.contracts!.generateIfReady(
          await actionActor(request, "order_merchandiser", "sourcing:contract:record"),
          caseId(request.params.sourcingCaseId),
        ),
      ),
    );
  }

  if (dependencies.contractReturns) {
    app.get<{ Params: { sourcingCaseId: string } }>(
      "/sourcing/cases/:sourcingCaseId/contract-return",
      async (request) => SourcingContractReturnResponseSchema.parse(
        await dependencies.contractReturns!.get(await readActor(request),caseId(request.params.sourcingCaseId)),
      ),
    );
    app.post<{ Params: { sourcingCaseId: string } }>(
      "/sourcing/cases/:sourcingCaseId/contract-return",
      async (request) => {
        const parsed=SourcingContractReturnUploadSchema.safeParse(request.body);
        const input=parsed.success?parsed.data:validationError(parsed.error.issues[0]?.message??"回签附件信息不完整");
        const actor=await readActor(request);
        const capabilities=actor.authorizationCapabilities??[];
        const capability=actor.actorRoles.includes("root_superuser") ? "sourcing:contract:record"
          : actor.actorRoles.includes("owner_group") && capabilities.includes("sourcing:owner:approve") ? "sourcing:owner:approve"
          : actor.actorRoles.includes("production_management") && capabilities.includes("sourcing:decision:record") ? "sourcing:decision:record"
          : actor.actorRoles.includes("order_merchandiser") && capabilities.includes("sourcing:contract:record") ? "sourcing:contract:record"
          : (() => { throw new ApplicationError("FORBIDDEN","当前账号无权回传合同",403); })();
        return SourcingContractReturnResponseSchema.parse(
          await dependencies.contractReturns!.submit({...actor,authorizationCapability:capability},
            caseId(request.params.sourcingCaseId),input.attachmentIds,idempotencyKey(request),input.expectedContractDocumentId),
        );
      },
    );
  }

  app.get<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/price-reapplications/current",async request=>
    SourcingPriceReapplicationStateSchema.parse(await dependencies.service.getCurrentPriceReapplication(await readActor(request),caseId(request.params.sourcingCaseId))));
  app.post<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/price-reapplications",async(request,reply)=>{
    const actor=await actionActor(request,"production_management","sourcing:decision:record");
    const parsed=RequestSourcingPriceReapplicationSchema.safeParse(request.body);
    if(!parsed.success) validationError(parsed.error.issues[0]?.message??"价格申请资料无效");
    const result=await dependencies.service.requestPriceReapplication(actor,caseId(request.params.sourcingCaseId),parsed.data!,idempotencyKey(request));
    if(result.reused) reply.header("idempotency-replayed","true");return reply.code(201).send(result.value);
  });
  app.post<{Params:{sourcingCaseId:string;priceRequestId:string}}>("/sourcing/cases/:sourcingCaseId/price-reapplications/:priceRequestId/decision",async(request,reply)=>{
    const parsed=DecideSourcingPriceReapplicationSchema.safeParse(request.body);
    if(!parsed.success) validationError(parsed.error.issues[0]?.message??"价格审批资料无效");
    const cancelled=parsed.data!.decision==="cancelled";
    const actor=await actionActor(request,cancelled?"production_management":"owner_group",cancelled?"sourcing:decision:record":"sourcing:owner:approve");
    const result=await dependencies.service.decidePriceReapplication(actor,caseId(request.params.sourcingCaseId),caseId(request.params.priceRequestId),parsed.data!,idempotencyKey(request));
    if(result.reused) reply.header("idempotency-replayed","true");return reply.code(201).send(result.value);
  });

  app.get<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/current",
    async (request) => dependencies.service.getCurrentFactoryChange(
      await readActor(request),
      caseId(request.params.sourcingCaseId),
    ),
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes",
    async (request, reply) => {
      const parsed = RequestSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "换厂信息不完整");
      const result = await dependencies.service.requestFactoryChange(
        await actionActor(request, "order_merchandiser", "sourcing:factory_change:request"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/management",
    async (request, reply) => {
      const parsed = RequestSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "转厂信息不完整");
      const result = await dependencies.service.requestFactoryChange(
        await actionActor(request, "production_management", "sourcing:decision:record"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/owner",
    async (request, reply) => {
      const parsed = RequestSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "转厂信息不完整");
      const result = await dependencies.service.requestFactoryChange(
        await actionActor(request, "owner_group", "sourcing:owner:approve"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string; factoryChangeRequestId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/:factoryChangeRequestId/decision",
    async (request, reply) => {
      const parsed = DecideSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "换厂核实信息不完整");
      const result = await dependencies.service.decideFactoryChange(
        await actionActor(request, "production_management", "sourcing:factory_change:verify"),
        caseId(request.params.sourcingCaseId),
        caseId(request.params.factoryChangeRequestId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string; factoryChangeRequestId: string } }>(
    "/sourcing/cases/:sourcingCaseId/factory-changes/:factoryChangeRequestId/owner-decision",
    async (request, reply) => {
      const parsed = DecideSourcingFactoryChangeSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "老板转厂审批信息不完整");
      const result = await dependencies.service.decideFactoryChange(
        await actionActor(request, "owner_group", "sourcing:owner:approve"),
        caseId(request.params.sourcingCaseId),
        caseId(request.params.factoryChangeRequestId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.get<{Params:{sourcingCaseId:string}}>("/sourcing/cases/:sourcingCaseId/factory-settlements",async request=>dependencies.service.readFactorySettlements(await actionActor(request,"factory_payables","sourcing:finance:reconcile"),caseId(request.params.sourcingCaseId)));

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/finance-reconciliations",
    async (request, reply) => {
      const parsed = RecordSourcingFinanceReconciliationSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "财务核对信息不完整");
      const result = await dependencies.service.recordFinanceReconciliation(
        await actionActor(request, "factory_payables", "sourcing:finance:reconcile"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { sourcingCaseId: string } }>(
    "/sourcing/cases/:sourcingCaseId/exception-decisions",
    async (request, reply) => {
      const parsed = DecideSourcingExceptionSchema.safeParse(request.body);
      const data = parsed.success
        ? parsed.data
        : validationError(parsed.error.issues[0]?.message ?? "差异处理信息不完整");
      const result = await dependencies.service.decideException(
        await actionActor(request, "production_management", "sourcing:exception:verify"),
        caseId(request.params.sourcingCaseId),
        data,
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

}
