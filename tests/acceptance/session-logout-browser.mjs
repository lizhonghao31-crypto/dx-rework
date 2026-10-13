import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-logout-browser-')),evidence=process.env.LOGOUT_EVIDENCE_DIR;
const screenshots=process.env.LOGOUT_SCREENSHOTS!=='0';
const sessions=new Map(),counts={logout:0,dd:0,mobile:0,qr:0,me:0},results=[];
let browser,server;
try{
 if(evidence)await mkdir(evidence,{recursive:true});
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/session-logout.tsx'),name:'LogoutFixture',formats:['iife']}}});
 const files=await readdir(output),js=await readFile(join(output,files.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(output,files.find(n=>n.endsWith('.css'))),'utf8');
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script></html>';
 const user=role=>({status:'authorized',user:{id:'TEST-'+role,displayName:'TEST '+role,capabilities:role==='root'||role==='worker'?['todo:view']:['sourcing:view','todo:view'],isRoot:role==='root',businessRoles:role==='root'?['root_superuser']:role==='worker'?['worker']:['order_merchandiser']}});
 server=createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost'),cookies=Object.fromEntries((request.headers.cookie||'').split(';').filter(Boolean).map(c=>c.trim().split('=')));
  const sid=cookies.test_session,role=cookies.test_role||'root';
  const send=(status,body)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(body===undefined?'':JSON.stringify(body));};
  if(url.pathname==='/__test/dd-request'){counts.dd++;send(200,{});return;}
  if(url.pathname==='/api/auth/me'){counts.me++;send(sessions.get(sid)?200:401,sessions.get(sid)?user(role):{});return;}
  if(url.pathname==='/api/auth/logout'){
   counts.logout++;
   if(cookies.test_fail==='1'){send(503,{});return;}
   sessions.set(sid,false);response.setHeader('set-cookie','test_session=; Path=/; Max-Age=0');send(204);return;
  }
  if(url.pathname==='/api/auth/client-config'){send(200,{corpId:'TEST-corp',mobileClientId:'TEST-mobile'});return;}
  if(url.pathname==='/api/auth/qr/start'){send(200,{authorizationUrl:'TEST',frame:{clientId:'TEST',redirectUri:'TEST',state:'TEST-state',scope:'openid',responseType:'code',prompt:'consent'}});return;}
  if(url.pathname==='/api/auth/mobile'||url.pathname==='/api/auth/qr/complete'){
   if(url.pathname.endsWith('mobile'))counts.mobile++;else counts.qr++;
   const finish=()=>{const next=randomUUID();sessions.set(next,true);response.setHeader('set-cookie','test_session='+next+'; Path=/; HttpOnly; SameSite=Lax');send(200,user(role));};
   if(cookies.test_delay==='1')setTimeout(finish,250);else finish();return;
  }
  if(url.pathname==='/api/todos/mine/indicator'){response.setHeader('x-dx-rework-actor-id','TEST-'+role);send(200,{pendingCount:0});return;}
  if(url.pathname.startsWith('/api/')){send(200,{});return;}
  response.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});response.end(html);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const context=async(role='root',mobile=false)=>{
  const ctx=await browser.newContext({viewport:{width:mobile?390:1440,height:960},...(mobile?{userAgent:'DingTalk TEST mobile'}:{})});
  const sid=randomUUID();sessions.set(sid,true);await ctx.addCookies([{name:'test_session',value:sid,url:origin},{name:'test_role',value:role,url:origin}]);return ctx;
 };
 const open=async ctx=>{const page=await ctx.newPage();page.on('pageerror',error=>{throw error;});await page.goto(origin+'/ui/home');await page.getByRole('heading',{name:'TEST 受保护业务'}).waitFor();return page;};
 const protectedAgain=async page=>{try{await page.getByRole('heading',{name:'TEST 受保护业务'}).waitFor({timeout:10000});}catch(error){console.log(JSON.stringify({counts,body:await page.locator('body').innerText(),storage:await page.evaluate(()=>({local:{...localStorage},tab:{...sessionStorage},cookie:document.cookie}))}));throw error;}};
 const logout=async(page,mobile=false)=>{if(mobile)await page.getByLabel('更多导航').click();await page.getByRole('button',{name:'退出登录',exact:true}).filter({visible:true}).click();await page.getByRole('heading',{name:'已退出登录'}).waitFor();};
 for(const role of ['root','ordinary']){
  const ctx=await context(role),page=await open(ctx),button=page.locator('aside .session-logout');
  const metrics=await button.evaluate(element=>{const css=getComputedStyle(element);return {font:css.fontSize,border:css.borderTopWidth,background:css.backgroundColor,width:element.getBoundingClientRect().width,svg:element.querySelector('svg').getBoundingClientRect().width};});
  assert.equal(metrics.font,'13px');assert.equal(metrics.border,'0px');assert.equal(metrics.background,'rgba(0, 0, 0, 0)');assert.ok(metrics.width>=80&&metrics.width<=100);assert.equal(metrics.svg,14);
  await button.focus();assert.equal(await button.evaluate(el=>getComputedStyle(el).outlineWidth),'2px');
  await button.evaluate(element=>element.blur());
  if(role==='root'&&evidence&&screenshots)await page.screenshot({path:join(evidence,'desktop-logout.png')});
  await logout(page);await page.reload();await page.getByRole('heading',{name:'已退出登录'}).waitFor();assert.equal(await page.getByRole('heading',{name:'TEST 受保护业务'}).count(),0);
  results.push({role,scenario:'placement-keyboard-refresh',metrics});await ctx.close();
 }
 {
  const ctx=await context(),a=await open(ctx),b=await open(ctx),before=counts.logout;
  await a.getByLabel('TEST 未保存内容').fill('TEST unsaved');await a.locator('aside .session-logout').click();await a.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(counts.logout,before);
  await a.locator('aside .session-logout').click();await a.getByRole('button',{name:'放弃修改',exact:true}).click();await a.getByRole('heading',{name:'已退出登录'}).waitFor();await b.getByRole('heading',{name:'已退出登录'}).waitFor();assert.equal(counts.logout,before+1);
  await b.reload();await b.getByRole('heading',{name:'已退出登录'}).waitFor();results.push({scenario:'unsaved-cancel-then-confirm-two-tabs'});await ctx.close();
 }
 {
  const ctx=await context(),page=await open(ctx);await ctx.addCookies([{name:'test_fail',value:'1',url:origin}]);await page.locator('aside .session-logout').click();await page.getByRole('alert').filter({hasText:'退出登录未完成'}).waitFor();await page.getByRole('heading',{name:'TEST 受保护业务'}).waitFor();
  await ctx.clearCookies({name:'test_fail'});await logout(page);results.push({scenario:'failure-retry'});await ctx.close();
 }
 {
  const ctx=await context('root',true),page=await open(ctx);if(evidence&&screenshots){await page.getByLabel('更多导航').click();await page.locator('.session-logout--mobile').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'mobile-logout.png')});await page.getByLabel('更多导航').click();}
  await logout(page,true);const before=counts.dd;await page.reload();await page.getByRole('heading',{name:'已退出登录'}).waitFor();await page.waitForTimeout(100);assert.equal(counts.dd,before);
  await page.getByRole('button',{name:'重新登录',exact:true}).click();await protectedAgain(page);assert.equal(counts.dd,before+1);results.push({scenario:'dingtalk-explicit-relogin'});await ctx.close();
 }
 {
  const ctx=await context(),page=await open(ctx);await logout(page);await page.getByRole('button',{name:'重新登录',exact:true}).click();await page.getByRole('button',{name:'TEST 扫码确认'}).click();await protectedAgain(page);results.push({scenario:'explicit-qr-relogin'});await ctx.close();
 }
 {
  const ctx=await context(),page=await open(ctx);await page.evaluate(()=>history.pushState({},'', '/ui/orders'));await logout(page);await page.goBack();await page.getByRole('heading',{name:'已退出登录'}).waitFor();assert.equal(await page.getByRole('heading',{name:'TEST 受保护业务'}).count(),0);results.push({scenario:'history-back'});await ctx.close();
 }
 {
  const ctx=await context(),page=await open(ctx),before=counts.me;
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));assert.equal(await page.locator('html').getAttribute('data-session-suspended'),'true');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await page.getByRole('heading',{name:'TEST 受保护业务'}).waitFor();assert.ok(counts.me>before);assert.equal(await page.locator('html').getAttribute('data-session-suspended'),null);
  await logout(page);await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await page.getByRole('heading',{name:'已退出登录'}).waitFor();results.push({scenario:'bfcache-mask-revalidation-logout'});await ctx.close();
 }
 {
  const ctx=await context('root',true);await ctx.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('TEST storage blocked');};});
  const page=await open(ctx);await logout(page,true);const before=counts.dd;await page.reload();await page.getByRole('heading',{name:'已退出登录'}).waitFor();assert.equal(counts.dd,before);
  await page.getByRole('button',{name:'重新登录',exact:true}).click();await protectedAgain(page);results.push({scenario:'storage-blocked-cookie-fallback-explicit-relogin'});await ctx.close();
 }
 {
  const ctx=await context(),a=await open(ctx),b=await open(ctx);await logout(a);await b.getByRole('heading',{name:'已退出登录'}).waitFor();
  await ctx.addCookies([{name:'test_role',value:'ordinary',url:origin}]);await a.getByRole('button',{name:'重新登录',exact:true}).click();await a.getByRole('button',{name:'TEST 扫码确认'}).click();await protectedAgain(a);await protectedAgain(b);
  await b.getByText('TEST ordinary',{exact:true}).waitFor();assert.equal(await b.locator('aside').getByText('平台管理',{exact:true}).count(),0);results.push({scenario:'sibling-login-rechecks-new-identity-and-permissions'});await ctx.close();
 }
 {
  const ctx=await context('root',true),a=await open(ctx),beforeMobile=counts.mobile,beforeLogout=counts.logout;
  await ctx.addCookies([{name:'test_delay',value:'1',url:origin}]);const b=await ctx.newPage();await b.goto(origin+'/auth/login');
  while(counts.mobile===beforeMobile)await b.waitForTimeout(10);
  await logout(a,true);await b.getByRole('heading',{name:'已退出登录'}).waitFor();
  while(counts.logout<beforeLogout+2)await b.waitForTimeout(10);
  assert.equal(await a.evaluate(()=>fetch('/api/auth/me').then(response=>response.status)),401);
  results.push({scenario:'late-login-response-revoked-after-sibling-logout'});await ctx.close();
 }
 {
  const ctx=await context('worker',true),page=await open(ctx);await page.getByLabel('更多导航').click();
  assert.equal(await page.locator('.mobile-primary-navigation__drawer').getByRole('link').count(),0);
  await page.getByRole('button',{name:'退出登录',exact:true}).filter({visible:true}).click();await page.getByRole('heading',{name:'已退出登录'}).waitFor();results.push({scenario:'worker-empty-overflow-logout-reachable'});await ctx.close();
 }
 {
  const ctx=await context('root',true);await ctx.addInitScript(()=>{const write=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===localStorage)throw new Error('TEST persistent storage blocked');return write.call(this,key,value);};});
  const a=await open(ctx),b=await open(ctx);await logout(a,true);await b.getByRole('heading',{name:'已退出登录'}).waitFor();
  const before=counts.dd;await a.getByRole('button',{name:'重新登录',exact:true}).click();await protectedAgain(a);await protectedAgain(b);assert.equal(counts.dd,before+1);
  results.push({scenario:'fallback-sibling-explicit-login-broadcast-fresh-admission'});await ctx.close();
 }
 if(evidence)await writeFile(join(evidence,'browser-result.json'),JSON.stringify({results,counts},null,2));console.log(JSON.stringify({success:true,results,counts}));
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(output,{recursive:true,force:true});}
