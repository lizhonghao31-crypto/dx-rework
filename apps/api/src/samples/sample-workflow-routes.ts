import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthUser } from "../auth/service.js";
import type { RootAuthority } from "../access/root-authority.js";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { sampleInput,type SampleWorkflowService } from "./sample-workflow-service.js";
export type SampleWorkflowDependencies={authenticate(token:string|undefined):Promise<AuthUser>;root?:RootAuthority|undefined;service:SampleWorkflowService};
export function registerSampleWorkflowRoutes(app:FastifyInstance,deps:SampleWorkflowDependencies){
 const actor=async(request:FastifyRequest)=>{
  const token=request.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('dx_rework_session='))?.slice('dx_rework_session='.length);
  return businessActor(deps.root,await deps.authenticate(token),request.id,'sample:view_basic');
 };
 const key=(request:FastifyRequest)=>{const value=request.headers['idempotency-key'];if(typeof value!=='string')throw new ApplicationError('VALIDATION_ERROR','缺少提交编号',400);return value;};
 app.get<{Params:{id:string}}>('/samples/:id/workflow',async(request,reply)=>{const user=await actor(request);reply.header('Cache-Control','no-store');return deps.service.view(user,sampleInput(z.string().uuid(),request.params.id));});
 app.get('/samples/borrowers',async(request,reply)=>{const user=await actor(request),query=sampleInput(z.object({search:z.string().trim().min(1).max(100)}).strict(),request.query);reply.header('Cache-Control','no-store');return deps.service.people(user,query.search);});
 for(const [name,method] of [['borrow','borrow'],['return','returnRequest'],['handoff-qr','issueQr'],['confirm','confirm'],['cancel','cancel']] as const){
  app.post<{Params:{id:string}}>(`/samples/:id/${name}`,async(request,reply)=>{const user=await actor(request);reply.header('Cache-Control','no-store');return deps.service[method](user,sampleInput(z.string().uuid(),request.params.id),request.body,key(request));});
 }
 app.post('/samples/returns/batch',async(request,reply)=>{const user=await actor(request);reply.header('Cache-Control','no-store');return deps.service.returnBatch(user,request.body,key(request));});
 app.post('/samples/handoff/lookup',async(request,reply)=>{const user=await actor(request);const body=sampleInput(z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict(),request.body);reply.header('Cache-Control','no-store');return deps.service.lookupQr(user,body.token);});
}
