import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JOURNEY_FACT_CALCULATION_VERSION,journeyFactFingerprint} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {evaluateSlaPlan} from '@dx-rework/domain/digital-sla-plan';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('PERF01 original single-mother facts in owned PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,repo:JourneyFactRepository,identity:DigitalProductionIdentityService,scene:string;
 const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
 const make=(count=2)=>identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-FACT-'+randomUUID(),orderDate:'2026-11-08',primaryMerchandiserId:f.people.merchandiser!.actorId,
  lines:Array.from({length:count},(_,i)=>({formalPoNo:'TEST-FACT-PO-'+i,color:'TEST色'+i,customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}))}),randomUUID());
 beforeAll(async()=>{f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-08T00:00:00.000Z');repo=new JourneyFactRepository(f.db);identity=new DigitalProductionIdentityService(f.db,true);});
 afterAll(async()=>{await f?.dispose();});
 it('builds exactly one native mother, retains both PO, is stable and does not switch ordinary reads',()=>run(async()=>{
  const order=await make(),other=await make(1),query=new DigitalJourneyQuery(f.db);
  const before=await query.read(f.root,order.productionOrderId,undefined,true),built=await repo.buildOne({kind:'order',id:order.productionOrderId});
  expect(built.model.orderId).toBe(order.productionOrderId);expect(built.model.quantities?.lines.map(l=>l.lineId)).toEqual(order.lines.map(l=>l.lineId));
  expect(built.model.quantities?.lines.map(l=>l.demand)).toEqual([10,10]);expect(built.model.quantities?.lines.every(l=>l.packed===null)).toBe(true);
  expect(built.model.nodes.some(n=>n.key==='development_pattern'&&n.progressApplicability==='unknown')).toBe(true);
  expect((await f.db.query('SELECT resource_id FROM digital_journey_fact_models')).rows).toEqual([{resource_id:order.productionOrderId}]);
  expect(JSON.stringify(built.model)).not.toContain(other.productionOrderId);
  const repeated=await repo.buildOne({kind:'order',id:order.productionOrderId});expect(repeated.sourceFingerprint).toBe(built.sourceFingerprint);expect(repeated.sourceVersion).toBe('1');
  const after=await query.read(f.root,order.productionOrderId,undefined,true);
  // This original audit-log observation intentionally uses real time, not the
  // business scenario. Every business value still compares byte-for-byte.
  if(before.operationLog&&after.operationLog)after.operationLog.asOf=before.operationLog.asOf;expect(after).toEqual(before);
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
  const displayIds=new Set(original.supervision!.nodes.map(n=>n.id));
  expect(evaluated.filter(n=>displayIds.has(n.id)).map(n=>({id:n.id,target:n.deadline,actual:n.actualEnd,status:n.status}))).toEqual(original.supervision!.nodes.map(n=>({id:n.id,target:n.target,actual:n.actualEnd,status:n.status})));
  const json=JSON.stringify(model);for(const forbidden of ['authorizationCapabilities','canExecute','canClose','canOpenWages','styleImageUrl','wageItemCount','unitPrice','/api/','/ui/'])expect(json).not.toContain(forbidden);
 }));
 it('retains a source-only unknown route without inventing production obligations or event times',()=>run(async()=>{
  const source=await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:'TEST-FACT-SOURCE-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const built=await repo.buildOne({kind:'source',id:source.sourceId});expect(built.model.orderId).toBeNull();expect(built.model.quantities).toBeNull();
  expect(built.model.requirements.every(r=>r.stage==='development')).toBe(true);expect(built.model.nodes.filter(n=>n.key==='development_pattern').every(n=>n.actualAt===null&&n.enteredAt===null)).toBe(true);
  expect(built.model.requirements.some(r=>r.applicability==='unknown')).toBe(true);
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
});
