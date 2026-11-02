import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {CreateUploadIntentSchema} from '@dx-rework/contracts';
import {QC_PROGRESS_CAPABILITY,SubmitQcProgressSchema,QcSupervisionSettingsSchema,QcAdoptSupervisionSchema} from '@dx-rework/contracts/qc-production-progress';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {AttachmentService} from '../tools/attachments.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {QcProductionProgressService} from './qc-production-progress-service.js';
export function registerQcProductionProgressRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:QcProductionProgressService,attachments:AttachmentService){
 const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请检查QC生产记录',400);return result.data;};
 const actor=async(request:FastifyRequest,write=false)=>businessActor(dependencies.root,await dependencies.authenticate(request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18)),request.id,write?QC_PROGRESS_CAPABILITY:'digital_production:view');
 const id=(request:FastifyRequest,name='orderId')=>parse(z.string().uuid(),(request.params as Record<string,unknown>)[name]);
 const key=(request:FastifyRequest)=>typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:'';
 const scope=z.object({factoryDecisionId:z.string().uuid().nullable().optional(),scopeRevision:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
 const base='/digital-production/orders/:orderId/qc-progress';
 app.get(base,async request=>service.read(await actor(request),id(request)));
 app.post(base,async request=>service.submit(await actor(request,true),id(request),parse(SubmitQcProgressSchema,request.body)));
 app.post(`${base}/settings`,async request=>service.settingsCommand(await actor(request,true),id(request),parse(QcSupervisionSettingsSchema,request.body),key(request)));
 app.post(`${base}/adopt`,async request=>service.adopt(await actor(request,true),id(request),parse(QcAdoptSupervisionSchema,request.body),key(request)));
 app.get(`${base}/upload-limits`,async request=>{const target=parse(scope,request.query);await service.authorizeUpload(await actor(request,true),id(request),target.factoryDecisionId??null,target.scopeRevision);return attachments.uploadLimits();});
 app.post(`${base}/upload-intents`,async request=>{
  const input=parse(z.object({factoryDecisionId:z.string().uuid().nullable(),scopeRevision:z.string().regex(/^[0-9a-f]{64}$/),upload:CreateUploadIntentSchema}).strict(),request.body),trusted=await actor(request,true),orderId=id(request);
  await service.authorizeUpload(trusted,orderId,input.factoryDecisionId,input.scopeRevision);
  if(!['image/jpeg','image/png','image/webp'].includes(input.upload.mimeType))throw new ApplicationError('VALIDATION_ERROR','现场照片仅支持JPG、PNG、WebP',400);
  const intent=await attachments.createUploadIntent(trusted,input.upload);
  await service.registerUpload(trusted,orderId,input.factoryDecisionId,input.scopeRevision,intent.attachmentId);return intent;
 });
 app.post(`${base}/attachments/:attachmentId/finalize`,async request=>{const trusted=await actor(request,true),attachmentId=id(request,'attachmentId');await service.authorizePendingUpload(trusted,id(request),attachmentId);return attachments.finalize(trusted,attachmentId);});
 app.get(`${base}/attachments/:attachmentId`,async(request,reply)=>{const trusted=await actor(request),attachmentId=id(request,'attachmentId'),orderId=id(request);const grant=await attachments.createDownloadIntent(trusted,attachmentId,()=>service.canDownload(trusted,orderId,attachmentId),'inline');return reply.redirect(grant.downloadUrl);});
}
