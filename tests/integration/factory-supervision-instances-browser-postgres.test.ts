import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {SpecialCraftLibraryService} from '../../apps/api/src/production-platform/special-craft-library.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {productionReadinessFixture,completeBulkRangeFixture} from '../helpers/production-readiness-fixture.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('frozen double-special factory supervision through original App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-factory-supervision-app-')),{fullApp:true,workbenchNumberedCreation:true});configureTimelineAdoption(h.f.db,'fixed_v2');});
 afterAll(async()=>{if(h){configureTimelineAdoption(h.f.db,'legacy');await h.writeEvidence();await h.dispose();}});
 it('reads before/after cutting and keeps each process/QC window through Journey, selector rebuild and authenticated rendering',async()=>{
  const f=h.f,steps:CraftStepChoice[]=[],library=new SpecialCraftLibraryService(f.db);
  for(const [index,name]of ['TEST A exact laser','TEST A exact stones'].entries()){
   const specialCraft=await library.save(f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:{minutes:60,calendar:'continuous',reminder:{enabled:true,percent:70}},bulk:{minutes:240*(index+1),calendar:'continuous',reminder:{enabled:false,percent:80}}}},randomUUID());
   steps.push({craftKind:'special',sequence:index+1,specialCraft});
  }
  const ready=await f.bulkReady('特殊工艺',undefined,1,f.sourcing,{quantity:100,craftSteps:steps}),journeys=new DigitalJourneyQuery(f.db);
  await expect(journeys.read(f.root,ready.id)).resolves.toMatchObject({orderId:ready.id});
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db);let state=await flow.read(f.root,ready.id);const lineId=state.lines[0]!.lineId;let prior:string|undefined;
  const unchanged=async()=> (await f.db.query(`SELECT
   (SELECT count(*) FROM digital_factory_facts)::int AS facts,(SELECT count(*) FROM digital_factory_qc)::int AS qc,
   (SELECT count(*) FROM digital_production_tasks)::int AS tasks,(SELECT count(*) FROM digital_timeline_adoptions)::int AS adoptions,
   (SELECT count(*) FROM digital_timeline_order_routes)::int AS routes`)).rows;
  const verify=async()=>{
   const before=await unchanged(),sla=await new SlaOrderService(f.db).read(f.root,ready.id);expect(sla.status).toBe('planned');if(sla.status!=='planned')throw Error('TEST expected original plan');
   const route=sla.factory&&'evaluationRoute'in sla.factory?sla.factory.evaluationRoute:undefined;expect(route).toBeDefined();
   const exact=route!.route.filter(row=>row.phase==='logistics'||row.phase==='qc');expect(exact).toHaveLength(4);
   for(const row of exact){const node=sla.evaluationPlan.nodes.find(node=>node.id===row.nodeId)!;expect(node.applicable).toBe('yes');expect(sla.facts[row.nodeId]).toBeDefined();}
   const detail=await journeys.read(f.root,ready.id),listed=(await journeys.list(f.root,JourneyFilterSchema.parse({scope:'production',search:detail.designStyleNo}),true)).items.find(item=>item.orderId===ready.id)!;
   const nativeTasks=(await f.db.query(`SELECT t.task_id,t.state,a.task_kind,t.route_instance_id,p.route_ref,p.step_id,p.phase FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) LEFT JOIN digital_timeline_task_positions p USING(task_id) WHERE a.production_order_id=$1`,[ready.id])).rows;
   await writeFile(join(h.evidence,'factory-native-detail.json'),JSON.stringify({nativeTasks,detail,listed,exact},null,2));
   expect(detail.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&['process_logistics','bulk_qc'].includes(node.key))).toHaveLength(4);
   for(const item of [detail,listed])for(const row of exact){
    const task=(await f.db.query('SELECT task_id FROM digital_timeline_task_positions WHERE route_ref=$1 AND step_id=$2 AND phase=$3',[ready.preparationId,row.stepId,row.phase])).rows[0];
    expect(task).toBeDefined();const node=item.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===task.task_id)!;
    expect(node.timing?.id).toBe(row.nodeId);expect(node.timings).toBeUndefined();
    const native=state.batchWindows!.find(window=>window.stepRef===row.stepId&&window.kind===(row.phase==='qc'?'bulk_qc':'process_logistics'))!;
    expect(node.timing?.actualStart).toBe(native.enteredAt);expect(node.timing?.actualEnd).toBe(native.completedAt);
    expect(node.timing?.windows).toEqual([expect.objectContaining({startedAt:native.enteredAt,deadline:native.dueAt,warningAt:native.warningAt,completedAt:native.completedAt,complete:native.complete,evidence:native.evidence})]);
    // The shared batch evaluator exposes the earliest OPEN D as its aggregate
    // target. Completed batches retain their own D in windows, never lose it or
    // replace it with the continuous legacy forecast or a formal P.
    expect(node.timing?.target.at).toBe(native.complete?null:native.dueAt);
    expect(node.timing?.label).toContain(state.craftSteps!.find(step=>step.stepId===row.stepId)!.specialCraft!.definition.name);
   }
   const client=await f.db.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const model=await journeys.buildFactsWithClient(client,{kind:'order',id:ready.id},businessNow().toISOString());expect(model.sla.factoryInstances?.map(instance=>instance.nodeId)).toEqual(exact.map(row=>row.nodeId));await client.query('ROLLBACK');}finally{client.release();}
   expect(await unchanged()).toEqual(before);return {detail,exact};
  };
  await verify();
  for(const step of state.craftSteps!){
   await flow.logistics(f.root,ready.id,{expectedRevision:state.revision,stepRef:step.stepId,kind:'工艺发出',occurredAt:businessNow().toISOString(),supplier:'TEST frozen route',note:'TEST',lines:[{lineId,quantity:100}],...(prior?{fromReturnId:prior}:{})},randomUUID());
   state=await flow.read(f.root,ready.id);await verify();const send=state.facts.filter(fact=>fact.kind==='工艺发出'&&fact.payload.stepRef===step.stepId).at(-1)!;
   await flow.logistics(f.root,ready.id,{expectedRevision:state.revision,stepRef:step.stepId,kind:'工艺回仓',occurredAt:businessNow().toISOString(),supplier:'TEST',note:'TEST',sendFactId:send.factId,lines:[{lineId,quantity:100}]},randomUUID());
   state=await flow.read(f.root,ready.id);prior=state.facts.filter(fact=>fact.kind==='工艺回仓'&&fact.payload.stepRef===step.stepId).at(-1)!.factId;
   await flow.qc(f.root,ready.id,{expectedRevision:state.revision,stepRef:step.stepId,returnFactId:prior,note:'TEST real original QC',checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]}]},randomUUID());
   state=await flow.read(f.root,ready.id);await verify();
  }
  const {detail}=await verify(),tab=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+ready.id);
  try{
   await tab.page.getByRole('button',{name:'本单全部节点',exact:true}).click();
   for(const node of detail.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&['process_logistics','bulk_qc'].includes(node.key))){
    const row=tab.page.locator('.cockpit-node-summary').locator(`[id="journey-node-${node.instanceId}"]`);await row.waitFor();expect(await row.innerText()).toContain(node.label);
   }
   for(const step of state.craftSteps!)expect(await tab.page.locator('.cockpit-node-summary').innerText()).toContain(step.specialCraft!.definition.name);
   await tab.page.screenshot({path:join(h.evidence,'factory-supervision.png'),fullPage:true});
   expect(h.errors).toEqual([]);expect(detail.orderId).toBe(ready.id);
  }catch(error){await writeFile(join(h.evidence,'factory-supervision.html'),await tab.page.content());throw error;}finally{await tab.context.close();}
 });
 it('counts appended preshrink once and binds the actual current task through the additional group handoff',async()=>{
  const f=h.f,special=await new SpecialCraftLibraryService(f.db).save(f.root,{id:null,expectedVersion:0,definition:{name:'TEST appended-preshrink craft',enabled:true,development:{minutes:60,calendar:'continuous',reminder:{enabled:false,percent:70}},bulk:{minutes:120,calendar:'continuous',reminder:{enabled:false,percent:70}}}},randomUUID());
  const ready=await f.bulkReady('特殊工艺',undefined,1,f.sourcing,{quantity:10,preshrink:'无需预缩',craftSteps:[{craftKind:'special',sequence:1,specialCraft:special}]}),instruction=new ProductionInstructionService(f.db,true),before=await instruction.read(f.root,ready.id);
  const draft=await instruction.save(f.root,ready.id,{expectedVersion:before.version,orderVersion:before.currentOrderVersion,sourceRound:before.sourceRound,document:{...before.document,preshrink:'需要预缩'}},randomUUID());
  const basis=await productionReadinessFixture(f.db,f.root,ready.id,f.people['pattern-room-worker']!.actorId,f.people.warehouse!);
  await instruction.publish(f.root,ready.id,{expectedVersion:draft.version,orderVersion:draft.currentOrderVersion,expectedReadinessRevision:basis.revision},randomUUID());
  const preparations=new BulkPreparationService(f.db),next=await preparations.read(f.root,ready.id);
  expect(next.preparationId).not.toBe(ready.preparationId);
  await preparations.dispatch(f.people['development-clerk']!,ready.id,{expectedVersion:next.dispatch.version,patternWorkerId:f.people['pattern-room-worker']!.actorId,deliverPattern:true},randomUUID());
  for(const kind of ['纸样完成','唛架完成'] as const)await completeBulkRangeFixture(f.db,f.people['pattern-room-worker']!,ready.id,next.preparationId!,kind);
  const preshrink=(await preparations.read(f.root,ready.id)).tasks.find(task=>task.taskKind==='warehouse_preshrink')!;
  const style=(await f.db.query('SELECT design_style_no FROM digital_production_orders WHERE production_order_id=$1',[ready.id])).rows[0].design_style_no as string;
  const tab=await h.open(f.people.warehouse!.actorId,1165,{},`/ui/digital-production?workspace=warehouse&tab=preshrink&search=${encodeURIComponent(style)}`);
  try{
   const queue=tab.page.getByRole('region',{name:'待预缩',exact:true}),open=queue.getByRole('link',{name:'进入原任务',exact:true});
   expect(new URL((await open.getAttribute('href'))!,tab.page.url()).searchParams.get('task')).toBe(preshrink.taskId);
   await open.click();
   await tab.page.getByRole('heading',{name:'仓库预缩办理',exact:true}).waitFor();
   const done=tab.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/orders/${ready.id}/bulk-preparation/complete`));
   await tab.page.getByRole('button',{name:'预缩完成',exact:true}).click();
   const response=await done;expect(response.status(),await response.text()).toBe(200);
   expect(response.request().postDataJSON()).toMatchObject({preparationId:next.preparationId,kind:'预缩完成'});
   await tab.page.getByRole('button',{name:'返回来源',exact:true}).click();
   await queue.getByText('没有符合当前授权和筛选的原仓库任务。',{exact:true}).waitFor();
   expect(new URL(tab.page.url()).searchParams.get('search')).toBe(style);
  }finally{await tab.close();}
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of (await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows)await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const result=await new SlaOrderService(f.db).read(f.root,ready.id);expect(result.status).toBe('planned');if(result.status!=='planned')throw Error('TEST expected original SLA plan');
  const own=result.evaluationPlan.nodes.filter(node=>node.parameterKey==='warehouse_preshrink'&&node.applicable==='yes'&&node.countsProgress);expect(own).toHaveLength(1);
  expect(own[0]!.id).toBe('warehouse_preshrink:'+next.preparationId);expect(result.facts[own[0]!.id]).toEqual(result.facts.warehouse_preshrink);expect(result.facts[own[0]!.id]?.businessCompleted).toBe(true);
  expect(result.nodes.find(node=>node.id===own[0]!.id)).toMatchObject({actualEnd:result.facts.warehouse_preshrink!.completedAt,status:expect.stringMatching(/^completed_/)});
  expect(result.evaluationPlan.nodes.find(node=>node.id==='bulk_cutting')!.dependsOn).toContain(own[0]!.id);expect(result.evaluationPlan.nodes.find(node=>node.id==='bulk_cutting')!.dependsOn).not.toContain('warehouse_preshrink');
  const journey=await new DigitalJourneyQuery(f.db).read(f.root,ready.id),node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.current&&node.key==='warehouse_preshrink')!;
  expect(node.timing).toMatchObject({id:own[0]!.id,actualEnd:result.facts.warehouse_preshrink!.completedAt});expect(journey.supervision!.nodes.filter(node=>node.id.startsWith('warehouse_preshrink'))).toHaveLength(1);
 });
 it('posts a real partial dispatch from the assigned warehouse task and reads the same fact from the original factory page',async()=>{
  const f=h.f,warehouse=f.people.warehouse!,ready=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:10});
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const original=await new FactoryFlowService(f.db).read(warehouse,ready.id),task=original.tasks.find(row=>row.taskKind==='warehouse_dispatch')!;
  const style=task.identity!.designStyleNo!;
  const tab=await h.open(warehouse.actorId,1165,{},`/ui/digital-production?workspace=warehouse&tab=dispatch&search=${encodeURIComponent(style)}`);
  try{
   const queue=tab.page.getByRole('region',{name:'待发料及发厂',exact:true}),open=queue.getByRole('link',{name:'进入原任务',exact:true});
   expect(new URL((await open.getAttribute('href'))!,tab.page.url()).searchParams.get('task')).toBe(task.taskId);
   await open.click();
   const work=tab.page.getByRole('region',{name:'仓库实际发厂',exact:true});await work.waitFor();
   expect(await work.getByRole('button',{name:/保存本批检查|保存工艺记录/}).count()).toBe(0);
   await work.locator(`input[name="quantity:${original.lines[0]!.lineId}"]`).fill('4');
   await work.getByRole('textbox',{name:'发厂说明',exact:true}).fill('TEST original warehouse first 4 pieces');
   const result=tab.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/orders/${ready.id}/factory-flow/dispatch`));
   await work.getByRole('button',{name:'保存本批实际发厂',exact:true}).click();
   const response=await result;expect(response.status(),await response.text()).toBe(200);
   expect(response.request().postDataJSON()).toMatchObject({lines:[{lineId:original.lines[0]!.lineId,quantity:4}],supplierId:f.supplierId});
   await work.getByText(/裁片已发 4 \/ 应发 10/).waitFor();
   await work.getByRole('button',{name:'返回来源',exact:true}).click();
   await open.waitFor();expect(new URL(tab.page.url()).searchParams.get('search')).toBe(style);
   await tab.page.goto(`${h.base}/ui/digital-production?factory=${ready.id}&factoryAction=dispatch`);
   await tab.page.getByText(/裁片已发 4 \/ 应发 10/).waitFor();
   expect((await f.db.query("SELECT count(*)::int AS total FROM digital_factory_facts WHERE preparation_id=$1 AND kind='仓库实际发厂'",[original.preparationId])).rows[0].total).toBe(1);
  }finally{await tab.close();}
 });
});
