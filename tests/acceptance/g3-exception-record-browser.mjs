import assert from 'node:assert/strict';
import {build} from 'vite';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp('/tmp/g3-case-browser-'),dir=process.env.CASE_REPAIR_EVIDENCE,results=[],errors=[];
let browser,server;
try {
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/acceptance/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/g3-exception-record.tsx'),name:'ExactCase',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(dir)await mkdir(dir,{recursive:true});
 const origin=`http://127.0.0.1:${server.address().port}`,id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const mode of ['finance','root','missing','case403','order403']){
  const page=await browser.newPage({viewport});page.on('pageerror',e=>errors.push({mode,width:viewport.width,error:e.message}));
  await page.addInitScript(mode=>sessionStorage.setItem('g3-case-mode',mode),mode);
  await page.route('**/*',route=>{const req=route.request();if(req.isNavigationRequest()&&new URL(req.url()).origin===origin)return route.continue();throw Error('Unexpected browser network: '+req.resourceType());});
  const target=`/acceptance/ui/tasks/${id(500)}?node=settlement_followup&case=${id(mode==='missing'?999:801)}`;
  await page.goto(origin+target);
  if(mode==='order403')await page.getByText('TEST order denied',{exact:true}).waitFor();
  else if(mode==='missing')await page.getByText('该供应商扣款任务不在当前有效台账中。',{exact:true}).waitFor();
  else if(mode==='case403')await page.waitForFunction(()=>window.exceptionRecordFixture.requests.some(r=>r.path.endsWith('/external-responsibilities')));
  else {await page.getByText('TEST exact case 801',{exact:true}).waitFor();assert.equal(await page.locator('.external-case').count(),1);}
  assert.equal(await page.getByText('TEST exact case 800',{exact:true}).count(),0,'unrelated case is not shown');
  const requests=await page.evaluate(()=>window.exceptionRecordFixture.requests);assert.deepEqual(requests.filter(r=>r.method!=='GET'),[]);
  if(mode==='order403')assert.equal(requests.some(r=>r.path.endsWith('/external-responsibilities')),false,'order denial prevents case reads');
  if(mode==='case403')assert.equal(await page.locator('.external-case').count(),0,'case API denial does not expose a record');
  if(dir)await page.screenshot({path:join(dir,`${mode}-${viewport.width}.png`),fullPage:true});
  results.push({mode,viewport,target,requests});await page.close();
 }
 assert.deepEqual(errors,[]);
 if(dir)await writeFile(join(dir,'results.json'),JSON.stringify({status:'passed',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),uncommitted:true,results,errors,limitation:'Actual App/components, synthetic authorized/denied responses on loopback. No production or Acceptance requests.'},null,2));
 console.log(JSON.stringify({status:'passed',cases:results.length,evidence:dir}));
} finally {await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(out,{recursive:true,force:true});}
