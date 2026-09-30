import {
  IdempotencyKeySchema,
  ProcessConfigurationOptionsResponseSchema,
  ProcessConfigurationParamsSchema,
  ProcessConfigurationResponseSchema,
  ReviewProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import {
  ActivateProcessWorkerPlanSchema,
  ProcessWorkerPlanActivationResponseSchema,
  ProcessWorkerPlanResponseSchema,
  SaveProcessWorkerPlanSchema,
} from "@dx-rework/contracts/process-worker-plan";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  BUSINESS_READ_ALL_CAPABILITY,
  businessActor,
  isRootUser,
} from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ProcessConfigurationService } from "./process-configuration-service.js";
import type { ProcessWorkerPlanService } from "./process-worker-plan-service.js";

const cookieToken = (request: FastifyRequest): string | undefined =>
  request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("dx_rework_session="))
    ?.slice("dx_rework_session=".length);

const decimalPlaces = (value: number): number => {
  const [coefficient = "", exponentText = "0"] = String(value).toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length ?? 0;
  return Math.max(0, fractionLength - Number(exponentText));
};

const PracticalProcessItemSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("catalog"),
    processId: z.string().uuid(),
    plannedQuantity: z.number().finite().positive().optional().default(1),
    pricingUnit: z.literal("piece"),
    unitPrice: z.number().finite().min(0.001),
    executionKind: z.enum(["worker", "tail_inspection"]).optional().default("worker"),
  }).strict(),
  z.object({
    source: z.literal("custom"),
    customProcessName: z.string().trim().min(1).max(100),
    plannedQuantity: z.number().finite().positive().optional().default(1),
    pricingUnit: z.literal("piece"),
    unitPrice: z.number().finite().min(0.001),
    executionKind: z.enum(["worker", "tail_inspection"]).optional().default("worker"),
  }).strict(),
]).superRefine((value, context) => {
  if (!Number.isInteger(value.plannedQuantity)) {
    context.addIssue({ code: "custom", path: ["plannedQuantity"], message: "返工计件数量只能使用整数件数" });
  }
  if (decimalPlaces(value.unitPrice) > 3) {
    context.addIssue({ code: "custom", path: ["unitPrice"], message: "单价最多保留三位小数" });
  }
});

const PracticalSaveProcessConfigurationSchema = z.object({
  expectedOrderVersion: z.number().int().positive(),
  items: z.array(PracticalProcessItemSchema).min(1).max(100),
  changeReason: z.string().trim().min(1).max(500).optional(),
}).strict();

const parse = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApplicationError("VALIDATION_ERROR", "工序配置参数不完整或格式不正确，请检查工序、计件单位和单价", 400);
  }
  return result.data;
};

const idempotencyKey = (request: FastifyRequest): string =>
  parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

export type ProcessConfigurationHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: ProcessConfigurationService;
  workerPlan?: ProcessWorkerPlanService;
  root?: RootAuthority;
}>;

export function registerProcessConfigurationRoutes(
  app: FastifyInstance,
  dependencies: ProcessConfigurationHttpDependencies,
): void {
  const actor = async (
    request: FastifyRequest,
    mode: "read" | "configure" | "review" | "assign",
  ): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await isRootUser(dependencies.root, user.id);
    const isOwnerReader = user.businessRoles?.includes("owner_group") === true
      && user.capabilities.includes(BUSINESS_READ_ALL_CAPABILITY);
    const isSupervisor = user.businessRoles?.includes("tail_supervisor") === true
      && user.capabilities.includes("process:configure");
    const canAssign = user.businessRoles?.includes("tail_supervisor") === true
      && user.capabilities.includes("work:assign");
    const isReviewer = user.businessRoles?.includes("ie_reviewer") === true
      && user.capabilities.includes("process:review");

    if (mode === "configure") {
      if (!isRoot && !isSupervisor) throw new ApplicationError("FORBIDDEN", "当前角色无权配置返工工序", 403);
      return businessActor(dependencies.root, user, request.id, "process:configure", isRoot ? "tail_supervisor" : undefined);
    }
    if (mode === "assign") {
      if (!isRoot && !canAssign) throw new ApplicationError("FORBIDDEN", "当前角色无权分配返工人员", 403);
      return businessActor(dependencies.root, user, request.id, "work:assign", isRoot ? "tail_supervisor" : undefined);
    }
    if (mode === "review") {
      if (!isRoot && !isReviewer) throw new ApplicationError("FORBIDDEN", "当前角色无权审核返工工序", 403);
      return businessActor(dependencies.root, user, request.id, "process:review", isRoot ? "ie_reviewer" : undefined);
    }
    if (isRoot || isOwnerReader) {
      return businessActor(dependencies.root, user, request.id, "process:configure", "tail_supervisor", true);
    }
    if (isSupervisor) return businessActor(dependencies.root, user, request.id, "process:configure");
    if (canAssign) return businessActor(dependencies.root, user, request.id, "work:assign");
    if (isReviewer) return businessActor(dependencies.root, user, request.id, "process:review");
    throw new ApplicationError("FORBIDDEN", "当前角色无权查看工序配置", 403);
  };

  app.get("/rework-process-configurations/options", async (request) =>
    ProcessConfigurationOptionsResponseSchema.parse(await dependencies.service.options(await actor(request, "configure"))));

  app.get<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration",
    async (request) => ProcessConfigurationResponseSchema.parse(await dependencies.service.get(
      await actor(request, "read"),
      parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
    )),
  );

  if (dependencies.workerPlan) {
    app.get<{ Params: { reworkOrderId: string } }>(
      "/rework-orders/:reworkOrderId/process-worker-plan",
      async (request) => ProcessWorkerPlanResponseSchema.parse(await dependencies.workerPlan!.get(
        await actor(request, "read"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
      )),
    );
    app.put<{ Params: { reworkOrderId: string } }>(
      "/rework-orders/:reworkOrderId/process-worker-plan",
      async (request, reply) => {
        const result = await dependencies.workerPlan!.save(
          await actor(request, "assign"),
          parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
          parse(SaveProcessWorkerPlanSchema, request.body),
          idempotencyKey(request),
        );
        if (result.reused) void reply.header("idempotency-replayed", "true");
        return reply.code(201).send(ProcessWorkerPlanResponseSchema.parse(result.value));
      },
    );
    app.post<{ Params: { reworkOrderId: string } }>(
      "/rework-orders/:reworkOrderId/process-worker-plan/activate",
      async (request, reply) => {
        const result = await dependencies.workerPlan!.activate(
          await actor(request, "assign"),
          parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
          parse(ActivateProcessWorkerPlanSchema, request.body),
          idempotencyKey(request),
        );
        if (result.reused) void reply.header("idempotency-replayed", "true");
        return ProcessWorkerPlanActivationResponseSchema.parse(result.value);
      },
    );
  }

  app.put<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration/draft",
    async (request, reply) => {
      const result = await dependencies.service.saveDraft(
        await actor(request, "configure"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
        parse(PracticalSaveProcessConfigurationSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(ProcessConfigurationResponseSchema.parse(result.value));
    },
  );

  app.post<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration/submit",
    async (request, reply) => {
      const reworkOrderId = parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId;
      const input = parse(SubmitProcessConfigurationSchema, request.body);
      await dependencies.workerPlan?.assertReadyForSubmit(reworkOrderId, input.expectedConfigurationVersion);
      const result = await dependencies.service.submit(
        await actor(request, "configure"), reworkOrderId, input, idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return ProcessConfigurationResponseSchema.parse(result.value);
    },
  );

  app.post<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration/review",
    async (request, reply) => {
      const reworkOrderId = parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId;
      const input = parse(ReviewProcessConfigurationSchema, request.body);
      const result = await dependencies.service.review(
        await actor(request, "review"), reworkOrderId, input, idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      if (input.decision === "approved" && dependencies.workerPlan) {
        try {
          const activation = await dependencies.workerPlan.activateAfterIeApproval(
            reworkOrderId, input.expectedConfigurationVersion, request.id,
          );
          if (activation) {
            return ProcessConfigurationResponseSchema.parse({
              ...result.value,
              reworkStatus: activation.reworkStatus,
              orderVersion: activation.orderVersion,
            });
          }
        } catch {
          // IE review is already durable. Keep the legacy pending-task-assignment
          // state visible so a tail supervisor can use the recovery activation.
        }
      }
      return ProcessConfigurationResponseSchema.parse(result.value);
    },
  );
}
