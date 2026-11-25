import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {SpecialCraftLibraryService} from '../../apps/api/src/production-platform/special-craft-library.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {craftStepIdentity,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {warehouseOriginalIssueFixture} from '../helpers/warehouse-original-issue-fixture.js';
import {productionReadinessFixture,completeBulkRangeFixture} from '../helpers/production-readiness-fixture.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {MemberModuleBindingService} from '../../apps/api/src/access/member-module-binding-service.js';
import {readWarehouseCraftFactoryBasis} from '../../apps/api/src/production-platform/warehouse-craft-factory-basis.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('frozen double-special factory supervision through original App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-factory-supervision-app-')),{fullApp:true,workbenchNumberedCreation:true,merchandiserWorkbench:true});configureTimelineAdoption(h.f.db,'fixed_v2');});
 afterAll(async()=>{if(h){configureTimelineAdoption(h.f.db,'legacy');await h.writeEvidence();await h.dispose();}});
 it('opens and records only the assigned original craft communication from the live merchandiser menu',async()=>{
  const f=h.f,original=await f.bulkReady('印花');
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[original.caseId])).rows[0]!;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await original.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),sheet=await flow.read(f.root,original.id),task=sheet.tasks.find(row=>row.taskKind==='process_logistics')!;
  const assignee=Object.values(f.people).find(person=>person.actorId!==f.root.actorId&&person.actorRoles.includes(task.requiredRole))!;
  await new DigitalProductionTaskService(f.db).reassign(f.root,task.taskId,assignee.actorId,randomUUID());
  const tab=await h.open(assignee.actorId,1165,{},'/ui/my-tasks');
  try{
   const originalList=tab.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/todos/merchandiser/current');
   await tab.page.locator('nav[aria-label="主导航"]').getByRole('link',{name:'跟单工作区',exact:true}).click();
   const listed=await originalList;expect(listed.status(),await listed.text()).toBe(200);
   expect(await listed.json()).toMatchObject({craftOnly:true,items:[{itemId:task.taskId,craftCommunication:{taskId:task.taskId,
    orderId:original.id,preparationId:sheet.preparationId,stepRef:task.stepRef??null}}]});
   expect(await tab.page.getByRole('button',{name:'查找原授权订单',exact:true}).count()).toBe(0);
   await tab.page.getByRole('button',{name:'办理本项工艺沟通',exact:true}).click();
   const panel=tab.page.getByRole('region',{name:'本项工艺沟通',exact:true}),note='TEST only this exact physical craft scope';
   const input=panel.getByRole('textbox',{name:'本次沟通内容',exact:true});
   await input.fill(note);
   expect(await panel.getByText(/工艺发出|工艺回仓/).count()).toBe(0);
   const submissions:Array<{body:unknown;key:string|undefined}>=[];
   const path=`/orders/${original.id}/factory-flow/logistics`;
   await tab.page.route('**'+path,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    submissions.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
    if(submissions.length!==1)return route.continue();
    const real=await route.fetch();expect(real.status(),await real.text()).toBe(200);await route.abort('failed');
   });
   await panel.getByRole('button',{name:'记录沟通',exact:true}).click();
   await panel.getByRole('alert').waitFor();
   const sent=tab.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/orders/${original.id}/factory-flow/logistics`));
   await panel.getByRole('button',{name:'使用原内容核对提交结果',exact:true}).click();
   const saved=await sent;expect(saved.status(),await saved.text()).toBe(200);
   expect(saved.request().postDataJSON()).toMatchObject({kind:'工艺沟通',note,...(task.stepRef?{stepRef:task.stepRef}:{})});
   expect(submissions).toEqual([submissions[0],submissions[0]]);expect(submissions[0]?.key).toBeTruthy();
   await panel.getByText(note,{exact:true}).waitFor();
   expect((await flow.read(f.root,original.id)).facts.map(fact=>fact.kind)).toEqual(['工艺沟通']);
   const wrong=await tab.context.request.get(h.base+`/api/digital-production/orders/${original.id}/factory-flow/workbench-communication?`+
    new URLSearchParams({taskId:randomUUID(),preparationId:sheet.preparationId!,...(task.stepRef?{stepRef:task.stepRef}:{})}));
   expect(wrong.status()).toBe(404);
  }finally{await tab.close();}
  const ordinary=await h.open(f.people.merchandiser!.actorId,1165,{},'/ui/my-tasks');
  try{
   const candidate=await ordinary.context.request.get(h.base+'/api/todos/merchandiser/current');
   expect(candidate.status(),await candidate.text()).toBe(200);
   expect((await candidate.json()).items.map((item:{itemId:string})=>item.itemId)).not.toContain(task.taskId);
   const denied=await ordinary.context.request.post(h.base+`/api/digital-production/orders/${original.id}/factory-flow/logistics`,{
    headers:{'idempotency-key':randomUUID()},data:{kind:'工艺沟通',note:'TEST other role',supplier:'',occurredAt:businessNow().toISOString(),
      expectedRevision:(await flow.read(f.root,original.id)).revision,...(task.stepRef?{stepRef:task.stepRef}:{})},
   });
   expect(denied.status()).toBe(403);
  }finally{await ordinary.close();}
 });
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
 it('posts two exact warehouse craft stages in the original ledger and refuses quantities occupied for rework',async()=>{
  const f=h.f,warehouse=f.people.warehouse!,manager=f.people['production-management']!,maker=f.people['pattern-room-worker']!,owner=f.people.owner!,library=new SpecialCraftLibraryService(f.db);
  await f.access.ensureOrganizationPolicy();
  const craftApprover=await h.dedicated('owner_group','TEST owner for warehouse craft approvals');
  await new MemberModuleBindingService(f.db).run(f.root.actorId,{li_zhonghao:owner.actorId,wu_yunfeng:craftApprover.id,li_junyue:f.root.actorId},true);
  const craftSteps:CraftStepChoice[]=[];
  for(const [index,name] of ['TEST warehouse laser','TEST warehouse stones'].entries()){
   const standard={minutes:120,calendar:'continuous' as const,reminder:{enabled:false,percent:70}};
   const specialCraft=await library.save(f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:standard,bulk:standard}},randomUUID());
   craftSteps.push({craftKind:'special',sequence:index+1,specialCraft});
  }
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:`TEST-WH-${randomUUID().slice(0,8).toUpperCase()}`,supplierType:'factory',supplierName:'TEST second craft factory',address:'TEST',contractEntityName:'TEST',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0002',bankName:'TEST',changeReason:'TEST warehouse native scoped factory'}));
  const ready=await f.bulkReady('特殊工艺',undefined,1,f.sourcing,{quantity:100,craftSteps});
  const resource={kind:'order' as const,id:ready.id},quoteService=new DigitalQuotationService(f.db,true);
  // Seed only the assembled row identities in this disposable schema. The native
  // quote commands create both submissions, supplier versions and approvals.
  const rowIds=craftSteps.map(()=>randomUUID());
  const quote=(await f.db.query('SELECT document,assignments FROM digital_quotation_documents WHERE production_order_id=$1',[ready.id])).rows[0];
  const refs=Object.fromEntries(craftSteps.map((step,i)=>[rowIds[i]!,{kind:'craft',stage:'bulk',sourceRef:`craft:bulk:${craftStepIdentity(step)}`,craftRef:{libraryId:step.specialCraft!.id,libraryVersion:step.specialCraft!.version}}]));
  const existingRefs=Object.fromEntries(quote.document.rows.map((row:{rowId:string})=>[row.rowId,{kind:'material',stage:'development',sourceRef:row.rowId}]));
  await f.db.query('UPDATE digital_quotation_documents SET assembly=$2,document=$3,assignments=$4 WHERE production_order_id=$1',[ready.id,
   JSON.stringify({schemaVersion:1,sourceVersion:1,roundNumber:1,fingerprint:'TEST assembled bulk rows',rows:{...existingRefs,...refs}}),
   JSON.stringify({...quote.document,rows:[...quote.document.rows,...craftSteps.map((step,i)=>({rowId:rowIds[i],section:'外发工序',category:'工艺',name:step.specialCraft!.definition.name,specification:'TEST',unit:'件',supplier:'',consumption:'1',unitPrice:null}))]}),
   JSON.stringify([...quote.assignments,...rowIds.map(rowId=>({rowId,technicalAssigneeId:null,priceAssigneeId:maker.actorId,priceRole:'pattern_room_worker'}))])]);
  const factories=[f.supplierId,supplier.supplierId];
  for(const [index,rowId] of rowIds.entries()){
   await quoteService.writeSecondaryCraft(maker,resource,rowId,'submit',{mode:'outsourced',supplierId:factories[index]!,expectedVersion:0,applicableQuantity:'100',unit:'件',unitPrice:'2',attachmentIds:[],note:'TEST authoritative supplier'},randomUUID());
   await expect(quoteService.writeSecondaryCraft({...owner,actorId:craftApprover.id},resource,rowId,'decision',{expectedVersion:1,decision:'approved'},randomUUID())).resolves.toMatchObject({state:'approved'});
  }
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());
  let occupiedOrigin:string|null=null,known=true;
  const flow=new FactoryFlowService(f.db,async(client,scope)=>{
   if(!known)return null;
   if(scope.sourceFactId===occupiedOrigin&&occupiedOrigin){
    const fact=(await client.query('SELECT payload FROM digital_factory_facts WHERE fact_id=$1 AND preparation_id=$2',[occupiedOrigin,scope.preparationId])).rows[0];
    return fact?{...scope,lines:[{lineId:fact.payload.lines[0].lineId,quantity:20}]}:null;
   }
   return {...scope,lines:[]};
  });
  const initial=await flow.read(f.root,ready.id),lineId=initial.lines[0]!.lineId,[first,second]=initial.craftSteps!;
  expect([first!.sequence,second!.sequence]).toEqual([1,2]);
  for(const [i,step] of initial.craftSteps!.entries())await expect(readWarehouseCraftFactoryBasis(f.db,ready.id,step,false)).resolves.toMatchObject({supplierId:factories[i],approvalRevision:1});
  const command=async(stepRef:string,factoryId:string,kind:'send'|'return',sourceFactId:string|null,quantity:number)=>{
   const state=await flow.read(f.root,ready.id);
   const raw=(await f.db.query("SELECT p.task_id FROM digital_timeline_task_positions p JOIN digital_production_task_access a USING(task_id) WHERE p.route_ref=$1 AND p.step_id=$2 AND a.task_kind='process_logistics'",[ready.preparationId,stepRef])).rows[0];
   return {expectedRevision:state.revision,preparationId:ready.preparationId,taskId:raw.task_id as string,stepRef,factoryId,kind,sourceFactId,lines:[{lineId,quantity}],occurredAt:businessNow().toISOString(),note:'TEST original physical handover'};
  };
  const firstSend=await command(first!.stepId,factories[0]!,'send',null,100),key=randomUUID();
  await expect(new FactoryFlowService(f.db).warehouseCraftMotion(warehouse,ready.id,firstSend,key)).rejects.toMatchObject({statusCode:409});
  await expect(flow.warehouseCraftMotion(warehouse,ready.id,{...firstSend,factoryId:factories[1]!},key)).rejects.toMatchObject({statusCode:409});
  await expect(flow.warehouseCraftMotion(manager,ready.id,firstSend,key)).rejects.toMatchObject({statusCode:403});
  known=false;await expect(flow.warehouseCraftMotion(warehouse,ready.id,firstSend,key)).rejects.toMatchObject({statusCode:409});known=true;
  const s1=await flow.warehouseCraftMotion(warehouse,ready.id,firstSend,key),out1=s1.facts.find(row=>row.kind==='工艺发出')!;
  expect(out1.payload).toMatchObject({stepRef:first!.stepId,lines:[{lineId,quantity:100}],warehouseMotion:{factoryId:factories[0],approvalRevision:1}});
  expect(await flow.warehouseCraftMotion(warehouse,ready.id,firstSend,key)).toEqual(s1);
  const receive=async(stepRef:string,factoryId:string,sendId:string,quantity:number)=>{
   const response=await flow.warehouseCraftMotion(warehouse,ready.id,await command(stepRef,factoryId,'return',sendId,quantity),randomUUID());
   return response.facts.filter(row=>row.kind==='工艺回仓').at(-1)!;
  };
  const in1=await receive(first!.stepId,factories[0]!,out1.factId,60);
  const in2=await receive(first!.stepId,factories[0]!,out1.factId,40);
  expect([in1,in2].map(row=>row.payload)).toEqual([60,40].map(quantity=>expect.objectContaining({sendFactId:out1.factId,lines:[{lineId,quantity}]})));
  for(const fact of [in1,in2])await flow.qc(f.root,ready.id,{expectedRevision:(await flow.read(f.root,ready.id)).revision,stepRef:first!.stepId,returnFactId:fact.factId,note:'TEST actual QC release',checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]}]},randomUUID());
  occupiedOrigin=in1.factId;
  const count=async()=>Number((await f.db.query('SELECT count(*) FROM digital_factory_facts WHERE preparation_id=$1',[ready.preparationId])).rows[0].count);
  const before=await count();
  await expect(flow.warehouseCraftMotion(warehouse,ready.id,await command(second!.stepId,factories[1]!,'send',in1.factId,41),randomUUID())).rejects.toMatchObject({statusCode:409});
  expect(await count()).toBe(before);
  const s2=await flow.warehouseCraftMotion(warehouse,ready.id,await command(second!.stepId,factories[1]!,'send',in1.factId,40),randomUUID());
  const out2=s2.facts.filter(row=>row.kind==='工艺发出').at(-1)!;
  expect(out2.payload).toMatchObject({stepRef:second!.stepId,fromReturnId:in1.factId,lines:[{lineId,quantity:40}],warehouseMotion:{factoryId:factories[1]}});
  const in3=await receive(second!.stepId,factories[1]!,out2.factId,25),in4=await receive(second!.stepId,factories[1]!,out2.factId,15);
  expect([in3,in4].map(row=>row.payload)).toEqual([25,15].map(quantity=>expect.objectContaining({sendFactId:out2.factId,lines:[{lineId,quantity}]})));
  expect((await flow.read(f.root,ready.id)).inTransit).toBe(false);
  expect(await count()).toBe(before+3);
  await flow.qc(f.root,ready.id,{expectedRevision:(await flow.read(f.root,ready.id)).revision,stepRef:second!.stepId,returnFactId:in3.factId,note:'TEST exact final QC release',checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]}]},randomUUID());
  occupiedOrigin=in3.factId;
  const dispatch={expectedRevision:(await flow.read(f.root,ready.id)).revision,returnFactId:in3.factId,supplierId:f.supplierId,occurredAt:businessNow().toISOString(),note:'TEST final accepted physical dispatch'};
  await expect(flow.dispatch(warehouse,ready.id,{...dispatch,lines:[{lineId,quantity:6}]},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect(await count()).toBe(before+3);
  const result=await flow.dispatch(warehouse,ready.id,{...dispatch,lines:[{lineId,quantity:5}]},randomUUID());
  expect(result.facts.filter(row=>row.kind==='仓库实际发厂')).toEqual([expect.objectContaining({payload:expect.objectContaining({returnFactId:in3.factId,lines:[{lineId,quantity:5}]})})]);
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
 it('sends one exact available accessory lot from the original assigned warehouse form and refreshes remaining quantity',async()=>{
  const f=h.f,prepared=await warehouseOriginalIssueFixture(f),{id,warehouse,resource,batch,preparation,scope,bulk,now}=prepared;
  const original=await f.runtime.run(prepared.scene,f.root,()=>preparation.recordWarehouseReceiptBatch(warehouse,resource,batch,randomUUID()));
  const receipt=original.history.find(row=>row.warehouseReceipt)!;
  const tab=await h.open(warehouse.actorId,1165,{},`/ui/digital-production?bulk=${id}`);
  try{
   const page=tab.page;await page.getByText('辅料发出记录 · 0 次',{exact:true}).click();
   await page.getByText('共享物料 · 采用需用 500 米 · 本范围可发 500 米',{exact:true}).waitFor();
   await page.getByRole('textbox',{name:'第 1 批实际发出（米，本批可用 500）',exact:true}).fill('300');
   await page.getByLabel('实际时间（北京时间）',{exact:true}).fill(new Date(Date.parse(now)+8*3600000).toISOString().slice(0,16));
   const committed=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/orders/${id}/bulk-preparation/materials-dispatch`));
   await page.getByRole('button',{name:'保存辅料发出',exact:true}).click();
   const response=await committed;expect(response.status(),await response.text()).toBe(200);
   expect(response.request().postDataJSON()).toMatchObject({supplierId:f.supplierId,items:[{materialId:scope.id,quantity:300,unit:'米',
    scope:{lineId:null,scopeRef:'whole',allocations:[{receipt:{recordId:receipt.recordId,version:receipt.version},quantity:'300'}]}}]});
   await page.getByText('共享物料 · 采用需用 500 米 · 本范围可发 200 米',{exact:true}).waitFor();
   expect(await page.getByRole('textbox',{name:'第 1 批实际发出（米，本批可用 200）',exact:true}).inputValue()).toBe('');
   expect((await bulk.read(warehouse,id)).materials?.history).toMatchObject([{items:[{materialId:scope.id,quantity:300,unit:'米'}]}]);
  }finally{await tab.close();}
 });
 it('lets the assigned warehouse record a failed report for a named actual fabric lot without authorizing its release',async()=>{
  const f=h.f,p=await warehouseOriginalIssueFixture(f,{fabricPurchase:true});
  const history=await f.runtime.run(p.scene,f.root,()=>p.preparation.recordWarehouseReceiptBatch(p.warehouse,p.resource,p.fabricBatch!,randomUUID()));
  const actual=history.history.find(row=>row.warehouseReceipt?.kind==='fabric_receipt')!;
  const tab=await h.open(p.warehouse.actorId,1165,{},`/ui/digital-production?bulk=${p.id}`);
  try{
   const page=tab.page;await page.getByText('面料验布 · 可预缩',{exact:true}).click();
   const report=page.getByRole('group',{name:'验布报告',exact:true});
   const physical=report.getByRole('checkbox',{name:/TEST棉布.*第 1 批.*500 米/});
   await physical.click();
   await report.getByRole('combobox').selectOption('不合格');
   await report.getByRole('textbox',{name:'检验情况',exact:true}).fill('TEST 当批面料未达到原质量要求');
   const committed=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/orders/${p.id}/bulk-preparation/fabric-report`));
   await report.getByRole('button',{name:'保存验布报告',exact:true}).click();
   const response=await committed;expect(response.status(),await response.text()).toBe(200);
   expect(response.request().postDataJSON()).toMatchObject({receiptBatches:[{materialId:p.fabricBatch!.materialId,receipt:{recordId:actual.recordId,version:actual.version}}],result:'不合格'});
   await page.getByText('面料验布 · 等待质量决定',{exact:true}).waitFor();
   expect(await page.getByRole('button',{name:'允许继续使用',exact:true}).count()).toBe(0);
   expect((await p.bulk.read(p.warehouse,p.id)).materials?.items.find(item=>item.kind==='fabric')?.issueOptions).toEqual([]);
  }finally{await tab.close();}
 });
});
