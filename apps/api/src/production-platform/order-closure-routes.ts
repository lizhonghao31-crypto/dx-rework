import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {SpecialClosureSchema,ReceiptQualitySchema} from '@dx-rework/contracts/order-closure';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {OrderClosureService} from './order-closure-service.js';
export function registerOrderClosureRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:OrderClosureService){
 const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请核对结案资料',400);return result.data;};
 const actor=async(request:FastifyRequest)=>businessActor(dependencies.root,await dependencies.authenticate(request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18)),request.id,'digital_production:view');
 const id=(request:FastifyRequest)=>parse(z.string().uuid(),(request.params as {orderId:unknown}).orderId);
 const base='/digital-production/orders/:orderId/closure';
 app.post(`${base}/quality`,async request=>service.recordQuality(await actor(request),id(request),parse(ReceiptQualitySchema,request.body),typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:''));
 app.get(`${base}/history`,async request=>service.documentHistory(await actor(request),id(request),parse(z.object({beforeId:z.string().uuid().optional()}).strict(),request.query).beforeId));
 app.get(base,async request=>service.read(await actor(request),id(request)));
 app.post(base,async request=>service.close(await actor(request),id(request),parse(SpecialClosureSchema,request.body),typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:''));
}
