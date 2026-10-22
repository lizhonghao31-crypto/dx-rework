import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-task-session-')),evidence=process.env.TASK_SESSION_EVIDENCE;
const rows=[];let browser,server,current;
const user=id=>({status:'authorized',user:{id,displayName:'TEST '+id,isRoot:false,businessRoles:['development_clerk'],capabilities:['todo:view','digital_production:view']}});
const firstId='10000000-0000-4000-8000-000000000001',secondId='10000000-0000-4000-8000-000000000002';
try{
 await build({configFile:false,logLevel:'warn',esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('apps/web/src/main.tsx'),name:'ActualTaskSessionApp',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await Promise.all(files.filter(f=>f.endsWith('.css')).map(f=>readFile(join(out,f),'utf8')));
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css.join('\n')}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(!path.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);return;}
  const run=current,record={path,method:req.method,actor:run.actor,status:null};run.requests.push(record);
  const send=(value,status=200)=>{if(res.destroyed)return;record.status=status;res.writeHead(status,{'content-type':'application/json','x-dx-rework-actor-id':run.actor});res.end(JSON.stringify(value));};
  if(path==='/api/auth/me'){
   run.authCalls++;
   if(run.mode==='hang'){run.release=()=>send(user(run.actor));return;}
   if(run.mode==='cancel'){res.destroy();return;}
   if(run.authCalls>=2&&[401,403,503].includes(run.mode)){send({error:{code:'TEST',message:'TEST identity response'}},run.mode);return;}
   setTimeout(()=>send(user(run.actor)),20);return;
  }
  if(path==='/api/todos/mine'){send({todos:[],activeModule:'digital_production',moduleCounts:{rework:0,sourcing:0,digital_production:0},page:1,pageSize:15,totalCount:0,totalPages:0});return;}
  if(path.endsWith('/indicator')){send({pendingCount:0,unreadCount:0});return;}
  if(path.includes('/notifications/')){send({notification:null,remainingCount:0});return;}
  send({error:{code:'TEST_READ_NOT_CONNECTED',message:'TEST standalone read not connected'}},503);
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const mode of ['navigation',503,401,403,'hang','identity-change']){
  console.log(JSON.stringify({starting:mode}));
  const run=current={mode,actor:firstId,authCalls:0,requests:[]},context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  if(mode==='hang')await page.clock.install();
  await page.goto(origin+'/ui/my-tasks',{waitUntil:'domcontentloaded'});
  const ready=()=>page.getByRole('heading',{name:'我的待办',exact:true}).waitFor();
  if(mode==='hang'){
   await page.waitForFunction(()=>document.body.innerText.includes('正在'));await page.clock.fastForward(10_100);
   await page.getByRole('heading',{name:'当前身份尚未读取',exact:true}).waitFor();assert.equal(run.authCalls,1);assert.equal(run.requests.filter(r=>r.path==='/api/todos/mine').length,0);
   run.mode='healthy';run.release?.();await page.getByRole('button',{name:'重新读取登录状态',exact:true}).click();await page.clock.resume();await ready();
  }else if(mode===503){
   await page.getByRole('heading',{name:'当前身份尚未读取',exact:true}).waitFor();assert.equal(run.requests.filter(r=>r.path==='/api/todos/mine').length,0);
   run.mode='healthy';await page.getByRole('button',{name:'重新读取登录状态',exact:true}).click();await ready();
  }else if(mode===401||mode===403){
   await page.waitForFunction(()=>document.body.innerText.includes('登录'));await new Promise(done=>setTimeout(done,100));
   assert.equal(await page.getByRole('heading',{name:'我的待办',exact:true}).count(),0);assert.equal(run.requests.filter(r=>r.path==='/api/todos/mine').length,0);
  }else{
   await ready();await page.waitForFunction(()=>!document.body.innerText.includes('正在读取待办'));
   const firstCalls=run.authCalls;await page.getByRole('link',{name:'生产管理座舱',exact:true}).first().click();await page.waitForURL('**/ui/digital-cockpit**');
   if(mode==='identity-change')run.actor=secondId;
   await page.getByRole('link',{name:/^我的待办/}).first().click();await page.waitForURL('**/ui/my-tasks**');await ready();
   await new Promise(done=>setTimeout(done,200));assert.ok(run.authCalls-firstCalls<=2,'A returned page has bounded identity reads');
   if(mode==='navigation'){
    await page.goBack();await page.waitForURL('**/ui/digital-cockpit**');await page.goForward();await ready();
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await ready();await new Promise(done=>setTimeout(done,200));
    assert.ok(run.authCalls<=7,'Back/forward and restored-page identity admission settle');
   }else{
    await page.waitForFunction(id=>sessionStorage!==null&&history.state?.dxTodoQueryUser===id,secondId);
    assert.ok(run.requests.some(r=>r.path==='/api/todos/mine'&&r.actor===secondId));
   }
  }
  if(mode!==401&&mode!==403)await page.getByText(/您当前的任务已全部完成/).waitFor();
  await new Promise(done=>setTimeout(done,200));
  const calls=run.authCalls;await new Promise(done=>setTimeout(done,180));assert.equal(run.authCalls,calls,'No self-triggered revalidation loop');assert.equal(errors.length,0);
  const row={mode,authCalls:run.authCalls,todoReads:run.requests.filter(r=>r.path==='/api/todos/mine').length,requests:run.requests,errors};rows.push(row);
  if(evidence)await page.screenshot({path:join(evidence,String(mode)+'.png'),fullPage:true});await context.close();
 }
 if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({actualEntry:'apps/web/src/main.tsx',results:rows,limits:'Synthetic localhost identity and business reads; real App/AuthGate/MyTodosPage and internal links; no live session or writes.'},null,2));
 console.log(JSON.stringify({passed:rows.length,cases:rows.map(r=>r.mode)}));
}finally{await browser?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});}
