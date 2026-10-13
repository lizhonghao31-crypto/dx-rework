import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
const { chromium }=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const root=await mkdtemp(join(tmpdir(),'session-path-')),html={},sessions={main:true,acceptance:true},results=[];
let server,browser;
try {
 for(const [scope,base] of [['main','/'],['acceptance','/acceptance/']]){
  const out=join(root,scope);
  await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':JSON.stringify(base),'process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/session-logout.tsx'),name:'IsolatedLogout',formats:['iife']}}});
  const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
  html[scope]='<!doctype html><meta charset="utf-8"><style>'+css+'</style><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script>';
 }
 server=createServer((request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname,scope=path.startsWith('/acceptance/')?'acceptance':'main',local=scope==='acceptance'?path.slice('/acceptance'.length):path;
  // Match the actual API's first-cookie selection: the more specific path comes first.
  const sid=(request.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('test_session='))?.slice('test_session='.length);
  const send=(status,body)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body));};
  if(local==='/api/auth/me'){send(sessions[scope]&&sid===scope?200:401,{status:'authorized',user:{id:'TEST-'+scope,displayName:'TEST '+scope,isRoot:true,businessRoles:['root_superuser'],capabilities:[]}});return;}
  if(local==='/api/auth/logout'){assert.equal(sid,scope);sessions[scope]=false;response.setHeader('set-cookie',`test_session=; Path=${scope==='main'?'/':'/acceptance/'}; Max-Age=0`);send(204,{});return;}
  if(local.startsWith('/api/')){send(404,{});return;}
  response.writeHead(200,{'content-type':'text/html;charset=utf-8'});response.end(html[scope]);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const exitScope of ['acceptance','main']){
  sessions.main=true;sessions.acceptance=true;const context=await browser.newContext({viewport:{width:1440,height:960}});
  await context.addCookies([{name:'test_session',value:'main',domain:'127.0.0.1',path:'/'},{name:'test_session',value:'acceptance',domain:'127.0.0.1',path:'/acceptance/'}]);
  const main=await context.newPage(),acceptance=await context.newPage();
  await main.goto(origin+'/ui/home');await acceptance.goto(origin+'/acceptance/ui/home');
  for(const page of [main,acceptance])await page.getByRole('heading',{name:'TEST 受保护业务'}).waitFor();
  const exiting=exitScope==='main'?main:acceptance,remaining=exitScope==='main'?acceptance:main;
  await exiting.locator('aside .session-logout').click();await exiting.getByRole('heading',{name:'已退出登录'}).waitFor();
  await remaining.reload();await remaining.getByRole('heading',{name:'TEST 受保护业务'}).waitFor();
  const keys=await remaining.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('dx-rework:logged-out:')&&!k.endsWith(':completed')&&!k.endsWith(':login-intent')));
  assert.deepEqual(keys,[`dx-rework:logged-out:${exitScope==='main'?'/':'/acceptance/'}`]);
  assert.equal(sessions[exitScope],false);assert.equal(sessions[exitScope==='main'?'acceptance':'main'],true);
  results.push({exitScope,otherSessionRetained:true,storageChannelAndCookiePathsIsolated:true});await context.close();
 }
 const report={localSyntheticOnly:true,results};if(process.env.LOGOUT_EVIDENCE_DIR){await mkdir(process.env.LOGOUT_EVIDENCE_DIR,{recursive:true});await writeFile(join(process.env.LOGOUT_EVIDENCE_DIR,'path-isolation.json'),JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
