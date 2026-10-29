import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readdir,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'vite';
const playwright=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const {chromium}=playwright.chromium?playwright:playwright.default;
const out=await mkdtemp(join(tmpdir(),'dx-pr2-time-')),evidence=process.env.PR2_TIME_BROWSER_EVIDENCE,results=[],errors=[],external=[];
let browser,server,page;
try{
 await build({configFile:false,logLevel:'warn',esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/order-date-dispatch-time.tsx'),name:'Pr2TimeInput',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=(await Promise.all(files.filter(f=>f.endsWith('.css')).map(f=>readFile(join(out,f),'utf8')))).join('\n');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const address=`http://127.0.0.1:${server.address().port}`;
 const selected=(width,name)=>{const key=`${width}:${name}`;return (!process.env.PR2_TIME_BROWSER_CASE||new RegExp(process.env.PR2_TIME_BROWSER_CASE).test(key))&&(!process.env.PR2_TIME_BROWSER_SKIP||!new RegExp(process.env.PR2_TIME_BROWSER_SKIP).test(key));};
 for(const width of (process.env.CASE_WIDTH?[Number(process.env.CASE_WIDTH)]:[1440,390])){
  const context=await browser.newContext({viewport:{width,height:960},isMobile:width===390,hasTouch:width===390,timezoneId:'America/Los_Angeles'});
  const open=async(query)=>{if(page)await page.close();page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort();});await page.goto(address+query);};
  const snapshot=()=>page.evaluate(()=>structuredClone(window.pr2TimeFixture));
  const tap=async(button)=>width===390?button.tap():button.click();
  for(const mode of ['past','current','future','ordinary']){
   if(!selected(width,`date-${mode}`))continue;
   await open(`/?view=date&mode=${mode}`);const day=mode==='past'?'2026-10-15':mode==='future'?'2026-12-10':'2026-10-29',date=page.getByLabel('客户下单日期',{exact:true}),confirm=page.getByRole('button',{name:'确认下单',exact:true});
   await page.waitForFunction(day=>document.querySelector('#development-customer-order-date')?.getAttribute('max')===day,day);assert.equal(await date.inputValue(),day);assert.equal(await confirm.isEnabled(),true);
   await page.getByLabel('PO 1 正式款号 / PO',{exact:true}).fill('TEST-PO');await page.getByLabel('PO 1 颜色',{exact:true}).fill('TEST黑');await page.getByLabel('尺码列 1',{exact:true}).fill('M');await page.getByLabel('PO 1 订购数量 1',{exact:true}).fill('10');await page.getByLabel('PO 1 出货日期',{exact:true}).fill('2028-03-01');
   await tap(confirm);await page.waitForFunction(()=>window.pr2TimeFixture.requests.some(r=>r.method==='POST'&&r.path.endsWith('/confirm')));
   const state=await snapshot(),post=state.requests.find(r=>r.method==='POST'&&r.path.endsWith('/confirm'));assert.equal(post.body.orderDate,day);assert.ok(state.requests.filter(r=>r.path.endsWith('/options')).every(r=>new URLSearchParams(r.search).get('sourceId')=== '00000000-0000-4000-8000-000000000001'));
   results.push({width,case:`${mode} scoped default/max/precheck/submit`});
  }
  if(selected(width,'refresh')){
  await open('/?view=date&mode=future');const date=page.getByLabel('客户下单日期',{exact:true});await page.waitForFunction(()=>document.querySelector('#development-customer-order-date')?.getAttribute('max')==='2026-12-10');await date.fill('2026-12-09');await page.getByLabel('PO 1 颜色',{exact:true}).fill('TEST保留输入');
  await page.evaluate(()=>{window.pr2TimeFixture.day='2026-12-11';window.dispatchEvent(new Event('acceptance-clock-changed'));});await page.waitForFunction(()=>document.querySelector('#development-customer-order-date')?.getAttribute('max')==='2026-12-11');assert.equal(await date.inputValue(),'2026-12-09');assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue(),'TEST保留输入');
  await page.evaluate(()=>{window.pr2TimeFixture.failCalendar=true;window.dispatchEvent(new Event('acceptance-clock-changed'));});await page.getByRole('alert').filter({hasText:'TEST 日期暂不可读'}).waitFor();assert.equal(await page.getByRole('button',{name:'确认下单',exact:true}).isDisabled(),true);assert.equal(await date.inputValue(),'2026-12-09');
  await page.evaluate(()=>{window.pr2TimeFixture.failCalendar=false;});await tap(page.getByRole('button',{name:'重新读取本单日期',exact:true}));await page.waitForFunction(()=>{const button=document.querySelector('button[type=submit]');return Boolean(button&&!button.disabled);});assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue(),'TEST保留输入');results.push({width,case:'clock day refresh and failed read retain draft without wall fallback'});
  }
  if(selected(width,'saved')){
  await open('/?view=date&mode=future&saved=1');await page.waitForFunction(()=>document.querySelector('#development-customer-order-date')?.getAttribute('max')==='2026-12-10');assert.equal(await page.getByLabel('客户下单日期',{exact:true}).inputValue(),'2026-10-15');assert.equal(await page.getByLabel('PO 1 订购数量 1',{exact:true}).inputValue(),'10');assert.equal(await page.getByLabel('客户下单日期',{exact:true}).isDisabled(),true);results.push({width,case:'published customer facts remain unchanged and locked'});
  }
  for(const mode of ['batch','legacy'])for(const manual of [false,true]){
   if(!selected(width,`factory-${mode}-${manual?'manual':'current'}`))continue;
   await open(`/?view=factory&mode=${mode}&factoryAction=dispatch`);const submit=page.getByRole('button',{name:mode==='batch'?'保存本批实际发厂':'确认整款已实际发厂',exact:true});await submit.waitFor();
   const form=submit.locator('xpath=ancestor::form');if(mode==='batch')await form.locator('input[type=number]').first().fill('10');
   const choice=form.getByRole('combobox',{name:'发厂时间',exact:true});assert.equal(await choice.inputValue(),'current');
   if(manual){await choice.selectOption('manual');const time=form.getByLabel('实际发厂时间（北京时间）',{exact:true});await time.fill('2026-12-10T19:56:17.915');assert.equal(await time.getAttribute('step'),'0.001');assert.equal(await time.evaluate(input=>input.validity.valid),true);await choice.selectOption('current');await choice.selectOption('manual');assert.equal(await time.inputValue(),'2026-12-10T19:56:17.915');}
   const bounds=await choice.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+2,`${mode} ${width} time choice usable`);
   if(!manual)await page.evaluate(()=>{window.pr2TimeFixture.failDispatch=true;});
   await tap(submit);await page.waitForFunction(()=>window.pr2TimeFixture.requests.some(r=>r.method==='POST'&&r.path.endsWith('/dispatch')));
   if(!manual){await page.getByRole('alert').filter({hasText:'TEST 未取得成功回执'}).waitFor();await tap(submit);await page.waitForFunction(()=>window.pr2TimeFixture.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/dispatch')).length===2);}
   const posts=(await snapshot()).requests.filter(r=>r.method==='POST'&&r.path.endsWith('/dispatch'));
   if(manual)assert.equal(posts[0].body.occurredAt,'2026-12-10T11:56:17.915Z');else{assert.equal(Object.hasOwn(posts[0].body,'occurredAt'),false);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(posts[0].key,posts[1].key);}
   results.push({width,case:`${mode} ${manual?'manual milliseconds':'server current, unrelated scene ignored, unknown outcome retry'}`});
  }
  if(page)await page.close();page=null;await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log(JSON.stringify({passed:results.length,results,errors,external,limits:['Synthetic localhost HTTP responses. Real server clock/permissions/guards are verified separately by native PostgreSQL tests.','Mobile evidence uses Chromium touch emulation; no claim about a physical Android/iOS native picker.']}));
}finally{if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'results.json'),JSON.stringify({results,errors,external},null,2));}if(page)await page.close();if(browser)await browser.close();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});}
