import {orderTimePolicyHistory} from '../../apps/api/src/production-platform/order-time-native-timing.js';
import {orderTimeCompletionTarget} from '../../apps/api/src/production-platform/order-time-completion-target.js';
import {arrangedOrderTimeTarget} from '../../apps/api/src/production-platform/framework-node-targets.js';
import {fixedGoalDelta} from '../../apps/api/src/production-platform/fixed-schedule-progress.js';
import {evaluateTimeFrameworkCandidate,freezeTimeFrameworkCandidate,initialFrameworkMilestoneStandard} from '../../apps/api/src/production-platform/order-time-framework.js';
import {readTimeFrameworkPlan,type TimeFrameworkInput} from '@dx-rework/contracts/order-time-framework';
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
 const make=(date='2027-03-01')=>new DigitalProductionIdentityService(f.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-R504-'+randomUUID(),orderDate:'2026-11-09',primaryMerchandiserId:f.people.merchandiser!.actorId,
  lines:[0,1].map(index=>({formalPoNo:'TEST-R504-'+randomUUID(),color:index?'白':'黑',customerWarehouseArrivalDate:date,sizes:[{size:'M',quantity:10}]}))}),randomUUID());
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
 it('preserves a sibling PO formal target across scoped arrangement and later native PO approval',async()=>{
  const own=await f.scene('2027-02-01T00:00:00.000Z');
  const inScene=<T,>(action:()=>Promise<T>)=>f.runtime.run(own,f.root,action);
  const {order,initial,planned,sibling,changed,line}=await inScene(async()=>{
   const order=await make(),input=value(order),initial=await confirm(order,input);
   const [changed,sibling]=initial.input.scopes,line=order.lines[0]!.lineId;
   const proposal:OrderTimeInput={...input,formalInputs:{version:'approved-remaining-v1',progress:{},notBefore:{
    ['b:'+sibling!.lineId]:{precision:'instant',value:'2027-02-04T00:00:00.000Z',source:'TEST true independent sibling condition'}}}};
   const planned=await confirm(order,proposal,initial.revision);
   expect(planned.input.formalTargets?.[changed!.scopeRef]?.[changed!.terminalIds[0]!]?.end.at).toBe('2027-02-06T00:00:00.000Z');
   expect(planned.input.formalTargets?.[sibling!.scopeRef]?.[sibling!.terminalIds[0]!]?.end.at).toBe('2027-02-07T00:00:00.000Z');
   return {order,initial,planned,sibling:sibling!,changed:changed!,line};
  });
  const saved=async(id:string)=>(await f.db.query('SELECT input_snapshot,fixed_targets FROM digital_order_time_plan_versions WHERE plan_version_id=$1',[id])).rows[0];
  const old=await saved(planned.id),siblingP=planned.input.formalTargets![sibling.scopeRef],siblingTerminal=sibling.terminalIds[0]!;
  await f.advance(own,'2027-02-03T00:00:00.000Z');
  await inScene(async()=>{
   const repo=new OrderTimePlanRepository(f.db),proposal=structuredClone(planned.input);
   proposal.formalInputs!.notBefore={...proposal.formalInputs!.notBefore,['a:'+line]:{precision:'instant',value:'2027-02-08T00:00:00.000Z',source:'TEST one PO changed planning condition'}};
   const scoped=await confirm(order,proposal,planned.revision);
   expect(scoped.input.formalTargets?.[changed.scopeRef]?.[changed.terminalIds[0]!]?.end.at).toBe('2027-02-13T00:00:00.000Z');
   expect(scoped.input.formalTargets?.[sibling.scopeRef]).toEqual(siblingP);
   expect(scoped.targets).toEqual(initial.targets);
   const dates=new PoCustomerDateService(f.db),sheet=await dates.read(f.root,order.productionOrderId);
   const version=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[order.productionOrderId])).rows[0].version;
   const request=await dates.request(f.root,order.productionOrderId,{orderVersion:version,changes:[{lineId:line,date:'2027-03-02',expectedVersion:sheet.customerPoDates.find(po=>po.lineId===line)!.version}],reason:'TEST approve only one customer PO'},randomUUID()) as {requestId:string};
   await dates.decide(f.root,order.productionOrderId,request.requestId,true,randomUUID());
   const approved=(await repo.current(initial.resource))!;
   expect(approved.input.scopes.find(scope=>scope.scopeRef===changed.scopeRef)?.customerGoal).toMatchObject({value:'2027-03-02'});
   expect(approved.input.scopes.find(scope=>scope.scopeRef===sibling.scopeRef)?.customerGoal).toEqual(sibling.customerGoal);
   expect(approved.input.formalTargets).toEqual(scoped.input.formalTargets);
   expect(approved.targets[sibling.scopeRef]).toEqual(initial.targets[sibling.scopeRef]);
   const next=structuredClone(approved.input);delete next.formalInputs;delete next.formalTargets;
   next.work.push({id:'printing:'+line,parameterKey:'printing',stage:4,dependsOn:['a:'+line]});
   next.work.find(work=>work.id==='b:'+line)!.dependsOn=['printing:'+line];
   const key=randomUUID(),followup=await confirm(order,next,approved.revision,key);
   expect(arrangedOrderTimeTarget(followup,sibling.scopeRef,siblingTerminal)).toEqual(siblingP![siblingTerminal]);
   expect(arrangedOrderTimeTarget(followup,changed.scopeRef,changed.terminalIds[0]!)).toBeUndefined();
   expect(await confirm(order,next,approved.revision,key)).toEqual(followup);
   expect(await saved(planned.id)).toEqual(old);
  });
 });
 it('rejects a stale competing confirmation without overwriting the winner',()=>run(async()=>{
  const order=await make(),first=await confirm(order,value(order)),a=structuredClone(first.input),b=structuredClone(first.input);a.plan=reviseOrderTimePlan(a.plan,{b:duration(24)});b.plan=reviseOrderTimePlan(b.plan,{b:duration(12)});
  const results=await Promise.allSettled([confirm(order,a,1),confirm(order,b,1)]);
  expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(results.filter(row=>row.status==='rejected')).toHaveLength(1);
  expect((await new OrderTimePlanRepository(f.db).current(first.resource))!.revision).toBe(2);
 }));
 it('reads the completed target from the original physical day after a real approved PO date change',async()=>{
  const ownScene=await f.scene('2027-02-01T00:00:00.000Z');
  const {order,line,initial,scope,work}=await f.runtime.run(ownScene,f.root,async()=>{
   const order=await make('2027-03-08'),input=value(order),line=order.lines[0]!.lineId;
   for(const scope of input.scopes){scope.customerGoal={precision:'date',value:'2027-03-08',source:'TEST customer date'};scope.goals[scope.customerGoalIds[0]!]=scope.customerGoal;}
   const initial=await confirm(order,input),scope=initial.input.scopes[0]!,work=initial.input.work.find(row=>row.id==='a:'+line)!;
   expect(initial.targets[scope.scopeRef]![work.id]!.end.at).toBe('2027-03-05T16:00:00.000Z');
   return {order,line,initial,scope,work};
  });
  await f.advance(ownScene,'2027-03-09T00:00:00.000Z');
  await f.runtime.run(ownScene,f.root,async()=>{
   const dates=new PoCustomerDateService(f.db),sheet=await dates.read(f.root,order.productionOrderId),orderVersion=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[order.productionOrderId])).rows[0].version;
   const request=await dates.request(f.root,order.productionOrderId,{orderVersion,changes:[{lineId:line,date:'2027-03-12',expectedVersion:sheet.customerPoDates.find(po=>po.lineId===line)!.version}],reason:'TEST completed then approved change'},randomUUID()) as {requestId:string};
   await dates.decide(f.root,order.productionOrderId,request.requestId,true,randomUUID());
   const current=(await new OrderTimePlanRepository(f.db).current(initial.resource))!,history=await orderTimePolicyHistory(f.db,initial.resource);
   expect(current.time.now).toBe('2027-03-09T00:00:00.000Z');
   expect(initial.time.now).toBe('2027-02-01T00:00:00.000Z');
   expect(current.targets[scope.scopeRef]![work.id]!.end.at).toBe('2027-03-09T16:00:00.000Z');
   const actual={precision:'instant' as const,at:'2027-03-06T16:00:00.000Z'},target=orderTimeCompletionTarget(work,scope,actual,history,ownScene)!;
   expect(target).toMatchObject({end:'2027-03-05T16:00:00.000Z',targetRevision:initial.id+':1'});
   expect(fixedGoalDelta({...work,canonicalWorkRef:work.id,start:null,end:current.targets[scope.scopeRef]![work.id]!.end.at,minutes:2880,calendar:'continuous',responsibilitySlaRef:null,completionTarget:target},{ready:{precision:'unknown'},clockStart:{precision:'unknown'},completed:actual,businessCompleted:true,waitingForPredecessors:false,evidenceRefs:['TEST physical completion']},{scopeRef:scope.scopeRef,targetRevision:current.id+':2'},'2027-03-10T00:00:00.000Z')).toMatchObject({kind:'late',signedValue:1440,targetRevision:initial.id+':1'});
   expect(current.targets[initial.input.scopes[1]!.scopeRef]).toEqual(initial.targets[initial.input.scopes[1]!.scopeRef]);
   expect(orderTimeCompletionTarget(work,{...scope,lineId:order.lines[1]!.lineId},actual,history,ownScene)).toBeNull();
  });
 });
 it('reads persisted new-format completion targets from the completed version, not the later arrangement',async()=>{
  const ownScene=await f.scene('2027-03-04T00:00:00.000Z');
  const first=await f.runtime.run(ownScene,f.root,async()=>{
   const order=await make('2027-04-20'),input=value(order);
   for(const scope of input.scopes){scope.customerGoal={precision:'date',value:'2027-04-20',source:'TEST original customer date'};scope.goals[scope.customerGoalIds[0]!]=scope.customerGoal;}
   const scope=input.scopes[0]!,work=input.work.filter(row=>row.id.endsWith(':'+scope.lineId));
   const standard=initialFrameworkMilestoneStandard('B','TEST frozen milestone standard',1);
   const frameworkInput:TimeFrameworkInput={scopeRef:scope.scopeRef,route:'B',acceptedAt:{precision:'instant',value:'2027-03-04T00:00:00.000Z',source:'TEST accepted event'},customerDelivery:{date:'2027-04-20',source:'TEST original customer date',revision:1},plan:input.plan,milestoneStandard:standard,work,bindings:Object.entries(standard.offsets).filter(([,offset])=>offset!==null).map(([key])=>({key:key as TimeFrameworkInput['bindings'][number]['key'],workIds:[key==='design_handover'?work[0]!.id:work.at(-1)!.id]})),notBefore:{}};
   const snapshot=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate(frameworkInput,{purpose:'order_proposal',observedAt:'2027-03-04T00:00:00.000Z'}),{reference:'TEST framework history 1',revision:1,previousReference:null,eventRef:'TEST first arrangement'});
   input.frameworkPlans={[scope.scopeRef]:snapshot};
   const saved=await confirm(order,input);
   expect(readTimeFrameworkPlan(saved.input.frameworkPlans![scope.scopeRef])).toEqual({kind:'framework',plan:snapshot});
   expect(snapshot.arranged[0]!.end.at).toBe('2027-03-06T00:00:00.000Z');
   return {order,saved,frameworkInput,scope,work:work[0]!};
  });
  await f.advance(ownScene,'2027-03-09T00:00:00.000Z');
  await f.runtime.run(ownScene,f.root,async()=>{
   const next=structuredClone(first.saved.input);next.plan=reviseOrderTimePlan(next.plan,{a:duration(24)});
   const snapshot=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate({...first.frameworkInput,plan:next.plan},{purpose:'order_proposal',observedAt:'2027-03-09T00:00:00.000Z'}),{reference:'TEST framework history 2',revision:2,previousReference:'TEST framework history 1',eventRef:'TEST approved new arrangement'});
   next.frameworkPlans={[first.scope.scopeRef]:snapshot};
   const current=await confirm(first.order,next,1),history=await orderTimePolicyHistory(f.db,current.resource);
   expect(snapshot.arranged[0]!.end.at).toBe('2027-03-10T00:00:00.000Z');
   // Physical completion supplied to the historical reader is 7th; this test
   // verifies persisted version selection, not recording a fabricated task event.
   const target=orderTimeCompletionTarget(first.work,first.scope,{precision:'instant',at:'2027-03-07T00:00:00.000Z'},history,ownScene)!;
   expect(target).toMatchObject({end:'2027-03-06T00:00:00.000Z',targetRevision:first.saved.id+':1'});
   expect((Date.parse('2027-03-07T00:00:00.000Z')-Date.parse(target.end))/86400000).toBe(1);
   expect(readTimeFrameworkPlan(current.input.frameworkPlans![first.scope.scopeRef])).toEqual({kind:'framework',plan:snapshot});
  });
 });
 it('does not alter an existing native task clock or completion when confirming a new policy',()=>run(async()=>{
  const x=await f.bulkReady('无'),order=await new DigitalProductionIdentityService(f.db,true).read(f.root,x.id);
  const read=()=>f.db.query(`SELECT t.task_id,t.entered_at,t.completed_at,(SELECT jsonb_agg(to_jsonb(d) ORDER BY revision_id) FROM digital_production_deadline_revisions d WHERE d.task_id=t.task_id) AS deadline_history FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 OR a.source_id=$2 ORDER BY t.task_id`,[order.productionOrderId,x.sourceId]);
  const before=(await read()).rows;expect(before.some(row=>row.entered_at)).toBe(true);
  const initial=await confirm(order,value(order)),next=structuredClone(initial.input);next.plan=reviseOrderTimePlan(next.plan,{a:duration(1),b:duration(1)});await confirm(order,next,1);
  expect((await read()).rows).toEqual(before);
 }));
});
