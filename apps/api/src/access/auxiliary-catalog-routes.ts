import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {AuxiliaryQuerySchema,AuxiliaryHistoryQuerySchema,CreateAuxiliarySchema,RenameAuxiliarySchema,DisableAuxiliarySchema,MergeAuxiliarySchema} from '@dx-rework/contracts/auxiliary-catalog';
import {IdempotencyKeySchema} from '@dx-rework/contracts';
import {requestValidationMessage} from '@dx-rework/contracts/validation-language';
import type {AuthUser} from '../auth/service.js';
import {ApplicationError} from '../platform/errors.js';
import {businessActor} from './business-authority.js';
import type {RootAuthority} from './root-authority.js';
import type {AuxiliaryCatalogService} from './auxiliary-catalog-service.js';
const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError('VALIDATION_ERROR',requestValidationMessage(result),400);return result.data;};
export function registerAuxiliaryCatalogRoutes(app:FastifyInstance,dependencies:{authenticate(token:string|undefined):Promise<AuthUser>;root:RootAuthority;service:AuxiliaryCatalogService}){
 const actor=async(request:FastifyRequest,write=false)=>{const token=request.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('dx_rework_session='))?.slice('dx_rework_session='.length);return businessActor(dependencies.root,await dependencies.authenticate(token),request.id,`auxiliary_catalog:${write?'write':'read'}`);};
 const path='/master-data/auxiliaries',id=(request:FastifyRequest)=>parse(z.object({id:z.string().uuid()}).strict(),request.params).id,key=(request:FastifyRequest)=>parse(IdempotencyKeySchema,request.headers['idempotency-key']);
 app.get(path,async request=>dependencies.service.list(await actor(request),parse(AuxiliaryQuerySchema,request.query)));
 app.get(`${path}/receipt`,async request=>{const query=parse(z.object({action:z.enum(['create','rename','disable','merge']),key:IdempotencyKeySchema}).strict(),request.query);return dependencies.service.receipt(await actor(request),query.action,query.key);});
 app.get(`${path}/:id/versions`,async request=>{
  const {page,version}=parse(AuxiliaryHistoryQuerySchema,request.query);
  return dependencies.service.history(await actor(request),id(request),page,version);
 });
 app.post(path,async request=>dependencies.service.create(await actor(request,true),parse(CreateAuxiliarySchema,request.body),key(request)));
 app.post(`${path}/:id/versions`,async request=>dependencies.service.rename(await actor(request,true),id(request),parse(RenameAuxiliarySchema,request.body),key(request)));
 app.post(`${path}/:id/disable`,async request=>dependencies.service.disable(await actor(request,true),id(request),parse(DisableAuxiliarySchema,request.body),key(request)));
 app.post(`${path}/:id/merge`,async request=>dependencies.service.merge(await actor(request,true),id(request),parse(MergeAuxiliarySchema,request.body),key(request)));
}
