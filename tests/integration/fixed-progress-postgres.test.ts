import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {FixedTimelineAdoptionRepository} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {businessNow,ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('fixed progress original native scope, readonly selection and owned PG13',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,scene:string,ready:Awaited<ReturnType<Awaited<ReturnType<typeof businessAnchorFixture>>['bulkReady']>>;
 const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
 beforeAll(async()=>{f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-10T08:00:00.123Z');configureTimelineAdoption(f.db,'fixed_v2');try{ready=await run(()=>f.bulkReady('无',undefined,2));}finally{configureTimelineAdoption(f.db,'legacy');}});
 afterAll(async()=>{await f?.dispose();});
 it('does not write targets in GET, builds with original worker and exposes the same perPO fixed targets in plain and cockpit reads',()=>run(async()=>{
  const query=new DigitalJourneyQuery(f.db),before=Number((await f.db.query('SELECT count(*)::int n FROM digital_timeline_target_revisions')).rows[0].n);
  const pending=await query.read(f.root,ready.id,undefined,true);expect(pending.fixedSchedule?.state).toBe('unknown');expect(Number((await f.db.query('SELECT count(*)::int n FROM digital_timeline_target_revisions')).rows[0].n)).toBe(before);
  const built=await new JourneyFactRepository(f.db).buildOne({kind:'order',id:ready.id});expect(built.model.fixedSchedule?.scopes).toHaveLength(2);
  const plain=await query.read(f.root,ready.id),cockpit=await query.read(f.root,ready.id,undefined,true);expect(plain.fixedSchedule).toEqual(cockpit.fixedSchedule);expect(cockpit.fixedSchedule?.legacyOverdue).toBe(false);
  const adopted=(await new FixedTimelineAdoptionRepository(f.db).currentTargets({kind:'order',id:ready.id}))!;
  for(const scope of cockpit.fixedSchedule!.scopes){const target=adopted.scopes.find(row=>row.scope_ref===scope.scopeRef)!;expect(scope.targetRevision).toContain(String(target.revision));for(const node of scope.nodes.filter(node=>!node.id.startsWith('source:')))expect(node.goalDelta.targetAt).toBe(target.targets_json.find((value:{id:string})=>value.id===node.id)?.end.at??null);}
  expect((await f.db.query('SELECT selection_json,selection_full_json FROM digital_journey_fact_models WHERE resource_id=$1',[ready.id])).rows[0]).toMatchObject({selection_json:{version:'journey-selection-v2'},selection_full_json:{version:'journey-selection-v2'}});
  for(const value of ['authorizationCapabilities','budgetTotal','actorRoles','styleImageUrl'])expect(JSON.stringify(built.model.fixedSchedule)).not.toContain(value);
  const task=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind IN ('bulk_cutting','bulk_cutting_external')",[ready.id])).rows[0];
  const taskDto=await new DigitalProductionTaskService(f.db).read(f.root,task.task_id);
  expect(taskDto.plannedTargets?.targets).toHaveLength(2);
  // This native fixture did not adopt a planning duration for factory work.
  // Its unbounded downstream window leaves cutting B unknown, while D exists.
  expect(taskDto.plannedTargets?.state).toBe('pending');
  expect(taskDto.plannedTargets?.targets.every(target=>target.endAt===null)).toBe(true);
  for(const target of taskDto.plannedTargets!.targets){const node=cockpit.fixedSchedule!.scopes.find(scope=>scope.lineId===target.lineId)!.nodes.find(node=>node.id==='bulk_cutting')!;expect(target.endAt).toBe(node.goalDelta.targetAt);}
  expect(taskDto.dueAt).not.toBeNull();
 }));
 it('keeps original legacy overdue KPI independent from unknown new progress and full-range filter counts',()=>run(async()=>{
  const query=new DigitalJourneyQuery(f.db),filter=JourneyFilterSchema.parse({scope:'production'}),all=await query.list(f.root,filter),selected=await query.list(f.root,JourneyFilterSchema.parse({...filter,progress:'unknown'}));
  expect(all.summary.overdue).toBe(0);expect(all.summary.scheduleUnknown).toBe(1);expect(selected.total).toBe(1);expect(selected.items[0]!.id).toBe(ready.id);expect(selected.summary.all).toBe(all.summary.all);expect(selected.summary.overdue).toBe(0);
 }));
 it('permits coherent v1 selector writes during rolling update but never serves them as the current v2 calculation',()=>run(async()=>{
  const db=await f.db.connect();try{
   await db.query('BEGIN');
   await db.query("UPDATE digital_journey_fact_models SET selection_json=jsonb_set(selection_json,'{version}','\"journey-selection-v1\"'),selection_full_json=jsonb_set(selection_full_json,'{version}','\"journey-selection-v1\"') WHERE resource_id=$1",[ready.id]);
   const time=await new ContextBusinessClock(f.db,db).read({kind:'order',id:ready.id}),rows=await new JourneyFactRepository(f.db).readSelectionsWithClient(db,[{kind:'order',id:ready.id}],time.now),old=rows.items.get(`order:${ready.id}`)!;
   expect(old.status).toBe('pending');expect(old.facts).toBeNull();
   await expect(db.query("UPDATE digital_journey_fact_models SET selection_json=jsonb_set(selection_json,'{version}','\"journey-selection-v2\"') WHERE resource_id=$1",[ready.id])).rejects.toMatchObject({code:'23514'});
  }finally{await db.query('ROLLBACK');db.release();}
 }));
 it('captures each actual PO cut in its original transaction and corrects only that scope, without changing the shared task completion',async()=>{
  const cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[ready.caseId])).rows,cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  const record=async(index:number)=>run(async()=>ready.cutting.record(cutter,cuts[index]!.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID()));
  await f.advance(scene,'2026-11-10T09:00:00.000Z');await record(0);
  const query=new DigitalJourneyQuery(f.db),first=await run(()=>query.read(f.root,ready.id,undefined,true)),firstLine=first.lines[0]!.id;
  expect(first.fixedSchedule!.scopes.find(scope=>scope.lineId===firstLine)!.nodes.find(node=>node.id==='bulk_cutting')).toMatchObject({businessCompleted:true,goalDelta:{actual:{precision:'instant',at:'2026-11-10T09:00:00.000Z'}}});
  expect(first.fixedSchedule!.scopes.find(scope=>scope.lineId!==firstLine)!.nodes.find(node=>node.id==='bulk_cutting')!.businessCompleted).toBe(false);
  await f.advance(scene,'2026-11-10T11:00:00.000Z');await record(1);
  const events=(await f.db.query("SELECT event_id,task_id,occurred_at,payload FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='cutting_scope_completed' ORDER BY occurred_at",[ready.id])).rows;expect(events).toHaveLength(2);
  const service=new DigitalProductionTaskService(f.db);await run(()=>service.correctTime(f.root,events[0]!.task_id,{eventId:events[0]!.event_id,occurredAt:'2026-11-10T09:30:00.000Z',reason:'TEST original Root correction applies only to first PO occurrence'},randomUUID()));
  expect(new Date((await f.db.query('SELECT completed_at FROM digital_production_tasks WHERE task_id=$1',[events[0]!.task_id])).rows[0].completed_at).toISOString()).toBe('2026-11-10T11:00:00.000Z');
  const corrected=await run(()=>query.read(f.root,ready.id,undefined,true));expect(corrected.fixedSchedule!.scopes.map(scope=>scope.nodes.find(node=>node.id==='bulk_cutting')!.goalDelta.actual)).toEqual([{precision:'instant',at:'2026-11-10T09:30:00.000Z'},{precision:'instant',at:'2026-11-10T11:00:00.000Z'}]);
 });
 it('includes a real native approved rework as zero original budget with its own assignment SLA and immutable handoff target',()=>run(async()=>{
  configureTimelineAdoption(f.db,'fixed_v2');let repair:Awaited<ReturnType<typeof f.reworkReady>>;try{repair=await f.reworkReady();}finally{configureTimelineAdoption(f.db,'legacy');}
  const built=await new JourneyFactRepository(f.db).buildOne({kind:'order',id:repair.ready.id}),scope=built.model.fixedSchedule!.scopes[0]!,added=scope.work.find(work=>work.canonicalWorkRef===`rework:${repair.id}`)!;
  expect(added).toBeDefined();expect(added).toMatchObject({accountingRole:'added_work',responsibilityMinutes:2880,originalHandoffAt:scope.work.find(work=>work.id===`garment_packing:${scope.lineId}`)!.start});expect(scope.facts[added.id]!.clockStart.precision).toBe('instant');expect(scope.facts[added.id]!.evidenceRefs.some(ref=>ref.startsWith('operation_events:'))).toBe(true);
  expect(scope.work.find(work=>work.id===`garment_packing:${scope.lineId}`)!.dependsOn).toContain(added.id);
  const targets=(await f.db.query("SELECT goal_anchor,targets_json FROM digital_timeline_target_revisions WHERE adoption_id=(SELECT adoption_id FROM digital_timeline_adoptions WHERE production_order_id=$1) AND scope_ref LIKE '%:rework:%'",[repair.ready.id])).rows;expect(targets).toHaveLength(1);expect(targets[0].goal_anchor.originalHandoff.start.at).toBe(added.originalHandoffAt);
  const before=JSON.stringify(targets);await new JourneyFactRepository(f.db).buildOne({kind:'order',id:repair.ready.id});expect(JSON.stringify((await f.db.query("SELECT goal_anchor,targets_json FROM digital_timeline_target_revisions WHERE adoption_id=(SELECT adoption_id FROM digital_timeline_adoptions WHERE production_order_id=$1) AND scope_ref LIKE '%:rework:%'",[repair.ready.id])).rows)).toBe(before);
 }));
 it('keeps native cancellation Z and elapsed time fixed on later reads without manufacturing final delivery',async()=>{
  await f.advance(scene,'2026-11-10T12:00:00.456Z');await run(()=>new DigitalProductionTaskService(f.db).controlResource(f.root,{kind:'order',id:ready.id},'cancel','TEST native stop, not physical delivery',randomUUID()));
  const query=new DigitalJourneyQuery(f.db),first=await run(()=>query.read(f.root,ready.id,undefined,true));expect(first.fixedSchedule?.state).toBe('terminated');expect(first.fixedSchedule?.durationSummary.finalActualSpanMinutes).toBeNull();expect(first.fixedSchedule?.scopes.flatMap(scope=>scope.nodes).filter(node=>!node.businessCompleted).every(node=>node.goalDelta.kind==='terminated')).toBe(true);
  await f.advance(scene,'2026-11-20T10:00:00.456Z');const later=await run(()=>query.read(f.root,ready.id,undefined,true));expect(later.fixedSchedule?.durationSummary.elapsedSpanMinutes).toEqual(first.fixedSchedule?.durationSummary.elapsedSpanMinutes);expect(later.fixedSchedule?.durationSummary.observationAt).toBe('2026-11-10T12:00:00.456Z');expect(later.display?.mainState).toBe('cancelled');
 });
 it('keeps native production completion and shipment dates distinct from earlier QC and audit timestamps',async()=>{
  const ownScene=await f.scene('2026-11-21T08:00:00.000Z'),ownRun=<T,>(action:()=>Promise<T>)=>f.runtime.run(ownScene,f.root,action);
  await ownRun(async()=>{
   configureTimelineAdoption(f.db,'fixed_v2');let made:Awaited<ReturnType<typeof f.bulkReady>>;try{made=await f.bulkReady('无');}finally{configureTimelineAdoption(f.db,'legacy');}
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[made.caseId])).rows[0],cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await made.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db);let state=await flow.read(f.root,made.id);state=await flow.dispatch(f.root,made.id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST original physical dispatch'},randomUUID());
   const lineId=state.lines[0]!.lineId,query=new DigitalJourneyQuery(f.db);
   await flow.productionQc(f.root,made.id,{expectedRevision:state.revision,factoryDecisionId:null,occurredAt:businessNow().toISOString(),checks:[{lineId,result:'合格',problem:''}],note:'TEST QC is not production completion'},randomUUID());
   await new JourneyFactRepository(f.db).buildOne({kind:'order',id:made.id});
   let detail=await query.read(f.root,made.id,undefined,true);expect(detail.fixedSchedule!.scopes[0]!.nodes.find(node=>node.id===`factory_work:${lineId}`)!.businessCompleted).toBe(false);
   const productionId=(await f.db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1',[made.caseId])).rows[0].production_order_id,reports=new ProductionReportingService(f.db);
   await reports.report(f.root,productionId,{position:1,businessDate:'2026-11-21',quantity:10},randomUUID());
   await reports.execute(f.root,productionId,'complete',{businessDate:'2026-11-21',confirmed:true},randomUUID());
   await reports.execute(f.root,productionId,'ship',{businessDate:'2026-11-21',confirmed:true},randomUUID());
   detail=await query.read(f.root,made.id,undefined,true);
   expect(detail.fixedSchedule!.scopes[0]!.nodes.find(node=>node.id===`factory_work:${lineId}`)).toMatchObject({businessCompleted:true,goalDelta:{actual:{precision:'date',date:'2026-11-21'}}});
   const built=await new JourneyFactRepository(f.db).buildOne({kind:'order',id:made.id}),returned=built.model.fixedSchedule!.scopes[0]!.facts[`return_logistics:${lineId}`]!;
   expect(returned.ready).toEqual({precision:'date',date:'2026-11-21'});expect(returned.completed).toEqual({precision:'unknown'});expect(returned.businessCompleted).toBe(false);
  });
 });
});
