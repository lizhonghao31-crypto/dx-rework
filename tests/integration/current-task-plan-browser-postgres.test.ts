import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {currentTaskPlanFixture,prepareCurrentTaskPlanSettings,republishedCurrentTaskPlanFixture,republishedInstructionTaskPlanFixture} from '../helpers/current-task-plan-fixture.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('current task P through original authenticated task App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-current-task-plan-')),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});await prepareCurrentTaskPlanSettings(h.f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('shows the same exact current P as Journey on the assigned worker page at desktop and narrow widths, independently of original B and D',async()=>{
  const f=h.f,fixture=await currentTaskPlanFixture(f),{scene,sourceId,orderId,paperId,worker}=fixture;
  const expected=await f.runtime.run(scene,f.root,async()=>{
   const service=new DigitalProductionTaskService(f.db),task=await service.read(f.root,paperId),journey=await new DigitalJourneyQuery(f.db).read(f.root,orderId!,undefined,true);
   const node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===paperId)!;
   expect(task.currentPlanTargets?.state).toBe('ready');expect(task.currentPlanTargets!.targets).toHaveLength(1);
   expect(task.currentPlanTargets!.targets[0]!.endAt).toBe(node.expectedAt);expect(task.currentPlanTargets!.targets[0]!.endAt).toBe('2026-11-17T10:00:00.000Z');
   expect(task.dueAt).toBe('2026-11-17T09:00:00.000Z');expect(task.currentPlanTargets!.targets[0]!.endAt).not.toBe(task.dueAt);
   const assigned=await service.read(worker,paperId);expect(assigned.currentPlanTargets).toEqual(task.currentPlanTargets);
   await expect(service.read(f.people['worker-a']!,paperId)).rejects.toMatchObject({statusCode:404});
   return task;
  });
  const clock=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  for(const width of [1165,390]){
   const tab=await h.open(worker.actorId,width,{},'/ui/digital-production?task='+paperId+'&view=read');
   try{
    const panel=tab.page.getByRole('region',{name:'本单当前计划'}).first();await panel.waitFor();
    await expect.poll(()=>panel.innerText()).toContain(clock(expected.currentPlanTargets!.targets[0]!.endAt!));
    expect(await panel.innerText()).toContain('本单当前计划完成');expect(await panel.innerText()).toContain(expected.currentPlanTargets!.targets[0]!.scopeLabel);
    expect(await panel.innerText()).not.toContain(clock(expected.dueAt!));
    expect(await panel.getAttribute('data-plan-version')).toBe(expected.currentPlanTargets!.planVersionId);
    const geometry=await panel.evaluate(element=>({left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,width:window.innerWidth,scroll:element.scrollWidth,client:element.clientWidth}));
    expect(geometry.left).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(width);expect(geometry.scroll).toBeLessThanOrEqual(geometry.client+1);
    const read=await tab.page.request.get(h.base+'/api/digital-production/tasks/'+paperId);expect(read.status()).toBe(200);
    expect((await read.json()).currentPlanTargets).toEqual(expected.currentPlanTargets);
    await tab.page.screenshot({path:join(h.evidence,'native-task-current-P-'+width+'.png'),fullPage:true});
   }catch(error){await writeFile(join(h.evidence,'native-task-current-P-'+width+'.html'),await tab.page.content());throw error;}finally{await tab.context.close();}
  }
  await f.runtime.run(scene,f.root,async()=>{
   const after=await new DigitalProductionTaskService(f.db).read(f.root,paperId);
   expect(after.plannedTargets).toEqual(expected.plannedTargets);expect(after.enteredAt).toBe(expected.enteredAt);expect(after.dueAt).toBe(expected.dueAt);expect(after.actualCompletion).toEqual(expected.actualCompletion);
   expect((await f.db.query('SELECT source_id FROM digital_development_documents WHERE source_id=$1',[sourceId])).rows).toHaveLength(1);
  });
  expect(h.errors).toEqual([]);
 });
 it('opens a genuinely new second-round paper P with its own current version in the original assigned-worker task page',async()=>{
  const f=h.f,{scene,sourceId,paperId,priorPaperId,priorTask,worker}=await republishedCurrentTaskPlanFixture(f,{withOrder:false});
  // This pure-source current-plan branch retains its original date goal.
  // Paper precedes the four remaining one-hour works before Beijing March1 end.
  const expectedAt=new Date(Date.parse('2027-03-01T16:00:00.000Z')-4*3600000).toISOString();
  const expected=await f.runtime.run(scene,f.root,async()=>{
   const task=await new DigitalProductionTaskService(f.db).read(f.root,paperId),journey=await new DigitalJourneyQuery(f.db).read(f.root,sourceId,undefined,true),node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===paperId)!;
   expect(task.currentPlanTargets?.state).toBe('ready');expect(task.currentPlanTargets!.targets[0]!.endAt).toBe(expectedAt);expect(node.expectedAt).toBe(task.currentPlanTargets!.targets[0]!.endAt);return task;
  });
  const snapshot=async()=> (await f.db.query(`SELECT
   (SELECT count(*)::int FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1) AS tasks,
   (SELECT count(*)::int FROM digital_order_time_plan_versions WHERE source_id=$1) AS plans,
   (SELECT count(*)::int FROM digital_development_route_facts WHERE source_id=$1) AS facts,
   (SELECT count(*)::int FROM digital_timeline_adoptions WHERE source_id=$1) AS adoptions`,[sourceId])).rows;
  const before=await snapshot(),tab=await h.open(worker.actorId,390,{},'/ui/digital-production?task='+paperId+'&view=read');
  try{
   const panel=tab.page.getByRole('region',{name:'本单当前计划'}).first();await panel.waitFor();
   await expect.poll(()=>panel.innerText()).toContain(new Date(expectedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
   expect(await panel.getAttribute('data-plan-version')).toBe(expected.currentPlanTargets!.planVersionId);expect(expected.currentPlanTargets!.targets[0]!.workRef).toContain(':round:2:');
   const response=await tab.page.request.get(h.base+'/api/digital-production/tasks/'+paperId);expect(response.status()).toBe(200);expect((await response.json()).currentPlanTargets).toEqual(expected.currentPlanTargets);
   const writes=h.requests.filter(call=>call.session===tab.session&&call.path.startsWith('/api/digital-production/')&&!['GET','HEAD'].includes(call.method));
   // The original notification host claims its user's queued notices on mount.
   // That existing acknowledgement is separate from task/plan business writes.
   expect(writes.filter(call=>call.path!=='/api/digital-production/notifications/claim?remaining=1')).toEqual([]);
   for(const call of writes)expect(call).toMatchObject({method:'POST',bodyHash:null,key:null,status:200});
   await tab.page.screenshot({path:join(h.evidence,'second-round-current-P-390.png'),fullPage:true});
  }catch(error){await writeFile(join(h.evidence,'second-round-current-P-390.html'),await tab.page.content());throw error;}finally{await tab.context.close();}
  expect(await snapshot()).toEqual(before);
  await f.runtime.run(scene,f.root,async()=>{
   const old=await new DigitalProductionTaskService(f.db).read(f.root,priorPaperId);expect({planned:old.plannedTargets,entered:old.enteredAt,due:old.dueAt,completed:old.actualCompletion}).toEqual({planned:priorTask.plannedTargets,entered:priorTask.enteredAt,due:priorTask.dueAt,completed:priorTask.actualCompletion});
  });
  expect(h.errors).toEqual([]);
 });
 it('shows an inherited warehouse handoff current P on its assigned original page after a later same-scope instruction',async()=>{
  const f=h.f,fixture=await republishedInstructionTaskPlanFixture(f,false);
  const task=await f.runtime.run(fixture.scene,fixture.worker,()=>new DigitalProductionTaskService(f.db).read(fixture.worker,fixture.dispatchId));
  expect(task.currentPlanTargets?.state).toBe('ready');expect(task.currentPlanTargets!.targets[0]!.workRef).toBe(fixture.canonicalWorkRef);
  const tab=await h.open(fixture.worker.actorId,390,{},'/ui/digital-production?task='+fixture.dispatchId+'&view=read');
  try{
   const panel=tab.page.getByRole('region',{name:'本单当前计划'}).first();await panel.waitFor();
   await expect.poll(()=>panel.innerText()).toContain(new Date(task.currentPlanTargets!.targets[0]!.endAt!).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
   expect(await panel.getAttribute('data-plan-version')).toBe(task.currentPlanTargets!.planVersionId);
   const response=await tab.page.request.get(h.base+'/api/digital-production/tasks/'+fixture.dispatchId);expect(response.status()).toBe(200);expect((await response.json()).currentPlanTargets).toEqual(task.currentPlanTargets);
   await tab.page.screenshot({path:join(h.evidence,'later-instruction-current-P-390.png'),fullPage:true});
   expect(h.requests.filter(call=>call.session===tab.session&&call.path.startsWith('/api/digital-production/')&&!['GET','HEAD'].includes(call.method)&&!call.path.startsWith('/api/digital-production/notifications/claim'))).toEqual([]);
  }finally{await tab.context.close();}
  await f.runtime.run(fixture.scene,f.root,async()=>{
   const again=await new DigitalProductionTaskService(f.db).read(fixture.worker,fixture.dispatchId);expect({planned:again.plannedTargets,entered:again.enteredAt,due:again.dueAt,actual:again.actualCompletion}).toEqual({planned:task.plannedTargets,entered:task.enteredAt,due:task.dueAt,actual:task.actualCompletion});
  });
  expect(h.errors).toEqual([]);
 });
});
