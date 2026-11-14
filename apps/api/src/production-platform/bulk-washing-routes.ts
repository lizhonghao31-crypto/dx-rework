import {z} from 'zod';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {BulkWashingCommandSchema} from '@dx-rework/contracts/bulk-washing';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {BulkWashingService} from './bulk-washing-service.js';
export function registerBulkWashingRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:BulkWashingService){
 const parse=<T>(schema:z.ZodType<T>,value:unknown)=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请核对洗水资料',400);return result.data;};
 const actor=async(request:FastifyRequest)=>businessActor(dependencies.root,await dependencies.authenticate(request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18)),request.id,'digital_production:view');
 const id=(request:FastifyRequest)=>parse(z.uuid(),(request.params as {orderId:unknown}).orderId);
 const base='/digital-production/orders/:orderId/bulk-washing';
 app.get(base,async request=>service.read(await actor(request),id(request)));
 app.post(base,async request=>service.record(await actor(request),id(request),parse(BulkWashingCommandSchema,request.body),typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:''));
}
