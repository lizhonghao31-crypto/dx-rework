import { AttachmentParamsSchema, CreateUploadIntentSchema } from "@dx-rework/contracts";
import { PatternOrderStatusSchema, PatternOrderQuerySchema, PatternHistoryQuerySchema, type PatternOrderCapability } from "@dx-rework/contracts/pattern-orders";
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
const uploadQuery = z.object({ kind: z.enum(["pattern", "misc"]).default("pattern"), purpose: z.enum(["create", "rework"]).default("create") }).strict();
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
  app.get('/pattern-room/history',async(request,reply)=>{reply.header('cache-control','no-store');return dependencies.service.history(await actor(request,'pattern_room:orders:view'),parse(PatternHistoryQuerySchema,request.query));});
  app.get("/pattern-room/misc-associations",async(request,reply)=>{
    reply.header("cache-control","no-store");
    const query=parse(z.object({q:z.string().trim().max(100).default("")}).strict(),request.query);
    return dependencies.service.miscAssociations(await actor(request,"pattern_room:misc:create"),query.q);
  });
  app.get("/pattern-room/workers", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.workers(await actor(request, "pattern_room:orders:assign"), parse(z.object({ q: z.string().max(100).default("") }), request.query).q);
  });
  app.get("/pattern-room/people-filters", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.peopleFilters(await actor(request, "pattern_room:orders:view"));
  });
  app.get("/pattern-room/related-orders",async(request,reply)=>{
    const query=parse(z.object({sourceId:z.string().uuid().optional(),orderId:z.string().uuid().optional(),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict().refine(value=>Boolean(value.sourceId||value.orderId)),request.query);
    reply.header("cache-control","no-store");return dependencies.service.related(await actor(request,"pattern_room:orders:view"),query);
  });
  app.get("/pattern-room/orders/:orderId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.get(await actor(request, "pattern_room:orders:view"), parse(orderParams, request.params).orderId, parse(z.object({ round: z.string().uuid().optional(), node: PatternOrderStatusSchema.optional() }), request.query));
  });
  app.post("/pattern-room/orders", async (request, reply) => reply.code(201).send(await dependencies.service.create(await actor(request, "pattern_room:orders:create"), request.body, key(request))));
  app.post("/pattern-room/misc-orders", async (request, reply) => reply.code(201).send(await dependencies.service.createMisc(await actor(request, "pattern_room:misc:create"), request.body, key(request))));
  const actions = [
    ["deleteOrder", "delete", "pattern_room:orders:delete"],
    ["assign", "assign", "pattern_room:orders:assign"], ["complete", "complete", "pattern_room:orders:complete"],
    ["handoff", "handoff", "pattern_room:orders:handoff"], ["updateMaterials", "materials", "pattern_room:orders:edit"],
    ["confirmMisc", "confirm", "pattern_room:misc:confirm"], ["updateMiscMaterials", "misc-materials", "pattern_room:misc:edit"], ["recordHours", "hours", "pattern_room:orders:hours"],
    ["requestRework", "rework", "pattern_room:orders:rework"], ["transfer", "transfer", "pattern_room:orders:transfer"],
    ["cancel", "cancel", "pattern_room:orders:cancel"], ["confirmCancelledFees", "cancel-fees", "pattern_room:orders:cancel_fees"],
  ] as const;
  for (const [method, path, capability] of actions) {
    app.post(`/pattern-room/orders/:orderId/${path}`, async request => dependencies.service[method](
      await actor(request, capability), parse(orderParams, request.params).orderId, request.body, key(request)));
  }
  app.get("/pattern-room/attachments/upload-limits", async (request, reply) => {
    const { kind, purpose } = parse(uploadQuery, request.query);
    await dependencies.service.uploadActor(await actor(request, purpose === "rework" ? "pattern_room:orders:rework" : kind === "pattern" ? "pattern_room:orders:create" : "pattern_room:misc:create"), kind, purpose);
    reply.header("cache-control", "no-store");
    return dependencies.attachments.uploadLimits();
  });
  app.post("/pattern-room/attachments/upload-intents", async (request, reply) => {
    const { kind, purpose } = parse(uploadQuery, request.query);
    const trusted = await dependencies.service.uploadActor(await actor(request, purpose === "rework" ? "pattern_room:orders:rework" : kind === "pattern" ? "pattern_room:orders:create" : "pattern_room:misc:create"), kind, purpose);
    return reply.code(201).send(await dependencies.attachments.createUploadIntent(trusted, parse(CreateUploadIntentSchema, request.body)));
  });
  app.post("/pattern-room/attachments/:attachmentId/finalize", async request => {
    const { kind, purpose } = parse(uploadQuery, request.query);
    const trusted = await dependencies.service.uploadActor(await actor(request, purpose === "rework" ? "pattern_room:orders:rework" : kind === "pattern" ? "pattern_room:orders:create" : "pattern_room:misc:create"), kind, purpose);
    return dependencies.attachments.finalize(trusted, parse(AttachmentParamsSchema, request.params).attachmentId);
  });
  app.get("/pattern-room/attachments/:attachmentId/download", async (request, reply) => {
    const trusted = await dependencies.service.downloadActor(await actor(request, "pattern_room:orders:view"));
    const mode = parse(z.object({ mode: z.enum(["thumbnail", "preview", "download"]).default("preview") }), request.query).mode;
    const grant = await dependencies.attachments.createDownloadIntent(trusted, parse(AttachmentParamsSchema, request.params).attachmentId,
      binding => dependencies.service.canDownload(trusted, binding), mode === "download" ? "attachment" : "inline", mode === "thumbnail" ? "thumbnail" : undefined);
    reply.header("cache-control", "no-store");
    return reply.redirect(grant.downloadUrl);
  });
}
