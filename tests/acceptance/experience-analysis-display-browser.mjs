import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'vite';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-experience-analysis-')),evidence=process.env.EXPERIENCE_ANALYSIS_EVIDENCE,results=[];
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,saved=DigitalAnalysisFilterSchema.parse({from:'2026-10-01',to:'2026-10-22',scope:'completed',metric:'shipping'});
let server,browser,current;
const overview={period:{newStyles:0,shippedRounds:0,completed:0,slaDenominator:0,onTime:0,measurable:0,missingTime:0,unverifiedTime:0,handlingSeconds:0,waitingSeconds:0,unknownWaiting:0,cycleBuckets:[]},snapshot:{active:0,pending:0,unassigned:0,blocked:0,overdue:0,materialPending:0,handoverPending:0,otherBlocked:0},nodes:[]};
try{
 await build({configFile:false,logLevel:'warn',esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('apps/web/src/main.tsx'),name:'ActualExperienceApp',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await Promise.all(files.filter(f=>f.endsWith('.css')).map(f=>readFile(join(out,f),'utf8')));
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css.join('\n')}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),path=url.pathname;if(!path.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);return;}
  const run=current;run.requests.push({path,search:url.search,method:req.method});const send=(body,status=200)=>{if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json','x-dx-rework-actor-id':id(1)});res.end(JSON.stringify(body));};
  if(req.method!=='GET')return send({error:{message:'TEST writes are not connected'}},403);
  if(path==='/api/auth/me')return send({status:'authorized',user:{id:id(1),displayName:'TEST老板',isRoot:true,businessRoles:['root_superuser'],capabilities:['digital_production:view','receiving:view']}});
  if(path.endsWith('/indicator'))return send({pendingCount:0,unreadCount:0});
  if(path.includes('/notifications/'))return send({notification:null,remainingCount:0});
  if(path==='/api/digital-production/analysis'){
   const filters=DigitalAnalysisFilterSchema.parse(Object.fromEntries(url.searchParams)),total=filters.category.startsWith('TEST-NONE')?0:37,page=filters.page,asOf=new Date(Date.UTC(2026,9,22,4,0,++run.reads)).toISOString();
   const rows=Array.from({length:Math.max(0,Math.min(15,total-(page-1)*15))},(_,i)=>({taskId:id(10+(page-1)*15+i),sourceId:id(2),sourceRound:1,instructionVersion:null,canReadSourceRound:false,orderId:null,styleNo:`TEST-${filters.category||'ALL'}-${(page-1)*15+i+1}`,customer:'PD',category:filters.category,requiredRole:'pattern_room_worker',assigneeId:id(3),assigneeName:'TEST师傅',nodeKey:'development_pattern',label:'开发纸样',round:1,state:'completed',createdAt:asOf,enteredAt:asOf,completedAt:asOf,enteredQuality:'现场登记',completedQuality:'现场登记',dueAt:null,policyVersion:null,events:[],assignmentHistory:[],delegations:[],pendingConditions:[],handlingSeconds:0,slaIncluded:false,onTime:null,exclusion:'无时限',waitingSeconds:0,unknownWaiting:0,missingTime:false,unverifiedTime:false,registrationDelaySeconds:0}));
   const body={ruleVersion:'TEST-analysis-rules',asOf,filters,overview,canExport:false,canRecord:true,page,total,summary:{newStyles:0,tasks:total,cancelled:0,completed:total,slaDenominator:0,onTime:0,measurable:0,handlingSeconds:0,waitingSeconds:0,unknownWaiting:0,missingTime:0,unverifiedTime:0,correctedTasks:0,materialPending:0,handoverPending:0},rounds:[],rows,notes:[{id:id(4),author:'TEST老板',createdAt:'2026-10-21T00:00:00Z',asOf:'2026-10-21T00:00:00Z',observeAt:'2026-10-23T00:00:00Z',conclusion:'TEST已留存分析',action:'TEST仅核验回看',filters:saved,taskIds:[id(10)],ruleVersion:'TEST-old-rule'}]};
   return setTimeout(()=>send(body),filters.category==='TEST-SLOW'?650:15);
  }
  if(path==='/api/receiving/board'){
   run.reads++;
   if(url.searchParams.get('startDate')>url.searchParams.get('endDate'))return send({error:{message:'结束日期不能早于开始日期'}},400);
   if(run.fail)return send({error:{message:run.fail===403?'当前身份不能读取该回货范围':'TEST回货服务暂不可读'}},run.fail);
   const body={date:'2026-10-22',startDate:url.searchParams.get('startDate'),endDate:url.searchParams.get('endDate'),mode:'date',status:'all',kpis:{orderCount:run.nonzero?2:0,receivedQuantity:run.nonzero?9:0,abnormalOrderCount:run.nonzero?1:0,differenceQuantity:run.nonzero?1:0,differenceRate:run.nonzero?10:0},insights:{pendingCount:0,missingPackingCount:0,staleCount:0},rows:[],page:1,pageSize:15,totalCount:0,totalPages:0};
   if(run.hold){run.release=()=>send(body);return;}return send(body);
  }
  return send({error:{message:'TEST此读取不在场景内'}},404);
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const name of ['analysis-navigation','board-loading-empty','board-failure-retry','board-permission','board-invalid-dates','board-refresh-failure','board-late-read']){
  console.log(JSON.stringify({starting:name}));const run=current={name,requests:[],reads:0,fail:name==='board-failure-retry'?503:name==='board-permission'?403:0,hold:name==='board-loading-empty',nonzero:name==='board-refresh-failure'},context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  if(name.startsWith('analysis')){
   await page.goto(origin+'/ui/digital-analysis?from=2026-10-01&to=2026-10-22&scope=snapshot&view=timing&page=2');
   const ready=()=>page.locator('[data-analysis-ready="true"]').waitFor(),category=page.getByLabel('品类',{exact:true});await ready();assert.equal(await page.getByRole('button',{name:'节点时效',exact:true}).getAttribute('aria-pressed'),'true');await page.locator('.analysis-saved-panel>summary').click();
   await category.fill('TEST-NONE');await page.getByText('当前服务端筛选无可见任务。',{exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('page'),'1');
   const oldAsOf=await page.locator('.analysis-definition-panel small').textContent();await page.getByRole('link',{name:'回看记录筛选',exact:true}).click();await ready();assert.equal(await category.inputValue(),'');assert.equal(new URL(page.url()).searchParams.get('category'),'');await page.getByText('37 项命中 · 已选 0 项依据',{exact:true}).waitFor();assert.notEqual(await page.locator('.analysis-definition-panel small').textContent(),oldAsOf);assert.ok(await page.getByText(/依据快照/).count());
   const sameAsOf=await page.locator('.analysis-definition-panel small').textContent();await page.getByRole('link',{name:'回看记录筛选',exact:true}).click();await ready();assert.notEqual(await page.locator('.analysis-definition-panel small').textContent(),sameAsOf,'Same saved filters read current data, not a historical response');
   await page.getByRole('button',{name:'下一页',exact:true}).click();await ready();assert.equal(new URL(page.url()).searchParams.get('page'),'2');await page.locator('.analysis-detail-panel').getByText('TEST-ALL-16',{exact:true}).waitFor();
   await page.goBack();await ready();assert.equal(await category.inputValue(),'');await page.locator('.analysis-detail-panel').getByText('TEST-ALL-1',{exact:true}).waitFor();await page.goBack();await ready();assert.equal(await category.inputValue(),'TEST-NONE');await page.getByText('当前服务端筛选无可见任务。',{exact:true}).waitFor();await page.goForward();await ready();assert.equal(await category.inputValue(),'');await page.locator('.analysis-detail-panel').getByText('TEST-ALL-1',{exact:true}).waitFor();await page.goForward();await ready();await page.locator('.analysis-detail-panel').getByText('TEST-ALL-16',{exact:true}).waitFor();
   await category.fill('TEST-SLOW');await page.waitForRequest(request=>request.url().includes('category=TEST-SLOW'));await category.fill('TEST-FAST');await ready();await page.locator('.analysis-detail-panel').getByText('TEST-TEST-FAST-1',{exact:true}).waitFor();await new Promise(done=>setTimeout(done,700));assert.equal(await category.inputValue(),'TEST-FAST');assert.equal(await page.getByText('TEST-TEST-SLOW-1',{exact:true}).count(),0);assert.equal(new URL(page.url()).searchParams.get('page'),'1');
   const count=run.reads;await new Promise(done=>setTimeout(done,250));assert.equal(run.reads,count,'URL synchronization settles without a request loop');
  }else{
   await page.goto(origin+'/ui/orders');await page.getByRole('heading',{name:'订单回货',exact:true}).waitFor();const cards=page.locator('.order-board-kpis'),unavailable=async()=>{await page.waitForFunction(()=>[...document.querySelectorAll('.order-board-kpis strong')].every(el=>el.textContent==='—'));assert.equal(await cards.locator('.dx-meter--success').count(),0);};
   if(name==='board-loading-empty'){await unavailable();assert.ok(await cards.getByText('正在读取，暂不计算',{exact:true}).count());run.hold=false;run.release();await page.waitForFunction(()=>document.querySelector('.order-board-kpis strong')?.textContent==='0');assert.equal(await cards.locator('.dx-meter--success').count(),2);}
   else if(name==='board-failure-retry'||name==='board-permission'){await page.getByRole('button',{name:'仅重新读取回货记录',exact:true}).waitFor();await unavailable();run.fail=0;await page.getByRole('button',{name:'仅重新读取回货记录',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.order-board-kpis strong')?.textContent==='0');}
   else{
    await page.waitForFunction(()=>document.querySelector('.order-board-kpis strong')?.textContent!=='—');
    if(name==='board-invalid-dates'){await page.getByLabel('开始日期',{exact:true}).fill('2027-12-31');await page.getByText('结束日期不能早于开始日期',{exact:false}).waitFor();await unavailable();assert.equal(await page.getByLabel('开始日期',{exact:true}).inputValue(),'2027-12-31');await page.getByLabel('开始日期',{exact:true}).fill('2026-01-01');await page.waitForFunction(()=>document.querySelector('.order-board-kpis strong')?.textContent==='0');}
    if(name==='board-refresh-failure'){run.fail=503;await page.getByLabel('款号',{exact:true}).fill('TEST-FAILED');await page.getByRole('button',{name:'仅重新读取回货记录',exact:true}).waitFor();await unavailable();assert.equal(await page.getByLabel('款号',{exact:true}).inputValue(),'TEST-FAILED');}
    if(name==='board-late-read'){run.hold=true;await page.getByLabel('款号',{exact:true}).fill('TEST-SLOW');await page.waitForRequest(r=>r.url().includes('q=TEST-SLOW'));await unavailable();run.hold=false;run.fail=503;await page.getByLabel('款号',{exact:true}).fill('TEST-FAILED');await page.getByRole('button',{name:'仅重新读取回货记录',exact:true}).waitFor();run.release();await new Promise(done=>setTimeout(done,100));await unavailable();}
   }
  }
  assert.deepEqual(errors,[]);assert.equal(run.requests.filter(r=>r.method!=='GET').length,0);results.push({name,reads:run.reads,requests:run.requests,errors});if(evidence)await page.screenshot({path:join(evidence,name+'.png'),fullPage:true});await context.close();
 }
 console.log(JSON.stringify({passed:results.length,cases:results.map(row=>row.name)}));
}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({entry:'apps/web/src/main.tsx',results,limits:'Real App/navigation/analysis/receiving pages with synthetic localhost reads. No historical snapshot replay, production API, write or ECS operation.'},null,2));await browser?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});}
