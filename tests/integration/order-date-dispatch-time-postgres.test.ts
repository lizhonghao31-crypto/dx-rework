import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {beijingCalendarDate,minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {AuthService,AuthUser} from '../../apps/api/src/auth/service.js';
import {registerAcceptanceClockHooks} from '../../apps/api/src/acceptance-clock/hooks.js';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('source-scoped customer dates and exact factory dispatch inputs',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);},120000);
 afterAll(async()=>{await f?.dispose();});
 const appFor=(actor:TrustedActorContext)=>{
  const user:AuthUser={id:actor.actorId,displayName:'TEST isolated date input',businessRoles:[...actor.actorRoles],capabilities:[...(actor.authorizationCapabilities??[])]};
  const authenticate=async()=>user,auth={authenticate,listAcceptanceIdentities:async()=>[{userId:user.id,active:true,employed:true}]} as unknown as AuthService;
  const app=Fastify();registerAcceptanceClockHooks(app,f.runtime,auth,undefined);
  registerDigitalIdentityRoutes(app,{authenticate,creationEnabled:true,service:new DigitalProductionIdentityService(f.db,true),factoryFlowService:new FactoryFlowService(f.db),developmentAttachments:f.attachments});
  return app;
 };
 const source=async(scene:string|null)=>{
  const action=async()=>{
   const designer=f.people['sample-designer']!,identity=new DigitalProductionIdentityService(f.db,true),style=`TEST-INPUT-${randomUUID()}`;
   const created=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'inch',sizes:['M'],measurements:[{name:'袖长',values:['6']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:await f.image(designer),kind:'款图'}]});
   const forms=new DigitalDevelopmentService(f.db,true),saved=await forms.save(designer,created.sourceId,{expectedVersion:0,document},randomUUID());
   await forms.publish(designer,created.sourceId,saved.version,randomUUID());
   return {...created,style};
  };
  return scene?f.runtime.run(scene,f.root,action):action();
 };
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: scoped options and original customer confirmation agree; tomorrow is still rejected`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-7:mode==='future'?7:0)*86400000).toISOString(),scene=mode==='ordinary'?null:await f.scene(at),p=await source(scene),app=appFor(f.people['sample-designer']!);
  try{
   const response=await app.inject({url:`/digital-production/options?sourceId=${p.sourceId}`});expect(response.statusCode).toBe(200);
   const calendar=response.json();expect(calendar.serverToday).toBe(beijingCalendarDate(new Date(at)));expect(calendar.minimumInitialCustomerDate).toBe(minimumInitialCustomerDate(new Date(at)));
   const tomorrow=beijingCalendarDate(new Date(Date.parse(`${calendar.serverToday}T00:00:00+08:00`)+86400000));
   const input={customerCode:'PD',productGroup:'男装',designStyleNo:p.style,temporaryStyleNo:null,orderDate:tomorrow,lines:[{formalPoNo:p.style,color:'TEST黑',customerWarehouseArrivalDate:'2028-03-01',sizes:[{size:'M',quantity:10}]}]};
   const endpoint=`/digital-production/sources/${p.sourceId}/confirm`;
   const rejected=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':randomUUID()},payload:input});expect(rejected.statusCode).toBe(400);expect(rejected.json().message).toContain(calendar.serverToday);
   expect((await f.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[p.sourceId])).rowCount).toBe(0);
   const key=randomUUID(),payload={...input,orderDate:calendar.serverToday},created=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':key},payload});
   expect(created.statusCode,created.body).toBe(200);const order=created.json();
   const replay=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':key},payload});expect(replay.statusCode).toBe(200);expect(replay.json().productionOrderId).toBe(order.productionOrderId);
   expect((await f.db.query('SELECT order_date::text AS date FROM digital_production_orders WHERE production_order_id=$1',[order.productionOrderId])).rows[0].date).toBe(calendar.serverToday);
  }finally{await app.close();}
 },60000);
 it('scoped options cross the Beijing midnight by 1ms without changing a saved source or using another scene',async()=>{
  const scene=await f.scene('2026-12-10T15:59:59.999Z'),p=await source(scene),otherScene=await f.scene('2026-12-20T01:00:00.000Z'),ordinary=await source(null),app=appFor(f.people['sample-designer']!);
  const before=(await f.db.query('SELECT to_jsonb(s) AS source FROM digital_production_sources s WHERE source_id=$1',[p.sourceId])).rows[0];
  try{
   const get=()=>app.inject({url:`/digital-production/options?sourceId=${p.sourceId}`});
   expect((await get()).json().serverToday).toBe('2026-12-10');await f.advance(scene,'2026-12-10T16:00:00.000Z');expect((await get()).json().serverToday).toBe('2026-12-11');
   const wall=(await app.inject({url:'/digital-production/options'})).json();expect(wall.serverToday).toBe(beijingCalendarDate());
   for(const path of [`/digital-production/options?sourceId=${p.sourceId}`,`/digital-production/options?sourceId=${ordinary.sourceId}`,'/digital-production/options']){
    const wrong=await app.inject({url:path,headers:{'x-acceptance-scenario':otherScene}});expect(wrong.statusCode).toBe(409);expect(wrong.json().serverToday).toBeUndefined();
   }
   expect((await f.db.query('SELECT to_jsonb(s) AS source FROM digital_production_sources s WHERE source_id=$1',[p.sourceId])).rows[0]).toEqual(before);
  }finally{await app.close();}
 },60000);
 it('source-scoped calendar retains source permission and rejects malformed scope',async()=>{
  const scene=await f.scene('2026-12-10T01:00:00Z'),p=await source(scene),app=appFor(f.people.warehouse!);
  try{
   // The original source policy deliberately hides invisible resources as 404.
   const denied=await app.inject({url:`/digital-production/options?sourceId=${p.sourceId}`});expect(denied.statusCode).toBe(404);expect(denied.json().serverToday).toBeUndefined();
   const invalid=await app.inject({url:'/digital-production/options?sourceId=not-an-id'});expect(invalid.statusCode).toBe(400);
  }finally{await app.close();}
 },60000);
 const cutReady=async(scene:string|null)=>{
  const action=async()=>{
   const p=await f.bulkReady('无'),row=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[p.caseId])).rows[0];
   const actor={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await p.cutting.record(actor,row.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(actor)]},randomUUID());
   return p;
  };
  return scene?f.runtime.run(scene,f.root,action):action();
 };
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: omitted dispatch time is authoritative, once per original key`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-7:mode==='future'?7:0)*86400000).toISOString(),scene=mode==='ordinary'?null:await f.scene(at),p=await cutReady(scene),app=appFor(f.people.warehouse!),flow=new FactoryFlowService(f.db);
  try{
   const state=await flow.read(f.root,p.id),payload={expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST use original order current time'},key=randomUUID(),endpoint=`/digital-production/orders/${p.id}/factory-flow/dispatch`;
   const wallBefore=Date.now(),response=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':key},payload}),wallAfter=Date.now();
   expect(response.statusCode,response.body).toBe(200);const sheet=response.json<FactoryFlowSheet>(),fact=sheet.facts.find(row=>row.kind==='仓库实际发厂')!;expect(fact).toBeDefined();
   if(scene){expect(fact.occurredAt).toBe(at);await f.advance(scene,new Date(Date.parse(at)+60000).toISOString());}else expect(Date.parse(fact.occurredAt!)).toBeGreaterThanOrEqual(wallBefore);
   expect(Date.parse(fact.recordedAt)).toBeGreaterThanOrEqual(wallBefore-1000);expect(Date.parse(fact.recordedAt)).toBeLessThanOrEqual(wallAfter+1000);
   const replay=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':key},payload});expect(replay.statusCode).toBe(200);expect(replay.json<FactoryFlowSheet>().facts.find(row=>row.kind==='仓库实际发厂')!.occurredAt).toBe(fact.occurredAt);
   expect((await f.db.query("SELECT count(*)::int n FROM digital_factory_facts WHERE preparation_id=$1 AND kind='仓库实际发厂'",[p.preparationId])).rows[0].n).toBe(1);
  }finally{await app.close();}
 },60000);
 it('manual millisecond lower/upper bounds remain exact, and failure rolls back before a valid same-key request',async()=>{
  const at='2026-12-10T11:56:17.915Z',scene=await f.scene(at),p=await cutReady(scene),app=appFor(f.people.warehouse!),state=await new FactoryFlowService(f.db).read(f.root,p.id),endpoint=`/digital-production/orders/${p.id}/factory-flow/dispatch`,key=randomUUID();
  const payload={expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST exact boundary'};
  try{
   for(const delta of [-1,1]){const invalid=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':key},payload:{...payload,occurredAt:new Date(Date.parse(at)+delta).toISOString()}});expect(invalid.statusCode,invalid.body).toBe(409);}
   const explicitNull=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':key},payload:{...payload,occurredAt:null}});expect(explicitNull.statusCode).toBe(400);
   const valid=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':key},payload:{...payload,occurredAt:at}});expect(valid.statusCode,valid.body).toBe(200);expect(valid.json<FactoryFlowSheet>().facts.find(row=>row.kind==='仓库实际发厂')!.occurredAt).toBe(at);
  }finally{await app.close();}
 },60000);
 it('manual time strictly after the lower bound and equal to the current upper bound remains valid',async()=>{
  const scene=await f.scene('2026-12-10T11:56:17.915Z'),p=await cutReady(scene),app=appFor(f.people.warehouse!);
  await f.advance(scene,'2026-12-10T11:56:17.916Z');
  try{
   const state=await new FactoryFlowService(f.db).read(f.root,p.id),response=await app.inject({method:'POST',url:`/digital-production/orders/${p.id}/factory-flow/dispatch`,headers:{'idempotency-key':randomUUID()},payload:{expectedRevision:state.revision,supplierId:f.supplierId,occurredAt:'2026-12-10T11:56:17.916Z',note:'TEST after lower and at upper'}});
   expect(response.statusCode,response.body).toBe(200);
  }finally{await app.close();}
 },60000);
 for(const sameKey of [true,false])it(`${sameKey?'same':'distinct'}-key concurrent default dispatch retains role/scope/version guards and one fact`,async()=>{
  const scene=await f.scene('2026-12-10T11:56:17.915Z'),other=await f.scene('2026-12-20T01:00:00Z'),p=await cutReady(scene),app=appFor(f.people.warehouse!),wrongRole=appFor(f.people.merchandiser!);
  try{
   const state=await new FactoryFlowService(f.db).read(f.root,p.id),endpoint=`/digital-production/orders/${p.id}/factory-flow/dispatch`,payload={expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST concurrent default'};
   const mixed=await app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':randomUUID(),'x-acceptance-scenario':other},payload});expect(mixed.statusCode).toBe(409);
   const denied=await wrongRole.inject({method:'POST',url:endpoint,headers:{'idempotency-key':randomUUID()},payload});expect(denied.statusCode).toBe(403);
   const key=randomUUID(),results=await Promise.all([app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':key},payload}),app.inject({method:'POST',url:endpoint,headers:{'idempotency-key':sameKey?key:randomUUID()},payload})]);
   expect(results.map(r=>r.statusCode).sort()).toEqual(sameKey?[200,200]:[200,409]);
   const successful=results.filter(r=>r.statusCode===200).map(r=>r.json<FactoryFlowSheet>().facts.find(fact=>fact.kind==='仓库实际发厂')!);
   expect(new Set(successful.map(fact=>fact.factId)).size).toBe(1);expect(successful[0]!.occurredAt).toBe('2026-12-10T11:56:17.915Z');
   expect((await f.db.query("SELECT count(*)::int n FROM digital_factory_facts WHERE preparation_id=$1 AND kind='仓库实际发厂'",[p.preparationId])).rows[0].n).toBe(1);
  }finally{await app.close();await wrongRole.close();}
 },60000);
});
