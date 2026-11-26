import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {admittedOrderFixture} from '../helpers/order-time-rewash-fixture.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {productionReadinessFixture} from '../helpers/production-readiness-fixture.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('native instruction publication and advisory forecast',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 let legacy:{orderId:string;sourceId:string;scene:string};
 beforeAll(async()=>{
  h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-instruction-forecast-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true});
  const f=h.f,scene=await f.scene('2026-11-17T08:00:00.000Z'),stop=Error('TEST stop after real legacy draft and preparation are ready');
  await f.runtime.run(scene,f.root,async()=>{
   await expect(f.bulkReady('无',undefined,1,f.sourcing,{beforeInstructionPublish:async orderId=>{
    const draft=await new ProductionInstructionService(f.db,true).read(f.people.merchandiser!,orderId);
    expect(draft.publishedVersion).toBeNull();legacy={orderId,sourceId:draft.order.sourceId!,scene};throw stop;
   }})).rejects.toBe(stop);
  });
  await new OrderTimeSettingsService(f.db,true,false).save(f.root,{expectedVersion:0,values:r5OneHourConfiguration()},randomUUID());
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});

 const service=()=>new ProductionInstructionService(h.f.db,true);
 const snapshot=async(orderId:string,sourceId:string)=>{
  const db=h.f.db;
  return (await db.query(`SELECT
   (SELECT coalesce(jsonb_agg(d ORDER BY d.revision),'[]') FROM digital_order_time_plan_versions d WHERE production_order_id=$1 OR source_id=$2) AS plans,
   (SELECT coalesce(jsonb_agg(s ORDER BY s.resource_kind),'[]') FROM digital_order_time_subjects s WHERE production_order_id=$1 OR source_id=$2) AS subjects,
   (SELECT coalesce(jsonb_agg(w ORDER BY w.kind,w.epoch),'[]') FROM digital_preparation_windows w WHERE production_order_id=$1) AS windows,
   (SELECT coalesce(jsonb_agg(d ORDER BY d.revision_id),'[]') FROM digital_production_deadline_revisions d WHERE d.task_id IN
     (SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_ship_sample')) AS ship_sample,
   (SELECT count(*)::int FROM audit_events WHERE (entity_id=$1::text OR entity_id=$2::text) AND action='order_time_activated') AS activations,
   (SELECT published_version FROM digital_instruction_documents WHERE production_order_id=$1) AS published,
   (SELECT count(*)::int FROM digital_instruction_versions WHERE production_order_id=$1) AS version_count,
   (SELECT count(*)::int FROM digital_instruction_preparation_bases WHERE production_order_id=$1) AS bases,
   (SELECT count(*)::int FROM digital_preparation_instruction_events WHERE production_order_id=$1 AND kind='published') AS recorded,
   (SELECT count(*)::int FROM digital_instruction_notices n JOIN digital_production_notification_events e USING(event_id) WHERE e.instruction_order_id=$1) AS notices,
   (SELECT count(*)::int FROM digital_bulk_preparations WHERE production_order_id=$1) AS preparations,
   (SELECT count(*)::int FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_pattern') AS patterns,
   (SELECT count(*)::int FROM digital_production_commands WHERE command=$3) AS receipts,
   (SELECT count(*)::int FROM digital_instruction_attachment_bindings WHERE production_order_id=$1) AS bindings,
   (SELECT count(*)::int FROM audit_events WHERE entity_id=$1::text AND entity_type='digital_instruction' AND action='publish') AS audit`,[orderId,sourceId,`instruction:${orderId}:publish`])).rows[0];
 };
 const modern=async(ready=true,commonCustomerDate?:string)=>{
  const f=h.f,item=await admittedOrderFixture(f,commonCustomerDate?{commonCustomerDate}:undefined);
  return f.runtime.run(item.scene,f.root,async()=>{
   const current=await service().read(f.people.merchandiser!,item.orderId);
   await service().save(f.people.merchandiser!,item.orderId,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,
    sourceRound:current.sourceRound,document:{...current.document,styleName:'TEST original forecast',category:'上衣',date:'2026-11-17',preshrink:'无需预缩',secondaryCraft:'无',craftSteps:[]}},randomUUID());
   if(ready)await productionReadinessFixture(f.db,f.root,item.orderId,f.people['pattern-room-worker']!.actorId,f.people.warehouse!);
   return item;
  });
 };
 const request=async(item:typeof legacy)=>{
  const f=h.f,main=f.people.merchandiser!;
  return f.runtime.run(item.scene,f.root,async()=>{
   const draft=await service().read(main,item.orderId);
   return {kind:'instruction_publish' as const,orderId:item.orderId,input:{expectedVersion:draft.version,orderVersion:draft.currentOrderVersion,
    ...(draft.readiness?{expectedReadinessRevision:draft.readiness.revision}:{})}};
  });
 };
 it.each([false,true])('publishes true forecast unknown through original instruction with prior plan=%s',async(withPlan)=>{
  const f=h.f,item=withPlan?await modern():legacy,main=f.people.merchandiser!;
  const operation=await request(item);
  await f.advance(item.scene,'2026-11-20T08:00:00.000Z');
  const check=await f.runtime.run(item.scene,f.root,()=>h.orderTimeRequests!.check(main,operation));
  expect(check.feasibility,JSON.stringify({coverage:check.coverage,quality:check.forecastQuality})).toBe('unknown');
  const prior=await snapshot(item.orderId,item.sourceId),repo=new OrderTimePlanRepository(f.db);
  expect(Boolean(await repo.current({kind:'order',id:item.orderId}))).toBe(withPlan);
  await f.runtime.run(item.scene,f.root,async()=>{
   await expect(service().publish(main,item.orderId,{...operation.input,expectedReadinessRevision:'TEST-stale'},randomUUID())).rejects.toMatchObject({code:'INSTRUCTION_CONFLICT'});
   expect(await snapshot(item.orderId,item.sourceId)).toEqual(prior);
  });
  h.setCollectionScene(item.scene);
  const path=`/api/digital-production/orders/${item.orderId}/instruction/publish`,tab=await h.open(main.actorId,1165,{},`/ui/digital-production?instruction=${item.orderId}`);
  try{
   const publish=tab.page.getByRole('button',{name:'发布有效制单',exact:true});
   const forecast='**/api/digital-production/order-time/check';
   if(withPlan){
    await tab.page.route(forecast,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'TEST forecast transport unavailable'})}),{times:1});
    await publish.click();
    await tab.page.getByRole('alert').filter({hasText:'时效检查未返回，尚未提交'}).waitFor();
    expect(h.requests.filter(r=>r.session===tab.session&&r.path===path&&r.method==='POST')).toHaveLength(0);
    await tab.page.route(forecast,async route=>{
     const response=await route.fetch(),body=await response.json();
     expect(body.feasibility).toBe('unknown');
     await route.fulfill({response,json:{...body,feasibility:'insufficient',requiredMinutes:121,availableMinutes:120,lateMinutes:1}});
    },{times:1});
   }
   const send=tab.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
   await publish.click();const response=await send;expect(response.status(),await response.text()).toBe(200);
   const key=response.request().headers()['idempotency-key']!,saved=await response.json();
   expect(saved.publishedVersion).toBe(operation.input.expectedVersion);
   if(!withPlan)await tab.page.getByText(/发布前预查：本单时效暂无法确认/).waitFor();
   expect(h.requests.filter(r=>r.session===tab.session&&r.path===path&&r.method==='POST')).toHaveLength(1);
   const result=await snapshot(item.orderId,item.sourceId);
   expect(result).toMatchObject({plans:prior.plans,subjects:prior.subjects,windows:prior.windows,ship_sample:prior.ship_sample,activations:prior.activations,
    published:operation.input.expectedVersion,version_count:1,bases:1,recorded:1,receipts:1,audit:1});
   expect(result.preparations).toBeGreaterThan(prior.preparations);expect(result.patterns).toBeGreaterThan(prior.patterns);
   const replay=await tab.context.request.post(h.base+path,{headers:{'idempotency-key':key},data:operation.input});
   expect(replay.status()).toBe(200);expect((await replay.json()).publishedVersion).toBe(saved.publishedVersion);
   expect(await snapshot(item.orderId,item.sourceId)).toEqual(result);
   const journey=await f.runtime.run(item.scene,f.root,()=>new DigitalJourneyQuery(f.db).read(f.root,item.orderId,undefined,true));
   expect(journey.actionableTodo?.items.some(row=>row.category==='instruction_publish')).not.toBe(true);
  }finally{await tab.close();}
 });
 it('returns the original readiness and authorization failures without writing when an advisory forecast is unknown',async()=>{
  const f=h.f,item=await modern(false),main=f.people.merchandiser!,operation=await request(item);
  await f.advance(item.scene,'2026-11-20T08:00:00.000Z');
  const prior=await snapshot(item.orderId,item.sourceId),path=`/api/digital-production/orders/${item.orderId}/instruction/publish`;
  h.setCollectionScene(item.scene);
  const tab=await h.open(main.actorId,1165,{},`/ui/digital-production?instruction=${item.orderId}`);
  try{
   const publish=tab.page.getByRole('button',{name:'发布有效制单',exact:true});
   const send=tab.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
   await publish.click();const response=await send;
   expect(response.status()).toBe(409);
   expect(await response.text()).toMatch(/面料|验布|产前/);
   expect(await snapshot(item.orderId,item.sourceId)).toEqual(prior);
  }finally{await tab.close();}
  const qc=await h.open(f.people.qc!.actorId,1165,{},`/ui/digital-production?instruction=${item.orderId}`);
  try{
   const denied=await qc.context.request.post(h.base+path,{headers:{'idempotency-key':randomUUID()},data:operation.input});
   // QC cannot see this pre-production order. The original scope guard conceals it.
   expect(denied.status()).toBe(404);
   expect((await denied.json()).error.message).toMatch(/不存在|无权/);
   expect(await snapshot(item.orderId,item.sourceId)).toEqual(prior);
  }finally{await qc.close();}
 });
 it('rolls the actual unknown publication back if downstream task synchronization fails and retries the same command',async()=>{
  const f=h.f,item=await modern(),main=f.people.merchandiser!,operation=await request(item),key=randomUUID();
  await f.advance(item.scene,'2026-11-20T08:00:00.000Z');
  await f.runtime.run(item.scene,f.root,async()=>{
   const check=await h.orderTimeRequests!.check(main,operation);
   expect(check.feasibility).toBe('unknown');
   const prior=await snapshot(item.orderId,item.sourceId);
   await f.db.query(`CREATE FUNCTION test_forecast_sync_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.production_order_id::text = TG_ARGV[0] THEN
      IF NOT EXISTS(SELECT 1 FROM digital_instruction_versions WHERE production_order_id=NEW.production_order_id) THEN
        RAISE EXCEPTION 'TEST expected a staged native publication version';
      END IF;
      RAISE EXCEPTION 'TEST downstream preparation synchronization failed';
    END IF; RETURN NEW; END $$`);
   const trigger=await f.db.query(`SELECT format('CREATE TRIGGER test_forecast_sync_failure BEFORE INSERT ON digital_bulk_preparations FOR EACH ROW EXECUTE FUNCTION test_forecast_sync_failure(%L)', $1::text) AS sql`,[item.orderId]);
   await f.db.query(trigger.rows[0].sql);
   try{
    await expect(service().publish(main,item.orderId,operation.input,key)).rejects.toThrow('TEST downstream preparation synchronization failed');
    expect(await snapshot(item.orderId,item.sourceId)).toEqual(prior);
   }finally{await f.db.query('DROP TRIGGER test_forecast_sync_failure ON digital_bulk_preparations');await f.db.query('DROP FUNCTION test_forecast_sync_failure()');}
   expect((await service().publish(main,item.orderId,operation.input,key)).publishedVersion).toBe(operation.input.expectedVersion);
   expect(await snapshot(item.orderId,item.sourceId)).toMatchObject({published:operation.input.expectedVersion,version_count:1,recorded:1,receipts:1,audit:1,activations:prior.activations});
  });
 });
 it('lets the server reject proven shortage after a stale sufficient preview and keeps the original design handoff',async()=>{
  const f=h.f,settings=new OrderTimeSettingsService(f.db,true,false),previous=await settings.read(f.root),values=r5OneHourConfiguration();
  values.nodes.bulk_printing={kind:'work',minutes:2880,calendar:'continuous',reminder:{enabled:true,percent:70}};
  await settings.save(f.root,{expectedVersion:previous.version,values},randomUUID());
  const item=await modern(true,'2026-11-18'),main=f.people.merchandiser!,first=await request(item);
  const operation=await f.runtime.run(item.scene,f.root,async()=>{
   const ordinary=await h.orderTimeRequests!.check(main,first);
   expect(ordinary.feasibility,JSON.stringify(ordinary.coverage)).toBe('sufficient');
   await service().publish(main,item.orderId,first.input,randomUUID());
   const saved=await service().read(main,item.orderId);
   await service().save(main,item.orderId,{expectedVersion:saved.version,orderVersion:saved.currentOrderVersion,
    document:{...saved.document,secondaryCraft:'印花',craftSteps:[{craftKind:'printing',sequence:1}]}},randomUUID());
   return request(item);
  });
  const check=await f.runtime.run(item.scene,f.root,()=>h.orderTimeRequests!.check(main,operation));
  expect(check.feasibility,JSON.stringify(check.coverage)).toBe('insufficient');
  expect(check.canRequest).toBe(false);
  const before=await snapshot(item.orderId,item.sourceId),path=`/api/digital-production/orders/${item.orderId}/instruction/publish`;
  h.setCollectionScene(item.scene);
  const tab=await h.open(main.actorId,1165,{},`/ui/digital-production?instruction=${item.orderId}`);
  try{
   await tab.page.route('**/api/digital-production/order-time/check',async route=>{
    const response=await route.fetch(),body=await response.json();
    expect(body.feasibility).toBe('insufficient');
    await route.fulfill({response,json:{...body,feasibility:'sufficient',lateMinutes:0}});
   },{times:1});
   const sentForDesigner=tab.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/digital-production/order-time/requests');
   const send=tab.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
   await tab.page.getByRole('button',{name:'发布有效制单',exact:true}).click();
   const response=await send;expect(response.status()).toBe(409);
   expect((await response.json()).error.code).toBe('ORDER_TIME_REQUEST_REQUIRED');
   const handoff=await sentForDesigner;expect(handoff.ok()).toBe(true);
   await tab.page.waitForURL(url=>url.searchParams.has('timeRequest'));
   const handoffId=new URL(tab.page.url()).searchParams.get('timeRequest');
   const routed=(await f.db.query("SELECT request_id,state FROM digital_order_time_requests WHERE operation_json->>'kind'='instruction_publish' AND operation_json->>'orderId'=$1",[item.orderId])).rows;
   expect(routed).toEqual([{request_id:handoffId,state:'needs_designer'}]);
   expect(await snapshot(item.orderId,item.sourceId)).toEqual(before);
  }finally{await tab.close();}
 });
});
