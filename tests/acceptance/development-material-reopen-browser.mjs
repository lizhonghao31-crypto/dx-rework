import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-material-')),evidence=process.env.D08_EVIDENCE,results=[],errors=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/erp-task-context.tsx'),name:'MaterialClosure',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const width of [1440,390])for(const mode of ['success','reject','lost','malformed','408']){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/ui/digital-pattern-room?fixtureScenario=material-closure-clerk&fixtureBasis=1&fixtureReopen=${mode}`);
  const note=page.getByRole('textbox',{name:'重新核料说明',exact:true}),send=page.getByRole('button',{name:'接回文员重新核料',exact:true});await note.fill('TEST沟通后文员重新确认本轮不用');await send.click();
  if(mode==='reject'){await page.getByText('TEST原补料已提交，请重新读取当前核料任务',{exact:true}).waitFor();assert.equal(await note.inputValue(),'TEST沟通后文员重新确认本轮不用');assert.equal(await send.isEnabled(),true);assert.doesNotMatch(page.url(),/task=/);}
  else if(mode==='success')await page.waitForURL(/task=00000000-0000-4000-8000-000000000851/);
  else{
   await page.getByText(/尚未确认本次提交是否成功/).first().waitFor();assert.equal(await note.isDisabled(),true);assert.equal(await send.isDisabled(),true);
   await page.getByRole('button',{name:'重新读取办理状态',exact:true}).click();await page.waitForURL(/task=00000000-0000-4000-8000-000000000851/);
  }
  const records=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('TEST-reopen-requests')||'[]'));assert.equal(records.length,['success','reject'].includes(mode)?1:2);if(records.length===2)assert.deepEqual(records[0],records[1]);assert.equal(typeof records[0].key,'string');assert.ok(records[0].key.length>0);
  if(evidence)await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});results.push({width,mode,passed:true});await context.close();
 }
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/ui/digital-pattern-room?fixtureScenario=material-closure-director&fixtureBasis=1&fixtureReopen=success`);await page.getByRole('heading',{name:'核料办理',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'接回文员重新核料',exact:true}).count(),0);await page.close();
 assert.deepEqual(errors,[]);
}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual components with synthetic TEST responses; API/transactions/notifications verified separately in isolated PostgreSQL. No real orders or deployment.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
