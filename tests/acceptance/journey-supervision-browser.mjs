import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'journey-sla-ui-')),evidence=process.env.JOURNEY_SLA_EVIDENCE,results=[],errors=[];let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/journey-supervision-ui.tsx'),name:'JourneyUi',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
 const origin=`http://127.0.0.1:${server.address().port}`,id='00000000-0000-4000-8000-000000000010';
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/ui/digital-cockpit');
  await page.getByLabel('时效统计范围').waitFor();
  assert.equal(await page.getByText('时间规则待完善',{exact:true}).count(),0);await page.getByText('1单未填齐出货日 · 查看',{exact:false}).click();
  await page.getByRole('button',{name:'1 单有PO没填客户出货日，整单交期统计只含已填PO'}).click();assert.equal(new URL(page.url()).searchParams.get('missing'),'customer_date');
  const beforeClear=await page.evaluate(()=>window.journeyEvidence.reads.filter(path=>path.includes('/journeys?')).length);await page.getByRole('button',{name:'清除缺项筛选'}).click();assert.equal(new URL(page.url()).searchParams.has('missing'),false);await page.waitForFunction(n=>window.journeyEvidence.reads.filter(path=>path.includes('/journeys?')).length>n,beforeClear);await page.locator('.journey-orders[aria-busy=false]').waitFor();await page.getByRole('button',{name:'TEST-长款号-20261026',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(evidence,`overview-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'TEST-长款号-20261026',exact:true}).click();await page.getByLabel('订单全景详情').waitFor();const details=page.locator('.journey-sla-details');assert.equal(await details.getAttribute('open'),null);
  await details.locator('summary').click();await page.getByLabel('节点时效依据，可横向滚动').waitFor();assert.ok((await details.innerText()).includes('前置工艺回仓预计未定'));await details.locator('summary').click();
  assert.equal(await page.getByRole('link',{name:'进入该节点办理'}).count(),0);assert.ok(await page.getByRole('link',{name:'查看节点记录'}).count());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(evidence,`detail-${width}.png`),fullPage:true});
  await page.goto(origin+`/ui/digital-cockpit?selected=${id}&refresh-fail=1`);await page.getByLabel('订单全景详情').waitFor();await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.getByRole('alert').filter({hasText:'仍显示上次读取资料'}).waitFor();assert.equal(await page.getByLabel('订单全景详情').count(),1);
  await page.goto(origin+'/ui/my-tasks');await page.getByRole('heading',{name:'开发纸样',exact:true}).waitFor();
  await page.getByText('逾期',{exact:true}).waitFor();await page.getByText('已读',{exact:true}).waitFor();assert.match(await page.locator('.my-todo-metrics').textContent(),/3 天 0 小时/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(evidence,`todos-${width}.png`),fullPage:true});
  assert.deepEqual(await page.evaluate(()=>window.journeyEvidence.writes.filter(path=>!path.includes("/notifications/claim"))),[]);results.push({width,fullAppRoute:true,coverageFilter:true,detailsFolded:true,readOnlyLinks:true,refreshPreservesFacts:true,overflow:false});await page.close();
 }
 assert.deepEqual(errors,[]);await writeFile(join(evidence,'results.json'),JSON.stringify({scope:'Actual App route/components with synthetic HTTP; native API/PG verified separately',results,errors},null,2));console.log(JSON.stringify(results));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
