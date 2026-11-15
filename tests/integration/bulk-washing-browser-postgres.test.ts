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
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
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
