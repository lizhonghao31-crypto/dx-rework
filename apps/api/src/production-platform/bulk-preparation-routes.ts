import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import { BulkDispatchSchema,BulkCompletionSchema,BulkWorkroomFilterSchema,BulkFabricReportSchema,BulkFabricDecisionSchema,BulkMaterialsDispatchSchema } from "@dx-rework/contracts/bulk-preparation";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { BulkPreparationService } from "./bulk-preparation-service.js";
import {PreshrinkCorrectionPreviewSchema,PreshrinkCorrectionApplySchema} from './bulk-preshrink-correction-service.js';
export function registerBulkPreparationRoutes(app:FastifyInstance,deps:DigitalIdentityDependencies,service:BulkPreparationService){
 const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const parsed=schema.safeParse(value);if(!parsed.success)throw new ApplicationError('VALIDATION_ERROR',parsed.error.issues[0]?.message??'请检查办理内容',400);return parsed.data;};
 const actor=async(r:FastifyRequest)=>businessActor(deps.root,await deps.authenticate(r.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18)),r.id,'digital_production:view');
 const id=(r:FastifyRequest)=>parse(z.string().uuid(),(r.params as {orderId:unknown}).orderId);
 const key=(r:FastifyRequest)=>typeof r.headers['idempotency-key']==='string'?r.headers['idempotency-key']:'';
 const base='/digital-production/orders/:orderId/bulk-preparation';
 app.get('/digital-production/workspaces/bulk-pattern',async r=>{
  const user=await actor(r);
  const {view,...filter}=parse(BulkWorkroomFilterSchema.extend({view:z.literal('cards').optional()}),r.query);
  return view==='cards'?service.workroomCards(user,filter):service.workroom(user,filter);
 });
 app.get(`${base}/history`,async r=>{
  const query=parse(z.union([z.object({eventId:z.string().uuid()}).strict(),z.object({beforeId:z.string().uuid().optional()}).strict()]),r.query);
  const user=await actor(r),orderId=id(r);
  return 'eventId'in query?service.documentHistory(user,orderId,undefined,query.eventId):service.documentHistory(user,orderId,query.beforeId);
 });
 app.get(base,async r=>service.read(await actor(r),id(r)));
 app.put(`${base}/dispatch`,async r=>service.dispatch(await actor(r),id(r),parse(BulkDispatchSchema,r.body),key(r)));
 app.post(`${base}/fabric-report`,async r=>service.reportFabric(await actor(r),id(r),parse(BulkFabricReportSchema,r.body),key(r)));
 app.post(`${base}/fabric-decision`,async r=>service.decideFabric(await actor(r),id(r),parse(BulkFabricDecisionSchema,r.body),key(r)));
 app.post(`${base}/materials-dispatch`,async r=>service.dispatchMaterials(await actor(r),id(r),parse(BulkMaterialsDispatchSchema,r.body),key(r)));
 app.post(`${base}/complete`,async r=>service.complete(await actor(r),id(r),parse(BulkCompletionSchema,r.body),key(r)));
 if(deps.root){
  const correction=service.scopedPreshrinkCorrection(deps.root);
  app.post(`${base}/preshrink-correction/preview`,async r=>correction.preview(await actor(r),id(r),parse(PreshrinkCorrectionPreviewSchema,r.body)));
  app.post(`${base}/preshrink-correction/apply`,async r=>correction.apply(await actor(r),id(r),parse(PreshrinkCorrectionApplySchema,r.body),key(r)));
 }
}
