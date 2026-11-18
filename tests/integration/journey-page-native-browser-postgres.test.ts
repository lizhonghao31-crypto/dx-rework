import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {cockpitHomeBrowser,homeReady} from '../acceptance/m01-cockpit-home-native-browser.js';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const scale=process.env.DX_JOURNEY_SCALE==='5000'?5000:process.env.DX_JOURNEY_SCALE==='1000'?1000:31;
if(process.env.DX_JOURNEY_SCALE&&!['1000','5000'].includes(process.env.DX_JOURNEY_SCALE))throw Error('Only explicitly bounded owned TEST scales are supported');
(url?describe.sequential:describe.skip)('PERF03 original full application with indexed page reads and real signed PostgreSQL identity',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 beforeAll(async()=>{h=await cockpitHomeBrowser({databaseUrl:url!,indexed:true,mixedNative:true,orderCount:scale,evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),'journey-page-'+scale+'-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});if(scale>31||process.env.DX_JOURNEY_SCALE_SMOKE==='1')await h.measureScale();},scale===5000?1200000:scale===1000?600000:testExecutionConfig.correctnessTimeoutMs);
 afterAll(async()=>{await h?.dispose();});
 it('renders current15 rows, preserves complete global totals across pages and opens the native detail',async()=>{
  const {context,page}=await h.open();try{
   const first=await h.read(page);expect(first.total).toBe(scale);expect(first.items).toHaveLength(15);expect(first.freshness).toBeUndefined();
   if(scale>31){const timing=await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation').map(entry=>entry.toJSON()),resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/api/digital-production/journeys')).map(entry=>entry.toJSON())}));await writeFile(join(h.evidence,'scale-browser-navigation.json'),JSON.stringify({fixtureOrders:scale,context:'Original complete-App IIFE fixture on owned loopback TEST; not production bundles or onsite latency',...timing},null,2)+'\n');}
   const next=page.getByRole('button',{name:'下一页',exact:true});
   // Native notifications remain enabled. Acknowledge an actually displayed
   // notice if it covers the footer; never force a click through the product UI.
   for(let attempt=0;attempt<8;attempt++){
    try{await next.click({timeout:1500});break;}
    catch(error){const notice=page.locator('[aria-label="站内提醒"]');if(!await notice.isVisible()||attempt===7)throw error;await notice.getByRole('button',{name:'我知道了',exact:true}).click();}
   }
   await homeReady(page);expect(new URL(page.url()).searchParams.get('page')).toBe('2');const second=await h.read(page,{page:'2'});
   expect(second.total).toBe(scale);expect(second.summary).toEqual(first.summary);expect(second.items).toHaveLength(15);expect(second.items.every(item=>!first.items.some(value=>value.id===item.id))).toBe(true);
   await expect.poll(()=>page.locator('.journey-orders tbody tr').evaluateAll(rows=>rows.map(row=>(row as HTMLElement).dataset.orderId)),{timeout:12000}).toEqual(second.items.map(item=>item.id));
   await page.locator('.journey-orders tbody tr').first().locator('.journey-order-select').click();await page.locator('[data-view=order][aria-busy=false]').waitFor();expect(await page.locator('.cockpit-stage').count()).toBe(7);
  }finally{await context.close();}
 });
 it('keeps the signed no-scope search usable when an unrelated order projection fails',async()=>{
  const {context,page}=await h.open();
  const prototype=DigitalJourneyQuery.prototype as unknown as {project(...args:unknown[]):Promise<OrderJourney|null>};
  const original=prototype.project,excluded=h.orders[0]!,matched=h.orders[1]!,visits:string[]=[];
  const spy=vi.spyOn(prototype,'project').mockImplementation(async function(this:unknown,...args:unknown[]){
   const row=args[2] as {order?:{production_order_id:string}};
   if(row.order){visits.push(row.order.production_order_id);if(row.order.production_order_id===excluded)throw Error('TEST excluded order projection failed');}
   return original.apply(this,args);
  });
  try{
   const path=h.base+'/api/digital-production/journeys?';
   const response=await page.request.get(path+new URLSearchParams({search:matched,page:'1'}));
   expect(response.status(),await response.text()).toBe(200);
   expect(await response.json()).toMatchObject({total:1,items:[{orderId:matched}]});
   expect(new Set(visits)).toEqual(new Set([matched]));
   expect((await page.request.get(path+new URLSearchParams({search:excluded,page:'1'}))).status()).toBe(500);
  }finally{spy.mockRestore();await context.close();}
 });
 it('keeps available orders usable while a real derived-object failure hides uncertain totals, pagination and false empty states',async()=>{
  const {context,page}=await h.open();const target=h.orders[0]!,search=(await h.fixture.db.query<{po_number:string}>('SELECT po_number FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position LIMIT 1',[target])).rows[0]!.po_number;try{
   await h.corruptProjection(target);await page.getByRole('button',{name:'刷新数据',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'1 单信息更新失败'}).waitFor();
   expect(await page.locator('.journey-orders tbody tr').count()).toBe(15);
   expect(await page.locator('.journey-kpis').innerText()).toContain('—');expect(await page.getByRole('navigation',{name:'分页',exact:true}).count()).toBe(0);
   expect(await page.getByText('当前授权和筛选范围没有订单。',{exact:true}).count()).toBe(0);
   await page.goto(h.base+h.path({search:'TEST-R3-HOME-01'}));await page.getByRole('alert').filter({hasText:'1 单信息更新失败'}).waitFor();
   const overlapping=await h.read(page,{search:'TEST-R3-HOME-01'});expect(overlapping.items.length).toBeGreaterThan(0);expect(overlapping.items.every(item=>item.orderId!==target)).toBe(true);
   await expect.poll(()=>page.locator('.journey-orders tbody tr').evaluateAll(rows=>rows.map(row=>(row as HTMLElement).dataset.orderId))).toEqual(overlapping.items.map(item=>item.id));
   // The original style keyword is a substring, so a healthy shared-prefix
   // mother must remain visible. Only this actual PO uniquely selects the
   // failed object and can independently prove the empty-but-uncertain state.
   await page.goto(h.base+h.path({search}));await page.getByRole('alert').filter({hasText:'1 单信息更新失败'}).waitFor();
   expect(await page.locator('.journey-orders tbody tr').count()).toBe(0);expect(await page.getByText('当前授权和筛选范围没有订单。',{exact:true}).count()).toBe(0);
   await page.getByRole('button',{name:'重试更新失败订单',exact:true}).click();
   await expect.poll(async()=>(await h.read(page,{search})).total,{timeout:12000}).toBe(1);
   await page.getByRole('button',{name:'刷新数据',exact:true}).click();await homeReady(page);expect((await h.read(page,{search})).total).toBe(1);
  }finally{await h.repairProjection(target);await context.close();}
 });
 it('keeps reliable global KPI, true second page and pagination when one selected display read fails',async()=>{
  const {context,page}=await h.open(),prototype=DigitalJourneyQuery.prototype as unknown as {project(...args:unknown[]):Promise<OrderJourney|null>},original=prototype.project;
  let spy:ReturnType<typeof vi.spyOn>|undefined;
  try{
   await page.goto(h.base+h.path({page:'2'}));await homeReady(page);const before=await h.read(page,{page:'2'}),target=before.items[0]!.orderId!;
   spy=vi.spyOn(prototype,'project').mockImplementation(async function(this:unknown,...args:unknown[]){const row=args[2] as {order?:{production_order_id:string}};if(row.order?.production_order_id===target)throw Error('TEST selected display dependency failed');return original.apply(this,args);});
   await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.getByRole('alert').filter({hasText:'1 单详情暂未读到'}).waitFor();
   const after=await h.read(page,{page:'2'});expect(after.page).toBe(2);expect(after.total).toBe(scale);expect(after.summary).toEqual(before.summary);expect(after.freshness).toMatchObject({failed:1,detailsOnly:true});
   expect(after.items.map(item=>item.id)).toEqual(before.items.filter(item=>item.orderId!==target).map(item=>item.id));
   expect(await page.locator('.journey-orders tbody tr').count()).toBe(14);expect(await page.getByRole('navigation',{name:'分页',exact:true}).count()).toBe(1);expect(await page.locator('.journey-kpis').innerText()).not.toContain('—');
  }finally{spy?.mockRestore();await context.close();}
 });
 it('rechecks the real same valid PMC session after native revocation instead of trusting a cached manager projection',async()=>{
  const {context,page}=await h.open(h.pmcId);try{
   expect((await h.read(page)).total).toBe(scale);await h.revokePmc();
   const me=await page.request.get(h.base+'/api/auth/me');expect(me.status()).toBe(200);
   const response=await page.request.get(h.base+'/api/digital-production/journeys?scope=production');expect([403,404]).toContain(response.status());
   const retry=await page.request.post(h.base+`/api/digital-production/journeys/${h.orders[0]}/refresh`);expect([403,404]).toContain(retry.status());
   await page.reload();await page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();expect(await page.locator('.journey-orders tbody tr').count()).toBe(0);
  }finally{await context.close();}
 });
});
