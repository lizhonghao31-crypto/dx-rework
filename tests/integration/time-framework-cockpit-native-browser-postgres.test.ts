import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import type {BulkWashingAdoption} from '@dx-rework/contracts/bulk-washing';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {admittedFrameworkProductionFixture} from '../helpers/order-time-rewash-fixture.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {ReworkInitiationService} from '../../apps/api/src/rework/service.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('PR08 activated original App time framework',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>,scene:string;
 const orders:Array<{id:string;style:string;route:'A'|'B'}>=[];
 let pairedOrder:{id:string;style:string};
 beforeAll(async()=>{
  h=await supplychainSettingsBrowser(url!,process.env.TIME08_BROWSER_EVIDENCE??join(tmpdir(),'time08-cockpit-'+randomUUID()),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});
  const settings=new OrderTimeSettingsService(h.db),read=await settings.read(h.f.root);
  expect(read.current.framework).toBeDefined();
  await settings.save(h.f.root,{expectedVersion:0,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  scene=await h.f.scene('2027-01-07T15:00:00Z');h.setCollectionScene(scene);
  const requests=new OrderTimeRequestService(h.db,orderTimeNativeExecutor(h.db,true,h.patternOrders));
  for(const sample of ['A','B','paired'] as const)await h.f.runtime.run(scene,h.f.root,async()=>{
   const route=sample==='paired'?'B':sample;
   const designer=h.f.people['sample-designer']!,style=(sample==='paired'?'TEST-F3-TWO-PO-':'TEST-TIME08-'+route+'-')+randomUUID();
   const line={formalPoNo:style+'-PO',color:'黑',customerWarehouseArrivalDate:'2027-02-20',sizes:[{size:'M',quantity:10}]};
   const input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',requiresColorMatching:route==='A',designStyleNo:style,orderDate:'2027-01-07',primaryMerchandiserId:h.f.people.merchandiser!.actorId,
    lines:sample==='paired'?[line,{...line,formalPoNo:style+'-PO2',color:'白'}]:[line]});
   const operation={kind:'direct_order' as const,input,route:{craftSteps:[],preshrink:false}},check=await requests.check(designer,operation);
   const pending=await requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST intermediate milestone gap'},randomUUID());
   const manager=h.f.people.owner!,review=await requests.read(manager,pending.requestId),result=await requests.apply(manager,pending.requestId,{expectedVersion:review.version,fingerprint:review.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const order={id:result.result!.orderId!,style,route};
   if(sample==='paired'){
    pairedOrder=order;
    const resource={kind:'order' as const,id:order.id};
    const lines=(await h.db.query<{line_id:string}>('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[order.id])).rows;
    const washing=lines.map((line,index)=>{
     const duration={minutes:index===0?60:180,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
     const document:BulkWashingAdoption={arrangement:{mode:'after_receipt',reference:'TEST separate PO washing',
      revision:1,accounting:'additional',washing:duration,inspection:duration},
      staff:{logisticsId:h.f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:h.f.people.qc!.actorId},
      fee:{kind:'pending'},sourceRef:'TEST authenticated arrangement'};
     return {lineId:line.line_id,expectedVersion:0,document};
    });
    const preview=await requests.check(h.f.root,{kind:'arrangement',resource},{},washing);
    await requests.arrange(h.f.root,{resource,fingerprint:preview.fingerprint,overrides:{},washing,acceptLate:true},randomUUID());
   }else orders.push(order);
  });
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('keeps customer delivery and actual work in separate homepage bars and opens the same original order',async()=>{
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-cockpit?search=TEST-TIME08-');
  try{
   const page=tab.page;
   await page.getByRole('progressbar',{name:'整单自然时间进度',exact:true}).first().waitFor();
   expect(await page.getByRole('progressbar',{name:'整单自然时间进度',exact:true}).count()).toBe(2);
   expect(await page.getByRole('progressbar',{name:'整单实际进度',exact:true}).count()).toBe(2);
   expect(await page.locator('.cockpit-home-delivery-date').allTextContents()).toEqual(['2027-02-20','2027-02-20']);
   const deliveryHeading=page.locator('th.cockpit-home-progress-heading[scope=col]');
   await deliveryHeading.waitFor({state:'visible'});
   expect(await deliveryHeading.allTextContents()).toEqual(['交货日期']);
   for(const meter of await page.locator('.cockpit-home-progress').all()){
    expect(await meter.evaluate(element=>{
     const [expected,time,actual,done]=Array.from(element.children);
     const first=time?.querySelector('[role=progressbar]')?.getBoundingClientRect();
     const second=done?.querySelector('[role=progressbar]')?.getBoundingClientRect();
     return [expected?.textContent,actual?.textContent,first?.height,second?.height,first?.width===second?.width];
    })).toEqual(['预计日期：2027-02-20','实际进度：未完成',15,15,true]);
   }
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.setViewportSize({width:1165,height:747});await page.screenshot({path:join(h.evidence,'home-1165.png')});
  }finally{await tab.context.close();}
 });
 for(const route of ['A','B'] as const)it('uses '+route+' milestones and original nodes at1165px without duplicate flow cards',async()=>{
  const order=orders.find(row=>row.route===route)!;
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+order.id);
  try{
   const page=tab.page,flow=page.locator('.cockpit-flow-panel .cockpit-stages');await flow.waitFor();
   const stageLabels=['订单创建','产品开发打板','大货产前准备','订单开裁','裁后工艺与发厂','工厂生产','回货与装箱'];
   expect(await flow.locator('.cockpit-stage-select strong').allTextContents()).toEqual(stageLabels);
   expect(await page.locator('.cockpit-flow-panel .cockpit-creation-events, .cockpit-flow-panel .cockpit-stage-date-colon').count()).toBe(0);
   await page.locator('[data-identity-fact="created"] time').waitFor();
   expect(await page.getByRole('heading',{name:route==='A'?'要对色':'无需对色',exact:true}).count()).toBe(1);
   const fit=await flow.locator('.cockpit-stage').evaluateAll(stages=>stages.every(stage=>{
    const box=stage.getBoundingClientRect(),viewport=stage.closest('.cockpit-flow-scroll')!.getBoundingClientRect();
    return box.left>=viewport.left-1&&box.right<=viewport.right+1&&[...stage.querySelectorAll('time')].every(time=>{
     const date=time.getBoundingClientRect();
     return date.left>=box.left-1&&date.right<=box.right+1;
    });
   }));
   expect(fit).toBe(true);
   const dto=await page.evaluate(async id=>{const response=await fetch('/api/digital-production/journeys/'+id+'?view=cockpit');if(!response.ok)throw Error('Journey read failed '+response.status);return response.json();},order.id) as OrderJourney;
   await writeFile(join(h.evidence,'event-target-'+route+'.json'),JSON.stringify(dto,null,2));
   const progress=dto.fixedSchedule!.scopes[0]!,poRow=page.getByRole('row').filter({hasText:order.style+'-PO'}).first();
   expect(progress.completionEstimate).toMatchObject({kind:'lower_bound',latest:null});
   // Both fixtures have zero lag against their accepted forward plan;
   // A's intermediate/customer milestone gap is a separate comparison.
   expect(progress.lagMinutes).toEqual({minimum:0,maximum:0});
   expect(progress.customerDuePassed).toBe(false);
   await poRow.getByText('进度待核',{exact:true}).waitFor();
   expect(await poRow.innerText()).not.toContain('可用');

   for(const node of dto.stages.flatMap(stage=>stage.nodes).filter(node=>node.key==='budget'||node.key==='design_handover')){
    expect(node.actualAt).toBeNull();
    for(const target of node.fixedTargets??[]){
     expect(target.progress.ownSla.deadlineAt).toBeNull();
     if(node.key==='budget')expect(target.progress.goalDelta).toMatchObject({kind:'on_target',targetAt:'2027-01-23T11:00:00.000Z'});
     else expect(target.progress.goalDelta).toMatchObject({kind:'late',targetPrecision:'date',targetDate:route==='A'?'2026-11-17':'2026-12-18',signedValue:route==='A'?51:20});
    }
   }

   const approval=dto.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='customer_sample');
   expect(approval).toMatchObject({expectedAt:'2027-01-07',expectedPrecision:'date'});
   expect(dto.fixedSchedule?.framework?.scopes[0]?.milestones.find(row=>row.key==='client_sample_approval')).toMatchObject({feasibility:'sufficient',lateMinutes:0});
   expect(await page.locator('.cockpit-flow-panel').count()).toBe(1);
   const panel=page.getByRole('region',{name:'小流程明细',exact:true});
   const milestoneKeys:string[]=[];
   for(const label of stageLabels){
    await flow.getByRole('button',{name:label+'节点明细',exact:true}).click();
    milestoneKeys.push(...await panel.locator('[data-milestone-key]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-milestone-key')!)));
   }
   expect(milestoneKeys.sort()).toEqual(dto.fixedSchedule!.framework!.scopes[0]!.milestones.map(item=>item.key).sort());
   expect(new Set(milestoneKeys).size).toBe(route==='A'?9:8);
   const stageDates=dto.cockpitStageDates![0]!.stages;
   const preparation=flow.locator('.cockpit-stage').nth(2);
   expect(stageDates.find(row=>row.key==='preparation')).toMatchObject({expected:{precision:'unknown'},missingTargets:['material_investment']});
   const explanation=preparation.locator('summary').filter({hasText:'查看待核项'});
   await explanation.click();
   await preparation.getByText('投面辅料：待核实际采购材料范围',{exact:true}).waitFor();
   await explanation.click();
   const originalTarget=stageDates.find(row=>row.differenceUsesOriginalTarget&&row.goalDelta?.targetAt)!;
   expect(originalTarget).toBeDefined();
   const targetStage=flow.locator('.cockpit-stage').nth(stageDates.indexOf(originalTarget));
   const compare=targetStage.locator('summary').filter({hasText:'差异按原目标'});
   await compare.click();
   const originalGoal=originalTarget.goalDelta!;
   expect(await targetStage.locator('details[open] time').getAttribute('datetime')).toBe(originalGoal.targetPrecision==='date'?originalGoal.targetDate:originalGoal.targetAt);
   expect(await targetStage.locator('details[open] small').innerText()).toBe('版本 '+originalGoal.targetRevision.split(':').at(-1));
   await compare.click();
   await flow.getByRole('button',{name:'大货产前准备节点明细',exact:true}).click();
   for(const key of ['fabric_receipt','style_label_ready'])
    expect(await panel.locator(`[data-milestone-key="${key}"] time`).first().innerText()).toMatch(/^20\d{2}-\d{2}-\d{2}$/);
   for(const key of ['cutting','production'] as const){
    const stage=stageDates.find(row=>row.key===key);
    expect(stage).toMatchObject({expectedSource:'stage_schedule',missingTargets:[]});
    expect(stage?.expected.precision).not.toBe('unknown');
   }
   await flow.getByRole('button',{name:'裁后工艺与发厂节点明细',exact:true}).click();
   await panel.getByRole('button',{name:'发加工节点明细',exact:true}).click();
   await expect.poll(()=>panel.getByRole('columnheader',{name:'计划完成',exact:true}).count()).toBe(1);
   expect(await panel.getByRole('columnheader',{name:'实际完成',exact:true}).count()).toBe(1);
   expect(await panel.locator('tbody tr').count()).toBeGreaterThan(0);
   expect(await panel.innerText()).not.toContain('受本目标约束');
   expect(await panel.locator('time').first().innerText()).toMatch(/^20\d{2}-\d{2}-\d{2}$/);
   const boxes=await page.locator('.journey-node-panel,.journey-documents-panel,.journey-activity-panel').evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,bottom:r.bottom};}));
   expect(boxes[0]!.right).toBeGreaterThan(boxes[1]!.right);expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.top);expect(Math.abs(boxes[1]!.top-boxes[2]!.top)).toBeLessThan(2);expect(Math.abs(boxes[1]!.bottom-boxes[2]!.bottom)).toBeLessThan(2);
   await page.setViewportSize({width:1165,height:747});await page.screenshot({path:join(h.evidence,'detail-'+route+'-1165.png')});
   await panel.evaluate(element=>element.scrollIntoView({block:"start",behavior:"instant"}));
   await page.screenshot({path:join(h.evidence,'nodes-'+route+'-1165.png')});
   await flow.getByRole('button',{name:'订单创建节点明细',exact:true}).click();
   const creation=panel.getByRole('link',{name:'创建正式订单',exact:true});
   await creation.waitFor();
   expect(new URL((await creation.getAttribute('href'))!,page.url()).searchParams.get('instruction')).toBe(order.id);
   const loadInstruction=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/orders/'+order.id+'/instruction')&&response.request().method()==='GET'&&response.ok());
   await creation.click();
   await loadInstruction;
   await page.getByRole('heading',{name:order.style,exact:true}).waitFor();
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await page.waitForURL(url=>url.searchParams.get('selected')===order.id&&url.searchParams.get('expanded')==='creation');
   await panel.getByRole('button',{name:'设计资料交接节点明细',exact:true}).click();
   await panel.getByRole('button',{name:'设计资料交接',exact:true}).waitFor();
   expect(await panel.locator('tbody tr').count()).toBe(1);
   expect(await page.getByRole('region',{name:'当前节点详情',exact:true}).innerText()).toContain('设计资料交接');
   await page.getByRole('button',{name:'本单全部节点',exact:true}).click();
   expect(await panel.locator('tbody tr').count()).toBeGreaterThan(0);
   await page.setViewportSize({width:650,height:900});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:join(h.evidence,'detail-'+route+'-650.png'),fullPage:true});
   expect(h.errors).toEqual([]);
  }finally{await tab.page.screenshot({path:join(h.evidence,'last-'+route+'.png'),fullPage:true});await writeFile(join(h.evidence,'last-'+route+'.html'),await tab.page.content());await tab.context.close();}
 });
 it('keeps a PO-only stage on its exact work scope and restores that PO after the original order record',async()=>{
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+pairedOrder.id);
  try{
   const page=tab.page,selector=page.getByRole('combobox',{name:'里程碑PO范围'}),flow=page.getByRole('region',{name:'订单全流程'});
   await selector.waitFor();
   const dto=await page.evaluate(async id=>{
    const response=await fetch('/api/digital-production/journeys/'+id+'?view=cockpit');
    if(!response.ok)throw Error('Journey read failed '+response.status);
    return response.json();
   },pairedOrder.id) as OrderJourney;
   await writeFile(join(h.evidence,'paired-scope-dates.json'),JSON.stringify(dto,null,2));
   const [first,second]=dto.fixedSchedule!.framework!.scopes;
   expect(first?.customerDate).toBe(second?.customerDate);
   const productionDate=(scopeRef:string)=>{
    const date=dto.cockpitStageDates!.find(scope=>scope.scopeRef===scopeRef)!.stages.find(stage=>stage.key==='production')!.expected;
    expect(date.precision).toBe('instant');
    return date.precision==='instant'?date.at:null;
   };
   const firstDate=productionDate(first!.scopeRef),secondDate=productionDate(second!.scopeRef);
   const shownProductionDate=flow.locator('[aria-label="工厂生产日期"] time').first();
   const receiving=dto.stages.find(stage=>stage.key==='receiving')!.nodes;
   const localNode=(scope:string)=>receiving.find(node=>node.key==='bulk_return_washing'
    &&node.fixedTargets?.length&&node.fixedTargets.every(target=>target.scopeRef===scope))!;
   const firstOnly=localNode(first!.scopeRef),secondOnly=localNode(second!.scopeRef);
   const shared=receiving.find(node=>node.fixedTargets?.some(target=>target.scopeRef===first!.scopeRef)
    &&node.fixedTargets.some(target=>target.scopeRef===second!.scopeRef))!;
   expect([firstOnly,secondOnly,shared].every(Boolean)).toBe(true);
   const panel=page.getByRole('region',{name:'小流程明细'});
   const node=(id:string)=>panel.locator(`[data-cockpit-focus="node:${id}"]`);
   // The overview enters the exact task before it has a PO selector value.
   await page.goto(h.base+'/ui/digital-cockpit?'+new URLSearchParams({selected:pairedOrder.id,
    expanded:secondOnly.stage,focus:secondOnly.instanceId}));
   await page.locator('[data-view=order][aria-busy=false]').waitFor();
   expect(await selector.inputValue()).toBe(second!.scopeRef);
   expect(await shownProductionDate.getAttribute('datetime')).toBe(secondDate);
   expect(await node(secondOnly.instanceId).getAttribute('aria-pressed')).toBe('true');
   expect(await node(firstOnly.instanceId).count()).toBe(0);
   await page.goto(h.base+'/ui/digital-cockpit?'+new URLSearchParams({selected:pairedOrder.id,
    expanded:shared.stage,focus:shared.instanceId}));
   await page.locator('[data-view=order][aria-busy=false]').waitFor();
   expect(await selector.inputValue()).toBe('');
   expect(await node(shared.instanceId).getAttribute('aria-pressed')).toBe('true');
   expect(await node(shared.instanceId).count()).toBe(1);
   await selector.selectOption(first!.scopeRef);
   await flow.getByRole('button',{name:'回货与装箱节点明细',exact:true}).click();
   await node(firstOnly.instanceId).waitFor();
   expect(await shownProductionDate.getAttribute('datetime')).toBe(firstDate);
   expect(await node(secondOnly.instanceId).count()).toBe(0);
   await node(firstOnly.instanceId).click();
   await selector.selectOption(second!.scopeRef);
   await node(secondOnly.instanceId).waitFor();
   expect(await shownProductionDate.getAttribute('datetime')).toBe(secondDate);
   expect(await node(firstOnly.instanceId).count()).toBe(0);
   expect(await node(shared.instanceId).count()).toBe(1);
   const current=page.getByRole('region',{name:'当前节点详情'}).getByRole('heading',{level:2});
   expect(await current.innerText()).not.toContain(firstOnly.subject!);
   await node(secondOnly.instanceId).click();
   expect(await current.innerText()).toContain(secondOnly.subject!);
   const materials=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname.endsWith('/journeys/'+pairedOrder.id+'/node-materials')
     &&url.searchParams.get('instanceId')===secondOnly.instanceId&&response.ok();
   });
   await page.getByRole('button',{name:'该节点所需材料一览',exact:true}).click();
   await materials;
   await page.getByRole('dialog',{name:'该节点所需材料一览',exact:true}).waitFor();
   await page.keyboard.press('Escape');

   await flow.getByRole('button',{name:'订单创建节点明细',exact:true}).click();
   await panel.getByRole('link',{name:'创建正式订单',exact:true}).click();
   await page.waitForURL(url=>url.searchParams.get('instruction')===pairedOrder.id);
   await page.getByRole('heading',{name:pairedOrder.style,exact:true}).waitFor();
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await page.waitForURL(url=>url.searchParams.get('selected')===pairedOrder.id&&url.searchParams.get('expanded')==='creation'
    &&url.searchParams.get('milestone')===second!.scopeRef+'|');
   expect(await selector.inputValue()).toBe(second!.scopeRef);
   await panel.getByRole('button',{name:'本单全部节点',exact:true}).click();
   await node(firstOnly.instanceId).waitFor();
   await node(secondOnly.instanceId).waitFor();
   expect(await node(shared.instanceId).count()).toBe(1);
   expect(h.errors).toEqual([]);
  }finally{await tab.context.close();}
 });
 it('opens the original second-PO rework task from the homepage and returns to its exact node and materials',async()=>{
  const f=h.f,fixture=await admittedFrameworkProductionFixture(f,{poCount:2,commonCustomerDate:'2027-03-01'});
  h.setCollectionScene(fixture.scene);
  const rework=await f.runtime.run(fixture.scene,f.root,async()=>{
   const [first,second]=(await f.db.query<{line_id:string;child_id:string;po_number:string}>(`SELECT line.line_id,link.child_id,line.po_number
    FROM digital_production_po_lines line JOIN digital_production_child_lines link USING(line_id)
    WHERE line.production_order_id=$1 AND link.production_order_id=$1 AND link.module='cutting' AND link.child_line_key='record'
    ORDER BY line.position`,[fixture.orderId])).rows;
   expect(first?.line_id).not.toBe(second?.line_id);
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
   const qc={...f.people.qc!,authorizationCapability:'rework:initiate',authorizationCapabilities:['rework:initiate']};
   await fixture.ready.cutting.record(cutter,second!.child_id,{pieceCount:1,actualCutCount:2,attachmentIds:[await f.image(cutter)]},randomUUID());
   const receipt=await new ReceivingService(f.db).create(warehouse,{cuttingOrderId:second!.child_id,documentQuantity:2,actualQuantity:2,attachmentIds:[await f.image(warehouse)]},randomUUID());
   const draft=await new ReworkInitiationService(f.db,'anchor-test').createDraft(qc,{receivingBatchId:receipt.value.receivingBatchId,
    problemPart:'TEST二号PO',problemDescription:'TEST仅第二张PO待返工',reworkQuantity:1},randomUUID());
   return {id:draft.value.reworkOrderId,lineId:second!.line_id,firstLineId:first!.line_id,po:second!.po_number};
  });
  const tab=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?'+new URLSearchParams({search:rework.po,stage:'receiving',node:'rework'}));
  try{
   const {page}=tab,task=page.locator(`[data-order-id="${fixture.sourceId}"] .cockpit-home-task`);
   await task.waitFor();
   const source=await page.request.get(h.base+`/api/digital-production/journeys/${fixture.sourceId}?view=cockpit`);
   expect(source.ok()).toBe(true);
   const dto=await source.json() as OrderJourney,scopes=dto.fixedSchedule!.framework!.scopes;
   const first=scopes.find(scope=>scope.lineId===rework.firstLineId),second=scopes.find(scope=>scope.lineId===rework.lineId);
   expect(scopes).toHaveLength(2);
   expect(first?.customerDate).toBe(second?.customerDate);
   const target=dto.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='rework'&&node.instanceId===rework.id)!;
   expect(target.records.map(record=>record.lineId)).toEqual([rework.lineId]);
   await task.click();
   await page.waitForURL(url=>url.searchParams.get('focus')===rework.id&&url.searchParams.get('expanded')==='receiving');
   expect(new URL(page.url()).searchParams.has('milestone')).toBe(false);
   expect(new URL(page.url()).searchParams.has('materialFocus')).toBe(false);
   const selector=page.getByRole('combobox',{name:'里程碑PO范围'}),current=page.getByRole('region',{name:'当前节点详情'});
   await selector.waitFor();
   expect(await selector.inputValue()).toBe(second!.scopeRef);
   expect(await page.locator(`[data-cockpit-focus="node:${rework.id}"]`).getAttribute('aria-pressed')).toBe('true');
   const materials=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname.endsWith(`/journeys/${fixture.sourceId}/node-materials`)&&url.searchParams.get('instanceId')===rework.id&&response.ok();
   });
   await current.getByRole('button',{name:'该节点所需材料一览',exact:true}).click();
   expect(await (await materials).json()).toMatchObject({instanceId:rework.id});
   await page.getByRole('dialog',{name:'该节点所需材料一览',exact:true}).waitFor();
   await page.keyboard.press('Escape');
   const original=current.getByRole('link',{name:'查看节点记录',exact:true});
   await original.click();
   await page.waitForURL(url=>url.pathname===`/ui/tasks/${rework.id}`);
   await page.getByRole('link',{name:'返回来源列表',exact:true}).click();
   await page.waitForURL(url=>url.searchParams.get('focus')===rework.id&&url.searchParams.get('selected')===fixture.sourceId);
   expect(await selector.inputValue()).toBe(second!.scopeRef);
   expect(await page.locator(`[data-cockpit-focus="node:${rework.id}"]`).getAttribute('aria-pressed')).toBe('true');
  }finally{await tab.context.close();}
 });
});
