import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ConfirmPreorderMaterialApplicabilitySchema,WarehouseReceiptAttestationSchema,WarehouseReceiptReconciliationSchema,WarehouseReceiptBatchSchema,WarehouseReceiptPageQuerySchema,PreparationMaterialRecordSchema,PreparationResponsibilitySchema,PreparationAdoptionSchema,InstructionDeliverySchema,type PreparationResource} from '@dx-rework/contracts/production-readiness';
import {CreateUploadIntentSchema} from '@dx-rework/contracts';
import {ConfirmDevelopmentSampleHandoverSchema} from '@dx-rework/contracts/digital-development-workspace';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {AttachmentService} from '../tools/attachments.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {ProductionReadinessService} from './production-readiness-service.js';
export function registerProductionReadinessRoutes(app:FastifyInstance,deps:DigitalIdentityDependencies,service:ProductionReadinessService,files:AttachmentService){
 const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请核对办理内容',400);return result.data;};
 const actor=async(r:FastifyRequest)=>businessActor(deps.root,await deps.authenticate(r.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18)),r.id,'digital_production:view');
 const key=(r:FastifyRequest)=>typeof r.headers['idempotency-key']==='string'?r.headers['idempotency-key']:'';
 if(deps.workbenchNumberedCreation)app.get('/digital-production/warehouse/receipts',async(r,reply)=>{
  reply.header('cache-control','private, no-store');
  return service.warehouseReceipts(await actor(r),parse(WarehouseReceiptPageQuerySchema,r.query),true);
 });
 for(const [route,kind] of [['orders','order'],['sources','source']] as const){
  const base=`/digital-production/${route}/:resourceId/production-readiness`;
  const resource=(r:FastifyRequest):PreparationResource=>({kind,id:parse(z.uuid(),(r.params as {resourceId:unknown}).resourceId)});
  app.get(base,async r=>service.read(await actor(r),resource(r)));
  if(kind==='source'){
   app.get(`${base}/sample-handover`,async(r,reply)=>{
    reply.header('cache-control','private, no-store');return service.sampleHandover(await actor(r),resource(r).id);
   });
   app.post(`${base}/sample-handover`,async(r,reply)=>{
    reply.header('cache-control','private, no-store');
    return service.confirmSampleHandover(await actor(r),resource(r).id,parse(ConfirmDevelopmentSampleHandoverSchema,r.body),key(r));
   });
  }
  app.post(`${base}/material-investment-reminder/close`,async r=>service.closeMaterialInvestmentReminder(await actor(r),resource(r),r.body,key(r)));
  if(deps.workbenchNumberedCreation){
   app.post(`${base}/material-investment/confirm-applicability`,async(r,reply)=>{
    reply.header('cache-control','private, no-store');
    return service.confirmPreorderMaterial(await actor(r),resource(r),parse(ConfirmPreorderMaterialApplicabilitySchema,r.body),key(r));
   });
   app.get(`${base}/warehouse-receipt-work`,async(r,reply)=>{
    reply.header('cache-control','private, no-store');
    return service.warehouseReceiptWork(await actor(r),resource(r),true);
   });
   app.post(`${base}/warehouse-receipt-reconciliation`,async(r,reply)=>{
    reply.header('cache-control','private, no-store');
    return service.reconcileWarehouseReceipt(await actor(r),resource(r),parse(WarehouseReceiptReconciliationSchema,r.body),key(r));
   });
   app.post(`${base}/warehouse-receipt-reconciliation/attest`,async(r,reply)=>{
    reply.header('cache-control','private, no-store');
    return service.attestWarehouseReceipt(await actor(r),resource(r),parse(WarehouseReceiptAttestationSchema,r.body),key(r));
   });
   app.post(`${base}/warehouse-receipts`,async(r,reply)=>{
    reply.header('cache-control','private, no-store');
    return service.recordWarehouseReceiptBatch(await actor(r),resource(r),parse(WarehouseReceiptBatchSchema,r.body),key(r));
   });
  }
  app.post(`${base}/materials`,async r=>{
   const result=await service.record(await actor(r),resource(r),parse(PreparationMaterialRecordSchema,r.body),key(r));
   if(result.warehouseReceiptPending)throw new ApplicationError('WAREHOUSE_RECEIPT_NOT_POSTED','未登记，请从原物料的仓库批次面板继续，原输入已保留',409);
   return result;
  });
  app.put(`${base}/responsibility`,async r=>service.assign(await actor(r),resource(r),parse(PreparationResponsibilitySchema,r.body),key(r)));
  app.post(`${base}/adoption-acknowledgement`,async r=>service.adopt(await actor(r),resource(r),parse(PreparationAdoptionSchema,r.body),key(r),true));
  app.post(`${base}/adoption`,async r=>service.adopt(await actor(r),resource(r),parse(PreparationAdoptionSchema,r.body),key(r)));
  if(kind==='order')app.post(`${base}/instruction-deliveries`,async r=>service.deliver(await actor(r),resource(r).id,parse(InstructionDeliverySchema,r.body),key(r)));
  app.get(`${base}/upload-limits`,async r=>{await service.authorize(await actor(r),resource(r));return files.uploadLimits();});
  app.post(`${base}/upload-intents`,async r=>{
   const trusted=await actor(r),target=resource(r);
   await service.authorizeAttachmentUpload(trusted,target);
   return files.createUploadIntent(trusted,parse(CreateUploadIntentSchema,r.body),db=>service.authorizeAttachmentUpload(trusted,target,db));
  });
  app.post(`${base}/attachments/:attachmentId/finalize`,async r=>{
   const trusted=await actor(r),target=resource(r);
   await service.authorizeAttachmentUpload(trusted,target);
   return files.finalize(trusted,parse(z.uuid(),(r.params as {attachmentId:unknown}).attachmentId),db=>service.authorizeAttachmentUpload(trusted,target,db));
  });
  app.get(`${base}/attachments/:attachmentId`,async(r,reply)=>{const trusted=await actor(r),target=resource(r),id=parse(z.uuid(),(r.params as {attachmentId:unknown}).attachmentId);await service.authorize(trusted,target);const grant=await files.createDownloadIntent(trusted,id,()=>service.canDownload(trusted,target,id),'attachment');return reply.redirect(grant.downloadUrl);});
 }
}
