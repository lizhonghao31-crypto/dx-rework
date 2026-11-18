import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import type {BulkWashingAdoption} from '@dx-rework/contracts/bulk-washing';
import {bulkWashingWindowReference} from '@dx-rework/contracts/bulk-washing';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {admittedFrameworkProductionFixture,prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {GarmentQualityService,garmentQuality} from '../../apps/api/src/production-platform/garment-quality.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JOURNEY_FACT_CALCULATION_VERSION,journeyFactFingerprint} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('four original washing windows in the authenticated App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-window-navigation-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true});await prepareRewashSettings(h.f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 const prepare=async(mode:'factory'|'after_receipt',complete=true,options:{failedFirst?:boolean}={})=>{
  const f=h.f,fixture=await admittedFrameworkProductionFixture(f);
  return f.runtime.run(fixture.scene,f.root,async()=>{
   const {orderId,lineId,requests,resource,ready,washing}=fixture,duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
   const document:BulkWashingAdoption={arrangement:{mode,reference:'TEST original four windows',revision:1,accounting:mode==='factory'?'included_in_factory':'additional',washing:duration,inspection:duration},staff:{logisticsId:f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:f.people.qc!.actorId},fee:{kind:'pending'},sourceRef:'TEST existing authorized manager arrangement'};
   const washingChanges=[{lineId,expectedVersion:0,document}],preview=await requests.check(f.root,{kind:'arrangement',resource:resource()},{},washingChanges);
   await requests.arrange(f.root,{resource:resource(),fingerprint:preview.fingerprint,overrides:{},washing:washingChanges,acceptLate:true},randomUUID());
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:2,attachmentIds:[await f.image(cutter)]},randomUUID());
   if(mode==='factory'){
    const flow=new FactoryFlowService(f.db),before=await flow.read(f.root,orderId);
    await flow.dispatch(f.root,orderId,{expectedRevision:before.revision,supplierId:f.supplierId,note:'TEST original factory scope'},randomUUID());
   }else{
    const receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},service=new ReceivingService(f.db);
    const first=(await service.create(receiver,{cuttingOrderId:cut,documentQuantity:2,actualQuantity:1,attachmentIds:[await f.image(receiver)]},randomUUID())).value;
    await service.createRepeated(receiver,{cuttingOrderId:cut,receivingBatchId:first.receivingBatchId,source:'jiashun',actualQuantity:1,defectiveQuantity:0},randomUUID());
    const receipts=await garmentQuality(f.db,orderId);expect(receipts).toHaveLength(2);
    for(const receipt of receipts)await new GarmentQualityService(f.db).record(f.root,orderId,{receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:1,occurredAt:'2026-11-17T08:00:00.000Z',problem:''},randomUUID());
   }
   const scopes=(await washing.read(f.root,orderId)).scopes;expect(scopes).toHaveLength(mode==='factory'?1:2);
   let index=0;
   for(const original of scopes)for(let batch=0;complete&&batch<(mode==='factory'?2:1);batch++){
    const failed=options.failedFirst&&index===0;
    const base=async()=>{const scope=(await washing.read(f.root,orderId)).scopes.find(row=>row.scopeId===original.scopeId)!;return {planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:'2026-11-17T08:00:00.000Z',note:'TEST exact native batch '+(++index)};};
    const start=await washing.record(f.root,orderId,{...await base(),kind:mode==='factory'?'factory_start':'send',quantity:1},randomUUID());
    const completion=await washing.record(f.root,orderId,{...await base(),...(mode==='factory'?{kind:'factory_complete' as const,startId:start.eventId}:{kind:'return' as const,sendId:start.eventId}),quantity:1},randomUUID());
    await washing.record(f.root,orderId,{...await base(),kind:'inspection',completionId:completion.eventId,quantity:1,qualifiedQuantity:failed?0:1},randomUUID());
   }
   const sheet=await washing.read(f.root,orderId);expect(sheet.scopes.flatMap(scope=>scope.windows)).toHaveLength(complete?4:0);
   return {...fixture,sheet};
  });
 };
 it.each([['factory',390],['after_receipt',1165]] as const)('clicks every %s window, follows its original records and restores the selected window at width%s',async(mode,width)=>{
  const f=h.f,fixture=await prepare(mode);h.setCollectionScene(fixture.scene);
  if(mode==='factory')await f.runtime.run(fixture.scene,f.root,async()=>{
   const resource={kind:'order' as const,id:fixture.orderId},facts=new JourneyFactRepository(f.db),original=await facts.buildOne(resource),old=structuredClone(original.model),previous='journey-facts-factory-instances-v14';
   expect(JOURNEY_FACT_CALCULATION_VERSION).not.toBe(previous);
   expect(JSON.stringify(original.model)).toContain('nativeWashingWindow');
   // Reconstruct only the previous derived cache's missing new identity.
   // Original task/event/plan/quantity data is never changed by this fixture.
   const strip=(value:unknown):void=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(strip);return;}const row=value as Record<string,unknown>;delete row.nativeWashingWindow;Object.values(row).forEach(strip);};strip(old);
   await f.db.query('UPDATE digital_journey_fact_models SET calculation_version=$3,payload=$4,source_fingerprint=$5 WHERE resource_kind=$1 AND resource_id=$2',['order',fixture.orderId,previous,JSON.stringify(old),journeyFactFingerprint(old)]);
   const client=await f.db.connect();try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(await facts.readStoredWithClient(client,resource)).toMatchObject({status:'obsolete',model:null});
    const selections=await facts.readSelectionsWithClient(client,[resource],(await f.runtime.repository.view(fixture.scene)).now);
    expect(selections.items.get('order:'+fixture.orderId)).toMatchObject({status:'obsolete',facts:null});await client.query('COMMIT');
   }finally{client.release();}
   const rebuilt=await facts.buildOne(resource);expect(rebuilt.model.fixedSchedule).toEqual(original.model.fixedSchedule);expect(rebuilt.model.sla.facts).toEqual(original.model.sla.facts);
   expect((await f.db.query('SELECT calculation_version FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2',['order',fixture.orderId])).rows[0].calculation_version).toBe(JOURNEY_FACT_CALCULATION_VERSION);
  });
  const tab=await h.open(f.root.actorId,width,{},'/ui/digital-cockpit?selected='+fixture.sourceId);
  try{
   const page=tab.page,read=async()=>{const response=await page.request.get(h.base+'/api/digital-production/journeys/'+fixture.sourceId+'?view=cockpit');expect(response.status()).toBe(200);return response.json() as Promise<OrderJourney>;},before=await read();
   const nodes=before.stages.flatMap(stage=>stage.nodes).filter(node=>node.key===(mode==='factory'?'bulk_factory_washing':'bulk_return_washing')||node.key===(mode==='factory'?'bulk_factory_washing_inspection':'bulk_return_washing_inspection'));
   expect(nodes).toHaveLength(2);expect(nodes.flatMap(node=>node.nativeWindows??[])).toHaveLength(4);
   let hops=0;
   for(const node of nodes)for(const window of node.nativeWindows??[]){
    expect(window.record).toMatchObject({domain:'factory',id:fixture.orderId,lineId:fixture.lineId,mode:'read'});
    const target=new URL(window.record!.url!,h.base).searchParams.get('washingWindow')!,scope=fixture.sheet.scopes.find(scope=>scope.windows.some(native=>bulkWashingWindowReference(scope.scopeId,native.id)===target))!;
    const native=scope.windows.find(native=>bulkWashingWindowReference(scope.scopeId,native.id)===target)!;
    expect(window).toMatchObject({evidence:target,startedAt:native.startedAt,deadline:native.dueAt,completedAt:native.completedAt});
    await page.goto(h.base+'/ui/digital-cockpit?'+new URLSearchParams({selected:fixture.sourceId,expanded:node.stage,focus:node.instanceId,row:node.instanceId}));
    await page.locator('[data-view=order][aria-busy=false]').waitFor();
    const current=page.getByRole('region',{name:'当前节点详情'});await current.locator('summary').filter({hasText:'节点详情'}).click();
    const link=current.getByRole('link',{name:'查看本窗口记录',exact:true});
    const exact=link;let clicked=false;
    for(let i=0;i<await exact.count();i++)if(new URL((await exact.nth(i).getAttribute('href'))!,h.base).searchParams.get('washingWindow')===target){await exact.nth(i).click();clicked=true;break;}
    expect(clicked).toBe(true);
    const article=page.locator('[data-washing-window]');
    await page.locator('[data-washing-window][aria-current=location]').waitFor();
    const selected=page.locator('[data-washing-window][aria-current=location]');expect(await selected.getAttribute('data-washing-window')).toBe(target);
    await expect.poll(()=>page.evaluate(()=>document.activeElement?.getAttribute('data-washing-window'))).toBe(target);
    expect(await selected.evaluate(node=>{const box=node.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1;})).toBe(true);
    expect(new URL(page.url()).searchParams.get('washingWindow')).toBe(target);expect(await selected.locator('summary').innerText()).toBe('本窗口原记录');
    await selected.locator('summary').click();const expectedNotes=scope.facts.filter(fact=>fact.kind==='inspection'?fact.completionId===native.id.replace(/:qc$/,''):fact.id===native.id);
    expect(expectedNotes.length).toBeGreaterThan(0);for(const fact of expectedNotes)expect(await selected.innerText()).toContain(fact.note);
    expect(await page.locator('#factory-washing').getByRole('button',{name:'保存',exact:true}).count()).toBe(0);expect(await article.count()).toBeGreaterThanOrEqual(2);
    if(hops++===0){
     // Keep native notifications and the mobile shell enabled. Acknowledge
     // real notices and scroll the native link above the fixed bottom nav.
     for(let attempt=0;attempt<8;attempt++){
      const notice=page.locator('[aria-label="站内提醒"]');if(await notice.isVisible())await notice.getByRole('button',{name:'我知道了',exact:true}).click();
      const budget=page.getByRole('link',{name:'本单预算费用补充',exact:true});await budget.evaluate(node=>node.scrollIntoView({block:'center'}));
      try{await budget.click({timeout:1500});break;}catch(error){if(attempt===7)throw error;}
     }
     await page.getByRole('button',{name:'返回来源',exact:true}).click();await selected.waitFor();expect(new URL(page.url()).searchParams.get('washingWindow')).toBe(target);
    }
    await page.getByRole('button',{name:'返回',exact:true}).first().click();await page.locator('[data-view=order][aria-busy=false]').waitFor();
    expect(new URL(page.url()).searchParams.get('focus')).toBe(node.instanceId);expect(new URL(page.url()).searchParams.get('materialFocus')).toBe('washing-window:'+target);
    await expect.poll(()=>page.evaluate(()=>document.activeElement?.closest<HTMLElement>('[data-material-focus]')?.dataset.materialFocus)).toBe('washing-window:'+target);
   }
   expect(await read()).toMatchObject({orderId:before.orderId});
   expect((await f.runtime.run(fixture.scene,f.root,()=>fixture.washing.read(f.root,fixture.orderId))).scopes).toEqual(fixture.sheet.scopes);
   expect(h.requests.filter(call=>call.session===tab.session&&call.method==='POST'&&call.path.endsWith('/bulk-washing'))).toEqual([]);
   const originalWindow=nodes[0]!.nativeWindows![0]!,reference=originalWindow.evidence;
   for(const bad of [{line:randomUUID(),washingWindow:reference},{line:fixture.lineId,washingWindow:'washing:receipt:FOREIGN:missing'}]){
    await page.goto(h.base+'/ui/digital-production?'+new URLSearchParams({factory:fixture.orderId,factoryAction:'washing',...bad}));
    await page.getByRole('alert').filter({hasText:/没有指定PO范围|没有此可见洗水窗口/}).waitFor();
    expect(new URL(page.url()).searchParams.get('washingWindow')).toBe(bad.washingWindow);
    expect(await page.locator('[data-washing-window][aria-current=location]').count()).toBe(0);expect(await page.getByRole('button',{name:'保存',exact:true}).count()).toBe(0);
   }
   const scoped=await h.open(f.people['embroidery-washing-merchandiser']!.actorId,width,{},originalWindow.record!.url!);
   try{await scoped.page.locator('[data-washing-window][aria-current=location]').waitFor();expect(await scoped.page.getByText(/洗水费用：/).count()).toBe(0);expect(await scoped.page.getByRole('button',{name:'保存',exact:true}).count()).toBe(0);expect(h.requests.filter(call=>call.session===scoped.session&&call.path.endsWith('/factory-flow'))).toEqual([]);}finally{await scoped.context.close();}
   const foreign=await h.dedicated('worker'),denied=await h.open(foreign.id,width,{},originalWindow.record!.url!);
   try{await denied.page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();expect((await denied.page.request.get(h.base+'/api/digital-production/orders/'+fixture.orderId+'/bulk-washing')).status()).toBe(403);expect(await denied.page.locator('[data-washing-window]').count()).toBe(0);}finally{await denied.context.close();}
   await page.screenshot({path:join(h.evidence,'exact-four-windows-'+mode+'-'+width+'.png'),fullPage:true});
  }catch(error){await writeFile(join(h.evidence,'four-windows-failure-'+mode+'.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('selects the exact six original/rewash windows, preserves default-instance links and respects deliberate filters without navigation writes',async()=>{
  const f=h.f,logistics=f.people['embroidery-washing-merchandiser']!,fixture=await prepare('after_receipt',true,{failedFirst:true});h.setCollectionScene(fixture.scene);
  const failed=fixture.sheet.scopes.flatMap(scope=>scope.facts).find(fact=>fact.kind==='inspection'&&fact.qualifiedQuantity===0)!;expect(failed).toBeTruthy();
  const tab=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+fixture.sourceId);
  try{
   const page=tab.page,read=async()=>{const response=await page.request.get(h.base+'/api/digital-production/journeys/'+fixture.sourceId+'?view=cockpit');expect(response.status()).toBe(200);return response.json() as Promise<OrderJourney>;};
   const before=await read(),originalNodes=before.stages.flatMap(stage=>stage.nodes).filter(node=>node.key==='bulk_return_washing'||node.key==='bulk_return_washing_inspection'),originalIds=new Set(originalNodes.map(node=>node.instanceId));expect(originalNodes).toHaveLength(2);
   await f.advance(fixture.scene,'2026-11-17T08:10:00.000Z');
   await f.runtime.run(fixture.scene,f.root,async()=>{
    const operation={kind:'arrangement' as const,resource:fixture.resource()},choices=await fixture.requests.check(f.root,operation),choice=choices.rewashing!.find(row=>row.inspectionId===failed.id)!;expect(choice.availableQuantity).toBe(1);
    const intentId=randomUUID(),rewashing=[{intentId,lineId:fixture.lineId,scopeId:choice.scopeId,quantityVersion:choice.quantityVersion,inspectionId:failed.id,quantity:1}],checked=await fixture.requests.check(f.root,operation,{},[],rewashing);
    await fixture.requests.arrange(f.root,{resource:fixture.resource(),fingerprint:checked.fingerprint,overrides:{},rewashing,acceptLate:true},randomUUID());
    const base=async()=>{const scope=(await fixture.washing.read(f.root,fixture.orderId)).scopes.find(row=>row.scopeId===choice.scopeId)!;return {planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:'2026-11-17T08:10:00.000Z',note:'TEST genuine new rewash retains failed history'};};
    const send=await fixture.washing.record(f.root,fixture.orderId,{...await base(),kind:'send',quantity:1,reworkOfInspectionId:failed.id,rewashWorkId:intentId},randomUUID());
    const completion=await fixture.washing.record(f.root,fixture.orderId,{...await base(),kind:'return',sendId:send.eventId,quantity:1},randomUUID());
    await fixture.washing.record(f.root,fixture.orderId,{...await base(),kind:'inspection',completionId:completion.eventId,quantity:1,qualifiedQuantity:1},randomUUID());
   });
   const after=await read(),sheet=await f.runtime.run(fixture.scene,f.root,()=>fixture.washing.read(f.root,fixture.orderId)),expected=sheet.scopes.flatMap(scope=>scope.windows.map(window=>bulkWashingWindowReference(scope.scopeId,window.id))).sort();
   expect(expected).toHaveLength(6);expect(new Set(expected).size).toBe(6);expect(sheet.scopes.flatMap(scope=>scope.facts).find(fact=>fact.id===failed.id)).toMatchObject({qualifiedQuantity:0,voided:false});
   for(const original of fixture.sheet.scopes)for(const window of original.windows)expect(sheet.scopes.find(scope=>scope.scopeId===original.scopeId)!.windows.find(row=>row.id===window.id)).toEqual(window);
   const nodes=after.stages.flatMap(stage=>stage.nodes).filter(node=>originalIds.has(node.instanceId));expect(nodes).toHaveLength(2);expect(nodes.flatMap(node=>node.nativeWindows!.map(window=>window.evidence)).sort()).toEqual(expected);
   const added=after.stages.flatMap(stage=>stage.nodes).filter(node=>!originalIds.has(node.instanceId)&&node.key.startsWith('bulk_return_washing'));expect(added).toHaveLength(2);expect(added.every(node=>node.planningOnly&&!node.countsInProgress)).toBe(true);
   const allProjections=[...nodes,...added].flatMap(node=>node.nativeWindows!.map(window=>window.evidence));expect(allProjections).toHaveLength(8);expect([...new Set(allProjections)].sort()).toEqual(expected);
   const sessions=[tab.session];
   for(const node of nodes){
    const context={selected:fixture.sourceId,expanded:node.stage,focus:node.instanceId,row:node.instanceId},own=node.nativeWindows!;
    await page.goto(h.base+'/ui/digital-cockpit?'+new URLSearchParams(context));await page.locator('[data-view=order][aria-busy=false]').waitFor();
    const current=page.getByRole('region',{name:'当前节点详情'}),details=current.locator('.cockpit-current-additional');await details.locator('summary').first().click();
    expect((await current.locator('[data-washing-choice]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-washing-choice')!))).sort()).toEqual(own.map(window=>window.evidence).sort());
    for(const window of own){
     const row=current.locator('[data-washing-choice]'),matches=[];
     for(let i=0;i<await row.count();i++)if(await row.nth(i).getAttribute('data-washing-choice')===window.evidence)matches.push(row.nth(i));
     expect(matches).toHaveLength(1);const selectedRow=matches[0]!;
     await selectedRow.getByRole('button',{name:'选中本窗口',exact:true}).click();
     await expect.poll(()=>new URL(page.url()).searchParams.get('materialFocus')).toBe('washing-window:'+window.evidence);expect(await selectedRow.getByRole('button',{name:'选中本窗口',exact:true}).getAttribute('aria-pressed')).toBe('true');expect(await current.locator('[data-washing-choice][aria-current=true]').count()).toBe(1);
     await selectedRow.getByRole('link',{name:'查看本窗口记录',exact:true}).click();await page.locator('[data-washing-window][aria-current=location]').waitFor();
     expect(await page.locator('[data-washing-window][aria-current=location]').getAttribute('data-washing-window')).toBe(window.evidence);expect(await page.getByRole('button',{name:'保存',exact:true}).count()).toBe(0);
     await page.getByRole('button',{name:'返回',exact:true}).first().click();await page.locator('[data-view=order][aria-busy=false]').waitFor();
     expect(new URL(page.url()).searchParams.get('focus')).toBe(node.instanceId);expect(new URL(page.url()).searchParams.get('materialFocus')).toBe('washing-window:'+window.evidence);await current.locator('[data-washing-choice][aria-current=true]').waitFor();
    }
    // An incoming filter cannot erase the requested completed window and pick
    // a default active sibling. Explicit user navigation may then leave it.
    const target=own[0]!.evidence;
    await page.goto(h.base+'/ui/digital-cockpit?'+new URLSearchParams({...context,expanded:'development',milestone:'TEST-other-range',nodeView:'active',materialNode:`${after.id}|${after.selectedRound??0}|${node.instanceId}`,materialFocus:'washing-window:'+target}));
    await page.locator('[data-view=order][aria-busy=false]').waitFor();await current.locator('[data-washing-choice][aria-current=true]').waitFor();expect(new URL(page.url()).searchParams.get('focus')).toBe(node.instanceId);expect(new URL(page.url()).searchParams.get('nodeView')).toBe('all');
    const statusFilter=page.getByRole('combobox',{name:'节点状态筛选'});
    await statusFilter.selectOption('completed');
    await expect.poll(()=>new URL(page.url()).searchParams.get('nodeView')).toBe('completed');
    await expect.poll(()=>new URL(page.url()).searchParams.get('materialFocus')).toBeNull();
    expect(await current.locator('[data-washing-choice][aria-current=true]').count()).toBe(0);
    await current.locator('[data-washing-choice]').first().getByRole('button',{name:'选中本窗口',exact:true}).click();
    await expect.poll(()=>new URL(page.url()).searchParams.get('materialFocus')).toMatch(/^washing-window:/);
    await statusFilter.selectOption('active');
    await expect.poll(()=>new URL(page.url()).searchParams.get('nodeView')).toBe('active');
    await expect.poll(()=>new URL(page.url()).searchParams.get('materialFocus')).toBeNull();
    expect(await current.locator('[data-washing-choice][aria-current=true]').count()).toBe(0);
    expect(await statusFilter.inputValue()).toBe('active');
    await page.getByRole('button',{name:'本单全部节点',exact:true}).click();
   }
   // Restrict the view to these two genuine authorized DTO rows so their
   // shared rewash window is reachable from a deterministic implicit default.
   // Keep original record reads and return navigation on the real App.
   const original=nodes[0]!,rewash=added.find(node=>node.nativeWindows?.some(window=>original.nativeWindows?.some(w=>w.evidence===window.evidence)))!;
   const shared=rewash.nativeWindows!.find(window=>original.nativeWindows?.some(w=>w.evidence===window.evidence))!;
   const route='/api/digital-production/journeys/'+fixture.sourceId;
   const defaultFrame=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+fixture.sourceId);
   sessions.push(defaultFrame.session);
   try{
    const implicit=defaultFrame.page;
    await implicit.route('**'+route+'?*',async handler=>{
     const response=await handler.fetch(),document=await response.json() as OrderJourney;
     const instances=document.stages.flatMap(stage=>stage.nodes);
     const pair=[original,rewash].map(({instanceId})=>instances.find(node=>node.instanceId===instanceId)!);
     await handler.fulfill({response,json:{...document,stages:document.stages.map(stage=>stage.key===original.stage?{...stage,nodes:pair}:stage)}});
    });
    await implicit.goto(h.base+'/ui/digital-cockpit?'+new URLSearchParams({selected:fixture.sourceId,milestone:'',expanded:original.stage}));
    await implicit.locator('[data-view=order][aria-busy=false]').waitFor();
    const current=implicit.getByRole('region',{name:'当前节点详情'});
    const rows=implicit.getByRole('region',{name:'节点列表'});
    expect(await rows.locator('[aria-pressed=true]').getAttribute('data-cockpit-focus')).toBe('node:'+original.instanceId);
    expect(new URL(implicit.url()).searchParams.has('focus')).toBe(false);
    await current.locator('summary').filter({hasText:'节点详情'}).click();
    const selectedRow=current.locator('[data-washing-choice="'+shared.evidence+'"]');
    const link=selectedRow.getByRole('link',{name:'查看本窗口记录',exact:true});
    const href=new URL((await link.getAttribute('href'))!,h.base);
    const returnTo=new URL(href.searchParams.get('returnTo')!,h.base).searchParams;
    expect(returnTo.get('focus')).toBe(original.instanceId);
    expect(returnTo.get('materialFocus')).toBe('washing-window:'+shared.evidence);
    await selectedRow.getByRole('button',{name:'选中本窗口',exact:true}).click();
    await expect.poll(()=>new URL(implicit.url()).searchParams.get('focus')).toBe(original.instanceId);
    await expect.poll(()=>new URL(implicit.url()).searchParams.get('materialFocus')).toBe('washing-window:'+shared.evidence);
    await link.click();
    const record=implicit.locator('[data-washing-window][aria-current=location]');
    await record.waitFor();
    expect(await record.getAttribute('data-washing-window')).toBe(shared.evidence);
    await implicit.getByRole('button',{name:'返回',exact:true}).first().click();
    await current.locator('[data-washing-choice][aria-current=true]').waitFor();
    expect(new URL(implicit.url()).searchParams.get('focus')).toBe(original.instanceId);
    expect(new URL(implicit.url()).searchParams.get('materialFocus')).toBe('washing-window:'+shared.evidence);
   }finally{await defaultFrame.context.close();}
   // A real different order/PO supplies adversarial references. The singleton
   // logistics role is unchanged: even an otherwise readable second order must
   // not leak into the first mother's mismatched window URL. The original cases
   // above independently require403 for a role with no washing scope at all.
   const foreign=await prepare('factory');h.setCollectionScene(fixture.scene);const deniedScope=foreign.sheet.scopes[0]!,foreignReference=bulkWashingWindowReference(deniedScope.scopeId,deniedScope.windows[0]!.id),allowed=nodes[0]!.nativeWindows![0]!;
   const ordinary=await h.open(logistics.actorId,1165,{},allowed.record!.url!);sessions.push(ordinary.session);
   try{
    await ordinary.page.locator('[data-washing-window][aria-current=location]').waitFor();expect(await ordinary.page.getByText(/洗水费用：/).count()).toBe(0);
    const readable=await ordinary.page.request.get(h.base+'/api/digital-production/orders/'+fixture.orderId+'/bulk-washing');expect(readable.status()).toBe(200);const visible=await readable.json();expect(visible.scopes.flatMap((scope:{windows:unknown[]})=>scope.windows)).toHaveLength(6);
    for(const window of nodes.flatMap(node=>node.nativeWindows!)){
     await ordinary.page.goto(h.base+window.record!.url!);await ordinary.page.locator('[data-washing-window][aria-current=location]').waitFor();expect(await ordinary.page.locator('[data-washing-window][aria-current=location]').getAttribute('data-washing-window')).toBe(window.evidence);expect(await ordinary.page.getByRole('button',{name:'保存',exact:true}).count()).toBe(0);
    }
    for(const forged of [{line:foreign.lineId,washingWindow:foreignReference},{line:fixture.lineId,washingWindow:foreignReference}]){
     await ordinary.page.goto(h.base+'/ui/digital-production?'+new URLSearchParams({factory:fixture.orderId,factoryAction:'washing',...forged}));await ordinary.page.getByRole('alert').filter({hasText:/没有指定PO范围|没有此可见洗水窗口/}).waitFor();
     expect(new URL(ordinary.page.url()).searchParams.get('washingWindow')).toBe(foreignReference);expect(await ordinary.page.locator('[data-washing-window][aria-current=location]').count()).toBe(0);expect(await ordinary.page.getByRole('button',{name:'保存',exact:true}).count()).toBe(0);expect(await ordinary.page.getByText(deniedScope.label,{exact:true}).count()).toBe(0);
    }
   }finally{await ordinary.context.close();}
   const invalid='washing:receipt:UNAVAILABLE:missing',node=nodes[0]!;
   await page.goto(h.base+'/ui/digital-cockpit?'+new URLSearchParams({selected:fixture.sourceId,focus:node.instanceId,row:node.instanceId,materialFocus:'washing-window:'+invalid}));await page.getByRole('region',{name:'当前节点详情'}).getByRole('alert').filter({hasText:'指定目标已保留'}).waitFor();expect(new URL(page.url()).searchParams.get('materialFocus')).toBe('washing-window:'+invalid);expect(await page.getByRole('region',{name:'当前节点详情'}).getByRole('link').count()).toBe(0);
   expect((await f.runtime.run(fixture.scene,f.root,()=>fixture.washing.read(f.root,fixture.orderId))).scopes).toEqual(sheet.scopes);
   // Original notification acknowledgement is separate from business writes.
   expect(h.requests.filter(call=>sessions.includes(call.session)&&!['GET','HEAD'].includes(call.method)&&!call.path.includes('/notifications/'))).toEqual([]);
   await writeFile(join(h.evidence,'six-window-identities.json'),JSON.stringify({source:'Genuine original manager plan, failed inspection and newly arranged rewash; original App/AuthService; no onsite UUID mapping claimed',expected,selected:nodes.map(node=>({instanceId:node.instanceId,windows:node.nativeWindows!.map(window=>window.evidence)})),navigationBusinessWrites:0},null,2));
  }catch(error){await writeFile(join(h.evidence,'six-windows-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('preserves the original washing form and exact pending command across same-order reads and canceled navigation',async()=>{
  const f=h.f,fixture=await prepare('factory',false);await f.advance(fixture.scene,'2026-11-17T08:01:00.000Z');h.setCollectionScene(fixture.scene);
  const path='/api/digital-production/orders/'+fixture.orderId+'/bulk-washing',fault={losePath:path,readPath:path,failRead:false},tab=await h.open(f.root.actorId,1165,fault,'/ui/digital-production?factory='+fixture.orderId+'&factoryAction=washing');
  try{
   const page=tab.page,panel=page.locator('#factory-washing');await panel.locator('details > summary').first().click();
   const form=panel.locator('form');await form.locator('[name=quantity]').fill('1');await form.locator('[name=occurredAt]').fill('2026-11-17T16:00:00.123');await form.locator('[name=note]').fill('TEST unsaved precise original washing');
   await form.evaluate(node=>node.setAttribute('data-original-mounted','true'));
   const assertDraft=async()=>{expect(await form.getAttribute('data-original-mounted')).toBe('true');expect(await form.locator('[name=quantity]').inputValue()).toBe('1');expect(await form.locator('[name=occurredAt]').inputValue()).toBe('2026-11-17T16:00:00.123');expect(await form.locator('[name=note]').inputValue()).toBe('TEST unsaved precise original washing');};
   await panel.getByRole('button',{name:'刷新洗水记录',exact:true}).click();await panel.getByText('正在读取洗水记录…',{exact:true}).waitFor({state:'hidden'});await assertDraft();
   fault.failRead=true;await panel.getByRole('button',{name:'刷新洗水记录',exact:true}).click();await panel.getByRole('alert').filter({hasText:'TEST 设置读取暂时失败'}).waitFor();await assertDraft();
   await page.getByRole('button',{name:'返回',exact:true}).first().click();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await assertDraft();
   const response=page.waitForResponse(value=>value.url().endsWith(path)&&value.request().method()==='POST');await form.getByRole('button',{name:'保存',exact:true}).click();expect((await response).status()).toBe(503);
   await panel.getByText('提交结果未确认，请用原内容核对，勿重复登记。',{exact:true}).waitFor();
   const first=h.requests.filter(call=>call.session===tab.session&&call.path===path&&call.method==='POST');expect(first).toHaveLength(1);expect(first[0]!.status).toBe(200);
   const before=await f.runtime.run(fixture.scene,f.root,()=>fixture.washing.read(f.root,fixture.orderId));expect(before.scopes[0]!.facts).toHaveLength(1);expect(before.scopes[0]!.facts[0]).toMatchObject({occurredAt:'2026-11-17T08:00:00.123Z',quantity:1});
   await panel.getByRole('button',{name:'刷新洗水记录',exact:true}).click();await panel.getByText('正在读取洗水记录…',{exact:true}).waitFor({state:'hidden'});expect(await panel.getByRole('button',{name:'核对原提交',exact:true}).count()).toBe(1);
   await panel.getByRole('button',{name:'核对原提交',exact:true}).click();await expect.poll(()=>panel.getByRole('button',{name:'核对原提交',exact:true}).count()).toBe(0);
   const calls=h.requests.filter(call=>call.session===tab.session&&call.path===path&&call.method==='POST');expect(calls).toHaveLength(2);expect(calls[1]).toMatchObject({key:calls[0]!.key,bodyHash:calls[0]!.bodyHash,status:200});expect(calls[0]!.key).toBeTruthy();
   const after=await f.runtime.run(fixture.scene,f.root,()=>fixture.washing.read(f.root,fixture.orderId));expect(after.scopes).toEqual(before.scopes);
  }finally{await tab.context.close();}
 });
});
