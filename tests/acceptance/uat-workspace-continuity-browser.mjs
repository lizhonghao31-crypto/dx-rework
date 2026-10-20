import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-uat-workspace-')),evidence=process.env.UAT_WORKSPACE_EVIDENCE;
const results=[],errors=[],external=[];let browser,server,activePage;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/uat-workspace-continuity.tsx'),name:'UatWorkspaceContinuity',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const viewport of [{width:1440,height:900},{width:1366,height:768},{width:390,height:844}]){
  const page=await browser.newPage({viewport});activePage=page;page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const request=route.request();if(request.isNavigationRequest()&&new URL(request.url()).hostname==='127.0.0.1')return route.continue();external.push(request.url());return route.abort();});
  const goto=(mode,extra='')=>page.goto(`http://127.0.0.1:${server.address().port}/ui/digital-pattern-room?mode=${mode}&scope=all${extra}`);
  const requested=async(value)=>page.waitForFunction(value=>window.uatWorkspaceFixture.requests.some(r=>new URL(r.path,location.origin).searchParams.get('search')===value),value);
  for(const [mode,label] of [['pattern','关键词'],['designer','款号 / PO'],['bulk','关键词'],['production','搜索产前与发厂订单'],['cockpit','综合搜索']]){
   await goto(mode);const input=page.getByRole('textbox',{name:label,exact:true});await input.waitFor();
   assert.equal(await page.getByRole('button',{name:/^(查询|搜索|筛选|应用筛选)$/}).count(),0);
   await input.fill('TEST-LJY');await requested('TEST-LJY');await page.waitForFunction(()=>new URLSearchParams(location.search).get('search')==='TEST-LJY');
   await input.fill('TEST LJY');await requested('TEST LJY');assert.equal(await input.inputValue(),'TEST LJY');
   await input.dispatchEvent('compositionstart');await input.fill('TEST-LJY-ORDER');await page.waitForTimeout(600);
   assert.equal(await page.evaluate(()=>window.uatWorkspaceFixture.requests.some(r=>new URL(r.path,location.origin).searchParams.get('search')==='TEST-LJY-ORDER')),false,'IME interim input does not fetch');
   await input.dispatchEvent('compositionend');await requested('TEST-LJY-ORDER');
   await input.fill('slow');await page.waitForFunction(()=>Boolean(window.uatWorkspaceFixture.releaseSlow));
   await input.fill('TEST-LJY');await requested('TEST-LJY');await page.waitForFunction(()=>new URLSearchParams(location.search).get('search')==='TEST-LJY');
   await page.evaluate(()=>window.uatWorkspaceFixture.releaseSlow());await page.waitForFunction(()=>window.uatWorkspaceFixture.slowSettled);await page.waitForTimeout(200);
   assert.doesNotMatch(await page.locator('body').innerText(),/999/);assert.equal(await page.getByRole('alert').count(),0);
   await input.fill('');await page.waitForFunction(()=>!new URLSearchParams(location.search).get('search'));await page.waitForTimeout(200);
   assert.deepEqual(await page.evaluate(()=>window.uatWorkspaceFixture.unexpected),[]);
   results.push({viewport,mode,checks:['automatic search and internal spaces','composition waits until committed','late old result cannot overwrite fresh query','clear restores original query','no query button or unexpected API']});
  }
  await goto('pattern');await page.locator('.pattern-task-card').first().waitFor();
  assert.equal(await page.locator('.pattern-board-column').count(),7);assert.equal(await page.locator('.pattern-task-card').count(),21);
  for(const column of await page.locator('.pattern-board-column').all()){assert.equal(await column.locator('.pattern-task-card').count(),3);assert.equal(await column.locator('.pattern-lane-heading > span').innerText(),'5');}
  if(viewport.width>800){const geometry=await page.evaluate(()=>{const center=e=>{const b=e.getBoundingClientRect();return b.y+b.height/2;};return [center(document.querySelector('.pattern-board-filters nav')),center(document.querySelector('.pattern-board-filters input')), ...[...document.querySelectorAll('.pattern-board-filters select')].map(center)];});assert.ok(Math.max(...geometry)-Math.min(...geometry)<20,`one-row filters: ${geometry}`);}
  if(evidence)await page.screenshot({path:join(evidence,`pattern-${viewport.width}.png`)});
  await page.locator('.pattern-board-column').first().getByRole('button',{name:'查看全部',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.pattern-task-card').length===5);assert.equal(await page.locator('.pattern-board-column').count(),1);
  results.push({viewport,mode:'pattern-preview',checks:['seven lanes, three cards each, full count5 each','view all reveals full lane','desktop tabs and filters share one row']});
  await goto('misc','&section=legacy');const rows=page.locator('.misc-record-table tbody tr');await rows.first().waitFor();assert.equal(await rows.count(),15);assert.equal(await page.locator('.misc-record-table th').count(),8);
  const headings=await page.locator('.misc-record-table th').allTextContents();assert.deepEqual(headings,['任务名称 / 编号','关联款号','状态','申请人','执行人','要求完成','提交时间','操作']);
  const long=rows.nth(1);assert.match(await long.innerText(),/长任务名称.*完整阅读/);const href=await rows.first().getByRole('link',{name:'查看',exact:true}).getAttribute('href');assert.match(href,/returnTo=/);
  const docWidth=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(docWidth<=viewport.width+1,`page overflow ${docWidth}/${viewport.width}`);
  const region=page.getByRole('region',{name:'杂事记录，可横向滚动查看完整字段'});await region.focus();await page.keyboard.press('End');await region.evaluate(e=>e.scrollLeft=e.scrollWidth);assert.ok(await region.evaluate(e=>e.scrollLeft>0||e.scrollWidth===e.clientWidth));
  await page.evaluate(()=>window.scrollTo(0,0));await region.evaluate(e=>e.scrollLeft=0);if(evidence)await page.screenshot({path:join(evidence,`misc-${viewport.width}.png`)});
  await page.getByRole('navigation',{name:'订单打板/杂事看板分页'}).getByRole('button',{name:'2',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.misc-record-table tbody tr').length===7);await page.getByRole('navigation',{name:'订单打板/杂事看板分页'}).getByRole('button',{name:'1',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.misc-record-table tbody tr').length===15);
  await page.getByRole('link',{name:'申请杂事',exact:true}).click();const drawer=page.getByRole('dialog',{name:'申请杂事',exact:true});await drawer.waitFor();await drawer.getByText('小时单价：10 元/小时',{exact:true}).waitFor();
  const bounds=await drawer.boundingBox();assert.ok(bounds.x>=0&&Math.abs(bounds.x+bounds.width-viewport.width)<2,'drawer is attached to right edge');
  assert.equal(await drawer.getByRole('textbox',{name:'关联款号 / PO（选填）',exact:true}).count(),0);assert.match(await drawer.innerText(),/可留空/);
  const task=drawer.getByRole('textbox',{name:'任务名称 *',exact:true});await task.fill('TEST-LJY 失败后保留的杂事');await drawer.getByRole('textbox',{name:'备注',exact:true}).fill('TEST 备注');
  await page.keyboard.press('Escape');await page.locator('[data-system-dialog-cancel]').waitFor();await page.locator('[data-system-dialog-cancel]').click();assert.equal(await task.inputValue(),'TEST-LJY 失败后保留的杂事');
  await drawer.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('[data-system-dialog-cancel]').click();assert.equal(await task.inputValue(),'TEST-LJY 失败后保留的杂事');
  await drawer.getByRole('button',{name:'提交杂事',exact:true}).click();await drawer.getByRole('alert').filter({hasText:'TEST提交失败'}).waitFor();assert.equal(await task.inputValue(),'TEST-LJY 失败后保留的杂事');
  if(evidence)await page.screenshot({path:join(evidence,`misc-drawer-${viewport.width}.png`)});
  await drawer.getByRole('button',{name:'提交杂事',exact:true}).click();await page.waitForURL(/pattern-room\/orders\/00000000-0000-4000-8000-000000000999/);
  const posts=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('uatMiscPosts')));assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(posts[1].body.association,null);assert.equal(posts[1].body.taskName,'TEST-LJY 失败后保留的杂事');
  await goto('misc','&section=legacy&noCreate=1');await page.locator('.misc-record-table tbody tr').first().waitFor();assert.equal(await page.getByRole('link',{name:'申请杂事',exact:true}).count(),0);
  results.push({viewport,mode:'misc',checks:['all eight original fields in compact15-row list and page2 seven rows','full long name and local scroll','same-view right drawer reuses original optional association/hourly form','dirty Escape cancelled without loss','failed submission retained and retry succeeded','existing no-create role stays denied']});
  await page.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}catch(error){if(evidence&&activePage&&!activePage.isClosed())await writeFile(join(evidence,'failure.json'),JSON.stringify({message:error.message,body:await activePage.locator('body').innerText(),state:await activePage.evaluate(()=>window.uatWorkspaceFixture)},null,2));throw error;}
finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,external,limits:'Actual components, synthetic TEST requests only; no production or Acceptance data.'},null,2));await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({passed:results.length,results,errors,external}));
