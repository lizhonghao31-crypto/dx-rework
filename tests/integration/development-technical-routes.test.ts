import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {describe,expect,it,vi} from 'vitest';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {registerDevelopmentExecutionRoutes} from '../../apps/api/src/production-platform/development-execution-routes.js';

describe('development technical HTTP validation boundary',()=>{
 const routes=['patch-decision','patch-complete','external-paper-interval','comments'];
 it.each(routes)('returns400 for malformed %s without starting a business transaction',async route=>{
  const connect=vi.fn(),service=new DevelopmentExecutionService({connect} as unknown as Pool,true);
  const app=Fastify();
  registerDevelopmentExecutionRoutes(app,{service:undefined as never,creationEnabled:true,authenticate:async token=>{
   if(token!=='TEST-technical-route')throw new ApplicationError('UNAUTHORIZED','请登录',401);
   return {id:randomUUID(),displayName:'TEST',businessRoles:['pattern_room_supervisor'],capabilities:['digital_production:view']};
  }},service,undefined as never);
  try{
   const response=await app.inject({method:'POST',url:`/digital-production/sources/${randomUUID()}/execution/technical/${route}`,headers:{cookie:'dx_rework_session=TEST-technical-route','idempotency-key':randomUUID()},payload:{unexpected:'TEST invalid input'}});
   expect(response.statusCode).toBe(400);expect(connect).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
});
