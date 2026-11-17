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

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('frozen double-special factory supervision through original App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-factory-supervision-app-')),{fullApp:true});configureTimelineAdoption(h.f.db,'fixed_v2');});
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
});
