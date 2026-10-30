import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createServer} from 'node:http';
const input=JSON.parse(await readFile(process.env.PR4_LOGISTICS_UI_INPUT,'utf8'));
for(const name of ['past shipped','current shipped','future shipped','ordinary shipped','range boundary -1','range boundary 0','range boundary 1','two PO transferred factory scopes','received retained after application','missing shipment evidence'])assert.ok(input.frames.some(f=>f.name===name),`Missing native case ${name}`);
const imported=await import(process.env.PLAYWRIGHT_IMPORT||'playwright'),{chromium}=imported.chromium?imported:imported.default;
const out=await mkdtemp(join(tmpdir(),'dx-logistics-ui-')),evidence=process.env.PR4_LOGISTICS_UI_EVIDENCE,results=[],errors=[],external=[];let browser,server,page;
try{
 await build({configFile:false,logLevel:'warn',esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/factory-logistics-cockpit.tsx'),name:'Pr4Logistics',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=(await Promise.all(files.filter(f=>f.endsWith('.css')).map(f=>readFile(join(out,f),'utf8')))).join('\n');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.pr4LogisticsInput=${JSON.stringify(input).replace(/</g,'\\u003c')};${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((req,res)=>{if(req.url.includes('/attachments/')){res.writeHead(404);res.end();}else{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);}});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});const origin=`http://127.0.0.1:${server.address().port}`;
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},isMobile:width===390,hasTouch:width===390});
  for(const [index,frame] of input.frames.entries()){
   page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort();});
   await page.goto(`${origin}/ui/digital-cockpit?case=${index}`);await page.getByRole('button',{name:frame.detail.designStyleNo,exact:true}).click();
   const details=page.locator('.journey-sla-details');await details.locator('summary').click();
   const rows=details.locator('tbody tr').filter({hasText:'工厂回仓物流预计'}),native=frame.detail.supervision.nodes.filter(n=>n.id.startsWith('return_logistics:'));
   assert.equal(await rows.count(),native.length);
   for(const [i,node] of native.entries()){
    const row=rows.nth(i),windows=node.logisticsWindows??[];assert.equal(await row.locator('.journey-logistics-range').count(),windows.length);
    for(const [j,window] of windows.entries()){
     const text=await row.locator('.journey-logistics-range').nth(j).innerText();assert.ok(text.includes(window.shippedOn));assert.ok(text.includes(window.supplierName));assert.ok(text.includes('未记录实际发货时刻'));
     if(window.arrivalRange){const boundary=at=>new Date(Date.parse(at)+8*3600000).toISOString().replace('T',' ').replace(/\.000Z$/,'').replace(/Z$/,'');assert.ok(text.includes(boundary(window.arrivalRange.fromInclusive)));assert.ok(text.includes(boundary(window.arrivalRange.toExclusive)));assert.ok(text.includes('（含）'));assert.ok(text.includes('（不含）'));}
     assert.equal(text.includes('预计范围已过'),window.estimateExpired);
    }
    assert.ok((await row.innerText()).includes('不是收货硬期限'));if(windows.length)assert.equal(await row.getByText('未启动',{exact:true}).count(),0);
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.getByRole('button',{name:'TEST 原工厂页',exact:true}).click();const original=page.locator('details').filter({has:page.locator('summary').filter({hasText:'工厂发回仓物流预计'})});
   if(frame.factory.returnLogistics?.length){await original.locator('summary').click();for(const window of frame.factory.returnLogistics)assert.ok((await original.innerText()).includes(window.shippedOn));}
   assert.ok((await page.evaluate(()=>window.pr4LogisticsRequests)).every(r=>r.method==='GET'));results.push({width,name:frame.name,poNodes:native.length,ranges:native.reduce((n,r)=>n+(r.logisticsWindows?.length??0),0)});await page.close();page=null;
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log(JSON.stringify({passed:results.length,errors,external}));
}finally{
 if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'results.json'),JSON.stringify({results,errors,external,limits:['Actual cockpit list/detail and factory React components with native isolated PostgreSQL DTOs; localhost read transport.','Chromium desktop/touch emulation; no real login, physical phone, OSS download or onsite evidence.']},null,2));}
 if(page)await page.close();await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});
}
