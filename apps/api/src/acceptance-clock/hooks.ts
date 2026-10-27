import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AuthService} from '../auth/service.js';
import type {RootAuthority} from '../access/root-authority.js';
import {businessActor} from '../access/business-authority.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {withAcceptanceBusinessTime} from './business-time.js';
import {clockRequestIds,clockRoots,clockUuid} from './scope.js';
import {clockConflict} from './repository.js';
import type {AcceptanceClockRuntime} from './runtime.js';

const sessions=new WeakMap<FastifyRequest,{scenarioId:string;finish:()=>void;actor:TrustedActorContext}>();
export const acceptanceCookie=(request:FastifyRequest,name:string)=>request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`))?.slice(name.length+1);
export async function acceptanceClockActor(request:FastifyRequest,auth:AuthService,root:RootAuthority|undefined,runtime:AcceptanceClockRuntime){
 const identities=await auth.listAcceptanceIdentities(acceptanceCookie(request,'dx_acceptance_control'));
 const user=await auth.authenticate(acceptanceCookie(request,'dx_rework_session'));
 if(!identities.some(i=>i.userId===user.id&&i.active&&i.employed))throw new ApplicationError('ACCEPTANCE_ISOLATION','请先切换到有效UAT业务身份',403);
 const actor=await businessActor(root,user,request.id,'digital_production:view');await runtime.assertActor(actor);return actor;
}
/** Only installed after the existing Acceptance boot guard; production has no hook. */
export function registerAcceptanceClockHooks(app:FastifyInstance,runtime:AcceptanceClockRuntime,auth:AuthService,root:RootAuthority|undefined){
 app.addHook('preHandler',(request,reply,done)=>{
  const path=request.routeOptions.url??request.url;
  if(path.startsWith('/acceptance/')||!/^\/(?:digital-production|sourcing|production-reporting|cutting|receiving|rework|work-|pattern-room)/.test(path)){done();return;}
  const resolve=async()=>{
   await auth.authenticate(acceptanceCookie(request,'dx_rework_session'));
   const claimed=request.headers['x-acceptance-scenario'];
   if(claimed!==undefined&&!clockUuid(claimed))throw new ApplicationError('VALIDATION_ERROR','测试场景标识无效',400);
   const roots=(await Promise.all(clockRequestIds(request.params,request.body,request.query).map(id=>clockRoots(runtime.database,id)))).flat();
   const scenes=new Set(roots.map(r=>r.scenarioId).filter((id):id is string=>Boolean(id)));
   if(claimed)scenes.add(claimed as string);
   if(!scenes.size)return;
   if(scenes.size!==1||roots.some(r=>!r.scenarioId))clockConflict('不能混用其他场景或非测试订单');
   const id=[...scenes][0]!;
   if(!roots.length&&!['POST /digital-production/sources','POST /digital-production/orders'].includes(`${request.method} ${path}`))clockConflict('请从测试单原关联入口办理；全局统计不使用单场景测试时间');
   const actor=await acceptanceClockActor(request,auth,root,runtime);
   return {id,actor};
  };
  void resolve().then(async value=>{
   if(!value){done();return;}
   await runtime.repository.withLock(value.id,async()=>{
    if(reply.raw.destroyed)return;
    const context=await runtime.context(await runtime.repository.row(value.id));
    await new Promise<void>((finish,reject)=>{
     let finished=false;
     const release=()=>{if(!finished){finished=true;finish();}};
     sessions.set(request,{scenarioId:value.id,finish:release,actor:value.actor});
     reply.raw.once('close',release);
     try{withAcceptanceBusinessTime(context,done);}catch(error){reject(error);}
    });
   });
  }).catch(error=>{if(!reply.sent)done(error);});
 });
 app.addHook('onSend',async(request,reply,payload)=>{
  const session=sessions.get(request);
  if(session&&reply.statusCode>=200&&reply.statusCode<300&&!['GET','HEAD','OPTIONS'].includes(request.method))await runtime.repository.markBusinessMutation(session.scenarioId);
  if(session)reply.header('x-acceptance-clock','scenario');
  return payload;
 });
 app.addHook('onResponse',async request=>{const session=sessions.get(request);if(session){session.finish();sessions.delete(request);}});
}
