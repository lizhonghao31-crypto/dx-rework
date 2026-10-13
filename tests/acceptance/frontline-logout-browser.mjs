import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp,readFile,readdir,rm,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'frontline-exit-'));let browser,server;const results=[];
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/frontline-logout.tsx'),name:'FrontlineExit',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
 const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script>';
 server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const path of ['/ui/frontline/tasks?kind=worker','/ui/frontline/tasks?kind=worker&single=1','/ui/frontline','/ui/receiving']){
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+path);const button=page.getByRole('button',{name:'退出登录',exact:true});await button.waitFor();
  assert.equal(await page.locator('.app-shell').count(),0);if(path.includes('single=1'))await page.locator('.frontline-task-workspace').waitFor();assert.equal(await button.count(),1);assert.equal(await button.isVisible(),true);
  const style=await button.evaluate(el=>({border:getComputedStyle(el).borderTopWidth,font:getComputedStyle(el).fontSize}));assert.equal(style.border,'0px');assert.equal(style.font,'13px');
  await button.click();await page.getByRole('heading',{name:'已退出登录'}).waitFor();assert.deepEqual(errors,[]);results.push({path,bareRouteExitVisible:true,smallBorderlessExit:true,explicitLogoutCompleted:true});await page.close();
 }
 const report={localSyntheticOnly:true,results};if(process.env.LOGOUT_EVIDENCE_DIR){await mkdir(process.env.LOGOUT_EVIDENCE_DIR,{recursive:true});await writeFile(join(process.env.LOGOUT_EVIDENCE_DIR,'bare-frontline-result.json'),JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
