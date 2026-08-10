import {
  IdempotencyKeySchema,
  ProcessConfigurationOptionsResponseSchema,
  ProcessConfigurationParamsSchema,
  ProcessConfigurationResponseSchema,
  ReviewProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
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
    plannedQuantity: z.number().finite().positive(),
    pricingUnit: z.enum(["piece", "hour"]),
    unitPrice: z.number().finite().min(0.001),
  }).strict(),
  z.object({
    source: z.literal("custom"),
    customProcessName: z.string().trim().min(1).max(100),
    plannedQuantity: z.number().finite().positive(),
    pricingUnit: z.enum(["piece", "hour"]),
    unitPrice: z.number().finite().min(0.001),
  }).strict(),
]).superRefine((value, context) => {
  if (decimalPlaces(value.plannedQuantity) > 1) {
    context.addIssue({
      code: "custom",
      path: ["plannedQuantity"],
      message: "计划数量最多保留一位小数",
    });
  }
  if (decimalPlaces(value.unitPrice) > 3) {
    context.addIssue({
      code: "custom",
      path: ["unitPrice"],
      message: "单价最多保留三位小数",
    });
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
    throw new ApplicationError(
      "VALIDATION_ERROR",
      "工序配置参数不完整或格式不正确，请检查工序、计划数量、计价单位和单价",
      400,
    );
  }
  return result.data;
};

const idempotencyKey = (request: FastifyRequest): string =>
  parse(IdempotencyKeySchema, request.headers["idempotency-key"]);

export type ProcessConfigurationHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: ProcessConfigurationService;
  root?: RootAuthority;
}>;

export function registerProcessConfigurationRoutes(
  app: FastifyInstance,
  dependencies: ProcessConfigurationHttpDependencies,
): void {
  const actor = async (
    request: FastifyRequest,
    mode: "read" | "configure" | "review",
  ): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await isRootUser(dependencies.root, user.id);
    const isOwnerReader = user.businessRoles?.includes("owner_group") === true
      && user.capabilities.includes(BUSINESS_READ_ALL_CAPABILITY);
    const isSupervisor = user.businessRoles?.includes("tail_supervisor") === true
      && user.capabilities.includes("process:configure");
    const isReviewer = user.businessRoles?.includes("ie_reviewer") === true
      && user.capabilities.includes("process:review");

    if (mode === "configure") {
      if (!isRoot && !isSupervisor) {
        throw new ApplicationError("FORBIDDEN", "当前角色无权配置返工工序", 403);
      }
      return businessActor(
        dependencies.root,
        user,
        request.id,
        "process:configure",
        isRoot ? "tail_supervisor" : undefined,
      );
    }
    if (mode === "review") {
      if (!isRoot && !isReviewer) {
        throw new ApplicationError("FORBIDDEN", "当前角色无权审核返工工序", 403);
      }
      return businessActor(
        dependencies.root,
        user,
        request.id,
        "process:review",
        isRoot ? "ie_reviewer" : undefined,
      );
    }
    if (isRoot || isOwnerReader) {
      return businessActor(
        dependencies.root,
        user,
        request.id,
        "process:configure",
        "tail_supervisor",
        true,
      );
    }
    if (isSupervisor) {
      return businessActor(dependencies.root, user, request.id, "process:configure");
    }
    if (isReviewer) {
      return businessActor(dependencies.root, user, request.id, "process:review");
    }
    throw new ApplicationError("FORBIDDEN", "当前角色无权查看工序配置", 403);
  };

  app.get("/rework-process-configurations/options", async (request) =>
    ProcessConfigurationOptionsResponseSchema.parse(
      await dependencies.service.options(await actor(request, "configure")),
    ));

  app.get<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration",
    async (request) => ProcessConfigurationResponseSchema.parse(
      await dependencies.service.get(
        await actor(request, "read"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
      ),
    ),
  );

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
      const result = await dependencies.service.submit(
        await actor(request, "configure"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
        parse(SubmitProcessConfigurationSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return ProcessConfigurationResponseSchema.parse(result.value);
    },
  );

  app.post<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/process-configuration/review",
    async (request, reply) => {
      const result = await dependencies.service.review(
        await actor(request, "review"),
        parse(ProcessConfigurationParamsSchema, request.params).reworkOrderId,
        parse(ReviewProcessConfigurationSchema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return ProcessConfigurationResponseSchema.parse(result.value);
    },
  );
}
