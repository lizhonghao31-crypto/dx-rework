import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
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
import {DigitalProductionIdentityService} from "../../apps/api/src/production-platform/identity-service.js";
import {DigitalDevelopmentService} from "../../apps/api/src/production-platform/development-service.js";
import {DigitalProductionTaskService} from "../../apps/api/src/production-platform/task-service.js";
import {DigitalProductionAccessService} from "../../apps/api/src/production-platform/access-service.js";
import {DigitalProductionNotificationService} from "../../apps/api/src/production-platform/notification-service.js";
import {DigitalQuotationService} from "../../apps/api/src/production-platform/quotation-service.js";
import {DevelopmentDocumentSchema} from "@dx-rework/contracts/digital-development";
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
 let execution:DevelopmentExecutionService,employeeAccess:EmployeeAccessService,sourceId:string,paperId:string,foreignSourceId:string,foreignTaskId:string,draftId:string;
 const tokens=new Map<string,string>(),evidence=join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),"development-read");
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
   const saved=await forms.save(designer,source.sourceId,{expectedVersion:0,document},randomUUID());
   if(published)await forms.publish(designer,source.sourceId,saved.version,randomUUID(),{categoryId:category.priceId,priceVersion:category.version});
   return {id:source.sourceId,materialId};
  };
  const own=await prepare();sourceId=own.id;
  const fixed=await execution.read(f.root,sourceId);
  await execution.configureFixedCutting(f.root,sourceId,{expectedVersion:fixed.fixedCutting?.version??0,assigneeId:worker.actorId,reason:'TEST native fixed cutter'},randomUUID());
  const before=await execution.read(f.root,sourceId),check=before.tasks.find(t=>t.taskKind==='development_materials')!;
  const verified=await execution.saveMaterials(f.root,sourceId,{taskId:check.taskId,expectedVersion:before.materialVerification!.version,expectedDocumentVersion:before.sheet.version,entries:[{materialId:own.materialId,usage:'use',physical:true,quantity:true,color:true,specification:true,note:'TEST actual clerk verification',confirmedWith:''}],note:'TEST S1 material verification',result:'通过'},randomUUID());
  await execution.check(f.root,sourceId,{taskId:check.taskId,result:'通过',note:'TEST native material check',expectedVerificationVersion:verified.version,items:[{materialId:own.materialId,physical:true,quantity:true,color:true,specification:true}]},randomUUID());
  await arrangeTestRound(f.db,execution,f.root,sourceId,worker.actorId);
  paperId=(await execution.read(worker,sourceId)).tasks.find(t=>t.taskKind==='development_pattern')!.taskId;
  foreignSourceId=(await prepare()).id;foreignTaskId=(await execution.read(f.root,foreignSourceId)).tasks.find(t=>t.taskKind==='development_materials')!.taskId;
  draftId=(await prepare(false)).id;
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},digitalIdentity:{authenticate,root,service:identity,creationEnabled:true,developmentQrBase:'https://architecture.invalid/',developmentService:forms,developmentExecution:execution,developmentAttachments:f.attachments,quotationService:new DigitalQuotationService(f.db,true),taskService:tasks,accessService:new DigitalProductionAccessService(f.db),notificationService:new DigitalProductionNotificationService(f.db)}});await app.ready();
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
});
