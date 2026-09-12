import { AttachmentParamsSchema, CreateUploadIntentSchema } from "@dx-rework/contracts";
import { PatternOrderQuerySchema, type PatternOrderCapability } from "@dx-rework/contracts/pattern-orders";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { PatternRoomOrderService } from "./order-service.js";

export type PatternRoomOrderDependencies = { authenticate(token: string | undefined): Promise<AuthUser>; service: PatternRoomOrderService; attachments: AttachmentService; root?: RootAuthority };
const orderParams = z.object({ orderId: z.string().uuid() });
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "请检查订单与必填资料", 400);
  return result.data;
};
export function registerPatternRoomOrderRoutes(app: FastifyInstance, dependencies: PatternRoomOrderDependencies): void {
  const actor = async (request: FastifyRequest, capability: PatternOrderCapability) => {
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice(18);
    return businessActor(dependencies.root, await dependencies.authenticate(token), request.id, capability);
  };
  const key = (request: FastifyRequest) => typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
  app.get("/pattern-room/orders", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.list(await actor(request, "pattern_room:orders:view"), parse(PatternOrderQuerySchema, request.query));
  });
  app.get("/pattern-room/workers", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.workers(await actor(request, "pattern_room:orders:assign"), parse(z.object({ q: z.string().max(100).default("") }), request.query).q);
  });
  app.get("/pattern-room/people-filters", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.peopleFilters(await actor(request, "pattern_room:orders:view"));
  });
  app.get("/pattern-room/orders/:orderId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.get(await actor(request, "pattern_room:orders:view"), parse(orderParams, request.params).orderId);
  });
  app.post("/pattern-room/orders", async (request, reply) => reply.code(201).send(await dependencies.service.create(await actor(request, "pattern_room:orders:create"), request.body, key(request))));
  const actions = [
    ["assign", "pattern_room:orders:assign"], ["complete", "pattern_room:orders:complete"],
    ["handoff", "pattern_room:orders:handoff"], ["updateMaterials", "pattern_room:orders:edit"],
  ] as const;
  for (const [method, capability] of actions) {
    app.post(`/pattern-room/orders/:orderId/${method === "updateMaterials" ? "materials" : method}`, async request => dependencies.service[method](
      await actor(request, capability), parse(orderParams, request.params).orderId, request.body, key(request)));
  }
  app.post("/pattern-room/attachments/upload-intents", async (request, reply) => {
    const trusted = await dependencies.service.uploadActor(await actor(request, "pattern_room:orders:create"));
    return reply.code(201).send(await dependencies.attachments.createUploadIntent(trusted, parse(CreateUploadIntentSchema, request.body)));
  });
  app.post("/pattern-room/attachments/:attachmentId/finalize", async request => {
    const trusted = await dependencies.service.uploadActor(await actor(request, "pattern_room:orders:create"));
    return dependencies.attachments.finalize(trusted, parse(AttachmentParamsSchema, request.params).attachmentId);
  });
  app.get("/pattern-room/attachments/:attachmentId/download", async (request, reply) => {
    const trusted = await dependencies.service.downloadActor(await actor(request, "pattern_room:orders:view"));
    const mode = parse(z.object({ mode: z.enum(["preview", "download"]).default("preview") }), request.query).mode;
    const grant = await dependencies.attachments.createDownloadIntent(trusted, parse(AttachmentParamsSchema, request.params).attachmentId,
      binding => dependencies.service.canDownload(trusted, binding), mode === "preview" ? "inline" : "attachment");
    reply.header("cache-control", "no-store");
    return reply.redirect(grant.downloadUrl);
  });
}
