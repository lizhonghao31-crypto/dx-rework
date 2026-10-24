import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const input=JSON.parse(await readFile(process.env.SLA_BULK_UI_INPUT,'utf8'));
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-bulk-sla-ui-')),evidence=process.env.SLA_BULK_UI_EVIDENCE,results=[],errors=[];
let browser,server,page;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/bulk-sla-ui.tsx'),name:'BulkSlaUi',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.bulkSlaInput=${JSON.stringify(input).replace(/</g,'\\u003c')};${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
 for(const width of [1440,390])for(const mode of ['warehouse','owner','readonly','conflict']){
  page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`);
  const panel=page.locator('.bulk-fabric-panel');await panel.locator('summary').waitFor();
  assert.equal(await panel.getAttribute('open'),null);
  if(mode==='warehouse')await page.screenshot({path:join(evidence,`collapsed-${width}.png`),fullPage:true});
  await panel.locator('summary').click();
  if(mode==='warehouse'||mode==='conflict'){
   await panel.getByLabel('检验情况').fill('TEST保留完整验布情况');
   await panel.getByRole('button',{name:'保存验布报告'}).click();
   await page.waitForFunction(()=>window.bulkSlaRequests.length>0);
   assert.equal((await page.evaluate(()=>window.bulkSlaRequests[0].body)).arrivedAt,'2026-10-22T00:00:00.000Z');
   if(mode==='conflict')await page.getByRole('alert').waitFor();
  }else if(mode==='owner'){
   assert.equal(await panel.getByRole('button',{name:'保存验布报告'}).count(),0);
   await panel.getByLabel('原因及后续安排').fill('TEST先处理色差，保留不合格事实');
   await panel.getByRole('button',{name:'先处理',exact:true}).click();
   await page.waitForFunction(()=>window.bulkSlaRequests.length>0);
   assert.equal((await page.evaluate(()=>window.bulkSlaRequests[0].body)).allowUse,false);
  }else assert.equal(await panel.getByRole('button').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${mode} ${width} overflow`);
  await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});results.push({mode,width});await page.close();page=null;
 }
 assert.deepEqual(errors,[]);
}finally{await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual full React page with isolated PostgreSQL response fixture; synthetic HTTP commands, not authenticated full application acceptance.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
