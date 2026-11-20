import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
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
function observeShellFrames(){
 const frames:Array<{width:number;height:number;layout:string;background:string;backgroundImage:string;underline:string;logout:string}>=[];
 Object.assign(window,{dxShellFrames:frames});
 function frame(){
  const aside=document.querySelector<HTMLElement>('.app-shell>aside');
  const link=aside?.querySelector<HTMLElement>('a[href$="/ui/my-tasks"]:has(svg)');
  const icon=link?.querySelector('svg'),logout=aside?.querySelector('.shell-brand-row button');
  if(aside&&link&&icon&&logout){
   const box=icon.getBoundingClientRect(),style=getComputedStyle(aside);
   if(box.width&&box.height&&style.display!=='none')frames.push({width:box.width,height:box.height,layout:style.display,background:style.backgroundColor,backgroundImage:style.backgroundImage,underline:getComputedStyle(link).textDecorationLine,logout:getComputedStyle(logout).display});
  }
  requestAnimationFrame(frame);
 }
 requestAnimationFrame(frame);
}
const shellFrames=async(page:Page)=>page.evaluate(()=>Reflect.get(window,'dxShellFrames'));
function expectStyledShell(frames:Awaited<ReturnType<typeof shellFrames>>){
 expect(frames.length).toBeGreaterThan(0);
 for(const frame of frames){
  expect(frame).toMatchObject({width:20,height:20,layout:'flex',underline:'none',logout:'flex'});
  expect(frame.background==='rgb(23, 44, 60)'||
   frame.backgroundImage==='linear-gradient(110deg, rgb(17, 31, 54), rgb(21, 37, 62))').toBe(true);
 }
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
   for(const width of [1165,1440]){await page.setViewportSize({width,height:1003});expect(await page.locator('.app-shell>aside').count()).toBe(1);expect(await page.locator('.journey-kpis .dx-production-kpi').count()).toBe(6);expect(await page.locator('.journey-orders tbody tr').count()).toBe(15);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(h.evidence,'production-home-'+width+'.png'),fullPage:true});}
   const resourceEntries=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>{const r=e as PerformanceResourceTiming;return {url:new URL(r.name).pathname,type:r.initiatorType,transfer:r.transferSize,encoded:r.encodedBodySize,duration:r.duration};}));
   await writeFile(join(h.evidence,'first-production-assets.json'),JSON.stringify({source:'Isolated native TEST production build, loopback uncompressed assets; not onsite or production compression equivalence',served:h.resources.slice(start),resourceEntries},null,2));
   await page.locator('.journey-orders tbody tr').first().locator('.journey-order-select').click();await page.locator('[data-view=order][aria-busy=false]').waitFor();expect(await page.locator('.cockpit-stage').count()).toBe(7);
   await page.setViewportSize({width:1165,height:1003});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(h.evidence,'production-detail-1165.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('measures the cockpit pilot at the original viewports and isolates its compiled styles from other modules',async()=>{
  const pilotStyle='style[data-cockpit-style="astryx-v0.7.16"]';
  const astryxAssets=Object.entries(h.assetManifest!).filter(([source])=>/digital-cockpit-page|focusOutline\.stylex|astryxdesign/.test(source)).map(([,entry])=>'/'+entry.file);
  const offRouteStart=h.resources.length;
  const cold=await h.open(undefined,{},1165,1,{height:747,path:'/ui/employee-access'});
  try{
   await cold.page.locator('.app-shell>aside').waitFor();
   await cold.page.waitForLoadState('networkidle');
   expect(await cold.page.locator(pilotStyle).count()).toBe(0);
   expect(h.resources.slice(offRouteStart).some(resource=>astryxAssets.includes(resource.path))).toBe(false);
   expect(h.resources.slice(offRouteStart).some(resource=>resource.path===asset('employee-access-page.tsx'))).toBe(true);
  }finally{await cold.context.close();}

  const baseline=process.env.COCKPIT_PILOT_BASELINE_ASSETS;
  const observed:unknown[]=[];
  for(const [width,height] of [[1165,747],[1440,900],[1280,800],[390,844],[360,800]] as const){
   const inspect=async(enabled:boolean)=>{
    const start=h.resources.length,transferred=new Map<string,number>();
    const {context,page}=await h.open(undefined,enabled||baseline?{}:{cockpitAstryx:'off'},width,1,{
     height,
     ...(!enabled&&baseline?{beforeNavigate:async(tab:Page)=>{
      await tab.route(url=>url.pathname.startsWith('/assets/')||url.pathname==='/ui/digital-cockpit',async route=>{
       const path=new URL(route.request().url()).pathname;
       if(path==='/ui/digital-cockpit'){await route.fulfill({path:join(baseline,'index.html'),contentType:'text/html'});return;}
       const file=join(baseline,path);
       transferred.set(path,(await stat(file)).size);
       await route.fulfill({path:file});
      });
     }}:{})
    });
    const readyMs=await page.evaluate(()=>performance.now());
    try{
     expect(await page.locator(pilotStyle).count()).toBe(enabled?1:0);
     const sections=['.cockpit-detail-identity','.cockpit-flow-panel','.journey-current-panel','.journey-risk-panel','.journey-node-panel','.journey-documents-panel','.journey-activity-panel'];
     const home=await page.evaluate(()=>{
      const table=document.querySelector('.journey-orders table')!;
      const button=document.querySelector<HTMLButtonElement>('.journey-filter-actions button[type=submit]')!;
      const bounds=button.getBoundingClientRect(),css=getComputedStyle(button);
      const rows=[...table.querySelectorAll('tbody tr')];
      return {visibleRows:rows.filter(row=>{const box=row.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;}).length,orderIds:rows.map(row=>row.getAttribute('data-order-id')),viewportOverflow:document.documentElement.scrollWidth>innerWidth+1,button:{height:bounds.height,width:bounds.width,fontSize:css.fontSize,background:css.backgroundColor,class:button.className},overflow:table.clientWidth>innerWidth};
     });
     const moduleAssets=transferred.size?[...transferred].map(([path,bytes])=>({path,bytes})):h.resources.slice(start);
     const resources=await page.evaluate(()=>performance.getEntriesByType('resource').map(entry=>{const resource=entry as PerformanceResourceTiming;return {path:new URL(resource.name).pathname,bytes:resource.encodedBodySize,ms:resource.duration};}));
     await page.screenshot({path:join(h.evidence,`pilot-${enabled?'new':'old'}-home-${width}x${height}.png`)});
     if(enabled){
      expect(home.button.class.includes('dx-cockpit-astryx-button')).toBe(width>=380);
      const scoped=await page.locator(pilotStyle).evaluate((element:HTMLStyleElement)=>[...element.sheet!.cssRules].map(rule=>rule.constructor.name));
      expect(scoped).toEqual(['CSSScopeRule']);
      const dates=await page.locator('.cockpit-home-delivery-date').first().locator('time').allTextContents();
      expect(dates).toEqual([...new Set(dates)]);expect(dates.every(date=>/^\d{4}-\d{2}-\d{2}$/.test(date))).toBe(true);
     }
     const clickStart=performance.now();
     await page.locator('.journey-order-select').first().click();
     await page.locator('[data-view=order][aria-busy=false]').waitFor();
     const detailMs=performance.now()-clickStart;
     const detail=await page.evaluate((selectors)=>Object.fromEntries(selectors.map(selector=>{
      const element=document.querySelector(selector)!;
      const box=element.getBoundingClientRect();
      return [selector,{width:box.width,height:box.height,left:box.left,top:box.top}];
     })),sections);
     expect(await page.locator('.cockpit-identity-facts>div').count()).toBe(6);
     expect(await page.locator('.cockpit-current-additional[open]').count()).toBe(enabled||!baseline?1:0);
     const detailWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
     await page.screenshot({path:join(h.evidence,`pilot-${enabled?'new':'old'}-detail-${width}x${height}.png`)});
     expect(detailWidth,`${enabled?'Astryx':'DX'} detail at ${width}×${height}`).toBeLessThanOrEqual(width+1);
     const scopedCss=enabled?await page.locator(pilotStyle).textContent():null;
     return {home,detail,detailMs,readyMs,resources,moduleAssets,scopedCss:scopedCss?{raw:Buffer.byteLength(scopedCss),gzip:gzipSync(scopedCss).length}:null};
    }finally{await context.close();}
   };
   const old=await inspect(false),pilot=await inspect(true);
   console.log('COCKPIT_PILOT '+JSON.stringify({width,height,oldRows:old.home.visibleRows,newRows:pilot.home.visibleRows,oldReadyMs:old.readyMs,newReadyMs:pilot.readyMs,oldDetailMs:old.detailMs,newDetailMs:pilot.detailMs,oldButtonWidth:old.home.button.width,newButtonWidth:pilot.home.button.width,oldHomeBytes:old.moduleAssets.reduce((total,asset)=>total+asset.bytes,0),newHomeBytes:pilot.moduleAssets.reduce((total,asset)=>total+asset.bytes,0)}));
   expect(pilot.home.orderIds).toEqual(old.home.orderIds);
   expect(pilot.home.viewportOverflow).toBe(false);
   expect(pilot.home.visibleRows).toBeGreaterThanOrEqual(old.home.visibleRows);
   expect(pilot.home.button.height).toBeGreaterThanOrEqual(old.home.button.height);
   expect(pilot.home.button.width+1).toBeGreaterThanOrEqual(old.home.button.width);
   expect(Number.parseFloat(pilot.home.button.fontSize)).toBeGreaterThanOrEqual(Number.parseFloat(old.home.button.fontSize));
   observed.push({width,height,old,pilot});
  }
  await writeFile(join(h.evidence,'cockpit-astryx-comparison.json'),JSON.stringify({baseline:baseline?'Separate frozen frontend, same TEST data and application API':'DX component fallback in the same build',observed},null,2));
 });
 it('keeps the original access gate ahead of an unauthorized module import',async()=>{
  const {context,page}=await h.open(h.pmcId);try{
   const start=h.resources.length;await page.goto(h.base+'/ui/employee-access');await page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();
   expect(h.resources.slice(start).some(r=>r.path===asset('employee-access-page.tsx'))).toBe(false);
   expect((await page.request.get(h.base+'/api/auth/me')).status()).toBe(200);
  }finally{await context.close();}
 });
 it('suppresses all unstyled shell frames when built entry CSS is slow or returns 404',async()=>{
  const {context,page:original}=await h.open();
  try{
   const response=await original.request.get(h.base+'/ui/digital-cockpit?workspace=settings');
   expect(response.ok()).toBe(true);
   const entry=await original.evaluate(markup=>[...new DOMParser().parseFromString(markup,'text/html').querySelectorAll('link[rel="stylesheet"]')]
    .map(link=>new URL(link.getAttribute('href')!,location.origin).pathname),await response.text());
   expect(entry.length).toBeGreaterThan(0);
   for(const fails of [false,true]){
    const page=await context.newPage();
    const requests=new Map<string,number>();
    await page.addInitScript(observeShellFrames);
    await page.route('**/assets/*.css',async route=>{
     const path=new URL(route.request().url()).pathname;
     if(!entry.includes(path))return route.continue();
     requests.set(path,(requests.get(path)??0)+1);
     await new Promise(resolve=>setTimeout(resolve,550));
     if(fails)await route.fulfill({status:404,contentType:'text/css',body:''});
     else await route.continue();
    });
    try{
     await page.goto(h.base+'/ui/digital-cockpit?workspace=settings');
     if(fails){
      const fallback=page.getByRole('alert').filter({hasText:'页面样式暂时未能加载'});
      await fallback.waitFor();
      expect(await fallback.getByRole('button',{name:'刷新页面'}).count()).toBe(1);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      expect(await page.locator('.app-shell').count()).toBe(0);
      expect(await shellFrames(page)).toEqual([]);
     }else{
      await page.getByRole('tab',{name:'时效设置',exact:true}).waitFor();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      expectStyledShell(await shellFrames(page));
     }
     expect([...requests.keys()].sort()).toEqual([...entry].sort());
     expect([...requests.values()]).toEqual(entry.map(()=>1));
     await page.screenshot({path:join(h.evidence,fails?'shell-entry-404.png':'shell-entry-slow.png')});
    }finally{await page.close();}
   }
  }finally{await context.close();}
 });
 it('keeps the already styled shell and its original entry sheets throughout a settings CSS failure',async()=>{
  const {context,page}=await h.open();
  try{
   await page.evaluate(observeShellFrames);
   const stylesheetEntry=Object.entries(h.assetManifest!).find(([id])=>id.endsWith('/cockpit-production-settings.tsx'))?.[1];
   const settingsCss=stylesheetEntry?.css?.find(name=>name.includes('cockpit-production-settings-'));
   expect(settingsCss).toBeTruthy();
   const sheets=await page.evaluateHandle(()=>[...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link=>[link,link.sheet]));
   let attempts=0;
   await page.route('**/'+settingsCss,async route=>{attempts++;await route.fulfill({status:404,contentType:'text/css',body:''});});
   await page.getByRole('link',{name:'生产管理设置',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'页面暂时未能打开'}).waitFor();
   await openCockpitNavigation(page);
   expect(await page.evaluate(found=>found.every(([link,sheet])=>(link as HTMLLinkElement).isConnected&&(link as HTMLLinkElement).sheet===sheet),sheets)).toBe(true);
   expectStyledShell(await shellFrames(page));
   expect(attempts).toBe(1);
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
   await page.goBack();await homeReady(page);expect(page.url()).toBe(originalUrl);expect(await page.locator('.journey-kpis .dx-production-kpi').count()).toBe(6);expect(await layout()).toEqual(before);
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
