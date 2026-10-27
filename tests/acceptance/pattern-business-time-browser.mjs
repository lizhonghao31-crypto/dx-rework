import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const dir=await mkdtemp(join(tmpdir(),'dx-pattern-business-time-'));let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:dir,lib:{entry:resolve('tests/fixtures/pattern-business-time.tsx'),name:'DateTask',formats:['iife']}}});
 const files=await readdir(dir),js=await readFile(join(dir,files.find(f=>f.endsWith('.js'))),'utf8');
 server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(`<html><meta charset="utf-8"><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/ui/digital-pattern-room?lane=sewing&scope=all&state=all`);
 await page.getByText('TEST-clock-5',{exact:true}).waitFor();
 for(let index=0;index<6;index++){
  const card=page.getByRole('button').filter({has:page.getByText(`TEST-clock-${index}`,{exact:true})});
  const text=await card.innerText();assert.match(text,index<3?/停留 2小时/:index===5?/停留 1小时/:/时间待核实/);
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({localOnly:true,synthetic:true,mixedBusinessClocks:3,unknownClocks:2,completedEndpoint:1,passed:true}));

}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
