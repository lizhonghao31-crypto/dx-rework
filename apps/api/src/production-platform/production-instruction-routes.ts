import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreateUploadIntentSchema } from "@dx-rework/contracts";
import { SaveInstructionSchema, ReviewInstructionSourceSchema, PublishInstructionSchema, InstructionDateRequestSchema,InstructionReceiptKeySchema } from "@dx-rework/contracts/production-instruction";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { ProductionInstructionService } from "./production-instruction-service.js";
export function registerInstructionRoutes(app: FastifyInstance, dependencies: DigitalIdentityDependencies, service: ProductionInstructionService, attachments: AttachmentService) {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR",result.error.issues[0]?.message??"请检查制单",400); return result.data; };
  const actor = async (request: FastifyRequest) => businessActor(dependencies.root,await dependencies.authenticate(request.headers.cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("dx_rework_session="))?.slice(18)),request.id,"digital_production:view");
  const id = (request:FastifyRequest,name:string)=>parse(z.string().uuid(),(request.params as Record<string,unknown>)[name]);
  const key=(request:FastifyRequest)=>typeof request.headers["idempotency-key"]==="string"?request.headers["idempotency-key"]:"";
  const base="/digital-production/orders/:orderId/instruction";
  app.get(`${base}/published-versions`,async(request,reply)=>{const q=parse(z.object({page:z.coerce.number().int().min(1).max(1_000_000).default(1),q:z.string().trim().max(100).default('')}).strict(),request.query);reply.header('cache-control','private, no-store');return service.originalVersions(await actor(request),id(request,'orderId'),q.page,q.q);});
  const originalBase=`${base}/original-versions/:version`;
  app.get(originalBase,async(request,reply)=>{parse(z.object({}).strict(),request.query);reply.header('cache-control','private, no-store');return service.originalVersion(await actor(request),id(request,'orderId'),parse(z.coerce.number().int().positive(),(request.params as {version:string}).version));});
  app.get(`${originalBase}/attachments/:attachmentId`,async(request,reply)=>{
    parse(z.object({}).strict(),request.query);const trusted=await actor(request),orderId=id(request,'orderId'),attachmentId=id(request,'attachmentId'),version=parse(z.coerce.number().int().positive(),(request.params as {version:string}).version);
    const grant=await attachments.createDownloadIntent(trusted,attachmentId,()=>service.canDownloadOriginal(trusted,orderId,version,attachmentId),'inline');
    return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
  });
  app.get(base,async request=>{const query=parse(z.object({version:z.coerce.number().int().positive().optional()}).strict(),request.query);return service.read(await actor(request),id(request,"orderId"),undefined,query.version);});
  app.get(`${base}/save-receipt`,async request=>{const query=parse(z.object({key:InstructionReceiptKeySchema}).strict(),request.query);return service.saveReceipt(await actor(request),id(request,'orderId'),query.key);});
  app.get(`${base}/date-requests/:requestId/decision-receipt`,async request=>{const query=parse(z.object({key:InstructionReceiptKeySchema,approved:z.enum(['true','false']).transform(value=>value==='true')}).strict(),request.query);return service.decisionReceipt(await actor(request),id(request,'orderId'),id(request,'requestId'),query.approved,query.key);});
  app.put(base,async request=>service.save(await actor(request),id(request,"orderId"),parse(SaveInstructionSchema,request.body),key(request)));
  app.post(`${base}/source-review`,async request=>service.reviewSource(await actor(request),id(request,"orderId"),parse(ReviewInstructionSourceSchema,request.body),key(request)));
  app.post(`${base}/publish`,async request=>service.publish(await actor(request),id(request,"orderId"),parse(PublishInstructionSchema,request.body),key(request)));
  app.post(`${base}/date-requests`,async request=>service.requestDate(await actor(request),id(request,"orderId"),parse(InstructionDateRequestSchema,request.body),key(request)));
  app.post(`${base}/date-requests/:requestId/decision`,async request=>service.decideDate(await actor(request),id(request,"orderId"),id(request,"requestId"),parse(z.object({approved:z.boolean()}).strict(),request.body).approved,key(request)));
  app.get(`${base}/upload-limits`,async request=>{await service.authorizeUpload(await actor(request),id(request,"orderId"));return attachments.uploadLimits();});
  app.post(`${base}/upload-intents`,async request=>{const trusted=await actor(request);await service.authorizeUpload(trusted,id(request,"orderId"));const input=parse(CreateUploadIntentSchema,request.body);if(!["image/jpeg","image/png","image/webp"].includes(input.mimeType))throw new ApplicationError("VALIDATION_ERROR","制单图片仅支持 JPG、PNG、WebP",400);return attachments.createUploadIntent(trusted,input);});
  app.post(`${base}/attachments/:attachmentId/finalize`,async request=>{const trusted=await actor(request);await service.authorizeUpload(trusted,id(request,"orderId"));return attachments.finalize(trusted,id(request,"attachmentId"));});
  app.get(`${base}/attachments/:attachmentId`,async(request,reply)=>{const trusted=await actor(request),orderId=id(request,"orderId"),attachmentId=id(request,"attachmentId");const grant=await attachments.createDownloadIntent(trusted,attachmentId,()=>service.canDownload(trusted,orderId,attachmentId),"inline");return reply.redirect(grant.downloadUrl);});
  app.get(`${base}/attachments/:attachmentId/preview`,async(request,reply)=>{
    const orderId=id(request,'orderId'),attachmentId=id(request,'attachmentId');
    const grant=await attachments.createImagePreviewDownloadIntent(()=>actor(request),attachmentId,(trusted)=>service.canDownload(trusted,orderId,attachmentId));
    return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
  });
}
