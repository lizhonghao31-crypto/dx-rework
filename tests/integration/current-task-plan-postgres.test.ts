import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {currentTaskPlanFixture,prepareCurrentTaskPlanSettings,republishedCurrentTaskPlanFixture,republishedInstructionTaskPlanFixture} from '../helpers/current-task-plan-fixture.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {randomUUID} from 'node:crypto';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {publishedTechnicalFixture} from '../helpers/development-technical-fixture.js';
import {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('exact current task P is separate from original B and native responsibility',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);await prepareCurrentTaskPlanSettings(f);});
 afterAll(async()=>{if(f)await f.dispose();});
 it('reads an exact captured paper task current P without modifying its original fixed B or R/D/A',async()=>{
  const {scene,orderId,sourceId}=await currentTaskPlanFixture(f);
  await f.runtime.run(scene,f.root,async()=>{
   const rows=(await f.db.query(`SELECT t.task_id,t.route_version,t.state,p.route_ref,p.route_position,p.phase FROM digital_production_tasks t
    JOIN digital_production_task_access a USING(task_id) LEFT JOIN digital_timeline_task_positions p USING(task_id)
    WHERE a.source_id=$1 AND a.task_kind='development_pattern' ORDER BY t.route_version,t.created_at`,[sourceId])).rows;
   expect(rows).toHaveLength(1);const taskId=rows[0]!.task_id,tasks=new DigitalProductionTaskService(f.db);
   const task=await tasks.read(f.root,taskId),journey=await new DigitalJourneyQuery(f.db).read(f.root,orderId!,undefined,true);
   const node=journey.stages.flatMap(stage=>stage.nodes).find(value=>value.instanceId===taskId);
   expect(task.currentPlanTargets?.state).toBe('ready');expect(task.currentPlanTargets!.targets.length).toBeGreaterThan(0);
   const again=await tasks.read(f.root,taskId);expect(again.plannedTargets).toEqual(task.plannedTargets);expect({enteredAt:again.enteredAt,dueAt:again.dueAt,actual:again.actualCompletion}).toEqual({enteredAt:task.enteredAt,dueAt:task.dueAt,actual:task.actualCompletion});
   expect(node?.expectedAt).toBeTruthy();
   const points=task.currentPlanTargets!.targets.map(value=>value.precision==='date'?value.date:value.endAt);
   expect([...new Set(points)]).toEqual([node!.expectedAt]);
  });
 });
 it.each([false,true])('retains adopted warehouse work on a genuinely republished instruction route (added scope %s)',async addedCraft=>{
  const fixture=await republishedInstructionTaskPlanFixture(f,addedCraft);
  await f.runtime.run(fixture.scene,f.root,async()=>{
   const service=new DigitalProductionTaskService(f.db),task=await service.read(fixture.worker,fixture.dispatchId),journey=await new DigitalJourneyQuery(f.db).read(f.root,fixture.orderId,undefined,true);
   const current=(await fixture.repo.current(fixture.resource()))!,work=current.input.work.find(work=>work.canonicalWorkRef===fixture.canonicalWorkRef)!;
   expect(work).toBeTruthy();expect(task.currentPlanTargets?.state,JSON.stringify(task.currentPlanTargets)).toBe('ready');
   expect(task.currentPlanTargets!.targets.map(target=>target.workRef)).toEqual([fixture.canonicalWorkRef]);expect(task.currentPlanTargets!.planVersionId).toBe(current.id);
   const node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===fixture.dispatchId)!;expect(node).toBeTruthy();
   expect(task.currentPlanTargets!.targets.map(target=>target.endAt)).toEqual([node.expectedAt]);
   const again=await service.read(fixture.worker,fixture.dispatchId);expect({planned:again.plannedTargets,entered:again.enteredAt,due:again.dueAt,actual:again.actualCompletion}).toEqual({planned:task.plannedTargets,entered:task.enteredAt,due:task.dueAt,actual:task.actualCompletion});
   const prior=await service.read(f.root,fixture.priorId);expect({planned:prior.plannedTargets,entered:prior.enteredAt,due:prior.dueAt,actual:prior.actualCompletion}).toEqual({planned:fixture.priorTask.plannedTargets,entered:fixture.priorTask.enteredAt,due:fixture.priorTask.dueAt,actual:fixture.priorTask.actualCompletion});
  });
 });
 it.each([false,true])('uses a genuinely republished second-round paper plan and retains the completed first round original B and R/D/A (linked order %s)',async withOrder=>{
  const {scene,sourceId,paperId,priorPaperId,priorTask:before}=await republishedCurrentTaskPlanFixture(f,{withOrder});
  await f.runtime.run(scene,f.root,async()=>{
   const tasks=new DigitalProductionTaskService(f.db),current=await tasks.read(f.root,paperId),journey=await new DigitalJourneyQuery(f.db).read(f.root,sourceId,undefined,true),node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===paperId)!;
   const sourcePlan=(await new OrderTimePlanRepository(f.db).current({kind:'source',id:sourceId}))!;
   expect(Boolean(sourcePlan.input.frameworkPlans)).toBe(withOrder);expect(current.currentPlanTargets!.planVersionId).toBe(sourcePlan.id);
   expect(node).toBeTruthy();expect(current.currentPlanTargets?.state).toBe('ready');expect(current.currentPlanTargets!.targets.map(target=>target.endAt)).toEqual([node.expectedAt]);
   // The linked production framework arranges forward from11:00. Pure
   // development has no production framework: its existing current targets
   // retain the March1 source goal; four remaining one-hour works follow paper.
   const expected=withOrder?'2026-11-17T12:00:00.000Z':new Date(Date.parse('2027-03-01T16:00:00.000Z')-4*3600000).toISOString();
   expect(current.currentPlanTargets!.targets[0]!.endAt).toBe(expected);
   expect(current.currentPlanTargets!.targets[0]!.workRef).toContain(':round:2:');expect(current.currentPlanTargets!.planVersionId).not.toBe(before.currentPlanTargets!.planVersionId);
   const old=await tasks.read(f.root,priorPaperId);expect({planned:old.plannedTargets,enteredAt:old.enteredAt,dueAt:old.dueAt,actual:old.actualCompletion,completedAt:old.completedAt}).toEqual({planned:before.plannedTargets,enteredAt:before.enteredAt,dueAt:before.dueAt,actual:before.actualCompletion,completedAt:before.completedAt});
   if(withOrder)expect(old.currentPlanTargets).toEqual(before.currentPlanTargets);
   else expect(old.currentPlanTargets?.state).toBe('not_applicable');
  });
 });
 it('keeps a captured printing step current P separate from its included dispatch and original responsibility',async()=>{
  const {scene,sourceId,orderId,execution,paperId,worker,native}=await currentTaskPlanFixture(f,{craft:'印花'});
  await f.runtime.run(scene,f.root,async()=>{
   const sheet=await new DigitalDevelopmentService(f.db,true,native).read(f.root,sourceId);
   expect((await execution.read(f.root,sourceId)).tasks.find(task=>task.taskId===paperId)?.state).toBe('ready');
   const artifact=(await publishedTechnicalFixture(f.db,f.root,sourceId,sheet.document!,sheet.version,worker.actorId,f.attachments,f.storage))!;
   await execution.complete(f.root,sourceId,{taskId:paperId,note:'TEST actual paper before craft',attachmentIds:[],artifactRef:{id:artifact.artifactSetId,version:artifact.version,scopeRef:'整款'}},randomUUID());
   const cutting=(await execution.read(f.root,sourceId)).tasks.find(task=>task.taskKind==='development_cutting'&&task.routeVersion===1)!;
   expect(cutting.state).toBe('ready');await execution.complete(f.root,sourceId,{taskId:cutting.taskId,note:'TEST actual original cutting before craft',attachmentIds:[]},randomUUID());
   const positioning=(await execution.read(f.root,sourceId)).tasks.find(task=>task.taskKind==='development_positioning'&&task.routeVersion===1)!;
   if(positioning.state!=='ready')await new DigitalProductionTaskService(f.db).reassign(f.root,positioning.taskId,f.people['sample-designer']!.actorId,randomUUID());
   expect((await new DigitalProductionTaskService(f.db).read(f.root,positioning.taskId)).state).toBe('ready');
   const positioningImage=await f.image(f.root);await execution.recordUploadPurpose(f.root,sourceId,positioningImage,'定位图',positioning.taskId);
   await new DevelopmentTechnicalService(f.db,true).completePosition(f.root,sourceId,{taskId:positioning.taskId,artifactSetId:artifact.artifactSetId,artifactVersion:artifact.version,attachmentIds:[positioningImage],note:'TEST actual original positioning'},randomUUID());
   const dispatch=(await execution.read(f.root,sourceId)).tasks.find(task=>task.taskKind==='development_craft_dispatch'&&task.routeVersion===1)!;
   await execution.route(f.root,sourceId,{taskId:dispatch.taskId,note:'TEST actual native craft dispatch',result:'通过',craftExecution:'内部',nextAssigneeId:null,sentDate:null,trackingNo:null},randomUUID());
   const tasks=new DigitalProductionTaskService(f.db),state=await execution.read(f.root,sourceId),journey=await new DigitalJourneyQuery(f.db).read(f.root,orderId!,undefined,true);
   const printing=state.tasks.filter(task=>task.taskKind==='development_printing'&&task.routeVersion===1);expect(printing).toHaveLength(1);
   const original=await tasks.read(f.root,printing[0]!.taskId),node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===printing[0]!.taskId)!;
   expect(original.currentPlanTargets?.state,JSON.stringify(original.currentPlanTargets)).toBe('ready');
   expect(original.currentPlanTargets!.targets.map(target=>target.endAt)).toEqual([node.expectedAt]);
   expect(original.currentPlanTargets!.targets[0]!.workRef).toMatch(/:round:1:step:[^:]+:work$/);
   expect(original.currentPlanTargets!.targets[0]!.endAt).toBe('2026-11-17T12:00:00.000Z');
   for(const kind of ['development_craft_dispatch']){
    const task=state.tasks.find(task=>task.taskKind===kind&&task.routeVersion===1)!;expect(task).toBeTruthy();const current=await tasks.read(f.root,task.taskId);
    // The actual framework arranges the parent craft, not an independent P for
    // its included dispatch. Do not borrow that parent's date as another work.
    expect(current.currentPlanTargets).toMatchObject({state:'not_applicable',reason:'本任务内含于已安排工作，未单列独立计划时间',targets:[]});
   }
   const again=await tasks.read(f.root,printing[0]!.taskId);expect(again.plannedTargets).toEqual(original.plannedTargets);expect(again.dueAt).toBe(original.dueAt);expect(again.actualCompletion).toEqual(original.actualCompletion);
  });
 });
});
