import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {GarmentQualityService,garmentQuality} from '../../apps/api/src/production-platform/garment-quality.js';
import {adoptBulkWashingWithClient} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
import {BulkWashingService} from '../../apps/api/src/production-platform/bulk-washing-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const currentBeijingInput=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,23).replace(/0+$/,'').replace(/\.$/,'');
(url?describe:describe.skip)('normal bulk washing in original App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>,orderId:string,inspector:Awaited<ReturnType<typeof r5RoleFixture>>;
 beforeAll(async()=>{
  h=await supplychainSettingsBrowser(url!,join(process.env.RUNNER_TEMP??tmpdir(),'bulk-washing-ui-'+randomUUID()),{fullApp:true});
  inspector=await r5RoleFixture(h.db,h.f.access,{...h.f.root,requestId:randomUUID()},'quality_control');
  const f=h.f,ready=await f.bulkReady('无',undefined,1,undefined,{quantity:100});orderId=ready.id;
  const line=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[orderId])).rows[0].line_id;
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  await new ReceivingService(f.db).create(warehouse,{cuttingOrderId:cut,documentQuantity:30,actualQuantity:30,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const receipt=(await garmentQuality(f.db,orderId))[0]!;
  await new GarmentQualityService(f.db).record(f.root,orderId,{receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:30,occurredAt:new Date().toISOString(),problem:''},randomUUID());
  const time={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}},db=await f.db.connect();
  try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,orderId,line,0,{arrangement:{mode:'after_receipt',reference:'TEST',revision:1,accounting:'additional',washing:time,inspection:time},staff:{logisticsId:f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:inspector.actor.actorId},fee:{kind:'pending'},sourceRef:'TEST approved washing'});await db.query('COMMIT');}finally{db.release();}
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('keeps factory denial scoped and settled while assigned washing logistics and QC retain their own narrow region',async()=>{
  for(const [id,kinds]of [[h.f.people['embroidery-washing-merchandiser']!.actorId,['send','return']],[inspector.actor.actorId,['inspection']]] as const){
   const tab=await h.open(id,1165,{},`/ui/digital-production?factory=${orderId}`);
   try{
    const factory=tab.page.getByRole('region',{name:'工厂流程资料'});await factory.getByRole('alert').waitFor();
    expect(await factory.innerText()).toContain('工厂流程资料暂不可读：资料不存在或不在授权范围');expect(await factory.getByText('正在读取工厂资料…',{exact:true}).count()).toBe(0);
    expect(h.requests.filter(call=>call.session===tab.session&&call.path.endsWith('/factory-flow')).at(-1)?.status).toBe(404);
    const washing=tab.page.locator('#factory-washing');await washing.getByRole('button',{name:'大货洗水',exact:true}).click();
    await washing.getByText(/收货批次.*合格 0 \/ 30/).click();
    expect(await washing.getByLabel('办理',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(kinds);
    expect(await washing.getByText(/洗水费用：/).count()).toBe(0);expect(await factory.getByText(/当前批准加工厂/).count()).toBe(0);
    expect(await washing.getByRole('alert').count()).toBe(0);
    await tab.page.screenshot({path:join(h.evidence,id===inspector.actor.actorId?'washing-qc-scoped-factory-1165.png':'washing-logistics-scoped-factory-1165.png'),fullPage:true});
   }finally{await tab.context.close();}
  }
 });
 it('ends factory transport failure, retries the real authorized region and leaves washing independently readable',async()=>{
  const tab=await h.open(h.f.root.actorId,1165,{},`/ui/digital-production?factory=${orderId}&factoryAction=washing`);
  try{
   let first=true;await tab.page.route(`**/orders/${orderId}/factory-flow`,async route=>{if(first){first=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_FACTORY_READ',message:'TEST 工厂读取暂时失败'}})});}else await route.continue();});
   await tab.page.goto(h.base+`/ui/digital-production?factory=${orderId}`);
   const factory=tab.page.getByRole('region',{name:'工厂流程资料'});await factory.getByRole('alert').waitFor();expect(await factory.innerText()).toContain('TEST 工厂读取暂时失败');expect(await factory.getByText('正在读取工厂资料…',{exact:true}).count()).toBe(0);
   const washing=tab.page.locator('#factory-washing');await washing.getByRole('button',{name:'大货洗水',exact:true}).click();await washing.getByText(/收货批次.*合格 0 \/ 30/).waitFor();
   const loaded=tab.page.waitForResponse(response=>response.url().endsWith('/factory-flow')&&response.request().method()==='GET');await factory.getByRole('button',{name:'刷新',exact:true}).click();expect((await loaded).status()).toBe(200);
   await factory.getByText(/整款实裁：全部PO完成/).waitFor();expect(await factory.getByRole('alert').count()).toBe(0);expect(await factory.getByText('正在读取工厂资料…',{exact:true}).count()).toBe(0);
   expect(await washing.getByText(/收货批次.*合格 0 \/ 30/).count()).toBe(1);
  }finally{await tab.context.close();}
 });
 it('preserves unsaved logistics, dispatch and ship-sample inputs through a same-order native refresh',async()=>{
  const crafted=await h.f.bulkReady('印花'),cutter={...h.f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  const cuts=(await h.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[crafted.caseId])).rows;
  for(const cut of cuts)await crafted.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await h.f.image(cutter)]},randomUUID());
  // A real no-craft route intentionally has no logistics form. Exercise each
  // form on its native applicable order rather than forging capability flags.
  for(const id of [orderId,crafted.id]){
   const tab=await h.open(h.f.root.actorId,1165,{},`/ui/digital-production?factory=${id}`);let release=()=>undefined;
   try{
    const factory=tab.page.getByRole('region',{name:'工厂流程资料'});await factory.getByText(/整款实裁：全部PO完成/).waitFor();
    const fields:Array<{form:ReturnType<typeof factory.locator>;values:Record<string,string>}>=[];
    if(id===crafted.id){
     const movement=factory.locator('form:has(#factory-logistics)');fields.push({form:movement,values:{supplier:'TEST 未提交工艺厂',at:'2026-11-15T09:30',note:'TEST 未提交收发说明'}});
    }else{
     const dispatch=factory.locator('select[name=dispatchTimeMode]').locator('xpath=ancestor::form');expect(await dispatch.count()).toBe(1);await dispatch.locator('[name=dispatchTimeMode]').selectOption('manual');
     fields.push({form:dispatch,values:{at:'2026-11-15T10:30',note:'TEST 未提交发厂说明'}});
     await factory.getByText('船样记录',{exact:true}).click();fields.push({form:factory.locator('input[name=tracking]').locator('xpath=ancestor::form'),values:{at:'2026-11-15T11:30',tracking:'TEST-UNSAVED-TRACKING',note:'TEST 未提交船样说明'}});
    }
    for(const {form,values}of fields){for(const [name,value]of Object.entries(values))await form.locator(`[name=${name}]`).fill(value);await form.evaluate(node=>node.setAttribute('data-test-draft-mounted','true'));}
    const gate=new Promise<void>(resolve=>{release=resolve;});await tab.page.route(`**/orders/${id}/factory-flow`,async route=>{await gate;await route.continue();});
    const response=tab.page.waitForResponse(value=>value.url().endsWith('/factory-flow')&&value.request().method()==='GET');
    await factory.getByRole('button',{name:'刷新',exact:true}).click();await factory.getByText('正在读取工厂资料…',{exact:true}).waitFor();
    for(const {form,values}of fields){expect(await form.evaluate(node=>Boolean(node.closest('[inert]')))).toBe(true);for(const [name,value]of Object.entries(values))expect(await form.locator(`[name=${name}]`).inputValue()).toBe(value);}
    release();expect((await response).status()).toBe(200);await factory.getByText('正在读取工厂资料…',{exact:true}).waitFor({state:'hidden'});
    for(const {form,values}of fields){expect(await form.getAttribute('data-test-draft-mounted')).toBe('true');for(const [name,value]of Object.entries(values))expect(await form.locator(`[name=${name}]`).inputValue()).toBe(value);}
    expect(h.requests.filter(call=>call.session===tab.session&&call.path.includes(`/orders/${id}/factory-flow`)&&call.method==='POST')).toEqual([]);
   }catch(error){await tab.page.screenshot({path:join(h.evidence,'factory-draft-refresh-failure.png'),fullPage:true});throw error;}finally{release();await tab.context.close();}
  }
 });
 it('preserves both module and object denial for unrelated real users without granting factory or washing access',async()=>{
  const worker=await h.dedicated('worker'),tab=await h.open(worker.id,1165,{},`/ui/digital-production?factory=${orderId}`);
  try{
   // A plain worker is denied before the business page mounts. Do not widen
   // that stronger original module boundary just to exercise a region.
   await tab.page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();
   expect(await tab.page.getByRole('region',{name:'工厂流程资料'}).count()).toBe(0);expect(await tab.page.locator('#factory-washing').count()).toBe(0);
   expect((await tab.page.request.get(h.base+`/api/digital-production/orders/${orderId}/factory-flow`)).status()).toBe(404);
   expect((await tab.page.request.get(h.base+`/api/digital-production/orders/${orderId}/bulk-washing`)).status()).toBe(403);
  }finally{await tab.context.close();}
  const designer=await h.dedicated('sample_designer'),foreign=await h.open(designer.id,1165,{},`/ui/digital-production?factory=${orderId}`);
  try{
   const factory=foreign.page.getByRole('region',{name:'工厂流程资料'});await factory.getByRole('alert').waitFor();expect(await factory.getByText('正在读取工厂资料…',{exact:true}).count()).toBe(0);
   const washing=foreign.page.locator('#factory-washing');await washing.getByRole('button',{name:'大货洗水',exact:true}).click();await washing.getByRole('alert').waitFor();
   expect(await washing.getByLabel('办理',{exact:true}).count()).toBe(0);expect(await washing.getByText('正在读取洗水记录…',{exact:true}).count()).toBe(0);expect(await factory.getByText(/当前批准加工厂/).count()).toBe(0);
  }finally{await foreign.context.close();}
 });
 it.each(['after_receipt','factory'] as const)('uses the original logistics and QC App for genuine failed-piece rewash on %s',async mode=>{
  const f=h.f,ready=await f.bulkReady('无',undefined,1,undefined,{quantity:4}),id=ready.id;
  const po=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[id])).rows[0].line_id;
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:4,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(h.db),before=await flow.read(f.root,id);
  await flow.dispatch(f.root,id,{expectedRevision:before.revision,supplierId:f.supplierId,note:'TEST rewash App factory'},randomUUID());
  const production=(await flow.read(f.root,id)).productionId!,reporting=new ProductionReportingService(h.db),businessDate=beijingCalendarDate(new Date());
  await reporting.report(f.root,production,{position:1,businessDate,quantity:4},randomUUID());await reporting.execute(f.root,production,'complete',{businessDate,confirmed:true},randomUUID());await reporting.execute(f.root,production,'ship',{businessDate,confirmed:true},randomUUID());
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  await new ReceivingService(h.db,undefined,undefined,new ProductionClosureService(h.db)).create(warehouse,{cuttingOrderId:cut,documentQuantity:4,actualQuantity:4,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const receipt=(await garmentQuality(h.db,id))[0]!;
  await new GarmentQualityService(h.db).record(f.root,id,{receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:4,occurredAt:new Date().toISOString(),problem:''},randomUUID());
  const qc=await r5RoleFixture(h.db,f.access,{...f.root,requestId:randomUUID()},'quality_control'),logistics=f.people['embroidery-washing-merchandiser']!;
  const duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}},db=await h.db.connect();
  try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,id,po,0,{arrangement:{mode,reference:'TEST original frozen batch',revision:1,accounting:'additional',washing:duration,inspection:duration},staff:{logisticsId:logistics.actorId,inspectorId:qc.actor.actorId},fee:{kind:'pending'},sourceRef:'TEST original adopted washing'});await db.query('COMMIT');}finally{db.release();}
  const service=new BulkWashingService(h.db),command=async()=>{const scope=(await service.read(logistics,id)).scopes[0]!;return {planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:new Date().toISOString(),note:'TEST genuine colour defect'};};
  const start=await service.record(logistics,id,{...await command(),kind:mode==='factory'?'factory_start':'send',quantity:4},randomUUID());
  const done=await service.record(logistics,id,{...await command(),...(mode==='factory'?{kind:'factory_complete' as const,startId:start.eventId}:{kind:'return' as const,sendId:start.eventId}),quantity:4},randomUUID());
  const failed=await service.record(qc.actor,id,{...await command(),kind:'inspection',completionId:done.eventId,quantity:4,qualifiedQuantity:3},randomUUID());
  const original=(await service.read(f.root,id)).scopes[0]!,path=`/ui/digital-production?factory=${id}&factoryAction=washing`;
  const tab=await h.open(logistics.actorId,1165,{},path);
  try{
   const panel=tab.page.locator('#factory-washing');await panel.locator('details > summary').first().click();
   await panel.getByLabel('办理',{exact:true}).selectOption('rework');await panel.getByLabel('对应不合格检查',{exact:true}).selectOption(failed.eventId);
   expect(await panel.getByLabel('本次数量',{exact:true}).getAttribute('max')).toBe('1');
   await panel.getByLabel('本次数量',{exact:true}).fill('1');await panel.getByLabel('说明',{exact:true}).fill('TEST 真实色差返洗，不撤销原检查');
   await panel.getByLabel('实际发生时间（北京时间，未知留空）',{exact:true}).fill(currentBeijingInput());
   await panel.getByRole('button',{name:'保存',exact:true}).click();await panel.getByText('返洗发出／开始 1 · 返洗洗回／洗好 0 · 复检合格 0（不增加原收货数量）',{exact:true}).waitFor();
   expect(await panel.getByLabel('办理',{exact:true}).inputValue()).toBe(mode==='factory'?'factory_complete':'return');
   const options=panel.getByLabel('对应记录',{exact:true}).locator('option');expect(await options.count()).toBe(2);expect(await options.nth(1).innerText()).toContain('返洗第1轮');
   await panel.getByLabel('对应记录',{exact:true}).selectOption({index:1});await panel.getByLabel('本次数量',{exact:true}).fill('1');
   await panel.getByLabel('实际发生时间（北京时间，未知留空）',{exact:true}).fill(currentBeijingInput());
   await panel.getByRole('button',{name:'保存',exact:true}).click();await panel.getByText('返洗发出／开始 1 · 返洗洗回／洗好 1 · 复检合格 0（不增加原收货数量）',{exact:true}).waitFor();
   expect(await panel.getByLabel('合格数量',{exact:true}).count()).toBe(0);expect(await panel.getByText(/洗水费用：/).count()).toBe(0);
   await tab.page.screenshot({path:join(h.evidence,`rewash-${mode}-logistics-1165.png`),fullPage:true});
  }finally{await tab.context.close();}
  const inspection=await h.open(qc.actor.actorId,390,{},path);
  try{
   const panel=inspection.page.locator('#factory-washing');await panel.locator('details > summary').first().click();
   expect(await panel.getByLabel('办理',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['inspection']);
   const options=panel.getByLabel('对应记录',{exact:true}).locator('option');expect(await options.count()).toBe(2);expect(await options.nth(1).innerText()).toContain('返洗第1轮');
   await panel.getByLabel('对应记录',{exact:true}).selectOption({index:1});expect(await panel.getByLabel('本次数量',{exact:true}).inputValue()).toBe('1');
   await panel.getByLabel('合格数量',{exact:true}).fill('1');await panel.getByLabel('实际发生时间（北京时间，未知留空）',{exact:true}).fill(currentBeijingInput());await panel.getByRole('button',{name:'保存',exact:true}).click();
   await panel.getByText('送洗 '+(mode==='after_receipt'?'4':'0')+' · 洗回／洗好 4 · 合格 4 · 剩余 0',{exact:true}).waitFor();
   expect(await panel.getByLabel('对应记录',{exact:true}).locator('option').count()).toBe(1);expect(await panel.getByText(/洗水费用：/).count()).toBe(0);
   const actual=(await service.read(f.root,id)).scopes[0]!;expect(actual.ledger).toMatchObject({qualified:4,complete:true,rework:{qualified:1,sent:1,washed:1}});
   expect(actual.facts.find(fact=>fact.id===failed.eventId)).toMatchObject({voided:false,kind:'inspection',qualifiedQuantity:3});
   expect(actual.windows.filter(window=>original.windows.some(prior=>prior.id===window.id))).toEqual(original.windows);
   expect((await garmentQuality(h.db,id))[0]!.quantity).toBe(4);
   await inspection.page.screenshot({path:join(h.evidence,`rewash-${mode}-qc-390.png`),fullPage:true});
  }finally{await inspection.context.close();}
 });
 it('assigned logistics records30 sent and20 returned, then QC releases only20 in the same existing page',async()=>{
  const path=`/ui/digital-production?factory=${orderId}&factoryAction=washing`;
  const {page,context}=await h.open(h.f.people['embroidery-washing-merchandiser']!.actorId,1165,{},path);
  try{
   await page.getByText(/收货批次.*合格 0 \/ 30/).click();
   await page.getByLabel('本次数量',{exact:true}).fill('30');await page.getByRole('button',{name:'保存',exact:true}).click();
   await page.getByText('送洗 30 · 洗回／洗好 0 · 合格 0 · 剩余 30',{exact:true}).waitFor();
   await page.getByLabel('办理',{exact:true}).selectOption('return');await page.getByLabel('对应记录',{exact:true}).selectOption({index:1});
   await page.getByLabel('本次数量',{exact:true}).fill('20');await page.getByRole('button',{name:'保存',exact:true}).click();
   await page.getByText('送洗 30 · 洗回／洗好 20 · 合格 0 · 剩余 30',{exact:true}).waitFor();
   expect(await page.getByText(/洗水费用：/).count()).toBe(0);
   await page.screenshot({path:join(h.evidence,'washing-logistics-1165.png'),fullPage:true});
  }catch(error){await page.screenshot({path:join(h.evidence,'washing-logistics-failure.png'),fullPage:true});throw error;}finally{await context.close();}
  const qc=await h.open(inspector.actor.actorId,1165,{},path);
  try{
   await qc.page.getByText(/收货批次.*合格 0 \/ 30/).click();
   await qc.page.getByLabel('对应记录',{exact:true}).selectOption({index:1});await qc.page.getByLabel('本次数量',{exact:true}).fill('20');await qc.page.getByLabel('合格数量',{exact:true}).fill('20');
   await qc.page.getByRole('button',{name:'保存',exact:true}).click();await qc.page.getByText('送洗 30 · 洗回／洗好 20 · 合格 20 · 剩余 10',{exact:true}).waitFor();
   await qc.page.getByText('洗后检查：时间待核 — 时间待核 · 已完成 · 时间待核',{exact:true}).waitFor();
   expect((await new BulkWashingService(h.db).read(h.f.root,orderId)).scopes[0]!.ledger).toMatchObject({complete:false,qualified:20,remaining:10});
   await qc.page.screenshot({path:join(h.evidence,'washing-qc-1165.png'),fullPage:true});expect(h.errors).toEqual([]);
   await h.f.access.revokeRole({...h.f.root,requestId:randomUUID()},inspector.assignmentId,'TEST same-session washing withdrawal');
   await qc.page.getByRole('button',{name:'刷新洗水记录',exact:true}).click();
   await qc.page.getByRole('alert').waitFor();
   expect(await qc.page.getByText('登记本批洗水',{exact:true}).count()).toBe(0);
   expect(await qc.page.getByText('送洗 30 · 洗回／洗好 20 · 合格 20 · 剩余 10',{exact:true}).count()).toBe(0);
  }catch(error){await qc.page.screenshot({path:join(h.evidence,'washing-qc-failure.png'),fullPage:true});throw error;}finally{await qc.context.close();}
 });
});
