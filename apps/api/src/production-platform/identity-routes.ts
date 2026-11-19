import {WholeOrderSelectionSchema,WholeOrderDeletionInputSchema} from '@dx-rework/contracts/whole-order-deletion';
import {registerDeliveryCalendarRoutes} from './delivery-calendar-routes.js';
import {registerOrderTimeRequestRoutes} from './order-time-request-routes.js';
import type {OrderTimeRequestService} from './order-time-request-service.js';
import type {DeliveryCalendarQuery} from './delivery-calendar-query.js';
import {journeyMeasure} from '../platform/journey-diagnostic.js';
import {registerQcProductionProgressRoutes} from './qc-production-progress-routes.js';
import type {QcProductionProgressService} from './qc-production-progress-service.js';
import {registerProductionReadinessRoutes} from './production-readiness-routes.js';
import type {ProductionReadinessService} from './production-readiness-service.js';
import type { DigitalJourneyQuery } from "./journey-query.js";
import { DevelopmentWorkspaceQuery } from "./development-workspace-query.js";
import { DevelopmentWorkspaceFilterSchema, PatternWorkspaceFilterSchema } from "@dx-rework/contracts/digital-development-workspace";
import { JourneyFilterSchema,JourneyLogFilterSchema,NodeMaterialsQuerySchema } from "@dx-rework/contracts/digital-production-journey";
import { registerDigitalAnalysisRoutes } from "./reporting-routes.js";
import type { DigitalAnalysisQuery } from "./reporting-query.js";
import type { DigitalCockpitQuery } from "./cockpit-query.js";
import { z as cockpitZ } from "zod";
import {registerOrderClosureRoutes} from "./order-closure-routes.js";
import type {OrderClosureService} from "./order-closure-service.js";
import type {BulkWashingService} from './bulk-washing-service.js';
import {registerBulkWashingRoutes} from './bulk-washing-routes.js';
import {registerFactoryFlowRoutes} from "./factory-flow-routes.js";
import type {FactoryFlowService} from "./factory-flow-service.js";
import { registerBulkPreparationRoutes } from "./bulk-preparation-routes.js";
import type { BulkPreparationService } from "./bulk-preparation-service.js";
import { registerInstructionRoutes } from "./production-instruction-routes.js";
import type { ProductionInstructionService } from "./production-instruction-service.js";
import { registerBudgetRoutes } from "./budget-routes.js";
import type { DigitalBudgetService } from "./budget-service.js";
import {registerQuotationRoutes} from './quotation-routes.js';
import type {DigitalQuotationService} from './quotation-service.js';
import {registerSeriesPlanRoutes} from './series-plan-routes.js';
import type {SeriesPlanService} from './series-plan-service.js';
import type {ShortLeadService} from './short-lead-service.js';
import {registerDevelopmentRoundRoutes} from "./development-round-routes.js";
import type {DevelopmentRoundService} from "./development-round-service.js";
import { registerDevelopmentExecutionRoutes } from "./development-execution-routes.js";
import type { DevelopmentExecutionService } from "./development-execution-service.js";
import { registerDevelopmentRoutes } from "./development-routes.js";
import type { DigitalDevelopmentService } from "./development-service.js";
import type { AttachmentService } from "../tools/attachments.js";
import { registerDigitalNotificationRoutes } from "./notification-routes.js";
import type { DigitalProductionNotificationService } from "./notification-service.js";
import { registerDigitalTaskRoutes } from "./task-routes.js";
import type { DigitalProductionTaskService } from "./task-service.js";
import { registerDigitalAccessRoutes } from "./access-routes.js";
import type { DigitalProductionAccessService } from "./access-service.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { DigitalSourceCreateSchema, DigitalOrderCreateSchema, DigitalNumberCorrectionSchema, DigitalIdSchema, DigitalPageSchema, DigitalDesignCodeCheckSchema } from "@dx-rework/contracts/digital-production";
import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import { assertIdentityActor, type DigitalProductionIdentityService } from "./identity-service.js";

export type DigitalIdentityDependencies = {
  bulkWashing?:BulkWashingService;
  orderTimeRequests?:OrderTimeRequestService;
  deliveryCalendar?:DeliveryCalendarQuery;
  readinessService?:ProductionReadinessService;
  analysis?: DigitalAnalysisQuery;
  cockpit?: DigitalCockpitQuery;
  journeys?: DigitalJourneyQuery;
  budgetService?: DigitalBudgetService;
  quotationService?:DigitalQuotationService;
  seriesPlans?:SeriesPlanService; shortLead?:ShortLeadService;
  instructionService?: ProductionInstructionService;
  bulkPreparationService?: BulkPreparationService;
  closureService?:OrderClosureService;
  factoryFlowService?:FactoryFlowService; qcProgress?:QcProductionProgressService;
  authenticate(token: string | undefined): Promise<AuthUser>; root?: RootAuthority;
  developmentQrBase?: string;
  developmentRounds?:DevelopmentRoundService;
  developmentExecution?: DevelopmentExecutionService;
  developmentService?: DigitalDevelopmentService; developmentAttachments?: AttachmentService;
  notificationService?: DigitalProductionNotificationService;
  taskService?: DigitalProductionTaskService; accessService?: DigitalProductionAccessService; service: DigitalProductionIdentityService; creationEnabled: boolean;
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    const businessMessage = result.error.issues.find((issue) => issue.code === "custom")?.message;
    throw new ApplicationError("VALIDATION_ERROR", businessMessage ?? "请检查客户、款色、尺码数量和日期", 400);
  }
  return result.data;
};
export function registerDigitalIdentityRoutes(app: FastifyInstance, dependencies: DigitalIdentityDependencies): void {
  if(dependencies.bulkWashing)registerBulkWashingRoutes(app,dependencies,dependencies.bulkWashing);
  if(dependencies.orderTimeRequests)registerOrderTimeRequestRoutes(app,dependencies,dependencies.orderTimeRequests);
  if(dependencies.qcProgress&&dependencies.developmentAttachments)registerQcProductionProgressRoutes(app,dependencies,dependencies.qcProgress,dependencies.developmentAttachments);
  if(dependencies.readinessService&&dependencies.developmentAttachments)registerProductionReadinessRoutes(app,dependencies,dependencies.readinessService,dependencies.developmentAttachments);
  if(dependencies.seriesPlans&&dependencies.shortLead)registerSeriesPlanRoutes(app,dependencies,dependencies.seriesPlans,dependencies.shortLead);
  if(dependencies.quotationService)registerQuotationRoutes(app,dependencies,dependencies.quotationService);
  if(dependencies.deliveryCalendar)registerDeliveryCalendarRoutes(app,dependencies,dependencies.deliveryCalendar);
  if(dependencies.analysis) registerDigitalAnalysisRoutes(app,dependencies,dependencies.analysis);
  if(dependencies.closureService)registerOrderClosureRoutes(app,dependencies,dependencies.closureService);
  if(dependencies.factoryFlowService&&dependencies.developmentAttachments)registerFactoryFlowRoutes(app,dependencies,dependencies.factoryFlowService,dependencies.developmentAttachments);
  if(dependencies.bulkPreparationService)registerBulkPreparationRoutes(app,dependencies,dependencies.bulkPreparationService);
  if (dependencies.instructionService && dependencies.developmentAttachments) registerInstructionRoutes(app,dependencies,dependencies.instructionService,dependencies.developmentAttachments);
  if (dependencies.budgetService && dependencies.developmentAttachments) registerBudgetRoutes(app, dependencies, dependencies.budgetService, dependencies.developmentAttachments);
  if(dependencies.developmentRounds)registerDevelopmentRoundRoutes(app,dependencies,dependencies.developmentRounds);
  if (dependencies.developmentExecution && dependencies.developmentAttachments) registerDevelopmentExecutionRoutes(app, dependencies, dependencies.developmentExecution, dependencies.developmentAttachments);
  if (dependencies.developmentService && dependencies.developmentAttachments) registerDevelopmentRoutes(app, dependencies, dependencies.developmentService, dependencies.developmentAttachments);
  if (dependencies.notificationService) registerDigitalNotificationRoutes(app, dependencies, dependencies.notificationService);
  if (dependencies.taskService) registerDigitalTaskRoutes(app, dependencies, dependencies.taskService);
  if (dependencies.accessService) registerDigitalAccessRoutes(app, dependencies, dependencies.accessService);
  const actor = async (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice(18);
    const trusted = await businessActor(dependencies.root, await dependencies.authenticate(token), request.id, "pattern_room:orders:create");
    assertIdentityActor(trusted);
    return trusted;
  };
  const key = (request: FastifyRequest) => typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
  const id = (request: FastifyRequest, name: string) => parse(DigitalIdSchema, (request.params as Record<string, unknown>)[name]);
  app.addHook("onSend", async (request, reply) => {
    if (request.routeOptions.url?.startsWith("/digital-production/")) reply.header("cache-control", "no-store");
  });
  app.post('/digital-production/whole-orders/delete-preview',async request=>dependencies.service.deletions().preview(await actor(request),parse(WholeOrderSelectionSchema,request.body)));
  app.post('/digital-production/whole-orders/delete',async request=>dependencies.service.deletions().remove(await actor(request),parse(WholeOrderDeletionInputSchema,request.body),key(request)));
  if (dependencies.journeys) {
    const workspaces = new DevelopmentWorkspaceQuery(dependencies.journeys);
    app.get("/digital-production/workspaces/designer", async request => workspaces.designer(await actor(request), parse(DevelopmentWorkspaceFilterSchema, request.query)));
    app.get("/digital-production/workspaces/pattern", async request => workspaces.pattern(await actor(request), parse(PatternWorkspaceFilterSchema, request.query)));
    app.get("/digital-production/journeys", async request => dependencies.journeys!.list(await journeyMeasure('route_auth',()=>actor(request)), parse(JourneyFilterSchema, request.query)));
    app.post('/digital-production/journeys/:id/refresh',async request=>dependencies.journeys!.refreshOne(await actor(request),id(request,'id')));
    app.get("/digital-production/journeys/export", async request => dependencies.journeys!.export(await actor(request), parse(JourneyFilterSchema, request.query)));
    app.get("/digital-production/journeys/:id/node-materials", async request => {
      const query=parse(NodeMaterialsQuerySchema,request.query);
      return dependencies.journeys!.nodeMaterials(await actor(request),id(request,"id"),query.instanceId,query.round);
    });
    app.get("/digital-production/journeys/:id/logs", async request => {
      const query=parse(JourneyLogFilterSchema,request.query);
      return dependencies.journeys!.logs(await actor(request),id(request,"id"),query.cursor);
    });
    app.get("/digital-production/journeys/:id", async request => {
      const query = parse(cockpitZ.object({ round: cockpitZ.coerce.number().int().positive().max(10000).optional(),view:cockpitZ.literal("cockpit").optional() }).strict(), request.query);
      return dependencies.journeys!.read(await actor(request), id(request, "id"), query.round,query.view==="cockpit");
    });
  }
  if (dependencies.cockpit) app.get("/digital-production/cockpit", async request => dependencies.cockpit!.list(await actor(request), parse(cockpitZ.object({ page: cockpitZ.coerce.number().int().min(1).max(100000).default(1), search: cockpitZ.string().trim().max(100).default(""), stage: cockpitZ.enum(["development", "bulk"]).default("development"), workload: cockpitZ.enum(["all","unassigned","blocked","urgent"]).default("all") }).strict(), request.query)));
  app.get("/digital-production/options", async request => {
    const trusted = await actor(request);
    const query=parse(cockpitZ.object({sourceId:DigitalIdSchema.optional()}).strict(),request.query);
    const calendar=await dependencies.service.orderCalendar(trusted,query.sourceId);
    return { creationEnabled: dependencies.creationEnabled,...calendar,customers: await dependencies.service.customers(trusted) };
  });
  app.get("/digital-production/sources", async request => {
    const trusted = await actor(request); const query = parse(DigitalPageSchema, request.query);
    return dependencies.service.sources(trusted, query.page, query.search);
  });
  app.get("/digital-production/design-codes/check",async request=>dependencies.service.checkDesignCode(await actor(request),parse(DigitalDesignCodeCheckSchema,request.query).code));
  app.get("/digital-production/sources/drafts",async request=>{
    const trusted=await actor(request),query=parse(DigitalPageSchema,request.query);
    return dependencies.service.developmentDrafts(trusted,query.page,query.search);
  });
  app.get("/digital-production/sources/drafts/receipt",async request=>dependencies.service.developmentDraftReceipt(await actor(request),key(request)));
  app.post("/digital-production/sources/drafts",async request=>dependencies.service.createSource(await actor(request),parse(DigitalSourceCreateSchema,request.body),key(request),true));
  app.post("/digital-production/sources", async request => dependencies.service.createSource(await actor(request), parse(DigitalSourceCreateSchema, request.body), key(request)));
  app.post("/digital-production/sources/:sourceId/confirm", async request => dependencies.service.createOrder(await actor(request), parse(DigitalOrderCreateSchema, request.body), key(request), id(request, "sourceId")));
  app.get("/digital-production/orders", async request => {
    const trusted = await actor(request); const query = parse(DigitalPageSchema, request.query);
    return dependencies.service.orders(trusted, query.page, query.search);
  });
  app.post("/digital-production/orders", async request => dependencies.service.createOrder(await actor(request), parse(DigitalOrderCreateSchema, request.body), key(request)));
  app.get("/digital-production/orders/:orderId", async request => dependencies.service.read(await actor(request), id(request, "orderId")));
  app.get("/digital-production/orders/:orderId/sla-plan", async request => dependencies.service.slaPlan(await actor(request), id(request, "orderId")));
  app.post("/digital-production/orders/:orderId/source/:sourceId", async request => dependencies.service.attachSource(await actor(request), id(request, "orderId"), id(request, "sourceId"), key(request)));
  app.patch("/digital-production/orders/:orderId/lines/:lineId/numbers", async request => dependencies.service.correctNumbers(await actor(request), id(request, "orderId"), id(request, "lineId"), parse(DigitalNumberCorrectionSchema, request.body), key(request)));
}
