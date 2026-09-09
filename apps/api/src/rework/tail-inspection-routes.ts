import {
  IdempotencyKeySchema,
  ProcessConfigurationParamsSchema,
  SubmitTailInspectionReportSchema,
  TailInspectionAssignmentParamsSchema,
  TailInspectionOptionsResponseSchema,
  TailInspectionResponseSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor, isRootUser } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { TailInspectionService } from "./tail-inspection-service.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((part) => part.trim())
  .find((part) => part.startsWith("dx_rework_session="))
  ?.slice("dx_rework_session=".length);

const parse = <T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "整查参数不完整或格式不正确", 400);
  return result.data;
};

const idempotencyKey = (request: FastifyRequest): string => parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

const rejectBody = (input: unknown): { expectedOrderVersion: number; reason: string } => {
  if (typeof input !== "object" || input === null) {
    throw new ApplicationError("VALIDATION_ERROR", "驳回整查参数不完整", 400);
  }
  const body = input as Record<string, unknown>;
  if (!Number.isInteger(body.expectedOrderVersion) || Number(body.expectedOrderVersion) <= 0) {
    throw new ApplicationError("VALIDATION_ERROR", "返工单版本无效", 400);
  }
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 500) {
    throw new ApplicationError("VALIDATION_ERROR", "驳回整查必须填写原因", 400);
  }
  return { expectedOrderVersion: Number(body.expectedOrderVersion), reason: body.reason.trim() };
};

export type TailInspectionHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: TailInspectionService;
  root?: RootAuthority;
}>;

export function registerTailInspectionRoutes(app: FastifyInstance, dependencies: TailInspectionHttpDependencies): void {
  const actor = async (request: FastifyRequest, mode: "read" | "options" | "report" | "review"): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(token(request));
    const root = await isRootUser(dependencies.root, user.id);
    const supervisorConfigure = user.businessRoles?.includes("tail_supervisor") === true
      && user.capabilities.includes("process:configure");
    const supervisorReview = user.businessRoles?.includes("tail_supervisor") === true
      && user.capabilities.includes("submission:audit");
    const inspector = user.businessRoles?.includes("worker") === true
      && user.capabilities.includes("tail_inspection:report");
    if (mode === "options") {
      if (!root && !supervisorConfigure) throw new ApplicationError("FORBIDDEN", "当前角色无权分配整查人员", 403);
      return businessActor(dependencies.root, user, request.id, "process:configure", root ? "tail_supervisor" : undefined);
    }
    if (mode === "report") {
      if (!root && !inspector) throw new ApplicationError("FORBIDDEN", "当前角色无权提交整查报数", 403);
      return businessActor(dependencies.root, user, request.id, "tail_inspection:report", root ? "worker" : undefined);
    }
    if (mode === "review") {
      if (!root && !supervisorReview) throw new ApplicationError("FORBIDDEN", "当前角色无权驳回整查报数", 403);
      return businessActor(dependencies.root, user, request.id, "submission:audit", root ? "tail_supervisor" : undefined);
    }
    if (root) return businessActor(dependencies.root, user, request.id, "process:configure", "tail_supervisor");
    if (supervisorConfigure) return businessActor(dependencies.root, user, request.id, "process:configure");
    if (supervisorReview) return businessActor(dependencies.root, user, request.id, "submission:audit");
    if (inspector) return businessActor(dependencies.root, user, request.id, "tail_inspection:report");
    throw new ApplicationError("FORBIDDEN", "当前角色无权查看整查报数", 403);
  };

  app.get("/tail-inspection-options", async (request) => TailInspectionOptionsResponseSchema.parse(
    await dependencies.service.listOptions(await actor(request, "options")),
  ));
  app.get<{ Params: { reworkOrderId: string } }>("/rework-orders/:reworkOrderId/tail-inspection", async (request) => TailInspectionResponseSchema.parse(
    await dependencies.service.get(
      await actor(request, "read"),
      parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
    ),
  ));
  app.post<{ Params: { assignmentId: string } }>("/tail-inspection-assignments/:assignmentId/reports", async (request, reply) => {
    const result = await dependencies.service.submit(
      await actor(request, "report"),
      parse(TailInspectionAssignmentParamsSchema, request.params).assignmentId,
      parse(SubmitTailInspectionReportSchema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(TailInspectionResponseSchema.parse(result.value));
  });
  app.post<{ Params: { assignmentId: string } }>("/tail-inspection-assignments/:assignmentId/reject", async (request, reply) => {
    const result = await dependencies.service.reject(
      await actor(request, "review"),
      parse(TailInspectionAssignmentParamsSchema, request.params).assignmentId,
      rejectBody(request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return TailInspectionResponseSchema.parse(result.value);
  });
}