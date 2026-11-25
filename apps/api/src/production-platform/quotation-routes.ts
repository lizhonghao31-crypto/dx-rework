import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {IeProcessingQuerySchema,QuotationResourceSchema,QuotationRowInputSchema,QuotationConfirmationSchema,SaveQuotationSchema,
 QuotationLineReviewCommandSchema,SaveQuotationPricingDraftSchema} from '@dx-rework/contracts/digital-quotation';
import {SecondaryCraftDecisionSchema,SecondaryCraftDraftSchema,SecondaryCraftSubmissionSchema} from '@dx-rework/contracts/secondary-craft-quotation';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {DigitalQuotationService} from './quotation-service.js';
export function registerQuotationRoutes(app:FastifyInstance,deps:DigitalIdentityDependencies,service:DigitalQuotationService){
 const attachments=deps.developmentAttachments;
 const parse=<T>(schema:z.ZodType<T>,input:unknown)=>{const result=schema.safeParse(input);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请检查报价输入',400);return result.data;};
 const actor=async(request:FastifyRequest)=>{const token=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('dx_rework_session='))?.slice(18);return businessActor(deps.root,await deps.authenticate(token),request.id,'digital_production:view');};
 const resource=(request:FastifyRequest)=>{const p=request.params as {kind:string;id:string};if(!['orders','sources'].includes(p.kind))throw new ApplicationError('NOT_FOUND','报价来源不存在',404);return parse(QuotationResourceSchema,{kind:p.kind==='orders'?'order':'source',id:p.id});};
 const key=(r:FastifyRequest)=>typeof r.headers['idempotency-key']==='string'?r.headers['idempotency-key']:'';
 app.get('/digital-production/quotations',async request=>service.list(await actor(request)));
 app.get('/digital-production/quotations/ie-processing',async(request,reply)=>{
  const input=parse(IeProcessingQuerySchema,request.query);
  reply.header('cache-control','private, no-store');return service.ieProcessingDirectory(await actor(request),input);
 });
 app.get('/digital-production/quotations/ie-processing/:quoteId/:rowId',async(request,reply)=>{
  const target=parse(z.object({quoteId:z.string().uuid(),rowId:z.string().uuid()}).strict(),request.params);
  reply.header('cache-control','private, no-store');
  const {items}=await service.ieProcessingDirectory(await actor(request),{page:1,search:'',state:'all'},target);
  if(items.length!==1)throw new ApplicationError('NOT_FOUND','当前账号无法查看所选报价行',404);
  return items[0];
 });
 const supportedStyleImage=(mime:string)=>/^image\/(?:jpeg|png|webp|gif)$/.test(mime);
 if(attachments)app.get('/digital-production/quotations/ie-processing/:quoteId/:rowId/style-image/:attachmentId',async(request,reply)=>{
  const {quoteId,rowId,attachmentId}=parse(z.object({quoteId:z.uuid(),rowId:z.uuid(),attachmentId:z.uuid()}).strict(),request.params);
  const {documentVersion}=parse(z.object({documentVersion:z.coerce.number().int().positive()}).strict(),request.query);
  const trusted=await actor(request),{items}=await service.ieProcessingDirectory(trusted,{page:1,search:'',state:'all'},{quoteId,rowId});
  const image=items[0]?.basis?.styleImage;
  if(!image||image.attachmentId!==attachmentId||image.documentVersion!==documentVersion)
   throw new ApplicationError('NOT_FOUND','本报价行所用版本没有此款图',404);
  const grant=await attachments.createDownloadIntent(trusted,attachmentId,async file=>
   file.entityType==='digital_development'&&file.entityId===image.sourceId&&supportedStyleImage(file.mimeType),'inline');
  return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
 });
 app.get('/digital-production/secondary-craft-quotations',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  return service.secondaryCraftDirectory(await actor(request));
 });
 const base='/digital-production/:kind/:id/quotation';
 app.get(`${base}/confirmed-versions`,async(request,reply)=>{const q=parse(z.object({page:z.coerce.number().int().min(1).max(1_000_000).default(1),q:z.string().trim().max(100).default('')}).strict(),request.query);reply.header('cache-control','private, no-store');return service.originalVersions(await actor(request),resource(request),q.page,q.q);});
 const originalBase=`${base}/original-versions/:version`;
 const original=(request:FastifyRequest)=>({version:parse(z.coerce.number().int().positive(),(request.params as {version:string}).version),...parse(z.object({quoteId:z.string().uuid()}).strict(),request.query)});
 app.get(originalBase,async(request,reply)=>{const ref=original(request);reply.header('cache-control','private, no-store');return service.originalVersion(await actor(request),resource(request),ref.quoteId,ref.version);});

 app.get(base,async request=>{const q=parse(z.object({version:z.coerce.number().int().positive().optional()}).strict(),request.query);return service.read(await actor(request),resource(request),undefined,q.version);});
 app.get(`${base}/workbench-pricing`,async request=>{
  parse(z.object({}).strict(),request.query);
  return service.workbenchPreview(await actor(request),resource(request));
 });
 app.put(`${base}/workbench-pricing`,async request=>service.saveWorkbenchPricingDraft(await actor(request),resource(request),
  parse(SaveQuotationPricingDraftSchema,request.body),key(request)));
 app.post(`${base}/workbench-review`,async request=>service.reviewWorkbenchLine(await actor(request),resource(request),
  parse(QuotationLineReviewCommandSchema,request.body),key(request)));
 const craftBase=`${base}/secondary-craft/:rowId`;
 const craftRow=(request:FastifyRequest)=>parse(z.uuid(),(request.params as {rowId:string}).rowId);
 const craftVersion=z.coerce.number().int().positive().optional();
 app.get(craftBase,async(request,reply)=>{
  const query=parse(z.object({supplierSearch:z.string().trim().max(100).optional(),version:craftVersion}).strict()
   .refine(value=>value.supplierSearch===undefined||value.version===undefined),request.query);
  reply.header('cache-control','private, no-store');
  return service.readSecondaryCraft(await actor(request),resource(request),craftRow(request),query);
 });
 if(attachments)app.get(`${craftBase}/attachments/:attachmentId`,async(request,reply)=>{
  const trusted=await actor(request);
  const attachmentId=parse(z.uuid(),(request.params as {attachmentId:string}).attachmentId);
  const query=parse(z.object({version:craftVersion}).strict(),request.query);
  const detail=await service.readSecondaryCraft(trusted,resource(request),craftRow(request),query);
  const target=detail.target;
  if(!target||target.stage!=='development'||!target.attachmentIds.includes(attachmentId))
   throw new ApplicationError('NOT_FOUND','工艺附件不存在',404);
  const grant=await attachments.createDownloadIntent(trusted,attachmentId,async file=>
   file.entityType==='digital_development'&&file.entityId===target.scopeId,'inline');
  return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
 });
 if(attachments)app.get(`${craftBase}/style-image/:attachmentId`,async(request,reply)=>{
  const trusted=await actor(request),attachmentId=parse(z.uuid(),(request.params as {attachmentId:string}).attachmentId);
  const {version,documentVersion}=parse(z.object({version:craftVersion,documentVersion:z.coerce.number().int().positive()}).strict(),request.query);
  const detail=await service.readSecondaryCraft(trusted,resource(request),craftRow(request),{version});
  const image='display' in detail?detail.display?.styleImage:null;
  if(!image||image.attachmentId!==attachmentId||image.documentVersion!==documentVersion)
   throw new ApplicationError('NOT_FOUND','本工艺版本没有此款图',404);
  const grant=await attachments.createDownloadIntent(trusted,attachmentId,async file=>
   file.entityType==='digital_development'&&file.entityId===image.sourceId&&supportedStyleImage(file.mimeType),'inline');
  return reply.header('cache-control','private, no-store').redirect(grant.downloadUrl);
 });
 app.put(`${craftBase}/draft`,async request=>service.writeSecondaryCraft(await actor(request),resource(request),craftRow(request),
  'draft',parse(SecondaryCraftDraftSchema,request.body),key(request)));
 app.post(`${craftBase}/submit`,async request=>service.writeSecondaryCraft(await actor(request),resource(request),craftRow(request),
  'submit',parse(SecondaryCraftSubmissionSchema,request.body),key(request)));
 app.post(`${craftBase}/decision`,async request=>service.writeSecondaryCraft(await actor(request),resource(request),craftRow(request),
  'decision',parse(SecondaryCraftDecisionSchema,request.body),key(request)));
 app.get(`${base}/participants`,async request=>service.participants(await actor(request),resource(request)));
 app.put(base,async request=>service.save(await actor(request),resource(request),parse(SaveQuotationSchema,request.body),key(request)));
 app.post(`${base}/rows/:rowId`,async request=>service.fillRow(await actor(request),resource(request),parse(z.string().uuid(),(request.params as {rowId:string}).rowId),parse(QuotationRowInputSchema,request.body),key(request)));
 app.post(`${base}/confirm`,async request=>service.confirm(await actor(request),resource(request),parse(QuotationConfirmationSchema,request.body),key(request)));
}
