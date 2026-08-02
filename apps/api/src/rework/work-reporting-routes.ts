import {
  CreateWorkReportSchema,
  CreateWorkTaskSchema,
  IdempotencyKeySchema,
  ReworkWorkTasksParamsSchema,
  ReworkWorkTasksResponseSchema,
  WorkReportResponseSchema,
  WorkTaskParamsSchema,
  WorkTaskResponseSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { WorkReportingService } from "./work-reporting-service.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
const parse = <T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T => { const result = schema.safeParse(input); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400); return result.data; };
const key = (request: FastifyRequest): string => parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

export type WorkReportingHttpDependencies = Readonly<{ authenticate(value: string | undefined): Promise<AuthUser>; service: WorkReportingService }>;

export function registerWorkReportingRoutes(app: FastifyInstance, dependencies: WorkReportingHttpDependencies): void {
  const actor = async (request: FastifyRequest, mode: "read" | "assign" | "report"): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    const supervisor = user.businessRoles?.includes("tail_supervisor") && user.capabilities.includes("work:assign");
    const worker = user.businessRoles?.includes("worker") && user.capabilities.includes("work:report");
    const proxy = user.businessRoles?.includes("tail_supervisor") && user.capabilities.includes("work:report_for_worker");
    if (!user.businessRoles?.length || (mode === "assign" && !supervisor) || (mode === "report" && !worker && !proxy) || (mode === "read" && !supervisor && !worker && !proxy)) throw new ApplicationError("FORBIDDEN", "当前角色无权处理工人任务或上数", 403);
    return { actorId: user.id, actorRoles: user.businessRoles, authorizationCapability: mode === "assign" ? "work:assign" : mode === "report" ? proxy ? "work:report_for_worker" : "work:report" : supervisor ? "work:assign" : worker ? "work:report" : "work:report_for_worker", requestId: request.id };
  };
  app.get<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/work-tasks", async (request) => ReworkWorkTasksResponseSchema.parse(await dependencies.service.list(await actor(request, "read"), parse(ReworkWorkTasksParamsSchema, request.params).reworkOrderId)));
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/work-tasks", async (request, reply) => { const result = await dependencies.service.createTask(await actor(request, "assign"), parse(ReworkWorkTasksParamsSchema, request.params).reworkOrderId, parse(CreateWorkTaskSchema, request.body), key(request)); if (result.reused) void reply.header("idempotency-replayed", "true"); return reply.code(201).send(WorkTaskResponseSchema.parse(result.value)); });
  app.post<{ Params: { workTaskId: string } }>("/work-tasks/:workTaskId/reports", async (request, reply) => { const result = await dependencies.service.submitReport(await actor(request, "report"), parse(WorkTaskParamsSchema, request.params).workTaskId, parse(CreateWorkReportSchema, request.body), key(request)); if (result.reused) void reply.header("idempotency-replayed", "true"); return reply.code(201).send(WorkReportResponseSchema.parse(result.value)); });
}
