import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreateUploadIntentSchema } from "@dx-rework/contracts";
import { SaveBudgetSchema, PublishBudgetSchema,AdoptBudgetQuotationSchema } from "@dx-rework/contracts/digital-budget";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { DigitalBudgetService } from "./budget-service.js";

export function registerBudgetRoutes(app: FastifyInstance, dependencies: DigitalIdentityDependencies, service: DigitalBudgetService, attachments: AttachmentService) {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApplicationError("VALIDATION_ERROR", result.error.issues[0]?.message ?? "请检查预算", 400);
    return result.data;
  };
  const actor = async (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice(18);
    return businessActor(dependencies.root, await dependencies.authenticate(token), request.id, "digital_production:view");
  };
  const id = (request: FastifyRequest, name: string) => parse(z.string().uuid(), (request.params as Record<string, unknown>)[name]);
  const key = (request: FastifyRequest) => typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
  const base = "/digital-production/orders/:orderId/budget";
  app.get(base, async request => {
    const query = parse(z.object({ version: z.coerce.number().int().positive().optional() }).strict(), request.query);
    return service.read(await actor(request), id(request, "orderId"), undefined, query.version);
  });
  app.put(base, async request => service.save(await actor(request), id(request, "orderId"), parse(SaveBudgetSchema, request.body), key(request)));
  app.post(`${base}/publish`, async request => {const input=parse(PublishBudgetSchema,request.body);return service.publish(await actor(request),id(request,'orderId'),input.expectedVersion,key(request),input.sourceQuoteVersion);});
  app.post(`${base}/adopt-quotation`,async request=>service.adoptQuotation(await actor(request),id(request,'orderId'),parse(AdoptBudgetQuotationSchema,request.body),key(request)));
  app.post(`${base}/prepare-sourcing`, async request => service.prepareSourcing(await actor(request), id(request, "orderId"), parse(PublishBudgetSchema, request.body).expectedVersion, attachments));
  app.get(`${base}/upload-limits`, async request => { await service.authorizeUpload(await actor(request), id(request, "orderId")); return attachments.uploadLimits(); });
  app.post(`${base}/upload-intents`, async request => {
    const trusted = await actor(request); await service.authorizeUpload(trusted, id(request, "orderId"));
    const input = parse(CreateUploadIntentSchema, request.body);
    if (!["image/jpeg", "image/png", "image/webp"].includes(input.mimeType)) throw new ApplicationError("VALIDATION_ERROR", "预算图片仅支持 JPG、PNG、WebP", 400);
    return attachments.createUploadIntent(trusted, input);
  });
  app.post(`${base}/attachments/:attachmentId/finalize`, async request => {
    const trusted = await actor(request); await service.authorizeUpload(trusted, id(request, "orderId"));
    return attachments.finalize(trusted, id(request, "attachmentId"));
  });
  app.get(`${base}/attachments/:attachmentId`, async (request, reply) => {
    const trusted = await actor(request), orderId = id(request, "orderId"), attachmentId = id(request, "attachmentId");
    await service.read(trusted, orderId);
    const grant = await attachments.createDownloadIntent(trusted, attachmentId, async row => row.entityType === "digital_budget" && row.entityId === orderId && service.canDownload(trusted, orderId, attachmentId), "inline");
    return reply.redirect(grant.downloadUrl);
  });
}
