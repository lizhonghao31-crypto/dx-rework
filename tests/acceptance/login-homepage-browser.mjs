import assert from 'node:assert/strict';
// All authentication calls use TEST fixtures; never point this runner at an online host.
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.LOGIN_SCREENSHOT_DIR??'/tmp/dx-login-homepage-evidence';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium'});const checks=[],errors=[];
async function setup({width=1672,height=941,logged=false,noRole=false,mobile=false,failStart=0,failSdk=false,origin=process.env.LOGIN_LOCAL_ORIGIN || 'http://127.0.0.1:3395',base=''}={}){
 assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'local TEST server required');
 const context=await browser.newContext({viewport:{width,height},...(mobile?{userAgent:'TEST DingTalk Mobile'}:{})});const page=await context.newPage();const count={me:0,start:0,complete:0,sdk:0,mobileConfig:0};
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({failSdk})=>{
  window.__testFrameLogin=(container,params,success,failure)=>{window.__qrParams=params;window.__qrSuccess=success;window.__qrError=failure;const node=document.getElementById(container.id);const frame=document.createElement('iframe');frame.title='钉钉二维码测试夹具';frame.width=container.width;frame.height=container.height;frame.style.border='0';frame.srcdoc='<html><body style="margin:0;background:white;display:grid;place-items:center;height:100vh;font:18px sans-serif;color:#234">TEST QR</body></html>';node.append(frame);};
  if(!failSdk)window.DTFrameLogin=window.__testFrameLogin;
  window.dd={runtime:{permission:{requestAuthCode:({onFail})=>onFail({test:true})}}};
 },{failSdk});
 await page.route('**/ddlogin.js',async route=>{count.sdk++;if(failSdk&&count.sdk===1)await route.abort('failed');else await route.fulfill({contentType:'application/javascript',body:'window.DTFrameLogin=window.__testFrameLogin;'});});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/auth/me')){count.me++;await route.fulfill(logged||noRole?{json:{status:noRole?'no_role':'authorized',user:{id:'11111111-1111-4111-8111-111111111111',displayName:'TEST',isRoot:true,businessRoles:['root_superuser'],capabilities:[]}}}:{status:401,json:{error:{code:'UNAUTHORIZED'}}});}
  else if(path.endsWith('/auth/qr/start')){count.start++;await new Promise(r=>setTimeout(r,100));if(count.start<=failStart)await route.fulfill({status:429,json:{error:{code:'RATE_LIMITED'}}});else await route.fulfill({json:{authorizationUrl:'https://example.test/mock',frame:{clientId:'TEST',redirectUri:`${origin}${base}/auth/qr/relay`,state:'TEST-state-'+count.start,scope:'openid',responseType:'code',prompt:'consent'}}});}
  else if(path.endsWith('/auth/qr/complete')){count.complete++;const body=route.request().postDataJSON();assert(body.authCode==='TEST-code');assert(body.state==='TEST-state-'+count.start);logged=true;await route.fulfill({json:{ok:true}});}
  else if(path.endsWith('/auth/client-config')){count.mobileConfig++;await route.fulfill({json:{corpId:'TEST-corp',mobileClientId:'TEST-client'}});}
  else await route.fulfill({json:{}});
 });
 await page.route(`**${base}/ui/my-tasks`,route=>route.fulfill({contentType:'text/html',body:'<html><body>TEST original role landing</body></html>'}));
 return {context,page,count,origin,base,close:()=>context.close()};
}
async function ready(t,path='/auth/login'){await t.page.goto(t.origin+t.base+path);await t.page.locator('#dx-rework-dingtalk-qr iframe').waitFor();}
try{
 for(const [width,height]of [[1672,941],[1920,1080],[1440,900],[1366,768],[1024,768],[768,1024],[390,844],[320,700]]){
  const t=await setup({width,height});await ready(t);const geometry=await t.page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,frame:document.querySelector('#dx-rework-dingtalk-qr').getBoundingClientRect().toJSON(),card:document.querySelector('.dx-login-qr-card').getBoundingClientRect().toJSON(),hero:document.querySelector('.dx-login-hero').getBoundingClientRect().toJSON()}));
  assert(geometry.scroll<=geometry.client,`${width}: horizontal overflow ${geometry.scroll}`);assert.equal(geometry.frame.width,300);assert.equal(t.count.start,1);assert.equal(t.count.me,1);
  await t.page.screenshot({path:`${out}/login-${width}.png`,fullPage:true});checks.push({case:'layout',width,height,geometry,requests:{...t.count}});await t.close();
 }
 for(const scale of [1.25,1.5]){
  // Browser zoom reduces the CSS viewport; preserve the physical screen size.
  const t=await setup({width:Math.floor(1366/scale),height:Math.floor(768/scale)});await ready(t);const geometry=await t.page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,frame:document.querySelector('#dx-rework-dingtalk-qr').getBoundingClientRect().width}));assert(geometry.scroll<=geometry.client);assert.equal(geometry.frame,300);checks.push({case:'zoom-equivalent-css-viewport',scale,geometry});await t.close();
 }
 {
  const t=await setup();await ready(t);await t.page.clock.install();await t.page.evaluate(()=>window.__qrError('TEST expired'));await t.page.getByRole('status').filter({hasText:'二维码已失效'}).waitFor();await t.page.clock.runFor(60000);assert.equal(t.count.start,1);
  await t.page.evaluate(()=>{const button=document.querySelector('.dx-login-action button');button.click();button.click();button.click();});await t.page.clock.runFor(1000);await t.page.waitForFunction(()=>window.__qrParams.state==='TEST-state-2');assert.equal(t.count.start,2);checks.push({case:'expire-no-auto-refresh-and-click-dedup',requests:{...t.count}});await t.close();
 }
 for(const options of [{failStart:1},{failSdk:true}]){
  const t=await setup(options);await t.page.goto(t.origin+'/auth/login');await t.page.getByRole('status').filter({hasText:'二维码生成失败'}).waitFor();await t.page.getByRole('button',{name:'重新生成二维码'}).click();await t.page.locator('#dx-rework-dingtalk-qr iframe').waitFor();assert.equal(t.count.start,2);if(options.failSdk)assert.equal(t.count.sdk,2);checks.push({case:options.failSdk?'sdk-error-manual-recovery':'429-manual-recovery',requests:{...t.count}});await t.close();
 }
 {
  const t=await setup();await ready(t);await t.page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://evil.example',data:{type:'dx-rework:dingtalk-qr-code',authCode:'TEST-code',state:'TEST-state-1'}})));assert.equal(t.count.complete,0);
  await t.page.evaluate(()=>window.__qrSuccess({authCode:'TEST-code',state:'TEST-wrong-state'}));await t.page.getByRole('status').filter({hasText:'扫码状态校验失败'}).waitFor();assert.equal(t.count.complete,0);
  await t.page.evaluate(()=>window.__qrSuccess({authCode:'TEST-code',state:'TEST-state-1'}));await t.page.getByText('TEST original role landing').waitFor();assert.equal(t.count.complete,1);checks.push({case:'origin-state-and-original-completion-role-landing',requests:{...t.count}});await t.close();
 }
 for(const path of ['/auth/login','/auth/qr']){
  const t=await setup({logged:true});await t.page.goto(t.origin+path);await t.page.getByText('TEST original role landing').waitFor();assert.equal(t.count.start,0);checks.push({case:'already-logged-no-qr',path,requests:{...t.count}});await t.close();
 }
 {
  const t=await setup({noRole:true});await t.page.goto(t.origin+'/auth/login');await t.page.getByText('当前账号尚未分配业务角色，请联系管理员。').waitFor();assert.equal(t.count.start,0);assert.equal(await t.page.locator('.dx-login-landing').count(),0);checks.push({case:'no-role-original-state',requests:{...t.count}});await t.close();
 }
 for(const path of ['/auth/login','/auth/qr']){
  const t=await setup({mobile:true});await t.page.goto(t.origin+path);await t.page.getByRole('heading',{name:'钉钉安全登录'}).waitFor();await t.page.getByText('钉钉免密认证失败，请重试；仍无法登录请联系管理员确认应用权限。').waitFor();assert.equal(t.count.start,0);assert.equal(await t.page.locator('.dx-login-landing').count(),0);checks.push({case:'dingtalk-original-mobile',path,requests:{...t.count}});await t.close();
 }
 for(const path of ['/auth/login','/auth/qr']){
  const t=await setup({origin:process.env.LOGIN_PREFIX_ORIGIN || 'http://127.0.0.1:3396',base:'/rework'});await ready(t,path);assert.equal(t.count.start,1);const background=await t.page.evaluate(()=>getComputedStyle(document.querySelector('.dx-login-landing')).backgroundImage);assert(background.includes('/rework/'));checks.push({case:'deployment-prefix',path,background});await t.close();
 }
}finally{await browser.close();await writeFile(`${out}/result.json`,JSON.stringify({checks,errors},null,2));}
assert.deepEqual(errors,[]);process.stdout.write(JSON.stringify({checks:checks.length,errors})+'\n');
