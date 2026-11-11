import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Page} from 'playwright-core';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {cockpitHomeBrowser,homeReady} from '../acceptance/m01-cockpit-home-native-browser.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
async function openCockpitNavigation(page:Page,afterNavigate=()=>{}){
 const link=page.locator('aside a[href$="/ui/digital-cockpit"]').first();
 const groups=link.locator('xpath=ancestor::details');
 for(const group of await groups.all())if(!await group.evaluate(node=>(node as HTMLDetailsElement).open))await group.locator(':scope > summary').click();
 await link.waitFor();await link.click();afterNavigate();await homeReady(page);
}
(url?describe.sequential:describe.skip)('PERF04 real production module graph with original signed PostgreSQL identity',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 const asset=(name:string)=>{const file=Object.entries(h.assetManifest!).find(([id])=>id.endsWith('/'+name))?.[1].file;expect(file,'dynamic production asset for '+name).toBeTruthy();return '/'+file!;};
 beforeAll(async()=>{h=await cockpitHomeBrowser({databaseUrl:url!,productionAssets:true,indexed:true,calendar:true,evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),'module-bundles-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});});
 afterAll(async()=>{await h?.dispose();});
 it('opens the real complete App with only the needed page graph and preserves approved home layout across widths',async()=>{
  const start=h.resources.length,{context,page}=await h.open(undefined,{},1440);try{
   const loaded=new Set(h.resources.slice(start).map(r=>r.path));expect(loaded.has(asset('digital-cockpit-page.tsx'))).toBe(true);
   for(const name of ['rework-detail-page.tsx','sourcing-workspace-page.tsx','wages/wage-page.tsx','admin-console-page.tsx','cockpit-production-settings.tsx','delivery-calendar-page.tsx','acceptance-lab-page.tsx'])expect(loaded.has(asset(name))).toBe(false);
   for(const width of [1165,1440]){await page.setViewportSize({width,height:1003});expect(await page.locator('.app-shell>aside').count()).toBe(1);expect(await page.locator('.journey-kpis button').count()).toBe(7);expect(await page.locator('.journey-orders tbody tr').count()).toBe(15);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(h.evidence,'production-home-'+width+'.png'),fullPage:true});}
   const resourceEntries=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>{const r=e as PerformanceResourceTiming;return {url:new URL(r.name).pathname,type:r.initiatorType,transfer:r.transferSize,encoded:r.encodedBodySize,duration:r.duration};}));
   await writeFile(join(h.evidence,'first-production-assets.json'),JSON.stringify({source:'Isolated native TEST production build, loopback uncompressed assets; not onsite or production compression equivalence',served:h.resources.slice(start),resourceEntries},null,2));
   await page.locator('.journey-orders tbody tr').first().locator('.journey-order-select').click();await page.locator('[data-view=order][aria-busy=false]').waitFor();expect(await page.locator('.cockpit-stage').count()).toBe(7);
   await page.setViewportSize({width:1165,height:1003});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(h.evidence,'production-detail-1165.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('keeps the original access gate ahead of an unauthorized module import',async()=>{
  const {context,page}=await h.open(h.pmcId);try{
   const start=h.resources.length;await page.goto(h.base+'/ui/employee-access');await page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();
   expect(h.resources.slice(start).some(r=>r.path===asset('employee-access-page.tsx'))).toBe(false);
   expect((await page.request.get(h.base+'/api/auth/me')).status()).toBe(200);
  }finally{await context.close();}
 });
 it('loads settings on demand and preserves an unsaved edit across the original parent navigation render',async()=>{
  const {context,page}=await h.open();try{
   const layout=()=>page.locator('.journey-kpis,.journey-orders thead,.journey-orders tbody tr:first-child').evaluateAll(elements=>elements.map(el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el);return {width:box.width,height:box.height,font:style.font,fontSize:style.fontSize};}));
   const before=await layout(),originalUrl=page.url(),start=h.resources.length;await page.getByRole('link',{name:'生产管理设置',exact:true}).click();await page.getByRole('tab',{name:'时效设置',exact:true}).waitFor();
   expect(h.resources.slice(start).some(r=>r.path===asset('cockpit-production-settings.tsx'))).toBe(true);
   await page.locator('.r5-node-name').getByText('开发纸样',{exact:true}).click();
   const input=page.getByLabel('开发纸样用时',{exact:true}),next=String(Number(await input.inputValue())+1);await input.fill(next);
   await page.evaluate(()=>{history.replaceState(null,'',location.pathname+location.search+'#TEST-preserve-unsaved');dispatchEvent(new PopStateEvent('popstate'));});
   expect(await input.inputValue()).toBe(next);expect(await page.getByRole('region',{name:'开发纸样设置',exact:true}).count()).toBe(1);
   await page.getByRole('region',{name:'开发纸样设置',exact:true}).getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('region',{name:'开发纸样设置',exact:true}).waitFor({state:'detached'});
   await page.goBack();await homeReady(page);expect(page.url()).toBe(originalUrl);expect(await page.locator('.journey-kpis button').count()).toBe(7);expect(await layout()).toEqual(before);
   await page.screenshot({path:join(h.evidence,'production-home-after-settings.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('contains a real missing dynamic resource inside the Shell and offers explicit recovery without automatic reload',async()=>{
  const {context,page}=await h.open();try{
   const target=asset('delivery-calendar-page.tsx');let attempts=0;await page.route('**'+target,async route=>{attempts++;await route.abort('failed');});
   await page.getByRole('link',{name:'交付点阵图',exact:true}).click();const error=page.getByRole('alert').filter({hasText:'页面暂时未能打开'});await error.waitFor();expect(attempts).toBe(1);expect(await page.locator('.app-shell>aside').count()).toBe(1);
   await page.unroute('**'+target);expect(await error.getByRole('button',{name:'重新打开',exact:true}).count()).toBe(0);await error.getByRole('button',{name:'刷新页面',exact:true}).click();await page.locator('.delivery-calendar[aria-busy=false]').waitFor();
   expect(await page.getByRole('alert').filter({hasText:'页面暂时未能打开'}).count()).toBe(0);expect((await page.request.get(h.base+'/api/auth/me')).status()).toBe(200);await page.screenshot({path:join(h.evidence,'production-module-recovered.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('retains original authorized navigation when sourcing, rework or personnel modules own their Shell and fail to download',async()=>{
  for(const [name,path]of [['sourcing-workspace-page.tsx','/ui/sourcing/pending'],['rework-detail-page.tsx','/ui/tasks/'+h.orders[0]!],['employee-access-page.tsx','/ui/employee-access']]){
   const {context,page}=await h.open();try{
    const target=asset(name!);let attempts=0;await page.route('**'+target,async route=>{attempts++;await route.abort('failed');});
    await page.goto(h.base+path);const error=page.getByRole('alert').filter({hasText:'页面暂时未能打开'});await error.waitFor();
    expect(attempts).toBe(1);expect(await page.locator('.app-shell>aside').count()).toBe(1);
    await openCockpitNavigation(page);
    expect(await page.locator('.app-shell>aside').count()).toBe(1);expect(await error.count()).toBe(0);
    expect((await page.request.get(h.base+'/api/auth/me')).status()).toBe(200);
   }finally{await context.close();}
  }
 });
 it('keeps original navigation usable while a self-shell page download is still pending',async()=>{
  const {context,page}=await h.open();let release=()=>{};
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  try{
   const target=asset('employee-access-page.tsx');let attempts=0;
   await page.route('**'+target,async route=>{attempts++;await waiting;await route.abort('failed');});
   await page.goto(h.base+'/ui/employee-access',{waitUntil:'domcontentloaded'});
   await page.getByRole('status').filter({hasText:'正在打开页面…'}).waitFor();
   expect(attempts).toBe(1);expect(await page.locator('.app-shell>aside').count()).toBe(1);
   await openCockpitNavigation(page,release);
   expect(await page.locator('.app-shell>aside').count()).toBe(1);expect((await page.request.get(h.base+'/api/auth/me')).status()).toBe(200);
  }finally{release();await context.close();}
 });
});
