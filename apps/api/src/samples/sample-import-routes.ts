import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {AuthUser} from '../auth/service.js';
import type {RootAuthority} from '../access/root-authority.js';
import {businessActor,isRootActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import {sampleInput} from './sample-workflow-service.js';
import type {SampleImportService} from './sample-import-service.js';
export type SampleImportDependencies={authenticate(token:string|undefined):Promise<AuthUser>;root?:RootAuthority|undefined;service:SampleImportService};
export function registerSampleImportRoutes(app:FastifyInstance,deps:SampleImportDependencies){
 const actor=async(request:FastifyRequest)=>{const user=await businessActor(deps.root,await deps.authenticate(request.headers.cookie?.split(';').map(p=>p.trim()).find(p=>p.startsWith('dx_rework_session='))?.slice('dx_rework_session='.length)),request.id,'sample:archive');if(!isRootActor(user))throw new ApplicationError('FORBIDDEN','迁移操作仅限管理员',403);return user;};
 app.post('/samples/migration/import',{bodyLimit:32*1024*1024},async(request,reply)=>{const user=await actor(request),body=sampleInput(z.object({source:z.unknown(),plan:z.unknown()}).strict(),request.body);reply.header('Cache-Control','no-store');return deps.service.import(user,body.source,body.plan);});
 app.post('/samples/migration/cutover',async(request,reply)=>{reply.header('Cache-Control','no-store');return deps.service.cutover(await actor(request),request.body);});
 app.get<{Params:{id:string}}>('/samples/migration/batches/:id/evidence',async(request,reply)=>{const user=await actor(request),query=sampleInput(z.object({kind:z.enum(['sample','log','borrow_request']),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict(),request.query);reply.header('Cache-Control','no-store');return deps.service.evidence(user,sampleInput(z.string().uuid(),request.params.id),query.kind,query.page);});
}
