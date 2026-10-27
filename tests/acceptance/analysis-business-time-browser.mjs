import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const dir=await mkdtemp(join(tmpdir(),'dx-analysis-business-time-'));let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:dir,lib:{entry:resolve('tests/fixtures/analysis-business-time.tsx'),name:'DateTask',formats:['iife']}}});
 const files=await readdir(dir),js=await readFile(join(dir,files.find(f=>f.endsWith('.js'))),'utf8');
 server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(`<html><meta charset="utf-8"><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/ui/digital-analysis?from=2026-01-01&to=2027-12-31&scope=snapshot`);
 await page.getByText('TEST分析原单-3',{exact:true}).waitFor();
 assert.equal(await page.getByText(/业务观察/).count(),3);
 for(let index=0;index<3;index++){const row=page.getByRole('row').filter({hasText:`TEST分析原单-${index}`});assert.match(await row.innerText(),/业务观察/);}
 assert.doesNotMatch(await page.getByRole('row').filter({hasText:'TEST分析原单-3'}).innerText(),/业务观察/);
 assert.ok((await page.evaluate(()=>window.analysisClockFixture.requests)).every(r=>r.method==='GET'));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({localOnly:true,synthetic:true,originalAnalysisComponent:true,mixedBusinessObservations:3,ordinaryRow:1,readOnly:true,passed:true}));

}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
