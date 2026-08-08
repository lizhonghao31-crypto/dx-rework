import {
  CreateWorkReportSchema,
  CreateWorkTaskSchema,
  IdempotencyKeySchema,
  ReworkWorkTasksParamsSchema,
  ReworkWorkTasksResponseSchema,
  WorkTaskAssignablePeopleResponseSchema,
  WorkReportResponseSchema,
  WorkTaskParamsSchema,
  WorkTaskResponseSchema,
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
import type { WorkReportingService } from "./work-reporting-service.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
const parse = <T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T => { const result = schema.safeParse(input); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400); return result.data; };
const key = (request: FastifyRequest): string => parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

export type WorkReportingHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: WorkReportingService;
  root?: RootAuthority;
}>;

export function registerWorkReportingRoutes(app: FastifyInstance, dependencies: WorkReportingHttpDependencies): void {
  const actor = async (request: FastifyRequest, mode: "read" | "assign" | "report"): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    const isRoot = await isRootUser(dependencies.root, user.id);
    const ownerReader = user.businessRoles?.includes("owner_group") === true
      && user.capabilities.includes(BUSINESS_READ_ALL_CAPABILITY);
    const supervisor = user.businessRoles?.includes("tail_supervisor") === true
      && user.capabilities.includes("work:assign");
    const worker = user.businessRoles?.includes("worker") === true
      && user.capabilities.includes("work:report");
    const proxy = user.capabilities.includes("work:report_for_worker");

    if (mode === "assign") {
      if (!isRoot && !supervisor) throw new ApplicationError("FORBIDDEN", "当前角色无权分配返工任务", 403);
      return businessActor(dependencies.root, user, request.id, "work:assign", isRoot ? "tail_supervisor" : undefined);
    }
    if (mode === "report") {
      if (!isRoot && !worker && !proxy) throw new ApplicationError("FORBIDDEN", "当前角色无权提交返工上数", 403);
      if (isRoot) return businessActor(dependencies.root, user, request.id, "work:report_for_worker", "tail_supervisor");
      return businessActor(dependencies.root, user, request.id, worker ? "work:report" : "work:report_for_worker");
    }
    if (isRoot) {
      const rootActor = await businessActor(
        dependencies.root,
        user,
        request.id,
        "work:assign",
        "tail_supervisor",
      );
      return {
        ...rootActor,
        authorizationCapabilities: [
          ...new Set([
            ...(rootActor.authorizationCapabilities ?? []),
            "work:assign",
            "work:report_for_worker",
          ]),
        ],
      };
    }
    if (ownerReader) {
      return businessActor(
        dependencies.root,
        user,
        request.id,
        "work:assign",
        "tail_supervisor",
        true,
      );
    }
    if (supervisor) return businessActor(dependencies.root, user, request.id, "work:assign");
    if (worker) return businessActor(dependencies.root, user, request.id, "work:report");
    if (proxy) return businessActor(dependencies.root, user, request.id, "work:report_for_worker");
    throw new ApplicationError("FORBIDDEN", "当前角色无权查看工人任务或上数", 403);
  };

  app.get<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/work-tasks", async (request) => ReworkWorkTasksResponseSchema.parse(await dependencies.service.list(await actor(request, "read"), parse(ReworkWorkTasksParamsSchema, request.params).reworkOrderId)));
  app.get("/work-task-options", async (request) => WorkTaskAssignablePeopleResponseSchema.parse({ people: await dependencies.service.listAssignablePeople(await actor(request, "assign")) }));
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/work-tasks", async (request, reply) => { const result = await dependencies.service.createTask(await actor(request, "assign"), parse(ReworkWorkTasksParamsSchema, request.params).reworkOrderId, parse(CreateWorkTaskSchema, request.body), key(request)); if (result.reused) void reply.header("idempotency-replayed", "true"); return reply.code(201).send(WorkTaskResponseSchema.parse(result.value)); });
  app.post<{ Params: { workTaskId: string } }>("/work-tasks/:workTaskId/reports", async (request, reply) => { const result = await dependencies.service.submitReport(await actor(request, "report"), parse(WorkTaskParamsSchema, request.params).workTaskId, parse(CreateWorkReportSchema, request.body), key(request)); if (result.reused) void reply.header("idempotency-replayed", "true"); return reply.code(201).send(WorkReportResponseSchema.parse(result.value)); });
}
