import assert from 'node:assert/strict';import {build} from 'vite';import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-pr5-n05-')),results=[],errors=[];let browser,server;
try{
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/acceptance/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/erp-order-layout-rework.tsx'),name:'ActualN05Ownership',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=(await Promise.all(files.filter(f=>f.endsWith('.css')).map(f=>readFile(join(out,f),'utf8')))).join('\n');
 server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`);});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const width of [1280,390])for(const stage of ['N04','N05'])for(const role of ['root','ie']){
  const page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/acceptance/ui/tasks/00000000-0000-4000-8000-000000000002?stage=${stage}&role=${role}&node=whole_order_review`);
  const responsibility=page.getByLabel('最终数量确认责任',{exact:true});await responsibility.waitFor();const text=await responsibility.innerText();
  assert.ok(text.includes('负责角色：尾部主管'));assert.ok(text.includes('实际负责人：未记录具体负责人'));assert.equal(text.includes('TEST IE'),false);
  assert.ok(text.includes(stage==='N04'?'前置条件：待全部执行报数完成':'前置条件：执行报数已完成，可办理最终数量确认'));
  assert.equal((await page.evaluate(()=>window.orderLayoutFixture.requests)).filter(r=>r.method!=='GET').length,0);
  results.push({width,stage,role,person:'unknown',writes:0});await page.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.length,results,errors}));if(process.env.PR5_N05_EVIDENCE)await writeFile(process.env.PR5_N05_EVIDENCE,JSON.stringify({results,errors,limits:['Actual rework page and original local role fixture; no live Acceptance, quantity or wage write.']},null,2));
}finally{await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});}
