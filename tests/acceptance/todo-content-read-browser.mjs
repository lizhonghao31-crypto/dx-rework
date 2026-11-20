import assert from 'node:assert/strict';
import {build} from 'vite';import {createServer} from 'node:http';import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright'),out=await mkdtemp(join(tmpdir(),'dx-todo-read-')),evidence=process.env.TODO_READ_EVIDENCE,results=[],errors=[],requests=[],reads=new Map(),rejected=new Set(),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,at='2026-10-20T00:00:00.000Z',token='a'.repeat(64);let browser,server,current;
const item=(actor,scenario)=>({todoId:id(3),taskTitle:'TEST长款号开发事项与本轮任务',todoType:'business_action',category:'digital_task',sourceEventId:id(3),sourceAction:'digital_task',entityType:'digital_task',entityId:id(2),recipientUserId:actor,requiredRole:null,requiredCapability:null,route:{routeName:'digital_production_task',entityId:id(2),todoId:id(3),developmentRound:1},policyKey:null,dueAt:null,reminderCount:0,status:'pending',blockedReason:null,orderContext:{reworkNo:null,orderNo:null,styleNo:'TEST-LONG-开发款号',supplierName:null,status:'ready',updatedAt:at},version:1,createdAt:at,updatedAt:at,...(scenario==='legacy'?{}:{contentToken:scenario==='stale'&&rejected.has(scenario)?'b'.repeat(64):token,readAt:reads.get(`${scenario}:${actor}`)??null,unread:!reads.has(`${scenario}:${actor}`)})});
try{
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/todo-content-read.tsx'),name:'TodoReadFixture',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8'),html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname,scenario=req.headers['x-test-case']??'normal',actor=req.headers['x-test-actor']??id(1),method=req.method,send=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json','x-dx-rework-actor-id':actor});res.end(JSON.stringify(body));};let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;requests.push({path,method,scenario,actor,body});
 if(path==='/api/auth/me')return send({status:'authorized',user:{id:actor,displayName:'TEST文员',isRoot:false,businessRoles:['development_clerk'],capabilities:['todo:view','digital_production:view']}});
 if(path.endsWith('/notifications/claim'))return send({notification:null,remainingCount:0});
 if(path==='/test/candidates')return send({error:{message:'TEST辅助候选暂不可读'}},scenario==='auxfail'?503:200);
 if(path==='/test/body'){if(scenario==='identitylate')await new Promise(done=>setTimeout(done,220));return send({body:'TEST正文'},scenario==='bodyfail'?503:200);}
 if(path==='/api/todos/mine/indicator')return send({pendingCount:1,unreadCount:reads.has(`${scenario}:${actor}`)?0:1});
 if(path==='/api/todos/mine')return send({todos:[item(actor,scenario)],activeModule:'digital_production',moduleCounts:{rework:0,sourcing:0,production:0,samples:0,pattern_room:0,suppliers:0,digital_production:1},page:1,pageSize:15,totalCount:1,totalPages:1});
 if(path===`/api/todos/mine/${id(3)}`){const status={noaccess:403,missing:404,metafail:503}[scenario]??(rejected.has(scenario)?{reassigned:404,revoked:403}[scenario]:undefined);return status?send({error:{message:'TEST事项不可读取'}},status):send(item(actor,scenario));}
 if(path===`/api/todos/mine/${id(3)}/read`){assert.deepEqual(body,{contentToken:item(actor,scenario).contentToken,route:item(actor,scenario).route});if(['stale','reassigned','revoked'].includes(scenario)&&!rejected.has(scenario)){rejected.add(scenario);return send({error:{message:'TEST事项内容或归属已变化'}},{stale:409,reassigned:404,revoked:403}[scenario]);}const key=`${scenario}:${actor}`,first=!reads.has(key);if(first)reads.set(key,at);if(scenario==='unknown'&&first){res.writeHead(200,{'content-type':'application/json'});res.end('{');return;}return send({read:true,contentToken:item(actor,scenario).contentToken,readAt:reads.get(key)});}
 if(path.startsWith('/api/'))return send({error:{message:'TEST未提供此接口'}},404);
 res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);
 });await new Promise(done=>server.listen(0,'127.0.0.1',done));browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});const origin=`http://127.0.0.1:${server.address().port}`,url=(scenario,view='reader')=>`${origin}/ui/${view==='list'?'my-tasks':view==='cockpit'?'digital-cockpit':'digital-production'}?case=${scenario}&view=${view}&todo=${id(3)}`;
 for(const scenario of ['normal','auxfail','bodyfail','legacy','noaccess','missing','metafail','hidden','wrong-round','wrong-entity','stale','reassigned','revoked','unknown','lost','identitylate']){
  const page=await browser.newPage({viewport:{width:1024,height:800}});current=page;page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));await page.goto(url(scenario));
  if(scenario==='metafail'){await page.getByRole('button',{name:'继续查看，本次不记录已读',exact:true}).click();await page.getByText('TEST真实主体已展示',{exact:true}).waitFor();}
  else if(scenario==='bodyfail')await page.getByText('TEST正文读取失败',{exact:true}).waitFor();
  else if(scenario==='identitylate'){await page.getByText('TEST正文读取中',{exact:true}).waitFor();await page.getByRole('button',{name:'TEST切换账号',exact:true}).click();await page.getByText('账号状态已变化，请重新核对本人事项。',{exact:false}).waitFor();await page.waitForTimeout(300);assert.equal(await page.getByText('TEST真实主体已展示',{exact:true}).count(),0);}
  else if(scenario==='hidden'){await page.locator('section h1').waitFor({state:'attached'});assert.equal(requests.filter(r=>r.scenario===scenario&&r.path.endsWith('/read')).length,0);await page.getByRole('button',{name:'显示正文',exact:true}).click();}
  else if(!['stale','reassigned','revoked'].includes(scenario))await page.getByText('TEST真实主体已展示',{exact:true}).waitFor();
  if(['unknown','lost'].includes(scenario)){await page.getByRole('button',{name:'仅重试已读同步',exact:true}).click();await page.waitForFunction(()=>!document.body.innerText.includes('阅读状态尚未确认'));assert.equal(reads.has(`${scenario}:${id(1)}`),true);const writes=requests.filter(r=>r.scenario===scenario&&r.method==='POST');assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);}
  else if(['stale','reassigned','revoked'].includes(scenario)){await page.getByText('本次阅读记录被拒绝',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'仅重试已读同步',exact:true}).count(),0);assert.equal(await page.getByText('TEST真实主体已展示',{exact:true}).count(),0);assert.equal(reads.has(`${scenario}:${id(1)}`),false);await page.getByRole('button',{name:'重试核对事项',exact:true}).click();await page.getByText('TEST真实主体已展示',{exact:true}).waitFor();if(scenario==='stale'){await page.waitForFunction(()=>window.todoFixture.requests.filter(r=>r.method==='POST').length===2);assert.equal(reads.has(`${scenario}:${id(1)}`),true);const writes=requests.filter(r=>r.scenario===scenario&&r.method==='POST');assert.deepEqual(writes.map(r=>r.body.contentToken),[token,'b'.repeat(64)]);}else{await page.getByText('本次不记录已读',{exact:false}).waitFor();assert.equal(requests.filter(r=>r.scenario===scenario&&r.method==='POST').length,1);}}
  else if(['normal','auxfail','hidden'].includes(scenario))await page.waitForFunction(()=>window.todoFixture.requests.some(r=>r.method==='POST'));
  else {await page.waitForTimeout(100);assert.equal(requests.filter(r=>r.scenario===scenario&&r.path.endsWith('/read')).length,0,`${scenario} never marks unread content`);}
  if(['normal','auxfail','hidden'].includes(scenario)){assert.equal(reads.has(`${scenario}:${id(1)}`),true);await page.reload();if(scenario==='hidden')await page.getByRole('button',{name:'显示正文',exact:true}).click();await page.getByText('TEST真实主体已展示',{exact:true}).waitFor();assert.equal(reads.get(`${scenario}:${id(1)}`),at);}
  if(evidence)await page.screenshot({path:join(evidence,`${scenario}.png`),fullPage:true});results.push({scenario,read:reads.has(`${scenario}:${id(1)}`)});await page.close();
 }
 // Real list + same-origin cross-tab invalidation; only actor IDs cross the channel.
 const context=await browser.newContext(),list=await context.newPage(),reader=await context.newPage();current=list;await list.goto(url('multitab','list'));await list.getByText('TEST长款号开发事项与本轮任务',{exact:true}).waitFor();await list.getByText('未读',{exact:true}).waitFor();await list.getByText('开发与大货、生产风险未读：1 项',{exact:true}).waitFor();await reader.goto(url('multitab'));await reader.getByText('TEST真实主体已展示',{exact:true}).waitFor();await list.getByText('已读',{exact:true}).waitFor();await list.getByText('开发与大货、生产风险未读：0 项',{exact:true}).waitFor();assert.equal(await list.locator('.my-todo-card').count(),1,'read never removes pending business item');await list.reload();await list.getByText('已读',{exact:true}).waitFor();assert.equal(reads.get(`multitab:${id(1)}`),at);
 // Ignore a signal from another identity and keep own body/count.
 const before=requests.filter(r=>r.scenario==='multitab'&&r.path==='/api/todos/mine').length;await reader.evaluate(()=>{const ch=new BroadcastChannel('dx-rework:todo-read-v1');ch.postMessage({type:'todo-read',actorId:'00000000-0000-4000-8000-000000000008'});ch.close();});await list.waitForTimeout(120);assert.equal(requests.filter(r=>r.scenario==='multitab'&&r.path==='/api/todos/mine').length,before);
 for(const width of [390,1024,1440]){await list.setViewportSize({width,height:900});await list.evaluate(()=>document.fonts.ready);assert.equal(await list.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);const titleGap=await list.locator('.my-todo-title').evaluate(el=>getComputedStyle(el).columnGap);assert.equal(titleGap,'10px');assert.ok((await list.locator('.my-todos-page').boundingBox()).width>Math.min(width-64,320),'body uses the available workspace');if(evidence)await list.screenshot({path:join(evidence,`list-${width}.png`),fullPage:true});}
 results.push({scenario:'multitab-persistence-identity-filter',pendingStillVisible:true});await context.close();

 // Let the backend capture the old indicator before the second tab marks real content read.
 const pendingContext=await browser.newContext();
 const pendingList=await pendingContext.newPage(),pendingReader=await pendingContext.newPage();
 current=pendingList;
 const raceScenario='multitab-indicator-in-flight',indicatorPath='/api/todos/mine/indicator';
 const listPath='/api/todos/mine',indicatorResponses=[];
 let releaseOld,resolveOld;
 const release=new Promise(done=>{releaseOld=done;});
 const firstResponse=new Promise(done=>{resolveOld=done;});
 const counts=()=>pendingList.evaluate(([indicator,list])=>({
   indicator:window.todoFixture.requests.filter(request=>request.path===indicator).length,
   list:window.todoFixture.requests.filter(request=>request.path===list).length,
 }),[indicatorPath,listPath]);
 const visibility=state=>pendingList.evaluate(value=>{
  Object.defineProperty(document,'visibilityState',{configurable:true,value});
  document.dispatchEvent(new Event('visibilitychange'));
 },state);
 const unread=count=>pendingList.getByText('开发与大货、生产风险未读：'+count+' 项',{exact:true});
 const pendingOne=pendingList.locator('.todo-count-badge[aria-label="1项待办提示"]').first();
 const checkCard=async label=>{
  await pendingList.locator('.my-todo-card').getByText(label,{exact:true}).waitFor();
  assert.equal(await pendingList.locator('.my-todo-card').count(),1);
  await pendingOne.waitFor({state:'attached'});
 };
 try{
  pendingList.on('pageerror',error=>errors.push(error.message));
  pendingReader.on('pageerror',error=>errors.push(error.message));
  await pendingList.clock.install();
  await pendingList.goto(url(raceScenario,'list'));
  await unread(1).waitFor();
  await checkCard('未读');
  await pendingList.route(target=>target.pathname===indicatorPath,async route=>{
   const response=await route.fetch(),snapshot=await response.json();
   indicatorResponses.push(snapshot);
   if(indicatorResponses.length===1){
    resolveOld(snapshot);
    await release;
   }
   await route.fulfill({response});
  });
  const initial=await counts();
  await visibility('hidden');
  await pendingList.clock.fastForward(61_000);
  assert.deepEqual(await counts(),initial,'hidden tab does not issue a polling request');

  await visibility('visible');
  await pendingList.waitForFunction(initialGets=>window.todoFixture.requests.filter(request=>request.path==='/api/todos/mine/indicator').length>initialGets,initial.indicator);
  const snapshot=await Promise.race([firstResponse,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Old indicator did not reach the TEST API')),6000);timer.unref();})]);
  assert.deepEqual(snapshot,{pendingCount:1,unreadCount:1});
  const acknowledged=pendingReader.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/read')&&response.request().method()==='POST'&&response.status()===200);
  await pendingReader.goto(url(raceScenario));
  await pendingReader.getByText('TEST真实主体已展示',{exact:true}).waitFor();
  assert.equal((await (await acknowledged).json()).read,true);
  assert.equal(reads.get(raceScenario+':'+id(1)),at);
  await checkCard('已读');
  assert.equal((await counts()).indicator,initial.indicator+1,'read is queued behind the held response');
  await unread(1).waitFor();
  releaseOld();
  await unread(0).waitFor();
  await checkCard('已读');
  assert.deepEqual(indicatorResponses,[{pendingCount:1,unreadCount:1},{pendingCount:1,unreadCount:0}]);
  const settled=await counts();
  assert.equal(settled.indicator,initial.indicator+2,'one new refresh after releasing the previously in-flight GET');

  await pendingList.evaluate(()=>{
   const channel=new BroadcastChannel('dx-rework:todo-read-v1');
   channel.onmessage=()=>{window.__testForeignReadReceived=true;channel.close();};
  });
  await pendingReader.evaluate(actorId=>{
   const channel=new BroadcastChannel('dx-rework:todo-read-v1');
   channel.postMessage({type:'todo-read',actorId});
   channel.close();
  },id(8));
  await pendingList.waitForFunction(()=>window.__testForeignReadReceived===true);
  await pendingList.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  assert.deepEqual(await counts(),settled,'another actor causes neither list nor indicator refresh');
  await unread(0).waitFor();
  await checkCard('已读');
  if(evidence)await pendingList.screenshot({path:join(evidence,'multitab-indicator-in-flight.png'),fullPage:true});
  results.push({scenario:raceScenario,indicatorResponses,refreshesAfterOld:1,hiddenPollingRequests:0,otherActorRefreshes:0,pendingStillVisible:true});
 }finally{releaseOld();}
 await pendingContext.close();
 assert.deepEqual(errors,[]);
}catch(error){if(evidence&&current&&!current.isClosed()){await current.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure.txt'),await current.locator('body').innerText());}throw error;}
finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,requests,limits:['Actual React read boundary, callback and MyTodosPage; synthetic HTTP content and receipts. Actual authorization, content token and database uniqueness tested separately against PostgreSQL. Not ECS or production acceptance.']},null,2));await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({passed:results.length,errors}));
