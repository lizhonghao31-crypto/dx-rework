import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {OrderTimeRuleSchema} from '@dx-rework/contracts/order-time-plan';
import {OrderTimeCheckSchema,OrderTimeRequestSchema,OrderTimeApplySchema,OrderTimeArrangementSchema,OrderTimeReturnSchema,OrderTimeWithdrawSchema} from '@dx-rework/contracts/order-time-requests';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {OrderTimeRequestService} from './order-time-request-service.js';

export function registerOrderTimeRequestRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:OrderTimeRequestService){
 const actor=async(request:FastifyRequest)=>{
  const token=request.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith('dx_rework_session='))?.slice(18);
  return businessActor(dependencies.root,await dependencies.authenticate(token),request.id,'digital_production:view');
 };
 const id=(request:FastifyRequest)=>z.string().uuid().parse((request.params as {requestId:string}).requestId);
 const key=(request:FastifyRequest)=>typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:'';
 const body=<T,>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请核对本单时效资料',400);return result.data;};
 app.post('/digital-production/order-time/check',async request=>service.check(await actor(request),body(OrderTimeCheckSchema,request.body).operation));
 app.post('/digital-production/order-time/preview',async request=>{const input=body(OrderTimeCheckSchema.extend({overrides:z.record(z.string(),OrderTimeRuleSchema)}).strict(),request.body);return service.check(await actor(request),input.operation,input.overrides);});
 app.post('/digital-production/order-time/requests',async request=>service.submit(await actor(request),body(OrderTimeRequestSchema,request.body),key(request)));
 app.post('/digital-production/order-time/arrange',async request=>service.arrange(await actor(request),body(OrderTimeArrangementSchema,request.body),key(request)));
 app.get('/digital-production/order-time/requests/:requestId',async request=>service.read(await actor(request),id(request)));
 app.post('/digital-production/order-time/requests/:requestId/preview',async request=>service.read(await actor(request),id(request),body(z.object({overrides:z.record(z.string(),OrderTimeRuleSchema)}).strict(),request.body).overrides));
 app.post('/digital-production/order-time/requests/:requestId/resubmit',async request=>service.resubmit(await actor(request),id(request),body(OrderTimeRequestSchema.extend({expectedVersion:OrderTimeApplySchema.shape.expectedVersion}),request.body),key(request)));
 app.post('/digital-production/order-time/requests/:requestId/apply',async request=>service.apply(await actor(request),id(request),body(OrderTimeApplySchema,request.body),key(request)));
 app.post('/digital-production/order-time/requests/:requestId/return',async request=>service.close(await actor(request),id(request),body(OrderTimeReturnSchema,request.body),key(request),'returned'));
 app.post('/digital-production/order-time/requests/:requestId/withdraw',async request=>service.close(await actor(request),id(request),body(OrderTimeWithdrawSchema,request.body),key(request),'withdrawn'));
}
