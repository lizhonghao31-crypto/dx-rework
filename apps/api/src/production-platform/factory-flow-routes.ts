import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreateUploadIntentSchema } from "@dx-rework/contracts";
import {FactoryProductionQcSchema,FactoryLogisticsSchema,FactoryQcSchema,FactoryDispatchSchema,FactoryFollowupSchema} from "@dx-rework/contracts/factory-flow";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { FactoryFlowService } from "./factory-flow-service.js";
export function registerFactoryFlowRoutes(app: FastifyInstance, dependencies: DigitalIdentityDependencies, service: FactoryFlowService, attachments: AttachmentService) {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR",result.error.issues[0]?.message??"请检查裁后办理",400); return result.data; };
  const actor = async (request: FastifyRequest) => businessActor(dependencies.root,await dependencies.authenticate(request.headers.cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("dx_rework_session="))?.slice(18)),request.id,"digital_production:view");
  const id = (request:FastifyRequest,name:string)=>parse(z.string().uuid(),(request.params as Record<string,unknown>)[name]);
  const key=(request:FastifyRequest)=>typeof request.headers["idempotency-key"]==="string"?request.headers["idempotency-key"]:"";
  const base="/digital-production/orders/:orderId/factory-flow";
  app.get(base,async request=>service.read(await actor(request),id(request,"orderId")));
  app.post(`${base}/logistics`,async request=>service.logistics(await actor(request),id(request,"orderId"),parse(FactoryLogisticsSchema,request.body),key(request)));
  app.post(`${base}/production-qc`,async request=>service.productionQc(await actor(request),id(request,"orderId"),parse(FactoryProductionQcSchema,request.body),key(request)));
  app.post(`${base}/qc`,async request=>service.qc(await actor(request),id(request,"orderId"),parse(FactoryQcSchema,request.body),key(request)));
  app.post(`${base}/dispatch`,async request=>service.dispatch(await actor(request),id(request,"orderId"),parse(FactoryDispatchSchema,request.body),key(request)));
  app.post(`${base}/followup`,async request=>service.followup(await actor(request),id(request,"orderId"),parse(FactoryFollowupSchema,request.body),key(request)));
  app.get(`${base}/upload-limits`,async request=>{await service.authorizeUpload(await actor(request),id(request,"orderId"));return attachments.uploadLimits();});
  app.post(`${base}/upload-intents`,async request=>{const trusted=await actor(request);await service.authorizeUpload(trusted,id(request,"orderId"));const input=parse(CreateUploadIntentSchema,request.body);if(!["image/jpeg","image/png","image/webp"].includes(input.mimeType))throw new ApplicationError("VALIDATION_ERROR","QC图片仅支持 JPG、PNG、WebP",400);return attachments.createUploadIntent(trusted,input);});
  app.post(`${base}/attachments/:attachmentId/finalize`,async request=>{const trusted=await actor(request);await service.authorizeUpload(trusted,id(request,"orderId"));return attachments.finalize(trusted,id(request,"attachmentId"));});
  app.get(`${base}/attachments/:attachmentId`,async(request,reply)=>{const trusted=await actor(request),orderId=id(request,"orderId"),attachmentId=id(request,"attachmentId");const grant=await attachments.createDownloadIntent(trusted,attachmentId,()=>service.canDownload(trusted,orderId,attachmentId),"inline");return reply.redirect(grant.downloadUrl);});
  app.get(`${base}/original-attachments/:attachmentId`,async(request,reply)=>{
    const trusted=await actor(request),attachmentId=id(request,'attachmentId'),orderId=id(request,'orderId');
    const query=parse(z.object({checkId:z.string().uuid(),returnFactId:z.string().uuid(),lineId:z.string().uuid(),stepRef:z.union([z.string().uuid(),z.literal('original')])}).strict(),request.query);
    const ref={kind:'craft-return' as const,orderId,attachmentId,...query,stepRef:query.stepRef==='original'?null:query.stepRef};
    const authorize=()=>service.canDownloadOriginal(trusted,ref);
    if(!await authorize())throw new ApplicationError('NOT_FOUND','所选原检查照片或范围不可查看',404);
    const grant=await attachments.createDownloadIntent(trusted,attachmentId,authorize,'inline');
    return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
  });
}
