import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {cockpitHomeBrowser} from '../acceptance/m01-cockpit-home-native-browser.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

const database=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(database?describe:describe.skip)('real production-dashboard foreground request ownership',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 let staged:[string,string,string];
 beforeAll(async()=>{
  h=await cockpitHomeBrowser({databaseUrl:database!,productionAssets:true,fixtureProfile:'navigation',
   evidence:await mkdtemp(join(tmpdir(),'dx-dashboard-wait-')),
   ...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});
  const f=h.fixture,flow=new FactoryFlowService(f.db);
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  staged=await h.runInScene(async()=>{
   const numbers:string[]=[];
   for(const key of ['A','B','C']){
    const ready=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:2,stylePrefix:'TEST-WAIT-'+key+'-'});
    const cutting=(await f.db.query<{cutting_order_id:string}>('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0]!;
    await ready.cutting.record(cutter,cutting.cutting_order_id,{pieceCount:1,actualCutCount:2,attachmentIds:[await f.image(cutter)]},randomUUID());
    await f.contracts.generateIfReady(f.root,ready.caseId);
    const state=await flow.read(f.root,ready.id);
    await flow.dispatch(f.root,ready.id,{expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST dashboard foreground query fixtures'},randomUUID());
    numbers.push(ready.input.lineItems[0]!.styleNo);
   }
   return numbers as [string,string,string];
  });
 },testExecutionConfig.correctnessTimeoutMs);
 afterAll(async()=>{await h?.dispose();});

 it('retains A while B and C are pending, accepts only C, and clears failed foreground waits',async()=>{
  const [a,b,c]=staged;
  const {page,context}=await h.open(h.fixture.root.actorId,{},1440,1,{path:'/ui/production-dashboard'});
  const rows=page.locator('.board-row .board-identity strong');
  const filter=page.getByPlaceholder('款号或供应商');
  const wait=page.locator('.dx-foreground-loading').getByText('请稍等',{exact:true});
  const held=new Map<string,ReturnType<typeof Promise.withResolvers<void>>>();
  const received=new Map<string,ReturnType<typeof Promise.withResolvers<void>>>();
  const fail='TEST-WAIT-FAILURE';
  for(const key of [b,c,fail]){
   held.set(key,Promise.withResolvers<void>());
   received.set(key,Promise.withResolvers<void>());
  }
  const released=new Set<string>();
  const delivered=Promise.withResolvers<void>();
  try{
   await page.route('**/api/production-dashboard?*',async route=>{
    const query=new URL(route.request().url()).searchParams.get('q')??'';
    const gate=held.get(query);
    if(!gate||released.has(query))return route.continue();
    released.add(query);
    if(query===fail){
     received.get(query)!.resolve();
     await gate.promise;
     return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'TEST 看板暂不可用'})});
    }
    const response=await route.fetch();
    try{
     expect(response.status()).toBe(200);
     const body=await response.json();
     expect(body.items.map((item:{order:{firstStyleNo:string}})=>item.order.firstStyleNo)).toEqual([query]);
     received.get(query)!.resolve();
     await gate.promise;
     await route.fulfill({response});
     if(query===b)delivered.resolve();
    }finally{await response.dispose();}
   });
   const firstRead=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/production-dashboard'&&url.searchParams.get('q')===a;
   });
   await filter.fill(a);
   const first=await firstRead;
   expect(first.status()).toBe(200);
   expect((await first.json()).items.map((item:{order:{firstStyleNo:string}})=>item.order.firstStyleNo)).toEqual([a]);
   await rows.filter({hasText:b}).waitFor({state:'detached'});
   await rows.filter({hasText:c}).waitFor({state:'detached'});
   await rows.filter({hasText:a}).waitFor();
   expect(await rows.allTextContents()).toEqual([a]);
   await wait.waitFor({state:'hidden'});
   await page.evaluate(target=>{
    const fetchOriginal=window.fetch.bind(window);
    window.fetch=(input,init)=>{
     const url=new URL(input instanceof Request?input.url:input,location.href);
     if(url.pathname==='/api/production-dashboard'&&url.searchParams.get('q')===target){
      // Exercise the generation guard even when an obsolete transport has a result.
      return fetchOriginal(input,{...init,signal:null}).then(response=>{
       document.body.dataset.dashboardLateResponse=String(response.status);
       return response;
      });
     }
     return fetchOriginal(input,init);
    };
   },b);
   await filter.fill(b);
   await received.get(b)!.promise;
   await wait.waitFor();
   expect(await rows.allTextContents()).toEqual([a]);
   await page.evaluate(({next}: {next:string})=>{
    const neverClearBeforeRows=()=>{
     const status=document.querySelector('.dx-foreground-loading')?.textContent;
     const rows=Array.from(document.querySelectorAll('.board-row .board-identity strong'));
     if(!rows.some(row=>row.textContent===next)&&status!=='请稍等')document.body.dataset.dashboardPrematureFinish='true';
    };
    const observer=new MutationObserver(neverClearBeforeRows);
    observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
   },{next:c});
   await filter.fill(c);
   await received.get(c)!.promise;
   await wait.waitFor();
   expect(await rows.allTextContents()).toEqual([a]);
   held.get(b)?.resolve();
   await delivered.promise;
   await page.waitForFunction(()=>document.body.dataset.dashboardLateResponse==='200');
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   expect(await wait.isVisible()).toBe(true);
   expect(await rows.allTextContents()).toEqual([a]);
   held.get(c)?.resolve();
   await rows.filter({hasText:c}).waitFor();
   await wait.waitFor({state:'hidden'});
   expect(await rows.allTextContents()).toEqual([c]);
   expect(await page.locator('body').getAttribute('data-dashboard-premature-finish')).toBeNull();
   await filter.fill(fail);
   await received.get(fail)!.promise;
   await wait.waitFor();
   held.get(fail)?.resolve();
   await wait.waitFor({state:'hidden'});
   await page.locator('.production-board [role="alert"]').waitFor();
   expect(await rows.allTextContents()).toEqual([c]);
   await page.getByRole('button',{name:'刷新',exact:false}).click();
   await page.getByText('当前筛选暂无生产订单',{exact:true}).waitFor();
   expect(await page.locator('.production-board [role="alert"]').count()).toBe(0);
   const badgeStarted=Promise.withResolvers<void>(),releaseBadge=Promise.withResolvers<void>();
   await page.route('**/api/todos/mine/indicator',async route=>{
    badgeStarted.resolve();
    await releaseBadge.promise;
    await route.continue();
   },{times:1});
   try{
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await badgeStarted.promise;
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,350)));
    expect(await wait.isVisible()).toBe(false);
   }finally{releaseBadge.resolve();}
   expect(h.errors).toEqual([]);
  }finally{
   for(const gate of held.values())gate.resolve();
   await context.close();
  }
 },testExecutionConfig.correctnessTimeoutMs);

 it('retains the factory workspace rows until the actual next filter returns',async()=>{
  const [a,b]=staged;
  const initial=new URLSearchParams({workspace:'factory',search:a});
  const {page,context}=await h.open(h.fixture.root.actorId,{},1440,1,{path:'/ui/digital-cockpit?'+initial});
  const query=page.getByRole('textbox',{name:'搜索产前与发厂订单'});
  const rows=page.locator('.workspace-order-list tbody tr td:first-child small');
  const table=page.locator('.workspace-order-list');
  const wait=page.locator('.dx-foreground-loading').getByText('请稍等',{exact:true});
  const gate=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
  try{
   await rows.filter({hasText:a}).waitFor();
   expect(await rows.allTextContents()).toEqual([a]);
   expect(await table.getByRole('alert').count()).toBe(0);
   await wait.waitFor({state:'hidden'});
   await page.route('**/api/digital-production/journeys?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('search')!==b)return route.continue();
    const response=await route.fetch();
    try{
     expect(response.status()).toBe(200);
     const snapshot=await response.json();
     expect(snapshot.items.map((item:{designStyleNo:string})=>item.designStyleNo)).toEqual([b]);
     started.resolve();
     await gate.promise;
     await route.fulfill({response});
    }finally{await response.dispose();}
   });
   await query.fill(b);
   await started.promise;
   await wait.waitFor();
   expect(await table.getAttribute('aria-busy')).toBe('true');
   expect(await rows.allTextContents()).toEqual([a]);
   const pagination=table.locator('.dx-production-pagination');
   expect(await pagination.innerText()).not.toContain('共 1 条');
   expect(await pagination.getByRole('button',{name:'跳转',exact:true}).isDisabled()).toBe(true);
   gate.resolve();
   await expect.poll(()=>rows.allTextContents()).toEqual([b]);
   await wait.waitFor({state:'hidden'});
   expect(await table.getAttribute('aria-busy')).toBe('false');
   expect(h.errors).toEqual([]);
  }finally{gate.resolve();await context.close();}
 },testExecutionConfig.correctnessTimeoutMs);

 it('keeps the old authorized route visible during a slow module load and exposes the original recovery on failure',async()=>{
  const {page,context}=await h.open(h.fixture.root.actorId,{},1440,1,{path:'/ui/production-dashboard'});
  const assetFor=(name:string)=>{
   const file=Object.entries(h.assetManifest!).find(([id])=>id.endsWith('/'+name))?.[1].file;
   expect(file).toBeTruthy();
   return '**/'+file!;
  };
  const board=page.locator('.production-dashboard.production-board');
  const wait=page.locator('.dx-foreground-loading').getByText('请稍等',{exact:true});
  const cockpitReady=Promise.withResolvers<void>(),allowCockpit=Promise.withResolvers<void>();
  const templateReady=Promise.withResolvers<void>(),failTemplate=Promise.withResolvers<void>();
  let loadCalls=0;
  const clickLink=async(path:string,id:string)=>{
   const target=page.locator('a[href="'+path+'"]:visible').first();
   if(await target.count())return target.click();
   // Drive the installed document router if this role's current menu is collapsed.
   await page.evaluate(({path,id})=>{
    if(document.getElementById(id))return;
    const anchor=document.createElement('a');anchor.href=path;anchor.textContent='TEST original internal link';anchor.id=id;
    document.querySelector('main')!.prepend(anchor);
   },{path,id});
   await page.locator('#'+id).click();
  };
  try{
   await page.route(assetFor('digital-cockpit-page.tsx'),async route=>{
    loadCalls+=1;cockpitReady.resolve();await allowCockpit.promise;await route.continue();
   });
   await page.route(assetFor('contract-template-settings-page.tsx'),async route=>{
    templateReady.resolve();await failTemplate.promise;await route.abort('failed');
   });
   await board.locator('.board-row').first().waitFor();
   const original=await board.locator('.board-row .board-identity strong').allTextContents();
   expect(original.length).toBe(3);
   await clickLink('/ui/digital-cockpit?scope=production','test-go-cockpit');
   await cockpitReady.promise;
   await wait.waitFor();
   expect(new URL(page.url()).pathname).toBe('/ui/production-dashboard');
   expect(await board.locator('.board-row .board-identity strong').allTextContents()).toEqual(original);
   await clickLink('/ui/digital-cockpit?scope=production','test-go-cockpit');
   expect(loadCalls).toBe(1);
   allowCockpit.resolve();
   await page.locator('.digital-journey-cockpit[data-view="overview"]').waitFor();
   await wait.waitFor({state:'hidden'});
   expect(new URL(page.url()).pathname).toBe('/ui/digital-cockpit');

   await clickLink('/ui/contract-template','test-go-template');
   await templateReady.promise;
   await wait.waitFor();
   expect(new URL(page.url()).pathname).toBe('/ui/digital-cockpit');
   expect(await page.locator('.digital-journey-cockpit[data-view="overview"]').isVisible()).toBe(true);
   failTemplate.resolve();
   await page.getByRole('alert').filter({hasText:'页面暂时未能打开，请刷新重试。'}).waitFor();
   await page.getByRole('button',{name:'刷新页面',exact:true}).waitFor();
   await wait.waitFor({state:'hidden'});
   expect(new URL(page.url()).pathname).toBe('/ui/contract-template');
   await page.goBack();
   await page.locator('.digital-journey-cockpit[data-view="overview"]').waitFor();
   await wait.waitFor({state:'hidden'});
  }finally{allowCockpit.resolve();failTemplate.resolve();await context.close();}
 },testExecutionConfig.correctnessTimeoutMs);

 it('covers the real ship-sample task read while contextual permissions are checked',async()=>{
  const task=(await h.fixture.db.query<{task_id:string}>(
   "SELECT task_id FROM digital_production_task_access WHERE task_kind='bulk_ship_sample' ORDER BY task_id LIMIT 1",
  )).rows[0]!;
  expect(task).toBeTruthy();
  const observed=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const taskRequest='**/api/digital-production/tasks/'+task.task_id;
  let style='';
  const {page,context}=await h.open(h.fixture.people.merchandiser!.actorId,{},1440,1,{
   path:'/ui/digital-production?task='+task.task_id+'&taskView=read',
   beforeNavigate: page=>page.route(taskRequest,async route=>{
    const response=await route.fetch();
    try{
     expect(response.status()).toBe(200);
     const body=await response.json();
     expect(body.taskId).toBe(task.task_id);
     style=body.identity.designStyleNo;
     observed.resolve();
     await release.promise;
     await route.fulfill({response});
    }finally{await response.dispose();}
   },{times:1}),
  });
  const wait=page.locator('.dx-foreground-loading').getByText('请稍等',{exact:true});
  try{
   await observed.promise;
   await wait.waitFor();
   release.resolve();
   await page.locator('.digital-task-identity').getByRole('heading',{name:style,exact:true}).waitFor();
   await wait.waitFor({state:'hidden'});
   expect(h.errors).toEqual([]);
  }finally{release.resolve();await context.close();}
 },testExecutionConfig.correctnessTimeoutMs);

 it('does not preload a restricted module during an intercepted link',async()=>{
  const {page,context}=await h.open(h.pmcId,{},1440,1,{path:'/ui/digital-cockpit?scope=production'});
  const name=Object.entries(h.assetManifest!).find(([id])=>id.endsWith('/employee-access-page.tsx'))?.[1].file;
  expect(name).toBeTruthy();
  let unauthorizedLoads=0;
  const target='/ui/employee-access';
  try{
   await page.locator('.digital-journey-cockpit[data-view="overview"]').waitFor();
   await page.route('**/'+name!,async route=>{unauthorizedLoads+=1;await route.continue();});
   await page.evaluate(path=>{
    const anchor=document.createElement('a');anchor.href=path;anchor.textContent='TEST employee access navigation';anchor.id='test-private-employee-access';document.querySelector('main')!.prepend(anchor);
   },target);
   await page.locator('#test-private-employee-access').click();
   await page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();
   expect(unauthorizedLoads).toBe(0);
   expect(new URL(page.url()).pathname).toBe(target);
  }finally{await context.close();}
 },testExecutionConfig.correctnessTimeoutMs);
});
