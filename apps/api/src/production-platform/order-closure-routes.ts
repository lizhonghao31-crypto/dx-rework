import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {CreateUploadIntentSchema} from '@dx-rework/contracts';
import {SpecialClosureSchema,ReceiptQualitySchema,ReceiptQualityVerificationSchema} from '@dx-rework/contracts/order-closure';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {OrderClosureService} from './order-closure-service.js';
export function registerOrderClosureRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:OrderClosureService){
 const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请核对结案资料',400);return result.data;};
 const actor=async(request:FastifyRequest)=>businessActor(dependencies.root,await dependencies.authenticate(request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18)),request.id,'digital_production:view');
 const id=(request:FastifyRequest)=>parse(z.string().uuid(),(request.params as {orderId:unknown}).orderId);

 const receipt='/digital-production/orders/:orderId/receipt-summary';
 app.get(receipt,async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  const includeBindings=(request.query as {documentBindings?:unknown}).documentBindings==='true';
  return service.cockpitReceipts.read(await actor(request),id(request),includeBindings);
 });
 const base='/digital-production/orders/:orderId/closure';
 if(dependencies.developmentAttachments){
  const attachments=dependencies.developmentAttachments;
  const photo=`${base}/quality/:receiptId/:quantityVersion`;
  const parts=(value:unknown)=>parse(z.object({receiptId:z.uuid(),quantityVersion:z.uuid(),eventId:z.uuid().optional(),attachmentId:z.uuid().optional()}),value);
  app.post(`${photo}/upload-intents`,async request=>{
   const trusted=await actor(request),orderId=id(request),{receiptId,quantityVersion}=parts(request.params);
   await service.authorizeQualityUpload(trusted,orderId,receiptId,quantityVersion);
   const input=parse(CreateUploadIntentSchema,request.body);
   if(!['image/jpeg','image/png','image/webp'].includes(input.mimeType))throw new ApplicationError('VALIDATION_ERROR','QC图片仅支持 JPG、PNG、WebP',400);
   return attachments.createUploadIntent(trusted,input);
  });
  app.post(`${photo}/attachments/:attachmentId/finalize`,async request=>{
   const trusted=await actor(request),orderId=id(request),{receiptId,quantityVersion,attachmentId}=parts(request.params);
   await service.authorizeQualityUpload(trusted,orderId,receiptId,quantityVersion);
   return attachments.finalize(trusted,parse(z.uuid(),attachmentId));
  });
  app.get(`${photo}/history/:eventId/attachments/:attachmentId`,async(request,reply)=>{
   const trusted=await actor(request),orderId=id(request),{receiptId,quantityVersion,eventId,attachmentId}=parts(request.params);
   const original={receiptId,quantityVersion,eventId:parse(z.uuid(),eventId),attachmentId:parse(z.uuid(),attachmentId)};
   const allowed=()=>service.canReadQualityPhoto(trusted,orderId,original);
   if(!await allowed())throw new ApplicationError('NOT_FOUND','原检查图片不可查看',404);
   const grant=await attachments.createDownloadIntent(trusted,original.attachmentId,allowed,'inline');
   reply.header('Cache-Control','no-store');return reply.redirect(grant.downloadUrl);
  });
 }
 app.post(`${base}/quality`,async request=>service.recordQuality(await actor(request),id(request),parse(ReceiptQualitySchema,request.body),typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:''));
 app.post(`${base}/quality/verify-time`,async request=>service.verifyQualityTime(await actor(request),id(request),parse(ReceiptQualityVerificationSchema,request.body),typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:''));
 app.get(`${base}/history`,async request=>{
  const query=parse(z.union([z.object({eventId:z.string().uuid()}).strict(),z.object({beforeId:z.string().uuid().optional()}).strict()]),request.query);
  const user=await actor(request),orderId=id(request);
  return 'eventId'in query?service.documentHistory(user,orderId,undefined,query.eventId):service.documentHistory(user,orderId,query.beforeId);
 });
 app.get(base,async request=>service.read(await actor(request),id(request)));
 app.post(base,async request=>service.close(await actor(request),id(request),parse(SpecialClosureSchema,request.body),typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:''));
}
