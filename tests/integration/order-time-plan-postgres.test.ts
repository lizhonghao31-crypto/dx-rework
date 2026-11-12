import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {FrozenOrderTimePlan,OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {reviseOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {OrderTimePlanRepository,type OrderTimeInput} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {PoCustomerDateService} from '../../apps/api/src/production-platform/po-customer-date-service.js';
import {FixedTimelineAdoptionRepository} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
import {SlaOrderApplicationService} from '../../apps/api/src/production-platform/sla-order-application.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {readInitialTimelineInput,freezeInitialTimelineInput} from '../../apps/api/src/production-platform/fixed-timeline-initial-input.js';
import {SlaConfigurationService} from '../../apps/api/src/production-platform/sla-configuration-service.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const duration=(hours:number):OrderTimeRule=>({kind:'work',minutes:hours*60,calendar:'continuous',reminder:{enabled:true,percent:70}});
(url?describe.sequential:describe.skip)('R5 one-order frozen time storage (owned PostgreSQL, new activation remains deferred)',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,scene:string;
 const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
 const tx=async<T,>(action:(client:PoolClient)=>Promise<T>)=>{const db=await f.db.connect();try{await db.query('BEGIN');const result=await action(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
 const make=()=>new DigitalProductionIdentityService(f.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-R504-'+randomUUID(),orderDate:'2026-11-09',primaryMerchandiserId:f.people.merchandiser!.actorId,
  lines:[0,1].map(index=>({formalPoNo:'TEST-R504-'+randomUUID(),color:index?'白':'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}))}),randomUUID());
 const value=(order:Awaited<ReturnType<typeof make>>):OrderTimeInput=>{
  const plan:FrozenOrderTimePlan={version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST explicit frozen original counterpart',revision:1,stageBufferMinutes:0,nodes:{a:duration(48),b:duration(48),packing:duration(24),printing:duration(24)}}};
  return {version:'order-time-input-v1',plan,route:{complete:true,missing:[]},work:order.lines.flatMap(line=>[
   {id:'a:'+line.lineId,parameterKey:'a',stage:2,dependsOn:[]},
   {id:'b:'+line.lineId,parameterKey:'b',stage:4,dependsOn:['a:'+line.lineId]},
   {id:'packing:'+line.lineId,parameterKey:'packing',stage:7,dependsOn:['b:'+line.lineId]}]),
   scopes:order.lines.map(line=>({scopeRef:'po:'+line.lineId,lineId:line.lineId,terminalIds:['packing:'+line.lineId],customerGoalIds:['packing:'+line.lineId],
    customerGoal:{precision:'date',value:'2027-03-01',source:'TEST original PO H'},goals:{['packing:'+line.lineId]:{precision:'date',value:'2027-03-01',source:'TEST original PO H'}}}))};
 };
 const confirm=async(order:Awaited<ReturnType<typeof make>>,input:OrderTimeInput,revision=0,key=randomUUID())=>tx(async db=>new OrderTimePlanRepository(db).confirm({resource:{kind:'order',id:order.productionOrderId},expectedRevision:revision,value:input,actorId:f.root.actorId,eventRef:'TEST explicitly authorized core command:'+key,time:await new ContextBusinessClock(f.db,db).read({kind:'order',id:order.productionOrderId}),requestKey:key}));
 beforeAll(async()=>{f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-09T08:00:00.000Z');expect((await f.db.query("SELECT current_setting('is_superuser') AS value")).rows[0].value).toBe('off');});
 afterAll(async()=>{await f?.dispose();});
 it('does not adopt on creation/GET; explicitly persists all known targets before preparation and reuses a lost-result key',()=>run(async()=>{
  const order=await make(),resource={kind:'order' as const,id:order.productionOrderId};
  expect(await new OrderTimePlanRepository(f.db).current(resource)).toBeNull();
  expect((await f.db.query('SELECT 1 FROM digital_bulk_preparations WHERE production_order_id=$1',[order.productionOrderId])).rowCount).toBe(0);
  const input=value(order),key=randomUUID(),first=await confirm(order,input,0,key),retry=await confirm(order,input,0,key);
  expect(retry).toEqual(first);expect(first.revision).toBe(1);
  configureTimelineAdoption(f.db,'legacy');
  expect(await new FixedTimelineAdoptionRepository(f.db).mode(resource)).toBe('fixed_v2');
  const configurationVersion=(await f.db.query('SELECT max(version)::int AS version FROM digital_sla_configurations')).rows[0].version;
  await expect(new SlaOrderApplicationService(f.db,'TEST R504 preview secret '.repeat(3)).preview(f.root,{orderId:order.productionOrderId,configurationVersion,parameterKeys:['garment_packing'],reason:'TEST old apply must not overwrite an adopted order'})).rejects.toMatchObject({statusCode:409});
  for(const scope of input.scopes){
   const targets=first.targets[scope.scopeRef]!;
   expect(targets['a:'+scope.lineId]!.start.at).toBe('2027-02-24T16:00:00.000Z');
   expect(targets['b:'+scope.lineId]!.end.at).toBe('2027-02-28T16:00:00.000Z');
   expect(targets['packing:'+scope.lineId]!.end.at).toBe('2027-03-01T16:00:00.000Z');
  }
  await expect(confirm(order,{...input,plan:reviseOrderTimePlan(input.plan,{b:duration(24)})},0,key)).rejects.toThrow('标识');
  await expect(f.db.query('UPDATE digital_order_time_plan_versions SET identity_hash=repeat(\'0\',64) WHERE plan_version_id=$1',[first.id])).rejects.toBeTruthy();
  await expect(f.db.query('DELETE FROM digital_order_time_plan_versions WHERE plan_version_id=$1',[first.id])).rejects.toBeTruthy();
 }));
 it('freezes a continuation input from the source current confirmed override without replacing its original counterpart',()=>run(async()=>{
  configureTimelineAdoption(f.db,'fixed_v2');
  try{
   const source=await new DigitalProductionIdentityService(f.db,true).createSource(f.root,{developmentType:'头版',designStyleNo:'TEST-R504-SOURCE-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const resource={kind:'source' as const,id:source.sourceId},initial=(await readInitialTimelineInput(f.db,resource))!,template=value(await make());
   const input:OrderTimeInput={...template,work:[{id:'a',parameterKey:'a',stage:2,dependsOn:[]}],scopes:[{scopeRef:'source:'+source.sourceId,lineId:null,terminalIds:['a'],customerGoalIds:[],customerGoal:{precision:'date',value:'2027-03-01',source:'TEST known source goal'},goals:{a:{precision:'date',value:'2027-03-01',source:'TEST known source goal'}}}]};
   const save=(v:OrderTimeInput,revision:number)=>tx(async db=>new OrderTimePlanRepository(db).confirm({resource,expectedRevision:revision,value:v,actorId:f.root.actorId,eventRef:'TEST actual confirmed source arrangement',time:await new ContextBusinessClock(f.db,db).read(resource),requestKey:randomUUID()}));
   const first=await save(input,0),changed=structuredClone(first.input);changed.plan=reviseOrderTimePlan(changed.plan,{a:duration(24)});await save(changed,1);
   const formal=await make(),formalInitial=(await readInitialTimelineInput(f.db,{kind:'order',id:formal.productionOrderId}))!;
   const inherited=await tx(db=>freezeInitialTimelineInput(db,'fixed_v2',{...formalInitial.data,orderTimePlan:changed.plan},initial));
   expect(inherited!.data.orderTimePlan).toEqual(changed.plan);expect(inherited!.data.orderTimePlan!.company).toEqual(first.input.plan.company);
   expect((await readInitialTimelineInput(f.db,resource))!.data.orderTimePlan).toBeUndefined();
   await expect(tx(db=>freezeInitialTimelineInput(db,'fixed_v2',{...formalInitial.data,orderTimePlan:input.plan},initial))).rejects.toThrow('当前已确认');
  }finally{configureTimelineAdoption(f.db,'legacy');}
 }));
 it('keeps original B after per-order time/route changes and does not repeatedly release cancelled work',()=>run(async()=>{
  const order=await make(),original=await confirm(order,value(order)),next=structuredClone(original.input),line=order.lines[0]!.lineId;
  next.plan=reviseOrderTimePlan(next.plan,{b:duration(24)});
  next.work.push({id:'print:'+line,parameterKey:'printing',stage:4,dependsOn:['a:'+line]});
  next.work.find(work=>work.id==='b:'+line)!.dependsOn=['print:'+line];
  const changed=await confirm(order,next,1);
  for(const scope of original.input.scopes)for(const [id,target]of Object.entries(original.targets[scope.scopeRef]!))expect(changed.targets[scope.scopeRef]![id]).toEqual(target);
  expect(changed.targets['po:'+line]!['print:'+line]!.end.at).toBe('2027-02-27T16:00:00.000Z');
  const removed=structuredClone(changed.input);removed.work=removed.work.filter(work=>work.id!=='print:'+line);removed.work.find(work=>work.id==='b:'+line)!.dependsOn=['a:'+line];
  const cancelled=await confirm(order,removed,2),again=await confirm(order,removed,3);
  expect(cancelled.targets).toEqual(again.targets);expect(cancelled.targets['po:'+line]!['print:'+line]).toEqual(changed.targets['po:'+line]!['print:'+line]);
  const incompleteOrder=await make(),incompleteOriginal=await confirm(incompleteOrder,value(incompleteOrder)),pending=structuredClone(incompleteOriginal.input),otherLine=incompleteOrder.lines[0]!.lineId;
  pending.plan=reviseOrderTimePlan(pending.plan,{b:{...duration(24),minutes:null}});
  pending.work.push({id:'print:'+otherLine,parameterKey:'printing',stage:4,dependsOn:['a:'+otherLine]});pending.work.find(work=>work.id==='b:'+otherLine)!.dependsOn=['print:'+otherLine];
  const unknown=await confirm(incompleteOrder,pending,1),stored=(await new OrderTimePlanRepository(f.db).current(unknown.resource))!;
  expect(stored.targets['po:'+otherLine]!['print:'+otherLine]!.end.at).toBeNull();
  expect(stored.targets['po:'+otherLine]!['b:'+otherLine]).toEqual(incompleteOriginal.targets['po:'+otherLine]!['b:'+otherLine]);
 }));
 it('rejects company replacement, unapproved H and another order PO instead of guessing a fallback',()=>run(async()=>{
  const a=await make(),b=await make(),original=await confirm(a,value(a)),next=structuredClone(original.input);
  next.plan.company.nodes.a=duration(1);await expect(confirm(a,next,1)).rejects.toThrow('原标准');
  const h=structuredClone(original.input);h.scopes[0]!.customerGoal={precision:'date',value:'2027-03-02',source:'TEST arbitrary date'};await expect(confirm(a,h,1)).rejects.toThrow('批准改期');
  const source=structuredClone(original.input);source.scopes[0]!.customerGoal={precision:'date',value:'2027-03-01',source:'TEST forged same-date approval'};await expect(confirm(a,source,1)).rejects.toThrow('批准改期');
  const terminal=structuredClone(original.input),scope=terminal.scopes[0]!,id=scope.customerGoalIds[0]!;scope.goals[id]={precision:'date',value:'2027-03-01',source:'TEST forged terminal approval'};await expect(confirm(a,terminal,1)).rejects.toThrow('批准改期');
  const precision=structuredClone(original.input);precision.scopes[0]!.customerGoal={precision:'instant',value:'2027-03-01T16:00:00.000Z',source:'TEST same boundary but different precision'};await expect(confirm(a,precision,1)).rejects.toThrow('批准改期');
  const other=structuredClone(original.input);other.scopes[0]!.lineId=b.lines[0]!.lineId;await expect(confirm(a,other,1)).rejects.toThrow();
  expect((await new OrderTimePlanRepository(f.db).current(original.resource))!.revision).toBe(1);
 }));
 it('rolls back both the version and its same-transaction dirty registration',()=>run(async()=>{
  const order=await make(),resource={kind:'order' as const,id:order.productionOrderId},before=(await f.db.query('SELECT * FROM digital_journey_fact_changes WHERE resource_kind=\'order\' AND resource_id=$1',[order.productionOrderId])).rows;
  await expect(tx(async db=>{await new OrderTimePlanRepository(db).confirm({resource,expectedRevision:0,value:value(order),actorId:f.root.actorId,eventRef:'TEST rolled back',time:await new ContextBusinessClock(f.db,db).read(resource),requestKey:randomUUID()});throw Error('TEST rollback');})).rejects.toThrow('TEST rollback');
  expect(await new OrderTimePlanRepository(f.db).current(resource)).toBeNull();expect((await f.db.query('SELECT * FROM digital_journey_fact_changes WHERE resource_kind=\'order\' AND resource_id=$1',[order.productionOrderId])).rows).toEqual(before);
 }));
 it('uses the policy effective at each original H approval, preserving the sibling PO and prior revisions',async()=>{
  const {order,first,changed}=await run(async()=>{const order=await make(),first=await confirm(order,value(order)),input=structuredClone(first.input);input.plan=reviseOrderTimePlan(input.plan,{b:duration(24)});return {order,first,changed:await confirm(order,input,1)};});
  // A future company standard is a real publication, outside the fixed test clock.
  await tx(async db=>{const current=await new SlaConfigurationRepository(db).initialStandard(f.root.actorId),values=structuredClone(current.values);values.garment_packing={kind:'duration',minutes:180};await new SlaConfigurationService().publishNewStandard(db,f.root,{expectedVersion:current.version,values,reason:'TEST future company does not enter old order policy',requestKey:randomUUID()});});
  await run(async()=>{
   const dates=new PoCustomerDateService(f.db),line=order.lines[0]!.lineId,scope='po:'+line,sibling='po:'+order.lines[1]!.lineId;
   const move=async(date:string)=>{const sheet=await dates.read(f.root,order.productionOrderId),version=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[order.productionOrderId])).rows[0].version;const request=await dates.request(f.root,order.productionOrderId,{orderVersion:version,changes:[{lineId:line,date,expectedVersion:sheet.customerPoDates.find(po=>po.lineId===line)!.version}],reason:'TEST original approved H path'},randomUUID()) as {requestId:string};await dates.decide(f.root,order.productionOrderId,request.requestId,true,randomUUID());};
   await move('2027-03-02');const h1=(await new OrderTimePlanRepository(f.db).current(first.resource))!;
   expect(h1.input.plan).toEqual(changed.input.plan);expect(h1.targets[scope]!['a:'+line]!.start.at).toBe('2027-02-26T16:00:00.000Z');expect(h1.targets[sibling]).toEqual(first.targets[sibling]);
   const newer=structuredClone(h1.input);newer.plan=reviseOrderTimePlan(newer.plan,{b:duration(72)});await confirm(order,newer,h1.revision);
   await move('2027-03-03');const h2=(await new OrderTimePlanRepository(f.db).current(first.resource))!;
   expect(h2.targets[scope]!['a:'+line]!.start.at).toBe('2027-02-25T16:00:00.000Z');
   expect((await f.db.query('SELECT fixed_targets FROM digital_order_time_plan_versions WHERE plan_version_id=$1',[h1.id])).rows[0].fixed_targets).toEqual(h1.targets);
   expect((await f.db.query('SELECT 1 FROM digital_order_time_plan_versions WHERE production_order_id=$1',[order.productionOrderId])).rowCount).toBe(5);
  });
 });
 it('rejects a stale competing confirmation without overwriting the winner',()=>run(async()=>{
  const order=await make(),first=await confirm(order,value(order)),a=structuredClone(first.input),b=structuredClone(first.input);a.plan=reviseOrderTimePlan(a.plan,{b:duration(24)});b.plan=reviseOrderTimePlan(b.plan,{b:duration(12)});
  const results=await Promise.allSettled([confirm(order,a,1),confirm(order,b,1)]);
  expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(results.filter(row=>row.status==='rejected')).toHaveLength(1);
  expect((await new OrderTimePlanRepository(f.db).current(first.resource))!.revision).toBe(2);
 }));
 it('does not alter an existing native task clock or completion when confirming a new policy',()=>run(async()=>{
  const x=await f.bulkReady('无'),order=await new DigitalProductionIdentityService(f.db,true).read(f.root,x.id);
  const read=()=>f.db.query(`SELECT t.task_id,t.entered_at,t.completed_at,(SELECT jsonb_agg(to_jsonb(d) ORDER BY revision_id) FROM digital_production_deadline_revisions d WHERE d.task_id=t.task_id) AS deadline_history FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 OR a.source_id=$2 ORDER BY t.task_id`,[order.productionOrderId,x.sourceId]);
  const before=(await read()).rows;expect(before.some(row=>row.entered_at)).toBe(true);
  const initial=await confirm(order,value(order)),next=structuredClone(initial.input);next.plan=reviseOrderTimePlan(next.plan,{a:duration(1),b:duration(1)});await confirm(order,next,1);
  expect((await read()).rows).toEqual(before);
 }));
});
