import {
  CreateWorkReportSchema,
  CreateWorkReportsBatchSchema,
  CreateWorkTaskSchema,
  ConfirmWorkAssignmentsSchema,
  FrontlineTasksQuerySchema,
  FrontlineTasksResponseSchema,
  IdempotencyKeySchema,
  ReworkWorkTasksParamsSchema,
  ReworkWorkTasksResponseSchema,
  WorkTaskAssignablePeopleResponseSchema,
  WorkReportResponseSchema,
  WorkReportsBatchResponseSchema,
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
import { type WorkReportingService } from "./work-reporting-service.js";

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
    const tailInspector = (
      user.businessRoles?.includes("worker") === true
      || user.businessRoles?.includes("tail_inspector") === true
    ) && user.capabilities.includes("tail_inspection:report");
    const proxy = user.capabilities.includes("work:report_for_worker");

    if (mode === "assign") {
      if (!isRoot && !supervisor) throw new ApplicationError("FORBIDDEN", "当前角色无权分配返工任务", 403);
      return businessActor(dependencies.root, user, request.id, "work:assign", isRoot ? "tail_supervisor" : undefined);
    }
    if (mode === "report") {
      if (!isRoot && !worker && !proxy && !tailInspector) throw new ApplicationError("FORBIDDEN", "当前角色无权提交返工执行报数", 403);
      if (isRoot) {
        const rootActor = await businessActor(dependencies.root, user, request.id, "work:report_for_worker", "tail_supervisor");
        return { ...rootActor, authorizationCapabilities: [...new Set([...(rootActor.authorizationCapabilities ?? []), "work:report_for_worker", "tail_inspection:report"]) ] };
      }
      const primaryCapability = tailInspector && !worker && !proxy
        ? "tail_inspection:report"
        : worker ? "work:report" : "work:report_for_worker";
      const reportActor = await businessActor(dependencies.root, user, request.id, primaryCapability);
      return {
        ...reportActor,
        authorizationCapabilities: [
          ...new Set([
            ...(reportActor.authorizationCapabilities ?? [reportActor.authorizationCapability]),
            ...(worker ? ["work:report"] : []),
            ...(proxy ? ["work:report_for_worker"] : []),
            ...(tailInspector ? ["tail_inspection:report"] : []),
          ]),
        ],
      };
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
            "tail_inspection:report",
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
    if (tailInspector) return businessActor(dependencies.root, user, request.id, "tail_inspection:report");
    if (proxy) return businessActor(dependencies.root, user, request.id, "work:report_for_worker");
    throw new ApplicationError("FORBIDDEN", "当前角色无权查看返工执行任务或报数", 403);
  };

  app.get("/frontline/work-tasks", async (request) => {
    const query = parse(FrontlineTasksQuerySchema, request.query);
    return FrontlineTasksResponseSchema.parse(
      await dependencies.service.listFrontlineTasks(await actor(request, "read"), query.kind),
    );
  });

  app.get<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/work-tasks", async (request) => ReworkWorkTasksResponseSchema.parse(await dependencies.service.list(await actor(request, "read"), parse(ReworkWorkTasksParamsSchema, request.params).reworkOrderId)));
  app.get("/work-task-options", async (request) => {
    const assignActor = await actor(request, "assign");
    const people = await dependencies.service.listAssignablePeople(assignActor);
    return WorkTaskAssignablePeopleResponseSchema.parse({ people });
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/work-tasks", async (request, reply) => { const result = await dependencies.service.createTask(await actor(request, "assign"), parse(ReworkWorkTasksParamsSchema, request.params).reworkOrderId, parse(CreateWorkTaskSchema, request.body), key(request)); if (result.reused) void reply.header("idempotency-replayed", "true"); return reply.code(201).send(WorkTaskResponseSchema.parse(result.value)); });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/work-tasks/confirm", async (request, reply) => {
    const result = await dependencies.service.confirmAssignments(
      await actor(request, "assign"),
      parse(ReworkWorkTasksParamsSchema, request.params).reworkOrderId,
      parse(ConfirmWorkAssignmentsSchema, request.body),
      key(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(ReworkWorkTasksResponseSchema.parse(result.value));
  });
  app.post<{ Params: { workTaskId: string } }>("/work-tasks/:workTaskId/reports", async (request, reply) => {
    const input = parse(CreateWorkReportSchema, request.body);
    if (!Number.isInteger(input.actualQuantity)) {
      throw new ApplicationError("VALIDATION_ERROR", "返工执行报数只能填写整数件数", 400);
    }
    const result = await dependencies.service.submitReport(
      await actor(request, "report"),
      parse(WorkTaskParamsSchema, request.params).workTaskId,
      input,
      key(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(WorkReportResponseSchema.parse(result.value));
  });
  app.post<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/work-reports/batch", async (request, reply) => {
    const startedAt = Date.now();
    const reworkOrderId = parse(ReworkWorkTasksParamsSchema, request.params).reworkOrderId;
    const input = parse(CreateWorkReportsBatchSchema, request.body);
    if (input.reports.some((report) => !Number.isInteger(report.actualQuantity))) {
      throw new ApplicationError("VALIDATION_ERROR", "返工执行报数只能填写整数件数", 400);
    }
    const result = await dependencies.service.submitReportsBatch(
      await actor(request, "report"),
      reworkOrderId,
      input,
      key(request),
    );
    const response = WorkReportsBatchResponseSchema.parse(result.value);
    if (result.reused) void reply.header("idempotency-replayed", "true");
    request.log.info({
      reworkOrderId,
      reportCount: input.reports.length,
      durationMs: Date.now() - startedAt,
      idempotencyReplayed: result.reused,
    }, "N04 batch work reports submitted");
    return reply.code(201).send(response);
  });
}
