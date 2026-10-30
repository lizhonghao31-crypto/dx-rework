import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const input=JSON.parse(await readFile(process.env.SLA_FACTORY_UI_INPUT,'utf8'));
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-bulk-sla-ui-')),evidence=process.env.SLA_FACTORY_UI_EVIDENCE,results=[],errors=[];
let browser,server,page;
try{
 await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/factory-batch-ui.tsx'),name:'BulkSlaUi',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.factoryInput=${JSON.stringify(input).replace(/</g,'\\u003c')};${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
 for(const width of (process.env.CASE_WIDTH?[Number(process.env.CASE_WIDTH)]:[1440,390]))for(const mode of (process.env.CASE_MODE?[process.env.CASE_MODE]:['warehouse','qc','logistics','readonly','conflict'])){
  page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  const action=mode==='qc'?'qc':mode==='logistics'?'logistics':'dispatch';
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}&factoryAction=${action}`);
  await page.locator('.factory-batch-panel').waitFor();
  const panel=page.locator('.factory-batch-panel');
  if(mode==='warehouse'||mode==='conflict'){
   const form=panel.locator('#factory-dispatch form');await form.locator('input[type=number]').first().fill('10');await form.getByRole('combobox',{name:'发厂时间',exact:true}).selectOption('manual');await form.locator('input[type=datetime-local]').fill('2026-10-23T10:00');await form.getByRole('button',{name:'保存本批实际发厂'}).click();
   await page.waitForFunction(()=>window.factoryRequests.length>0);assert.equal((await page.evaluate(()=>window.factoryRequests[0].body)).lines[0].quantity,10);
   if(mode==='conflict')await page.getByRole('alert').waitFor();
  }else if(mode==='qc'){
   assert.ok(await panel.getByText('本批检查与放行',{exact:true}).count());
   await panel.getByText('不合格批次是否先发',{exact:true}).first().click();
   assert.ok(await panel.getByText('质检允许本批先发，保留不合格结论',{exact:true}).count());
  }else if(mode==='logistics')assert.ok(await panel.getByRole('button',{name:'保存工艺记录'}).count());
  else assert.equal(await panel.getByRole('button').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${mode} ${width} overflow`);
  await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});results.push({mode,width});await page.close();page=null;
 }
 assert.deepEqual(errors,[]);
}finally{await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual full React page with isolated PostgreSQL response fixture; synthetic HTTP commands, not authenticated full application acceptance.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
