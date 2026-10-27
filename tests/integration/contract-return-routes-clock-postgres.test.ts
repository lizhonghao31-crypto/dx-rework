import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {registerSourcingRoutes} from '../../apps/api/src/sourcing/sourcing-routes.js';
import {SourcingContractReturnService} from '../../apps/api/src/sourcing/sourcing-contract-return-service.js';
import {registerAcceptanceClockHooks} from '../../apps/api/src/acceptance-clock/hooks.js';
import type {AuthService,AuthUser} from '../../apps/api/src/auth/service.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('original contract return HTTP clock path',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);},120000);
 afterAll(async()=>{await f?.dispose();});
 const appFor=()=>{
  const owner=f.people.owner!,user:AuthUser={id:owner.actorId,displayName:'TEST original UAT owner',businessRoles:['owner_group'],capabilities:['digital_production:view','sourcing:view','sourcing:owner:approve','supplier_contract_data:read']};
  const authenticate=async()=>user,auth={authenticate,listAcceptanceIdentities:async()=>[{userId:user.id,active:true,employed:true}]} as unknown as AuthService;
  const app=Fastify();registerAcceptanceClockHooks(app,f.runtime,auth,undefined);
  registerSourcingRoutes(app,{authenticate,service:f.sourcing,contracts:f.contracts,contractReturns:new SourcingContractReturnService(f.db)});return app;
 };
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: original GET/POST retains strict response schema and approved UAT owner scope`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-7:mode==='current'?0:7)*86400000).toISOString(),scene=mode==='ordinary'?null:await f.scene(at);
  const p=scene?await f.runtime.run(scene,f.root,()=>f.bulkReady('无')):await f.bulkReady('无'),app=appFor();
  try{const before=await app.inject({method:'GET',url:`/sourcing/cases/${p.caseId}/contract-return`});expect(before.statusCode,before.body).toBe(200);
   if(scene){expect(before.json().contractGeneratedAt).toBe(at);expect(before.json().contractReturnAsOf).toBe(at);}else expect(before.json().contractReturnTimeQuality).toBeUndefined();
   const file=await f.image(f.people.owner!),key=randomUUID(),input={method:'POST' as const,url:`/sourcing/cases/${p.caseId}/contract-return`,headers:{'idempotency-key':key},payload:{attachmentIds:[file]}};
   const first=await app.inject(input);expect(first.statusCode,first.body).toBe(200);expect(first.json().contractReturnStatus).toBe('returned_on_time');
   if(scene)expect(first.json().contractReturnedAt).toBe(at);else expect(Math.abs(Date.parse(first.json().contractReturnedAt)-Date.now())).toBeLessThan(60000);
   const retry=await app.inject(input);expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual(first.json());
   const audit=(await f.db.query('SELECT submitted_at,submitted_by FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1',[p.caseId])).rows[0];expect(audit.submitted_by).toBe(f.people.owner!.actorId);expect(Math.abs(audit.submitted_at.getTime()-Date.now())).toBeLessThan(60000);
  }finally{await app.close();}
 },60000);
 it('rejects a foreign scenario header and a scene/ordinary mixed request before business writes',async()=>{
  const scene=await f.scene('2026-11-01T02:00:00.000Z'),other=await f.scene('2026-11-02T02:00:00.000Z'),p=await f.runtime.run(scene,f.root,()=>f.bulkReady('无')),ordinary=await f.bulkReady('无'),app=appFor();
  try{for(const [id,claimed] of [[p.caseId,other],[ordinary.caseId,scene]]){
   const response=await app.inject({method:'POST',url:`/sourcing/cases/${id}/contract-return`,headers:{'idempotency-key':randomUUID(),'x-acceptance-scenario':claimed!},payload:{attachmentIds:[await f.image(f.people.owner!)]}});
   expect(response.statusCode,response.body).toBe(409);
   expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1',[id])).rows[0].n).toBe(0);
  }}finally{await app.close();}
 },60000);
});
