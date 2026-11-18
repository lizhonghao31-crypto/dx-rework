import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {currentTaskPlanFixture,prepareCurrentTaskPlanSettings,republishedCurrentTaskPlanFixture,republishedInstructionTaskPlanFixture,republishedBulkPreparationTaskPlanFixture} from '../helpers/current-task-plan-fixture.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {fixedTaskTargets,type FixedTaskWorkBinding} from '../../apps/api/src/production-platform/fixed-task-targets.js';
import {FixedTimelineAdoptionRepository} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
import {readFixedOrderRoute} from '../../apps/api/src/production-platform/fixed-order-route.js';

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
   const taskPath='/api/digital-production/tasks/'+fixture.dispatchId;
   expect(h.requests.filter(call=>call.session===tab.session&&call.method==='GET'&&call.path===taskPath)).toHaveLength(1);
   const response=await tab.page.request.get(h.base+'/api/digital-production/tasks/'+fixture.dispatchId);expect(response.status()).toBe(200);expect((await response.json()).currentPlanTargets).toEqual(task.currentPlanTargets);
   await tab.page.screenshot({path:join(h.evidence,'later-instruction-current-P-390.png'),fullPage:true});
   expect(h.requests.filter(call=>call.session===tab.session&&call.path.startsWith('/api/digital-production/')&&!['GET','HEAD'].includes(call.method)&&!call.path.startsWith('/api/digital-production/notifications/claim'))).toEqual([]);
  }finally{await tab.context.close();}
  await f.runtime.run(fixture.scene,f.root,async()=>{
   const again=await new DigitalProductionTaskService(f.db).read(fixture.worker,fixture.dispatchId);expect({planned:again.plannedTargets,entered:again.enteredAt,due:again.dueAt,actual:again.actualCompletion}).toEqual({planned:task.plannedTargets,entered:task.enteredAt,due:task.dueAt,actual:task.actualCompletion});
  });
  expect(h.errors).toEqual([]);
 });
 it.each([{cuttingProcess:'in_house' as const,framework:true},{cuttingProcess:'outsourced' as const,framework:true},{cuttingProcess:'in_house' as const,framework:false},{cuttingProcess:'outsourced' as const,framework:false}])('opens the original bulk page with exact independent PO cutting plans after a later instruction, $cuttingProcess framework=$framework',async({cuttingProcess,framework})=>{
  const f=h.f;await prepareCurrentTaskPlanSettings(f,framework);
  const fixture=await republishedBulkPreparationTaskPlanFixture(f,false,{poCount:2,cuttingProcess,framework});
  const before=await f.runtime.run(fixture.scene,f.root,async()=>{
   const bulk=await new BulkPreparationService(f.db).read(f.root,fixture.orderId),tasks=bulk.tasks.filter(task=>['bulk_cutting','bulk_cutting_external'].includes(task.taskKind));expect(tasks).toHaveLength(1);
   const task=tasks[0]!,current=(await fixture.repo.current(fixture.resource()))!,journey=await new DigitalJourneyQuery(f.db).read(f.root,fixture.orderId,undefined,true);
   expect(task.taskKind).toBe(cuttingProcess==='in_house'?'bulk_cutting':'bulk_cutting_external');expect(task.routeVersion).toBeGreaterThan(1);
   expect(task.currentPlanTargets?.state,JSON.stringify(task.currentPlanTargets)).toBe('ready');expect(task.currentPlanTargets!.targets).toHaveLength(2);
   const work=current.input.work.find(work=>work.parameterKey==='bulk_cutting')!;expect(task.currentPlanTargets!.targets.every(target=>target.workRef===work.canonicalWorkRef)).toBe(true);
   const dates=(await f.db.query('SELECT line_id,customer_warehouse_arrival_date::text AS goal FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[fixture.orderId])).rows;
   const diagnosis={targets:task.currentPlanTargets,dates,scopes:current.input.scopes.map(scope=>({scopeRef:scope.scopeRef,goal:scope.customerGoal})),framework:Object.values(current.input.frameworkPlans??{}).map(plan=>({input:plan.input,arranged:plan.arranged.filter(row=>row.id==='bulk_cutting'||row.id==='style_label_ready')}))};
   await writeFile(join(h.evidence,'bulk-plan-'+cuttingProcess+'-'+framework+'.json'),JSON.stringify(diagnosis,null,2));
   if(framework){
    // All physical prerequisites are genuinely complete in this framework
    // fixture. The republished one-hour preparation sequence ends at12:00;
    // different customer goals alone do not invent different actual conditions.
    expect(task.currentPlanTargets!.targets.map(target=>target.endAt)).toEqual(['2026-11-17T12:00:00.000Z','2026-11-17T12:00:00.000Z']);
   }else{
    // The original non-framework frozen goals differ by two continuous days.
    // Keep both real scoped targets instead of a latest/aggregate date.
    expect(new Set(task.currentPlanTargets!.targets.map(target=>target.endAt)).size,JSON.stringify(diagnosis)).toBe(2);
    expect(Date.parse(task.currentPlanTargets!.targets[1]!.endAt!)-Date.parse(task.currentPlanTargets!.targets[0]!.endAt!)).toBe(2*86400000);
   }
   for(const line of dates){
    const target=task.currentPlanTargets!.targets.find(target=>target.lineId===line.line_id)!;
    const node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.records.some(record=>record.domain==='task'&&record.id===task.taskId))!;
    const scope=node.fixedTargets!.find(value=>value.lineId===line.line_id)!;expect(scope.progress.currentTarget?.at??scope.progress.goalDelta.targetAt).toBe(target.endAt);
   }
   return {task,bulk,plan:current};
  });
  h.setCollectionScene(fixture.scene);
  const tab=await h.open(f.root.actorId,cuttingProcess==='in_house'?1165:390,{},'/ui/digital-production?bulk='+fixture.orderId);
  try{
   await tab.page.getByRole('heading',{name:'大货产前准备',exact:true}).waitFor();
   const response=await tab.page.request.get(h.base+'/api/digital-production/orders/'+fixture.orderId+'/bulk-preparation');expect(response.status()).toBe(200);
   const actual=await response.json();await writeFile(join(h.evidence,'bulk-http-'+cuttingProcess+'-'+framework+'.json'),JSON.stringify({tasks:actual.tasks,lines:actual.cutting.lines},null,2));
   expect(actual.tasks.find((task:{taskId:string})=>task.taskId===before.task.taskId)?.currentPlanTargets).toEqual(before.task.currentPlanTargets);
   for(const line of before.bulk.cutting.lines){
    const row=tab.page.locator('[id="bulk-po-line-'+line.lineId+'"]'),panel=row.getByRole('region',{name:'本单当前计划'}),target=before.task.currentPlanTargets!.targets.find(target=>target.lineId===line.lineId)!;
    await panel.waitFor();await expect.poll(()=>panel.innerText()).toContain(target.precision==='date'&&target.date?target.date+'（日期）':new Date(target.endAt!).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
    expect(await panel.innerText()).toContain(target.scopeLabel);expect(await panel.getAttribute('data-plan-version')).toBe(before.task.currentPlanTargets!.planVersionId);
    const sibling=before.task.currentPlanTargets!.targets.find(other=>other.lineId!==line.lineId)!;expect(await panel.innerText()).not.toContain(sibling.scopeLabel);
    const link=row.getByRole('link',{name:'查看／登记原实裁',exact:true});expect(await link.getAttribute('href')).toContain(line.cuttingOrderId!);
   }
   await tab.page.screenshot({path:join(h.evidence,'original-bulk-two-PO-current-P-'+cuttingProcess+'-'+framework+'.png'),fullPage:true});
   expect(h.requests.filter(call=>call.session===tab.session&&call.path.startsWith('/api/digital-production/')&&!['GET','HEAD'].includes(call.method)&&!call.path.startsWith('/api/digital-production/notifications/claim'))).toEqual([]);
  }catch(error){await writeFile(join(h.evidence,'bulk-page-'+cuttingProcess+'-'+framework+'.html'),await tab.page.content());await writeFile(join(h.evidence,'bulk-page-'+cuttingProcess+'-'+framework+'.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
  await f.runtime.run(fixture.scene,f.root,async()=>{
   const again=await new DigitalProductionTaskService(f.db).read(f.root,before.task.taskId);expect({planned:again.plannedTargets,entered:again.enteredAt,due:again.dueAt,actual:again.actualCompletion}).toEqual({planned:before.task.plannedTargets,entered:before.task.enteredAt,due:before.task.dueAt,actual:before.task.actualCompletion});expect(await fixture.repo.current(fixture.resource())).toEqual(before.plan);
   const prior=await new DigitalProductionTaskService(f.db).read(f.root,fixture.priorId);expect({planned:prior.plannedTargets,entered:prior.enteredAt,due:prior.dueAt,actual:prior.actualCompletion}).toEqual({planned:fixture.priorTask.plannedTargets,entered:fixture.priorTask.enteredAt,due:fixture.priorTask.dueAt,actual:fixture.priorTask.actualCompletion});
  });
  expect(h.errors).toEqual([]);
 });
 it.each([false,true])('shows a newly required preshrink current P while retaining its original added-route B identity, framework=%s',async framework=>{
  const f=h.f;await prepareCurrentTaskPlanSettings(f,framework);
  const fixture=await republishedBulkPreparationTaskPlanFixture(f,false,{framework,addPreshrink:true});
  const before=await f.runtime.run(fixture.scene,f.root,async()=>{
   const bulk=await new BulkPreparationService(f.db).read(f.root,fixture.orderId),task=bulk.tasks.find(task=>task.taskKind==='warehouse_preshrink')!;expect(task).toBeDefined();
   const adoption=(await new FixedTimelineAdoptionRepository(f.db).existing(fixture.resource()))!,route=(await readFixedOrderRoute(f.db,adoption,fixture.preparation))!;
   expect(adoption.input.work.some(work=>work.parameterKey==='warehouse_preshrink')).toBe(false);
   const added=route.work.find(work=>work.parameterKey==='warehouse_preshrink')!;expect(added.canonicalWorkRef).toBe(`order:${fixture.orderId}:route:${fixture.preparation}:preshrink`);
   const captured:FixedTaskWorkBinding[]=[];const fixed=await fixedTaskTargets(f.db,{taskId:task.taskId,resource:fixture.resource(),round:task.routeVersion,routeRef:fixture.preparation,kind:task.taskKind},binding=>captured.push(binding));
   const current=(await fixture.repo.current(fixture.resource()))!,work=current.input.work.find(work=>work.parameterKey==='warehouse_preshrink')!;
   expect(captured).toEqual([{captured:true,canonicalWorkRef:added.canonicalWorkRef,currentPlanWorkRef:work.canonicalWorkRef}]);expect(task.plannedTargets).toEqual(fixed);
   expect(task.currentPlanTargets?.state,JSON.stringify(task.currentPlanTargets)).toBe('ready');expect(task.currentPlanTargets!.planVersionId).toBe(current.id);expect(task.currentPlanTargets!.targets.map(target=>target.workRef)).toEqual([work.canonicalWorkRef]);
   const journey=await new DigitalJourneyQuery(f.db).read(f.root,fixture.orderId,undefined,true),node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===task.taskId)!;expect(node).toBeDefined();expect(task.currentPlanTargets!.targets[0]!.endAt).toBe(node.expectedAt);
   expect((await new DigitalProductionTaskService(f.db).read(f.people.warehouse!,task.taskId)).currentPlanTargets).toEqual(task.currentPlanTargets);
   await writeFile(join(h.evidence,'added-preshrink-original-and-current-'+framework+'.json'),JSON.stringify({task,captured,adoption:adoption.adoptionId,originalAddedWork:added,currentWork:work,planId:current.id},null,2));
   return {task,current,adoption,route};
  });
  h.setCollectionScene(fixture.scene);const tab=await h.open(f.root.actorId,390,{},'/ui/digital-production?bulk='+fixture.orderId);
  try{
   const section=tab.page.locator('.bulk-preparation-reference-work>section').filter({has:tab.page.getByRole('heading',{level:3}).filter({hasText:before.task.label})}),panel=section.getByRole('region',{name:'本单当前计划'});await panel.waitFor();
   const target=before.task.currentPlanTargets!.targets[0]!;await expect.poll(()=>panel.innerText()).toContain(target.precision==='date'&&target.date?target.date+'（日期）':new Date(target.endAt!).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));expect(await panel.getAttribute('data-plan-version')).toBe(before.current.id);
   expect(h.requests.filter(call=>call.session===tab.session&&call.path.startsWith('/api/digital-production/')&&!['GET','HEAD'].includes(call.method)&&!call.path.startsWith('/api/digital-production/notifications/claim'))).toEqual([]);
   await tab.page.screenshot({path:join(h.evidence,'added-preshrink-original-page-'+framework+'.png'),fullPage:true});
  }finally{await tab.context.close();}
  await f.runtime.run(fixture.scene,f.root,async()=>{
   const after=await new DigitalProductionTaskService(f.db).read(f.root,before.task.taskId);expect({fixed:after.plannedTargets,entered:after.enteredAt,due:after.dueAt,actual:after.actualCompletion}).toEqual({fixed:before.task.plannedTargets,entered:before.task.enteredAt,due:before.task.dueAt,actual:before.task.actualCompletion});
   expect(await fixture.repo.current(fixture.resource())).toEqual(before.current);expect(await new FixedTimelineAdoptionRepository(f.db).existing(fixture.resource())).toEqual(before.adoption);expect(await readFixedOrderRoute(f.db,before.adoption,fixture.preparation)).toEqual(before.route);
  });expect(h.errors).toEqual([]);
 });
});
