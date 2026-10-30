import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createServer} from 'node:http';
const input=JSON.parse(await readFile(process.env.PR3_HISTORY_UI_INPUT,'utf8'));
assert.equal(input.frames.length,12,'Require all four native clock cases and three rounds');
const playwright=await import(process.env.PLAYWRIGHT_IMPORT||'playwright'),{chromium}=playwright.chromium?playwright:playwright.default;
const out=await mkdtemp(join(tmpdir(),'dx-round-history-')),evidence=process.env.PR3_HISTORY_UI_EVIDENCE,results=[],errors=[],external=[];
let browser,server,page;
try{
 await build({configFile:false,logLevel:'warn',esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/rework-round-history.tsx'),name:'Pr3History',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=(await Promise.all(files.filter(f=>f.endsWith('.css')).map(f=>readFile(join(out,f),'utf8')))).join('\n');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.pr3HistoryInput=${JSON.stringify(input).replace(/</g,'\\u003c')};${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=','base64');
 server=createServer((req,res)=>{if(req.url.includes('/pattern-room/attachments/')){res.writeHead(200,{'content-type':'image/png'});res.end(png);}else{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);}});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const origin=`http://127.0.0.1:${server.address().port}`;
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},isMobile:width===390,hasTouch:width===390});
  for(let index=0;index<input.frames.length;index++){
   const frame=input.frames[index],detail=frame.detail;
   page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort();});
   const query=new URLSearchParams({case:String(index),round:detail.currentRoundId,node:'completed',readOnly:'history'});
   await page.goto(`${origin}/ui/pattern-room/orders/${detail.orderId}?${query}`);await page.locator('.pattern-readonly-workspace').waitFor();
   const material=page.locator('.pattern-material-section');assert.equal(await material.locator('.pattern-material-grid > li').count(),frame.index+1);
   const links=await material.getByRole('link',{name:'下载',exact:true}).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));
   const actual=links.map(link=>new URL(link,origin).pathname.match(/attachments\/([^/]+)\//)[1]).sort();assert.deepEqual(actual,detail.attachments.map(f=>f.attachmentId).sort());
   assert.equal(await page.locator('form').count(),0);assert.equal(await page.locator('.pattern-workspace-actions').count(),0);
   assert.ok((await page.locator('.pattern-history-notice').innerText()).includes('历史节点 · 只读'));
   const requests=await page.evaluate(()=>window.pr3HistoryState.requests);assert.ok(requests.every(r=>r.method==='GET'));
   const reads=requests.filter(r=>new URL(r.path,origin).pathname.endsWith('/pattern-room/orders/'+detail.orderId));assert.ok(reads.length);assert.ok(reads.every(r=>new URL(r.path,origin).searchParams.get('round')===detail.currentRoundId));
   results.push({width,mode:frame.mode,round:frame.index,attachments:actual.length});await page.close();page=null;
  }
  const frame=input.frames[0];page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(`${origin}/ui/pattern-room/orders/${frame.detail.orderId}?case=0&round=${frame.detail.currentRoundId}&node=completed&readOnly=history&unknown=1`);await page.getByText('TEST历史附件归属或绑定审计时间未留证',{exact:true}).waitFor();assert.equal(await page.locator('.pattern-material-grid > li').count(),0);assert.equal(await page.locator('form').count(),0);results.push({width,case:'explicit unknown instead of current attachments'});await page.close();page=null;await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log(JSON.stringify({passed:results.length,errors,external}));
}finally{
 if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'results.json'),JSON.stringify({results,errors,external,limits:['Actual product React component with isolated PostgreSQL round history DTOs; synthetic localhost GET transport.','Unknown notice is an explicit synthetic projection. Thumbnail bytes are local layout placeholders, not real OSS download evidence.','Mobile is Chromium touch emulation, not a physical device.']},null,2));}
 if(page)await page.close();await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});
}
