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
 beforeAll(async()=>{h=await cockpitHomeBrowser({databaseUrl:url!,indexed:true,workbenchKpis:true,productionAssets:true,mixedNative:true,orderCount:31,evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),'workspace-pages-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});});
 afterAll(async()=>{await h?.dispose();});
 // Besides the scale cohort the original homepage creates one real shortage order.
 const expectedOrdered=()=>new Set([...h.orders,h.shortage.productionOrderId]).size;
 it('shows15 current native designer rows with the original complete app and correct later page',async()=>{
  const {context,page}=await h.open();try{
   const workspaceReads:string[]=[],optionReads:string[]=[];
   page.on('request',request=>{const url=new URL(request.url());if(request.method()!=='GET')return;
    if(url.pathname.endsWith('/workspaces/designer'))workspaceReads.push('designer:'+Number(url.searchParams.get('page')??'1'));
    if(url.pathname.endsWith('/workspaces/pattern'))workspaceReads.push('pattern:'+Number(url.searchParams.get('page')??'1'));
    if(['/api/digital-production/options','/api/digital-production/access/options'].includes(url.pathname))optionReads.push(url.pathname);
   });
   const response=page.waitForResponse(value=>value.url().includes('/workspaces/designer?')&&value.request().method()==='GET');await page.goto(h.base+'/ui/digital-production?workspace=designer&view=ordered');const first=await response;expect(first.status()).toBe(200);
   const firstPage=await first.json();
   await expect.poll(()=>page.locator('.development-list-panel tbody tr').count(),{timeout:12000}).toBe(15);
   expect(await page.getByRole('alert').count()).toBe(0);
   await expect.poll(()=>new Set(optionReads).size).toBe(2);
   const initialOptionReads=[...optionReads];
   const next=page.getByRole('button',{name:'下一页',exact:true});
   const nextResponse=page.waitForResponse(value=>value.url().includes('/workspaces/designer?')&&value.request().method()==='GET'&&new URL(value.url()).searchParams.get('page')==='2');
   for(let attempt=0;attempt<8;attempt++){try{await next.click({timeout:1500});break;}catch(error){const notice=page.locator('[aria-label="站内提醒"]');if(!await notice.isVisible()||attempt===7)throw error;await notice.getByRole('button',{name:'我知道了',exact:true}).click();}}
   await expect.poll(()=>new URL(page.url()).searchParams.get('page')).toBe('2');
   const later=await nextResponse;expect(later.status()).toBe(200);expect(await later.json()).toMatchObject({page:2,total:firstPage.total,counts:firstPage.counts});
   await expect.poll(()=>page.locator('.development-list-panel tbody tr').count(),{timeout:12000}).toBe(15);
   expect(optionReads).toEqual(initialOptionReads);
   await page.screenshot({path:join(h.evidence,'designer-page2.png'),fullPage:true});
   const patternResponse=page.waitForResponse(value=>value.url().includes('/workspaces/pattern?'));await page.goto(h.base+'/ui/digital-pattern-room?scope=all&state=all');const patternReply=await patternResponse;expect(patternReply.status()).toBe(200);const pattern=await patternReply.json();await page.locator('.pattern-board-columns').waitFor();await expect.poll(()=>page.locator('.pattern-task-card').count(),{timeout:12000}).toBe((pattern.boardPreview??[]).length);
   expect(workspaceReads).toEqual(['designer:1','designer:2','pattern:1']);
   await page.screenshot({path:join(h.evidence,'pattern-current-board.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('keeps available rows and original controls when one order fails, without false totals or empty states',async()=>{
  const {context,page}=await h.open(),target=h.orders[0]!;try{
   await h.corruptProjection(target);const response=page.waitForResponse(value=>value.url().includes('/workspaces/designer?')&&value.request().method()==='GET');await page.goto(h.base+'/ui/digital-production?workspace=designer&view=ordered');const read=await response;expect(read.status()).toBe(200);
   expect(await read.json()).toMatchObject({total:null,freshness:{failed:1},businessCounts:{ordered:expectedOrdered()}});
   await page.getByRole('status').filter({hasText:'本页有部分明细未能读取'}).waitFor();
   expect(await page.locator('.development-list-panel tbody tr').count()).toBe(15);
   expect(await page.getByRole('navigation',{name:'分页',exact:true}).count()).toBe(0);
   expect(await page.getByText('当前视图暂无档案',{exact:true}).count()).toBe(0);
   expect(await page.locator('.development-kpi-2').innerText()).toContain(String(expectedOrdered()));
   expect(await page.getByText('部分订单信息尚未更新，数量暂不显示。',{exact:true}).count()).toBe(0);
   await page.screenshot({path:join(h.evidence,'designer-one-failure.png'),fullPage:true});
   // The actual development board excludes this bulk-only failed mother.
   const unaffected=page.waitForResponse(value=>value.url().includes('/workspaces/pattern?'));await page.goto(h.base+'/ui/digital-pattern-room?scope=all&state=all');const boardReply=await unaffected;expect(boardReply.status()).toBe(200);const board=await boardReply.json();expect(board.freshness).toBeUndefined();expect(board.total).not.toBeNull();
  }finally{await h.repairProjection(target);await context.close();}
 });
 it('keeps reliable totals and page2 controls after a display-only detail failure, then rereads that page',async()=>{
  const {context,page}=await h.open();let fail=true,total:number|undefined,ordered:number|undefined;
  try{
   // Inject only the display failure response; identity, selection and counts
   // still come from the original signed full application's actual API.
   await page.route('**/workspaces/designer?**',async route=>{const response=await route.fetch(),body=await response.json();total=body.total;ordered=body.businessCounts?.ordered;
    if(fail&&body.items.length){const missing=body.items.splice(0,1)[0];body.detailFailures=[{journeyId:missing.journey.id,designStyleNo:missing.journey.designStyleNo}];}
    await route.fulfill({response,json:body});
   });
   const response=page.waitForResponse(value=>value.url().includes('/workspaces/designer?'));await page.goto(h.base+'/ui/digital-production?workspace=designer&view=ordered&page=2');expect((await response).status()).toBe(200);
   await page.getByRole('status').filter({hasText:'的详情读取失败'}).waitFor();expect(await page.locator('.development-list-panel tbody tr').count()).toBe(14);
   expect(await page.getByRole('navigation',{name:'分页',exact:true}).count()).toBe(1);expect(new URL(page.url()).searchParams.get('page')).toBe('2');expect(total).toBe(expectedOrdered());expect(ordered).toBe(expectedOrdered());expect(await page.locator('.development-kpi-2').innerText()).toContain(String(ordered));expect(await page.getByText('部分订单信息尚未更新，数量暂不显示。',{exact:true}).count()).toBe(0);
   fail=false;const restored=page.waitForResponse(value=>value.url().includes('/workspaces/designer?'));await page.getByRole('button',{name:'重新读取本页',exact:true}).click();expect((await restored).status()).toBe(200);await expect.poll(()=>page.locator('.development-list-panel tbody tr').count(),{timeout:12000}).toBe(15);expect(new URL(page.url()).searchParams.get('page')).toBe('2');
  }finally{await context.close();}
 });
});
