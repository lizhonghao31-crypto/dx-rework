import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JOURNEY_FACT_CALCULATION_VERSION,journeyFactFingerprint,journeyValueFingerprint} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {ContextBusinessClock,businessScopeKey} from '../../apps/api/src/acceptance-clock/business-time.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {evaluateSlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {readJourneySelectionAccess,readTaskAccessForPage} from '../../apps/api/src/production-platform/journey-selection-access.js';
import {readJourneySelections} from '../../apps/api/src/production-platform/journey-selection-query.js';
import {selectJourneySelections,selectJourneys} from '../../apps/api/src/production-platform/journey-projection.js';
import {JOURNEY_NODES,JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {JourneyFactUpdates} from '../../apps/api/src/production-platform/journey-fact-updates.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {nativeTaskReadiness} from '../../apps/api/src/production-platform/task-readiness-facts.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import type {JourneyCompleteResult} from '@dx-rework/contracts/digital-production-journey';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
// The native SQL selector deliberately carries no live action eligibility.
// Compare every structural field here, and check todo on the public list after enrichment.
function reduceSelection(result:Omit<JourneyCompleteResult,'items'>&{items:readonly {id:string}[]}){
 const {todo,...summary}=result.summary;
 return {projection:{...result,summary,items:result.items.map(item=>item.id)},todo};
}
(url?describe.sequential:describe.skip)('PERF01 original single-mother facts in owned PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,repo:JourneyFactRepository,identity:DigitalProductionIdentityService,scene:string;
 const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
 const make=(count=2)=>identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-FACT-'+randomUUID(),orderDate:'2026-11-08',primaryMerchandiserId:f.people.merchandiser!.actorId,
  lines:Array.from({length:count},(_,i)=>({formalPoNo:'TEST-FACT-PO-'+i,color:'TEST色'+i,customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}))}),randomUUID());
 beforeAll(async()=>{f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-08T00:00:00.000Z');repo=new JourneyFactRepository(f.db);identity=new DigitalProductionIdentityService(f.db,true);});
 afterAll(async()=>{await f?.dispose();});
 it('batch-loads live technical and budget read scope with the original per-resource policy for real multi-role fixtures',()=>run(async()=>{
  const order=await make(),source=await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:'TEST-SCOPE-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const resources=[{kind:'order' as const,id:order.productionOrderId},{kind:'source' as const,id:source.sourceId},{kind:'order' as const,id:randomUUID()}];
  const client=await f.db.connect();
  try{
   const policy=new DigitalProductionAccessPolicy(client);
   for(const actor of [f.root,...Object.values(f.people)]){
    const access=await readJourneySelectionAccess(client,actor,resources);
    for(const scope of resources){
     expect(access.resources.get(businessScopeKey(scope))?.technical??false,`${actor.actorRoles.join(',')} ${scope.kind} technical`).toBe(await policy.allowed(actor,scope.kind,scope.id,'technical'));
     expect(access.resources.get(businessScopeKey(scope))?.budget??false,`${actor.actorRoles.join(',')} ${scope.kind} budget`).toBe(await policy.allowed(actor,scope.kind,scope.id,'budget'));
    }
   }
   const primary=f.people.merchandiser!,key=businessScopeKey(resources[0]!);
   expect((await readJourneySelectionAccess(client,primary,resources)).resources.get(key)?.technical).toBe(true);
   const assignment=(await client.query('SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code=$2 AND revoked_at IS NULL',[primary.actorId,'order_merchandiser'])).rows[0]!.assignment_id;
   const admin={...f.root,authorizationCapability:'access:admin'};
   await f.access.revokeRole(admin,assignment,'TEST batch read native eligibility revocation');
   try{
    expect((await readJourneySelectionAccess(client,primary,resources)).resources.get(key)?.technical??false).toBe(await policy.allowed(primary,'order',order.productionOrderId,'technical'));
    expect((await readJourneySelectionAccess(client,primary,resources)).resources.get(key)?.timing).toBe(false);
   }finally{await f.access.assignRole(admin,{userId:primary.actorId,roleCode:'order_merchandiser',reason:'TEST restore fixture role through audited grant'});}
  }finally{client.release();}
 }));
 it('batch-loads only the requested active tasks and matches each original technical, parent and execute decision',()=>run(async()=>{
  const order=await make(),sibling=await make(1);
  const tasks=(await f.db.query<{task_id:string}>(`SELECT task_id FROM digital_production_task_access
   WHERE production_order_id=$1 ORDER BY task_id`,[order.productionOrderId])).rows.map(row=>row.task_id);
  const unrequested=(await f.db.query<{task_id:string}>(`SELECT task_id FROM digital_production_task_access
   WHERE production_order_id=$1 ORDER BY task_id LIMIT 1`,[sibling.productionOrderId])).rows[0]!.task_id;
  expect(tasks.length).toBeGreaterThan(0);
  const missing=randomUUID(),client=await f.db.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const policy=new DigitalProductionAccessPolicy(client),service=new DigitalProductionTaskService(f.db);
   for(const actor of [f.root,...Object.values(f.people)]){
    const page=await readTaskAccessForPage(client,actor,[...tasks,tasks[0]!,missing]);
    expect([...page.keys()].sort()).toEqual([...tasks].sort());expect(page.has(unrequested)).toBe(false);
    const parentTechnical=await policy.allowed(actor,'order',order.productionOrderId,'technical');
    for(const taskId of tasks)expect(page.get(taskId)).toEqual({
     technical:await policy.allowed(actor,'task',taskId,'technical'),execute:await policy.allowed(actor,'task',taskId,'execute'),parentTechnical,
    });
    const details=await service.readPage(actor,[...tasks,tasks[0]!,missing],client);
    expect([...details.keys()]).toEqual(tasks.filter(taskId=>page.get(taskId)?.technical));
    for(const [taskId,detailsFromPage] of details)expect(detailsFromPage).toEqual(await service.read(actor,taskId,client));
   }
   expect(await readTaskAccessForPage(client,f.root,[])).toEqual(new Map());
  }finally{await client.query('ROLLBACK');client.release();}
 }));
 it('builds exactly one native mother, retains both PO, is stable and does not switch ordinary reads',()=>run(async()=>{
  const order=await make(),other=await make(1),query=new DigitalJourneyQuery(f.db);
  const before=await query.read(f.root,order.productionOrderId,undefined,true),built=await repo.buildOne({kind:'order',id:order.productionOrderId});
  expect(built.model.orderId).toBe(order.productionOrderId);expect(built.model.quantities?.lines.map(l=>l.lineId)).toEqual(order.lines.map(l=>l.lineId));
  expect(built.model.quantities?.lines.map(l=>l.demand)).toEqual([10,10]);expect(built.model.quantities?.lines.every(l=>l.packed===0)).toBe(true);
  expect(built.model.nodes.some(n=>n.key==='development_pattern'&&n.progressApplicability==='unknown')).toBe(true);
  expect((await f.db.query('SELECT resource_id FROM digital_journey_fact_models')).rows).toEqual([{resource_id:order.productionOrderId}]);
  expect(JSON.stringify(built.model)).not.toContain(other.productionOrderId);
  const repeated=await repo.buildOne({kind:'order',id:order.productionOrderId});expect(repeated.sourceFingerprint).toBe(built.sourceFingerprint);expect(repeated.sourceVersion).toBe('1');
  const after=await query.read(f.root,order.productionOrderId,undefined,true);
  // This original audit-log observation intentionally uses real time, not the
  // business scenario. Every business value still compares byte-for-byte.
  if(before.operationLog&&after.operationLog)after.operationLog.asOf=before.operationLog.asOf;expect(after).toEqual(before);
 }));
 it('keeps the native order-scoped ship sample current before preparation, through partial PO records and stored reads',()=>run(async()=>{
  const order=await make(),id=order.productionOrderId,query=new DigitalJourneyQuery(f.db),flow=new FactoryFlowService(f.db),primary=f.people.merchandiser!;
  const task=(await f.db.query("SELECT t.* FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind='bulk_ship_sample'",[id])).rows[0]!;
  expect(task.route_instance_id).toBe(id);
  expect((await f.db.query('SELECT 1 FROM digital_bulk_preparations WHERE production_order_id=$1',[id])).rowCount).toBe(0);
  const check=async(sent:0|1|2)=>{
   const completed=sent===2;
   const expectedStatus=['not_started','partial','complete'][sent];
   for(const cockpit of [false,true]){
    const item=await query.read(primary,id,undefined,cockpit),nodes=item.stages.flatMap(stage=>stage.nodes).filter(node=>node.key==='bulk_ship_sample');
    expect(nodes).toHaveLength(1);expect(nodes[0]).toMatchObject({instanceId:task.task_id,current:true,state:completed?'completed':'active'});
    if(!completed){expect(nodes[0]).toMatchObject({enteredAt:null,deadlineMode:'date_target'});expect(nodes[0]!.expectedAt).toBeTruthy();expect(nodes[0]!.risks).not.toContain('unknown');}
    const requirement=item.businessProgress!.requirements.find(row=>row.key==='bulk_ship_sample')!;
    expect(requirement).toMatchObject({applicability:'applicable',completed});
    expect(requirement.reasons.join('')).not.toContain('退役');
    expect(item.visualProgress!.stages.find(stage=>stage.key==='production')!.actualRatio).not.toBeNull();
    if(cockpit)expect(item.cockpitFacts?.shipSample).toMatchObject({status:expectedStatus,scope:'whole'});
   }
   const built=await repo.buildOne({kind:'order',id});
   expect(built.model.nodes.filter(node=>node.key==='bulk_ship_sample')).toEqual([expect.objectContaining({instanceId:task.task_id,current:true,state:completed?'completed':'active'})]);
   expect(built.model.requirements.find(row=>row.key==='bulk_ship_sample')).toMatchObject({applicability:'applicable',completed});
   const listed=await new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}).list(primary,JourneyFilterSchema.parse({scope:'production',search:order.designStyleNo}));
   expect(listed.total).toBe(1);expect(listed.items[0]!.businessProgress!.requirements.find(row=>row.key==='bulk_ship_sample')).toMatchObject({applicability:'applicable',completed});
   expect(listed.items[0]?.cockpitFacts?.shipSample).toMatchObject({status:expectedStatus,scope:'whole'});
  };
  await check(0);
  let state=await flow.read(primary,id);
  const input={expectedRevision:state.revision,kind:'船样寄出' as const,occurredAt:'2026-11-08T00:00:00.000Z',trackingNumber:'TEST-CURRENT-SAMPLE',note:'TEST native order identity'};
  await expect(flow.followup(f.people['pattern-room-worker']!,id,{...input,lineIds:[order.lines[0]!.lineId]},randomUUID())).rejects.toMatchObject({statusCode:404});
  const key=randomUUID();state=await flow.followup(primary,id,{...input,lineIds:[order.lines[0]!.lineId]},key);
  await flow.followup(primary,id,{...input,lineIds:[order.lines[0]!.lineId]},key);
  expect(state.shipSamples).toHaveLength(1);await check(1);
  state=await flow.followup(primary,id,{...input,expectedRevision:state.revision,lineIds:[order.lines[1]!.lineId],trackingNumber:'TEST-CURRENT-SAMPLE-2'},randomUUID());
  expect(state.shipSamples).toHaveLength(2);await check(2);
  expect((await f.db.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='ship_sample_sent'",[id])).rows[0].n).toBe(2);
  expect((await f.db.query('SELECT 1 FROM digital_factory_routes WHERE production_order_id=$1',[id])).rowCount).toBe(0);
  await expect(query.read(f.people['pattern-room-worker']!,id,undefined,true)).rejects.toMatchObject({statusCode:404});
 }));
 it('does not retire the whole-order ship sample when a current production preparation has a different identity',()=>run(async()=>{
  const ready=await f.bulkReady('无',undefined,2),query=new DigitalJourneyQuery(f.db);
  expect(ready.preparationId).not.toBe(ready.id);
  const item=await query.read(f.root,ready.id,undefined,true),sample=item.stages.flatMap(stage=>stage.nodes).filter(node=>node.key==='bulk_ship_sample');
  expect(sample).toHaveLength(1);expect(sample[0]).toMatchObject({current:true,state:'active'});
  expect(item.businessProgress!.requirements.find(row=>row.key==='bulk_ship_sample')).toMatchObject({applicability:'applicable',completed:false});
  const built=await repo.buildOne({kind:'order',id:ready.id});
  expect(built.model.nodes.filter(node=>node.key==='bulk_ship_sample')).toEqual([expect.objectContaining({instanceId:sample[0]!.instanceId,current:true})]);
  expect(built.model.requirements.find(row=>row.key==='bulk_ship_sample')).toMatchObject({applicability:'applicable',completed:false});
  const original=(await f.db.query('SELECT route_instance_id,entered_at,completed_at FROM digital_production_tasks WHERE task_id=$1',[sample[0]!.instanceId])).rows[0]!;
  expect(original.route_instance_id).toBe(ready.id);expect(original.completed_at).toBeNull();
  expect(sample[0]!.enteredAt).toBe(original.entered_at?.toISOString()??null);
 }));
 it('uses original multi-PO preparation, native events, frozen SLA inputs and per-instance deadlines without an actor',()=>run(async()=>{
  const ready=await f.bulkReady('印花',undefined,2),scope={kind:'order' as const,id:ready.id};
  const allowed=vi.spyOn(DigitalProductionAccessPolicy.prototype,'allowed'),role=vi.spyOn(DigitalProductionAccessPolicy.prototype,'activeRole');
  let built;try{built=await repo.buildOne(scope);expect(allowed).not.toHaveBeenCalled();expect(role).not.toHaveBeenCalled();}finally{allowed.mockRestore();role.mockRestore();}
  const original=await new DigitalJourneyQuery(f.db).read(f.root,ready.id,undefined,true),model=built.model;
  expect(model.requirements.map(r=>({key:r.key,completed:r.completed,applicability:r.applicability,targets:r.targets}))).toEqual(original.businessProgress!.requirements.map(r=>({key:r.key,completed:r.completed,applicability:r.applicability,targets:r.targets})));
  const marker=model.nodes.find(n=>n.key==='bulk_marker'&&n.current)!;expect(marker.state).toBe('completed');expect(marker.actualAt).toBeTruthy();
  expect(model.tasks.length).toBeGreaterThan(2);expect(model.tasks.every(t=>t.requiredRole&&t.routeInstanceId)).toBe(true);
  const nativeTasks=(await f.db.query(`SELECT a.task_id,a.task_kind,a.required_role,a.assignee_id,t.route_instance_id FROM digital_production_task_access a
   JOIN digital_production_tasks t USING(task_id) WHERE a.task_kind<>'factory_material_count' AND (a.source_id=$1 OR a.production_order_id=$2) ORDER BY a.task_id`,[ready.sourceId,ready.id])).rows;
  expect(model.tasks.map(t=>t.id)).toEqual(nativeTasks.map(t=>t.task_id));
  const originalSourcing=nativeTasks.find(t=>t.task_kind==='sourcing_preparation')!;expect(originalSourcing).toBeTruthy();
  expect(model.tasks.find(t=>t.id===originalSourcing.task_id)).toMatchObject({kind:'sourcing_preparation',requiredRole:originalSourcing.required_role,assigneeId:originalSourcing.assignee_id,routeInstanceId:originalSourcing.route_instance_id});
  // Native instance identity survives even though the visible link correctly
  // opens the original sourcing case rather than the technical task page.
  const sourcingNode=model.nodes.find(n=>n.current&&n.key==='sourcing_preparation')!;expect(sourcingNode.instanceId).toBe(originalSourcing.task_id);expect(sourcingNode.scopes.some(s=>s.domain==='sourcing')).toBe(true);
  const nativeDependencies=(await f.db.query('SELECT task_id AS "taskId",predecessor_id AS "predecessorId" FROM digital_production_task_dependencies WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,predecessor_id',[model.tasks.map(t=>t.id)])).rows;
  expect(model.dependencies).toEqual(nativeDependencies);expect(model.sla.plan?.nodes.some(n=>n.dependsOn.length>0)).toBe(true);
  for(const task of model.tasks){const n=original.stages.flatMap(s=>s.nodes).find(n=>n.instanceId===task.id);expect(n?.enteredAt).toBe(task.enteredAt);expect(n?.expectedPrecision).toBe(task.dueAt?task.deadlineMode==='date_target'?'date':'instant':'missing');}
  expect(model.sla.plan).not.toBeNull();const evaluated=evaluateSlaPlan(model.sla.plan!,model.sla.facts,{now:'2026-11-08T00:00:00.000Z',scenarioId:scene,revision:1},{mode:'read_projection'});
  const instances=new Map((model.sla.instances??[]).map(instance=>[`${instance.definitionId}:task:${instance.taskId}`,instance]));
  const aggregate=original.supervision!.nodes.filter(node=>!instances.has(node.id)),displayIds=new Set(aggregate.map(n=>n.id));
  expect(evaluated.filter(n=>displayIds.has(n.id)).map(n=>({id:n.id,target:n.deadline,actual:n.actualEnd,status:n.status}))).toEqual(aggregate.map(n=>({id:n.id,target:n.target,actual:n.actualEnd,status:n.status})));
  const native=original.supervision!.nodes.filter(node=>instances.has(node.id));
  expect(native.map(node=>node.id).sort()).toEqual([...instances].filter(([,instance])=>instance.eligible&&model.nodes.some(node=>node.current&&node.state!=='unavailable'&&node.instanceId===instance.taskId&&node.round===instance.round)).map(([id])=>id).sort());
  for(const node of native){
   const instance=instances.get(node.id)!,start=instance.fact.startedAt??null,end=instance.fact.completedAt??null,deadline=instance.deadline.at;
   const past=(at:string)=>deadline!==null&&(instance.deadline.exclusive?Date.parse(at)>=Date.parse(deadline):Date.parse(at)>Date.parse(deadline));
   const status=instance.fact.businessCompleted?!start||!end||!deadline?'completed_unrated':past(end)?'completed_late':'completed_on_time':!start?instance.state==='pending'?'not_started':'unknown':!deadline?'unknown':past(original.asOf!)?'overdue':instance.warningAt&&Date.parse(original.asOf!)>=Date.parse(instance.warningAt)?'warning':'running';
   expect(node).toMatchObject({actualStart:start,actualEnd:end,target:instance.deadline,status});
   expect(instance.sourceId).toBe(ready.sourceId);expect(model.tasks.some(task=>task.id===instance.taskId&&task.routeVersion===instance.round&&task.routeInstanceId===instance.routeRef)).toBe(true);
  }
  const json=JSON.stringify(model);for(const forbidden of ['authorizationCapabilities','canExecute','canClose','canOpenWages','styleImageUrl','wageItemCount','unitPrice','/api/','/ui/'])expect(json).not.toContain(forbidden);
 }));
 it('retains a source-only unknown route without inventing production obligations or event times',()=>run(async()=>{
  const source=await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:'TEST-FACT-SOURCE-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const built=await repo.buildOne({kind:'source',id:source.sourceId});expect(built.model.orderId).toBeNull();expect(built.model.quantities).toBeNull();
  expect(built.model.requirements.every(r=>r.stage==='development')).toBe(true);expect(built.model.nodes.filter(n=>n.key==='development_pattern').every(n=>n.actualAt===null&&n.enteredAt===null)).toBe(true);
  expect(built.model.requirements.some(r=>r.applicability==='unknown')).toBe(true);
  const client=await f.db.connect(),asOf=(await f.runtime.repository.view(scene)).now;
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   for(const actor of [f.root,f.people['sample-designer']!]){
    const original=await new DigitalJourneyQuery(f.db).read(actor,source.sourceId,undefined,true);
    for(const spec of JOURNEY_NODES.filter(node=>!node.planningOnly&&!['creation','development'].includes(node.stage))){
     for(const state of ['not_applicable','unavailable']){
      const filter=JourneyFilterSchema.parse({scope:'development',node:spec.key,state});
      const read=await readJourneySelections(f.db,client,actor,[{source:{source_id:source.sourceId},order:null}],filter,asOf);
      expect(read.items.map(row=>row.status)).toEqual(['ready']);
      const actual=selectJourneySelections(read.items.map(row=>row.selection),filter,asOf),expected=selectJourneys([original],filter,asOf);
      expect({...actual,items:actual.items.map(item=>item.id)},`${actor.actorRoles} ${spec.key} ${state}`).toEqual({...expected,items:expected.items.map(item=>item.id)});
     }
    }
   }
   await client.query('COMMIT');
  }finally{await client.query('ROLLBACK');client.release();}
 }));
 it('refuses missing resources and attached-source aliases without creating partial derived rows',()=>run(async()=>{
  const count=Number((await f.db.query('SELECT count(*) FROM digital_journey_fact_models')).rows[0].count);
  // Original Acceptance clock scope rejects a foreign/nonexistent resource
  // before projection; keep that safety boundary, rather than bypassing it.
  await expect(repo.buildOne({kind:'order',id:randomUUID()})).rejects.toMatchObject({statusCode:409});
  expect(Number((await f.db.query('SELECT count(*) FROM digital_journey_fact_models')).rows[0].count)).toBe(count);
  const order=await make(),source=await identity.createSource(f.root,{developmentType:'头版',designStyleNo:order.designStyleNo,temporaryStyleNo:null,customerCode:'PD'},randomUUID());await identity.attachSource(f.root,order.productionOrderId,source.sourceId,randomUUID());
  await expect(repo.buildOne({kind:'source',id:source.sourceId})).rejects.toMatchObject({statusCode:404});
  expect((await f.db.query('SELECT 1 FROM digital_journey_fact_models WHERE resource_id=$1',[source.sourceId])).rowCount).toBe(0);
 }));
 it('does not return old payloads as current after source or calculation-version drift',()=>run(async()=>{
  const order=await make(),scope={kind:'order' as const,id:order.productionOrderId};await repo.buildOne(scope);const db=await f.db.connect();
  try{
   expect((await repo.readStoredWithClient(db,scope)).status).toBe('ready');
   await db.query('UPDATE digital_journey_fact_models SET source_version=source_version+1 WHERE resource_id=$1',[scope.id]);expect(await repo.readStoredWithClient(db,scope)).toMatchObject({status:'pending',model:null,sourceVersion:'2',appliedSourceVersion:'1'});
   await repo.buildOne(scope);await db.query("UPDATE digital_journey_fact_models SET calculation_version='TEST obsolete mapping' WHERE resource_id=$1",[scope.id]);expect(await repo.readStoredWithClient(db,scope)).toMatchObject({status:'obsolete',model:null});
   await repo.buildOne(scope);expect((await db.query('SELECT calculation_version FROM digital_journey_fact_models WHERE resource_id=$1',[scope.id])).rows[0].calculation_version).toBe(JOURNEY_FACT_CALCULATION_VERSION);
   await db.query("UPDATE digital_journey_fact_models SET source_fingerprint=repeat('0',64) WHERE resource_id=$1",[scope.id]);await expect(repo.readStoredWithClient(db,scope)).rejects.toThrow('fingerprint');
  }finally{db.release();}
 }));
 it('keeps clock revisions isolated and can rebuild from original facts without touching another mother',async()=>{
  const order=await run(()=>make()),scope={kind:'order' as const,id:order.productionOrderId};const built=await run(()=>repo.buildOne(scope));expect(journeyFactFingerprint(built.model)).toBe(built.sourceFingerprint);
  await f.advance(scene,'2026-11-08T01:00:00.000Z');await run(async()=>{const db=await f.db.connect();try{expect(await repo.readStoredWithClient(db,scope)).toMatchObject({status:'pending',model:null});}finally{db.release();}await repo.buildOne(scope);});
 });
 it('publishes lightweight selectors with the same generation and isolates missing, stale, expired and corrupt objects without loading full models',()=>run(async()=>{
  const a=await make(),b=await make(),c=await make(),scopes=[a,b,c].map(order=>({kind:'order' as const,id:order.productionOrderId}));
  await repo.buildOne(scopes[0]!);await repo.buildOne(scopes[1]!);
  const read=async()=>{
   const client=await f.db.connect();let committed=false;
   try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const spy=vi.spyOn(client,'query');
    try{
     const result=await repo.readSelectionsWithClient(client,scopes,(await f.runtime.repository.view(scene)).now);
     expect(spy.mock.calls.filter(call=>String(call[0]).includes('m.selection_json'))).toHaveLength(1);
     expect(spy.mock.calls.some(call=>/\bm\.payload\b|SELECT m\.\*/.test(String(call[0])))).toBe(false);
     await client.query('COMMIT');committed=true;return result.items;
    }finally{spy.mockRestore();}
   }finally{if(!committed)await client.query('ROLLBACK');client.release();}
  };
  const key=(i:number)=>businessScopeKey(scopes[i]!);let found=await read();
  expect(found.get(key(0))).toMatchObject({status:'ready',sourceVersion:'1'});expect(found.get(key(1))?.status).toBe('ready');expect(found.get(key(2))).toMatchObject({status:'missing',facts:null});
  const stored=(await f.db.query('SELECT selection_json,selection_fingerprint,selection_full_json FROM digital_journey_fact_models WHERE resource_id=$1',[a.productionOrderId])).rows[0];
  expect(journeyValueFingerprint(stored.selection_json)).toBe(stored.selection_fingerprint);expect(stored.selection_json.nodes.every((n:{current:boolean})=>n.current)).toBe(true);
  for(const excluded of ['authorizationCapabilities','canExecute','canClose','canOpenWages','styleImageUrl','wageItemCount','unitPrice','/api/','/ui/'])expect(JSON.stringify(stored.selection_json)).not.toContain(excluded);
  expect(Object.keys(stored.selection_full_json).sort()).toEqual(['cancelled','closedAt','frames','version']);
  expect(Buffer.byteLength(JSON.stringify(stored.selection_full_json))).toBeLessThan(Buffer.byteLength(JSON.stringify(stored.selection_json)));
  const invalid=await f.db.connect();try{await invalid.query('BEGIN');
   await expect(invalid.query("UPDATE digital_journey_fact_models SET selection_full_json='{}'::jsonb WHERE resource_id=$1",[a.productionOrderId])).rejects.toMatchObject({code:'23514'});
  }finally{await invalid.query('ROLLBACK');invalid.release();}
  await f.db.query('UPDATE digital_production_po_sizes SET quantity=11 WHERE line_id=$1',[a.lines[0]!.lineId]);
  found=await read();expect(found.get(key(0))).toMatchObject({status:'pending',facts:null});expect(found.get(key(1))?.status).toBe('ready');await repo.buildOne(scopes[0]!);
  await f.db.query("UPDATE digital_journey_fact_models SET selection_fingerprint=repeat('0',64) WHERE resource_id=$1",[a.productionOrderId]);
  found=await read();expect(found.get(key(0))).toMatchObject({status:'failed',facts:null});expect(found.get(key(1))?.status).toBe('ready');await repo.buildOne(scopes[0]!);
  await f.db.query('UPDATE digital_journey_fact_models SET selection_expires_at=$2 WHERE resource_id=$1',[a.productionOrderId,(await f.runtime.repository.view(scene)).now]);
  found=await read();expect(found.get(key(0))).toMatchObject({status:'pending',facts:null});expect(found.get(key(1))?.status).toBe('ready');await repo.buildOne(scopes[0]!);
  await f.db.query("UPDATE digital_journey_fact_models SET calculation_version='TEST-obsolete-selector' WHERE resource_id=$1",[a.productionOrderId]);
  found=await read();expect(found.get(key(0))).toMatchObject({status:'obsolete',facts:null});expect(found.get(key(1))?.status).toBe('ready');
 }));
 it('reduces full-scope current native selections in PostgreSQL without transporting models or node collections',()=>run(async()=>{
  const a=await make(),b=await make(),orders=[a,b],candidates=orders.map(order=>({source:null,order:{production_order_id:order.productionOrderId}}));
  for(const order of orders)await repo.buildOne({kind:'order',id:order.productionOrderId});
  const query=new DigitalJourneyQuery(f.db),asOf=(await f.runtime.repository.view(scene)).now;
  const expected=await Promise.all(orders.map(order=>query.read(f.root,order.productionOrderId,undefined,true)));
  const client=await f.db.connect();try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   for(const patch of [{},{stage:'preparation'},{node:'packing'},{risk:'overdue'},{missing:'customer_date'},{search:a.designStyleNo},{kpi:'not_started'}]){
    const filter=JourneyFilterSchema.parse({scope:'production',...patch}),read=await readJourneySelections(f.db,client,f.root,candidates,filter,asOf);
    expect(read.items.every(row=>row.status==='ready')).toBe(true);
    expect(read.items.every(row=>row.selection.stages.length===0&&row.selection.actionableTodo===undefined)).toBe(true);
    const actual=selectJourneySelections(read.items.map(row=>row.selection),filter,asOf),original=selectJourneys(expected,filter,asOf);
    expect(actual.summary.todo).toBe(actual.summary.all?null:0);
    expect(reduceSelection(actual).projection).toEqual(reduceSelection(original).projection);
   }
   await client.query('COMMIT');
  }finally{if(client.query)await client.query('ROLLBACK');client.release();}
  const indexed=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'});
  const filter=JourneyFilterSchema.parse({scope:'production',search:a.designStyleNo,kpi:'todo'});
  for(const result of await Promise.all([query.list(f.root,filter),indexed.list(f.root,filter)])){
   expect(result).toMatchObject({total:1,summary:{todo:1},items:[{orderId:a.productionOrderId,actionableTodo:{status:'complete',items:[]}}]});
   expect(result.items[0]!.supervision?.coverage.map(fact=>fact.key)).toEqual(expect.arrayContaining(['factory_date','fabric_date']));
  }
 }));
 it('keeps linked native preparation and partial-role selection identical without sharing full-manager nodes',()=>run(async()=>{
  const ready=await f.bulkReady('无',undefined,2),candidate={source:{source_id:ready.sourceId},order:{production_order_id:ready.id}};
  await repo.buildOne({kind:'order',id:ready.id});
  const query=new DigitalJourneyQuery(f.db),indexed=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'});
  const asOf=(await f.runtime.repository.view(scene)).now,client=await f.db.connect(),differences:unknown[]=[];
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const preparation=new BulkPreparationService(f.db),resource={kind:'order' as const,id:ready.id};
   const complete=await preparation.read(f.root,ready.id,client);
   expect(complete.readiness).toBeDefined();
   const {time}=await new ContextBusinessClock(f.db,client).readObservation(resource,{now:()=>new Date(asOf),mode:'live'});
   const transport=vi.spyOn(client,'query');
   try{
    const {sheet}=await preparation.readJourneyFactsWithClient(ready.id,client,time,f.root);
    expect(sheet.instructionVersion).toBe(complete.instructionVersion);
    expect(sheet.sourceRound).toBe(complete.sourceRound);
    expect(sheet.instructionValid).toBe(complete.instructionValid);
    expect(sheet.customerConfirmed).toBe(complete.customerConfirmed);
    expect(sheet.ownerApproved).toBe(complete.ownerApproved);
    expect(sheet.tasks.map(task=>task.taskId)).toEqual(complete.tasks.map(task=>task.taskId));
    expect(sheet.reasons).toEqual(complete.reasons);
    expect(sheet.cutting.completed).toBe(complete.cutting.completed);
    expect(sheet.cutting.lines).toEqual(complete.cutting.lines.map(({lineId,cuttingOrderId})=>({lineId,cuttingOrderId})));
    expect(sheet.preshrink).toBe(complete.preshrink);
    expect(sheet.readiness?.responsibility).toEqual(complete.readiness?.responsibility);
    const statements=transport.mock.calls.map(([sql])=>typeof sql==='string'?sql:sql.text);
    expect(statements.some(sql=>sql.includes('digital_instruction_deliveries'))).toBe(false);
    expect(statements.some(sql=>sql.includes("event_kind='bulk_materials_dispatched'"))).toBe(false);
   }finally{transport.mockRestore();}
   const actors=[f.root,...['production-management','sample-designer','merchandiser','pattern-room-worker','warehouse','qc','development-clerk'].flatMap(key=>f.people[key]?[f.people[key]!]:[]),
    ...['production-management','merchandiser'].map(key=>({...f.people[key]!,authorizationCapabilities:[],authorizationCapability:'digital_production:view'}))];
   for(const actor of actors){
    const original=await query.read(actor,ready.id,undefined,true).catch(error=>{if(error.statusCode===404)return null;throw error;});
    for(const patch of [{},{stage:'development'},{stage:'preparation'},{node:'sourcing_preparation'},{node:'sourcing_preparation',state:'active'},{state:'active'},{risk:'unknown'},{missing:'scope'}]){
     const filter=JourneyFilterSchema.parse({scope:'production',...patch}),read=await readJourneySelections(f.db,client,actor,[candidate],filter,asOf);
     const expected=selectJourneys(original?[original]:[],filter,asOf),actual=selectJourneySelections(read.items.map(row=>row.selection),filter,asOf);
     expect(read.items.every(row=>row.selection.actionableTodo===undefined)).toBe(true);
     expect(actual.summary.todo).toBe(actual.summary.all?null:0);
     const expectedProjection=reduceSelection(expected).projection,actualProjection=reduceSelection(actual).projection;
     if(JSON.stringify(actualProjection)!==JSON.stringify(expectedProjection))differences.push({roles:actor.actorRoles,filter:patch,expected:expectedProjection,actual:actualProjection});
    }
    if(!original)continue;
    const filter=JourneyFilterSchema.parse({scope:'production',search:ready.id,kpi:'todo'});
    const expected=selectJourneys([original],filter,asOf);
    for(const actual of await Promise.all([query.list(actor,filter),indexed.list(actor,filter)])){
     expect(actual.summary?.todo).toBe(expected.summary.todo);
     expect(actual.total).toBe(expected.summary.todo===null?null:expected.total);
     expect(actual.items.map(item=>item.id)).toEqual(expected.items.map(item=>item.id));
    }
   }
   await client.query('COMMIT');expect(differences).toEqual([]);
  }finally{await client.query('ROLLBACK');client.release();}
 }));

});

(url?describe.sequential:describe.skip)('PERF03 current-page assembly from native PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,scene:string,identity:DigitalProductionIdentityService,repo:JourneyFactRepository;
 let query:DigitalJourneyQuery,legacy:DigitalJourneyQuery;
 const orders:Awaited<ReturnType<DigitalProductionIdentityService['createOrder']>>[]=[];
 const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action),filter=JourneyFilterSchema.parse({scope:'production'});
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-08T00:00:00.000Z');identity=new DigitalProductionIdentityService(f.db,true);repo=new JourneyFactRepository(f.db);
  query=new DigitalJourneyQuery(f.db,{listReadMode:'indexed'});legacy=new DigitalJourneyQuery(f.db);
  await run(async()=>{for(let i=0;i<31;i++)orders.push(await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-PAGE-'+String(i).padStart(2,'0'),orderDate:'2026-11-08',primaryMerchandiserId:f.people.merchandiser!.actorId,
   lines:Array.from({length:i===0?3:2},(_,j)=>({formalPoNo:`TEST-PAGE-PO-${i}-${j}`,color:['黑','白','蓝'][j],customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10+j}]}))}),randomUUID()));
   for(const order of orders)await repo.buildOne({kind:'order',id:order.productionOrderId});});
 });
 beforeEach(()=>vi.restoreAllMocks());
 afterAll(async()=>{vi.restoreAllMocks();await f?.dispose();});
 it('assembles15/15/1 current objects with exact complete totals, KPI, PO, order and native row parity, never building facts in GET',()=>run(async()=>{
  const original=await legacy.list(f.root,filter),originalIds=(await legacy.list(f.root,filter,true)).items.map(item=>item.id);
  const projection=vi.spyOn(query as unknown as {project:(...args:unknown[])=>unknown},'project'),build=vi.spyOn(DigitalJourneyQuery.prototype,'buildFactsWithClient');
  const ids:string[]=[];
  for(const [page,count]of [[1,15],[2,15],[3,1]]){
   projection.mockClear();const result=await query.list(f.root,{...filter,page:page!});
   expect(projection).toHaveBeenCalledTimes(count!);expect(build).not.toHaveBeenCalled();
   expect(result.total).toBe(31);expect(result.summary).toEqual(original.summary);expect(result.facets).toEqual(original.facets);expect(result.items).toHaveLength(count!);
   if(page===1)expect(result.items).toEqual(original.items);
   ids.push(...result.items.map(item=>item.id));
  }
  expect(ids).toEqual(originalIds);expect(new Set(ids).size).toBe(31);
 }));
 it('refuses old totals immediately after a successful native save, then exposes only the rebuilt current PO',()=>run(async()=>{
  const order=orders[0]!,changed='TEST-PAGE-CORRECTED-'+randomUUID();
  await identity.correctNumbers(f.root,order.productionOrderId,order.lines[0]!.lineId,{expectedVersion:order.version,formalPoNo:changed},randomUUID());
  const pending=await query.list(f.root,filter);
  expect(pending).toMatchObject({total:null,summary:null,freshness:{pending:1,failed:0}});expect(pending.items.some(item=>item.id===order.productionOrderId)).toBe(false);
  expect(pending.items.length).toBeGreaterThan(0);
  await new JourneyFactUpdates(f.db,repo).runOnce();const current=await query.list(f.root,{...filter,search:changed});
  expect(current.total).toBe(1);expect('freshness' in current).toBe(false);expect(current.items[0]!.lines[0]!.po).toBe(changed);
 }));
 it('isolates one page object failure and one corrupt selector without presenting false zero totals or aborting other available objects',()=>run(async()=>{
  const originalProject=Reflect.get(query,'project') as (...args:unknown[])=>Promise<unknown>,target=orders[0]!.productionOrderId;
  vi.spyOn(query as unknown as {project:(...args:unknown[])=>Promise<unknown>},'project').mockImplementation(function(...args){
   const candidate=args[2] as {order:{production_order_id:string}|null};if(candidate.order?.production_order_id===target)throw Error('TEST one display object failure');
   return Reflect.apply(originalProject,query,args);
  });
  const reliable=await query.list(f.root,filter); // same selected facts; only the target rich row is unavailable
  expect(reliable).toMatchObject({total:31,page:1,freshness:{failed:1,pending:0,detailsOnly:true,retryIds:[target]}});expect(reliable.items).toHaveLength(14);
  expect(reliable.summary).not.toBeNull();expect(reliable.summary!.all).toBe(31);
  vi.restoreAllMocks();await f.db.query("UPDATE digital_journey_fact_models SET selection_fingerprint=repeat('0',64) WHERE resource_id=$1",[target]);
  try{
   const corrupt=await query.list(f.root,filter);expect(corrupt).toMatchObject({total:null,summary:null,freshness:{failed:1,pending:0,retryIds:[target]}});expect(corrupt.items).toHaveLength(15);
   const builds=vi.spyOn(repo,'buildOne');await query.refreshOne(f.root,target);await query.refreshOne(f.root,target);
   expect(builds).not.toHaveBeenCalled();expect((await f.db.query('SELECT DISTINCT resource_id FROM digital_journey_fact_changes')).rows).toEqual([{resource_id:target}]);
   await new JourneyFactUpdates(f.db,repo).runOnce();expect(builds.mock.calls.map(call=>call[0].id)).toEqual([target]);
  }finally{await repo.buildOne({kind:'order',id:target});}
  expect((await query.list(f.root,filter)).total).toBe(31);
 }));
 it('P01 captures native cutting-gate readiness once and cancellation keeps its real business termination',async()=>{
  const ownScene=await f.scene('2026-11-09T08:00:00.123Z');
  const ready=await f.runtime.run(ownScene,f.root,()=>f.bulkReady('无'));
  const ids=(await f.db.query("SELECT a.task_id FROM digital_production_task_access a WHERE a.production_order_id=$1 AND a.task_kind IN ('bulk_cutting','bulk_cutting_external')",[ready.id])).rows.map(row=>row.task_id as string);
  expect(ids).toHaveLength(1);
  const initial=(await nativeTaskReadiness(f.db,ids)).get(ids[0]!)!;
  expect(initial).toMatchObject({tracked:true,firstReadyAt:'2026-11-09T08:00:00.123Z',quality:'现场登记'});expect(initial.basis).not.toHaveLength(0);
  const taskService=new DigitalProductionTaskService(f.db);
  await f.advance(ownScene,'2026-11-09T10:00:00.456Z');
  await f.runtime.run(ownScene,f.root,()=>taskService.controlResource(f.root,{kind:'order',id:ready.id},'cancel','TEST original cancellation, not delivery',randomUUID()));
  const first=await f.runtime.run(ownScene,f.root,()=>repo.buildOne({kind:'order',id:ready.id}));
  expect(first.model).toMatchObject({cancelled:true,closedAt:null,termination:{kind:'cancelled',at:'2026-11-09T10:00:00.456Z',precision:'instant',scopeRef:`order:${ready.id}`}});
  expect(first.model.nativeReadiness).toContainEqual(initial);
  await f.advance(ownScene,'2026-11-29T10:00:00.456Z');
  const later=await f.runtime.run(ownScene,f.root,()=>repo.buildOne({kind:'order',id:ready.id}));
  expect(later.model.termination).toEqual(first.model.termination);
  expect((await nativeTaskReadiness(f.db,ids)).get(ids[0]!)).toEqual(initial);
 });
 it('P01 special closure records scoped BusinessTime and does not turn outstanding work into delivery A',async()=>{
  const ownScene=await f.scene('2026-11-09T08:00:00.789Z');
  await f.runtime.run(ownScene,f.root,async()=>{
   const ready=await f.bulkReady('无'),closure=new OrderClosureService(f.db);
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,ready.id);
   await flow.dispatch(f.people.warehouse!,ready.id,{expectedRevision:state.revision,occurredAt:'2026-11-09T08:00:00.789Z',supplierId:f.supplierId,note:'TEST original dispatch enters production'},randomUUID());
   const before=await closure.read(f.root,ready.id);
   expect(before.canClose).toBe(true);
   const closed=await closure.close(f.root,ready.id,{expectedRevision:before.revision,reason:'TEST administrative termination preserves outstanding quantities'},randomUUID());
   expect(closed.closed?.closedAt).toBe('2026-11-09T08:00:00.789Z');
   const model=(await repo.buildOne({kind:'order',id:ready.id})).model;
   expect(model.termination).toMatchObject({kind:'special_closure',at:'2026-11-09T08:00:00.789Z',scopeRef:`order:${ready.id}`});
   expect(model.quantities!.lines.some(line=>line.packed===null||line.packed<line.demand!)).toBe(true);
   expect(model.nodes.find(node=>node.key==='packing')?.state).not.toBe('completed');
   expect(model.factoryTimeline).toHaveLength(1);
   expect(model.factoryTimeline![0]).toMatchObject({factoryDecisionId:null,quantity:10,dispatchedAt:'2026-11-09T08:00:00.789Z',completedDate:null,completionTransitionRef:null});
   expect(model.factoryTimeline![0]!.startTransitionRef).toMatch(/^sourcing_production_transitions:/);
  });
 });
 it('P01 native cut references preserve separate PO identities within one style',()=>run(async()=>{
  const ready=await f.bulkReady('无',undefined,2),model=(await repo.buildOne({kind:'order',id:ready.id})).model;
  const original=(await f.db.query(`SELECT c.cutting_order_id,c.sourcing_line_position,c.approval_snapshot_id,l.line_id
   FROM cutting_orders c JOIN digital_production_child_lines l ON l.module='sourcing' AND l.child_id=c.sourcing_case_id AND l.child_line_key=c.sourcing_line_position::text
   WHERE c.sourcing_case_id=$1 ORDER BY c.sourcing_line_position`,[ready.caseId])).rows;
  expect(original).toHaveLength(2);expect(new Set(original.map(row=>row.cutting_order_id)).size).toBe(2);
  expect(model.cutScopes).toEqual(original.map(row=>({lineId:row.line_id,status:'verified',cuts:[{cuttingOrderId:row.cutting_order_id,sourcingCaseId:ready.caseId,
   sourcingLinePosition:row.sourcing_line_position,approvalSnapshotId:row.approval_snapshot_id,sourceLineId:row.line_id}]})));
 }));
});
