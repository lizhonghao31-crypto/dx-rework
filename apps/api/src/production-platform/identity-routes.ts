import { registerBulkPreparationRoutes } from "./bulk-preparation-routes.js";
import type { BulkPreparationService } from "./bulk-preparation-service.js";
import { registerInstructionRoutes } from "./production-instruction-routes.js";
import type { ProductionInstructionService } from "./production-instruction-service.js";
import { registerBudgetRoutes } from "./budget-routes.js";
import type { DigitalBudgetService } from "./budget-service.js";
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
import { DigitalSourceCreateSchema, DigitalOrderCreateSchema, DigitalNumberCorrectionSchema, DigitalIdSchema, DigitalPageSchema } from "@dx-rework/contracts/digital-production";
import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import { assertIdentityActor, type DigitalProductionIdentityService } from "./identity-service.js";

export type DigitalIdentityDependencies = {
  budgetService?: DigitalBudgetService;
  instructionService?: ProductionInstructionService;
  bulkPreparationService?: BulkPreparationService;
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
  app.get("/digital-production/options", async request => {
    const trusted = await actor(request);
    return { creationEnabled: dependencies.creationEnabled, customers: await dependencies.service.customers(trusted) };
  });
  app.get("/digital-production/sources", async request => {
    const trusted = await actor(request); const query = parse(DigitalPageSchema, request.query);
    return dependencies.service.sources(trusted, query.page, query.search);
  });
  app.post("/digital-production/sources", async request => dependencies.service.createSource(await actor(request), parse(DigitalSourceCreateSchema, request.body), key(request)));
  app.post("/digital-production/sources/:sourceId/confirm", async request => dependencies.service.createOrder(await actor(request), parse(DigitalOrderCreateSchema, request.body), key(request), id(request, "sourceId")));
  app.get("/digital-production/orders", async request => {
    const trusted = await actor(request); const query = parse(DigitalPageSchema, request.query);
    return dependencies.service.orders(trusted, query.page, query.search);
  });
  app.post("/digital-production/orders", async request => dependencies.service.createOrder(await actor(request), parse(DigitalOrderCreateSchema, request.body), key(request)));
  app.get("/digital-production/orders/:orderId", async request => dependencies.service.read(await actor(request), id(request, "orderId")));
  app.post("/digital-production/orders/:orderId/source/:sourceId", async request => dependencies.service.attachSource(await actor(request), id(request, "orderId"), id(request, "sourceId"), key(request)));
  app.patch("/digital-production/orders/:orderId/lines/:lineId/numbers", async request => dependencies.service.correctNumbers(await actor(request), id(request, "orderId"), id(request, "lineId"), parse(DigitalNumberCorrectionSchema, request.body), key(request)));
}
