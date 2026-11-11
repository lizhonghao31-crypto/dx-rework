import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {PoolClient} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {FixedTimelineAdoptionRepository,type FixedTimelineInput} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
import {SlaOrderApplicationService} from '../../apps/api/src/production-platform/sla-order-application.js';
import {PoCustomerDateService} from '../../apps/api/src/production-platform/po-customer-date-service.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {SlaConfigurationService} from '../../apps/api/src/production-platform/sla-configuration-service.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JourneyFactUpdates} from '../../apps/api/src/production-platform/journey-fact-updates.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {readInitialTimelineInput,freezeInitialTimelineInput} from '../../apps/api/src/production-platform/fixed-timeline-initial-input.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {SourcingProductionService} from '../../apps/api/src/sourcing/sourcing-production-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {productionReadinessFixture,completeBulkRangeFixture} from '../helpers/production-readiness-fixture.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {applyOrderMerchandiserFixture} from '../helpers/order-merchandiser-fixture.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('fixed timeline repository foundation with original native parents (owned PostgreSQL)',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,scene:string;
 const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
 const tx=async<T,>(action:(client:PoolClient)=>Promise<T>)=>{
  const client=await f.db.connect();
  try{await client.query('BEGIN');const result=await action(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 };
 const make=async(poCount=1)=>{
  const identity=new DigitalProductionIdentityService(f.db,true);
  const order=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-FIXED-'+randomUUID(),orderDate:'2026-11-09',primaryMerchandiserId:f.people.merchandiser!.actorId,
   lines:Array.from({length:poCount},(_,index)=>({formalPoNo:'TEST-FIXED-'+randomUUID(),color:index?'白':'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}))}),randomUUID());
  const event=(await f.db.query("SELECT id FROM audit_events WHERE action='digital_order_created' AND entity_id=$1",[order.productionOrderId])).rows[0];
  return {resource:{kind:'order' as const,id:order.productionOrderId},eventRef:`audit_events:${event.id}`,lineId:order.lines[0]!.lineId,lineIds:order.lines.map(line=>line.lineId)};
 };
 const input=async(db:Pick<PoolClient,'query'>,p:Awaited<ReturnType<typeof make>>):Promise<FixedTimelineInput>=>{
  const saved=(await db.query(`SELECT p.*,s.rule_version,s.parameters_json FROM digital_sla_plans p
   JOIN digital_sla_order_snapshots s USING(snapshot_id) WHERE p.production_order_id=$1 ORDER BY p.revision LIMIT 1`,[p.resource.id])).rows[0];
  return {timelineSchemaVersion:2,routeSchemaVersion:2,calculationVersion:'fixed-backward-v1',resource:p.resource,round:1,
   originalPlan:{ref:`digital_sla_plans:${saved.plan_id}`,revision:saved.revision,plan:saved.plan_json},
   unified:{snapshotRef:saved.snapshot_id,values:validateDigitalSlaSnapshot({ruleVersion:saved.rule_version,parameters:saved.parameters_json})},development:null,
   sourceVersions:{creation:p.eventRef,customerDate:1},
   work:p.lineIds.map(lineId=>({id:`packing:${lineId}`,dependsOn:[],minutes:60,calendar:'continuous',canonicalWorkRef:`order:${p.resource.id}:packing:${lineId}`,planningParameterRef:'TEST explicit temporary planning60',responsibilitySlaRef:null})),
   consumers:p.lineIds.map(lineId=>({scopeRef:`po:${lineId}`,lineId,nodeIds:[`packing:${lineId}`],customerDateVersion:1,customerGoalIds:[`packing:${lineId}`],ends:{[`packing:${lineId}`]:{precision:'date',value:'2027-03-01',source:`po:${lineId}:customer-date:1`}}}))};
 };
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!,{throughVersion:'0280_journey_selection_facts'});
  await applyOrderMerchandiserFixture(f.db,true);
  await f.db.query(await readFile(new URL('../../apps/api/migrations/0281_fixed_timeline_adoptions.sql',import.meta.url),'utf8'));
  await f.db.query(await readFile(new URL('../../apps/api/migrations/0282_journey_fixed_progress_selectors.sql',import.meta.url),'utf8'));
  expect((await f.db.query("SELECT current_setting('is_superuser') AS superuser")).rows[0].superuser).toBe('off');
  scene=await f.scene('2026-11-09T08:00:00.000Z');
 });
 afterAll(async()=>{await f?.dispose();});
 it('keeps one immutable original input and v2 mode after stopping new adoption',()=>run(async()=>{
  const p=await make(),time=await new ContextBusinessClock(f.db).read(p.resource);
  const first=await tx(async db=>new FixedTimelineAdoptionRepository(db).capture(p.resource,1,f.root.actorId,p.eventRef,time,'fixed_v2',()=>input(db,p)));
  expect(first).not.toBeNull();let recaptured=false;
  const retry=await tx(async db=>new FixedTimelineAdoptionRepository(db).capture(p.resource,1,f.root.actorId,p.eventRef,time,'legacy',async()=>{recaptured=true;throw Error('Current settings must not be read');}));
  expect(recaptured).toBe(false);expect(retry).toEqual(first);
  expect(await new FixedTimelineAdoptionRepository(f.db).mode(p.resource)).toBe('fixed_v2');
  await expect(f.db.query("UPDATE digital_timeline_adoptions SET identity_hash=repeat('0',64) WHERE adoption_id=$1",[first!.adoptionId])).rejects.toBeTruthy();
 }));
 it('retries target projection from the original snapshot and keeps it after later observations',()=>run(async()=>{
  const p=await make(),time=await new ContextBusinessClock(f.db).read(p.resource);
  const saved=(await tx(db=>new FixedTimelineAdoptionRepository(db).capture(p.resource,1,f.root.actorId,p.eventRef,time,'fixed_v2',()=>input(db,p))))!;
  await expect(tx(async db=>{
   const fault={query:(...args:Parameters<PoolClient['query']>)=>{if(String(args[0]).includes('INSERT INTO digital_timeline_target_revisions'))throw Error('TEST controlled transient target storage');return db.query(...args);}} as Pick<PoolClient,'query'>;
   return new FixedTimelineAdoptionRepository(fault).buildInitialTargets(saved,f.root.actorId,time);
  })).rejects.toThrow('TEST controlled transient');
  expect((await f.db.query('SELECT 1 FROM digital_timeline_target_revisions WHERE adoption_id=$1',[saved.adoptionId])).rowCount).toBe(0);
  const result=await tx(db=>new FixedTimelineAdoptionRepository(db).buildInitialTargets(saved,f.root.actorId,time));
  expect(result[0]!.targets[0]!.start.at).toBe('2027-03-01T15:00:00.000Z');
  await f.advance(scene,'2026-11-10T08:00:00.000Z');
  const again=await tx(db=>new FixedTimelineAdoptionRepository(db).buildInitialTargets(saved,f.root.actorId,{...time,now:'2026-11-10T08:00:00.000Z'}));
  expect(again).toEqual(result);
  expect((await f.db.query('SELECT 1 FROM digital_timeline_target_revisions WHERE adoption_id=$1',[saved.adoptionId])).rowCount).toBe(1);
 }));
 it('serializes concurrent original-input capture without using the second callback',()=>run(async()=>{
  const p=await make(),time=await new ContextBusinessClock(f.db).read(p.resource),first=await f.db.connect(),second=await f.db.connect();
  let callbacks=0,entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  try{
   await first.query('BEGIN');await second.query('BEGIN');
   const a=new FixedTimelineAdoptionRepository(first).capture(p.resource,1,f.root.actorId,p.eventRef,time,'fixed_v2',async()=>{callbacks++;entered();await resume;return input(first,p);});
   await started;
   const b=new FixedTimelineAdoptionRepository(second).capture(p.resource,1,f.root.actorId,p.eventRef,time,'fixed_v2',async()=>{callbacks++;return input(second,p);});
   release();const saved=await a;await first.query('COMMIT');const existing=await b;await second.query('COMMIT');
   expect(callbacks).toBe(1);expect(existing?.adoptionId).toBe(saved?.adoptionId);
  }finally{release();await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();}
 }));
 it('blocks direct preview and apply of new standards for a v2 order before any snapshot append',()=>run(async()=>{
  const p=await make(),time=await new ContextBusinessClock(f.db).read(p.resource);
  await tx(db=>new FixedTimelineAdoptionRepository(db).capture(p.resource,1,f.root.actorId,p.eventRef,time,'fixed_v2',()=>input(db,p)));
  const application=new SlaOrderApplicationService(f.db,'TEST-fixed-timeline-preview-'.repeat(3)),version=(await f.db.query('SELECT max(version)::int AS version FROM digital_sla_configurations')).rows[0].version;
  const selection={orderId:p.resource.id,configurationVersion:version,parameterKeys:['bulk_pattern'],reason:'TEST no in-flight replacement'};
  const before=Number((await f.db.query('SELECT count(*) FROM digital_sla_order_snapshots WHERE production_order_id=$1',[p.resource.id])).rows[0].count);
  await expect(application.preview(f.root,selection)).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('已冻结')});
  await expect(application.apply(f.root,{...selection,previewToken:'TEST stale browser token'},randomUUID())).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('已冻结')});
  expect(Number((await f.db.query('SELECT count(*) FROM digital_sla_order_snapshots WHERE production_order_id=$1',[p.resource.id])).rows[0].count)).toBe(before);
 }));
 it('replays only genuine approved H changes in order from frozen input, leaving the other PO and B0 unchanged',async()=>{
  const {p,saved}=await run(async()=>{
   const p=await make(2),time=await new ContextBusinessClock(f.db).read(p.resource),saved=(await tx(db=>new FixedTimelineAdoptionRepository(db).capture(p.resource,1,f.root.actorId,p.eventRef,time,'fixed_v2',()=>input(db,p))))!;
   await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));return {p,saved};
  });
  // Global publication remains outside the isolated Acceptance clock scope;
  // its original guard is not relaxed for this future-standard counterexample.
  await tx(async db=>{const current=await new SlaConfigurationRepository(db).initialStandard(f.root.actorId),values=structuredClone(current.values);values.garment_packing={kind:'duration',minutes:180};await new SlaConfigurationService().publishNewStandard(db,f.root,{expectedVersion:current.version,values,reason:'TEST future standard must not enter old H retry',requestKey:randomUUID()});});
  await run(async()=>{
  const read=()=>f.db.query('SELECT scope_ref,revision,targets_json,goal_anchor,source_event_ref,business_time FROM digital_timeline_target_revisions WHERE adoption_id=$1 ORDER BY scope_ref,revision',[saved.adoptionId]);
  const original=(await read()).rows,dates=new PoCustomerDateService(f.db);
  const request=async(date:string)=>{
   const state=await dates.read(f.root,p.resource.id),version=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[p.resource.id])).rows[0].version,line=state.customerPoDates.find(line=>line.lineId===p.lineId)!;
   return await dates.request(f.root,p.resource.id,{orderVersion:version,changes:[{lineId:p.lineId,date,expectedVersion:line.version}],reason:'TEST true original PO H change'},randomUUID()) as {requestId:string};
  };
  const rejected=await request('2027-03-02');
  await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));expect((await read()).rows).toEqual(original);
  await dates.decide(f.root,p.resource.id,rejected.requestId,false,randomUUID());
  await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));expect((await read()).rows).toEqual(original);
  await expect(request('2027-03-01')).rejects.toMatchObject({statusCode:409});
  const first=await request('2027-03-02');await dates.decide(f.root,p.resource.id,first.requestId,true,randomUUID());
  const second=await request('2027-03-03'),decisionKey=randomUUID();await dates.decide(f.root,p.resource.id,second.requestId,true,decisionKey);await dates.decide(f.root,p.resource.id,second.requestId,true,decisionKey);
  await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));
  const rows=(await read()).rows,own=rows.filter(row=>row.scope_ref===`po:${p.lineId}`),sibling=rows.filter(row=>row.scope_ref!==`po:${p.lineId}`);
  expect(own.map(row=>row.revision)).toEqual([1,2,3]);expect(own[0]).toEqual(original.find(row=>row.scope_ref===`po:${p.lineId}`));
  expect(sibling).toEqual(original.filter(row=>row.scope_ref!==`po:${p.lineId}`));
  expect(own.map(row=>row.targets_json[0].end.at)).toEqual(['2027-03-01T16:00:00.000Z','2027-03-02T16:00:00.000Z','2027-03-03T16:00:00.000Z']);
  expect(own.every(row=>Date.parse(row.targets_json[0].end.at)-Date.parse(row.targets_json[0].start.at)===60*60000)).toBe(true);
  expect((await new FixedTimelineAdoptionRepository(f.db).existing(p.resource))?.identityHash).toBe(saved.identityHash);
  await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));expect((await read()).rows).toEqual(rows);
  });
 });
 it('replays a real approved customer H change committed before the first physical route adoption',async()=>{
  configureTimelineAdoption(f.db,'fixed_v2');
  try{
   const p=await run(()=>make()),initial=(await readInitialTimelineInput(f.db,p.resource))!,base=Date.parse(initial.data.time.now);
   await f.advance(scene,new Date(base+3600000).toISOString());
   await run(async()=>{
    const dates=new PoCustomerDateService(f.db),state=await dates.read(f.root,p.resource.id),version=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[p.resource.id])).rows[0].version;
    const request=await dates.request(f.root,p.resource.id,{orderVersion:version,changes:[{lineId:p.lineId,date:'2027-03-02',expectedVersion:state.customerPoDates[0]!.version}],reason:'TEST real H before original route adoption'},randomUUID()) as {requestId:string};
    await dates.decide(f.root,p.resource.id,request.requestId,true,randomUUID());
   });
   await f.advance(scene,new Date(base+7200000).toISOString());
   await run(async()=>{
    const time=await new ContextBusinessClock(f.db).read(p.resource),saved=(await tx(db=>new FixedTimelineAdoptionRepository(db).capture(p.resource,1,f.root.actorId,p.eventRef,time,'fixed_v2',()=>input(db,p))))!;
    expect(saved.time.now).toBe(new Date(base+7200000).toISOString());
    await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));
    const rows=(await f.db.query('SELECT revision,targets_json FROM digital_timeline_target_revisions WHERE adoption_id=$1 ORDER BY revision',[saved.adoptionId])).rows;
    expect(rows.map(row=>row.revision)).toEqual([1,2]);expect(rows.map(row=>row.targets_json[0].end.at)).toEqual(['2027-03-01T16:00:00.000Z','2027-03-02T16:00:00.000Z']);
    await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));
    expect((await f.db.query('SELECT 1 FROM digital_timeline_target_revisions WHERE adoption_id=$1',[saved.adoptionId])).rowCount).toBe(2);
   });
  }finally{configureTimelineAdoption(f.db,'legacy');}
 });
 it('isolates a target storage failure in the original bounded worker after business commit and retries the original input',()=>run(async()=>{
  const bad=await make(),good=await make(),save=async(p:Awaited<ReturnType<typeof make>>)=>tx(async db=>new FixedTimelineAdoptionRepository(db).capture(p.resource,1,f.root.actorId,p.eventRef,await new ContextBusinessClock(f.db,db).read(p.resource),'fixed_v2',()=>input(db,p)));
  const badAdoption=(await save(bad))!,goodAdoption=(await save(good))!;
  const originalVersion=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[bad.resource.id])).rows[0].version;
  const faultDb=new Proxy(f.db,{get(target,key){
   if(key==='connect')return async()=>{
    const client=await target.connect();return new Proxy(client,{get(db,property){
     if(property==='query')return (sql:string,values?:unknown[])=>{if(sql.includes('INSERT INTO digital_timeline_target_revisions')&&values?.[1]===badAdoption.adoptionId)throw Error('TEST controlled single-object target storage failure');return db.query(sql,values);};
     const value=Reflect.get(db,property,db);return typeof value==='function'?value.bind(db):value;
    }});
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const result=await new JourneyFactUpdates(f.db,new JourneyFactRepository(faultDb)).runOnce();
  expect(result.failed).toBe(1);expect(result.built).toBeGreaterThan(0);
  expect((await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[bad.resource.id])).rows[0].version).toBe(originalVersion);
  expect((await f.db.query('SELECT 1 FROM digital_timeline_target_revisions WHERE adoption_id=$1',[badAdoption.adoptionId])).rowCount).toBe(0);
  expect((await f.db.query('SELECT 1 FROM digital_timeline_target_revisions WHERE adoption_id=$1',[goodAdoption.adoptionId])).rowCount).toBe(1);
  expect((await f.db.query("SELECT error_code FROM digital_journey_fact_retries WHERE resource_kind='order' AND resource_id=$1",[bad.resource.id])).rows[0]?.error_code).toBe('BUILD_FAILED');
  await new JourneyFactRepository(f.db).buildOne(bad.resource);
  expect((await f.db.query('SELECT targets_json,business_time FROM digital_timeline_target_revisions WHERE adoption_id=$1',[badAdoption.adoptionId])).rows[0]).toMatchObject({business_time:badAdoption.time,targets_json:[{start:{at:'2027-03-01T15:00:00.000Z'}}]});
  expect((await f.db.query("SELECT 1 FROM digital_journey_fact_changes WHERE resource_kind='order' AND resource_id=$1",[bad.resource.id])).rowCount).toBe(0);
  expect((await f.db.query("SELECT 1 FROM digital_journey_fact_retries WHERE resource_kind='order' AND resource_id=$1",[bad.resource.id])).rowCount).toBe(0);
 }));
 it('freezes native source and order creation inputs and keeps their v2 identity when only new adoption is stopped',async()=>{
  let sourceId='',orderId='';
  configureTimelineAdoption(f.db,'fixed_v2');
  try{await run(async()=>{
   sourceId=(await new DigitalProductionIdentityService(f.db,true).createSource(f.root,{developmentType:'头版',designStyleNo:'TEST-FIXED-SOURCE-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID())).sourceId;
   orderId=(await make()).resource.id;
  });}finally{configureTimelineAdoption(f.db,'legacy');}
  await run(async()=>{
   const source=await readInitialTimelineInput(f.db,{kind:'source',id:sourceId}),order=await readInitialTimelineInput(f.db,{kind:'order',id:orderId});
   expect(source).toMatchObject({version:2,data:{resource:{kind:'source',id:sourceId},development:{version:expect.any(Number)},planning:null}});
   expect(order).toMatchObject({version:2,data:{resource:{kind:'order',id:orderId},unified:{snapshotRef:expect.any(String)}}});
   const repo=new FixedTimelineAdoptionRepository(f.db);
   expect(await repo.mode({kind:'source',id:sourceId})).toBe('fixed_v2');expect(await repo.mode({kind:'order',id:orderId})).toBe('fixed_v2');
   const later=await make();expect(await repo.mode(later.resource)).toBe('legacy');expect(await readInitialTimelineInput(f.db,later.resource)).toBeNull();
   expect((await readInitialTimelineInput(f.db,{kind:'source',id:sourceId}))?.identityHash).toBe(source!.identityHash);
   expect((await readInitialTimelineInput(f.db,{kind:'order',id:orderId}))?.identityHash).toBe(order!.identityHash);
   const application=new SlaOrderApplicationService(f.db,'TEST-fixed-header-'.repeat(3)),version=(await f.db.query('SELECT max(version)::int AS version FROM digital_sla_configurations')).rows[0].version;
   await expect(application.preview(f.root,{orderId,configurationVersion:version,parameterKeys:['bulk_pattern'],reason:'TEST native header freeze'})).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('已冻结')});
  });
 });
 it('freezes one creation snapshot when a new development standard commits between the native standard reads',()=>run(async()=>{
  const before=(await f.db.query('SELECT version,values_json FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0];
  let injected=false;
  const pool=new Proxy(f.db,{get(target,key){
   if(key==='connect')return async()=>{
    const client=await target.connect();return new Proxy(client,{get(db,property){
     if(property==='query')return async(sql:string,values?:unknown[])=>{
      const result=await db.query(sql,values);
      if(!injected&&sql.startsWith('SELECT * FROM digital_sla_configurations ')){
       injected=true;
       await f.db.query('INSERT INTO digital_development_cycle_standards(version,values_json,changed_by,reason) VALUES($1,$2,$3,$4)',[before.version+1,JSON.stringify(before.values_json),f.root.actorId,'TEST controlled concurrent future publication']);
      }
      return result;
     };
     const value=Reflect.get(db,property,db);return typeof value==='function'?value.bind(db):value;
    }});
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  configureTimelineAdoption(pool,'fixed_v2');
  try{
   const source=await new DigitalProductionIdentityService(pool,true).createSource(f.root,{developmentType:'头版',designStyleNo:'TEST-SNAPSHOT-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   expect(injected).toBe(true);
   expect((await readInitialTimelineInput(f.db,{kind:'source',id:source.sourceId}))?.data.development?.version).toBe(before.version);
   expect((await f.db.query('SELECT max(version)::int AS version FROM digital_development_cycle_standards')).rows[0].version).toBe(before.version+1);
  }finally{configureTimelineAdoption(pool,'legacy');}
 }));
 it('runs two independent native craft tasks in both chosen sequences without a combined or invented dual SLA',()=>run(async()=>{
  configureTimelineAdoption(f.db,'fixed_v2');
  try{
   for(const kinds of [['embroidery','printing'],['printing','embroidery']] as const){
    const steps=kinds.map((craftKind,index)=>({craftKind,sequence:index+1}));
    const created=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,
      new ContextBusinessClock(f.db),[['印绣花','免洗']],{fixedCraftSteps:steps});
    const sourceId=created[0]!.sourceId,saved=(await new FixedTimelineAdoptionRepository(f.db).existing({kind:'source',id:sourceId},1))!;
    expect(saved.input.craftSteps?.map(step=>step.craftKind)).toEqual(kinds);
    const positions=(await f.db.query(`SELECT t.state,a.task_kind,p.route_position,p.step_id,p.phase FROM digital_timeline_task_positions p JOIN digital_production_tasks t USING(task_id) JOIN digital_production_task_access a USING(task_id) WHERE p.adoption_id=$1 ORDER BY p.route_position`,[saved.adoptionId])).rows;
    expect(positions.filter(row=>row.phase==='work')).toMatchObject(kinds.map(kind=>({state:'completed',task_kind:`development_${kind}`,step_id:expect.any(String)})));
    expect(new Set(positions.filter(row=>row.phase==='work').map(row=>row.step_id)).size).toBe(2);
    expect((await f.db.query("SELECT 1 FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_print_embroidery'",[sourceId])).rowCount).toBe(0);
   }
  }finally{configureTimelineAdoption(f.db,'legacy');}
 }));
 it('retains frozen standards and original completed facts when an adopted source starts a real second craft round with new adoption stopped',()=>run(async()=>{
  configureTimelineAdoption(f.db,'fixed_v2');
  try{
   const created=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,
    new ContextBusinessClock(f.db),[['印绣花','免洗']],{fixedCraftSteps:[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}]});
   const sourceId=created[0]!.sourceId,repo=new FixedTimelineAdoptionRepository(f.db),original=(await repo.existing({kind:'source',id:sourceId},1))!;
   const before=(await f.db.query('SELECT t.task_id,t.state,t.completed_at FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=1 ORDER BY t.task_id',[sourceId])).rows;
   configureTimelineAdoption(f.db,'legacy');
   const forms=new DigitalDevelopmentService(f.db,true),sheet=await forms.read(f.root,sourceId),rounds=new DevelopmentRoundService(f.db,true);
   const draft=await rounds.save(f.root,sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:sheet.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST实际重做两道工艺',explanation:'TEST原冻结标准及历史任务保持',categories:['工艺'],affectedNodes:['工艺'],outputKind:'工艺布片'}},randomUUID());
   const key=randomUUID(),request={expectedDraftVersion:draft.draftVersion,basedOnRound:1};
   expect((await rounds.publish(f.root,sourceId,request,key)).roundNumber).toBe(2);
   expect((await rounds.publish(f.root,sourceId,request,key)).roundNumber).toBe(2);
   const next=(await repo.existing({kind:'source',id:sourceId},2))!;
   expect(next.input.unified).toEqual(original.input.unified);expect(next.input.development).toEqual(original.input.development);
   expect(next.input.craftSteps?.map(step=>step.craftKind)).toEqual(['embroidery','printing']);
   expect(next.input.craftSteps?.some(step=>original.input.craftSteps?.some(old=>old.stepId===step.stepId))).toBe(false);
   expect(next.input.route?.filter(node=>node.phase==='dispatch').length).toBe(2);
   expect(next.input.route?.filter(node=>node.phase==='confirmation').length).toBe(2);
   expect(next.input.work.filter(work=>['development_embroidery','development_printing'].includes(work.id)).every(work=>work.accountingRole==='added_work'&&work.responsibilityMinutes===null)).toBe(true);
   const history=(await f.db.query('SELECT t.task_id,t.state,t.completed_at FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version=1 ORDER BY t.task_id',[sourceId])).rows;
   expect(history.filter(row=>row.state==='completed')).toEqual(before.filter(row=>row.state==='completed'));
   expect(history.filter(row=>row.state!=='completed').every(row=>row.state==='cancelled'&&row.completed_at===null)).toBe(true);
   expect((await forms.read(f.root,sourceId)).roundNumber).toBe(2);
   const built=await new JourneyFactRepository(f.db).buildOne({kind:'source',id:sourceId}),progress=built.model.fixedSchedule!.scopes[0]!,oldTargets=(await repo.currentTargets({kind:'source',id:sourceId},1))!;
   const oldGoal=Object.keys(original.input.consumers[0]!.ends).find(id=>id!=='development_shipping')!,handoff=oldTargets.scopes[0].targets_json.find((target:{id:string})=>target.id===oldGoal)!.end.at;
   expect(progress.work.filter(work=>work.accountingRole==='added_work').length).toBeGreaterThan(0);
   expect(progress.work.filter(work=>work.accountingRole==='added_work').every(work=>work.originalHandoffAt===handoff)).toBe(true);
   expect(progress.work.some(work=>work.id===`prior_source_completion:${sourceId}:round:1`)).toBe(true);
   const source=(await f.db.query('SELECT design_style_no,temporary_style_no,customer_code FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0];
   const order=await new DigitalProductionIdentityService(f.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:source.customer_code??'PD',productGroup:'男装',designStyleNo:source.design_style_no,temporaryStyleNo:source.temporary_style_no,orderDate:beijingCalendarDate(businessNow()),primaryMerchandiserId:f.people.merchandiser!.actorId,
    lines:[{formalPoNo:'TEST-CONTINUATION-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID(),sourceId);
   const continuation=(await readInitialTimelineInput(f.db,{kind:'order',id:order.productionOrderId}))!;
   expect(continuation).not.toBeNull();expect(continuation.data.development).toEqual(original.input.development);
   expect(continuation.data.unified.values).toEqual(original.input.unified.values);
  }finally{configureTimelineAdoption(f.db,'legacy');}
 }));
 for(const sequence of [['embroidery','printing'],['printing','embroidery']] as const)it(`native ${sequence.join('→')}: terminal-only dispatch, effective QC, partial release and retry without double counting`,()=>run(async()=>{
  configureTimelineAdoption(f.db,'fixed_v2');
  let ready:Awaited<ReturnType<typeof f.bulkReady>>;
  try{ready=await f.bulkReady('印绣花',undefined,1,f.sourcing,{quantity:100,craftSteps:sequence.map((craftKind,index)=>({craftKind,sequence:index+1}))});}
  finally{configureTimelineAdoption(f.db,'legacy');}
  const cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[ready!.caseId])).rows;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of cuts)await ready!.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),tasks=new DigitalProductionTaskService(f.db),read=()=>flow.read(f.root,ready!.id);
  const assigned=(await f.db.query("SELECT a.task_id,a.required_role FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind IN ('process_logistics','bulk_qc')",[ready!.id])).rows;
  for(const task of assigned){const person=Object.values(f.people).find(person=>person.actorRoles.includes(task.required_role));expect(person).toBeDefined();await tasks.reassign(f.root,task.task_id,person!.actorId,randomUUID());}
  let state=await read();expect(state.routeSchemaVersion).toBe(2);expect(state.craftSteps?.map(step=>step.craftKind)).toEqual(sequence);
  const [first,last]=state.craftSteps!,lineId=state.lines[0]!.lineId;
  const move=async(stepRef:string,kind:'工艺发出'|'工艺回仓',extra:Record<string,unknown>={})=>{state=await read();await flow.logistics(f.root,ready!.id,{expectedRevision:state.revision,stepRef,kind,occurredAt:businessNow().toISOString(),supplier:'TEST actual craft',note:'TEST',...extra} as Parameters<FactoryFlowService['logistics']>[2],randomUUID());state=await read();return state.facts.filter(fact=>fact.kind===kind&&fact.payload.stepRef===stepRef).at(-1)!.factId;};
  const check=async(stepRef:string,returnFactId:string)=>{state=await read();await flow.qc(f.root,ready!.id,{expectedRevision:state.revision,stepRef,returnFactId,note:'TEST',checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]}]},randomUUID());};
  const sent=await move(first!.stepId,'工艺发出',{lines:[{lineId,quantity:100}]}),returned=await move(first!.stepId,'工艺回仓',{sendFactId:sent,lines:[{lineId,quantity:100}]});
  await check(first!.stepId,returned);state=await read();
  await expect(flow.dispatch(f.root,ready!.id,{expectedRevision:state.revision,returnFactId:returned,lines:[{lineId,quantity:100}],supplierId:f.supplierId,note:'TEST must reject intermediate'},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(tx(async db=>{
   const factId=randomUUID();
   await db.query(`INSERT INTO digital_factory_facts(fact_id,preparation_id,sequence,kind,payload,actor_id,occurred_at)
    SELECT $1,$2,coalesce(max(sequence),0)+1,'仓库实际发厂',$3,$4,$5 FROM digital_factory_facts WHERE preparation_id=$2`,
    [factId,ready!.preparationId,JSON.stringify({stepRef:last!.stepId,returnFactId:returned,lines:[{lineId,quantity:100}]}),f.root.actorId,businessNow().toISOString()]);
   await new SourcingProductionService(f.db).dispatchDigitalWithClient(db,f.root,ready!.id,factId);
  })).rejects.toMatchObject({statusCode:409});
  expect((await f.db.query('SELECT 1 FROM sourcing_production_orders WHERE sourcing_case_id=$1',[ready!.caseId])).rowCount).toBe(0);
  const partial=sequence[0]==='printing',firstQuantity=partial?60:100;
  const finalSend=await move(last!.stepId,'工艺发出',{fromReturnId:returned,lines:[{lineId,quantity:100}]}),finalReturn=await move(last!.stepId,'工艺回仓',{sendFactId:finalSend,lines:[{lineId,quantity:firstQuantity}]});
  await check(last!.stepId,finalReturn);state=await read();expect(state.batchTotals![0]).toMatchObject({quantity:100,sent:0,remaining:100});
  await flow.qc(f.root,ready!.id,{expectedRevision:state.revision,stepRef:last!.stepId,returnFactId:finalReturn,note:'TEST effective recheck',checks:[{lineId,result:'需处理',problem:'TEST must use latest check',treatment:'TEST recheck',attachmentIds:[]}]},randomUUID());
  state=await read();await expect(flow.dispatch(f.root,ready!.id,{expectedRevision:state.revision,returnFactId:finalReturn,lines:[{lineId,quantity:1}],supplierId:f.supplierId,note:'TEST stale QC must not release'},randomUUID())).rejects.toMatchObject({statusCode:409});
  await check(last!.stepId,finalReturn);
  const dispatch=async(returnFactId:string,quantity:number)=>{
   state=await read();const key=randomUUID(),input={expectedRevision:state.revision,returnFactId,lines:[{lineId,quantity}],supplierId:f.supplierId,note:'TEST terminal only'};
   await flow.dispatch(f.root,ready!.id,input,key);await flow.dispatch(f.root,ready!.id,input,key);
  };
  if(partial){
   const resent=await move(last!.stepId,'工艺发出',{fromReturnId:finalReturn,lines:[{lineId,quantity:10}]}),repaired=await move(last!.stepId,'工艺回仓',{sendFactId:resent,lines:[{lineId,quantity:10}]});
   await check(last!.stepId,repaired);await dispatch(finalReturn,50);await dispatch(repaired,10);
   state=await read();expect(state.batchTotals![0]).toMatchObject({sent:60,remaining:40});expect(state.dispatched).toBe(false);
   const remainder=await move(last!.stepId,'工艺回仓',{sendFactId:finalSend,lines:[{lineId,quantity:40}]});await check(last!.stepId,remainder);await dispatch(remainder,40);
  }else await dispatch(finalReturn,100);
  state=await read();expect(state.batchTotals![0]).toMatchObject({quantity:100,sent:100,remaining:0});expect(state.dispatched).toBe(true);
  expect(state.facts.filter(fact=>fact.kind==='仓库实际发厂')).toHaveLength(partial?3:1);
 }));
 it('keeps planning duration separate from native responsibility SLA and does not fill an inherited missing standard later',()=>run(async()=>{
  const configuration=await new SlaConfigurationRepository(f.db).initialStandard(f.root.actorId),development=(await f.db.query('SELECT version FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0];
  configureTimelineAdoption(f.db,'fixed_v2');
  let originalSource:string;
  try{originalSource=(await new DigitalProductionIdentityService(f.db,true).createSource(f.root,{developmentType:'头版',designStyleNo:'TEST-ORIGINAL-FROZEN-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID())).sourceId;}
  finally{configureTimelineAdoption(f.db,'legacy');}
  const old=(await readInitialTimelineInput(f.db,{kind:'source',id:originalSource!}))!;
  expect(old.data.planning).toBeNull();
  await f.db.query(`INSERT INTO digital_timeline_standard_versions(standard_id,version,unified_configuration_id,development_version,planning_json,created_by,request_key)
   SELECT $1,coalesce(max(version),0)+1,$2,$3,$4,$5,$6 FROM digital_timeline_standard_versions`,[randomUUID(),configuration.configurationId,development.version,JSON.stringify({development_printing:{minutes:60,calendar:'continuous',responsibilityAdopted:false}}),f.root.actorId,randomUUID()]);
  const preserved=await freezeInitialTimelineInput(f.db,'fixed_v2',{resource:old.data.resource,creationEventRef:'TEST downstream original creation',time:old.data.time,unified:old.data.unified},old);
  expect(preserved!.data.planning).toBeNull();
  configureTimelineAdoption(f.db,'fixed_v2');
  try{
   const created=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,new ContextBusinessClock(f.db),[['印花','免洗']],{fixedCraftSteps:[{craftKind:'printing',sequence:1}]});
   const saved=(await new FixedTimelineAdoptionRepository(f.db).existing({kind:'source',id:created[0]!.sourceId},1))!;
   expect(saved.input.work.find(work=>work.id==='development_printing')).toMatchObject({minutes:60,calendar:'continuous',responsibilityMinutes:5760,responsibilityCalendar:'continuous'});
   const task=(await f.db.query("SELECT a.task_id FROM digital_production_task_access a WHERE source_id=$1 AND task_kind='development_printing'",[created[0]!.sourceId])).rows[0];
   expect((await new DigitalProductionTaskService(f.db).read(f.root,task.task_id)).slaHours).toBe(96);
  }finally{configureTimelineAdoption(f.db,'legacy');}
 }));
 it('accepts a genuine new instruction scope without changing original targets or rereading later planning settings',()=>run(async()=>{
  const configuration=await new SlaConfigurationRepository(f.db).initialStandard(f.root.actorId),development=(await f.db.query('SELECT version FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0];
  const planning={budget:{minutes:60,calendar:'continuous'},warehouse_accessories:{minutes:30,calendar:'continuous'},factory_production_work:{minutes:120,calendar:'continuous'},factory_production:{minutes:60,calendar:'continuous'},ship_sample:{minutes:15,calendar:'continuous'},bulk_printing:{minutes:60,calendar:'continuous'}};
  const publish=async(minutes:number)=>f.db.query(`INSERT INTO digital_timeline_standard_versions(standard_id,version,unified_configuration_id,development_version,planning_json,created_by,request_key)
   SELECT $1,coalesce(max(version),0)+1,$2,$3,$4,$5,$6 FROM digital_timeline_standard_versions`,[randomUUID(),configuration.configurationId,development.version,JSON.stringify({...planning,bulk_printing:{minutes,calendar:'continuous'}}),f.root.actorId,randomUUID()]);
  await publish(60);configureTimelineAdoption(f.db,'fixed_v2');
  let ready:Awaited<ReturnType<typeof f.bulkReady>>;
  try{ready=await f.bulkReady('无');}finally{configureTimelineAdoption(f.db,'legacy');}
  const repo=new FixedTimelineAdoptionRepository(f.db),saved=(await repo.existing({kind:'order',id:ready!.id}))!;
  await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));
  const before=(await f.db.query('SELECT targets_json FROM digital_timeline_target_revisions WHERE adoption_id=$1 ORDER BY scope_ref,revision',[saved.adoptionId])).rows;
  expect(before[0].targets_json.find((node:{id:string})=>node.id==='warehouse_dispatch').start.at).toBeTruthy();
  await publish(300);
  const instruction=new ProductionInstructionService(f.db,true),current=await instruction.read(ready!.primary,ready!.id);
  await instruction.save(ready!.primary,ready!.id,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,sourceRound:current.sourceRound!,document:{...current.document,secondaryCraft:'印花',craftSteps:[{craftKind:'printing',sequence:1}]}},randomUUID());
  const basis=await productionReadinessFixture(f.db,f.root,ready!.id,f.people['pattern-room-worker']!.actorId,f.people.warehouse!);
  const draft=await instruction.read(ready!.primary,ready!.id);
  await instruction.publish(ready!.primary,ready!.id,{expectedVersion:draft.version,orderVersion:draft.currentOrderVersion,expectedReadinessRevision:basis.revision},randomUUID());
  const next=await new BulkPreparationService(f.db).read(ready!.primary,ready!.id);
  expect(next.preparationId).not.toBe(ready!.preparationId);
  await tx(db=>new FixedTimelineAdoptionRepository(db).buildPendingTargets(saved));
  const original=(await f.db.query("SELECT targets_json FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref NOT LIKE '%:route:%' ORDER BY scope_ref,revision",[saved.adoptionId])).rows;
  expect(original).toEqual(before);
  const scope=(await f.db.query('SELECT input_snapshot FROM digital_timeline_order_routes WHERE route_ref=$1',[next.preparationId])).rows[0].input_snapshot;
  expect(scope.work.find((node:{parameterKey:string})=>node.parameterKey==='bulk_printing')).toMatchObject({minutes:60,accountingRole:'added_work'});
  const targets=(await f.db.query("SELECT targets_json FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref LIKE '%:route:%'",[saved.adoptionId])).rows;
  expect(targets).toHaveLength(1);expect(targets[0].targets_json.at(-1).end).toEqual(before[0].targets_json.find((node:{id:string})=>node.id==='warehouse_dispatch').start);
  await new BulkPreparationService(f.db).dispatch(f.people['development-clerk']!,ready!.id,{expectedVersion:next.dispatch.version,patternWorkerId:f.people['pattern-room-worker']!.actorId,deliverPattern:true},randomUUID());
  for(const kind of ['纸样完成','唛架完成','预缩完成'] as const)await completeBulkRangeFixture(f.db,kind==='预缩完成'?f.people.warehouse!:f.people['pattern-room-worker']!,ready!.id,next.preparationId!,kind);
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of (await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready!.caseId])).rows)await ready!.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=await new FactoryFlowService(f.db).read(f.root,ready!.id);
  expect(flow.routeSchemaVersion).toBe(2);expect(flow.craftSteps?.map(step=>step.craftKind)).toEqual(['printing']);
  const positions=(await f.db.query('SELECT p.step_id,p.phase,p.route_version FROM digital_timeline_task_positions p JOIN digital_production_task_access a USING(task_id) WHERE p.route_ref=$1 AND a.task_kind IN (\'process_logistics\',\'bulk_qc\')',[next.preparationId])).rows;
  expect(positions).toHaveLength(2);expect(positions.every(row=>row.step_id===flow.craftSteps![0]!.stepId&&row.route_version===draft.version)).toBe(true);
 }));
});
