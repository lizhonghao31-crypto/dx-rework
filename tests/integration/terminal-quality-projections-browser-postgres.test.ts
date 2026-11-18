import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {admittedFrameworkProductionFixture,admittedOrderFixture,prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {nodeStatus} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JOURNEY_FACT_CALCULATION_VERSION,journeyFactFingerprint} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original terminal quality projections preserve unfinished facts',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-quality-terminal-app-')),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});f=h.f;await prepareRewashSettings(f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('shows the stopped receiving-QC instance after special closure with frozen four-hour delay and no invented completion',async()=>{
  const {scene,orderId,ready,lineId}=await admittedFrameworkProductionFixture(f);
  await f.runtime.run(scene,f.root,async()=>{
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:2,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,orderId);
   await flow.dispatch(f.root,orderId,{expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST actual dispatch before terminal quality'},randomUUID());
   const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
   await new ReceivingService(f.db).create(warehouse,{cuttingOrderId:cut,documentQuantity:2,actualQuantity:2,attachmentIds:[await f.image(warehouse)]},randomUUID());
  });
  await f.advance(scene,'2026-11-17T13:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const closure=new OrderClosureService(f.db),before=await closure.read(f.root,orderId);
   await closure.close(f.root,orderId,{expectedRevision:before.revision,reason:'TEST special closure of real unfinished warehouse QC'},randomUUID());
  });
  for(const now of ['2026-11-17T13:00:00.000Z','2026-11-18T13:00:00.000Z']){
   if(now.endsWith('18T13:00:00.000Z'))await f.advance(scene,now);
   const {detail,node}=await f.runtime.run(scene,f.root,async()=>{
    const detail=await new DigitalJourneyQuery(f.db).read(f.root,orderId,undefined,true),node=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='receiving_inspection')!;
    const work=detail.fixedSchedule!.scopes.find(scope=>scope.lineId===lineId)!.nodes.find(work=>work.id.startsWith('garment_inspection'))!;
    expect(work).toMatchObject({businessCompleted:false,ownSla:{state:'terminated',overdueMinutes:{minimum:240,maximum:240}}});
    expect(nodeStatus(node),JSON.stringify({node,work})).toContain('计时已终止');expect(node.actualAt).toBeNull();expect(node.state).not.toBe('completed');
    return {detail,node};
   });
    // Original HTTP resource hooks acquire the same scene lock themselves.
    // Do not hold it around a browser request or block its authenticated read.
    h.setCollectionScene(scene);
    const tab=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?search='+encodeURIComponent(detail.designStyleNo));
    try{
     const row=tab.page.locator(`[data-order-id="${detail.id}"]`);await row.waitFor();
     expect(await row.getByText('已特殊结案',{exact:true}).count()).toBeGreaterThan(0);expect(await row.locator('.cockpit-home-task-heading').count()).toBe(0);
     await tab.page.goto(h.base+'/ui/digital-cockpit?selected='+detail.id+'&expanded='+node.stage+'&focus='+encodeURIComponent(node.instanceId));
     await tab.page.getByRole('button',{name:'本单全部节点',exact:true}).click();
     await tab.page.getByLabel('节点阶段筛选',{exact:true}).selectOption(node.stage);
     const summary=tab.page.locator('.cockpit-node-summary').locator(`[id="journey-node-${node.instanceId}"]`);await summary.waitFor();
     expect(await summary.innerText()).toContain('计时已终止');expect(await summary.innerText()).not.toContain('进行中');
     // The fixture's sole unfinished receiving-QC obligation is stopped by
     // the original whole-order closure. Lock its identity above, not by
     // invoking the UI predicate that is under test.
     const filter=tab.page.getByLabel('节点状态筛选',{exact:true}),completed=await filter.locator('option[value=completed]').innerText();
     await filter.selectOption('active');await summary.waitFor({state:'hidden'});
     expect(await filter.locator('option[value=active]').innerText()).toBe('进行中（0）');
     expect(await tab.page.locator('.journey-node-viewport tbody tr').count()).toBe(0);
     await tab.page.getByRole('region',{name:'小流程明细'}).getByRole('button',{name:'查看更多 ›',exact:true}).click();
     const more=tab.page.getByRole('dialog',{name:'全部节点明细',exact:true});await more.waitFor();expect(await more.locator('tbody tr').count()).toBe(0);
     await more.getByRole('button',{name:'关闭全部节点明细',exact:true}).click();
     expect(await tab.page.getByText('当前条件没有可见节点。可选择本单全部节点查看其他记录。',{exact:true}).count()).toBe(1);
     await filter.selectOption('all');await summary.waitFor();
     expect(await filter.locator('option[value=completed]').innerText()).toBe(completed);
     // "All nodes" intentionally clears the explicit selection. Choose the
     // locked original QC row again before asserting its historical detail.
     await summary.getByRole('button',{name:node.label,exact:true}).click();
     await tab.page.getByRole('region',{name:'当前节点详情'}).getByRole('heading',{name:'当前节点：'+node.label,exact:false}).waitFor();
     expect(await tab.page.getByRole('region',{name:'当前节点详情'}).getByText('计时已终止',{exact:true}).count()).toBeGreaterThan(0);
     expect(await tab.page.getByRole('link',{name:'进入该节点办理',exact:true}).count()).toBe(0);
     expect(node.actualAt).toBeNull();expect(node.fixedTargets!.flatMap(target=>target.progress.ownSla.overdueMinutes??[])).toContainEqual({minimum:240,maximum:240});
     await writeFile(join(h.evidence,'terminal-filter-original-dto-'+now.slice(0,10)+'.json'),JSON.stringify({nativeIdentity:node.instanceId,lineId,observedAt:now,source:detail.sourceId,orderId:detail.orderId,nativeNode:node,completedFilter:completed},null,2));
     expect(h.errors).toEqual([]);
    }catch(error){await writeFile(join(h.evidence,'terminal-detail.html'),await tab.page.content());await writeFile(join(h.evidence,'terminal-detail.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
  }
 });
 it('retains the exact cancelled cutting original D and frozen four-hour responsibility at two observations',async()=>{
  const fixture=await admittedFrameworkProductionFixture(f),{scene,orderId,lineId,repo,resource}=fixture;
  let taskId='',nodeId='';let original!:Awaited<ReturnType<DigitalProductionTaskService['read']>>;
  await f.runtime.run(scene,f.root,async()=>{
   const tasks=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind='bulk_cutting' AND t.state NOT IN('completed','cancelled')",[orderId])).rows;expect(tasks).toHaveLength(1);taskId=tasks[0]!.task_id;
   original=await new DigitalProductionTaskService(f.db).read(f.root,taskId);
   const detail=await new DigitalJourneyQuery(f.db).read(f.root,orderId,undefined,true),node=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.records.some(record=>record.domain==='task'&&record.id===taskId));
   await writeFile(join(h.evidence,'cancel-cutting-before.json'),JSON.stringify({original,detail},null,2));expect(node).toBeDefined();nodeId=node!.instanceId;
   expect(original).toMatchObject({enteredAt:'2026-11-17T08:00:00.000Z',dueAt:'2026-11-17T09:00:00.000Z',completedAt:null});
  });
  const plan=await repo.current(resource());await f.advance(scene,'2026-11-17T13:00:00.000Z');
  await f.runtime.run(scene,f.root,()=>new DigitalProductionTaskService(f.db).controlResource(f.root,resource(),'cancel','TEST cancel actual running cutting exactly once',randomUUID()));
  await f.runtime.run(scene,f.root,async()=>{
   const facts=new JourneyFactRepository(f.db),built=await facts.buildOne(resource());
   expect(built.model.schemaVersion).toBe(1);
   const original=built.model.fixedSchedule!.scopes.find(scope=>scope.lineId===lineId)!.facts;
   expect(Object.values(original).filter(fact=>fact.ownTaskId===taskId)).toHaveLength(1);
   // Reconstruct the previous deployed calculation's missing cancelled R in
   // this disposable derived cache only. Original tasks/events/plans stay intact.
   const old=structuredClone(built.model),previous='journey-facts-factory-instances-v13';
   expect(JOURNEY_FACT_CALCULATION_VERSION).not.toBe(previous);
   for(const scope of old.fixedSchedule!.scopes)for(const fact of Object.values(scope.facts))if(fact.ownTaskId===taskId){fact.ready={precision:'unknown'};fact.clockStart={precision:'unknown'};delete fact.ownTaskId;}
   await f.db.query('UPDATE digital_journey_fact_models SET calculation_version=$3,payload=$4,source_fingerprint=$5 WHERE resource_kind=$1 AND resource_id=$2',['order',orderId,previous,JSON.stringify(old),journeyFactFingerprint(old)]);
   const client=await f.db.connect();try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(await facts.readStoredWithClient(client,resource())).toMatchObject({status:'obsolete',model:null});
    const selection=await facts.readSelectionsWithClient(client,[resource()],(await f.runtime.repository.view(scene)).now);
    expect(selection.items.get('order:'+orderId)).toMatchObject({status:'obsolete',facts:null});
    await client.query('COMMIT');
   }finally{client.release();}
   const rebuilt=await facts.buildOne(resource());expect(rebuilt.model.fixedSchedule).toEqual(built.model.fixedSchedule);
   expect((await f.db.query('SELECT calculation_version FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2',['order',orderId])).rows[0].calculation_version).toBe(JOURNEY_FACT_CALCULATION_VERSION);
  });
  for(const now of ['2026-11-17T13:30:00.000Z','2026-11-17T20:00:00.000Z']){
   await f.advance(scene,now);
   const {detail,node}=await f.runtime.run(scene,f.root,async()=>{
    const native=await new DigitalProductionTaskService(f.db).read(f.root,taskId),detail=await new DigitalJourneyQuery(f.db).read(f.root,orderId,undefined,true),node=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===nodeId)!;
    await writeFile(join(h.evidence,'cancel-cutting-'+now.slice(11,13)+'.json'),JSON.stringify({native,detail},null,2));
    expect(native).toMatchObject({state:'cancelled',enteredAt:original.enteredAt,dueAt:original.dueAt,completedAt:null});
    const targets=node.fixedTargets!.filter(target=>target.lineId===lineId);expect(targets).toHaveLength(1);
    expect(targets[0]!.progress).toMatchObject({businessCompleted:false,goalDelta:{kind:'terminated'},ownSla:{state:'terminated',deadlineAt:'2026-11-17T09:00:00.000Z',overdueMinutes:{minimum:240,maximum:240}}});
    expect(node.actualAt).toBeNull();expect(node.risks).not.toContain('overdue');expect(node.risks).not.toContain('due_soon');expect(await repo.current(resource())).toEqual(plan);
    return {detail,node};
   });
   h.setCollectionScene(scene);
   const tab=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+detail.id+'&expanded='+node.stage+'&focus='+encodeURIComponent(node.instanceId));
   try{
    const current=tab.page.locator('.cockpit-current-summary');await current.waitFor();
    await expect.poll(()=>current.innerText()).toContain('终止前超时4小时');
    expect(await current.innerText()).toContain(new Date(original.dueAt!).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
    expect(await current.innerText()).toContain('自身截止');
    await tab.page.getByRole('button',{name:'本单全部节点',exact:true}).click();
    const row=tab.page.locator(`[id="journey-node-${nodeId}"]`);await row.waitFor();
    expect(await row.innerText()).toContain('终止前超时4小时');expect(await row.innerText()).not.toContain('按时完成');
    // All-nodes clears selection and may choose another live instance. Select
    // the exact cancelled original again before checking its read-only detail.
    await row.getByRole('button',{name:node.label,exact:true}).click();
    await tab.page.getByRole('region',{name:'当前节点详情'}).getByRole('heading',{name:'当前节点：'+node.label,exact:false}).waitFor();
    expect(await tab.page.getByRole('link',{name:'进入该节点办理',exact:true}).count()).toBe(0);
    await writeFile(join(h.evidence,'cancel-cutting-visible-'+now.slice(11,13)+'.txt'),await tab.page.locator('body').innerText());
    await tab.page.screenshot({path:join(h.evidence,'cancel-cutting-visible-'+now.slice(11,13)+'.png'),fullPage:true});
    expect(h.errors).toEqual([]);
   }catch(error){await writeFile(join(h.evidence,'cancel-cutting-failed.html'),await tab.page.content());throw error;}finally{await tab.context.close();}
   expect(await repo.current(resource())).toEqual(plan);
  }
  await f.runtime.run(scene,f.root,async()=>{
   expect((await f.db.query("SELECT count(*)::int n FROM digital_production_task_events WHERE task_id=$1 AND resource_kind='order' AND resource_id=$2 AND event_kind='cancel'",[taskId,orderId])).rows[0].n).toBe(1);
   expect(await repo.current(resource())).toEqual(plan);
  });
 });
 it.each(['无','印花'] as const)('retains the original cancelled two-PO responsibility with only the legacy %s frozen plan and persisted selection frames',async craft=>{
  // Independent original TEST schema with no new-admission standard. Do not
  // force a historical fixture through the active framework's new-order gate.
  const legacy=await businessAnchorFixture(url!);
  try{
  const scene=await legacy.scene('2026-11-10T08:00:00.000Z'),run=<T,>(action:()=>Promise<T>)=>legacy.runtime.run(scene,legacy.root,action);
  const ready=await run(async()=>{configureTimelineAdoption(legacy.db,'fixed_v2');try{return await legacy.bulkReady(craft,undefined,2);}finally{configureTimelineAdoption(legacy.db,'legacy');}}),resource={kind:'order' as const,id:ready.id};
  if(craft==='印花')await run(async()=>{
   const cuts=(await legacy.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[ready.caseId])).rows,cutter={...legacy.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   for(const cut of cuts)await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await legacy.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(legacy.db),state=await flow.read(legacy.root,ready.id);
   await flow.logistics(legacy.root,ready.id,{expectedRevision:state.revision,kind:'工艺发出',stepRef:state.craftSteps![0]!.stepId,occurredAt:'2026-11-10T08:00:00.000Z',supplier:'TEST original print supplier',note:'TEST real start before cancellation',lines:state.lines.map(line=>({lineId:line.lineId,quantity:10}))},randomUUID());
  });
  const original=await run(async()=>{
   expect(await new OrderTimePlanRepository(legacy.db).current(resource)).toBeNull();
   await new JourneyFactRepository(legacy.db).buildOne(resource);
   const tasks=(await legacy.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind=$2 AND t.state NOT IN('completed','cancelled')",[ready.id,craft==='印花'?'process_logistics':'bulk_cutting'])).rows;
   expect(tasks).toHaveLength(1);const service=new DigitalProductionTaskService(legacy.db);
   if(craft==='印花'){
    const worker=Object.values(legacy.people).find(person=>person.actorRoles.includes('embroidery_washing_merchandiser'))!;
    await service.reassign(legacy.root,tasks[0]!.task_id,worker.actorId,randomUUID());
   }
   const task=await service.read(legacy.root,tasks[0]!.task_id);
   expect(task.enteredAt).toBe('2026-11-10T08:00:00.000Z');expect(task.dueAt).not.toBeNull();return task;
  });
  const stopped=new Date(Date.parse(original.dueAt!)+4*3600000).toISOString();await legacy.advance(scene,stopped);
  await run(()=>new DigitalProductionTaskService(legacy.db).controlResource(legacy.root,resource,'cancel','TEST legacy original cancellation, not retirement',randomUUID()));
  const snapshot=async()=>run(async()=>{
   const detail=await new DigitalJourneyQuery(legacy.db).read(legacy.root,ready.id,undefined,true),task=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===original.taskId)!;
   expect(detail.fixedSchedule!.policyVersion).not.toBe('order-time-plan-v1');expect(task.fixedTargets).toHaveLength(2);
   expect(new Set(task.fixedTargets!.map(target=>target.lineId)).size).toBe(2);
   for(const target of task.fixedTargets!)expect(target.progress).toMatchObject({businessCompleted:false,goalDelta:{actual:{precision:'unknown'}},ownSla:{state:'terminated',deadlineAt:original.dueAt,overdueMinutes:{minimum:240,maximum:240}}});
   expect(task.actualAt).toBeNull();expect(task.risks).not.toContain('overdue');expect(task.risks).not.toContain('due_soon');
   const stored=await new JourneyFactRepository(legacy.db).buildOne(resource);expect(stored.model.schemaVersion).toBe(1);
   const frames=(await legacy.db.query('SELECT selection_json,selection_full_json FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2',['order',ready.id])).rows[0]!;
   expect(frames.selection_json.version).toBe('journey-selection-v2');expect(frames.selection_full_json.version).toBe('journey-selection-v2');
   for(const frame of frames.selection_json.frames)expect(frame.risks.filter((row:{id:string})=>row.id===original.taskId).every((row:{risks:string[]})=>!row.risks.includes('overdue')&&!row.risks.includes('due_soon'))).toBe(true);
   await writeFile(join(h.evidence,'cancel-legacy-'+craft+'-'+detail.asOf!.slice(0,10)+'.json'),JSON.stringify({task,scopes:detail.fixedSchedule!.scopes,frames},null,2));
   return task.fixedTargets!.map(target=>({lineId:target.lineId,progress:target.progress.ownSla}));
  });
  const first=await snapshot();await legacy.advance(scene,new Date(Date.parse(stopped)+24*3600000).toISOString());expect(await snapshot()).toEqual(first);
  }finally{await legacy.dispose();}
 });
 it('retains a cancelled original development craft-return window with its legacy duration alias',async()=>{
  const legacy=await businessAnchorFixture(url!);
  try{
   const scene=await legacy.scene('2026-11-10T08:00:00.000Z'),run=<T,>(action:()=>Promise<T>)=>legacy.runtime.run(scene,legacy.root,action),stop=new Error('TEST native craft returned before original confirmation');let sourceId='';
   await run(async()=>{
    configureTimelineAdoption(legacy.db,'fixed_v2');
    try{
     await expect(exerciseDevelopmentSlaNative(legacy.db,new TodoProjectionService(new TodoService(legacy.db)),legacy.root,legacy.people['pattern-room-worker']!.actorId,new ContextBusinessClock(legacy.db),[['印花','免洗']],{
      fixedCraftSteps:[{craftKind:'printing',sequence:1}],onRouteComplete:async(id,kind)=>{if(kind==='development_printing'){sourceId=id;throw stop;}},
     })).rejects.toBe(stop);
    }finally{configureTimelineAdoption(legacy.db,'legacy');}
   });
   expect(sourceId).not.toBe('');const resource={kind:'source' as const,id:sourceId};
   const original=await run(async()=>{
    expect(await new OrderTimePlanRepository(legacy.db).current(resource)).toBeNull();
    const rows=(await legacy.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_craft_confirmation' AND t.route_version=1",[sourceId])).rows;
    expect(rows).toHaveLength(1);const task=await new DigitalProductionTaskService(legacy.db).read(legacy.root,rows[0]!.task_id);
    expect(task.enteredAt).toBe('2026-11-10T08:00:00.000Z');expect(task.dueAt).toBe('2026-11-10T08:30:00.000Z');return task;
   });
   await legacy.advance(scene,'2026-11-10T12:30:00.000Z');
   await run(()=>new DigitalProductionTaskService(legacy.db).controlResource(legacy.root,resource,'cancel','TEST original craft confirmation cancelled after real processing',randomUUID()));
   for(const [index,now] of ['2026-11-10T12:30:00.000Z','2026-11-11T12:30:00.000Z'].entries()){
    if(index)await legacy.advance(scene,now);
    await run(async()=>{
     const stored=await new JourneyFactRepository(legacy.db).buildOne(resource);
     const detail=await new DigitalJourneyQuery(legacy.db).read(legacy.root,sourceId,undefined,true),node=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===original.taskId)!;
     await writeFile(join(h.evidence,'cancel-development-return-diagnostic.json'),JSON.stringify({original,node,detail,basis:stored.model.fixedSchedule},null,2));
     // Rebuilt persisted facts expose the independently known responsibility;
     // no requested finish date or completion is manufactured for this source.
     expect(node.fixedTargets).toHaveLength(1);
     expect(node.fixedTargets![0]!.progress).toMatchObject({businessCompleted:false,goalDelta:{actual:{precision:'unknown'}},ownSla:{state:'terminated',deadlineAt:original.dueAt,overdueMinutes:{minimum:240,maximum:240}}});
     const scope=stored.model.fixedSchedule!.scopes[0]!,work=scope.work.find(work=>work.id.startsWith('development_craft_confirmation:'))!;
     expect(work.responsibilityMinutes).toBe(30);
     expect(scope.facts[work.id]).toMatchObject({ownTaskId:original.taskId,ready:{precision:'instant',at:original.enteredAt},clockStart:{precision:'instant',at:original.enteredAt},completed:{precision:'unknown'},businessCompleted:false});
     expect(node.timing).toMatchObject({status:'terminated',actualStart:original.enteredAt,actualEnd:null,target:{at:original.dueAt},termination:{kind:'cancelled',overdueSeconds:14400}});
     expect(node.actualAt).toBeNull();expect(node.risks).not.toContain('overdue');expect(node.risks).not.toContain('due_soon');
     await writeFile(join(h.evidence,'cancel-development-return-'+now.slice(0,10)+'.json'),JSON.stringify({original,node,scopes:detail.fixedSchedule!.scopes},null,2));
    });
   }
  }finally{await legacy.dispose();}
 });
 it('retains cancelled source material verification responsibility on its linked open order',async()=>{
  const settings=new OrderTimeSettingsService(f.db,true,true),standard=await settings.read(f.root),values=r5OneHourConfiguration();
  values.nodes.development_materials={kind:'work',minutes:240,calendar:'continuous',reminder:{enabled:true,percent:70}};
  await settings.save(f.root,{expectedVersion:standard.version,values:prepareTimeFrameworkConfiguration(values)},randomUUID());
  const start='2026-11-17T18:40:27.622Z',deadline='2026-11-17T22:40:27.622Z',cancelledAt='2026-11-18T02:40:27.622Z';
  const {scene,orderId,sourceId,repo,resource}=await admittedOrderFixture(f,{startAt:start,poCount:2});
  const run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action),tasks=new DigitalProductionTaskService(f.db),journeys=new DigitalJourneyQuery(f.db);
  const source={kind:'source' as const,id:sourceId};
  const plan=await repo.current(resource());expect(plan?.input.scopes).toHaveLength(2);
  const original=await run(async()=>{
   const rows=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_materials' AND t.route_version=1",[sourceId])).rows;
   expect(rows).toHaveLength(1);
   const task=await tasks.read(f.root,rows[0]!.task_id);expect(task).toMatchObject({state:'ready',enteredAt:start,dueAt:deadline,completedAt:null});return task;
  });
  await f.advance(scene,cancelledAt);
  await run(()=>tasks.controlResource(f.root,source,'cancel','TEST stops the linked source but leaves its customer order open',randomUUID()));
  const eventQuery="SELECT event_id,occurred_at,recorded_at,time_quality FROM digital_production_task_events WHERE task_id=$1 AND resource_kind='source' AND resource_id=$2 AND event_kind='cancel'";
  const [event]= (await f.db.query(eventQuery,[original.taskId,sourceId])).rows;
  expect(event.occurred_at.toISOString()).toBe(cancelledAt);expect(event.recorded_at.toISOString()).not.toBe(cancelledAt);
  await run(async()=>{
   const facts=new JourneyFactRepository(f.db),{model}=await facts.buildOne(resource());
   const scopes=model.fixedSchedule!.scopes;
   expect(scopes).toHaveLength(2);
   for(const scope of scopes)expect(scope.facts['source:development_materials']).toMatchObject({ownTaskId:original.taskId,terminated:true,terminationAt:cancelledAt,evidenceRefs:expect.arrayContaining([`digital_production_task_events:${event.event_id}`])});
   expect(model.termination).toBeNull();
   const previous='journey-facts-washing-window-identities-v15';
   await f.db.query('UPDATE digital_journey_fact_models SET calculation_version=$2 WHERE resource_kind=\'order\' AND resource_id=$1',[orderId,previous]);
   const client=await f.db.connect();
   try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(await facts.readStoredWithClient(client,resource())).toMatchObject({status:'obsolete',model:null});
    const observation=await f.runtime.repository.view(scene),selection=await facts.readSelectionsWithClient(client,[resource()],observation.now);
    expect(selection.items.get(`order:${orderId}`)).toMatchObject({status:'obsolete',facts:null});
   }finally{await client.query('ROLLBACK');client.release();}
   expect((await facts.buildOne(resource())).model.fixedSchedule).toEqual(model.fixedSchedule);
  });
  for(const [index,now] of ['2026-11-18T03:00:00.000Z','2027-04-14T16:00:00.000Z'].entries()){
   await f.advance(scene,now);
   const detail=await run(async()=>{
    expect(await tasks.read(f.root,original.taskId)).toMatchObject({state:'cancelled',enteredAt:start,dueAt:deadline,completedAt:null,canExecute:false});
    const detail=await journeys.read(f.root,orderId,undefined,true),node=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===original.taskId)!;
    await writeFile(join(h.evidence,`cancel-linked-source-${index}.json`),JSON.stringify({node,scopes:detail.fixedSchedule?.scopes},null,2));
    expect(detail.display?.mainState).not.toBe('cancelled');
    expect(node).toMatchObject({state:'cancelled',actualAt:null,overdueSeconds:14400,nativeTaskDeadline:{at:deadline}});
    expect(node.risks).not.toContain('overdue');
    const ownTargets=node.fixedTargets!;expect(ownTargets).toHaveLength(2);expect(new Set(ownTargets.map(target=>target.lineId)).size).toBe(2);
    for(const own of ownTargets)expect(own.progress).toMatchObject({businessCompleted:false,goalDelta:{kind:'terminated',actual:{precision:'unknown'}},ownSla:{state:'terminated',deadlineAt:deadline,overdueMinutes:{minimum:240,maximum:240}}});
    expect(detail.fixedSchedule!.scopes.some(scope=>scope.nodes.some(work=>work.id.startsWith('garment_packing:')&&work.state!=='terminated'))).toBe(true);
    return {id:detail.id,stage:node.stage};
   });
   if(index===0){
    h.setCollectionScene(scene);
    const tab=await h.open(f.root.actorId,1165,{},`/ui/digital-cockpit?selected=${detail.id}&expanded=${detail.stage}&focus=${original.taskId}`);
    try{
     const current=tab.page.locator('.cockpit-current-summary');await current.waitFor();
     await expect.poll(()=>current.innerText()).toContain('终止前超时4小时');
     expect(await current.innerText()).toContain(new Date(deadline).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
     expect(await tab.page.getByRole('link',{name:'进入该节点办理',exact:true}).count()).toBe(0);
    }finally{await tab.context.close();}
   }
  }
  expect(await repo.current(resource())).toEqual(plan);
  expect((await f.db.query(eventQuery,[original.taskId,sourceId])).rows).toEqual([event]);
 });
});
