import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {z} from 'zod';
import {DigitalAnalysisFilterSchema,DigitalAnalysisNoteSchema} from '@dx-rework/contracts/digital-production-analysis';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {DigitalAnalysisQuery} from './reporting-query.js';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
export function registerDigitalAnalysisRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:DigitalAnalysisQuery){
 const actor=async(request:FastifyRequest)=>{const token=request.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('dx_rework_session='))?.slice(18);return businessActor(dependencies.root,await dependencies.authenticate(token),request.id,'report:view');};
 const parse=<T>(schema:z.ZodType<T>,value:unknown)=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR','请核对分析日期、筛选和记录',400);return result.data;};
 app.get('/digital-production/analysis',async request=>service.list(await actor(request),parse(DigitalAnalysisFilterSchema,request.query)));
 app.get('/digital-production/analysis/export',async(request,reply)=>{const content=await service.export(await actor(request),parse(DigitalAnalysisFilterSchema,request.query));reply.header('content-type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition','attachment; filename="digital-production-analysis.xlsx"');return reply.send(content);});
 app.post('/digital-production/analysis/notes',async request=>service.record(await actor(request),parse(DigitalAnalysisNoteSchema,request.body),typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:''));
}
