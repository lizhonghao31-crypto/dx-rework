import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-material-')),evidence=process.env.MATERIAL_EVIDENCE,results=[],errors=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/erp-task-context.tsx'),name:'MaterialClosure',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const context=await browser.newContext({viewport}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const url=role=>`http://127.0.0.1:${server.address().port}/ui/digital-pattern-room?fixtureScenario=material-closure-${role}&taskView=handle`;
  await page.goto(url('clerk'));const form=page.locator('.development-material-check-form');await form.waitFor();
  assert.equal(await page.getByRole('button',{name:'确认面料决定',exact:true}).count(),0);
  assert.match(await page.locator('[aria-label="问题面料报告与决定"]').innerText(),/TEST 色牢度风险/);
  assert.equal(await page.getByLabel('TEST 深蓝弹力牛仔布使用情况',{exact:true}).inputValue(),'pending');assert.match(await form.innerText(),/空白占位/);
  await page.getByLabel('TEST 深蓝弹力牛仔布使用情况',{exact:true}).selectOption('use');
  for(const field of ['实物已到','数量相符','颜色相符','规格相符'])await page.getByRole('checkbox',{name:`TEST 深蓝弹力牛仔布 ${field}`,exact:true}).check();
  await page.getByLabel('TEST 配布使用情况',{exact:true}).selectOption('unused');await page.getByRole('button',{name:'保存核料输入',exact:true}).click();
  await page.getByText('本轮不使用的材料须记录与设计师确认的对象及说明',{exact:true}).waitFor();assert.equal(await page.getByText('本轮不使用的材料须记录与设计师确认的对象及说明',{exact:true}).count(),1);
  await page.getByLabel('已向哪位设计师确认',{exact:true}).fill('TEST 王设计师');await page.getByLabel('不使用确认说明',{exact:true}).fill('TEST 已核实该配布本轮不用');await page.getByLabel('缺项 / 备注',{exact:true}).fill('TEST 保存四项与备注');
  await page.getByRole('button',{name:'保存核料输入',exact:true}).click();await page.getByText('核料输入已保存，尚未完成本次核料。',{exact:true}).waitFor();
  await page.reload();await form.waitFor();assert.equal(await page.getByLabel('TEST 配布使用情况',{exact:true}).inputValue(),'unused');assert.equal(await page.getByLabel('缺项 / 备注',{exact:true}).inputValue(),'TEST 保存四项与备注');
  for(const field of ['实物已到','数量相符','颜色相符','规格相符'])assert.equal(await page.getByRole('checkbox',{name:`TEST 深蓝弹力牛仔布 ${field}`,exact:true}).isChecked(),true);
  await page.getByRole('button',{name:'核对完成并提交',exact:true}).click();await page.getByText('问题面料尚未允许使用，请供应链总监或 Root 在本页决定',{exact:true}).waitFor();assert.equal(await page.getByText('问题面料尚未允许使用，请供应链总监或 Root 在本页决定',{exact:true}).count(),1);
  await page.goto(url('clerk')+'&fixtureBasis=1');
  const facts=page.locator('.development-task-material-facts');
  assert.doesNotMatch(await facts.innerText(),/已提交核料：使用|已提交核料：不用/);
  assert.match(await facts.innerText(),/保存草稿不生效/);
  await page.goto(url('root'));await page.getByRole('button',{name:'确认面料决定',exact:true}).waitFor();await page.goto(url('director'));
  const decisions=page.locator('[aria-label="问题面料报告与决定"]');await decisions.getByLabel('本次明确决定').selectOption('停止使用');await decisions.getByLabel('决定依据与说明').fill('TEST 明确停用');await decisions.getByRole('button',{name:'确认面料决定'}).click();await page.getByRole('heading',{name:'已决定停止使用，不能以核料勾选放行'}).waitFor();
  await decisions.getByLabel('本次明确决定').selectOption('允许使用');await decisions.getByLabel('决定依据与说明').fill('TEST 总监复核明确允许');await decisions.getByRole('button',{name:'确认面料决定'}).click();await page.getByRole('heading',{name:'已明确允许使用，仍须完成实际核料'}).waitFor();
  await page.goto(url('clerk'));await form.waitFor();assert.equal(await page.getByRole('checkbox',{name:'TEST 深蓝弹力牛仔布 颜色相符',exact:true}).isChecked(),true);
  if(evidence)await page.screenshot({path:join(evidence,`material-${viewport.width}.png`),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
  await page.getByRole('button',{name:'核对完成并提交',exact:true}).click();await page.waitForURL(/arrangement=/);
  results.push({viewport,checks:['clerk confirmation pending despite legacy false','unused reason required','four checks and note survive reload','saved and rejected drafts never appear as applied facts','one error only','root/director decision in same material page','explicit stop then allow','clerk resumes and navigates to arrangement','no page overflow']});await context.close();
 }
 for(const [count,viewport] of [[1,{width:1440,height:900}],[7,{width:390,height:844}],[100,{width:1440,height:900}]]){
  const context=await browser.newContext({viewport}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/ui/digital-pattern-room?fixtureScenario=material-closure-clerk&taskView=handle&fixtureMaterials=${count}`);
  const form=page.locator('.development-material-verification');await form.waitFor();
  assert.equal(await form.locator('.material-verification-card').count(),count);
  assert.equal(await page.getByLabel('核对结果',{exact:true}).count(),0);
  const before=await page.evaluate(()=>window.taskContextFixture.requests.filter(r=>r.method!=='GET').length);
  for(const field of ['实物已到','数量相符','颜色相符','规格相符'])await page.getByRole('button',{name:`${field}全选`,exact:true}).click();
  assert.equal(await page.evaluate(()=>window.taskContextFixture.requests.filter(r=>r.method!=='GET').length),before);
  assert.equal(await page.getByRole('checkbox',{name:'TEST 材料1长名称 实物已到',exact:true}).isChecked(),true);
  if(count>1){
   assert.equal(await page.getByLabel('TEST 材料2长名称使用情况',{exact:true}).inputValue(),'pending');
   assert.equal(await page.getByLabel('TEST 材料3长名称使用情况',{exact:true}).inputValue(),'unused');
   assert.equal(await page.getByRole('checkbox',{name:'TEST 材料4长名称 实物已到',exact:true}).isChecked(),false);
   assert.equal(await page.getByRole('checkbox',{name:'TEST 材料5长名称 颜色相符',exact:true}).isChecked(),false);
   assert.equal(await page.getByRole('checkbox',{name:'TEST 材料6长名称 规格相符',exact:true}).isChecked(),false);
  }
  if(count===100)assert.equal(await page.getByRole('checkbox',{name:'TEST 材料100长名称 数量相符',exact:true}).isChecked(),true);
  await page.getByRole('button',{name:'保存核料输入',exact:true}).click();await page.getByText('核料输入已保存，尚未完成本次核料。',{exact:true}).first().waitFor();
  await page.reload();await form.waitFor();assert.equal(await page.getByRole('checkbox',{name:'TEST 材料1长名称 规格相符',exact:true}).isChecked(),true);
  assert.equal(await page.evaluate(()=>window.taskContextFixture.requests.filter(r=>r.path.endsWith('/check')).length),0);
  await page.getByRole('button',{name:'核对完成并提交',exact:true}).click();await page.getByText('TEST 缺料／不符尚未解决，已保存输入但本次核料未完成',{exact:true}).waitFor();
  assert.doesNotMatch(page.url(),/arrangement=/);
  assert.match(await form.innerText(),/输入已保存，本次核料尚未取得完成回执/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  if(evidence)await page.screenshot({path:join(evidence,`bulk-${count}-${viewport.width}.png`),fullPage:true});
  results.push({count,viewport,checks:['all four independent selects',...(count>1?['pending and unused preserved','known missing and mismatch protected']:[]),'no write before explicit save','whole page including final row','save reload remains draft','check rejection no navigation','portaled submit still owns form','no page overflow']});await context.close();
 }
 const legacy=await browser.newPage();await legacy.goto(`http://127.0.0.1:${server.address().port}/ui/digital-pattern-room?fixtureScenario=material-check&taskView=handle&fixtureLegacy=1`);
 await legacy.getByRole('heading',{name:'核料输入功能尚未就绪',exact:true}).waitFor();
 assert.equal(await legacy.locator('.development-material-check-form').count(),0);
 assert.equal(await legacy.getByRole('button',{name:'核对完成并提交',exact:true}).count(),0);
 assert.equal(await legacy.evaluate(()=>window.taskContextFixture.requests.filter(r=>r.method!=='GET').length),0);
 results.push({checks:['missing verification protocol stops writes','legacy required false is never interpreted as clerk unused']});await legacy.close();
 assert.deepEqual(errors,[]);
}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual components with synthetic TEST responses; API/transactions/notifications verified separately in isolated PostgreSQL. No real orders or deployment.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
