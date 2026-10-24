import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const input=JSON.parse(await readFile(process.env.SLA_FACTORY_QC_UI_INPUT,'utf8'));
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-factory-qc-ui-')),evidence=process.env.SLA_FACTORY_QC_UI_EVIDENCE,results=[],errors=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/factory-batch-ui.tsx'),name:'SampleUi',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.factoryInput=${JSON.stringify(input).replace(/</g,'\\u003c')};${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=productionQc&factoryAction=productionQc`);
  const form=page.locator('form').filter({has:page.getByText('本次检查',{exact:true})});
  await form.locator('input[type=datetime-local]').fill(new Date(Date.now()+8*3600000).toISOString().slice(0,16));
  await form.locator('select').first().selectOption('合格');
  await form.getByRole('button',{name:'保存工厂检查'}).click();await page.waitForFunction(()=>window.factoryRequests.length===1);
  const request=await page.evaluate(()=>window.factoryRequests[0]);assert.ok(request.path.endsWith('/production-qc'));assert.equal(request.body.checks.length,1);assert.equal(request.body.checks[0].result,'合格');assert.equal(request.body.factoryDecisionId,null);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(evidence,`factory-qc-${width}.png`),fullPage:true});results.push({width,recorded:true,overflow:false});await page.close();
 }
 assert.deepEqual(errors,[]);await writeFile(join(evidence,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
