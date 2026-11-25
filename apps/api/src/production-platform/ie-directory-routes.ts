import type {FastifyInstance} from 'fastify';
import {UnifiedIeDirectoryQuerySchema,type UnifiedIeDirectoryQuery} from '@dx-rework/contracts/digital-quotation';
import {businessActor,isRootActor} from '../access/business-authority.js';
import type {RootAuthority} from '../access/root-authority.js';
import type {AuthUser} from '../auth/service.js';
import {ApplicationError} from '../platform/errors.js';
import type {IntegratedIeActors,readIntegratedIeDirectory} from './ie-directory-reader.js';

export type ReadIntegratedIeDirectory=(actors:IntegratedIeActors,input:UnifiedIeDirectoryQuery)=>ReturnType<typeof readIntegratedIeDirectory>;

export function registerIeDirectoryRoutes(app:FastifyInstance,deps:{read:ReadIntegratedIeDirectory;root:RootAuthority|undefined;authenticate(token:string|undefined):Promise<AuthUser>}){
 app.get('/digital-production/quotations/ie-directory',async(request,reply)=>{
  const input=UnifiedIeDirectoryQuerySchema.safeParse(request.query);
  if(!input.success)throw new ApplicationError('VALIDATION_ERROR','IE 目录筛选无效',400);
  const token=request.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('dx_rework_session='))?.slice(18);
  const user=await deps.authenticate(token),processing=await businessActor(deps.root,user,request.id,'digital_production:view');
  const sourcing=user.capabilities.includes('sourcing:view')||isRootActor(processing)?await businessActor(deps.root,user,request.id,'sourcing:view'):null;
  const rework=await businessActor(deps.root,user,request.id,'report:view');
  reply.header('cache-control','private, no-store');
  return deps.read({processing,sourcing,rework},input.data);
 });
}
