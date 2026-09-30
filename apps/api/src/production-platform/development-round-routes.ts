import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {SaveDevelopmentRevisionSchema,PublishDevelopmentRevisionSchema} from '@dx-rework/contracts/digital-development-rounds';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {DevelopmentRoundService} from './development-round-service.js';
export function registerDevelopmentRoundRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:DevelopmentRoundService){
 const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const result=schema.safeParse(input);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',result.error.issues[0]?.message??'请检查复版资料',400);return result.data;};
 const actor=async(request:FastifyRequest)=>{const token=request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18);return businessActor(dependencies.root,await dependencies.authenticate(token),request.id,'digital_production:view');};
 const id=(request:FastifyRequest)=>parse(z.string().uuid(),(request.params as {sourceId:string}).sourceId);
 const key=(request:FastifyRequest)=>typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:'';
 const base='/digital-production/sources/:sourceId/development';
 app.get(`${base}/rounds`,async request=>service.read(await actor(request),id(request)));
 app.put(`${base}/round-draft`,async request=>service.save(await actor(request),id(request),parse(SaveDevelopmentRevisionSchema,request.body),key(request)));
 app.post(`${base}/round-publish`,async request=>service.publish(await actor(request),id(request),parse(PublishDevelopmentRevisionSchema,request.body),key(request)));
}
