import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const dir=await mkdtemp(join(tmpdir(),'dx-date-task-header-'));let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:dir,lib:{entry:resolve('tests/fixtures/date-target-task-header.tsx'),name:'DateTask',formats:['iife']}}});
 const files=await readdir(dir),js=await readFile(join(dir,files.find(f=>f.endsWith('.js'))),'utf8');
 server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(`<html><meta charset="utf-8"><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('heading',{name:'船样 · 第1轮',exact:true}).waitFor();
 const deadline=await page.locator('section p').filter({hasText:'截止：'}).innerText();assert.doesNotMatch(deadline,/无时限/);assert.match(deadline,/2026-10-26/);
 const text=await page.locator('body').innerText();assert.match(text,/主办：TEST师傅/);assert.match(text,/时间(?:依据|记录)：/);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({localOnly:true,synthetic:true,dateTargetDeadline:true,ownerAndTimeQualitySeparate:true,passed:true}));
 for(const mode of ['missing','unlimited','duration']){
  await page.goto(`http://127.0.0.1:${server.address().port}?mode=${mode}`);await page.getByRole('heading',{name:'船样 · 第1轮',exact:true}).waitFor();
  const value=await page.locator('section p').filter({hasText:'截止：'}).innerText();
  assert.match(value,mode==='missing'?/截止时间待核实/:mode==='unlimited'?/无时限/:/2026/);
  await page.getByText('历史记录与核实',{exact:true}).click();
  const row=await page.getByRole('row').filter({hasText:'TEST原登记人'}).innerText();assert.match(row,mode==='missing'?/截止时间待核实/:mode==='unlimited'?/无时限/:/2026/);
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({localOnly:true,synthetic:true,missingTarget:true,unlimited:true,duration:true,originalRevisionTable:true,passed:true}));

}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
