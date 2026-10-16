import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
// Optional isolated PostgreSQL/browser evidence. No production endpoint is used.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {registerPatternRoomPriceRoutes} from '../../apps/api/src/pattern-room/price-routes.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';

export async function workbenchBrowser({database,attachments,storage,root,worker,taskId,sewingTaskId,standaloneTaskId,processActors,processSourceId,bulkTaskId}){
 const out=process.env.R2_WORKBENCH_EVIDENCE;assert(out);await mkdir(out,{recursive:true});
 const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'/opt/codex/cua_node/lib/node_modules/playwright/index.mjs');
 const users=new Map([root,worker,...Object.values(processActors??{})].map(actor=>[actor.actorId,{id:actor.actorId,displayName:actor===root?'TEST-R2 样板负责人':'TEST-R2 纸样师傅',businessRoles:actor.actorRoles,capabilities:[...new Set([...(actor.authorizationCapabilities??[]),'digital_production:view',...(actor===root?['pattern_room:catalog:read']:[])])],isRoot:actor===root}]));
 const api=Fastify();api.setErrorHandler((error,_request,reply)=>reply.code(error.statusCode??500).send({error:{message:error.message}}));
 const authenticate=async token=>{assert(users.has(token),'unknown isolated fixture identity');return users.get(token);};
 registerPatternRoomPriceRoutes(api,{authenticate,service:new PatternRoomPriceService(database)});
 api.get('/auth/me',async request=>({status:'authorized',user:await authenticate(request.headers.cookie?.match(/dx_rework_session=([^;]+)/)?.[1])}));
 registerDigitalIdentityRoutes(api,{bulkPreparationService:new BulkPreparationService(database),journeys:new DigitalJourneyQuery(database),authenticate,creationEnabled:true,service:new DigitalProductionIdentityService(database,true),taskService:new DigitalProductionTaskService(database),accessService:new DigitalProductionAccessService(database),notificationService:new DigitalProductionNotificationService(database),developmentService:new DigitalDevelopmentService(database,true),developmentExecution:new DevelopmentExecutionService(database,true),developmentRounds:new DevelopmentRoundService(database,true),budgetService:new DigitalBudgetService(database,true),instructionService:new ProductionInstructionService(database,true),developmentAttachments:attachments});
 api.get('/__test-storage',async(request,reply)=>{const key=request.query.key,bytes=storage.objectBytes.get(key);return bytes?reply.type(storage.objects.get(key)?.mimeType??'application/octet-stream').send(Buffer.from(bytes)):reply.code(404).send();});
 await api.listen({host:'127.0.0.1',port:0});const apiPort=api.server.address().port;
 const vite=await createServer({configFile:false,root:new URL('../../apps/web',import.meta.url).pathname,plugins:[react()],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:`http://127.0.0.1:${apiPort}`,rewrite:path=>path.replace(/^\/api/,'')}}}});await vite.listen();
 const origin=`http://127.0.0.1:${vite.httpServer.address().port}`,browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const originalDownload=storage.createDownloadGrant.bind(storage),originalUpload=storage.createExactSizeNonOverwritableUploadGrant.bind(storage);
 storage.createDownloadGrant=async(key,options)=>({...await originalDownload(key,options),downloadUrl:origin+'/api/__test-storage?key='+encodeURIComponent(key)});
 storage.createExactSizeNonOverwritableUploadGrant=async(key,options)=>({...await originalUpload(key,options),uploadUrl:origin+'/__test-upload'});
 const context=await browser.newContext({recordVideo:{dir:out},viewport:{width:1440,height:900}}),page=await context.newPage(),errors=[],requests=[],checks=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)requests.push({url:response.url(),status:response.status()});});page.on('request',request=>{if(request.url().startsWith(origin+'/api/'))requests.push({url:request.url(),method:request.method()});});
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||(url.protocol==='chrome-extension:'&&url.host==='mhjfbmdgcfjbbpaeojofohoefgiehjai')||(url.protocol==='chrome:'&&url.host==='resources'))await route.continue();else{errors.push('Blocked non-local request: '+url.protocol+'//'+url.host+url.pathname);await route.abort();}});
 await context.route(origin+'/__test-upload',async route=>{
  const request=route.request();
  if(request.method()==='POST'){
   const form=await new Request(request.url(),{method:'POST',headers:request.headers(),body:request.postDataBuffer()}).formData(),file=form.get('file'),key=String(form.get('key')),bytes=new Uint8Array(await file.arrayBuffer());
   await storage.writeImmutable(key,bytes,{mimeType:file.type,sha256:createHash('sha256').update(bytes).digest('hex')});await route.fulfill({status:204,headers:{'access-control-allow-origin':'*'}});
  }else{const key=decodeURIComponent(new URL(request.url()).pathname.slice(1)),bytes=storage.objectBytes.get(key);await route.fulfill(bytes?{status:200,headers:{'access-control-allow-origin':'*'},contentType:storage.objects.get(key)?.mimeType??'application/octet-stream',body:Buffer.from(bytes)}:{status:404});}
 });
 const open=async (actor,id=taskId)=>{await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:actor.actorId,url:origin}]);await page.goto(`${origin}/ui/digital-production?task=${id}&workbench=sample&returnTo=${encodeURIComponent('/ui/digital-pattern-room?state=all&page=2')}`);await page.getByLabel('工序工作台样板').waitFor();await page.getByRole('status').filter({hasText:'正在读取原任务条件'}).waitFor({state:'hidden'});};
 try{
  await open(root);
  for(const width of [1440,1600,1165]){await page.setViewportSize({width,height:width===1165?757:900});await page.screenshot({path:`${out}/paper-${width}.png`});const box=await page.locator('.task-workbench-sample>footer').boundingBox();assert(box&&box.y+box.height<=page.viewportSize().height+1);}
  checks.push('three desktop viewports: fixed action footer visible');
  await page.setViewportSize({width:1440,height:900});
  const note=page.getByLabel('办理备注');if(await note.isEnabled())await note.fill('TEST 页签切换保留备注');
  await page.getByRole('button',{name:'本单资料',exact:true}).click();await page.getByRole('navigation',{name:'本单资料目录'}).waitFor();
  for(const label of ['开发单','大货制单','成本预算表']){await page.getByRole('button',{name:label,exact:true}).click();await page.locator('.order-document-container>footer .dx-doc-toolbar').waitFor();await page.locator('.task-document-reader img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));if(label==='大货制单')assert.equal(await page.getByLabel('查看版本',{exact:true}).inputValue(),'1');await page.screenshot({path:`${out}/document-${label}.png`});assert(await page.locator('.task-document-reader').innerText());}
  await page.getByRole('button',{name:'其他信息',exact:true}).click();await page.locator('#budget-outsourcing').waitFor();assert.equal(await page.locator('.task-document-reader .dx-doc-section').count(),1);await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));assert.equal(await page.locator('.task-document-reader .dx-doc-section').count(),6);await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  checks.push('three real published documents readable through original services; all budget chapters retained for print');
  await page.getByRole('button',{name:'操作记录',exact:true}).click();await page.locator('.task-workbench-sample main ol').waitFor();assert.equal(await page.locator('.task-workbench-sample main ol>li').count(),10);await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByText('第 2 页',{exact:true}).waitFor();await page.getByRole('button',{name:'当前办理',exact:true}).click();if(await note.isEnabled())assert.equal(await note.inputValue(),'TEST 页签切换保留备注');
  checks.push('tabs replace main region and preserve task note');
  await open(root,sewingTaskId);await page.getByRole('heading',{name:/车板.*办理/}).waitFor();assert(await page.getByLabel('本轮前置条件').innerText());await page.screenshot({path:`${out}/sewing-blocked.png`});checks.push('sewing shows real unmet conditions before scrolling');
  await open(root,standaloneTaskId);await page.getByRole('button',{name:'本单资料',exact:true}).click();await page.getByRole('button',{name:'大货制单',exact:true}).click();await page.getByText('尚无确定订单，不适用',{exact:true}).waitFor();await page.screenshot({path:`${out}/no-order.png`});checks.push('no confirmed order: no invented instruction or budget');await page.getByRole('button',{name:'开发单',exact:true}).click();await page.locator('.development-thumbnails button').first().waitFor();assert.equal(await page.locator('.development-thumbnails button').count(),6);await page.getByRole('button',{name:'下一组附件',exact:true}).click();assert.equal(await page.locator('.development-thumbnails button').count(),2);await page.getByRole('button',{name:'查看主款图 8',exact:true}).click();await page.screenshot({path:`${out}/multiple-attachments.png`});checks.push('eight synthetic attachments paginated and selectable');await page.getByRole('button',{name:'尺寸表',exact:true}).click();await page.locator('#development-sizes').waitFor();assert.equal(await page.locator('#development-sizes tbody tr').count(),40);await page.screenshot({path:`${out}/long-size-table.png`});const footer=await page.locator('.task-workbench-sample>footer').boundingBox();assert(footer.y+footer.height<=page.viewportSize().height+1);checks.push('long dimensions and paginated history keep actions visible');
  await open(root);await page.getByRole('button',{name:'本单资料',exact:true}).click();await page.getByRole('button',{name:'工序成果',exact:true}).click();
  const uploadsBefore=requests.filter(request=>request.method==='POST'&&request.url.endsWith('/upload-intents')).length;
  await page.locator('.task-workbench-sample input[type=file]').setInputFiles({name:'TEST-r2-result.png',mimeType:'image/png',buffer:await sharp({create:{width:120,height:80,channels:3,background:'#4073a4'}}).png().toBuffer()});
  await page.getByText('已上传 1 份，返回当前办理提交后正式引用。',{exact:true}).waitFor();await page.getByRole('button',{name:'当前办理',exact:true}).click();await page.getByRole('button',{name:'纸样完成，交给下一位',exact:true}).click();await page.getByText('本任务已完成',{exact:true}).waitFor();await page.getByRole('button',{name:'本单资料',exact:true}).click();await page.getByRole('button',{name:'工序成果',exact:true}).click();await page.getByRole('link',{name:'查看原附件',exact:false}).waitFor();
  assert.equal(requests.filter(request=>request.method==='POST'&&request.url.endsWith('/upload-intents')).length-uploadsBefore,1);await page.screenshot({path:`${out}/result-uploaded.png`});const fileUrl=await page.getByRole('link',{name:'查看原附件',exact:false}).getAttribute('href');const content=await page.evaluate(async url=>{const response=await fetch(url);return {ok:response.ok,bytes:(await response.arrayBuffer()).byteLength};},fileUrl);assert(content.ok&&content.bytes>0);checks.push('one original upload, real completion and same task bound result downloaded');
  await open(worker);const start=requests.length;await page.getByRole('button',{name:'本单资料',exact:true}).click();await page.getByRole('button',{name:'成本预算表',exact:true}).click();await page.getByText('当前身份无权查看此类资料',{exact:true}).waitFor();assert(!requests.slice(start).some(request=>/\/budget(?:\?|$|\/)/.test(request.url)));
  await page.screenshot({path:`${out}/worker-budget-denied.png`});await page.getByRole('button',{name:'开发单',exact:true}).click();await page.locator('.order-document-container>footer .dx-doc-toolbar').waitFor();checks.push('worker budget locked with zero budget requests');
  for(const target of ['/ui/digital-cockpit?search=TEST&page=2&stage=development','/ui/my-tasks?q=TEST&page=2','/ui/digital-pattern-room?state=all&page=2']){
   await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:root.actorId,url:origin}]);await page.goto(`${origin}/ui/digital-production?task=${taskId}&workbench=sample&returnTo=${encodeURIComponent(target)}`);await page.getByLabel('工序工作台样板').waitFor();assert.equal(await page.getByRole('button',{name:'返回来源',exact:true}).count(),1);assert.equal(await page.getByRole('link',{name:'返回开发工作台',exact:true}).count(),0);await page.getByRole('button',{name:'返回来源',exact:true}).click();await page.waitForURL(url=>{const expected=new URL(target,origin);return url.pathname===expected.pathname&&[...expected.searchParams].every(([key,value])=>url.searchParams.get(key)===value);});
  }
  checks.push('single return restores cockpit, todo and board query context');
  const {documentBrowser}=await import('./r2-documents-browser.mjs');await documentBrowser({page,context,origin,database,root,worker,taskId,sewingTaskId,checks,out,requests});
  if(processActors){const {processBrowser}=await import('./r2-processes-browser.mjs');await processBrowser({page,context,origin,database,root,actors:processActors,sourceId:processSourceId,bulkTaskId,checks,out});}
  const {createBrowser}=await import('./r2-create-browser.mjs');await createBrowser({page,context,origin,database,root,checks,out,requests});
  assert.deepEqual(errors,[]);
 }catch(error){await page.screenshot({path:`${out}/failure.png`});errors.push(String(error));errors.push((await page.locator('body').innerText()).slice(0,4000));throw error;}finally{await writeFile(`${out}/result.json`,JSON.stringify({checks,errors,requests,limitations:['isolated PostgreSQL fixtures; local storage transport emulation','no ECS or production access','PR03 approved shell; process adapters use synthetic tasks; ordered transitions covered separately by PostgreSQL tests']},null,2));await context.close();await browser.close();await vite.close();await api.close();}
}
