import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {QuotationResourceSchema,QuotationRowInputSchema,QuotationConfirmationSchema,SaveQuotationSchema} from '@dx-rework/contracts/digital-quotation';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {DigitalQuotationService} from './quotation-service.js';
export function registerQuotationRoutes(app:FastifyInstance,deps:DigitalIdentityDependencies,service:DigitalQuotationService){
 const parse=<T>(schema:z.ZodType<T>,input:unknown)=>{const result=schema.safeParse(input);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请检查报价输入',400);return result.data;};
 const actor=async(request:FastifyRequest)=>{const token=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('dx_rework_session='))?.slice(18);return businessActor(deps.root,await deps.authenticate(token),request.id,'digital_production:view');};
 const resource=(request:FastifyRequest)=>{const p=request.params as {kind:string;id:string};if(!['orders','sources'].includes(p.kind))throw new ApplicationError('NOT_FOUND','报价来源不存在',404);return parse(QuotationResourceSchema,{kind:p.kind==='orders'?'order':'source',id:p.id});};
 const key=(r:FastifyRequest)=>typeof r.headers['idempotency-key']==='string'?r.headers['idempotency-key']:'';
 app.get('/digital-production/quotations',async request=>service.list(await actor(request)));
 const base='/digital-production/:kind/:id/quotation';
 app.get(base,async request=>{const q=parse(z.object({version:z.coerce.number().int().positive().optional()}).strict(),request.query);return service.read(await actor(request),resource(request),undefined,q.version);});
 app.get(`${base}/participants`,async request=>service.participants(await actor(request),resource(request)));
 app.put(base,async request=>service.save(await actor(request),resource(request),parse(SaveQuotationSchema,request.body),key(request)));
 app.post(`${base}/rows/:rowId`,async request=>service.fillRow(await actor(request),resource(request),parse(z.string().uuid(),(request.params as {rowId:string}).rowId),parse(QuotationRowInputSchema,request.body),key(request)));
 app.post(`${base}/confirm`,async request=>service.confirm(await actor(request),resource(request),parse(QuotationConfirmationSchema,request.body),key(request)));
}
