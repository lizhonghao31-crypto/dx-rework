import {join} from 'node:path';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {failedFrameworkWashingFixture,prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original authenticated App manager rewash plan and assigned logistics',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{
  h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-rewash-app-evidence-')),{fullApp:true,orderTimeFlow:true});
  await prepareRewashSettings(h.f);
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it.each([['after_receipt',1165],['factory',390]] as const)('arranges independent %s P through the original page before logistics at width %s',async(mode,width)=>{
  const {scene,orderId,inspectionId,washing,repo,resource}=await failedFrameworkWashingFixture(h.f,mode);
  const before=await h.f.runtime.run(scene,h.f.root,()=>repo.current(resource()));
  const manager=await h.open(h.f.root.actorId,width,{},'/ui/digital-production?timeOrder='+orderId);
  let intentId='';
  try{
   const page=manager.page;await page.getByRole('heading',{name:'本单时效调整',exact:false}).waitFor();
   await page.getByText('新增返洗计划',{exact:true}).click();
   const fields=page.locator('.r5-time-washing').filter({has:page.getByText('新增返洗计划',{exact:true})});
   await fields.getByLabel('安排本次返洗',{exact:true}).check();
   const quantity=fields.getByLabel('本次计划数量',{exact:true});
   await quantity.fill('2');await page.getByRole('alert').filter({hasText:'有效的本轮返洗计划数量'}).waitFor();
   expect(await page.getByRole('button',{name:'提交',exact:true}).isDisabled()).toBe(true);
   const preview=page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.request().method()==='POST');
   await quantity.fill('1');expect((await preview).status()).toBe(200);
   await expect.poll(()=>page.getByRole('button',{name:'提交',exact:true}).isEnabled()).toBe(true);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:join(h.evidence,`rewash-arrange-${mode}-${width}.png`),fullPage:true});
   const arranged=page.waitForResponse(response=>response.url().endsWith('/order-time/arrange')&&response.request().method()==='POST');
   await page.getByRole('button',{name:'提交',exact:true}).scrollIntoViewIfNeeded();
   await page.getByRole('button',{name:'提交',exact:true}).click();
   const response=await arranged;expect(response.status()).toBe(200);
   await page.getByText('本单新安排已生效。',{exact:true}).waitFor();
   const saved=await h.f.runtime.run(scene,h.f.root,()=>repo.current(resource()));
   expect(saved!.revision).toBe(before!.revision+1);expect(saved!.input.rewashing).toHaveLength(1);
   const row=saved!.input.rewashing![0]!;intentId=row.intentId;expect(row.inspectionId).toBe(inspectionId);
   expect(h.requests.filter(call=>call.session===manager.session&&call.method==='POST'&&call.path.endsWith('/order-time/arrange'))).toHaveLength(1);
  }catch(error){await writeFile(join(h.evidence,`manager-failure-${mode}.txt`),await manager.page.locator('body').innerText());await manager.page.screenshot({path:join(h.evidence,`manager-failure-${mode}.png`),fullPage:true});throw error;}finally{await manager.context.close();}
  await h.f.advance(scene,'2026-11-17T08:10:00.000Z');
  const logistics=await h.open(h.f.people['embroidery-washing-merchandiser']!.actorId,width,{},`/ui/digital-production?factory=${orderId}&factoryAction=washing`);
  try{
   const page=logistics.page,panel=page.locator('#factory-washing');
   await panel.locator('details > summary').first().waitFor();await panel.locator('details > summary').first().click();
   await panel.getByLabel('办理',{exact:true}).selectOption('rework');
   await panel.getByLabel('对应不合格检查',{exact:true}).selectOption(inspectionId);
   await panel.getByLabel('本轮正式计划',{exact:true}).selectOption(intentId);
   await panel.getByLabel('本次数量',{exact:true}).fill('1');
   await panel.getByLabel('实际发生时间（北京时间，未知留空）',{exact:true}).fill('2026-11-17T16:10');
   const started=page.waitForResponse(response=>response.url().endsWith(`/orders/${orderId}/bulk-washing`)&&response.request().method()==='POST');
   await panel.getByRole('button',{name:'保存',exact:true}).click();expect((await started).status()).toBe(200);
   await expect.poll(()=>panel.getByText(/返洗发出／开始 1/).count()).toBe(1);
   const scope=(await h.f.runtime.run(scene,h.f.root,()=>washing.read(h.f.root,orderId))).scopes[0]!;
   const start=scope.facts.find(fact=>(fact.kind==='send'||fact.kind==='factory_start')&&fact.rewashWorkId===intentId)!;
   expect(start).toMatchObject({kind:mode==='factory'?'factory_start':'send',reworkOfInspectionId:inspectionId,quantity:1});
   expect(scope.windows.find(window=>window.id===start.id)).toMatchObject({startedAt:'2026-11-17T08:10:00.000Z',dueAt:'2026-11-17T09:10:00.000Z'});
   expect(scope.facts.find(fact=>fact.id===inspectionId)).toMatchObject({qualifiedQuantity:1,voided:false});
   expect(await panel.getByText(/洗水费用：/).count()).toBe(0);
   expect(h.requests.filter(call=>call.session===logistics.session&&call.method==='POST'&&call.path.endsWith('/bulk-washing'))).toHaveLength(1);
   expect(h.errors).toEqual([]);
   await page.screenshot({path:join(h.evidence,`rewash-logistics-${mode}-${width}.png`),fullPage:true});
  }finally{await logistics.context.close();}
 });
});
