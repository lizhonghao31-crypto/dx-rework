import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {admittedFrameworkProductionFixture,prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {nodeStatus} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JOURNEY_FACT_CALCULATION_VERSION,journeyFactFingerprint} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
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
 it('retains the original cancelled two-PO responsibility with only the legacy frozen plan and persisted selection frames',async()=>{
  // Independent original TEST schema with no new-admission standard. Do not
  // force a historical fixture through the active framework's new-order gate.
  const legacy=await businessAnchorFixture(url!);
  try{
  const scene=await legacy.scene('2026-11-10T08:00:00.000Z'),run=<T,>(action:()=>Promise<T>)=>legacy.runtime.run(scene,legacy.root,action);
  const ready=await run(async()=>{configureTimelineAdoption(legacy.db,'fixed_v2');try{return await legacy.bulkReady('无',undefined,2);}finally{configureTimelineAdoption(legacy.db,'legacy');}}),resource={kind:'order' as const,id:ready.id};
  const original=await run(async()=>{
   expect(await new OrderTimePlanRepository(legacy.db).current(resource)).toBeNull();
   await new JourneyFactRepository(legacy.db).buildOne(resource);
   const tasks=(await legacy.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind IN('bulk_cutting','bulk_cutting_external') AND t.state NOT IN('completed','cancelled')",[ready.id])).rows;
   expect(tasks).toHaveLength(1);const task=await new DigitalProductionTaskService(legacy.db).read(legacy.root,tasks[0]!.task_id);
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
   await writeFile(join(h.evidence,'cancel-legacy-'+detail.asOf!.slice(0,10)+'.json'),JSON.stringify({task,scopes:detail.fixedSchedule!.scopes,frames},null,2));
   return task.fixedTargets!.map(target=>({lineId:target.lineId,progress:target.progress.ownSla}));
  });
  const first=await snapshot();await legacy.advance(scene,new Date(Date.parse(stopped)+24*3600000).toISOString());expect(await snapshot()).toEqual(first);
  }finally{await legacy.dispose();}
 });
});
