import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID,createHash} from "node:crypto";
import sharp from 'sharp';
import {createServer,type Server} from "node:http";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {join,resolve,extname} from "node:path";
import {tmpdir} from "node:os";
import {build} from "vite";
import type {Browser,chromium as Chromium} from "playwright-core";
import {loadConfig} from "@dx-rework/config";
import {buildApp} from "../../apps/api/src/app.js";
import {AuthService} from "../../apps/api/src/auth/service.js";
import {PostgresAuthStore} from "../../apps/api/src/auth/postgres-store.js";
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from "../../apps/api/src/auth/acceptance-provider.js";
import {RootAuthority} from "../../apps/api/src/access/root-authority.js";
import {EmployeeAccessService} from "../../apps/api/src/access/employee-access-service.js";
import {DevelopmentExecutionService} from "../../apps/api/src/production-platform/development-execution-service.js";
import {DevelopmentRoundService} from "../../apps/api/src/production-platform/development-round-service.js";
import {DigitalJourneyQuery} from "../../apps/api/src/production-platform/journey-query.js";
import {DigitalProductionIdentityService} from "../../apps/api/src/production-platform/identity-service.js";
import {DigitalDevelopmentService} from "../../apps/api/src/production-platform/development-service.js";
import {DigitalProductionTaskService} from "../../apps/api/src/production-platform/task-service.js";
import {DigitalProductionAccessService} from "../../apps/api/src/production-platform/access-service.js";
import {DigitalProductionNotificationService} from "../../apps/api/src/production-platform/notification-service.js";
import {DigitalQuotationService} from "../../apps/api/src/production-platform/quotation-service.js";
import {DevelopmentDocumentSchema,type DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import {PatternRoomOrderService} from "../../apps/api/src/pattern-room/order-service.js";
import {PatternRoomPriceService} from "../../apps/api/src/pattern-room/price-service.js";
import {RootAwareTodoProjectionService} from "../../apps/api/src/todos/root-aware-projection-service.js";
import {TodoService} from "../../apps/api/src/todos/service.js";
import {arrangeTestRound} from "../helpers/development-arrangement-fixture.js";
import {businessAnchorFixture} from "../helpers/business-anchor-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("S1 development read through original App and native signed identity",()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,app:ReturnType<typeof buildApp>,browser:Browser,server:Server,output:string,base:string;
 let execution:DevelopmentExecutionService,employeeAccess:EmployeeAccessService,sourceId:string,paperId:string,foreignSourceId:string,foreignTaskId:string,draftId:string,commentSourceId:string,commentShippingId:string,uploadSourceId:string,uploadPaperId:string;
 let externalSourceId:string,externalTaskId:string,externalRequestId:string;
 const tokens=new Map<string,string>(),evidence=join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),"development-read");
 let loginRole:(role:string)=>Promise<string>;
 const path=(id:string)=>`/digital-production/sources/${id}/execution`;
 const get=(role:string,url:string)=>app.inject({method:"GET",url,headers:{cookie:"dx_rework_session="+tokens.get(role)}});
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);
  // Match the original full-schema technical fixture's current capability load.
  for(const actor of Object.values(f.people)){
   const rows=(await f.db.query('SELECT DISTINCT c.capability FROM user_role_assignments a JOIN role_capabilities c USING(role_code) WHERE a.user_id=$1 AND a.revoked_at IS NULL',[actor.actorId])).rows;
   actor.authorizationCapabilities=[...new Set([...(actor.authorizationCapabilities??[]),...rows.map(row=>row.capability as string)])];
  }
  const secret="TEST S1 development native browser ".repeat(3),root=new RootAuthority(f.db,"anchor-test","uat-root");
  const provider=new AcceptanceDingTalkProvider(f.db,"anchor-test",secret),store=new PostgresAuthStore(f.db,"anchor-test","uat-root");
  const auth=new AuthService(provider,store,"anchor-test",3600000,secret);
  loginRole=async role=>(await auth.loginMobile(mintAcceptanceLoginCode(role,secret))).token;
  employeeAccess=new EmployeeAccessService(f.db,"anchor-test",f.access,store,provider,{enabled:false,dingtalkUserId:undefined,secret:undefined},"uat-root");
  const config=loadConfig({NODE_ENV:"test",DATABASE_URL:url!,DINGTALK_CORP_ID:"anchor-test",DINGTALK_H5_APP_KEY:"TEST",DINGTALK_H5_APP_SECRET:secret,DINGTALK_WEB_CLIENT_ID:"TEST",DINGTALK_WEB_CLIENT_SECRET:secret,DINGTALK_QR_REDIRECT_URI:"https://architecture.invalid/auth/qr/callback",APP_BASE_PATH:"/",SESSION_SECRET:secret});
  const authenticate:typeof auth.authenticate=(token,context)=>auth.authenticate(token,context);
  const native=new PatternRoomOrderService(f.db,new RootAwareTodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
  const identity=new DigitalProductionIdentityService(f.db,true),forms=new DigitalDevelopmentService(f.db,true,native),tasks=new DigitalProductionTaskService(f.db);
  execution=new DevelopmentExecutionService(f.db,true,native,"TEST S1 preview secret not live");
  const prices=new PatternRoomPriceService(f.db),option=(await prices.options(f.root))[0]!,quote=await prices.quote(f.root,'category',option.priceId);
  const category=await prices.change(f.root,'category',option.priceId,{version:quote.version,amount:'10.000',enabled:true,reason:'TEST isolated S1 sample'},randomUUID());
  const designer=f.people['sample-designer']!,worker=f.people['pattern-room-worker']!;
  const prepare=async(published=true)=>{
   const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:'TEST-S1-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const materialId=randomUUID(),photo=await f.image(designer);
   const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[],template:'上衣',quantity:1,sampleSize:'',orderDate:null,returnDate:null,unit:'cm',sizes:[],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST S1 原制作说明',craft:'无',washing:'免洗',materials:[{materialId,category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'',color:'黑',specification:'TEST40支',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:photo,kind:'款图'}]});
   document.patternCategoryId=category.priceId;
   const saved=await forms.save(designer,source.sourceId,{expectedVersion:0,document},randomUUID());
   if(published)await forms.publish(designer,source.sourceId,saved.version,randomUUID(),{categoryId:category.priceId,priceVersion:category.version});
   return {id:source.sourceId,materialId};
  };
  const prepareHandling=async()=>{
   const own=await prepare(),id=own.id;
   const fixed=await execution.read(f.root,id);
   await execution.configureFixedCutting(f.root,id,{expectedVersion:fixed.fixedCutting?.version??0,assigneeId:worker.actorId,reason:'TEST native fixed cutter'},randomUUID());
   const before=await execution.read(f.root,id),check=before.tasks.find(t=>t.taskKind==='development_materials')!;
   const verified=await execution.saveMaterials(f.root,id,{taskId:check.taskId,expectedVersion:before.materialVerification!.version,expectedDocumentVersion:before.sheet.version,entries:[{materialId:own.materialId,usage:'use',physical:true,quantity:true,color:true,specification:true,note:'TEST actual clerk verification',confirmedWith:''}],note:'TEST S1 material verification',result:'通过'},randomUUID());
   await execution.check(f.root,id,{taskId:check.taskId,result:'通过',note:'TEST native material check',expectedVerificationVersion:verified.version,items:[{materialId:own.materialId,physical:true,quantity:true,color:true,specification:true}]},randomUUID());
   await arrangeTestRound(f.db,execution,f.root,id,worker.actorId);
   const state=await execution.read(f.root,id);return {id,paperId:state.tasks.find(t=>t.taskKind==='development_pattern')!.taskId,shippingId:state.tasks.find(t=>t.taskKind==='development_shipping')!.taskId};
  };
  const own=await prepareHandling();sourceId=own.id;paperId=own.paperId;
  const commentOwn=await prepareHandling();commentSourceId=commentOwn.id;commentShippingId=commentOwn.shippingId;
  const uploadOwn=await prepareHandling();uploadSourceId=uploadOwn.id;uploadPaperId=uploadOwn.paperId;
  const externalOwn=await prepareHandling();externalSourceId=externalOwn.id;
  const external=await execution.externalPattern(f.people['pattern-room-supervisor']!,externalSourceId,{action:'request',roundNumber:1,note:'TEST original external paper request'},randomUUID());
  externalTaskId=external.taskId;externalRequestId=external.requestId;
  foreignSourceId=(await prepare()).id;foreignTaskId=(await execution.read(f.root,foreignSourceId)).tasks.find(t=>t.taskKind==='development_materials')!.taskId;
  draftId=(await prepare(false)).id;
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},patternRoomPrices:{authenticate,root,service:prices},digitalIdentity:{authenticate,root,service:identity,creationEnabled:true,developmentQrBase:'https://architecture.invalid/',developmentService:forms,developmentExecution:execution,developmentAttachments:f.attachments,quotationService:new DigitalQuotationService(f.db,true),taskService:tasks,accessService:new DigitalProductionAccessService(f.db),notificationService:new DigitalProductionNotificationService(f.db)}});await app.ready();
  for(const role of ['root','pattern-room-worker','worker-a','pattern-room-supervisor','development-clerk'])tokens.set(role,(await auth.loginMobile(mintAcceptanceLoginCode(role,secret))).token);
  output=await mkdtemp(join(tmpdir(),"dx-development-read-native-"));const previous=process.env.NODE_ENV;
  try{process.env.NODE_ENV="production";await build({root:resolve("apps/web"),configFile:resolve("apps/web/vite.config.ts"),mode:"production",base:"/",build:{outDir:output,emptyOutDir:true}});}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
  const html=await readFile(join(output,"index.html"));
  server=createServer(async(request,response)=>{try{
   const path=request.url??"/";
   if(path.startsWith('/__test-storage?')){const key=new URL(path,'http://TEST.invalid').searchParams.get('key')!,bytes=f.storage.objectBytes.get(key);response.writeHead(bytes?200:404,{'content-type':f.storage.objects.get(key)?.mimeType??'application/octet-stream'});response.end(bytes?Buffer.from(bytes):undefined);return;}
   if(path.startsWith("/api/")){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const payload=Buffer.concat(chunks),headers={...request.headers,host:"architecture.invalid",origin:"https://architecture.invalid"};delete headers["content-length"];
    const reply=await app.inject({method:request.method as "GET"|"POST"|"PATCH"|"DELETE",url:path.slice(4),headers,...(payload.length?{payload}:{})});response.writeHead(reply.statusCode,reply.headers);response.end(reply.rawPayload);return;
   }
   if(path.startsWith("/assets/")){const asset=new URL(path,"http://TEST.invalid").pathname;if(!/^\/assets\/[A-Za-z0-9_.-]+$/.test(asset)){response.writeHead(400);response.end();return;}response.writeHead(200,{"content-type":extname(asset)===".css"?"text/css":"text/javascript"});response.end(await readFile(join(output,asset.slice(1))));return;}
   response.writeHead(200,{"content-type":"text/html;charset=utf-8"});response.end(html);
  }catch{response.writeHead(500);response.end();}});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();if(!address||typeof address==="string")throw Error("Owned native loopback required");base="http://127.0.0.1:"+address.port;
  const grant=f.storage.createDownloadGrant.bind(f.storage);
  f.storage.createDownloadGrant=async(key,options)=>({...await grant(key,options),downloadUrl:base+'/__test-storage?key='+encodeURIComponent(key)});
  const {chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??"playwright-core");browser=await chromium.launch({headless:true,...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{}),args:["--no-sandbox"]});await mkdir(evidence,{recursive:true});
 });
 afterAll(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await app?.close();await f?.dispose();if(output)await rm(output,{recursive:true,force:true});});

 it("keeps native GET and QR scoped to this source and revalidates the same session after real role revocation or disabling",async()=>{
  const root=await get('root',path(sourceId));expect(root.statusCode).toBe(200);
  expect(root.json()).toMatchObject({qrAvailable:true,canDispatch:true,sheet:{sourceId,status:'published',roundNumber:1},fixedCutting:{valid:true},materialReadiness:[{available:true,verified:true}]});
  const draft=await get('root',path(draftId));expect(draft.statusCode).toBe(200);expect(draft.json()).toMatchObject({sheet:{status:'draft'},dispatch:null,tasks:[]});
  const worker=await get('pattern-room-worker',path(sourceId));expect(worker.statusCode).toBe(200);expect(worker.json().canDispatch).toBe(false);expect(worker.json().tasks.some((t:{taskId:string})=>t.taskId===paperId)).toBe(true);expect(worker.json().tasks.some((t:{taskKind:string})=>t.taskKind==='development_materials')).toBe(false);
  expect((await get('pattern-room-worker',path(foreignSourceId))).statusCode).toBe(404);
  for(const role of ['pattern-room-supervisor','development-clerk'])expect((await get(role,path(sourceId))).statusCode).toBe(200);
  const qr=await get('pattern-room-worker',path(sourceId)+`/tasks/${paperId}/qr`);expect(qr.statusCode).toBe(200);expect(qr.headers['content-type']).toContain('image/png');expect(qr.rawPayload.length).toBeGreaterThan(100);
  expect((await get('root',path(sourceId)+`/tasks/${foreignTaskId}/qr`)).statusCode).toBe(404);
  const token=tokens.get('pattern-room-worker'),assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='pattern_room_worker' AND revoked_at IS NULL",[f.people['pattern-room-worker']!.actorId])).rows[0]!;
  await f.access.revokeRole(f.root,assignment.assignment_id,'TEST S1 same-session role revocation');
  expect([401,403,404]).toContain((await get('pattern-room-worker',path(sourceId))).statusCode);expect(tokens.get('pattern-room-worker')).toBe(token);
  await employeeAccess.disableAccess(f.root,f.people['worker-a']!.actorId,'TEST S1 native Root disable');
  expect((await get('worker-a',path(sourceId))).statusCode).toBe(401);
  expect((await get('root',path(sourceId))).statusCode).toBe(200);
  await f.access.assignRole(f.root,{userId:f.people['pattern-room-worker']!.actorId,roleCode:'pattern_room_worker',reason:'TEST restore native assignment for the independent page case'});
 });
 it("renders original development documents, material facts and technical panel while retaining unsubmitted input across tabs",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);const page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===base||['data:','blob:'].includes(url.protocol)?route.continue():route.abort();});
  try{
   const ready=page.waitForResponse(response=>response.url().endsWith('/api'+path(sourceId))&&response.status()===200);
   await page.goto(base+`/ui/digital-production?task=${paperId}&taskView=handle`);await ready;
   await page.getByLabel('开发工序工作台',{exact:true}).waitFor();await page.getByText('TEST S1 原制作说明',{exact:true}).waitFor();
   await page.getByText('本轮技术资料与异常处理',{exact:true}).click();const technical=page.getByLabel('开发周期与技术依据',{exact:true});await technical.waitFor();
   await technical.getByLabel('原因',{exact:true}).fill('TEST S1 尚未提交的技术原因');
   await page.getByRole('button',{name:'本单资料',exact:true}).click();await page.getByRole('button',{name:'开发单',exact:true}).click();await page.locator('.order-document-container').waitFor();
   await page.getByRole('button',{name:'面辅料与检测报告',exact:true}).click();await page.locator('.order-document-container').getByText('TEST棉布',{exact:false}).first().waitFor();
   await page.locator('.order-document-container').getByRole('heading',{name:'面辅料与检测报告',exact:true}).waitFor();
   await page.locator('.order-document-container').getByText('主布 · 主布 · TEST40支 · 发布时已有实物',{exact:false}).waitFor();
   await page.screenshot({path:join(evidence,'development-materials-1165.png'),fullPage:true});
   await page.getByRole('button',{name:'当前办理',exact:true}).click();await technical.waitFor({state:'visible'});expect(await technical.getByLabel('原因',{exact:true}).inputValue()).toBe('TEST S1 尚未提交的技术原因');
   expect(errors).toEqual([]);await page.screenshot({path:join(evidence,'development-technical-1165.png'),fullPage:true});
  }catch(error){await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure-body.txt'),await page.locator('body').innerText());throw error;}finally{await context.close();}
 });
 it('clears only acknowledged paper and sewing uploads after native completion, retaining the real unsaved guard',async()=>{
  // The preceding authorization case deliberately revokes the old session's
  // role. Use a fresh native login after its audited role restoration.
  tokens.set('pattern-room-worker',await loginRole('pattern-room-worker'));
  const context=await browser.newContext({viewport:{width:1165,height:1003}});await context.addCookies([{name:'dx_rework_session',value:tokens.get('pattern-room-worker')!,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  let artifactAttempt=0;
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin===base&&request.method()==='POST'&&url.pathname.endsWith('/technical/artifacts')){
    artifactAttempt++;
    if(artifactAttempt===1)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{message:'TEST临时拒绝，原输入保留'}})});
    if(artifactAttempt===2){expect((await route.fetch()).status()).toBe(200);return route.abort('failed');}
   }
   if(url.origin===base||['data:','blob:'].includes(url.protocol))return route.continue();
   if(url.origin!=='https://private.example.test'||request.method()!=='POST')return route.abort();
   // Only the private object store is synthetic; intent, finalization, source
   // access, technical versions and completion use the original authenticated API.
   const form=await new Response(request.postDataBuffer(),{headers:{'content-type':request.headers()['content-type']!}}).formData();
   const key=String(form.get('key')),file=form.get('file') as File,bytes=new Uint8Array(await file.arrayBuffer()),sha256=createHash('sha256').update(bytes).digest('hex');
   expect(f.storage.signed.some(grant=>grant.method==='POST'&&grant.objectKey===key)).toBe(true);expect(sha256).toBe(form.get('x-oss-meta-sha256'));
   await f.storage.writeImmutable(key,bytes,{mimeType:file.type,sha256});await route.fulfill({status:204,headers:{'access-control-allow-origin':'*'}});
  });
  const leavingBlocked=()=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
  try{
   const allowed=await get('pattern-room-worker',path(uploadSourceId));expect(allowed.statusCode,allowed.body).toBe(200);
   expect(allowed.json().tasks.find((task:{taskId:string})=>task.taskId===uploadPaperId)).toMatchObject({state:'ready',canExecute:true});
   await page.goto(base+`/ui/digital-production?task=${uploadPaperId}&taskView=handle`);await page.getByRole('heading',{name:'纸样三件套',exact:true}).waitFor();
   await page.getByLabel('选择PLT文件',{exact:true}).setInputFiles({name:'TEST-acknowledged-paper.plt',mimeType:'application/octet-stream',buffer:Buffer.from('IN;SP1;PU0,0;PD100,100;SP0;')});
   await expect.poll(()=>page.locator('.task-workbench-sample footer').innerText()).toContain('附件已上传，尚未随本次办理提交');expect(await leavingBlocked()).toBe(true);
   await page.getByLabel('第1项用量单位',{exact:true}).fill('米');await page.getByLabel('第1项单件用量',{exact:true}).fill('1.5');
   await page.getByLabel('尺码列（逗号或顿号分隔）',{exact:true}).fill('M');await page.getByLabel('基码',{exact:true}).selectOption('M');
   await page.getByRole('button',{name:'添加测量部位',exact:true}).click();await page.getByLabel('第1部位名称',{exact:true}).fill('胸围');await page.getByLabel('胸围 M',{exact:true}).fill('48');
   const rejected=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/technical/artifacts'));
   await page.getByRole('button',{name:'发布技术成果',exact:true}).click();expect((await rejected).status()).toBe(409);
   await page.getByRole('alert').filter({hasText:'TEST临时拒绝'}).waitFor();expect(await leavingBlocked()).toBe(true);expect(await page.getByText('已上传，尚未保存引用',{exact:false}).count()).toBe(1);
   await page.getByRole('button',{name:'发布技术成果',exact:true}).click();await page.getByRole('alert').filter({hasText:'尚未确认本次提交是否成功'}).waitFor();
   expect(await leavingBlocked()).toBe(true);expect(await page.getByText('已上传，尚未保存引用',{exact:false}).count()).toBe(1);
   const published=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/technical/artifacts'));
   await page.getByRole('button',{name:'重新读取办理状态',exact:true}).click();expect((await published).status()).toBe(200);
   await expect.poll(()=>page.locator('.task-workbench-sample footer').innerText()).not.toContain('尚未');
   await expect.poll(leavingBlocked).toBe(false);
   const complete=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/complete'));
   await page.getByRole('button',{name:'纸样完成，交给下一位',exact:true}).click();expect((await complete).status()).toBe(200);
   await expect.poll(()=>page.locator('.task-workbench-sample footer').innerText()).toContain('已完成');await expect.poll(leavingBlocked).toBe(false);
   const saved=await execution.read(f.people['pattern-room-worker']!,uploadSourceId),artifact=saved.technical!.artifacts.find(row=>row.status==='published')!;
   expect(saved.tasks.find(task=>task.taskId===uploadPaperId)?.state).toBe('completed');expect(artifact.body.pltAttachmentIds).toHaveLength(1);expect(artifact.body.consumptionRows[0]?.consumption).toBe('1.5');
   const original=(await f.db.query('SELECT status,object_key FROM attachments WHERE attachment_id=$1',[artifact.body.pltAttachmentIds[0]])).rows[0]!;
   expect(original.status).toBe('ready');expect(f.storage.objectBytes.has(original.object_key)).toBe(true);expect(f.storage.deleted).not.toContain(original.object_key);
   expect(saved.technical!.artifacts).toHaveLength(1);expect(artifactAttempt).toBe(3);
   await page.screenshot({path:join(evidence,'acknowledged-paper-1165.png'),fullPage:true});
   const cutting=saved.tasks.find(task=>task.taskKind==='development_cutting')!;
   await execution.complete(f.root,uploadSourceId,{taskId:cutting.taskId,note:'TEST original actual cutting predecessor',attachmentIds:[]},randomUUID());
   const sewing=(await execution.read(f.people['pattern-room-worker']!,uploadSourceId)).tasks.find(task=>task.taskKind==='development_sewing')!;
   expect(sewing).toMatchObject({state:'ready',canExecute:true});
   await page.goto(base+`/ui/digital-production?task=${sewing.taskId}&taskView=handle`);await page.getByRole('button',{name:'本单资料 · 车板成果上传',exact:true}).click();
   const photo=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer();
   await page.getByLabel('车板成果',{exact:true}).setInputFiles({name:'TEST-acknowledged-sewing.png',mimeType:'image/png',buffer:photo});
   await page.getByText('已上传，尚未保存引用',{exact:false}).waitFor();await page.getByRole('button',{name:'当前办理',exact:true}).click();
   await expect.poll(()=>page.locator('.task-workbench-sample footer').innerText()).toContain('附件已上传，尚未随本次办理提交');expect(await leavingBlocked()).toBe(true);
   const sewn=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/route'));
   await page.getByRole('button',{name:'车板完成，交给下一位',exact:true}).click();expect((await sewn).status()).toBe(200);
   await expect.poll(()=>page.locator('.task-workbench-sample footer').innerText()).toContain('已完成');await expect.poll(leavingBlocked).toBe(false);
   expect((await execution.read(f.root,uploadSourceId)).tasks.find(task=>task.taskId===sewing.taskId)?.state).toBe('completed');
   await page.screenshot({path:join(evidence,'acknowledged-sewing-1165.png'),fullPage:true});
  }catch(error){await page.screenshot({path:join(evidence,'upload-state-failure.png'),fullPage:true});await writeFile(join(evidence,'upload-state-failure.txt'),await page.locator('body').innerText());throw error;}finally{await context.close();}
 });
 it('settles failed external-paper previews only after the original receipt and a fresh completed task, preserving uncertain submissions',async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});await context.addCookies([{name:'dx_rework_session',value:tokens.get('pattern-room-supervisor')!,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  let attempts=0,failNextRead=false;const commands:Array<{key:string|undefined;body:unknown}>=[];
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin===base&&request.method()==='GET'&&url.pathname==='/api'+path(externalSourceId)&&failNextRead){failNextRead=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'TEST fresh execution read unavailable'}})});}
   if(url.origin===base&&request.method()==='POST'&&url.pathname==='/api'+path(externalSourceId)+'/external-pattern'){
    attempts++;commands.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()});
    if(attempts===1)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{message:'TEST临时拒收，原附件保留'}})});
    if(attempts===2){expect((await route.fetch()).status()).toBe(200);return route.abort('failed');}
    if(attempts===3)failNextRead=true;
   }
   if(url.origin===base||['data:','blob:'].includes(url.protocol))return route.continue();
   if(url.origin!=='https://private.example.test'||request.method()!=='POST')return route.abort();
   // Only object storage transport and explicitly named failures are synthetic.
   // All successful intents, finalization, receipt, replay and reads use native services.
   const form=await new Response(request.postDataBuffer(),{headers:{'content-type':request.headers()['content-type']!}}).formData();
   const key=String(form.get('key')),file=form.get('file') as File,bytes=new Uint8Array(await file.arrayBuffer()),sha256=createHash('sha256').update(bytes).digest('hex');
   expect(f.storage.signed.some(grant=>grant.method==='POST'&&grant.objectKey===key)).toBe(true);expect(sha256).toBe(form.get('x-oss-meta-sha256'));
   await f.storage.writeImmutable(key,bytes,{mimeType:file.type,sha256});await route.fulfill({status:204,headers:{'access-control-allow-origin':'*'}});
  });
  const leavingBlocked=()=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
  try{
   await page.goto(base+`/ui/digital-production?task=${externalTaskId}&taskView=handle`);
   const upload=page.getByLabel('收到的纸样附件',{exact:true});await upload.waitFor();
   await upload.setInputFiles({name:'TEST-remove-rejected.plt',mimeType:'application/octet-stream',buffer:Buffer.from('IN;SP0;')});
   const remove=page.getByRole('button',{name:'移除失败附件 TEST-remove-rejected.plt',exact:true});await remove.waitFor();
   await remove.scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'failed-external-paper-1165.png'),fullPage:true});
   await remove.click();await remove.waitFor({state:'detached'});expect(await page.getByRole('alert').count()).toBe(0);await expect.poll(leavingBlocked).toBe(false);
   const note=page.getByLabel('备注',{exact:true});await note.fill('TEST真实收到说明尚未提交');
   await upload.setInputFiles({name:'TEST-note-rejected.plt',mimeType:'application/octet-stream',buffer:Buffer.from('IN;SP0;')});
   const noteFailure=page.getByRole('button',{name:'移除失败附件 TEST-note-rejected.plt',exact:true});await noteFailure.waitFor();await noteFailure.click();await noteFailure.waitFor({state:'detached'});
   expect(await note.inputValue()).toBe('TEST真实收到说明尚未提交');expect(await leavingBlocked()).toBe(true);
   await upload.setInputFiles({name:'TEST-original-rejected.plt',mimeType:'application/octet-stream',buffer:Buffer.from('IN;SP0;')});
   await page.getByRole('button',{name:'移除失败附件 TEST-original-rejected.plt',exact:true}).waitFor();
   const png=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer();
   await upload.setInputFiles({name:'TEST-received-paper.png',mimeType:'image/png',buffer:png});
   await page.getByText('已上传，尚未保存引用',{exact:false}).waitFor();expect(await leavingBlocked()).toBe(true);
   const rejected=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/external-pattern'));
   await page.getByRole('button',{name:'记录已收到',exact:true}).click();expect((await rejected).status()).toBe(409);
   await page.getByRole('alert').filter({hasText:'TEST临时拒收'}).waitFor();expect(await page.getByText('已上传，尚未保存引用',{exact:false}).count()).toBe(1);
   await page.getByRole('button',{name:'移除失败附件 TEST-original-rejected.plt',exact:true}).waitFor();
   expect((await execution.read(f.root,externalSourceId)).externalPatterns.find(row=>row.requestId===externalRequestId)?.receivedAt).toBeNull();
   await page.getByRole('button',{name:'记录已收到',exact:true}).click();await page.getByRole('alert').filter({hasText:'尚未确认本次提交是否成功'}).waitFor();
   expect(await leavingBlocked()).toBe(true);expect(await page.getByText('已上传，尚未保存引用',{exact:false}).count()).toBe(1);
   const committed=await execution.read(f.root,externalSourceId);expect(committed.tasks.find(task=>task.taskId===externalTaskId)?.state).toBe('completed');
   // A later local failure is not part of the original submitted snapshot.
   await upload.setInputFiles({name:'TEST-later-rejected.plt',mimeType:'application/octet-stream',buffer:Buffer.from('IN;SP0;')});
   await page.getByRole('button',{name:'移除失败附件 TEST-later-rejected.plt',exact:true}).waitFor();
   await page.getByRole('button',{name:'重新读取办理状态',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'本次办理已提交，但最新资料暂未读取到'}).waitFor();
   expect(await page.getByRole('button',{name:'移除失败附件 TEST-original-rejected.plt',exact:true}).count()).toBe(1);expect(await leavingBlocked()).toBe(true);
   await page.getByRole('button',{name:'重新读取办理状态',exact:true}).click();
   await page.getByText('本任务已完成',{exact:true}).waitFor();
   expect(await page.getByRole('button',{name:'移除失败附件 TEST-original-rejected.plt',exact:true}).count()).toBe(0);
   const later=page.getByRole('button',{name:'移除失败附件 TEST-later-rejected.plt',exact:true});await later.waitFor();expect(await leavingBlocked()).toBe(true);
   await later.click();await later.waitFor({state:'detached'});await expect.poll(()=>page.locator('.task-workbench-sample footer').innerText()).toContain('已提交');await expect.poll(leavingBlocked).toBe(false);expect(attempts).toBe(3);
   expect(commands[1]!.key).toBeTruthy();expect(commands[2]).toEqual(commands[1]);
   const final=await execution.read(f.root,externalSourceId),record=final.externalPatterns.find(row=>row.requestId===externalRequestId)!;
   expect(record.receivedAt).toBeTruthy();expect(record.attachmentIds).toHaveLength(1);expect(final.externalPatterns).toHaveLength(1);
   const original=(await f.db.query('SELECT status,object_key FROM attachments WHERE attachment_id=$1',[record.attachmentIds[0]])).rows[0]!;
   expect(original.status).toBe('ready');expect(f.storage.objectBytes.has(original.object_key)).toBe(true);expect(f.storage.deleted).not.toContain(original.object_key);
   await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(evidence,'completed-external-paper-390.png'),fullPage:true});
  }catch(error){await page.screenshot({path:join(evidence,'failed-preview-regression.png'),fullPage:true});await writeFile(join(evidence,'failed-preview-regression.txt'),await page.locator('body').innerText());await writeFile(join(evidence,'failed-preview-error.txt'),String(error));throw error;}finally{await context.close();}
 });
 it('captures and supplements the original customer approval date in the authenticated App without creating another review',async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  try{
   await page.goto(base+`/ui/digital-production?task=${commentShippingId}&taskView=handle`);
   await page.getByText('登记实际客户样板确认',{exact:true}).click();
   await page.getByText('客户评语与最终批复',{exact:true}).click();
   await page.getByLabel('反馈性质',{exact:true}).selectOption('final');
   expect(await page.getByLabel('客户实际反馈时间',{exact:true}).inputValue()).toBe('unknown');
   await page.getByLabel('评语原意',{exact:true}).fill('TEST original customer approval without an invented time');
   await page.getByLabel('确认依据与原记录位置',{exact:true}).fill('TEST original message location');
   const save=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/technical/comments'));
   await page.getByRole('button',{name:'保存客户评语',exact:true}).click();expect((await save).status()).toBe(200);
   const form=page.getByRole('form',{name:'补充客户批复时间第1版',exact:true});await form.waitFor();
   const before=(await f.db.query('SELECT * FROM digital_development_size_review_requests WHERE source_id=$1',[commentSourceId])).rows;expect(before).toHaveLength(1);
   await form.getByLabel('客户实际反馈日期',{exact:true}).fill('2026-11-09');
   await form.getByLabel('批复时间依据',{exact:true}).fill('TEST dated customer message, actual date only');
   const supplement=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/technical/comment-time'));
   await form.getByRole('button',{name:'保存批复时间',exact:true}).click();expect((await supplement).status()).toBe(200);
   await form.waitFor({state:'detached'});await page.getByText('第1版客户批复 · 实际发生：2026-11-09',{exact:false}).waitFor();
   expect((await f.db.query('SELECT * FROM digital_development_size_review_requests WHERE source_id=$1',[commentSourceId])).rows).toEqual(before);
   const facts=(await f.db.query('SELECT precision,occurred_at,occurred_date::text AS date FROM digital_development_comment_times WHERE source_id=$1',[commentSourceId])).rows;expect(facts).toEqual([{precision:'date',occurred_at:null,date:'2026-11-09'}]);
   await page.screenshot({path:join(evidence,'customer-approval-time-1165.png'),fullPage:true});
  }catch(error){await page.screenshot({path:join(evidence,'customer-approval-time-failure.png'),fullPage:true});await writeFile(join(evidence,'customer-approval-time-failure-body.txt'),await page.locator('body').innerText());throw error;}finally{await context.close();}
 });
 it("records a date-only material occurrence through the original App without replacing its registration time",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});
  await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===base||['data:','blob:'].includes(url.protocol)?route.continue():route.abort();});
  try{
   // The task's "本单资料" is a reader. Use the original editable development
   // entry and its handling chapter for a material business operation.
   await page.goto(base+`/ui/digital-production?development=${sourceId}`);
   await page.getByRole('button',{name:'轮次与记录',exact:true}).click();
   const form=page.locator('.development-material-events');
   await form.getByLabel('实际发生时间').selectOption('date');
   await form.getByLabel('发生日期',{exact:true}).fill('2026-11-09');
   await form.getByLabel('说明',{exact:true}).fill('TEST R5 original App material occurrence');
   const result=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes(`/sources/${sourceId}/development/materials/`)&&response.url().endsWith('/events'));
   await form.getByRole('button',{name:'确认记录',exact:true}).click();
   const response=await result;expect(response.status()).toBe(200);
   expect(response.request().postDataJSON().actualTime).toEqual({precision:'date',date:'2026-11-09'});
   const sheet=await response.json() as DevelopmentSheet,actual=sheet.materialEvents.find(event=>event.note==='TEST R5 original App material occurrence')!;
   expect(actual).toMatchObject({occurredAt:null,occurredDate:'2026-11-09',timeQuality:'补报未核实'});
   expect(actual.createdAt).not.toBeNull();
   const stored=(await f.db.query('SELECT occurred_at,recorded_at,payload FROM digital_production_task_events WHERE event_id=$1 AND resource_id=$2',[actual.eventId,sourceId])).rows[0]!;
   expect(stored.occurred_at).toBeNull();expect(stored.recorded_at).not.toBeNull();
   expect(stored.payload.actualCompletedDate).toBe('2026-11-09');
  }catch(error){await page.screenshot({path:join(evidence,'occurrence-failure.png'),fullPage:true});await writeFile(join(evidence,'occurrence-failure-body.txt'),await page.locator('body').innerText());await writeFile(join(evidence,'occurrence-failure-controls.json'),JSON.stringify(await page.locator('.development-material-events select').evaluateAll(selects=>selects.map(select=>select.outerHTML))));throw error;}finally{await context.close();}
 });
 it("inherits the original verified material occurrence when a new round explicitly retains the completed check",async()=>{
  const old=await new DigitalDevelopmentService(f.db,true).read(f.root,sourceId);
  const check=(await f.db.query("SELECT t.task_id,t.completed_at FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_materials' AND t.route_version=1 AND t.state='completed'",[sourceId])).rows[0]!;
  expect(check).toBeDefined();expect(check.completed_at).not.toBeNull();
  const rounds=new DevelopmentRoundService(f.db,true);
  const draft=await rounds.save(f.root,sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:old.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST only pattern changes; verified material check retained',explanation:'TEST preserve actual occurrence of inherited material',categories:['版型'],affectedNodes:['纸样'],outputKind:'整件样板'}},randomUUID());
  await rounds.publish(f.root,sourceId,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID());
  expect((await rounds.read(f.root,sourceId)).rounds[0]!.inherited.development_materials.taskId).toBe(check.task_id);
  const current=await new DigitalJourneyQuery(f.db).read(f.root,sourceId,2);
  const material=current.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===`material:${old.document!.materials[0]!.materialId}:2`)!;
  expect(material).toMatchObject({state:'completed',round:2,actualAt:check.completed_at.toISOString(),actualQuality:'verified'});
 });
 it("R5 blocks publication during quote loading, failed or unconfigured reads and publishes with the recovered native quote",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});
  await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);
  let release!:()=>void;const held=new Promise<void>(done=>{release=done;});
  let mode:'loading'|'failed'|'unconfigured'|'ready'='loading',publishes=0;
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!==base&&!['data:','blob:'].includes(url.protocol))return route.abort();
   if(request.method()==='POST'&&url.pathname.endsWith(`/sources/${draftId}/development/publish`))publishes++;
   if(/\/pattern-room\/category-options\/[^/]+\/quote$/.test(url.pathname)){
    if(mode==='loading')await held;
    if(mode==='failed'||mode==='unconfigured')return route.fulfill({status:mode==='failed'?503:409,contentType:'application/json',body:JSON.stringify({error:{code:mode==='failed'?'SERVICE_UNAVAILABLE':'PRICE_NOT_CONFIGURED',message:mode==='failed'?'TEST价格读取暂时失败':'TEST执行价尚未配置'}})});
   }
   return route.continue();
  });
  try{
   await page.goto(base+`/ui/digital-production?development=${draftId}`);
   await page.getByRole('button',{name:'打板信息',exact:true}).click();
   const publish=page.getByRole('button',{name:'发布开发单',exact:true}),refresh=page.getByRole('button',{name:'刷新价格',exact:true});
   await page.getByText('执行单价正在读取…',{exact:true}).waitFor();expect(await publish.isDisabled()).toBe(true);expect(publishes).toBe(0);
   mode='ready';release();await page.getByText('执行单价：10.000 元/件',{exact:true}).waitFor();await expect.poll(()=>publish.isEnabled()).toBe(true);
   mode='failed';await refresh.click();await page.getByRole('alert').filter({hasText:'TEST价格读取暂时失败'}).waitFor();expect(await publish.isDisabled()).toBe(true);expect(publishes).toBe(0);
   mode='unconfigured';await refresh.click();await page.getByRole('alert').filter({hasText:'TEST执行价尚未配置'}).waitFor();expect(await publish.isDisabled()).toBe(true);expect(publishes).toBe(0);
   mode='ready';await refresh.click();await page.getByText('执行单价：10.000 元/件',{exact:true}).waitFor();await expect.poll(()=>publish.isEnabled()).toBe(true);
   const response=page.waitForResponse(reply=>reply.request().method()==='POST'&&reply.url().endsWith(`/sources/${draftId}/development/publish`));await publish.click();
   const receipt=await response;expect(receipt.status(),await receipt.text()).toBe(200);expect(publishes).toBe(1);
   const native=(await f.db.query('SELECT o.status FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id) WHERE l.source_id=$1',[draftId])).rows;
   expect(native).toEqual([{status:'pending_assignment'}]);
  }catch(error){await page.screenshot({path:join(evidence,'quote-failure.png'),fullPage:true});await writeFile(join(evidence,'quote-failure-body.txt'),await page.locator('body').innerText());throw error;}
  finally{release();await context.close();}
 });
});
