import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {businessNow,ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {appendCurrentSettingsSet} from '../../apps/api/src/production-platform/sla-settings-set-repository.js';
import {assertSlaSettingsActor} from '../../apps/api/src/production-platform/sla-settings-authority.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('R5 native company time settings without early adoption',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,service:OrderTimeSettingsService;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);service=new OrderTimeSettingsService(f.db,true);});
 afterAll(async()=>{await f?.dispose();});
 it('reads without writing a new company standard or adopting an order and holds the runtime switch until07',async()=>{
  const before=(await f.db.query('SELECT count(*)::int AS n FROM digital_order_time_standards')).rows[0].n;
  const state=await new OrderTimeSettingsService(f.db).read(f.root);expect(state.enabled).toBe(false);expect(state.record).toBeNull();
  await expect(new OrderTimeSettingsService(f.db).save(f.root,{expectedVersion:0,values:state.current},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_order_time_standards')).rows[0].n).toBe(before);
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_order_time_plan_versions')).rows[0].n).toBe(0);
 });
 it('saves complete time/calendar/reminders once and preserves the same-key receipt after later publication',async()=>{
  const state=await service.read(f.root),values=structuredClone(state.current),key=randomUUID();
  values.nodes.development_pattern={kind:'work',minutes:120,calendar:'beijing_sunday_excluded',reminder:{enabled:false,percent:80}};
  const body={expectedVersion:state.version,values},first=await service.save(f.root,body,key);
  expect(first.record.standard.nodes.development_pattern).toEqual(values.nodes.development_pattern);expect(first.existingOrdersChanged).toBe(0);
  const later=structuredClone(values);later.nodes.development_pattern={...values.nodes.development_pattern,minutes:180};
  const second=await service.save(f.root,{expectedVersion:first.record.version,values:later},randomUUID());expect(second.record.version).toBe(first.record.version+1);
  expect(await service.save(f.root,body,key)).toEqual(first);expect((await service.read(f.root)).record?.id).toBe(second.record.id);
  await expect(service.save(f.root,{...body,values:later},key)).rejects.toMatchObject({statusCode:409});
  await expect(f.db.query('UPDATE digital_order_time_standards SET standard_json=\'{}\' WHERE standard_id=$1',[first.record.id])).rejects.toBeTruthy();
 });
 it('refuses a stale concurrent save without changing the current standard',async()=>{
  const state=await service.read(f.root),a=structuredClone(state.current),b=structuredClone(state.current);a.stageBufferMinutes=60;b.stageBufferMinutes=120;
  const results=await Promise.allSettled([service.save(f.root,{expectedVersion:state.version,values:a},randomUUID()),service.save(f.root,{expectedVersion:state.version,values:b},randomUUID())]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await service.read(f.root)).version).toBe(state.version+1);
 });
 it('uses history in one command and hides a deleted entry without destroying an adopted order counterpart',async()=>{
  const history=await service.history(f.root),chosen=history.items.filter(row=>row.kind==='order_time').at(-1)!,state=await service.read(f.root);
  const used=await service.use(f.root,{expectedVersion:state.version,id:chosen.id},randomUUID());expect(used.record.sourceId).toBe(chosen.id);expect(used.record.standard.nodes).toEqual(chosen.standard.nodes);
  const identity=new DigitalProductionIdentityService(f.db,true),style='TEST-R5-HISTORY-'+randomUUID(),order=await identity.createOrder(f.people['sample-designer']!,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:beijingCalendarDate(businessNow()),lines:[{formalPoNo:style,color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:1}]}]}),randomUUID());
  const line=order.lines[0]!,client=await f.db.connect();try{await client.query('BEGIN');await new OrderTimePlanRepository(client).confirm({resource:{kind:'order',id:order.productionOrderId},expectedRevision:0,value:{version:'order-time-input-v1',plan:{version:'order-time-plan-v1',revision:1,company:chosen.standard,overrides:{}},work:[{id:'TEST pattern',parameterKey:'development_pattern',stage:2,dependsOn:[]}],scopes:[{scopeRef:'po:'+line.lineId,lineId:line.lineId,terminalIds:['TEST pattern'],customerGoalIds:['TEST pattern'],goals:{'TEST pattern':{precision:'date',value:'2027-03-01',source:'TEST actual PO'}},customerGoal:{precision:'date',value:'2027-03-01',source:'TEST actual PO'}}],route:{complete:true,missing:[]}},actorId:f.root.actorId,eventRef:'TEST explicit original order confirmation',time:await new ContextBusinessClock().read({kind:'order',id:order.productionOrderId}),requestKey:randomUUID()});await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  const key=randomUUID(),body={expectedVersion:used.record.version,id:chosen.id};expect(await service.remove(f.root,body,key)).toEqual(await service.remove(f.root,body,key));
  expect((await service.history(f.root)).items.some(row=>row.id===chosen.id)).toBe(false);
  expect((await f.db.query('SELECT standard_json FROM digital_order_time_standards WHERE standard_id=$1',[chosen.id])).rows[0].standard_json).toEqual(chosen.standard);
  expect((await new OrderTimePlanRepository(f.db).current({kind:'order',id:order.productionOrderId}))?.input.plan.company).toEqual(chosen.standard);
  await expect(service.use(f.root,{expectedVersion:used.record.version,id:chosen.id},randomUUID())).rejects.toMatchObject({statusCode:404});
  await expect(service.remove(f.root,{expectedVersion:used.record.version,id:used.record.id},randomUUID())).rejects.toMatchObject({statusCode:409});
 });
 it('shows exact missing old counterparts, refuses activating a partial history and deletes only its selectable entry',async()=>{
  const history=await service.history(f.root),cycle=history.items.find(row=>row.kind==='legacy_development')!,state=await service.read(f.root);
  expect(cycle).toMatchObject({id:'1',partial:true});expect(cycle.standard.nodes.development_cycle_normal?.minutes).toBe(7*1440);expect(cycle.standard.nodes.development_pattern?.minutes).toBeNull();
  expect(cycle.missing).toEqual(['当时的节点时效','当时的规划日历']);
  await expect(service.use(f.root,{id:cycle.id,kind:cycle.kind,expectedVersion:state.version},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await service.read(f.root)).record).toEqual(state.record);
  await service.remove(f.root,{id:cycle.id,kind:cycle.kind,expectedVersion:state.version},randomUUID());
  expect((await f.db.query('SELECT values_json FROM digital_development_cycle_standards WHERE version=1')).rows[0].values_json.normalDays).toBe(7);
  expect((await service.history(f.root)).items.some(row=>row.kind===cycle.kind&&row.id===cycle.id)).toBe(false);
 });
 it('keeps old unified and paired settings in the same paginated history with their own saved counterparts',async()=>{
  const db=await f.db.connect();let partialId='',setId='';
  try{await db.query('BEGIN');await assertSlaSettingsActor(db,f.root,true);const repo=new SlaConfigurationRepository(db),current=await repo.current(),values=await repo.bootstrapValues();
   const first=await repo.publish({expectedVersion:current?.version??0,values,actorId:f.root.actorId,reason:'TEST historical one-side standard',requestKey:randomUUID()});partialId=first.configurationId;
   const changed=structuredClone(values);changed.development_pattern={kind:'duration',minutes:360};
   await repo.publish({expectedVersion:first.version,values:changed,actorId:f.root.actorId,reason:'TEST historical actual pair',requestKey:randomUUID()});
   const set=await appendCurrentSettingsSet(db,f.root.actorId,randomUUID(),{reason:'TEST exact old pair',planning:{development_pattern:{minutes:480,calendar:'beijing_sunday_excluded'}}});setId=set!.setId;await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  const history=await service.history(f.root),partial=history.items.find(row=>row.kind==='legacy_unified'&&row.id===partialId)!,pair=history.items.find(row=>row.kind==='legacy_set'&&row.id===setId)!;
  expect(partial.partial).toBe(true);expect(partial.standard.nodes.development_cycle_normal?.minutes).toBeNull();
  expect(pair.partial).toBe(false);expect(pair.standard.nodes.development_cycle_normal?.minutes).toBe(7*1440);expect(pair.standard.nodes.development_pattern).toMatchObject({minutes:360,calendar:'beijing_sunday_excluded'});
  const state=await service.read(f.root),used=await service.use(f.root,{id:pair.id,kind:pair.kind,expectedVersion:state.version},randomUUID());
  expect(used.record.standard.nodes.development_pattern).toEqual(pair.standard.nodes.development_pattern);
  await service.remove(f.root,{id:pair.id,kind:pair.kind,expectedVersion:used.record.version},randomUUID());
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_timeline_standard_versions WHERE standard_id=$1',[pair.id])).rows[0].n).toBe(1);
 });
 it('keeps the original management roles and rechecks actual role withdrawal in the same actor context',async()=>{
  const {actor:pmc}=await r5RoleFixture(f.db,f.access,f.root,'pmc'),state=await service.read(f.root);
  await expect(service.read(pmc)).resolves.toMatchObject({version:state.version});
  await expect(service.save(pmc,{expectedVersion:state.version,values:state.current},randomUUID())).rejects.toMatchObject({statusCode:403});
  // This schema's native seeder creates its sole manager for this suite only;
  // the real role is singleton, so do not grant a second one or relax its guard.
  const manager=f.people['production-management']!,assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[manager.actorId])).rows[0].assignment_id;
  await f.access.revokeRole(f.root,assignment,'TEST withdraw original time settings role');
  await expect(service.save(manager,{expectedVersion:state.version,values:state.current},randomUUID())).rejects.toMatchObject({statusCode:403});
 });
});
