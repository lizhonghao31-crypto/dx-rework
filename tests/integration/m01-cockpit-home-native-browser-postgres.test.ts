import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {vi} from 'vitest';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {sourcingSlaEvidence} from '../../apps/api/src/production-platform/sourcing-sla-evidence.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs});
import {cockpitHomeBrowser,homeReady,coverageReady,JOURNEY_COVERAGE_KEYS} from '../acceptance/m01-cockpit-home-native-browser.js';
async function openPendingCoverage(page:Parameters<typeof homeReady>[0]){
 const current=new URL(page.url()).searchParams.get('kpi');
 if(current!=='todo'){
  await page.getByRole('region',{name:'订单状态统计'}).getByRole('button',{name:/待处理/}).click();
  await homeReady(page);
 }
 const trigger=page.getByRole('button',{name:'查看待补资料',exact:true});
 await trigger.click();
 return trigger;
}
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('R3-02 original full App homepage, authenticated PostgreSQL and bounded browser cases',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 beforeAll(async()=>{h=await cockpitHomeBrowser({databaseUrl:url!,evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??process.env.RUNNER_TEMP??tmpdir(),'m01-cockpit-home-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});},120000);
 afterAll(async()=>{await h?.dispose();});
 it('keeps live-clock reading passive and preserves original dialogs across explicit same-order refreshes',async()=>{
  const {context,page}=await h.open();let journeyReads=0,documentReads=0;
  const isJourney=(url:string)=>/\/digital-production\/journeys(?:\?|\/[0-9a-f-]+\?)/.test(url);
  // Native signed identity and PG response remain intact. Only the observation
  // mode is adapted to exercise live UI cadence with the isolated fixed clock.
  await page.route('**/api/digital-production/journeys**',async route=>{
   if(!isJourney(route.request().url()))return route.continue();
   const response=await route.fetch(),value=await response.json();journeyReads++;
   await route.fulfill({response,json:{...value,observationMode:'live'}});
  });
  page.on('request',request=>{if(/\/api\/digital-production\/(?:sources|orders)\//.test(request.url()))documentReads++;});
  const refresh=async()=>{
   const received=page.waitForResponse(response=>isJourney(response.url()));
   // Exercise the existing refresh callback while a modal owns the top layer,
   // as a committed action can do; this does not submit a business command.
   await page.getByRole('button',{name:'刷新数据',exact:true}).evaluate((button:HTMLButtonElement)=>button.click());
   await received;await page.locator('[data-view][aria-busy=false]').waitFor();
  };
  try{
   await page.clock.install();await refresh();
   await page.locator('.cockpit-home-risk-trigger').first().click();
   const risk=page.getByRole('dialog',{name:'风险明细',exact:true});await risk.waitFor();
   let before=journeyReads;await page.clock.fastForward(61000);expect(journeyReads).toBe(before);expect(await risk.isVisible()).toBe(true);
   await refresh();expect(await risk.isVisible()).toBe(true);await risk.getByRole('button',{name:'关闭风险明细',exact:true}).click();
   await openPendingCoverage(page);const coverage=page.getByRole('dialog',{name:'待补资料',exact:true});await coverage.waitFor();await refresh();expect(await coverage.isVisible()).toBe(true);await page.keyboard.press('Escape');
   await page.locator('.journey-order-select').first().click();await page.locator('[data-view=order][aria-busy=false]').waitFor();
   await page.getByRole('button',{name:'调整主跟单',exact:true}).click();const personnel=page.getByRole('dialog',{name:'调整主跟单',exact:true});await personnel.waitFor();
   const field=personnel.getByRole('combobox',{name:'主跟单 *',exact:true}),original=await field.inputValue();
   before=journeyReads;await page.clock.fastForward(61000);expect(journeyReads).toBe(before);expect(await personnel.isVisible()).toBe(true);
   await refresh();expect(await personnel.isVisible()).toBe(true);expect(await field.inputValue()).toBe(original);expect(await personnel.locator('fieldset').isEnabled()).toBe(true);await personnel.getByRole('button',{name:'关闭',exact:true}).click();
   const identityRead=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/me');
   await page.locator('.cockpit-document-open-all').click();await identityRead;const documents=page.getByRole('dialog',{name:'全部相关单据',exact:true});await documents.waitFor();
   await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('.cockpit-document-priority-row')];return rows.length>0&&rows.every(row=>['ready','error'].includes(row.getAttribute('data-read-state')??'')&&!row.textContent?.includes('读取中'));});
   const search=documents.getByRole('textbox',{name:'查找已读取资料'});await search.fill('TEST keep input');
   before=journeyReads;const documentsBefore=documentReads;await page.clock.fastForward(61000);expect(journeyReads).toBe(before);expect(documentReads).toBe(documentsBefore);expect(await documents.isVisible()).toBe(true);
   await refresh();expect(await documents.isVisible()).toBe(true);expect(await search.inputValue()).toBe('TEST keep input');
   await expect.poll(()=>documentReads).toBeGreaterThan(documentsBefore);await page.keyboard.press('Escape');
   // Revocation / switching must still discard former private results, covered
   // by the native same-session suite and m01-cockpit-reads cases below.
   expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });
 it('renders the original full Shell, six peer KPIs, and aligned date/progress rows without changing source facts',async()=>{
  const {context,page}=await h.open(undefined,{},1584);
  try{const actual=await h.read(page);expect(actual.total).toBe(31);for(const width of [1165,1366,1440,1920]){
   await page.setViewportSize({width,height:1003});expect(await page.locator('.app-shell>aside').count()).toBe(1);expect(await page.locator('.journey-kpis .dx-production-kpi').count()).toBe(6);expect(await page.locator('.journey-secondary-kpis').count()).toBe(0);expect(await page.locator('.journey-orders th').count()).toBe(9);expect(await page.locator('.journey-orders th[aria-label="订单操作"]').count()).toBe(1);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   const cards=await page.locator('.journey-kpis .dx-production-kpi').evaluateAll(items=>items.map(el=>el.getBoundingClientRect().top));expect(Math.max(...cards)-Math.min(...cards)).toBeLessThan(2);
   const row=page.locator('.journey-orders tbody tr').first(),before=await row.boundingBox();await row.locator('.journey-order-select').hover();expect((await row.boundingBox())!.height).toBe(before!.height);
   for(const order of actual.items){const meter=page.locator(`[data-order-id="${order.id}"]`).getByRole('progressbar',{name:'整单实际进度'}),ratio=order.visualProgress?.actualRatio;if(ratio===null||ratio===undefined)expect(await meter.getAttribute('aria-valuenow')).toBeNull();else expect(Number(await meter.getAttribute('aria-valuenow'))).toBeCloseTo(ratio===1?100:Math.min(99.9,Math.round(ratio*1000)/10));}
   const body=await page.locator('body').innerText();for(const noise of ['查看进度依据与采用版本','完成办理前','当前结果：','时间规则待完善'])expect(body).not.toContain(noise);
   await page.screenshot({path:join(h.evidence,`full-home-${width}.png`),fullPage:true});await page.screenshot({path:join(h.evidence,`viewport-home-${width}.png`)});
  }
  await page.goto(h.base+h.path({search:h.prefix+'02'}));await homeReady(page);
  for(const width of [1165,1366,1584]){await page.setViewportSize({width,height:1003});const row=page.locator('.journey-orders tbody tr').first();const geometry=await row.evaluate(element=>({width:innerWidth,height:element.getBoundingClientRect().height,dpr:devicePixelRatio,fonts:document.fonts.status,cells:[...element.children].map(cell=>({text:cell.textContent,height:cell.getBoundingClientRect().height,font:getComputedStyle(cell).fontFamily,fontSize:getComputedStyle(cell).fontSize,lineHeight:getComputedStyle(cell).lineHeight}))}));await writeFile(join(h.evidence,`single-two-PO-geometry-${width}.json`),JSON.stringify(geometry,null,2));await page.screenshot({path:join(h.evidence,`single-two-PO-before-check-${width}.png`),fullPage:true});expect(geometry.height).toBeLessThanOrEqual(190);const cell=row.locator('.cockpit-home-client');const centers=await cell.evaluate(el=>[el,el.querySelector('.cockpit-home-customer')!,el.querySelector('[aria-label=下单数量]')!].map(item=>{const box=item.getBoundingClientRect();return box.x+box.width/2;}));expect(Math.max(...centers)-Math.min(...centers)).toBeLessThan(1);await page.screenshot({path:join(h.evidence,`single-two-PO-home-${width}.png`),fullPage:true});}
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(h.evidence,'viewport-home-390.png')});
  }finally{await context.close();}
 });
 it('matches the six current KPI cards to their authorized whole-range counts, including zero and unavailable',async()=>{
  const {context,page}=await h.open();try{const source=await h.read(page);
   const stats=page.getByRole('region',{name:'订单状态统计',exact:true});
   expect(await stats.getByText('未启动',{exact:true}).count()).toBe(0);
   for(const [label,field]of [['进行中','active'],['临期','dueSoon'],['逾期','overdue'],['整单已完成','completed'],['待处理','todo'],['订单总数','all']] as const){
    const card=stats.locator('.dx-production-kpi').filter({has:page.getByText(label,{exact:true})}),expected=source.summary[field];
    expect(await card.locator('strong').innerText()).toBe(String(expected??'—'));
    if(expected==null){expect(await card.evaluate(element=>element.tagName)).toBe('ARTICLE');continue;}
    const button=stats.getByRole('button',{name:new RegExp(label)});
    const response=page.waitForResponse(r=>r.url().includes('/digital-production/journeys?')&&!new URL(r.url()).searchParams.has('missing'));
    await button.click();const result=await (await response).json();expect(result.total).toBe(expected);await page.locator('[data-view="overview"][aria-busy="false"]').waitFor();
    expect(await page.locator('.journey-orders tbody tr').count()).toBe(Math.min(expected??0,15));expect(new URL(page.url()).searchParams.get('page')??'1').toBe('1');
   }
  }finally{await context.close();}
 });
 it('opens seven vertical categories first and drills every authorized page with counts matching full candidates',async()=>{
  const {context,page}=await h.open();try{const actual=await h.read(page,{kpi:'todo'}),trigger=await openPendingCoverage(page),originalUrl=page.url();const dialog=page.getByRole('dialog',{name:'待补资料'});await dialog.waitFor();expect(await dialog.locator('.cockpit-coverage-categories li').count()).toBe(7);expect(await dialog.locator('.cockpit-coverage-order-list').count()).toBe(0);
   for(const [i,key]of JOURNEY_COVERAGE_KEYS.entries()){const category=actual.supervision!.coverage.find(row=>row.key===key),button=dialog.locator('.cockpit-coverage-categories button').nth(i);expect(await button.innerText()).toContain(`${category?.orders??0} 单`);if(!category?.orders){expect(await button.isDisabled()).toBe(true);continue;}await button.click();await coverageReady(page);expect(await dialog.locator('.cockpit-coverage-heading').innerText()).toContain(`共 ${category.orders} 单`);await dialog.getByRole('button',{name:'返回分类',exact:true}).click();}
   const category=actual.supervision!.coverage.find(row=>row.orders>15)!;expect(category).toBeTruthy();const index=JOURNEY_COVERAGE_KEYS.indexOf(category.key);await dialog.locator('.cockpit-coverage-categories button').nth(index).click();await coverageReady(page);
   const ids=new Set<string>();let total=0;
   for(let i=1;i<=Math.ceil(category.orders/15);i++){
    const result=await h.read(page,{kpi:'todo',missing:category.key,page:String(i)});expect(result.total).toBe(category.orders);
    const rows=dialog.locator('.cockpit-coverage-order-list li');
    // An independently fetched page is not proof that React has committed the
    // dialog's own response. Compare the settled visible sequence, not a single
    // instantaneous DOM count during the request/paint handoff.
    await expect.poll(()=>rows.locator('strong').allTextContents(),{timeout:12000,message:`Visible coverage page ${i} must match the complete authorized native result`}).toEqual(result.items.map(item=>item.designStyleNo));
    expect(await rows.count()).toBe(result.items.length);
    for(const item of result.items){expect(await rows.filter({hasText:item.designStyleNo}).count()).toBe(1);ids.add(item.id);}
    total+=await rows.count();
    if(i*15<category.orders){
     const response=page.waitForResponse(response=>{const target=new URL(response.url());return target.pathname.endsWith('/digital-production/journeys')&&target.searchParams.get('missing')===category.key&&target.searchParams.get('page')===String(i+1);});
     await dialog.getByRole('button',{name:'下一页',exact:true}).click();expect((await response).status()).toBe(200);await coverageReady(page);
    }
   }
   expect(total).toBe(category.orders);expect(ids.size).toBe(category.orders);await dialog.getByRole('button',{name:'返回分类',exact:true}).click();expect(await dialog.locator('.cockpit-coverage-categories li').count()).toBe(7);await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});expect(page.url()).toBe(originalUrl);expect(await trigger.evaluate(el=>el===document.activeElement)).toBe(true);
   await page.goto(h.base+h.path({search:'',missing:'factory_date'}));await homeReady(page);const full=await h.read(page,{search:''});expect(await page.locator('.cockpit-applied-coverage').count()).toBe(1);await page.getByRole('button',{name:/订单总数/}).first().click();await homeReady(page);expect(new URL(page.url()).searchParams.has('missing')).toBe(false);expect(await page.locator('.cockpit-applied-coverage').count()).toBe(0);expect(await page.locator('.journey-orders [aria-label="分页"]').innerText()).toContain(`共 ${full.summary.all} 条`);
  }finally{await context.close();}
 });
 it('shows all original PO risks in a keyboard dismissible modal without expanding the table and retains a long multi-PO entry',async()=>{
  const {context,page}=await h.open(undefined,{search:h.prefix+'01'});try{const row=page.locator('.journey-orders tbody tr').first(),before=await row.boundingBox(),trigger=row.getByRole('button',{name:/全部.*项风险/});expect(await row.getByRole('button',{name:'另 1 个PO，查看订单'}).count()).toBe(1);await trigger.focus();await trigger.press('Enter');const dialog=page.getByRole('dialog');await dialog.waitFor();const text=await dialog.innerText();expect(text).toContain('TEST-PO-1-1');expect(text).toContain('TEST-PO-1-2');expect(text).toContain('TEST-PO-1-3');expect(text).toContain('2026-10-01');expect((await row.boundingBox())!.height).toBe(before!.height);await page.screenshot({path:join(h.evidence,'full-home-risk-modal.png'),fullPage:true});await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});expect((await row.boundingBox())!.height).toBe(before!.height);expect(await trigger.evaluate(el=>el===document.activeElement)).toBe(true);
  }finally{await context.close();}
 });
 it('returns from a category order to the unchanged original second homepage page and filters',async()=>{
  const {context,page}=await h.open(undefined,{page:'2',customer:'PD',kpi:'todo'});try{const original=new URL(page.url()),ids=await page.locator('.journey-orders tbody tr').evaluateAll(rows=>rows.map(el=>el.getAttribute('data-order-id')));await openPendingCoverage(page);const category=page.locator('.cockpit-coverage-categories button:enabled').first();await category.click();await coverageReady(page);await page.locator('.cockpit-coverage-order-list button').first().click();await page.locator('[data-view="order"][aria-busy="false"]').waitFor();await page.getByRole('button',{name:'‹ 生产管理总览'}).first().click();await homeReady(page);const returned=new URL(page.url());for(const key of ['search','customer','page'])expect(returned.searchParams.get(key)).toBe(original.searchParams.get(key));expect(await page.locator('.journey-orders tbody tr').evaluateAll(rows=>rows.map(el=>el.getAttribute('data-order-id')))).toEqual(ids);
  }finally{await context.close();}
 });
 it('uses original received and packed facts for remaining receipt debt and never promotes a technical order UUID to business ID',async()=>{
  const {context,page}=await h.open(undefined,{search:h.shortage.designStyleNo});try{const data=await h.read(page,{search:h.shortage.designStyleNo}),order=data.items[0]!;expect(order.businessProgress!.quantities!.lines.map(line=>line.remainingReceipt)).toEqual([2]);const trigger=page.getByRole('button',{name:/收货数量/});expect(await trigger.innerText()).toMatch(/部分收货\s*· 2\/4 件/);expect(await page.locator('.cockpit-home-receipt-gap').count()).toBe(0);const row=page.locator('.journey-orders tbody tr').first(),before=await row.boundingBox();expect(await row.innerText()).toContain('订单ID：—');expect(await row.innerText()).not.toContain(order.id);await page.screenshot({path:join(h.evidence,'full-home-original-receipt-debt.png'),fullPage:true});await trigger.click();const dialog=page.getByRole('dialog',{name:'风险明细'});await dialog.waitFor();expect(await dialog.innerText()).toContain('应收 4件 · 已收 2件 · 欠收 2件');expect(await dialog.locator('[aria-label="回货差额"] button').count()).toBe(1);await page.screenshot({path:join(h.evidence,'full-home-receipt-debt-modal.png'),fullPage:true});await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});expect(await trigger.evaluate(el=>el===document.activeElement)).toBe(true);expect((await row.boundingBox())!.height).toBe(before!.height);}finally{await context.close();}
 });
 it('keeps a failed category read distinct from empty orders and retries through the original request path',async()=>{
  const {context,page}=await h.open();try{await page.route('**/api/digital-production/journeys?**',async route=>{if(new URL(route.request().url()).searchParams.has('missing'))await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_HOME_TRANSPORT',message:'TEST category read failed'}})});else await route.continue();});await openPendingCoverage(page);await page.locator('.cockpit-coverage-categories button:enabled').first().click();const dialog=page.getByRole('dialog');await dialog.getByRole('alert').waitFor();expect(await dialog.innerText()).not.toContain('当前条件下没有对应订单');expect(await dialog.locator('.cockpit-coverage-order-list').count()).toBe(0);await page.unroute('**/api/digital-production/journeys?**');await dialog.getByRole('button',{name:'重新读取',exact:true}).click();await coverageReady(page);expect(await dialog.locator('.cockpit-coverage-order-list li').count()).toBeGreaterThan(0);await page.keyboard.press('Escape');await homeReady(page);
  }finally{await context.close();}
 });
 it('Final10 real full App keeps compact seven rings, native dates and both shared grid alignments',async()=>{
  const {context,page}=await h.open(undefined,{search:h.prefix+'01'});try{
   await page.locator('.journey-orders tbody tr').first().locator('.journey-order-select').click();await page.locator('[data-view="order"][aria-busy="false"]').waitFor();
   for(const width of [1165,1280,1366,1440,1585,1920]){
    await page.setViewportSize({width,height:1003});const stages=page.locator('.cockpit-stage');expect(await stages.count()).toBe(7);
    const geometry=await page.evaluate(()=>{const box=(selector:string)=>{const r=document.querySelector(selector)!.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return {body:document.documentElement.scrollWidth,inner:innerWidth,flow:box('.cockpit-flow-scroll'),stages:[...document.querySelectorAll('.cockpit-stage')].map(el=>{const r=el.getBoundingClientRect();return {x:r.x,right:r.right,top:r.top,dates:el.querySelector('.cockpit-stage-dates')!.getBoundingClientRect().bottom};}),current:box('.journey-current-panel'),risk:box('.journey-risk-panel'),nodes:box('.journey-node-panel'),docs:box('.journey-documents-panel'),log:box('.journey-activity-panel'),docsFooter:box('.cockpit-document-footer'),logFooter:box('.cockpit-log-summary-footer')};});
    expect(geometry.body).toBeLessThanOrEqual(geometry.inner+1);expect(new Set(geometry.stages.map(s=>Math.round(s.top))).size).toBe(1);expect(geometry.stages[6]!.right).toBeLessThanOrEqual(geometry.flow.right+1);
    for(const [a,b]of [[geometry.current.x,geometry.nodes.x],[geometry.current.x,geometry.docs.x],[geometry.risk.right,geometry.log.right],[geometry.current.y,geometry.risk.y],[geometry.current.bottom,geometry.risk.bottom],[geometry.docs.y,geometry.log.y],[geometry.docs.bottom,geometry.log.bottom],[geometry.docsFooter.bottom,geometry.logFooter.bottom]])expect(Math.abs(a-b)).toBeLessThanOrEqual(1);
    expect(await page.locator('.cockpit-flow-panel h2').innerText()).toBe('流程');const metadata=await page.locator('.cockpit-identity-facts>div').evaluateAll(fields=>fields.map(field=>({label:field.querySelector('dt')!.getBoundingClientRect().left,value:field.querySelector('dd')!.getBoundingClientRect().left})));expect(metadata).toHaveLength(6);for(let col=0;col<3;col++){expect(Math.abs(metadata[col]!.label-metadata[col+3]!.label)).toBeLessThanOrEqual(1);expect(Math.abs(metadata[col]!.value-metadata[col+3]!.value)).toBeLessThanOrEqual(1);}const overflow=await page.locator('.cockpit-current-scroll,.cockpit-detail-risk-summary').evaluateAll(elements=>elements.some(el=>getComputedStyle(el).overflowY==='auto'||getComputedStyle(el).overflowY==='scroll'));expect(overflow).toBe(false);const seven=await page.locator('.journey-node-viewport').evaluate(el=>{const rows=[...el.querySelectorAll('tbody>tr')],r=el.getBoundingClientRect();return {count:rows.length,seventhBottom:rows[6]?.getBoundingClientRect().bottom??null,bottom:r.bottom,eighthBottom:rows[7]?.getBoundingClientRect().bottom??null};});if(seven.seventhBottom!==null)expect(seven.seventhBottom).toBeLessThanOrEqual(seven.bottom+1);if(seven.eighthBottom!==null)expect(seven.eighthBottom).toBeLessThanOrEqual(seven.bottom+1);expect(geometry.docs.y).toBeGreaterThanOrEqual(geometry.nodes.bottom);expect(geometry.nodes.right).toBeCloseTo(geometry.log.right,0);
    const trigger=stages.nth(2).locator('.cockpit-stage-select');await trigger.focus();await trigger.hover();await page.mouse.move(0,0);
    const namesVisible=await stages.locator('.cockpit-stage-select>strong').evaluateAll(elements=>elements.every(element=>{const style=getComputedStyle(element);return style.visibility==='visible'&&style.display!=='none'&&element.getBoundingClientRect().height>0;}));expect(namesVisible).toBe(true);expect(await page.getByRole('tooltip').count()).toBe(0);expect(await trigger.evaluate(el=>el===document.activeElement)).toBe(true);
    await page.screenshot({path:join(h.evidence,`full-detail-multi-PO-${width}.png`),fullPage:true});await page.keyboard.press('Tab');await page.locator('.cockpit-detail-toolbar').click();
   }
   const body=await page.locator('.cockpit-detail').innerText();for(const text of ['计划与时效','订单进度 · 全单范围','查看进度依据与采用版本','该节点已结束'])expect(body).not.toContain(text);expect(body).toContain('订单ID：—');expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });
 it('Final10 labelled shared-projection fixture renders independent zero, partial, full and unknown rings in the real full App',async()=>{
  const pairs=[[0,0],[.4,.8],[1,.6],[null,null]] as const;
  const {context,page}=await h.open(undefined,{search:h.prefix+'01'});try{
   // Only the returned visual projection is a labelled rendering fixture here;
   // authenticated native IDs, commands, permissions and dates are retained.
   await page.route('**/api/digital-production/journeys/*',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);const value=await response.json();expect(value.visualProgress?.stages).toHaveLength(7);await route.fulfill({response,json:{...value,visualProgress:{...value.visualProgress,stages:value.visualProgress.stages.map((stage:Record<string,unknown>,index:number)=>index<4?{...stage,timeRatio:pairs[index]![0],actualRatio:pairs[index]![1]}:stage)}}});});
   await page.locator('.journey-orders tbody tr').first().locator('.journey-order-select').click();await page.locator('[data-view="order"][aria-busy="false"]').waitFor();
   const firstTrigger=page.locator('.cockpit-stage-select').first();
   await firstTrigger.hover();await firstTrigger.focus();await page.mouse.move(0,0);
   expect(await firstTrigger.evaluate(el=>el===document.activeElement)).toBe(true);expect(await page.getByRole('tooltip').count()).toBe(0);
   await page.keyboard.press('Space');expect(await firstTrigger.getAttribute('aria-pressed')).toBe('true');
   const removed=['创建产品开发','开发资料保存/发布','订购信息'];
   const heading=page.getByRole('region',{name:'当前节点详情'}).getByRole('heading');
   for(const label of removed)expect(await heading.innerText()).not.toContain(label);
   const nodes=page.getByRole('region',{name:'小流程明细'});
   await nodes.getByRole('button',{name:/查看更多/}).click();
   const expanded=page.getByRole('dialog',{name:'全部节点明细'});await expanded.waitFor();
   for(const label of removed)expect(await expanded.innerText()).not.toContain(label);
   await page.keyboard.press('Escape');await expanded.waitFor({state:'detached'});
   expect(await firstTrigger.getAttribute('aria-pressed')).toBe('true');
   for(const [index,pair]of pairs.entries()){
    const stage=page.locator('.cockpit-stage').nth(index);for(const [kind,ratio]of [['time',pair[0]],['actual',pair[1]]] as const){const arc=stage.locator('.cockpit-stage-arc.is-'+kind);expect(await arc.count()).toBe(ratio===null||ratio===0?0:1);if(ratio!==null&&ratio>0)expect(await arc.getAttribute('stroke-dasharray')).toBe(`${ratio*100} 100`);}
    const button=stage.locator('.cockpit-stage-select');await button.focus();expect(await button.getAttribute('title')).toBe(pair[0]===null?null:`时间 ${pair[0]*100}% · 实际 ${pair[1]!*100}%`);expect(await button.locator('strong').isVisible()).toBe(true);expect(await stage.getByRole('tooltip').count()).toBe(0);
   }
  }finally{await context.close();}
 });
 it('Final10 full App keeps long metadata labels and values on shared columns at normal and 125-percent CSS viewport/DPR conditions',async()=>{
  // Labelled response fixture stresses layout only: native identifiers, auth,
  // business quantities, node facts, dates and versions are not replaced.
  for(const scale of [1,1.25]){
   const {context,page}=await h.open(undefined,{search:h.prefix+'01'},1165,scale);try{
    await page.route('**/api/digital-production/journeys/*',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);const value=await response.json();await route.fulfill({response,json:{...value,customer:'TEST-长客户名称用于资料列对齐检查-'.repeat(2),merchandisers:value.merchandisers.map((person:{name:string|null})=>({...person,name:'TEST-长跟单姓名用于字段自然换行检查'}))}});});
    await page.locator('.journey-orders tbody tr').first().locator('.journey-order-select').click();await page.locator('[data-view="order"][aria-busy="false"]').waitFor();
    for(const width of [1165,1280,1366,1440,1920]){
     await page.setViewportSize({width:Math.round(width/scale),height:Math.round(1003/scale)});
     const layout=await page.evaluate(()=>({width:innerWidth,body:document.documentElement.scrollWidth,dpr:devicePixelRatio,fields:[...document.querySelectorAll<HTMLElement>('.cockpit-identity-facts>div')].map(field=>{const outer=field.getBoundingClientRect(),label=field.querySelector('dt')!.getBoundingClientRect(),value=field.querySelector('dd')!.getBoundingClientRect();return {key:field.dataset.identityFact,label:label.left,value:value.left,right:value.right,outerRight:outer.right,scroll:field.scrollWidth,client:field.clientWidth,overflow:field.scrollWidth>field.clientWidth+1};})}));
     expect(layout.dpr).toBe(scale);expect(layout.body).toBeLessThanOrEqual(layout.width+1);expect(layout.fields).toHaveLength(6);
     for(let col=0;col<3;col++){expect(Math.abs(layout.fields[col]!.label-layout.fields[col+3]!.label)).toBeLessThanOrEqual(1);expect(Math.abs(layout.fields[col]!.value-layout.fields[col+3]!.value)).toBeLessThanOrEqual(1);}
     await page.screenshot({path:join(h.evidence,`long-metadata-physical-${width}-scale-${scale}.png`),fullPage:true});for(const field of layout.fields){expect(field.right).toBeLessThanOrEqual(field.outerRight+1);expect(field.overflow,JSON.stringify({width,scale,field})).toBe(false);}
     const cards=await page.locator('.cockpit-detail-columns>.dx-production-panel').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));const [current,nodes,risk,docs,log]=cards;for(const [a,b]of [[current!.left,nodes!.left],[current!.top,risk!.top],[current!.bottom,risk!.bottom],[current!.left,docs!.left],[risk!.right,log!.right],[docs!.top,log!.top],[docs!.bottom,log!.bottom]])expect(Math.abs(a-b)).toBeLessThanOrEqual(1);
     await page.screenshot({path:join(h.evidence,`long-metadata-physical-${width}-scale-${scale}.png`),fullPage:true});
    }
   }finally{await context.close();}
  }
 });
 it('R3-03 original physical F receipt debt, material/risk/directory/log dialogs retain card geometry and return focus',async()=>{
  const {context,page}=await h.open(undefined,{search:h.shortage.designStyleNo});try{
   await page.locator('.journey-orders tbody tr').first().locator('.journey-order-select').click();await page.locator('[data-view="order"][aria-busy="false"]').waitFor();expect(await page.locator('.cockpit-receipt-gap').innerText()).toBe('欠2件');expect(await page.locator('.cockpit-detail-risk-summary').innerText()).toContain('应收4件，已收2件');
   const boxes=async()=>page.locator('.cockpit-detail-columns>.dx-production-panel').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return [r.x+window.scrollX,r.y+window.scrollY,r.width,r.height];})),before=await boxes();
   const risk=page.locator('.journey-risk-panel').getByRole('button',{name:'查看全部 ›',exact:true});await risk.click();await page.getByRole('dialog',{name:'风险与异常明细'}).waitFor();expect(await page.getByRole('dialog',{name:'风险与异常明细'}).innerText()).toContain('欠2件');await page.keyboard.press('Escape');expect(await risk.evaluate(el=>el===document.activeElement)).toBe(true);expect(await boxes()).toEqual(before);
   expect(await page.locator('.cockpit-current-additional[open]').count()).toBe(1);const materialBefore=await boxes();const material=page.getByRole('button',{name:'该节点所需材料一览',exact:true});await material.click();const md=page.getByRole('dialog',{name:'该节点所需材料一览'});await md.getByLabel('本节点材料明细').waitFor();expect(await boxes()).toEqual(materialBefore);await page.keyboard.press('Escape');expect(await material.evaluate(el=>el===document.activeElement)).toBe(true);
   const documents=page.locator('.journey-documents-panel').getByRole('button',{name:'查看更多 ›',exact:true});await documents.click();const dd=page.getByRole('dialog',{name:'全部相关单据',exact:true});await dd.waitFor();await page.screenshot({path:join(h.evidence,'detail-documents-modal.png'),fullPage:true});await page.keyboard.press('Escape');expect(await boxes()).toEqual(before);expect(await documents.evaluate(el=>el===document.activeElement)).toBe(true);
   const logs=page.locator('.journey-activity-panel').getByRole('button',{name:'查看更多',exact:true});await logs.click();const ld=page.getByRole('dialog',{name:'操作记录',exact:true});await ld.waitFor();if(await ld.getByRole('button',{name:'加载后续记录',exact:true}).count()){const count=await ld.locator('tbody tr').count();await ld.getByRole('button',{name:'加载后续记录',exact:true}).click();await ld.getByRole('button',{name:'正在读取…',exact:true}).waitFor({state:'detached'});expect(await ld.locator('tbody tr').count()).toBeGreaterThan(count);}await page.keyboard.press('Escape');expect(await boxes()).toEqual(before);expect(await logs.evaluate(el=>el===document.activeElement)).toBe(true);
   await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(h.evidence,'full-detail-original-F.png'),fullPage:true});expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });
 it('rejects the next drill read after real PMC revocation while keeping the same valid original signed session',async()=>{
  const {context,page}=await h.open(h.pmcId);try{const first=await h.read(page);expect(first.total).toBe(31);const token=(await context.cookies()).find(cookie=>cookie.name==='dx_rework_session')!.value,before=h.hash(token);await openPendingCoverage(page);await page.locator('.cockpit-coverage-categories button:enabled').first().click();await coverageReady(page);await h.revokePmc();const read=page.waitForResponse(response=>response.url().includes('/digital-production/journeys?'));await page.getByRole('dialog').getByRole('button',{name:'下一页',exact:true}).click();const response=await read;expect([200,403]).toContain(response.status());const result=await response.json();expect(JSON.stringify(result)).not.toContain(h.prefix);for(const id of h.orders)expect(JSON.stringify(result)).not.toContain(id);if(response.status()===200)expect(result.total).toBe(0);expect(h.hash((await context.cookies()).find(cookie=>cookie.name==='dx_rework_session')!.value)).toBe(before);const user=await h.auth.authenticate(token);expect(user.businessRoles).toContain('finance_read');expect(user.businessRoles).not.toContain('pmc');expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });
 it('R5 assigns the missing primary in the original order personnel UI, rejects an ordinary merchandiser and continues genuine owner approval',async()=>{
  const f=h.fixture,native=new SourcingService(f.db,undefined,undefined,undefined,f.contracts),stop=new Error('TEST keep genuine owner approval pending');
  let orderId='',caseId='';const original=native.recordManagementDecision.bind(native);
  const management=vi.spyOn(native,'recordManagementDecision').mockImplementation(async(...args)=>{
   caseId=args[1];orderId=(await f.db.query("SELECT production_order_id FROM digital_production_child_links WHERE module='sourcing' AND child_id=$1",[caseId])).rows[0].production_order_id;
   // Isolated historical missing-staff precondition; assignment and approval below use the real UI and original commands.
   await f.db.query('UPDATE digital_production_orders SET primary_merchandiser_id=NULL WHERE production_order_id=$1',[orderId]);return original(...args);
  });
  const owner=vi.spyOn(native,'decideOwner').mockRejectedValueOnce(stop);
  try{await expect(h.runInScene(()=>f.bulkReady('无',undefined,1,native,{stylePrefix:h.prefix+'OWNER-READY-'}))).rejects.toBe(stop);}finally{management.mockRestore();owner.mockRestore();}
  expect((await sourcingSlaEvidence(f.db,orderId)).sourcing_approval).toBeUndefined();
  const manager=await h.open(f.people['production-management']!.actorId);
  await manager.page.goto(h.base+h.path({selected:orderId}));
  try{
   const button=manager.page.getByRole('button',{name:'调整主跟单',exact:true});await button.waitFor();await button.click();
   const dialog=manager.page.getByRole('dialog',{name:'调整主跟单',exact:true});await dialog.waitFor();
   const name=(await f.db.query('SELECT display_name FROM app_users WHERE id=$1',[f.people.merchandiser!.actorId])).rows[0].display_name;
   await dialog.getByRole('combobox',{name:'主跟单 *',exact:true}).fill(name);await dialog.getByRole('option',{name,exact:true}).click();
   await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
   await expect.poll(async()=>(await f.db.query('SELECT primary_merchandiser_id FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0].primary_merchandiser_id).toBe(f.people.merchandiser!.actorId);
   await expect.poll(()=>manager.page.locator('[data-identity-fact="merchandiser"]').innerText()).toContain(name);
   expect((await sourcingSlaEvidence(f.db,orderId)).sourcing_approval?.startedAt).toBe('2026-11-07T00:00:00.000Z');
   const detail=await manager.page.request.get(h.base+'/api/digital-production/journeys/'+orderId+'?view=cockpit');expect(detail.status()).toBe(200);
   const ownerNode=(await detail.json()).stages.flatMap((stage:{nodes:Array<{key:string}>})=>stage.nodes).find((node:{key:string})=>node.key==='sourcing_owner');
   expect(ownerNode).toMatchObject({state:'active',responsibilityRole:'老板审批'});

  }finally{await manager.context.close();}
  const merchandiser=await h.open(f.people.merchandiser!.actorId);
  await merchandiser.page.goto(h.base+h.path({selected:orderId}));
  try{
   await merchandiser.page.locator('[data-view="order"][aria-busy="false"]').waitFor();expect(await merchandiser.page.getByRole('button',{name:'调整主跟单',exact:true}).count()).toBe(0);
   const version=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0].version;
   const denied=await merchandiser.page.request.put(h.base+'/api/digital-production/orders/'+orderId+'/merchandiser',{data:{merchandiserId:f.people.merchandiser!.actorId,expectedVersion:version}});expect(denied.status()).toBe(403);
   expect((await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0].version).toBe(version);
  }finally{await merchandiser.context.close();}
  const approval=await h.open(f.people.owner!.actorId);
  try{
   await approval.page.goto(h.base+'/ui/sourcing/orders/'+caseId+'?node=owner');const approve=approval.page.getByRole('button',{name:'批准方案',exact:true});await approve.waitFor();await expect.poll(()=>approve.isEnabled()).toBe(true);const submitted=approval.page.waitForResponse(response=>response.url().endsWith('/owner-decisions')&&response.request().method()==='POST');await approve.click();const response=await submitted;expect(response.status(),response.status()===201?'original approval succeeded':await response.text()).toBe(201);
   await expect.poll(async()=>(await f.db.query('SELECT decision,decided_by FROM sourcing_owner_decisions WHERE sourcing_case_id=$1',[caseId])).rows).toEqual([{decision:'approved',decided_by:f.people.owner!.actorId}]);
   const current=await approval.page.request.get(h.base+'/api/sourcing/cases/'+caseId);expect(current.status()).toBe(200);expect((await current.json()).status).toBe('pending_finance_reconciliation');
   await approval.page.screenshot({path:join(h.evidence,'r509-original-owner-approved.png'),fullPage:true});
  }finally{await approval.context.close();}
 });

 it.each([0,4])('opens the original live production dashboard directly after transfer with %i pieces retained by the old factory',async reported=>{
  const f=h.fixture;await f.advance(h.scene,new Date(Date.now()+86400000).toISOString());
  let id='',productionId='',decision='';
  const search=h.prefix+'CURRENT-FACTORY-'+reported+'-',factoryName='TEST-R509 current factory '+reported;
  await h.runInScene(async()=>{
   const r=await f.bulkReady('无',undefined,1,f.sourcing,{stylePrefix:search});id=r.id;
   const cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[r.caseId])).rows;
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   for(const cut of cuts)await r.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,id);await flow.dispatch(f.people.warehouse!,id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST current factory navigation'},randomUUID());
   productionId=(await f.db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1',[r.caseId])).rows[0].production_order_id;
   if(reported)await new ProductionReportingService(f.db).report(f.root,productionId,{position:1,businessDate:beijingCalendarDate(businessNow()),quantity:reported},randomUUID());
   const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:'TEST-'+randomUUID().slice(0,8).toUpperCase(),supplierType:'factory',supplierName:factoryName,address:'TEST',contractEntityName:factoryName,partyBRepresentative:'TEST',payeeName:factoryName,bankAccount:'TEST000'+reported,bankName:'TEST',changeReason:'TEST original factory no remaining share'}));
   await f.sourcing.requestFactoryChange(f.people['production-management']!,r.caseId,{supplierId:supplier.supplierId,unitPrice:'6',changeReason:'TEST transfer all unstarted production'},randomUUID());
   const request=(await f.sourcing.getCurrentFactoryChange({...f.root,authorizationCapability:'sourcing:view'},r.caseId)).item!;
   decision=(await f.sourcing.decideFactoryChange(f.people.owner!,r.caseId,request.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST current factory scope'},randomUUID())).value.decision!.sourcingDecisionId;
   const scopes=(await f.db.query('SELECT factory_decision_id,quantity::int FROM sourcing_production_factory_orders WHERE production_order_id=$1 ORDER BY factory_decision_id NULLS FIRST',[productionId])).rows;
   expect(scopes).toEqual([{factory_decision_id:null,quantity:reported},{factory_decision_id:decision,quantity:10-reported}]);
  });
  const tab=await h.open(reported?undefined:f.people.merchandiser!.actorId,{search});try{
   const journey=(await h.read(tab.page,{search})).items.find(item=>item.orderId===id)!;
   const node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.current&&node.key==='production_reporting');
   expect(node?.records).toEqual(expect.arrayContaining([
    expect.objectContaining({domain:'factory',url:'/ui/digital-production?factory='+id+'&factoryAction=productionProgress'}),
    expect.objectContaining({domain:'production',url:'/ui/production-dashboard/'+productionId})
   ]));
   const row=tab.page.locator(`[data-order-id="${journey.id}"]`);
   const progress=row.locator('.cockpit-home-fact').filter({hasText:'生产进度'});
   const links=progress.getByRole('link');
   if(reported){
    expect(await links.count()).toBe(0);
    await progress.locator('summary').click();
   }
   const target=reported?progress.getByRole('link',{name:factoryName,exact:true}):progress.getByRole('link',{name:/生产进度/});
   expect(await links.count()).toBe(reported?2:1);
   const href=new URL((await target.getAttribute('href'))!,h.base);
   expect(href.pathname).toBe('/ui/production-dashboard/'+productionId);
   expect(href.searchParams.get('factoryDecisionId')).toBe(decision);
   if(reported){
    const targets=await links.evaluateAll(elements=>elements.map(element=>{
     const url=new URL((element as HTMLAnchorElement).href);
     return {path:url.pathname,decision:url.searchParams.get('factoryDecisionId')};
    }));
    expect(targets).toEqual(expect.arrayContaining([null,decision].map(factoryDecisionId=>({path:'/ui/production-dashboard/'+productionId,decision:factoryDecisionId}))));
   }
   const loaded=tab.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/production-dashboard/'+productionId&&new URL(response.url()).searchParams.get('factoryDecisionId')===decision);
   await target.click();expect((await loaded).status()).toBe(200);
   expect(new URL(tab.page.url()).pathname).toBe('/ui/production-dashboard/'+productionId);
   await expect.poll(()=>tab.page.locator('.production-dashboard').innerText()).toContain(factoryName);

   await tab.page.goto(h.base+'/ui/digital-production?factory='+id);const link=tab.page.getByRole('link',{name:'打开原实时生产',exact:true});
   await expect.poll(()=>link.count()).toBe(1);if(!await link.isVisible())await link.locator('xpath=ancestor::details[1]').locator('summary').first().click();
   expect(new URL((await link.getAttribute('href'))!,h.base).searchParams.get('factoryDecisionId')).toBe(decision);
   await link.click();await expect.poll(()=>new URL(tab.page.url()).searchParams.get('factoryDecisionId')).toBe(decision);
   await expect.poll(()=>tab.page.locator('.production-dashboard').innerText()).toContain(factoryName);
   expect((await tab.page.request.get(h.base+'/api/production-dashboard/'+productionId+'?factoryDecisionId='+decision)).status()).toBe(200);
   await tab.page.screenshot({path:join(h.evidence,`r509-current-factory-production-${reported}.png`),fullPage:true});
  }finally{await tab.context.close();}
  if(!reported){
   const denied=await h.open(f.people['development-clerk']!.actorId,{},1584,1,{path:h.path({search})});
   try{
    const dashboard=await denied.page.request.get(h.base+'/api/production-dashboard/'+productionId+'?factoryDecisionId='+decision);
    expect(dashboard.status()).toBe(403);
    const list=await h.read(denied.page,{search});
    const readOnlyOrder=list.items.find(item=>item.orderId===id);
    expect(readOnlyOrder?.cockpitFacts?.production).toMatchObject({status:'unavailable'});
    expect(readOnlyOrder?.cockpitFacts?.production.dashboardLinks).toBeUndefined();
    await denied.page.locator('.digital-journey-cockpit[data-view="overview"][aria-busy="false"]').waitFor();
    expect(await denied.page.getByRole('link',{name:/生产进度/}).count()).toBe(0);
   }finally{await denied.context.close();}
  }
 });

});
