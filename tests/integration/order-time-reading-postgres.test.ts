import {PoCustomerDateService} from '../../apps/api/src/production-platform/po-customer-date-service.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {randomUUID} from 'node:crypto';
import {Client,type PoolClient} from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {reviseOrderTimePlan,type OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {OrderTimePlanRepository,type OrderTimeInput} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JourneyFactUpdates} from '../../apps/api/src/production-platform/journey-fact-updates.js';
import {JOURNEY_FACT_CALCULATION_VERSION} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {historicalOrderTimeCompany} from '../../apps/api/src/production-platform/order-time-admission.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const duration=(minutes:number):OrderTimeRule=>({kind:'work',minutes,calendar:'continuous',reminder:{enabled:true,percent:70}});
(url?describe.sequential:describe.skip)('R5 stored order-time reading, actual authorized RR and bounded model updates',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,scene:string;
 const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
 const tx=async<T,>(action:(db:PoolClient)=>Promise<T>)=>{const db=await f.db.connect();try{await db.query('BEGIN');const result=await action(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
 const make=()=>new DigitalProductionIdentityService(f.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-R506-'+randomUUID(),orderDate:'2026-11-11',primaryMerchandiserId:f.people.merchandiser!.actorId,
  lines:[0,1].map(index=>({formalPoNo:'TEST-R506-'+randomUUID(),color:index?'白':'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}))}),randomUUID());
 // Explicit focused input tests the reader before production preparation. It
 // is not the R5-07 full native first-adoption/route selection implementation.
 const input=(order:Awaited<ReturnType<typeof make>>):OrderTimeInput=>({version:'order-time-input-v1',plan:{version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST explicit original counterpart',revision:1,stageBufferMinutes:0,nodes:{order_creation:{kind:'event',minutes:0,calendar:'continuous',reminder:{enabled:false,percent:70}},garment_packing:duration(240)}}},route:{complete:true,missing:[]},
  work:[{id:'order_creation',parameterKey:'order_creation',stage:1,dependsOn:[]},...order.lines.map(line=>({id:'garment_packing:'+line.lineId,parameterKey:'garment_packing',stage:7,dependsOn:['order_creation']}))],
  scopes:order.lines.map(line=>({scopeRef:'po:'+line.lineId,lineId:line.lineId,terminalIds:['garment_packing:'+line.lineId],customerGoalIds:['garment_packing:'+line.lineId],customerGoal:{precision:'date',value:'2027-03-01',source:'TEST actual PO customer date'},goals:{['garment_packing:'+line.lineId]:{precision:'date',value:'2027-03-01',source:'TEST actual PO customer date'}}}))});
 const confirm=(order:Awaited<ReturnType<typeof make>>,value:OrderTimeInput,expectedRevision=0)=>tx(async db=>new OrderTimePlanRepository(db).confirm({resource:{kind:'order',id:order.productionOrderId},value,expectedRevision,actorId:f.root.actorId,eventRef:'TEST explicit original confirmed arrangement',requestKey:randomUUID(),time:await new ContextBusinessClock(f.db,db).read({kind:'order',id:order.productionOrderId})}));
 beforeAll(async()=>{f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-11T08:00:00.000Z');expect((await f.db.query("SELECT current_setting('is_superuser') AS value")).rows[0].value).toBe('off');});
 afterAll(async()=>{await f?.dispose();});
 it('returns both correct known PO targets before preparation through plain and cockpit reads without adopting or writing in GET',()=>run(async()=>{
  const order=await make(),saved=await confirm(order,input(order)),query=new DigitalJourneyQuery(f.db);
  const before=(await f.db.query('SELECT count(*)::int n FROM digital_order_time_plan_versions')).rows[0].n;
  const plain=await query.read(f.root,order.productionOrderId),cockpit=await query.read(f.root,order.productionOrderId,undefined,true);
  expect(plain.fixedSchedule).toEqual(cockpit.fixedSchedule);expect(cockpit.fixedSchedule!.observationMode).toBe('fixed');
  expect(cockpit.fixedSchedule!.durationSummary).toMatchObject({planStart:'2027-03-01T12:00:00.000Z',planEnd:'2027-03-01T16:00:00.000Z',planSpanMinutes:240,actualStart:{precision:'instant',at:'2026-11-11T08:00:00.000Z'},deliveryCompletedAt:{precision:'unknown'},finalActualSpanMinutes:null});
  for(const scope of cockpit.fixedSchedule!.scopes){expect(scope.targetRevision).toBe(saved.id+':1');expect(scope.nodes.find(node=>node.id.startsWith('garment_packing:'))!.goalDelta).toMatchObject({targetAt:'2027-03-01T16:00:00.000Z',targetPrecision:'date',targetDate:'2027-03-01',actual:{precision:'unknown'}});}
  expect((await f.db.query('SELECT count(*)::int n FROM digital_order_time_plan_versions')).rows[0].n).toBe(before);
  expect((await f.db.query('SELECT count(*)::int n FROM digital_timeline_adoptions WHERE production_order_id=$1',[order.productionOrderId])).rows[0].n).toBe(0);
  expect((await f.db.query('SELECT count(*)::int n FROM digital_bulk_preparations WHERE production_order_id=$1',[order.productionOrderId])).rows[0].n).toBe(0);
  for(const key of ['process_logistics','bulk_qc'])expect(cockpit.stages.flatMap(stage=>stage.nodes).find(node=>node.key===key)).toMatchObject({state:'not_applicable',countsInProgress:false,risks:[]});
  await expect(query.read(f.people['pattern-room-worker']!,order.productionOrderId,undefined,true)).rejects.toMatchObject({statusCode:404});
 }));
 it('Acceptance PR02 limits requested and approved date notification context to the changed PO and preserves the other date',()=>run(async()=>{
  const order=await make(),red=order.lines[0]!,blue=order.lines[1]!,dates=new PoCustomerDateService(f.db),notifications=new DigitalProductionNotificationService(f.db);
  const requested=await dates.request(f.root,order.productionOrderId,{orderVersion:order.version,reason:'TEST only red PO changes',changes:[{lineId:red.lineId,expectedVersion:red.customerDateVersion??0,date:'2027-03-03'}]},randomUUID());
  const check=async(key:string,recipient=f.people['production-management']!)=>{
   const event=(await f.db.query('SELECT event_id FROM digital_production_notification_events WHERE source_key=$1',[key])).rows[0];expect(event).toBeTruthy();
   for(let i=0;i<100;i++){const shown=await notifications.claim(recipient);if(!shown.notification||shown.notification.eventId===event.event_id)break;}
   const notice=await notifications.current(recipient,event.event_id);expect(notice.notification?.context).toMatchObject({poNumbers:[red.poNumber],colors:[red.color]});
   expect((await notifications.current(f.people['pattern-room-worker']!,event.event_id)).notification).toBeNull();
  };
  await check('po-customer-request:'+requested.requestId);
  await dates.decide(f.root,order.productionOrderId,requested.requestId,true,randomUUID());
  await check('po-customer-decision:'+requested.requestId);
  const current=await new DigitalProductionIdentityService(f.db,true).read(f.root,order.productionOrderId);
  expect(current.lines.find(line=>line.lineId===red.lineId)!.customerWarehouseArrivalDate).toBe('2027-03-03');
  expect(current.lines.find(line=>line.lineId===blue.lineId)!.customerWarehouseArrivalDate).toBe('2027-03-01');
 }));
 it('stores only the exact new factual basis with no actor DTO and switches freshness after the same-transaction dirty registration',()=>run(async()=>{
  const order=await make(),saved=await confirm(order,input(order)),resource={kind:'order' as const,id:order.productionOrderId},repo=new JourneyFactRepository(f.db);
  const first=await repo.buildOne(resource);expect(first.model.fixedSchedule?.policyVersion).toBe('order-time-plan-v1');expect(first.model.fixedSchedule?.scopes).toHaveLength(2);expect(first.model.fixedSchedule?.notApplicableNodes).toEqual(['process_logistics','bulk_qc']);
  for(const privateKey of ['authorizationCapabilities','actorRoles','company','overrides','styleImageUrl'])expect(JSON.stringify(first.model.fixedSchedule)).not.toContain('"'+privateKey+'"');
  const changed=structuredClone(saved.input);changed.plan=reviseOrderTimePlan(changed.plan,{garment_packing:duration(120)});await confirm(order,changed,1);
  const read=await f.db.connect();try{const state=await repo.readStoredWithClient(read,resource);expect(state.status).toBe('pending');}finally{read.release();}
  const rebuilt=await repo.buildOne(resource);expect(rebuilt.model.fixedSchedule!.scopeRevision).not.toBe(first.model.fixedSchedule!.scopeRevision);
  expect(rebuilt.model.fixedSchedule!.scopes[0]!.work.find(work=>work.id.startsWith('garment_packing:'))!.minutes).toBe(120);
  expect(rebuilt.model.fixedSchedule!.scopes[0]!.work.find(work=>work.id.startsWith('garment_packing:'))!.end).toBe('2027-03-01T16:00:00.000Z');
  expect((await f.db.query('SELECT calculation_version FROM digital_journey_fact_models WHERE resource_id=$1',[order.productionOrderId])).rows[0].calculation_version).toBe(JOURNEY_FACT_CALCULATION_VERSION);
 }));
 it('keeps one actual RR snapshot across a competing confirmed version and sees the next version on the next request',()=>run(async()=>{
  const order=await make(),original=await confirm(order,input(order)),resource={kind:'order' as const,id:order.productionOrderId},read=await f.db.connect();
  try{await read.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const first=await new OrderTimePlanRepository(read).current(resource);expect(first!.revision).toBe(1);
   const changed=structuredClone(original.input);changed.plan=reviseOrderTimePlan(changed.plan,{garment_packing:duration(120)});await confirm(order,changed,1);
   expect((await new OrderTimePlanRepository(read).current(resource))!.revision).toBe(1);await read.query('COMMIT');
   expect((await new OrderTimePlanRepository(read).current(resource))!.revision).toBe(2);
  }catch(error){await read.query('ROLLBACK');throw error;}finally{read.release();}
 }));
 it('keeps complete authorized list counts and current15 assembly with new factual storage; ordinary reads never build a mother',()=>run(async()=>{
  const order=await make();await confirm(order,input(order));await new JourneyFactRepository(f.db).buildOne({kind:'order',id:order.productionOrderId});
  const build=vi.spyOn(JourneyFactRepository.prototype,'buildOne'),query=new DigitalJourneyQuery(f.db),filter=JourneyFilterSchema.parse({scope:'production',search:order.designStyleNo});
  try{const result=await query.list(f.root,filter);expect(result.total).toBe(1);expect(result.items).toHaveLength(1);expect(result.items[0]!.id).toBe(order.productionOrderId);for(const key of ['process_logistics','bulk_qc'])expect(result.items[0]!.stages.flatMap(stage=>stage.nodes).find(node=>node.key===key)).toMatchObject({state:'not_applicable',risks:[]});expect(build).not.toHaveBeenCalled();}finally{build.mockRestore();}
  const result=await new JourneyFactUpdates(f.db).runOnce();expect(result.failed).toBe(0);
 }));
 it('keeps an old order first adopted by an explicit arrangement visible to its order-only technical reader',()=>run(async()=>{
  const old=await f.bulkReady('无'),order=await new DigitalProductionIdentityService(f.db,true).read(f.root,old.id);
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_order_time_subjects WHERE production_order_id=$1',[old.id])).rows[0].n).toBe(0);
  // Focused historical-storage fixture: the exact audit → immutable plan →
  // managed marker written by arrange(). No native creation is fabricated.
  // Feasibility/arrange UI is covered by its own original-command suite.
  await tx(async db=>{const eventId=randomUUID(),value=input(order);await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'order_time_arranged','digital_production',$4,$5)",[eventId,'TEST historical first arrangement',f.root.actorId,old.id,JSON.stringify({plan:value.plan})]);
   await new OrderTimePlanRepository(db).confirm({resource:{kind:'order',id:old.id},expectedRevision:0,value,actorId:f.root.actorId,eventRef:'audit_events:'+eventId,time:await new ContextBusinessClock(f.db,db).read({kind:'order',id:old.id}),requestKey:randomUUID()});await db.query('UPDATE digital_production_orders SET order_time_managed=true WHERE production_order_id=$1',[old.id]);});
  const actor=f.people['development-clerk']!,policy=new DigitalProductionAccessPolicy(f.db);expect(await policy.allowed(actor,'order',old.id,'technical')).toBe(true);expect(await policy.allowed(actor,'source',old.sourceId,'technical')).toBe(false);
  await new JourneyFactRepository(f.db).buildOne({kind:'order',id:old.id});const query=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),result=await query.list(actor,JourneyFilterSchema.parse({scope:'production',search:order.designStyleNo}));
  expect(result.total).toBe(1);expect(result.items.map(item=>item.orderId)).toContain(old.id);expect(result.freshness).toBeUndefined();expect(result.summary).not.toBeNull();expect(result.items[0]!.createdAt).toBe((await f.db.query('SELECT created_at FROM digital_production_orders WHERE production_order_id=$1',[old.id])).rows[0].created_at.toISOString());
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_order_time_subjects WHERE production_order_id=$1',[old.id])).rows[0].n).toBe(0);
 }));

 it('retains the source completion target across later native conversion into two POs and persisted fact reads',async()=>{
  const ownScene=await f.scene('2026-11-21T08:00:00.000Z'),ownRun=<T,>(action:()=>Promise<T>)=>f.runtime.run(ownScene,f.root,action);
  let sourcePlan:Awaited<ReturnType<OrderTimePlanRepository['confirm']>>|undefined;
  const made=await ownRun(()=>exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,new ContextBusinessClock(f.db),[['无','免洗']],{
   fixedCraftSteps:[],onRouteComplete:async(sourceId,kind)=>{
    if(kind!=='development_sewing')return;
    const resource={kind:'source' as const,id:sourceId},workId='development_confirmation',goal={precision:'instant' as const,value:'2026-11-21T09:00:00.000Z',source:'TEST confirmed source target before real completion'};
    const company=await historicalOrderTimeCompany(f.db,resource),complete=r5OneHourConfiguration();
    // Preserve every already captured native quota; supply only this focused
    // fixture's missing future planning inputs before native conversion.
    for(const [key,rule]of Object.entries(company.nodes))if(rule.minutes===null&&complete.nodes[key]?.minutes!==null)company.nodes[key]=complete.nodes[key]!;
    const value:OrderTimeInput={version:'order-time-input-v1',plan:{version:'order-time-plan-v1',revision:1,overrides:{},company},route:{complete:true,missing:[]},
     work:[{id:workId,parameterKey:workId,canonicalWorkRef:`source:${sourceId}:round:1:work:${workId}`,stage:2,dependsOn:[]}],
     scopes:[{scopeRef:`source:${sourceId}:round:1`,lineId:null,terminalIds:[workId],customerGoalIds:[],customerGoal:goal,goals:{[workId]:goal}}]};
    sourcePlan=await tx(async db=>new OrderTimePlanRepository(db).confirm({resource,value,expectedRevision:0,actorId:f.root.actorId,eventRef:'TEST arrangement before original confirmation',requestKey:randomUUID(),time:await new ContextBusinessClock(f.db,db).read(resource)}));
   },
  }));
  const sourceId=made[0]!.sourceId;
  const task=(await f.db.query("SELECT t.completed_at FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_confirmation' AND t.route_version=1",[sourceId])).rows[0];
  expect(task.completed_at.toISOString()).toBe('2026-11-21T08:00:00.000Z');
  await f.advance(ownScene,'2026-11-22T08:00:00.000Z');
  await ownRun(async()=>{
   const source=(await f.db.query('SELECT design_style_no,temporary_style_no FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0];
   const order=await new DigitalProductionIdentityService(f.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:source.design_style_no,temporaryStyleNo:source.temporary_style_no,orderDate:'2026-11-22',primaryMerchandiserId:f.people.merchandiser!.actorId,productionPlanning:{craftSteps:[],preshrink:false},
    lines:[0,1].map(index=>({formalPoNo:'TEST-INHERITED-'+randomUUID(),color:index?'白':'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}))}),randomUUID(),sourceId);
   const sharedId='source:development_confirmation',resource={kind:'order' as const,id:order.productionOrderId},query=new DigitalJourneyQuery(f.db);
   const saved=(await new OrderTimePlanRepository(f.db).current(resource))!;
   expect(Date.parse(saved.time.now)).toBeGreaterThan(task.completed_at.getTime());
   const before=(await f.db.query('SELECT count(*)::int n FROM digital_order_time_plan_versions')).rows[0].n;
   const check=(detail:Awaited<ReturnType<DigitalJourneyQuery['read']>>)=>{
    expect(detail.fixedSchedule!.scopes).toHaveLength(2);
    for(const scope of detail.fixedSchedule!.scopes){
     expect(scope.nodes.find(node=>node.id===sharedId)).toMatchObject({businessCompleted:true,goalDelta:{targetAt:'2026-11-21T09:00:00.000Z',targetRevision:sourcePlan!.id+':1',actual:{precision:'instant',at:'2026-11-21T08:00:00.000Z'},signedValue:-60,unit:'minute'}});
    }
   };
   const driver=vi.spyOn(Client.prototype,'query');
   try{
    check(await query.read(f.root,order.productionOrderId,undefined,true));
    const histories=(driver.mock.calls as unknown[][]).flatMap((args,index)=>typeof args[0]==='string'&&args[0].startsWith('SELECT plan_version_id,input_snapshot,business_time,fixed_targets,revision,identity_hash')?[{params:args[1],client:driver.mock.instances[index]}]:[]);
    const sourceReads=histories.filter(row=>JSON.stringify(row.params)===JSON.stringify(['source',sourceId]));
    const orderReads=histories.filter(row=>JSON.stringify(row.params)===JSON.stringify(['order',order.productionOrderId]));
    expect(sourceReads).toHaveLength(1);expect(orderReads).toHaveLength(1);expect(sourceReads[0]!.client).toBe(orderReads[0]!.client);
   }finally{driver.mockRestore();}
   const built=await new JourneyFactRepository(f.db).buildOne(resource);
   for(const scope of built.model.fixedSchedule!.scopes)expect(scope.work.find(work=>work.id===sharedId)!.completionTarget).toMatchObject({end:'2026-11-21T09:00:00.000Z',targetRevision:sourcePlan!.id+':1'});
   check(await query.read(f.root,order.productionOrderId,undefined,true));
   expect((await f.db.query('SELECT count(*)::int n FROM digital_order_time_plan_versions')).rows[0].n).toBe(before);
  });
 });
});
