import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';

// Visual/interaction fixture for the actual component. Real authentication,
// native mutations and database isolation are covered by the PostgreSQL suite.
const base=process.env.CLOCK_UI_URL;
if(!base||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw new Error('CLOCK_UI_URL must be the explicitly started local Vite server');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const web=resolve('apps/web'),stem=`.clock-browser-${process.pid}`,html=resolve(web,`${stem}.html`),entry=resolve(web,`${stem}.tsx`);
const out=resolve(process.env.CLOCK_UI_OUTPUT??'/tmp/daxing-clock-ui');await mkdir(out,{recursive:true});
await writeFile(html,`<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/${stem}.tsx"></script></html>`);
await writeFile(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{AcceptanceClockPanel,AcceptanceClockLauncher}from'./src/acceptance-clock-panel';import'@dx-rework/ui/tokens.css';import'@dx-rework/ui/components.css';import'./src/styles.css';createRoot(document.getElementById('root')!).render(location.search==='?launcher'?<AcceptanceClockLauncher/>:<main style={{maxWidth:1100,margin:'24px auto',padding:12}}><h1>开发单</h1><label>未保存业务输入<input aria-label="未保存业务输入" defaultValue=""/></label><AcceptanceClockPanel resourceId="11111111-1111-4111-8111-111111111111"/><section><h2>原业务办理区</h2><p>开发资料及主操作保留原位置。</p></section></main>);`);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const failures=[],creationAttempts=[];let requests=0;
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 page.on('pageerror',error=>failures.push(error.message));
 let scene={scenarioId:'22222222-2222-4222-8222-222222222222',name:'TEST中文长名称：印绣花与洗水并行场景，保留当前未保存输入',now:'2026-10-26T00:00:00.000Z',version:1,configurationId:'33333333-3333-4333-8333-333333333333',configurationVersion:1,sourceIds:['11111111-1111-4111-8111-111111111111'],orderIds:[],recordedAt:'2026-10-26T00:00:00.000Z',lastScan:null};
 let conflict=false,available=true;
 await page.route('**/api/acceptance/clock/**',async route=>{
  requests++;const path=new URL(route.request().url()).pathname,payload=route.request().postDataJSON();
  const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(!available)return send({error:{message:'未启用'}},404);
  if(path.endsWith('/scenarios')){
   if(route.request().method()!=='POST')return send({scenarios:[scene]});
   creationAttempts.push(payload);
   return creationAttempts.length<5?send({error:{message:'TEST复制中断，请重试'}},503):send(scene);
  }
  if(path.includes('/resource/'))return send({scene});
  if(path.endsWith('/standards'))return send([{id:scene.configurationId,version:1}]);
  if(path.endsWith('/targets'))return send([{id:'material-check',label:'开发文员核料 · 4小时',dueAt:'2026-10-26T04:00:00Z',warningAt:'2026-10-26T02:48:00Z',exclusive:false},{id:'date-check',label:'TEST日期截止',dueAt:'2027-04-05T16:00:00.000Z',warningAt:null,exclusive:true}]);
  if(path.endsWith('/preview')){const exclusive=payload.nodeId==='date-check';return send({at:exclusive?new Date(Date.parse('2027-04-05T16:00:00.000Z')+(payload.boundary==='due_before'?-1:payload.boundary==='due_after'?1:0)).toISOString():'2026-10-26T02:48:00.000Z',token:'fixture-boundary',label:exclusive?'TEST日期截止':'开发文员核料',version:scene.version,exclusive});}
  if(path.endsWith('/advance')){
   if(conflict){conflict=false;scene={...scene,version:scene.version+1};return send({error:{message:'测试时间或标准已更新，请刷新后重新预览'}},409);}
   assert.equal(payload.expectedVersion,scene.version);assert.ok(Date.parse(payload.at)>Date.parse(scene.now));
   scene={...scene,now:payload.at,version:scene.version+1,lastScan:{status:'completed',recordedAt:scene.recordedAt,message:''}};
   return send({scene,scan:{status:'completed'}});
  }
  if(path.endsWith('/scan'))return send({status:'completed'});
  return send({error:{message:'测试请求未声明'}},400);
 });
 await page.goto(`${base}/${stem}.html`);
 await page.getByText('测试时间',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'前进30分钟',exact:true}).isVisible(),false);
 await page.screenshot({path:resolve(out,'clock-pc-folded.png'),fullPage:true});
 await page.getByLabel('未保存业务输入').fill('TEST未保存内容');
 await page.locator('.acceptance-clock > summary').click();
 await page.getByRole('button',{name:'前进30分钟',exact:true}).click();
 await page.getByRole('status').filter({hasText:'时间已推进'}).waitFor();
 assert.equal(await page.getByLabel('未保存业务输入').inputValue(),'TEST未保存内容');
 assert.equal(scene.now,'2026-10-26T00:30:00.000Z');
 await page.getByRole('button',{name:'刷新办理数据',exact:true}).click();
 await page.getByRole('dialog').waitFor();
 await page.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal(await page.getByLabel('未保存业务输入').inputValue(),'TEST未保存内容');

 await page.screenshot({path:resolve(out,'clock-pc-expanded.png'),fullPage:true});
 await page.getByLabel('跳转节点').selectOption('date-check');
 for(const [boundary,suffix] of [['due_before','.999'],['due','.000'],['due_after','.001']]){
  await page.getByLabel('边界').selectOption(boundary);
  await page.getByRole('button',{name:'查看跳转结果'}).click();
  const preview=page.locator('.acceptance-clock__preview');await preview.waitFor();
  assert.ok((await preview.textContent()).includes('日期截止采用排他边界'));
  assert.ok((await preview.textContent()).includes(suffix));
  assert.equal((await preview.textContent()).includes('此刻已越过'),false);
  assert.equal(await page.getByLabel('未保存业务输入').inputValue(),'TEST未保存内容');
 }
 await page.getByLabel('跳转节点').selectOption('material-check');
 await page.getByRole('button',{name:'查看跳转结果'}).click();
 await page.getByRole('button',{name:'确认推进'}).waitFor();
 conflict=true;await page.getByRole('button',{name:'确认推进'}).click();
 await page.getByRole('alert').filter({hasText:'测试时间或标准已更新'}).waitFor();
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.screenshot({path:resolve(out,'clock-narrow-conflict.png'),fullPage:true});
 available=false;await page.reload();
 await page.waitForLoadState('networkidle');
 assert.equal(await page.locator('.acceptance-clock').count(),0);
 available=true;await page.goto(`${base}/${stem}.html?launcher`);
 await page.getByText('SLA测试场景',{exact:true}).click();
 await page.getByLabel('场景名称').fill('TEST复制重试');
 await page.getByLabel('业务输入').selectOption(scene.scenarioId);
 for(let attempt=0;attempt<4;attempt++){
  if(attempt===2)await page.getByLabel('场景名称').fill('TEST改变输入');
  if(attempt===3)await page.getByLabel('业务输入').selectOption('');
  await page.getByRole('button',{name:'创建并打开'}).click();
  await page.getByRole('alert').filter({hasText:'TEST复制中断'}).waitFor();
  await page.getByRole('button',{name:'创建并打开'}).waitFor({state:'visible'});
 }
 assert.equal(creationAttempts.length,4);
 assert.equal(creationAttempts[0].requestKey,creationAttempts[1].requestKey);
 assert.notEqual(creationAttempts[1].requestKey,creationAttempts[2].requestKey);
 assert.notEqual(creationAttempts[2].requestKey,creationAttempts[3].requestKey);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.screenshot({path:resolve(out,'clock-launcher-retry.png'),fullPage:true});
 await page.route('**/ui/digital-production?development=**',route=>route.fulfill({contentType:'text/html',body:'<main>TEST原业务入口</main>'}));
 await page.getByRole('button',{name:'创建并打开'}).click();
 await page.waitForURL(url=>url.searchParams.get('development')===scene.sourceIds[0]);
 assert.equal(creationAttempts[4].requestKey,creationAttempts[3].requestKey);
 assert.deepEqual(failures,[]);
 console.log(JSON.stringify({suite:'acceptance-clock-component-browser',passed:14,boundaryCases:['B-1ms','B','B+1ms'],requests,viewports:['1440x1000','390x844'],evidence:out,scope:'real component with deterministic API responses; not a full application business acceptance'}));
 await context.close();
}finally{await browser.close();await Promise.all([unlink(html),unlink(entry)]);}
