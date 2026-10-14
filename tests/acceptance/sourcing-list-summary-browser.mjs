import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'dx-sourcing-summary-'));
const id = index => `00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
const item = index => ({sourcingCaseId:id(index),erpOrderId:id(index),erpOrderNo:`TEST-${index}`,styleNo:`TEST-${index}`,gender:'男装',styleName:'针织',laneKey:'garment_processing',orderQuantity:100,lineItems:[{position:1,styleNo:`TEST-${index}`,alternateStyleNo:null,color:'蓝',quantity:100,externalUnitPrice:null,legacy:false}],estimatedCutPieceSendDate:null,deliveryDate:null,processDescription:null,processes:[],status:'pending_ie_quote',version:1,createdBy:id(99),merchandiserName:'验收跟单',createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z',ieQuote:null,decision:null,ownerDecision:null});
let browser,server;
try {
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/sourcing-list-summary.tsx'),name:'SourcingSummaryFixture',formats:['iife']}}});
 const files=await readdir(output),js=await readFile(join(output,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(output,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const [width,height] of [[1440,1024],[768,1024],[390,844]]) {
  const page=await browser.newPage({viewport:{width,height}}),errors=[],queries=[];let releaseSlow,slowStarted;
  const started=new Promise(r=>{slowStarted=r;});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/auth/me'))return route.fulfill({json:{status:'authorized',user:{id:id(99),displayName:'验收跟单',businessRoles:['order_merchandiser'],capabilities:['sourcing:view']}}});
   if(!url.pathname.endsWith('/sourcing/cases'))return route.fulfill({status:403,json:{error:{message:'无权限'}}});
   const params=url.searchParams;queries.push(Object.fromEntries(params));const q=params.get('q'),currentPage=Number(params.get('page'));
   if(q==='失败')return route.fulfill({status:500,json:{error:{message:'列表读取失败'}}});
   if(q==='慢响应'){slowStarted();await new Promise(r=>{releaseSlow=r;});}
   const totalCount=q==='不存在'?0:q==='快响应'?2:17;
   const count=Math.max(0,Math.min(15,totalCount-(currentPage-1)*15));
   return route.fulfill({json:{items:Array.from({length:count},(_,i)=>item(i+1+(currentPage-1)*15)),page:currentPage,pageSize:15,totalCount,totalPages:Math.max(1,Math.ceil(totalCount/15)),totalOrderQuantity:totalCount*100}});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/ui/sourcing/pending`);
  const summary=page.getByRole('status',{name:'筛选结果汇总'}),search=page.getByRole('textbox',{name:'关键词搜索'});
  await summary.waitFor();assert.match(await summary.innerText(),/共 17 张订单.*订单数量合计 1,700 件/);
  await page.getByRole('navigation',{name:'订单列表分页'}).getByRole('button',{name:'2',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.sourcing-order-card').length===2);assert.match(await summary.innerText(),/1,700/);
  await search.fill('慢响应');await started;assert.equal(await summary.count(),0);
  await search.fill('快响应');await page.waitForFunction(()=>document.querySelector('.sourcing-list-summary')?.textContent.includes('200'));releaseSlow();
  await page.waitForResponse(res=>new URL(res.url()).searchParams.get('q')==='慢响应');
  assert.match(await summary.innerText(),/共 2 张订单.*200 件/);
  await search.fill('不存在');await page.waitForFunction(()=>document.querySelector('.sourcing-list-summary')?.textContent.includes('共 0'));
  assert.match(await summary.innerText(),/共 0 张订单.*0 件/);
  await search.fill('失败');await page.getByText('列表读取失败',{exact:true}).waitFor();assert.equal(await summary.count(),0);
  await search.fill('');await page.waitForFunction(()=>document.querySelector('.sourcing-list-summary')?.textContent.includes('1,700'));
  await page.getByRole('combobox',{name:'性别',exact:true}).selectOption('男装');
  await page.getByRole('combobox',{name:'订单状态',exact:true}).selectOption('ie');
  await page.getByRole('combobox',{name:'合同回签',exact:true}).selectOption('pending');
  await summary.waitFor();assert.ok(queries.some(q=>q.gender==='男装'&&q.stage==='ie'&&q.contractReturn==='pending'&&q.page==='1'));
  const layout=await page.evaluate(()=>{const f=document.querySelector('.sourcing-search').getBoundingClientRect(),s=document.querySelector('.sourcing-list-summary').getBoundingClientRect(),l=document.querySelector('.sourcing-order-list').getBoundingClientRect();return {filterBottom:f.bottom,summaryTop:s.top,summaryBottom:s.bottom,listTop:l.top,summaryRight:s.right,width:innerWidth,font:getComputedStyle(document.querySelector('.sourcing-list-summary')).fontSize};});
  assert.ok(layout.summaryTop>=layout.filterBottom&&layout.summaryBottom<=layout.listTop&&layout.summaryRight<=width);assert.equal(layout.font,'12px');assert.deepEqual(errors,[]);
  if(process.env.SUMMARY_EVIDENCE_DIR){await mkdir(process.env.SUMMARY_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SUMMARY_EVIDENCE_DIR,`${width}.png`),fullPage:true});}
  await page.close();console.log(`PASS ${width}: full totals across pages, zero/reset, late response/error isolation, combined filters, inline layout`);
 }
} finally {await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(output,{recursive:true,force:true});}
