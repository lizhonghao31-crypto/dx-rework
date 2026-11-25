import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {SpecialCraftLibraryService} from '../../apps/api/src/production-platform/special-craft-library.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {readGarmentReworkSource} from '../../apps/api/src/production-platform/garment-quality.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {craftStepIdentity,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {CreateResponsibilityDraftSchema,CreateSupplierSchema,ResponsibilityDeterminationResponseSchema} from '@dx-rework/contracts';
import {FactoryLogisticsSchema} from '@dx-rework/contracts/factory-flow';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {warehouseOriginalIssueFixture} from '../helpers/warehouse-original-issue-fixture.js';
import {productionReadinessFixture,completeBulkRangeFixture} from '../helpers/production-readiness-fixture.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {MemberModuleBindingService} from '../../apps/api/src/access/member-module-binding-service.js';
import {readWarehouseCraftFactoryBasis} from '../../apps/api/src/production-platform/warehouse-craft-factory-basis.js';
import {lockCraftProblemForOriginalRework,readCurrentCraftProblem} from '../../apps/api/src/production-platform/quality-craft-problem-scope.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {ReworkInitiationService} from '../../apps/api/src/rework/service.js';
import {ReworkV2SubmissionService} from '../../apps/api/src/rework/v2-submission-service.js';
import {ensureWithinSourceReceivingActualQuantity} from '../../apps/api/src/rework/receiving-quantity-ceiling.js';
import {ProcessConfigurationService} from '../../apps/api/src/rework/process-configuration-service.js';
import {ProcessWorkerPlanService} from '../../apps/api/src/rework/process-worker-plan-service.js';
import {WorkReportingService} from '../../apps/api/src/rework/work-reporting-service.js';
import {WholeOrderReviewService} from '../../apps/api/src/rework/whole-order-review-service.js';
import {AuthorizedResponsibilityDeterminationService} from '../../apps/api/src/rework/responsibility-determination-authorized-service.js';
import {externalCraftRepairProgress} from '../../apps/api/src/production-platform/warehouse-craft-rework-return.js';
import {readQualityWarehouseCraftOccupation} from '../../apps/api/src/production-platform/quality-warehouse-craft-occupation.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {pendingReceivingForAuthorizedOrders} from '../../apps/api/src/receiving/pending-receiving-original-allocation.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('frozen double-special factory supervision through original App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-factory-supervision-app-')),{fullApp:true,workbenchNumberedCreation:true,originalCraftRework:true});configureTimelineAdoption(h.f.db,'fixed_v2');});
 afterAll(async()=>{if(h){configureTimelineAdoption(h.f.db,'legacy');await h.writeEvidence();await h.dispose();}});
 it('uses the original assigned quality form for an exact plant and receipt, and refuses a superseded receipt quantity',async()=>{
  const f=h.f,original=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:500}),qc=f.people.qc!,warehouse=f.people.warehouse!,flow=new FactoryFlowService(f.db);
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[original.caseId])).rows[0].cutting_order_id;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await original.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:500,attachmentIds:[await f.image(cutter)]},randomUUID());
  const before=await flow.read(f.root,original.id),occurredAt=businessNow().toISOString(),day=beijingCalendarDate(new Date(occurredAt));
  await flow.dispatch(warehouse,original.id,{expectedRevision:before.revision,supplierId:f.supplierId,occurredAt,note:'TEST original factory dispatch'},randomUUID());
  const current=await flow.read(f.root,original.id),task=current.tasks.find(row=>row.taskKind==='factory_production_qc')!;
  await new DigitalProductionTaskService(f.db).reassign(f.root,task.taskId,qc.actorId,randomUUID());
  const production=current.productionId!,line=current.lines[0]!,style=task.identity!.designStyleNo;
  const reports=new ProductionReportingService(f.db);
  await reports.report(f.root,production,{position:1,businessDate:day,quantity:500},randomUUID());
  await reports.execute(f.root,production,'complete',{businessDate:day,confirmed:true},randomUUID());
  await reports.execute(f.root,production,'ship',{businessDate:day,confirmed:true},randomUUID());
  const receiving=new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db));
  const receiver={...warehouse,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  const intake=await receiving.create(receiver,{cuttingOrderId:cut,productionOrderId:production,factoryDecisionId:null,documentQuantity:280,actualQuantity:280,attachmentIds:[await f.image(receiver)]},randomUUID());
  const originalBalance=async()=>pendingReceivingForAuthorizedOrders(f.db,[original.id]);
  const balance=await originalBalance();
  expect(balance).toMatchObject([{expectedQuantity:500,balance:{received:280,remaining:220}}]);
  const pagePath=`/ui/digital-production?workspace=quality&kind=factory&search=${encodeURIComponent(style)}`;
  const tab=await h.open(qc.actorId,1165,{},pagePath);
  try{
   const plant=tab.page.getByRole('region',{name:'在厂加工检查清单',exact:true}),plantLink=plant.getByRole('link',{name:'办理本批检查',exact:true});
   await plantLink.click();
   expect(new URL(tab.page.url()).searchParams.get('qualityProduction')).toBe(production);
   expect(new URL(tab.page.url()).searchParams.get('qualityDecision')).toBe('original');
   expect(new URL(tab.page.url()).searchParams.get('line')).toBe(line.lineId);
   const plantForm=tab.page.getByRole('group',{name:'本次检查',exact:true});await plantForm.waitFor();
   expect(await plantForm.getByLabel('本次结论').count()).toBe(1);
   expect(await tab.page.getByRole('heading',{name:'大货洗水',exact:true}).count()).toBe(0);
   const beforePlant=(await f.db.query('SELECT count(*)::int AS count FROM rework_orders')).rows[0].count;
   const inspected=await tab.context.request.post(`${h.base}/api/digital-production/orders/${original.id}/factory-flow/production-qc`,{
    headers:{'idempotency-key':randomUUID()},data:{expectedRevision:(await flow.read(qc,original.id)).revision,
     occurredAt:businessNow().toISOString(),factoryDecisionId:null,note:'',
     checks:[{lineId:line.lineId,result:'需处理',problem:'TEST actual issue, fault quantity not established'}]},
   });
   expect(inspected.status(),await inspected.text()).toBe(200);
   expect((await inspected.json()).productionChecks).toEqual([expect.objectContaining({lineId:line.lineId,productionId:production,
    result:'需处理',problem:'TEST actual issue, fault quantity not established'})]);
   await tab.page.reload();
   await tab.page.getByText('TEST actual issue, fault quantity not established',{exact:true}).waitFor();
   expect(await tab.page.getByRole('button',{name:/返工/}).count()).toBe(0);
   expect((await f.db.query('SELECT count(*)::int AS count FROM rework_orders')).rows[0].count).toBe(beforePlant);
   await tab.page.getByRole('button',{name:'返回来源',exact:true}).click();
   await plant.getByText('没有符合当前授权和筛选的检查。',{exact:true}).waitFor();
   expect(new URL(tab.page.url()).searchParams.get('search')).toBe(style);
   await tab.page.goto(h.base+pagePath.replace('kind=factory','kind=garment'));
   const queue=tab.page.getByRole('region',{name:'成衣到仓检查清单',exact:true}),row=queue.getByRole('row').filter({hasText:'280 件 / 待核'});
   await row.getByRole('link',{name:'办理本批检查',exact:true}).click();
   const firstLink=tab.page.url();
   expect(new URL(firstLink).searchParams.get('qualityReceipt')).toBe(intake.value.receiptId);
   expect(new URL(firstLink).searchParams.get('qualityQuantityVersion')).toBe(intake.value.receiptId);
   const inspect=tab.page.getByRole('region',{name:'本批原质检',exact:true});await inspect.getByText('本批实收 280 件 · 待检查',{exact:true}).waitFor();
   await inspect.getByText('登记本批到仓质检',{exact:true}).click();
   await inspect.getByLabel('检查时间',{exact:true}).selectOption('now');
   await inspect.getByLabel('本批合格数量',{exact:true}).fill('260');
   await inspect.getByLabel('质量问题／处理说明',{exact:true}).fill('TEST twenty garments require attention');
   const checked=tab.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/orders/${original.id}/closure/quality`));
   await inspect.getByRole('button',{name:'保存到仓质检',exact:true}).click();const result=await checked;
   expect(result.status(),await result.text()).toBe(200);
   expect(result.request().postDataJSON()).toMatchObject({receiptId:intake.value.receiptId,quantityVersion:intake.value.receiptId,qualifiedQuantity:260});
   const checkedGarment={orderId:original.id,receiptId:intake.value.receiptId,quantityVersion:intake.value.receiptId,eventId:(await result.json()).eventId as string};
   await expect(readGarmentReworkSource(f.db,qc,checkedGarment)).resolves.toMatchObject({receivingBatchId:intake.value.receivingBatchId,
    lineId:line.lineId,sourceEventId:checkedGarment.eventId,quantity:20});
   await expect(readGarmentReworkSource(f.db,warehouse,checkedGarment)).rejects.toMatchObject({statusCode:403});
   await expect(readGarmentReworkSource(f.db,qc,{...checkedGarment,eventId:randomUUID()})).rejects.toMatchObject({statusCode:409});
   await inspect.getByText('本批实收 280 件 · 已检查，合格 260',{exact:true}).waitFor();
   const draftResponse=tab.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/rework-orders/garment-quality/drafts'));
   await inspect.getByRole('button',{name:'按本批问题发起返工',exact:true}).click();
   const entered=await draftResponse;
   expect(entered.status(),await entered.text()).toBe(201);
   expect(entered.request().postDataJSON()).toEqual(checkedGarment);
   const draftKey=entered.request().headers()['idempotency-key']!;
   const draft=await entered.json();
   expect(draft).toMatchObject({receivingBatchId:intake.value.receivingBatchId,reworkQuantity:20,status:'draft'});
   const reworkLink=inspect.getByRole('link',{name:'查看原成衣返工单',exact:true});await reworkLink.waitFor();
   expect(await reworkLink.getAttribute('href')).toContain(`/ui/tasks/${draft.reworkOrderId}`);
   const retry=await tab.context.request.post(`${h.base}/api/rework-orders/garment-quality/drafts`,{
    headers:{'idempotency-key':randomUUID()},data:checkedGarment,
   });
   expect(retry.status(),await retry.text()).toBe(201);
   expect(await retry.json()).toMatchObject({reworkOrderId:draft.reworkOrderId});
   const duplicate=await tab.context.request.post(`${h.base}/api/rework-orders/drafts`,{
    headers:{'idempotency-key':randomUUID()},data:{receivingBatchId:intake.value.receivingBatchId},
   });
   expect(duplicate.status()).toBe(409);
   expect((await f.db.query('SELECT source_garment_qc_event_id,rework_quantity FROM rework_orders WHERE rework_order_id=$1',[draft.reworkOrderId])).rows).toEqual([
    expect.objectContaining({source_garment_qc_event_id:checkedGarment.eventId,rework_quantity:20})]);
   await expect(ensureWithinSourceReceivingActualQuantity(f.db,draft.reworkOrderId,[{label:'实际返工',quantity:21}])).rejects.toMatchObject({statusCode:400});
   expect(await originalBalance()).toEqual(balance);
   const second=await receiving.createRepeated(receiver,{receivingBatchId:intake.value.receivingBatchId,cuttingOrderId:cut,productionOrderId:production,factoryDecisionId:null,source:'other_factory',documentQuantity:2,actualQuantity:2},randomUUID());
   await expect(readGarmentReworkSource(f.db,qc,{...checkedGarment,receiptId:second.value.receiptId,quantityVersion:second.value.receiptId})).rejects.toMatchObject({statusCode:409});
   expect(await inspect.getByText('本批实收 2 件',{exact:false}).count()).toBe(0);
   await tab.page.getByRole('button',{name:'返回来源',exact:true}).click();
   const remaining=queue.getByRole('link',{name:'办理本批检查',exact:true});
   expect(new URL((await remaining.getAttribute('href'))!,tab.page.url()).searchParams.get('qualityReceipt')).toBe(second.value.receiptId);
   const version=Number((await f.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[intake.value.receivingBatchId])).rows[0].version);
   await receiving.correctReceipt({...f.root,authorizationCapability:'receiving:correct',authorizationCapabilities:['receiving:correct']},intake.value.receiptId,{expectedVersion:version,documentQuantity:280,actualQuantity:270,defectiveQuantity:0});
   await expect(readGarmentReworkSource(f.db,qc,checkedGarment)).rejects.toMatchObject({statusCode:409});
   const staleDraft=await tab.context.request.post(`${h.base}/api/rework-orders/garment-quality/drafts`,{
    headers:{'idempotency-key':randomUUID()},data:checkedGarment,
   });
   expect(staleDraft.status()).toBe(409);
   const replay=await tab.context.request.post(`${h.base}/api/rework-orders/garment-quality/drafts`,{
    headers:{'idempotency-key':draftKey},data:checkedGarment,
   });
   expect(replay.status(),await replay.text()).toBe(201);
   expect(replay.headers()['idempotency-replayed']).toBe('true');
   expect((await replay.json()).reworkOrderId).toBe(draft.reworkOrderId);
   for(const action of ['submit','submit-v2']){
    const refused=await tab.context.request.post(`${h.base}/api/rework-orders/${draft.reworkOrderId}/${action}`,{
     headers:{'idempotency-key':randomUUID()},data:{expectedVersion:draft.version},
    });
    expect(refused.status(),await refused.text()).toBe(409);
    expect(await refused.text()).toContain('原检查或本批实收数量版本已变化');
   }
   expect((await f.db.query('SELECT status FROM rework_orders WHERE rework_order_id=$1',[draft.reworkOrderId])).rows[0]?.status).toBe('draft');
   await tab.page.goto(firstLink);
   await tab.page.getByRole('alert').filter({hasText:'本批实收或数量版本已变化'}).waitFor();
   expect(await tab.page.getByRole('button',{name:'保存到仓质检',exact:true}).count()).toBe(0);
   await tab.page.getByRole('button',{name:'返回来源',exact:true}).click();
   await expect.poll(()=>remaining.count()).toBe(2);
   const refreshed=new URL((await remaining.filter({hasText:'办理本批检查'}).first().getAttribute('href'))!,tab.page.url());
   const entries=await remaining.evaluateAll(links=>links.map(link=>(link as HTMLAnchorElement).href));
   expect(refreshed.searchParams.get('closure')).toBe(original.id);
   const exact=entries.map(entry=>new URL(entry).searchParams).find(params=>params.get('qualityReceipt')===intake.value.receiptId)!;
   expect(exact.get('qualityQuantityVersion')).not.toBe(intake.value.receiptId);
  }finally{await tab.close();}
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
  const qcPhotos:{stepRef:string;returnFactId:string;attachmentId:string}[]=[];
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
   const attachmentId=await f.image(f.root);qcPhotos.push({stepRef:step.stepId,returnFactId:prior,attachmentId});
   await flow.qc(f.root,ready.id,{expectedRevision:state.revision,stepRef:step.stepId,returnFactId:prior,note:'TEST real original QC',checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[attachmentId]}]},randomUUID());
   state=await flow.read(f.root,ready.id);await verify();
  }
  const {detail}=await verify(),tab=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+ready.id);
  try{
   const [first,second]=qcPhotos,check=state.checks.find(row=>row.returnFactId===first!.returnFactId)!;
   const original=`${h.base}/api/digital-production/orders/${ready.id}/factory-flow/original-attachments/`;
   const selected=new URLSearchParams({lineId,checkId:check.checkId,returnFactId:first!.returnFactId,stepRef:first!.stepRef});
   const exact=await tab.context.request.get(original+first!.attachmentId+'?'+selected,{maxRedirects:0});
   expect(exact.status()).toBe(302);expect(exact.headers()['cache-control']?.split(',').map(value=>value.trim())).toContain('no-store');
   expect((await tab.context.request.get(original+second!.attachmentId+'?'+selected,{maxRedirects:0})).status()).toBe(404);
   selected.set('stepRef',second!.stepRef);
   expect((await tab.context.request.get(original+first!.attachmentId+'?'+selected,{maxRedirects:0})).status()).toBe(404);
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
  const cutQuantity=440,firstReturn=400,sameFactoryReturn=40,oldOccupied=20,secondSend=380,firstSecondReturn=80,problemReturn=300,
   outsidePieces=20,returnPortion=10,inspectedPieces=290,passedPieces=270,heldPieces=30;
  const ready=await f.bulkReady('特殊工艺',undefined,1,f.sourcing,{quantity:cutQuantity,craftSteps});
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
   await quoteService.writeSecondaryCraft(maker,resource,rowId,'submit',{mode:'outsourced',supplierId:factories[index]!,expectedVersion:0,applicableQuantity:String(cutQuantity),unit:'件',unitPrice:'2',attachmentIds:[],note:'TEST authoritative supplier'},randomUUID());
   await expect(quoteService.writeSecondaryCraft({...owner,actorId:craftApprover.id},resource,rowId,'decision',{expectedVersion:1,decision:'approved'},randomUUID())).resolves.toMatchObject({state:'approved'});
  }
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:cutQuantity,attachmentIds:[await f.image(cutter)]},randomUUID());
  let occupiedOrigin:string|null=null,known=true;
  const flow=new FactoryFlowService(f.db,async(client,scope)=>{
   if(!known)return null;
   if(scope.sourceFactId===occupiedOrigin&&occupiedOrigin){
    const fact=(await client.query('SELECT payload FROM digital_factory_facts WHERE fact_id=$1 AND preparation_id=$2',[occupiedOrigin,scope.preparationId])).rows[0];
    return fact?{...scope,lines:[{lineId:fact.payload.lines[0].lineId,quantity:oldOccupied}]}:null;
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
  const firstSend=await command(first!.stepId,factories[0]!,'send',null,cutQuantity),key=randomUUID();
  await expect(new FactoryFlowService(f.db).warehouseCraftMotion(warehouse,ready.id,firstSend,key)).rejects.toMatchObject({statusCode:409});
  await expect(flow.warehouseCraftMotion(warehouse,ready.id,{...firstSend,factoryId:factories[1]!},key)).rejects.toMatchObject({statusCode:409});
  await expect(flow.warehouseCraftMotion(manager,ready.id,firstSend,key)).rejects.toMatchObject({statusCode:403});
  known=false;await expect(flow.warehouseCraftMotion(warehouse,ready.id,firstSend,key)).rejects.toMatchObject({statusCode:409});known=true;
  const live=new FactoryFlowService(f.db,readQualityWarehouseCraftOccupation),warehouseStyle=(await f.db.query('SELECT design_style_no FROM digital_production_orders WHERE production_order_id=$1',[ready.id])).rows[0].design_style_no as string;
  await expect(live.warehouseCraftWork(manager,ready.id)).rejects.toMatchObject({statusCode:403});
  const entry=await h.open(warehouse.actorId,1165,{},`/ui/digital-production?workspace=warehouse&tab=craft&search=${encodeURIComponent(warehouseStyle)}`);
  let s1:Awaited<ReturnType<FactoryFlowService['warehouseCraftMotion']>>,wire:typeof firstSend,wireKey:string;
  try{
   await entry.page.getByRole('region',{name:'原仓库工艺收发',exact:true}).getByRole('link',{name:'进入原任务',exact:true}).click();
   await entry.page.getByRole('heading',{name:'仓库实际工艺收发',exact:true}).waitFor();
   const options=entry.page.getByRole('combobox',{name:'实际办理工艺与批次',exact:true});await options.click();
   await entry.page.getByRole('option').filter({hasText:'TEST warehouse laser'}).click();
   await entry.page.getByRole('group',{name:'登记本批实际发出',exact:true}).getByRole('textbox',{name:new RegExp(`可办 ${cutQuantity} 片`)}).fill(String(cutQuantity));
   await entry.page.getByLabel('实际发生时间（北京时间）',{exact:true}).fill(new Date(Date.parse(firstSend.occurredAt)+8*3600000).toISOString().slice(0,23));
   await entry.page.getByRole('textbox',{name:'本次实际说明',exact:true}).fill('TEST 原仓库首批发出');
   const posted=entry.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/orders/${ready.id}/factory-flow/logistics`));
   await entry.page.getByRole('button',{name:'保存本批原收发',exact:true}).click();const response=await posted;
   expect(response.status(),await response.text()).toBe(200);
   const sent=response.request().postDataJSON();
   expect(sent).toMatchObject({kind:'工艺发出',stepRef:first!.stepId,warehouse:{taskId:firstSend.taskId,factoryId:factories[0]},lines:[{lineId,quantity:cutQuantity}]});
   s1=await response.json();wire={...firstSend,note:sent.note,occurredAt:sent.occurredAt,expectedRevision:sent.expectedRevision};
   wireKey=response.request().headers()['idempotency-key']!;
   await entry.page.getByText('已保存原仓库收发记录。',{exact:true}).waitFor();
   await entry.page.getByRole('button',{name:'返回来源',exact:true}).click();
   await entry.page.getByRole('region',{name:'原仓库工艺收发',exact:true}).waitFor();
   expect(new URL(entry.page.url()).searchParams.get('search')).toBe(warehouseStyle);
  }finally{await entry.close();}
  const out1=s1.facts.find(row=>row.kind==='工艺发出')!;
  expect(out1.payload).toMatchObject({stepRef:first!.stepId,lines:[{lineId,quantity:cutQuantity}],warehouseMotion:{factoryId:factories[0],approvalRevision:1}});
  expect(await live.warehouseCraftMotion(warehouse,ready.id,wire,wireKey)).toEqual(s1);
  const receive=async(stepRef:string,factoryId:string,sendId:string,quantity:number)=>{
   const response=await flow.warehouseCraftMotion(warehouse,ready.id,await command(stepRef,factoryId,'return',sendId,quantity),randomUUID());
   return response.facts.filter(row=>row.kind==='工艺回仓').at(-1)!;
  };
  const in1=await receive(first!.stepId,factories[0]!,out1.factId,firstReturn);
  const in2=await receive(first!.stepId,factories[0]!,out1.factId,sameFactoryReturn);
  expect([in1,in2].map(row=>row.payload)).toEqual([firstReturn,sameFactoryReturn].map(quantity=>expect.objectContaining({sendFactId:out1.factId,lines:[{lineId,quantity}]})));
  for(const fact of [in1,in2])await flow.qc(f.root,ready.id,{expectedRevision:(await flow.read(f.root,ready.id)).revision,stepRef:first!.stepId,returnFactId:fact.factId,note:'TEST actual QC release',checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]}]},randomUUID());
  occupiedOrigin=in1.factId;
  const count=async()=>Number((await f.db.query('SELECT count(*) FROM digital_factory_facts WHERE preparation_id=$1',[ready.preparationId])).rows[0].count);
  const before=await count();
  await expect(flow.warehouseCraftMotion(warehouse,ready.id,await command(second!.stepId,factories[1]!,'send',in1.factId,secondSend+1),randomUUID())).rejects.toMatchObject({statusCode:409});
  expect(await count()).toBe(before);
  const s2=await flow.warehouseCraftMotion(warehouse,ready.id,await command(second!.stepId,factories[1]!,'send',in1.factId,secondSend),randomUUID());
  const out2=s2.facts.filter(row=>row.kind==='工艺发出').at(-1)!;
  expect(out2.payload).toMatchObject({stepRef:second!.stepId,fromReturnId:in1.factId,lines:[{lineId,quantity:secondSend}],warehouseMotion:{factoryId:factories[1]}});
  const in3=await receive(second!.stepId,factories[1]!,out2.factId,firstSecondReturn),in4=await receive(second!.stepId,factories[1]!,out2.factId,problemReturn);
  expect([in3,in4].map(row=>row.payload)).toEqual([firstSecondReturn,problemReturn].map(quantity=>expect.objectContaining({sendFactId:out2.factId,lines:[{lineId,quantity}]})));
  expect((await flow.read(f.root,ready.id)).inTransit).toBe(false);
  expect(await count()).toBe(before+3);
  await flow.qc(f.root,ready.id,{expectedRevision:(await flow.read(f.root,ready.id)).revision,stepRef:second!.stepId,returnFactId:in3.factId,note:'TEST exact final QC release',checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]}]},randomUUID());
  occupiedOrigin=in3.factId;
  const dispatch={expectedRevision:(await flow.read(f.root,ready.id)).revision,returnFactId:in3.factId,supplierId:f.supplierId,occurredAt:businessNow().toISOString(),note:'TEST final accepted physical dispatch'};
  await expect(flow.dispatch(warehouse,ready.id,{...dispatch,lines:[{lineId,quantity:firstSecondReturn-oldOccupied+1}]},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect(await count()).toBe(before+3);
  const result=await flow.dispatch(warehouse,ready.id,{...dispatch,lines:[{lineId,quantity:firstSecondReturn-oldOccupied}]},randomUUID());
  expect(result.facts.filter(row=>row.kind==='仓库实际发厂')).toEqual([expect.objectContaining({payload:expect.objectContaining({returnFactId:in3.factId,lines:[{lineId,quantity:firstSecondReturn-oldOccupied}]})})]);
  const qc=f.people.qc!,qcTask=(await f.db.query(`SELECT p.task_id FROM digital_timeline_task_positions p
   JOIN digital_production_task_access a USING(task_id) WHERE p.route_ref=$1 AND p.step_id=$2 AND a.task_kind='bulk_qc'`,[ready.preparationId,second!.stepId])).rows[0];
  const taskService=new DigitalProductionTaskService(f.db);
  await taskService.reassign(f.root,qcTask.task_id,qc.actorId,randomUUID());
  const qualityQuery={kind:'craft' as const,status:'open' as const,page:1,search:''};
  const qualityWork=await taskService.qualityDirectory(qc,'craft',qualityQuery);
  expect(qualityWork).toMatchObject({page:1,items:[{source:{taskId:qcTask.task_id,returnFactId:in4.factId}}],total:1});
  expect(await taskService.qualityDirectory(qc,'craft',{...qualityQuery,page:2})).toEqual({page:2,items:[],total:1});
  await expect(taskService.qualityDirectory(warehouse,'craft',qualityQuery)).rejects.toMatchObject({statusCode:403});
  const qualityStyle=(await f.db.query('SELECT design_style_no FROM digital_production_orders WHERE production_order_id=$1',[ready.id])).rows[0].design_style_no as string;
  const qualityTab=await h.open(qc.actorId,1165,{},`/ui/digital-production?workspace=quality&kind=craft&search=${encodeURIComponent(qualityStyle)}`);
  try{
   await qualityTab.page.getByRole('heading',{name:'质量中心',exact:true}).waitFor();
   const queue=qualityTab.page.getByRole('region',{name:'工艺回仓质检原任务',exact:true});
   const open=queue.getByRole('link',{name:'办理本批检查',exact:true});
   const entry=new URL((await open.getAttribute('href'))!,qualityTab.page.url());
   expect(entry.searchParams.get('qualityTask')).toBe(qcTask.task_id);
   expect(entry.searchParams.get('qualityReturn')).toBe(in4.factId);
   expect(entry.searchParams.get('qualityStep')).toBe(second!.stepId);
   await open.click();
   await qualityTab.page.getByRole('region',{name:'本批原工艺检查',exact:true}).getByText(`本批实际回仓 ${problemReturn} 片`,{exact:true}).waitFor();
   expect(new URL(qualityTab.page.url()).searchParams.get('factory')).toBe(ready.id);
   await qualityTab.page.getByRole('button',{name:'返回来源',exact:true}).click();
   await open.waitFor();
   expect(new URL(qualityTab.page.url()).searchParams.get('search')).toBe(qualityStyle);
  }finally{await qualityTab.close();}
  const originalReportPhoto=await f.image(qc);
  const inspected={expectedRevision:(await flow.read(f.root,ready.id)).revision,stepRef:second!.stepId,returnFactId:in4.factId,note:'TEST count remaining physical return',
   checks:[{lineId,result:'需处理' as const,problem:'TEST twenty affected pieces',treatment:'',attachmentIds:[originalReportPhoto],
    quantityScope:{inspectedQuantity:inspectedPieces,qualifiedQuantity:passedPieces,problemQuantity:outsidePieces,unit:'片' as const}}]};
  await expect(flow.qc(qc,ready.id,{...inspected,checks:[{...inspected.checks[0]!,quantityScope:{inspectedQuantity:problemReturn+1,qualifiedQuantity:problemReturn+1-outsidePieces,problemQuantity:outsidePieces,unit:'片'}}]},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(flow.qc(warehouse,ready.id,inspected,randomUUID())).rejects.toMatchObject({statusCode:403});
  const counted=await flow.qc(qc,ready.id,inspected,randomUUID()),current=counted.checks.find(check=>check.returnFactId===in4.factId)!;
  expect(counted.batches?.find(batch=>batch.factId===in4.factId)?.rows).toMatchObject([{lineId,available:problemReturn,releasedAvailable:passedPieces}]);
  const locate={orderId:ready.id,preparationId:ready.preparationId,stepRef:second!.stepId,returnFactId:in4.factId,lineId,checkId:current.checkId};
  const disposition={orderId:ready.id,preparationId:ready.preparationId,stepRef:second!.stepId,sourceFactId:in4.factId};
  const dispositionClient=await f.db.connect();
  try{
   await expect(readQualityWarehouseCraftOccupation(dispositionClient,disposition)).resolves.toEqual({...disposition,lines:[{lineId,quantity:heldPieces}]});
   await expect(readQualityWarehouseCraftOccupation(dispositionClient,{...disposition,stepRef:first!.stepId})).resolves.toBeNull();
  }finally{dispositionClient.release();}
  await expect(readCurrentCraftProblem(f.db,locate)).resolves.toMatchObject({problemQuantity:outsidePieces,qualifiedQuantity:passedPieces,actualReturned:problemReturn,sourceSendFactId:out2.factId,factoryId:factories[1]});
  await expect(readCurrentCraftProblem(f.db,{...locate,stepRef:first!.stepId})).resolves.toBeNull();
  const sourceTx=await f.db.connect();
  try{
   await sourceTx.query('BEGIN');
   await expect(lockCraftProblemForOriginalRework(sourceTx,warehouse,locate)).rejects.toMatchObject({statusCode:403});
   await expect(lockCraftProblemForOriginalRework(sourceTx,qc,locate)).resolves.toMatchObject({
    evidence:{checkId:current.checkId,problemQuantity:outsidePieces,unit:'片'},source:{taskId:qcTask.task_id},
   });
   await expect(lockCraftProblemForOriginalRework(sourceTx,qc,{...locate,checkId:randomUUID()})).rejects.toMatchObject({statusCode:409});
  }finally{await sourceTx.query('ROLLBACK');sourceTx.release();}
  const rework=new ReworkInitiationService(f.db,'anchor-test');
  const qaActor={...qc,authorizationCapability:'rework:initiate',authorizationCapabilities:['rework:initiate']};
  const origin={scope:locate,execution:'factory' as const,quantity:outsidePieces};
  await expect(rework.createCraftDraft(qaActor,{...origin,quantity:outsidePieces+1},randomUUID())).rejects.toMatchObject({statusCode:400});
  const qcEntry=await h.open(qc.actorId,1165,{},`/ui/digital-production?workspace=quality&status=completed&search=${encodeURIComponent(qualityStyle)}`);
  let entered:Awaited<ReturnType<ReworkInitiationService['createCraftDraft']>>;
  let startKey:string;
  try{
   const scopeRow=qcEntry.page.getByRole('row').filter({hasText:`${problemReturn} 片 /`});
   await scopeRow.getByRole('link',{name:'查看原检查',exact:true}).click();
   await qcEntry.page.getByRole('textbox',{name:'本次实际返工片数',exact:true}).fill(String(outsidePieces));
   const sent=qcEntry.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/rework-orders/craft-quality/drafts'&&response.request().method()==='POST');
   await qcEntry.page.getByRole('button',{name:'打开原返工草稿',exact:true}).click();
   const issued=await sent;
   expect(issued.status(),await issued.text()).toBe(201);
   expect(issued.request().postDataJSON()).toEqual(origin);
   startKey=issued.request().headers()['idempotency-key']!;
   entered={value:await issued.json(),reused:false};
   await qcEntry.page.getByRole('link',{name:'查看原返工单',exact:true}).waitFor();
  }finally{await qcEntry.close();}
  const draftId=entered.value.reworkOrderId;
  expect(entered.value).toMatchObject({receivingBatchId:null,status:'draft',reworkQuantity:outsidePieces,
   processingFactory:{type:'supplier',supplierId:factories[1]},originalCraftQuality:{checkId:current.checkId,unit:'片',execution:'factory'}});
  expect(await rework.createCraftDraft(qaActor,origin,startKey)).toMatchObject({reused:true,value:{reworkOrderId:draftId}});
  expect((await rework.createCraftDraft(qaActor,origin,randomUUID())).value.reworkOrderId).toBe(draftId);
  await expect(ensureWithinSourceReceivingActualQuantity(f.db,draftId,[{label:'原报量',quantity:outsidePieces+1}])).rejects.toThrow(`原工艺问题范围 ${outsidePieces} 片`);
  await expect(ensureWithinSourceReceivingActualQuantity(f.db,draftId,[{label:'原报量',quantity:outsidePieces}])).resolves.toBeUndefined();
  expect((await f.db.query('SELECT count(*)::int AS count FROM rework_orders WHERE source_craft_qc_check_id=$1',[current.checkId])).rows[0].count).toBe(1);
  const submit=new ReworkV2SubmissionService(f.db,'anchor-test'),submitted=await submit.submit(qaActor,draftId,{expectedVersion:entered.value.version},randomUUID());
  expect(submitted.value).toMatchObject({status:'pending_process_configuration',reworkNo:expect.any(String),attachmentIds:[],
   originalCraftQuality:{checkId:current.checkId,unit:'片',execution:'factory'}});
  expect((await f.db.query('SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1',[originalReportPhoto])).rows[0])
   .toEqual({entity_type:'digital_factory_qc',entity_id:current.checkId});
  expect((await f.db.query("SELECT count(*)::int AS count FROM rework_work_reports WHERE rework_order_id=$1",[draftId])).rows[0].count).toBe(0);
  const pendingRepair={...await command(second!.stepId,factories[1]!,'send',in4.factId,outsidePieces),reworkId:draftId};
  const beforeRepair=await count();
  await expect(flow.warehouseCraftRepair(qaActor,ready.id,pendingRepair,randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(flow.warehouseCraftRepair(warehouse,ready.id,pendingRepair,randomUUID())).rejects.toThrow('原返工尚未进入实际执行');
  expect(await count()).toBe(beforeRepair);
  await expect(f.db.query(`INSERT INTO digital_factory_qc(check_id,preparation_id,return_fact_id,line_id,result,problem,treatment,
    attachment_ids,checked_by,checked_at) VALUES($1,$2,$3,$4,'合格','','','{}',$5,$6)`,
   [randomUUID(),ready.preparationId,in4.factId,lineId,qc.actorId,businessNow().toISOString()])).rejects.toMatchObject({code:'23514'});
  const countedDispatch={...dispatch,expectedRevision:counted.revision,returnFactId:in4.factId,occurredAt:businessNow().toISOString()};
  await expect(flow.dispatch(warehouse,ready.id,{...countedDispatch,lines:[{lineId,quantity:passedPieces+1}]},randomUUID())).rejects.toMatchObject({statusCode:409});
  const partial=await flow.dispatch(warehouse,ready.id,{...countedDispatch,lines:[{lineId,quantity:passedPieces}]},randomUUID());
  expect(partial.batches?.find(batch=>batch.factId===in4.factId)?.rows).toMatchObject([{lineId,sent:passedPieces,available:heldPieces,releasedAvailable:0}]);
  const tail={...f.people['tail-supervisor']!,authorizationCapability:'process:configure',authorizationCapabilities:['process:configure']},
   configuration=new ProcessConfigurationService(f.db),configuredFrom={expectedOrderVersion:submitted.value.version};
  await expect(configuration.activateExternalCraft(qaActor,draftId,configuredFrom,randomUUID())).rejects.toMatchObject({statusCode:403});
  const tailTab=await h.open(tail.actorId,1165,{},`/ui/tasks/${draftId}?node=process_configuration`);
  try{
   const button=tailTab.page.getByRole('button',{name:'确认原外厂返修',exact:true});
   await button.click();
   const response=tailTab.page.waitForResponse(result=>result.request().method()==='POST'&&result.url().includes(`/rework-orders/${draftId}/process-configuration/external-activate`));
   await tailTab.page.getByRole('button',{name:'确认',exact:true}).click();
   const committed=await response;
   expect(committed.status()).toBe(200);
   expect(await committed.json()).toMatchObject({reworkStatus:'in_progress',externalCraftOnly:true,configuration:{status:'approved',items:[{executionKind:'external_craft',plannedQuantity:outsidePieces,unitPrice:null}]}});
  }finally{await tailTab.close();}
  const activated=await configuration.get(tail,draftId);
  const nativeFlow=new FactoryFlowService(f.db,readQualityWarehouseCraftOccupation);
  const outsideSent={...await command(second!.stepId,factories[1]!,'send',in4.factId,outsidePieces),reworkId:draftId};
  const originalLogistics=(movement:typeof outsideSent)=>FactoryLogisticsSchema.parse({
   expectedRevision:movement.expectedRevision,kind:movement.kind==='send'?'工艺发出':'工艺回仓',
   stepRef:movement.stepRef,lines:movement.lines,occurredAt:movement.occurredAt,note:movement.note,
   ...(movement.kind==='send'?{fromReturnId:movement.sourceFactId}:{sendFactId:movement.sourceFactId}),
   warehouse:{taskId:movement.taskId,preparationId:movement.preparationId,factoryId:movement.factoryId,reworkId:movement.reworkId},
  });
  const repairKey=randomUUID(),outboundRepair=await nativeFlow.logistics(warehouse,ready.id,originalLogistics(outsideSent),repairKey);
  expect(await nativeFlow.warehouseCraftRepair(warehouse,ready.id,outsideSent,repairKey)).toEqual(outboundRepair);
  const sentRepair=outboundRepair.facts.at(-1)!;
  expect(sentRepair.payload).toMatchObject({stepRef:second!.stepId,fromReturnId:in4.factId,
   lines:[{lineId,quantity:outsidePieces}],
   warehouseMotion:{reworkId:draftId,checkId:current.checkId,factoryId:factories[1]}});
  await expect(flow.warehouseCraftMotion(warehouse,ready.id,
   await command(second!.stepId,factories[1]!,'return',sentRepair.factId,returnPortion),randomUUID())).rejects.toThrow('沿同一返工范围回仓');
  const repairScope={reworkId:draftId,originalReturnFactId:in4.factId,stepRef:second!.stepId,lineId,factoryId:factories[1]!,quantity:outsidePieces};
  const repairProgress=(sheet:typeof outboundRepair)=>externalCraftRepairProgress(repairScope,
   sheet.facts.map(item=>({fact_id:item.factId,kind:item.kind,occurred_at:item.occurredAt,payload:item.payload})));
  const recordReturn=async()=>nativeFlow.logistics(warehouse,ready.id,originalLogistics({
   ...await command(second!.stepId,factories[1]!,'return',sentRepair.factId,returnPortion),reworkId:draftId,
  }),randomUUID());
  const firstRepairReturn=await recordReturn();
  expect(repairProgress(firstRepairReturn)).toMatchObject({sent:outsidePieces,returned:returnPortion,remainingToReturn:returnPortion,physicalCompletedAt:null});
  expect(firstRepairReturn.facts.at(-1)?.payload).toMatchObject({lines:[{lineId,quantity:returnPortion}]});
  const followUp=(revision:number,returnFactId:string)=>({expectedRevision:revision,stepRef:second!.stepId,returnFactId,
   note:'TEST original repair reinspection',checks:[{lineId,result:'合格' as const,problem:'',treatment:'',attachmentIds:[],
    quantityScope:{inspectedQuantity:returnPortion,qualifiedQuantity:returnPortion,problemQuantity:0,unit:'片' as const}}]});
  const firstFact=firstRepairReturn.facts.at(-1)!;
  await expect(flow.qc(qc,ready.id,followUp(firstRepairReturn.revision,firstFact.factId),randomUUID())).rejects.toThrow('须同一范围全部实际回仓');
  const execution=new WorkReportingService(f.db),assigner={...tail,authorizationCapability:'work:assign',authorizationCapabilities:['work:assign']};
  const active=(await execution.list(assigner,draftId));
  expect(active).toMatchObject({reworkStatus:'in_progress',tasks:[],externalRepair:{requiredQuantity:outsidePieces,returnedQuantity:returnPortion,physicalCompletedAt:null}});
  await expect(execution.completeExecution(assigner,draftId,{expectedOrderVersion:active.orderVersion},randomUUID())).rejects.toThrow('尚未全部实际回仓');
  const lastRepairReturn=await recordReturn(),lastFact=lastRepairReturn.facts.at(-1)!;
  expect(repairProgress(lastRepairReturn)).toMatchObject({sent:outsidePieces,returned:outsidePieces,remainingToReturn:0,physicalCompletedAt:lastFact.occurredAt});
  expect(lastFact.payload).toMatchObject({lines:[{lineId,quantity:returnPortion}]});
  expect(lastRepairReturn.batches?.find(batch=>batch.factId===lastFact.factId)?.rows).toMatchObject([{lineId,available:returnPortion,allowDispatch:false}]);
  await expect(execution.completeExecution(qaActor,draftId,{expectedOrderVersion:active.orderVersion},randomUUID())).rejects.toMatchObject({statusCode:403});
  const completedTab=await h.open(tail.actorId,1165,{},`/ui/tasks/${draftId}?node=work_reporting`);
  let n04Version:number;
  try{
   const result=completedTab.page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes(`/rework-orders/${draftId}/work-tasks/complete`));
   await completedTab.page.getByRole('button',{name:'全部完成，进入节点05',exact:true}).click();
   const completed=await result,n04=await completed.json();
   expect(completed.status()).toBe(200);
   expect(n04).toMatchObject({reworkStatus:'pending_order_review',tasks:[],externalRepair:{requiredQuantity:outsidePieces,returnedQuantity:outsidePieces,physicalCompletedAt:lastFact.occurredAt}});
   n04Version=n04.orderVersion;
   const replay=await completedTab.context.request.post(`${h.base}/api/rework-orders/${draftId}/work-tasks/complete`,{
    headers:{'idempotency-key':completed.request().headers()['idempotency-key']!},data:{expectedOrderVersion:active.orderVersion},
   });
   expect(replay.headers()['idempotency-replayed']).toBe('true');
   expect(await replay.json()).toEqual(n04);
  }finally{await completedTab.close();}
  const review=new WholeOrderReviewService(f.db),tailReviewer={...tail,authorizationCapability:'submission:audit',authorizationCapabilities:['submission:audit']},
   ie={...f.people.ie!,authorizationCapability:'process:review',authorizationCapabilities:['process:review']};
  const approval={expectedOrderVersion:n04Version,temporaryCoefficients:[]};
  await expect(review.approve(ie,draftId,approval,randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(review.approve(tailReviewer,draftId,{...approval,processPrices:[{configurationItemId:activated.configuration!.items[0]!.configurationItemId,unitPrice:1}]},randomUUID())).rejects.toThrow('不包含本厂工序单价');
  const physical={requiredQuantity:outsidePieces,returnedQuantity:outsidePieces,physicalCompletedAt:lastFact.occurredAt};
  const confirmTab=await h.open(tail.actorId,1165,{},`/ui/tasks/${draftId}?node=whole_order_review`);
  let n05Version:number;
  try{
   await confirmTab.page.getByText(`实际回仓 ${outsidePieces} / ${outsidePieces} 片，无本厂计件工资。`,{exact:true}).waitFor();
   await confirmTab.page.getByRole('button',{name:'确认数量并提交 IE',exact:true}).click();
   const result=confirmTab.page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes(`/rework-orders/${draftId}/whole-order-review/approve`));
   await confirmTab.page.getByRole('button',{name:'确认',exact:true}).click();
   const saved=await result;
   expect(saved.status()).toBe(200);
   const payload=await saved.json();
   expect(payload).toMatchObject({reworkStatus:'pending_final_quantity_ie_review',externalRepair:physical,
    finalConfirmation:{confirmationVersion:1,externalRepair:physical,prices:[],quantities:[]},reports:[]});
   n05Version=payload.orderVersion;
  }finally{await confirmTab.close();}
  await expect(review.reviewFinalQuantity(tailReviewer,draftId,{expectedOrderVersion:n05Version,decision:'approved'},randomUUID())).rejects.toMatchObject({statusCode:403});
  const returnedByIe=await review.reviewFinalQuantity(ie,draftId,{expectedOrderVersion:n05Version,decision:'rejected',reason:'TEST recheck exact outside count'},randomUUID());
  expect(returnedByIe.value).toMatchObject({reworkStatus:'pending_order_review',finalConfirmation:{status:'rejected',confirmationVersion:1,externalRepair:physical}});
  const again=await review.approve(tailReviewer,draftId,{...approval,expectedOrderVersion:returnedByIe.value.orderVersion},randomUUID());
  const ieTab=await h.open(ie.actorId,1165,{},`/ui/tasks/${draftId}?node=final_quantity_ie_review`);
  try{
   await ieTab.page.getByText(`实际回仓 ${outsidePieces} / ${outsidePieces} 片，无本厂计件工资。`,{exact:true}).waitFor();
   expect((await review.get(ie,draftId)).orderVersion).toBe(again.value.orderVersion);
   await ieTab.page.getByRole('button',{name:'通过',exact:true}).click();
   const result=ieTab.page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes(`/rework-orders/${draftId}/whole-order-review/ie-review`));
   await ieTab.page.getByRole('button',{name:'确认',exact:true}).click();
   const ieApproved=await result;
   expect(ieApproved.status()).toBe(200);
   expect(await ieApproved.json()).toMatchObject({reworkStatus:'pending_responsibility_determination',finalConfirmation:{status:'approved',confirmationVersion:2,externalRepair:physical,prices:[],quantities:[]}});
  }finally{await ieTab.close();}
  expect((await f.db.query(`SELECT (SELECT count(*)::int FROM rework_work_reports WHERE rework_order_id=$1) AS reports,
    (SELECT count(*)::int FROM rework_wage_items WHERE rework_order_id=$1) AS wages`,[draftId])).rows[0]).toEqual({reports:0,wages:0});
  const latestRepairSheet=await flow.read(qc,ready.id),dispatchRepair={...dispatch,expectedRevision:latestRepairSheet.revision,
   returnFactId:lastFact.factId,occurredAt:businessNow().toISOString(),lines:[{lineId,quantity:returnPortion}]};
  await expect(flow.dispatch(warehouse,ready.id,dispatchRepair,randomUUID())).rejects.toMatchObject({statusCode:409});
  const rechecked=await flow.qc(qc,ready.id,followUp(latestRepairSheet.revision,lastFact.factId),randomUUID());
  expect(rechecked.batches?.find(batch=>batch.factId===lastFact.factId)?.rows).toMatchObject([{lineId,available:returnPortion,releasedAvailable:returnPortion}]);
  expect(rechecked.batches?.find(batch=>batch.factId===firstFact.factId)?.rows).toMatchObject([{lineId,available:returnPortion,allowDispatch:false}]);
  const sentAfterQc=await flow.dispatch(warehouse,ready.id,{...dispatchRepair,expectedRevision:rechecked.revision,occurredAt:businessNow().toISOString()},randomUUID());
  expect(sentAfterQc.facts.at(-1)).toMatchObject({kind:'仓库实际发厂',payload:{returnFactId:lastFact.factId,lines:[{lineId,quantity:returnPortion}]}});
  const responsibility=new AuthorizedResponsibilityDeterminationService(f.db),responsibilityHandler={...manager,
   authorizationCapability:'responsibility:determine',authorizationCapabilities:['responsibility:determine']};
  const target=ResponsibilityDeterminationResponseSchema.parse(await responsibility.get(responsibilityHandler,draftId));
  expect(target).toMatchObject({reworkStatus:'pending_responsibility_determination',canDetermine:true,sourceProcesses:[
   {configurationItemId:activated.configuration!.items[0]!.configurationItemId,executionKind:'external_craft',includedInResponsibility:true},
  ]});
  expect(Number(target.sourceProcesses[0]!.baseAmount)).toBe(0);
  const determination=await responsibility.saveDraft(responsibilityHandler,draftId,CreateResponsibilityDraftSchema.parse({
   expectedOrderVersion:target.orderVersion,expectedCurrentDeterminationVersion:null,handlerUserId:responsibilityHandler.actorId,
   reason:'TEST processing supplier responsibility without recorded charge',processes:[{configurationItemId:target.sourceProcesses[0]!.configurationItemId,multiplier:'1.000',
    allocations:[{responsibilityType:'processing_factory',shareBps:10000,multiplier:'1.200',supplierId:factories[1]}]}],
  }),randomUUID());
  expect(Number(determination.value.determination?.calculationTotal)).toBe(0);
  const finalResponsibility=await responsibility.finalize(responsibilityHandler,draftId,{expectedOrderVersion:determination.value.orderVersion,
   expectedCurrentDeterminationVersion:determination.value.determination!.version},randomUUID());
  expect(ResponsibilityDeterminationResponseSchema.parse(finalResponsibility.value)).toMatchObject({reworkStatus:'completed',determination:{stage:'finalized'}});
  expect(Number(finalResponsibility.value.determination?.calculationTotal)).toBe(0);
  expect((await f.db.query("SELECT count(*)::int AS count FROM rework_work_tasks WHERE rework_order_id=$1",[draftId])).rows[0].count).toBe(0);
  expect((await f.db.query('SELECT count(*)::int AS count FROM receiving_batches WHERE cutting_order_id=$1',[cut.cutting_order_id])).rows[0].count).toBe(0);

  const firstQc=(await nativeFlow.read(f.root,ready.id)).tasks.find(row=>row.taskKind==='bulk_qc'&&row.stepRef===first!.stepId)!;
  await taskService.reassign(f.root,firstQc.taskId,qc.actorId,randomUUID());
  const internalPhoto=await f.image(qc);
  const internalCounted=await nativeFlow.qc(qc,ready.id,{expectedRevision:(await nativeFlow.read(qc,ready.id)).revision,
   stepRef:first!.stepId,returnFactId:in2.factId,note:'TEST actual internal issue',checks:[{lineId,result:'需处理',problem:'TEST internal repairs',treatment:'',
    attachmentIds:[internalPhoto],quantityScope:{inspectedQuantity:40,qualifiedQuantity:37,problemQuantity:3,unit:'片'}}]},randomUUID());
  const originalCheck=internalCounted.checks.filter(row=>row.returnFactId===in2.factId&&row.lineId===lineId).at(-1)!;
  const internalScope={...locate,stepRef:first!.stepId,returnFactId:in2.factId,checkId:originalCheck.checkId};
  const repair=await rework.createCraftDraft(qaActor,{scope:internalScope,execution:'internal',quantity:3},randomUUID());
  const internalId=repair.value.reworkOrderId;
  const correctedDraft=await rework.updateDraft(qaActor,internalId,{expectedVersion:repair.value.version,tailInspectionRequired:false},randomUUID());
  const acceptedInternal=await submit.submit(qaActor,internalId,{expectedVersion:correctedDraft.value.version},randomUUID());
  expect(acceptedInternal.value).toMatchObject({reworkNo:expect.any(String),status:'pending_process_configuration',receivingBatchId:null,
   originalCraftQuality:{checkId:originalCheck.checkId,execution:'internal',unit:'片'}});
  const reinspect={expectedRevision:(await nativeFlow.read(qc,ready.id)).revision,stepRef:first!.stepId,returnFactId:in2.factId,
   internalReworkId:internalId,note:'TEST actual internal reinspection',checks:[{lineId,result:'合格' as const,problem:'',treatment:'',attachmentIds:[],
    quantityScope:{inspectedQuantity:3,qualifiedQuantity:3,problemQuantity:0,unit:'片' as const}}]};
  await expect(nativeFlow.qc(qc,ready.id,reinspect,randomUUID())).rejects.toThrow('未完成实际执行');
  const process=await f.access.createProcess({...f.root,authorizationCapability:'master_data:manage',authorizationCapabilities:['master_data:manage','access:admin']},
   {processCode:`TESTC${randomUUID().slice(0,7).toUpperCase()}`,processName:'TEST 原本厂裁片返工',pricingUnit:'piece',active:true,changeReason:'TEST original internal work'});
  const plan=new ProcessWorkerPlanService(f.db),internalConfig=await configuration.saveDraft(tail,internalId,{expectedOrderVersion:acceptedInternal.value.version,
   items:[{source:'catalog',processId:process.processId,executionKind:'worker',plannedQuantity:3,pricingUnit:'piece',unitPrice:1.25}]},randomUUID());
  const actualWorker=f.people['worker-a']!,person=(await f.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1',[actualWorker.actorId])).rows[0].person_id;
  const nativeConfiguration=internalConfig.value.configuration!,processItem=nativeConfiguration.items[0]!;
  await plan.save(assigner,internalId,{expectedOrderVersion:internalConfig.value.orderVersion,configurationId:nativeConfiguration.configurationId,
   expectedConfigurationVersion:nativeConfiguration.configurationVersion,assignments:[{configurationItemId:processItem.configurationItemId,memberIds:[person]}]},randomUUID());
  const queued=await configuration.submit(tail,internalId,{expectedOrderVersion:internalConfig.value.orderVersion,expectedConfigurationVersion:nativeConfiguration.configurationVersion},randomUUID());
  const approved=await configuration.review(ie,internalId,{expectedOrderVersion:queued.value.orderVersion,
   expectedConfigurationVersion:queued.value.configuration!.configurationVersion,decision:'approved'},randomUUID());
  await plan.activateAfterIeApproval(internalId,approved.value.configuration!.configurationVersion,randomUUID());
  const activeInternal=await execution.list(assigner,internalId);
  expect(activeInternal).toMatchObject({reworkStatus:'in_progress',tasks:[{plannedQuantity:3}]});
  const work=await execution.submitReport({...actualWorker,authorizationCapability:'work:report',authorizationCapabilities:['work:report']},activeInternal.tasks[0]!.workTaskId,
   {expectedOrderVersion:activeInternal.orderVersion,actualQuantity:3,completedAt:businessNow().toISOString()},randomUUID());
  expect(work.value).toMatchObject({actualQuantity:3});
  expect((await f.db.query('SELECT submitted_by FROM rework_work_reports WHERE work_report_id=$1 AND rework_order_id=$2',
   [work.value.workReportId,internalId])).rows[0]).toEqual({submitted_by:actualWorker.actorId});
  expect((await execution.list(assigner,internalId)).reworkStatus).toBe('pending_order_review');
  expect((await nativeFlow.read(qc,ready.id)).batches?.find(batch=>batch.factId===in2.factId)?.rows).toMatchObject([{releasedAvailable:37}]);
  await expect(nativeFlow.qc(qc,ready.id,{...reinspect,internalReworkId:draftId},randomUUID())).rejects.toThrow('不属于本批');
  const internalUi=await h.open(qc.actorId,1165,{},`/ui/digital-production?workspace=quality&status=completed&search=${encodeURIComponent(qualityStyle)}`);
  let afterInternal:Awaited<ReturnType<FactoryFlowService['qc']>>;
  try{
   const row=internalUi.page.getByRole('row').filter({hasText:'40 片 /'});
   await row.getByRole('link',{name:'查看原检查',exact:true}).click();
   const confirmed=internalUi.page.waitForResponse(response=>new URL(response.url()).pathname.endsWith(`/orders/${ready.id}/factory-flow/qc`)&&response.request().method()==='POST');
   await internalUi.page.getByRole('button',{name:'确认本批原返工复检合格',exact:true}).click();
   const response=await confirmed;
   expect(response.status(),await response.text()).toBe(200);
   expect(response.request().postDataJSON()).toMatchObject({internalReworkId:internalId,returnFactId:in2.factId,stepRef:first!.stepId,
    checks:[{lineId,quantityScope:{inspectedQuantity:3,qualifiedQuantity:3,problemQuantity:0,unit:'片'}}]});
   afterInternal=await response.json();
   await internalUi.page.getByText('实际已检 40 片 · 合格 40 片 · 问题 0 片',{exact:true}).waitFor();
  }finally{await internalUi.close();}
  expect(afterInternal.batches?.find(batch=>batch.factId===in2.factId)?.rows).toMatchObject([{releasedAvailable:40}]);
  expect(afterInternal.checks.filter(row=>row.returnFactId===in2.factId&&row.lineId===lineId)).toEqual(expect.arrayContaining([
   expect.objectContaining({checkId:originalCheck.checkId,result:'需处理',quantityScope:{inspectedQuantity:40,qualifiedQuantity:37,problemQuantity:3,unit:'片'}}),
   expect.objectContaining({result:'合格',quantityScope:{inspectedQuantity:40,qualifiedQuantity:40,problemQuantity:0,unit:'片'}}),
  ]));
  expect((await f.db.query('SELECT count(*)::int AS count FROM rework_work_reports WHERE rework_order_id=$1',[internalId])).rows[0].count).toBe(1);
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
