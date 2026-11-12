import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cockpitHomeBrowser,homeReady} from '../acceptance/m01-cockpit-home-native-browser.js';
vi.setConfig({testTimeout:100000,hookTimeout:100000});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('Root deletion in original authenticated App',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 beforeAll(async()=>{h=await cockpitHomeBrowser({databaseUrl:url!,indexed:true,evidence:join(tmpdir(),'whole-delete-browser-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});});
 afterAll(async()=>{await h?.dispose();});
 it('selects, cancels, confirms and updates full count without removing historical facts',async()=>{
  const {context,page}=await h.open(undefined,{},1165);try{
   await page.getByRole('button',{name:'批量删除',exact:true}).click();
   const rows=page.locator('.journey-orders tbody tr'),first=await rows.first().getAttribute('data-order-id');
   await rows.first().getByRole('checkbox').check();
   await page.getByRole('button',{name:'删除所选（1）',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'删除 1 张订单？'});
   await dialog.getByRole('button',{name:'删除这 1 单',exact:true}).waitFor();
   await page.screenshot({path:join(h.evidence,'delete-confirm-1165.png'),fullPage:true});
   await dialog.getByRole('button',{name:'取消',exact:true}).click();
   expect((await h.read(page)).total).toBe(31);
   await page.getByRole('button',{name:'删除所选（1）',exact:true}).click();
   await dialog.getByRole('button',{name:'删除这 1 单',exact:true}).click();
   await dialog.getByRole('button',{name:'完成',exact:true}).click();
   await homeReady(page);await expect.poll(async()=>(await h.read(page)).total).toBe(30);
   expect((await h.fixture.db.query('SELECT 1 FROM digital_production_orders WHERE production_order_id=$1',[first])).rowCount).toBe(1);
   expect(await page.locator(`.journey-orders tbody tr[data-order-id="${first}"]`).count()).toBe(0);
   await page.screenshot({path:join(h.evidence,'delete-result-1165.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('keeps a failed batch item visible and re-previews before retrying it',async()=>{
  const {context,page}=await h.open(undefined,{},1165);try{
   await page.getByRole('button',{name:'批量删除',exact:true}).click();
   const rows=page.locator('.journey-orders tbody tr');
   await rows.nth(0).getByRole('checkbox').check();await rows.nth(1).getByRole('checkbox').check();
   await page.getByRole('button',{name:'删除所选（2）',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'删除 2 张订单？'});
   // A stale preview is sent to the real API; no success/failure response is mocked.
   await page.route('**/digital-production/whole-orders/delete',async route=>{
    const body=route.request().postDataJSON();body.orders[0].revision='0'.repeat(64);
    await route.continue({postData:JSON.stringify(body)});
   },{times:1});
   await dialog.getByRole('button',{name:'删除这 2 单',exact:true}).click();
   await dialog.getByText('订单或关联范围已变化，请重新确认后删除',{exact:false}).waitFor();
   await expect.poll(async()=>(await h.read(page)).total).toBe(29);
   await dialog.getByRole('button',{name:'重新核对关联范围',exact:true}).click();
   await dialog.getByRole('button',{name:'删除这 2 单',exact:true}).click();
   await dialog.getByRole('button',{name:'完成',exact:true}).click();
   await expect.poll(async()=>(await h.read(page)).total).toBe(28);
  }finally{await context.close();}
 });
 it('does not expose Root actions to a real PMC session',async()=>{
  const {context,page}=await h.open(h.pmcId);try{expect(await page.getByRole('button',{name:'批量删除',exact:true}).count()).toBe(0);expect(await page.getByText('删除整单',{exact:true}).count()).toBe(0);}finally{await context.close();}
 });
});
