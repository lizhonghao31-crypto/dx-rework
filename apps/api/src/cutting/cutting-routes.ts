import {
  AttachmentParamsSchema,
  CorrectCuttingRecordSchema,
  CreateCuttingRecordSchema,
  CreateUploadIntentSchema,
  canUseCutting,
  CuttingOrderQuerySchema,
  type CuttingCapability,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { CuttingService } from "./cutting-source-service.js";

export type CuttingHttpDependencies = {
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: CuttingService;
  attachments: AttachmentService;
  root?: RootAuthority;
};

const orderParams = z.object({ cuttingOrderId: z.string().uuid() }).strict();
const imageQuery = z.object({
  mode: z.enum(["thumbnail", "preview", "download"]).default("preview"),
}).strict();
const cookieToken = (request: FastifyRequest): string | undefined =>
  request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("dx_rework_session="))
    ?.slice("dx_rework_session=".length);
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      result.error.issues[0]?.message ?? "请检查裁床信息",
      400,
    );
  }
  return result.data;
};
const idempotencyKey = (request: FastifyRequest): string =>
  typeof request.headers["idempotency-key"] === "string"
    ? request.headers["idempotency-key"]
    : "";

export function registerCuttingRoutes(
  app: FastifyInstance,
  dependencies: CuttingHttpDependencies,
): void {
  const actor = async (request: FastifyRequest, capability: CuttingCapability) =>
    businessActor(
      dependencies.root,
      await dependencies.authenticate(cookieToken(request)),
      request.id,
      capability,
    );

  app.get("/cutting/orders", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.list(
      await actor(request, "cutting:orders:view"),
      parse(CuttingOrderQuerySchema, request.query),
    );
  });

  app.get("/cutting/orders/:cuttingOrderId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { cuttingOrderId } = parse(orderParams, request.params);
    return dependencies.service.get(
      await actor(request, "cutting:orders:view"),
      cuttingOrderId,
    );
  });

  app.post("/cutting/orders/:cuttingOrderId/records", async (request, reply) => {
    const { cuttingOrderId } = parse(orderParams, request.params);
    const result = await dependencies.service.record(
      await actor(request, "cutting:records:create"),
      cuttingOrderId,
      parse(CreateCuttingRecordSchema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) reply.header("idempotency-replayed", "true");
    return reply.code(result.value.outcome === "created" ? 201 : 200).send(result.value);
  });

  app.post("/cutting/orders/:cuttingOrderId/attachments/upload-intents", async (request, reply) => {
    const user = await dependencies.authenticate(cookieToken(request));
    const trusted = await businessActor(dependencies.root, user, request.id, "cutting:records:create");
    if (!canUseCutting(trusted.actorRoles, trusted.authorizationCapabilities ?? [], "cutting:records:create")) {
      throw new ApplicationError("FORBIDDEN", "当前角色仅可查看裁床订单", 403);
    }
    const { cuttingOrderId } = parse(orderParams, request.params);
    const detail = await dependencies.service.get(
      { ...trusted, authorizationCapability: "cutting:orders:view" }, cuttingOrderId,
    );
    if (!detail.canRecord) throw new ApplicationError("FORBIDDEN", "当前裁床订单不能上传登记附件", 403);
    const uploader = await businessActor(dependencies.root, user, request.id, "tools:user");
    if (!uploader.authorizationCapabilities?.includes("tools:user")) throw new ApplicationError("FORBIDDEN", "无权上传附件", 403);
    return reply.code(201).send(await dependencies.attachments.createUploadIntent(uploader, parse(CreateUploadIntentSchema, request.body)));
  });

  app.post("/cutting/orders/:cuttingOrderId/corrections", async (request, reply) => {
    const { cuttingOrderId } = parse(orderParams, request.params);
    const result = await dependencies.service.correct(
      await actor(request, "cutting:records:correct"),
      cuttingOrderId,
      parse(CorrectCuttingRecordSchema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) reply.header("idempotency-replayed", "true");
    return reply.code(200).send(result.value);
  });

  app.get("/cutting/attachments/:attachmentId/download", async (request, reply) => {
    const trusted = await actor(request, "cutting:orders:view");
    const { attachmentId } = parse(AttachmentParamsSchema, request.params);
    const { mode } = parse(imageQuery, request.query);
    const grant = await dependencies.attachments.createDownloadIntent(
      trusted,
      attachmentId,
      (binding) => dependencies.service.canDownload(trusted, binding),
      mode === "download" ? "attachment" : "inline",
      mode === "thumbnail" ? "thumbnail" : undefined,
      { requireBound: true },
    );
    reply.header("cache-control", "no-store");
    return reply.redirect(grant.downloadUrl);
  });
}
