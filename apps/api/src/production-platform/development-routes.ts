import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreateUploadIntentSchema } from "@dx-rework/contracts";
import { SaveDevelopmentSchema, PublishDevelopmentSchema, DevelopmentMaterialEventSchema } from "@dx-rework/contracts/digital-development";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { DigitalDevelopmentService } from "./development-service.js";

export function registerDevelopmentRoutes(app: FastifyInstance, dependencies: DigitalIdentityDependencies, service: DigitalDevelopmentService, attachments: AttachmentService) {
  const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
    const result = schema.safeParse(input);
    if (!result.success) throw new ApplicationError("VALIDATION_ERROR", result.error.issues[0]?.message ?? "请检查开发单", 400);
    return result.data;
  };
  const actor = async (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice(18);
    return businessActor(dependencies.root, await dependencies.authenticate(token), request.id, "digital_production:view");
  };
  const id = (request: FastifyRequest, name: string) => parse(z.string().uuid(), (request.params as Record<string, unknown>)[name]);
  const key = (request: FastifyRequest) => typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
  const base = "/digital-production/sources/:sourceId/development";
  app.get(base, async request => {const query=parse(z.object({round:z.coerce.number().int().positive().optional()}).strict(),request.query);return service.read(await actor(request),id(request,"sourceId"),undefined,query.round);});
  app.put(base, async request => service.save(await actor(request), id(request,"sourceId"), parse(SaveDevelopmentSchema, request.body), key(request)));
  app.post(`${base}/publish`, async request => {const input=parse(PublishDevelopmentSchema,request.body);return service.publish(await actor(request), id(request,"sourceId"), input.expectedVersion, key(request),input.patternOrder);});
  app.post(`${base}/materials/:materialId/events`, async request => service.materialEvent(await actor(request), id(request,"sourceId"), id(request,"materialId"), parse(DevelopmentMaterialEventSchema, request.body), key(request)));
  app.get(`${base}/upload-limits`, async request => { await service.authorizeUpload(await actor(request),id(request,"sourceId")); return attachments.uploadLimits(); });
  app.post(`${base}/upload-intents`, async request => {
    const trusted = await actor(request); await service.authorizeUpload(trusted,id(request,"sourceId"));
    return attachments.createUploadIntent(trusted,parse(CreateUploadIntentSchema,request.body));
  });
  app.post(`${base}/attachments/:attachmentId/finalize`, async request => {
    const trusted = await actor(request); await service.authorizeUpload(trusted,id(request,"sourceId"));
    return attachments.finalize(trusted,id(request,"attachmentId"));
  });
  app.get(`${base}/attachments/:attachmentId/metadata`, async request => {
    const trusted=await actor(request),sourceId=id(request,"sourceId"),attachmentId=id(request,"attachmentId");
    await service.read(trusted,sourceId);
    return attachments.readIdentity(trusted,attachmentId,async row=>row.entityType==="digital_development"&&row.entityId===sourceId&&service.canDownload(trusted,sourceId,attachmentId));
  });
  app.get(`${base}/attachments/:attachmentId`, async (request,reply) => {
    const trusted = await actor(request), sourceId = id(request,"sourceId"), attachmentId = id(request,"attachmentId");
    // Includes source scope even for unbound drafts owned by the same uploader.
    await service.read(trusted,sourceId);
    const grant = await attachments.createDownloadIntent(trusted,attachmentId, async row => row.entityType === "digital_development" && row.entityId === sourceId && service.canDownload(trusted,sourceId,attachmentId),"inline");
    return reply.redirect(grant.downloadUrl);
  });
}
