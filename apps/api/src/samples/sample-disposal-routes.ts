import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {AuthUser} from '../auth/service.js';
import type {RootAuthority} from '../access/root-authority.js';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import {sampleInput} from './sample-workflow-service.js';
import type {SampleDisposalService} from './sample-disposal-service.js';
export type SampleDisposalDependencies={authenticate(token:string|undefined):Promise<AuthUser>;root?:RootAuthority|undefined;service:SampleDisposalService};
export function registerSampleDisposalRoutes(app:FastifyInstance,deps:SampleDisposalDependencies){
 const actor=async(request:FastifyRequest)=>businessActor(deps.root,await deps.authenticate(request.headers.cookie?.split(';').map(p=>p.trim()).find(p=>p.startsWith('dx_rework_session='))?.slice('dx_rework_session='.length)),request.id,'sample:view_basic');
 app.get('/samples/disposal-people',async(request,reply)=>{const user=await actor(request),query=sampleInput(z.object({search:z.string().trim().min(1).max(100)}).strict(),request.query);reply.header('Cache-Control','no-store');return deps.service.people(user,query.search);});
 app.get<{Params:{id:string}}>('/samples/:id/disposal-actions',async(request,reply)=>{reply.header('Cache-Control','no-store');return deps.service.actions(await actor(request),sampleInput(z.string().uuid(),request.params.id));});
 app.get<{Params:{id:string}}>('/samples/:id/financial-audit',async(request,reply)=>{const query=sampleInput(z.object({page:z.coerce.number().int().min(1).max(100000).default(1)}).strict(),request.query);reply.header('Cache-Control','no-store');return deps.service.financialHistory(await actor(request),sampleInput(z.string().uuid(),request.params.id),query.page);});
 app.get('/samples/archived',async(request,reply)=>{const query=sampleInput(z.object({page:z.coerce.number().int().min(1).max(100000).default(1)}).strict(),request.query);reply.header('Cache-Control','no-store');return deps.service.archived(await actor(request),query.page);});
 for(const [path,method]of [['disposal-request','request'],['disposal-decision','decide'],['loss-close','closeLoss'],['basic','updateBasic'],['location','updateLocation'],['finance-correction','correctFinance'],['archive','archive'],['restore','restore']] as const){
  app.post<{Params:{id:string}}>(`/samples/:id/${path}`,async(request,reply)=>{const user=await actor(request),key=request.headers['idempotency-key'];if(typeof key!=='string')throw new ApplicationError('VALIDATION_ERROR','缺少提交编号',400);reply.header('Cache-Control','no-store');return deps.service[method](user,sampleInput(z.string().uuid(),request.params.id),request.body,key);});
 }
}
