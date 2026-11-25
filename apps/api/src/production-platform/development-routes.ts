import {SaveDevelopmentAmendmentSchema,SubmitDevelopmentAmendmentSchema} from "@dx-rework/contracts/digital-development-amendments";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreateUploadIntentSchema } from "@dx-rework/contracts";
import { DevelopmentSubmissionReceiptQuerySchema,SaveDevelopmentSchema, PublishDevelopmentSchema, PublishDevelopmentPreorderSchema, SaveDevelopmentWorkbenchBasicsSchema, DevelopmentMaterialEventSchema } from "@dx-rework/contracts/digital-development";
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
  app.get(base, async request => {const query=parse(z.object({round:z.coerce.number().int().positive().optional()}).strict(),request.query);return service.readDocument(await actor(request),id(request,"sourceId"),query.round,dependencies.workbenchNumberedCreation===true);});
  if(dependencies.creationEnabled&&dependencies.workbenchNumberedCreation){
    app.put(`${base}/workbench-basics`,async request=>service.saveWorkbenchBasics(await actor(request),id(request,'sourceId'),
      parse(SaveDevelopmentWorkbenchBasicsSchema,request.body),key(request)));
  }
  app.get(`${base}/published-versions`,async(request,reply)=>{
    const query=parse(z.object({page:z.coerce.number().int().min(1).max(1_000_000).default(1),q:z.string().max(100).default('')}).strict(),request.query);
    reply.header('cache-control','private, no-store');return service.publishedVersions(await actor(request),id(request,'sourceId'),query.page,query.q);
  });
  const versionBase=`${base}/versions/:documentVersion`;
  const versionReference=(request:FastifyRequest)=>({sourceId:id(request,'sourceId'),
    documentVersion:parse(z.coerce.number().int().positive(),(request.params as Record<string,unknown>).documentVersion),
    round:parse(z.object({round:z.coerce.number().int().positive()}).strict(),request.query).round});
  app.get(versionBase,async(request,reply)=>{
    const ref=versionReference(request);reply.header('cache-control','private, no-store');
    return service.publishedVersion(await actor(request),ref.sourceId,ref.round,ref.documentVersion);
  });
  const versionFile=async(request:FastifyRequest)=>{
    const ref=versionReference(request),attachmentId=id(request,'attachmentId'),trusted=await actor(request);
    if(!await service.canDownloadVersion(trusted,ref.sourceId,ref.round,ref.documentVersion,attachmentId))throw new ApplicationError('NOT_FOUND','找不到所选版本的附件',404);
    return {...ref,attachmentId,trusted};
  };
  app.get(`${versionBase}/attachments/:attachmentId/metadata`,async request=>{
    const ref=await versionFile(request);
    return attachments.readIdentity(ref.trusted,ref.attachmentId,row=>Promise.resolve(row.entityType==='digital_development'&&service.canDownloadVersion(ref.trusted,ref.sourceId,ref.round,ref.documentVersion,ref.attachmentId)));
  });
  app.get(`${versionBase}/attachments/:attachmentId`,async(request,reply)=>{
    const ref=await versionFile(request),grant=await attachments.createDownloadIntent(ref.trusted,ref.attachmentId,row=>Promise.resolve(row.entityType==='digital_development'&&service.canDownloadVersion(ref.trusted,ref.sourceId,ref.round,ref.documentVersion,ref.attachmentId)),'inline');
    return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
  });
  app.get(`${versionBase}/attachments/:attachmentId/preview`,async(request,reply)=>{
    const grant=await attachments.createImagePreviewDownloadIntent(async()=>{const ref=await versionFile(request);return ref.trusted;},id(request,'attachmentId'),async(trusted,row)=>{
      const ref=versionReference(request);return row.entityType==='digital_development'&&service.canDownloadVersion(trusted,ref.sourceId,ref.round,ref.documentVersion,id(request,'attachmentId'));
    });
    return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
  });
  app.get(`${base}/draft-save-receipt`,async request=>service.draftSaveReceipt(await actor(request),id(request,'sourceId'),key(request)));
  app.get(`${base}/submission-receipt`,async(request,reply)=>{const input=parse(DevelopmentSubmissionReceiptQuerySchema,request.query);reply.header('cache-control','private, no-store');return service.submissionReceipt(await actor(request),id(request,'sourceId'),input.operation,input.key);});
  app.get(`${base}/amendment`,async request=>{const input=parse(z.object({taskId:z.string().uuid()}).strict(),request.query);return service.readAmendment(await actor(request),id(request,"sourceId"),input.taskId);});
  app.put(`${base}/amendment`,async request=>service.saveAmendment(await actor(request),id(request,"sourceId"),parse(SaveDevelopmentAmendmentSchema,request.body),key(request)));
  app.post(`${base}/amendment/submit`,async request=>service.submitAmendment(await actor(request),id(request,"sourceId"),parse(SubmitDevelopmentAmendmentSchema,request.body),key(request)));
  app.get(`${base}/amendment/receipt`,async request=>{const input=parse(z.object({taskId:z.string().uuid(),operation:z.enum(["save","submit"]),key:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)}).strict(),request.query);return service.amendmentReceipt(await actor(request),id(request,"sourceId"),input.taskId,input.operation,input.key);});
  app.get(`${base}/amendment/history`,async request=>{const input=parse(z.object({round:z.coerce.number().int().positive()}).strict(),request.query);return service.amendmentHistory(await actor(request),id(request,"sourceId"),input.round);});
  app.put(base, async request => service.save(await actor(request), id(request,"sourceId"), parse(SaveDevelopmentSchema, request.body), key(request),dependencies.workbenchNumberedCreation===true));
  app.post(`${base}/publish`, async request => {const input=parse(PublishDevelopmentSchema,request.body);return service.publish(await actor(request), id(request,"sourceId"), input.expectedVersion, key(request),input.patternOrder);});
  if(dependencies.creationEnabled&&dependencies.workbenchNumberedCreation){
    app.get('/digital-production/development/material-suppliers',async(request,reply)=>{
      const trusted=await actor(request),query=parse(z.object({q:z.string().trim().max(100).default('')}).strict(),request.query);
      dependencies.service.assertSourceCreation(trusted);
      reply.header('cache-control','private, no-store');
      return {items:await service.materialSuppliers(trusted,query.q)};
    });
    app.post(`${base}/publish-preorder`,async request=>{
      const input=parse(PublishDevelopmentPreorderSchema,request.body);
      return service.publishPreorder(await actor(request),id(request,'sourceId'),input.expectedVersion,key(request));
    });
  }
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
    await service.authorizeAttachmentRead(trusted,sourceId);
    return attachments.readIdentity(trusted,attachmentId,async row=>row.entityType==="digital_development"&&service.canDownload(trusted,sourceId,attachmentId));
  });
  app.get(`${base}/attachments/:attachmentId`, async (request,reply) => {
    const trusted = await actor(request), sourceId = id(request,"sourceId"), attachmentId = id(request,"attachmentId");
    // Includes source scope even for unbound drafts owned by the same uploader.
    await service.authorizeAttachmentRead(trusted,sourceId);
    const grant = await attachments.createDownloadIntent(trusted,attachmentId, async row => row.entityType === "digital_development" && service.canDownload(trusted,sourceId,attachmentId),"inline");
    return reply.redirect(grant.downloadUrl);
  });
  app.get(`${base}/attachments/:attachmentId/preview`,async(request,reply)=>{
    const sourceId=id(request,'sourceId'),attachmentId=id(request,'attachmentId');
    const grant=await attachments.createImagePreviewDownloadIntent(async()=>{const trusted=await actor(request);await service.authorizeAttachmentRead(trusted,sourceId);return trusted;},attachmentId,
      (trusted,row)=>Promise.resolve(row.entityType==='digital_development'&&service.canDownload(trusted,sourceId,attachmentId)));
    return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
  });
}
