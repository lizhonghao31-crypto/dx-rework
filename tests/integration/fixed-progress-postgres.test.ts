import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
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
import {reworkSlaEvidence} from '../../apps/api/src/production-platform/rework-sla-evidence.js';
import {WholeOrderReviewService} from '../../apps/api/src/rework/whole-order-review-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {businessNow,ContextBusinessClock,installAcceptanceClockReader} from '../../apps/api/src/acceptance-clock/business-time.js';
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
 it('keeps a null-scenario trusted reader fixed in the actual adopted v2 projection',async()=>{
  // Create a genuine ordinary-clock order in its own native TEST schema.
  // Re-labelling a guarded scene as ordinary must still fail its original SLA guard.
  const ordinary=await businessAnchorFixture(url!);try{
   configureTimelineAdoption(ordinary.db,'fixed_v2');const made=await ordinary.bulkReady('无');configureTimelineAdoption(ordinary.db,'legacy');await new JourneyFactRepository(ordinary.db).buildOne({kind:'order',id:made.id});
   const live=await new DigitalJourneyQuery(ordinary.db).read(ordinary.root,made.id,undefined,true);expect(live.fixedSchedule?.observationMode).toBe('live');const at=live.asOf!;
   const scoped={query:ordinary.db.query.bind(ordinary.db),connect:ordinary.db.connect.bind(ordinary.db)} as unknown as typeof ordinary.db;
   installAcceptanceClockReader(scoped,{read:async()=>({now:at,scenarioId:null,revision:0}),nativeScenario:async()=>null});
   const item=await new DigitalJourneyQuery(scoped).read(ordinary.root,made.id,undefined,true);expect(item.fixedSchedule).toBeDefined();expect(item.asOf).toBe(at);expect(item.fixedSchedule!.observationMode).toBe('fixed');expect(item.fixedSchedule!.asOf).toBe(at);
  }finally{configureTimelineAdoption(ordinary.db,'legacy');await ordinary.dispose();}
 });
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
  expect((await f.db.query("SELECT 1 FROM digital_journey_fact_changes WHERE resource_kind='order' AND resource_id=$1",[repair.ready.id])).rowCount).toBe(0);
  const before=JSON.stringify(targets);await new JourneyFactRepository(f.db).buildOne({kind:'order',id:repair.ready.id});expect(JSON.stringify((await f.db.query("SELECT goal_anchor,targets_json FROM digital_timeline_target_revisions WHERE adoption_id=(SELECT adoption_id FROM digital_timeline_adoptions WHERE production_order_id=$1) AND scope_ref LIKE '%:rework:%'",[repair.ready.id])).rows)).toBe(before);
 }));
 it('keeps native cancellation Z and elapsed time fixed on later reads without manufacturing final delivery',async()=>{
  await f.advance(scene,'2026-11-10T12:00:00.456Z');await run(()=>new DigitalProductionTaskService(f.db).controlResource(f.root,{kind:'order',id:ready.id},'cancel','TEST native stop, not physical delivery',randomUUID()));
  const query=new DigitalJourneyQuery(f.db),first=await run(()=>query.read(f.root,ready.id,undefined,true));expect(first.fixedSchedule?.state).toBe('terminated');expect(first.fixedSchedule?.durationSummary.finalActualSpanMinutes).toBeNull();expect(first.fixedSchedule?.scopes.flatMap(scope=>scope.nodes).filter(node=>!node.businessCompleted).every(node=>node.goalDelta.kind==='terminated')).toBe(true);
  const stopped=first.supervision!.nodes.filter(node=>node.termination);
  expect(stopped.length).toBeGreaterThan(0);expect(stopped.every(node=>node.status==='terminated'&&node.actualEnd===null&&node.termination?.kind==='cancelled'&&node.termination.at==='2026-11-10T12:00:00.456Z')).toBe(true);
  const retained=(rows:typeof stopped)=>rows.map(({id,status,actualStart,actualEnd,target,termination})=>({id,status,actualStart,actualEnd,target,termination}));
  await f.advance(scene,'2026-11-20T10:00:00.456Z');const later=await run(()=>query.read(f.root,ready.id,undefined,true));expect(later.fixedSchedule?.durationSummary.elapsedSpanMinutes).toEqual(first.fixedSchedule?.durationSummary.elapsedSpanMinutes);expect(later.fixedSchedule?.durationSummary.observationAt).toBe('2026-11-10T12:00:00.456Z');expect(later.display?.mainState).toBe('cancelled');
  expect(retained(later.supervision!.nodes.filter(node=>node.termination))).toEqual(retained(stopped));
  const stored=await run(()=>new JourneyFactRepository(f.db).buildOne({kind:'order',id:ready.id}));
  expect(stored.model.sla.termination).toMatchObject({kind:'cancelled',at:'2026-11-10T12:00:00.456Z'});
  const frames=(await f.db.query('SELECT selection_json FROM digital_journey_fact_models WHERE resource_id=$1',[ready.id])).rows[0].selection_json.frames;
  expect(frames.length).toBeGreaterThan(0);
  const ids=new Set(stopped.map(node=>node.id));
  const instanceIds=new Set(later.stages.flatMap(stage=>stage.nodes).filter(node=>node.timing&&ids.has(node.timing.id)||node.timings?.some(timing=>ids.has(timing.id))).map(node=>node.instanceId));
  for(const frame of frames)expect(frame.risks.filter((node:{id:string})=>instanceIds.has(node.id)).every((node:{risks:string[]})=>!node.risks.includes('overdue')&&!node.risks.includes('due_soon'))).toBe(true);
 });
 it('keeps a real 48-hour rework window finished at 50 hours through later 74-hour quantity review without closing its administration',async()=>{
  const ownScene=await f.scene('2026-12-01T00:00:00.000Z'),ownRun=<T,>(action:()=>Promise<T>)=>f.runtime.run(ownScene,f.root,action);
  const repair=await ownRun(async()=>{configureTimelineAdoption(f.db,'fixed_v2');try{return await f.reworkReady(2);}finally{configureTimelineAdoption(f.db,'legacy');}});
  const windows=(await reworkSlaEvidence(f.db,repair.ready.id)).windows,original=windows.find(window=>window.reworkId===repair.id)!;
  expect(original.startedAt).toBe('2026-12-01T00:00:00.000Z');expect(original.deadline).toBe('2026-12-03T00:00:00.000Z');
  const [first,removed]=repair.state.tasks;expect(repair.state.tasks).toHaveLength(2);
  const adjustment={...f.root,authorizationCapability:'work:assignment_adjust',authorizationCapabilities:['work:assignment_adjust']};
  const reportActor={...f.root,authorizationCapability:'work:report_for_worker',authorizationCapabilities:['work:report_for_worker']};
  await f.advance(ownScene,'2026-12-02T00:00:00.000Z');
  const added=await ownRun(async()=>{
   const member=await f.access.createPerson({...f.root,authorizationCapability:'master_data:manage'},{personType:'temporary',displayName:'TEST返工增补员工',aliases:[],reason:'TEST 原分派后增加执行人员'});
   const roster=await repair.work.addActiveTaskMembers(adjustment,repair.id,{expectedOrderVersion:repair.state.orderVersion,configurationItemId:first!.configurationItemId,memberIds:[member.personId]},randomUUID());
   const added=roster.value.tasks.find(task=>!repair.state.tasks.some(original=>original.workTaskId===task.workTaskId));
   expect(added).toBeDefined();return added!;
  });
  const beforeEnd='2026-12-03T01:00:00.000Z';await f.advance(ownScene,beforeEnd);
  await ownRun(async()=>{
   let current=await repair.work.list(f.root,repair.id);
   await repair.work.submitReport(reportActor,first!.workTaskId,{expectedOrderVersion:current.orderVersion,actualQuantity:5,completedAt:beforeEnd},randomUUID());
   current=await repair.work.list(f.root,repair.id);
   await repair.work.removeActiveTask(adjustment,repair.id,removed!.workTaskId,{expectedOrderVersion:current.orderVersion},randomUUID());
   const partial=(await reworkSlaEvidence(f.db,repair.ready.id)).windows.find(window=>window.reworkId===repair.id)!;
   expect(partial).toMatchObject({complete:false,completedAt:null,assignmentId:original.assignmentId,startedAt:original.startedAt,deadline:original.deadline});
  });
  const completedAt='2026-12-03T02:00:00.000Z';await f.advance(ownScene,completedAt);
  await ownRun(async()=>{
   const current=await repair.work.list(f.root,repair.id);
   await repair.work.submitReport(reportActor,added.workTaskId,{expectedOrderVersion:current.orderVersion,actualQuantity:5,completedAt},randomUUID());
   const item=await new DigitalJourneyQuery(f.db).read(f.root,repair.ready.id,undefined,true),node=item.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='rework'&&node.instanceId===repair.id)!;
   expect(node).toMatchObject({state:'active',sla:'finished',enteredAt:original.startedAt,actualAt:completedAt,completionResult:'late',overdueSeconds:7200,
    nativeWindows:[{evidence:original.evidence,startedAt:original.startedAt,deadline:original.deadline,completedAt,complete:true}]});
   const timing=item.supervision!.nodes.find(node=>node.id==='garment_rework:'+original.lineId)!;
   expect(timing).toMatchObject({status:'completed_late',actualEnd:completedAt});
   expect(timing.windows).toEqual([expect.objectContaining({evidence:original.evidence,startedAt:original.startedAt,deadline:original.deadline,completedAt,complete:true})]);
   expect(item.lines).toHaveLength(2);expect(item.lines.some(line=>line.id!==original.lineId)).toBe(true);
   expect(item.businessProgress!.requirements.find(row=>row.key==='rework')?.completed).toBe(false);
  });
  for(const at of ['2026-12-04T02:00:00.000Z','2026-12-05T02:00:00.000Z']){
   await f.advance(ownScene,at);
   await ownRun(async()=>{const item=await new DigitalJourneyQuery(f.db).read(f.root,repair.ready.id,undefined,true);expect(item.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='rework'&&node.instanceId===repair.id)).toMatchObject({actualAt:completedAt,overdueSeconds:7200});});
  }
  await f.advance(ownScene,'2026-12-06T02:00:00.000Z');
  await ownRun(async()=>{
   const review=new WholeOrderReviewService(f.db),actor={...f.root,authorizationCapability:'submission:audit'},before=await review.get(actor,repair.id);
   await review.approve(actor,repair.id,{expectedOrderVersion:before.orderVersion,temporaryCoefficients:before.temporaryWorkers.map(worker=>({configurationItemId:worker.configurationItemId,personId:worker.personId,multiplier:1}))},randomUUID());
   const item=await new DigitalJourneyQuery(f.db).read(f.root,repair.ready.id,undefined,true),node=item.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='rework'&&node.instanceId===repair.id)!;
   expect(node).toMatchObject({state:'active',sla:'finished',actualAt:completedAt,completionResult:'late',overdueSeconds:7200});
   expect((await reworkSlaEvidence(f.db,repair.ready.id)).windows.find(window=>window.reworkId===repair.id)).toMatchObject({completedAt,deadline:original.deadline});
  });
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
   await new ProductionClosureService(f.db).setPilot(f.root,{supplierId:f.supplierId,enabled:true});
   const receiver={...f.root,authorizationCapability:'receiving:create'},receiving=new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db)),closure=new OrderClosureService(f.db);
   const receipt=await receiving.create(receiver,{cuttingOrderId:cut.cutting_order_id,productionOrderId:productionId,factoryDecisionId:null,documentQuantity:10,actualQuantity:3,attachmentIds:[await f.image(receiver)]},randomUUID());
   let sheet=await closure.read(f.root,made.id);
   expect(sheet.factoryDeliveries).toEqual([expect.objectContaining({lineId,productionId,factoryDecisionId:null,delivered:true,received:3,remaining:7,collected:false,status:'on_time',firstReceipt:{precision:'instant',at:'2026-11-21T08:00:00.000Z'}})]);
   expect(sheet.collection).toMatchObject({received:3,remaining:7,status:'待收齐'});
   expect(sheet.receivingSpan!.collectedAt).toBeNull();
   const version=(await f.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[receipt.value.receivingBatchId])).rows[0].version;
   await receiving.correctReceipt({...f.root,authorizationCapability:'receiving:correct'},receipt.value.receiptId,{expectedVersion:version,source:'jiashun',documentQuantity:10,actualQuantity:0,defectiveQuantity:0});
   sheet=await closure.read(f.root,made.id);
   expect(sheet.factoryDeliveries![0]).toMatchObject({delivered:false,received:0,remaining:10,status:'pending'});
   expect(sheet.receivingSpan!.firstDelivery).toMatchObject({delivered:false});
   expect((await f.db.query("SELECT 1 FROM digital_journey_fact_changes WHERE resource_kind='order' AND resource_id=$1",[made.id])).rowCount).toBeGreaterThan(0);
   await new JourneyFactRepository(f.db).buildOne({kind:'order',id:made.id});
   expect((await query.read(f.root,made.id,undefined,true)).fixedSchedule!.scopes[0]!.nodes.find(node=>node.id===`return_logistics:${lineId}`)!.businessCompleted).toBe(false);

  });
 });
 it('closes each adopted development craft parent only on its matching original return confirmation',async()=>{
  const ownScene=await f.scene('2026-11-22T08:00:00.000Z');
  await f.runtime.run(ownScene,f.root,async()=>{
   configureTimelineAdoption(f.db,'fixed_v2');const checked:string[]=[];
   try{await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,new ContextBusinessClock(f.db),[['印绣花','免洗']],{
    fixedCraftSteps:[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}],
    onRouteComplete:async(sourceId,kind,taskId)=>{
     if(!['development_embroidery','development_printing','development_craft_confirmation'].includes(kind))return;
     const task=(await f.db.query('SELECT p.step_id,t.completed_at FROM digital_timeline_task_positions p JOIN digital_production_tasks t USING(task_id) WHERE p.task_id=$1',[taskId])).rows[0];
     const saved=(await new FixedTimelineAdoptionRepository(f.db).existing({kind:'source',id:sourceId},1))!,step=saved.input.craftSteps!.find(step=>step.stepId===task.step_id)!;
     const built=await new JourneyFactRepository(f.db).buildOne({kind:'source',id:sourceId}),fact=built.model.fixedSchedule!.scopes[0]!.facts[`development_${step.craftKind}`]!;
     if(kind==='development_craft_confirmation'){
      expect(fact.businessCompleted).toBe(true);expect(fact.completed).toEqual({precision:'instant',at:new Date(task.completed_at).toISOString()});
     }else{
      expect(fact.businessCompleted).toBe(false);expect(fact.completed).toEqual({precision:'unknown'});
     }
     checked.push(kind+':'+step.craftKind);
    },
   });}finally{configureTimelineAdoption(f.db,'legacy');}
   expect(checked).toEqual(['development_embroidery:embroidery','development_craft_confirmation:embroidery','development_printing:printing','development_craft_confirmation:printing']);
  });
 });

});
