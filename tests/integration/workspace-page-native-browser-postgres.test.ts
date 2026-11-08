import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {cockpitHomeBrowser} from '../acceptance/m01-cockpit-home-native-browser.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('PERF07 full production application workspace pages',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 beforeAll(async()=>{h=await cockpitHomeBrowser({databaseUrl:url!,indexed:true,productionAssets:true,mixedNative:true,orderCount:31,evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),'workspace-pages-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});});
 afterAll(async()=>{await h?.dispose();});
 it('shows15 current native designer rows with the original complete app and correct later page',async()=>{
  const {context,page}=await h.open();try{
   const response=page.waitForResponse(value=>value.url().includes('/workspaces/designer?')&&value.request().method()==='GET');await page.goto(h.base+'/ui/digital-production?workspace=designer&view=ordered');expect((await response).status()).toBe(200);
   await expect.poll(()=>page.locator('.development-list-panel tbody tr').count(),{timeout:12000}).toBe(15);
   expect(await page.getByRole('alert').count()).toBe(0);
   const next=page.getByRole('button',{name:'下一页',exact:true});
   for(let attempt=0;attempt<8;attempt++){try{await next.click({timeout:1500});break;}catch(error){const notice=page.locator('[aria-label="站内提醒"]');if(!await notice.isVisible()||attempt===7)throw error;await notice.getByRole('button',{name:'我知道了',exact:true}).click();}}
   await expect.poll(()=>new URL(page.url()).searchParams.get('page')).toBe('2');
   await expect.poll(()=>page.locator('.development-list-panel tbody tr').count(),{timeout:12000}).toBe(15);
   await page.screenshot({path:join(h.evidence,'designer-page2.png'),fullPage:true});
   const patternResponse=page.waitForResponse(value=>value.url().includes('/workspaces/pattern?'));await page.goto(h.base+'/ui/digital-pattern-room?scope=all&state=all');const patternReply=await patternResponse;expect(patternReply.status()).toBe(200);const pattern=await patternReply.json();await page.locator('.pattern-board-columns').waitFor();await expect.poll(()=>page.locator('.pattern-task-card').count(),{timeout:12000}).toBe((pattern.boardPreview??[]).length);
   await page.screenshot({path:join(h.evidence,'pattern-current-board.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('keeps available rows and original controls when one order fails, without false totals or empty states',async()=>{
  const {context,page}=await h.open(),target=h.orders[0]!;try{
   await h.corruptProjection(target);const response=page.waitForResponse(value=>value.url().includes('/workspaces/designer?')&&value.request().method()==='GET');await page.goto(h.base+'/ui/digital-production?workspace=designer&view=ordered');expect((await response).status()).toBe(200);
   await page.getByRole('status').filter({hasText:'部分订单信息尚未更新，数量暂不显示'}).waitFor();
   expect(await page.locator('.development-list-panel tbody tr').count()).toBe(15);
   expect(await page.getByRole('navigation',{name:'分页',exact:true}).count()).toBe(0);
   expect(await page.getByText('当前视图暂无档案',{exact:true}).count()).toBe(0);
   expect(await page.locator('.development-view-cards').innerText()).toContain('—');
   await page.screenshot({path:join(h.evidence,'designer-one-failure.png'),fullPage:true});
   // The actual development board excludes this bulk-only failed mother.
   const unaffected=page.waitForResponse(value=>value.url().includes('/workspaces/pattern?'));await page.goto(h.base+'/ui/digital-pattern-room?scope=all&state=all');const boardReply=await unaffected;expect(boardReply.status()).toBe(200);const board=await boardReply.json();expect(board.freshness).toBeUndefined();expect(board.total).not.toBeNull();
  }finally{await h.repairProjection(target);await context.close();}
 });
 it('keeps reliable totals and page2 controls after a display-only detail failure, then rereads that page',async()=>{
  const {context,page}=await h.open();let fail=true,total:number|undefined;
  try{
   // Inject only the display failure response; identity, selection and counts
   // still come from the original signed full application's actual API.
   await page.route('**/workspaces/designer?**',async route=>{const response=await route.fetch(),body=await response.json();total=body.total;
    if(fail&&body.items.length){const missing=body.items.splice(0,1)[0];body.detailFailures=[{journeyId:missing.journey.id,designStyleNo:missing.journey.designStyleNo}];}
    await route.fulfill({response,json:body});
   });
   const response=page.waitForResponse(value=>value.url().includes('/workspaces/designer?'));await page.goto(h.base+'/ui/digital-production?workspace=designer&view=ordered&page=2');expect((await response).status()).toBe(200);
   await page.getByRole('status').filter({hasText:'的详情读取失败'}).waitFor();expect(await page.locator('.development-list-panel tbody tr').count()).toBe(14);
   expect(await page.getByRole('navigation',{name:'分页',exact:true}).count()).toBe(1);expect(new URL(page.url()).searchParams.get('page')).toBe('2');expect(await page.locator('.development-view-cards').innerText()).toContain(String(total));expect(await page.getByText('部分订单信息尚未更新，数量暂不显示。',{exact:true}).count()).toBe(0);
   fail=false;const restored=page.waitForResponse(value=>value.url().includes('/workspaces/designer?'));await page.getByRole('button',{name:'重新读取本页',exact:true}).click();expect((await restored).status()).toBe(200);await expect.poll(()=>page.locator('.development-list-panel tbody tr').count(),{timeout:12000}).toBe(15);expect(new URL(page.url()).searchParams.get('page')).toBe('2');
  }finally{await context.close();}
 });
});
