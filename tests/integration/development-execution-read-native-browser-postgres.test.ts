import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID,createHash} from "node:crypto";
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
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
import {DevelopmentAmendmentService} from '../../apps/api/src/production-platform/development-amendment-service.js';
import {DigitalJourneyQuery} from "../../apps/api/src/production-platform/journey-query.js";
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {DevelopmentWorkspaceQuery} from '../../apps/api/src/production-platform/development-workspace-query.js';
import {DevelopmentWorkspaceFilterSchema} from '@dx-rework/contracts/digital-development-workspace';
import {DigitalProductionIdentityService} from "../../apps/api/src/production-platform/identity-service.js";
import {DigitalDevelopmentService} from "../../apps/api/src/production-platform/development-service.js";
import {DigitalProductionTaskService} from "../../apps/api/src/production-platform/task-service.js";
import {DigitalProductionAccessService} from "../../apps/api/src/production-platform/access-service.js";
import {DigitalProductionNotificationService} from "../../apps/api/src/production-platform/notification-service.js";
import {DigitalQuotationService} from "../../apps/api/src/production-platform/quotation-service.js";
import {DevelopmentDocumentSchema,type DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import type {DevelopmentReturnIssue} from '@dx-rework/contracts/digital-development-amendments';
import {PatternRoomOrderService} from "../../apps/api/src/pattern-room/order-service.js";
import {PatternRoomPriceService} from "../../apps/api/src/pattern-room/price-service.js";
import {RootAwareTodoProjectionService} from "../../apps/api/src/todos/root-aware-projection-service.js";
import {TodoService} from "../../apps/api/src/todos/service.js";
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {arrangeTestRound} from "../helpers/development-arrangement-fixture.js";
import {businessAnchorFixture} from "../helpers/business-anchor-fixture.js";
import {createHistoricalPatternFixture} from '../helpers/historical-pattern-fixture.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("S1 development read through original App and native signed identity",()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,app:ReturnType<typeof buildApp>,browser:Browser,server:Server,output:string,base:string;
 let prepareDevelopment:(published?:boolean,accessoryId?:string)=>Promise<{id:string;materialId:string}>;
 let execution:DevelopmentExecutionService,employeeAccess:EmployeeAccessService,sourceId:string,paperId:string,foreignSourceId:string,foreignTaskId:string,draftId:string,commentSourceId:string,commentShippingId:string,uploadSourceId:string,uploadPaperId:string;
 let externalSourceId:string,externalTaskId:string,externalRequestId:string;
 const tokens=new Map<string,string>(),evidence=join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),"development-read");
 const readerRequests=new Map<string,Set<Promise<void>>>(),closedReaderSessions=new Set<string>();
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
  const prepare=prepareDevelopment=async(published=true,accessoryId?:string)=>{
   const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:'TEST-S1-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const materialId=randomUUID(),photo=await f.image(designer);
   const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[],template:'上衣',quantity:1,sampleSize:'',orderDate:null,returnDate:null,unit:'cm',sizes:[],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST S1 原制作说明',craft:'无',washing:'免洗',materials:[{materialId,category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'',color:'黑',specification:'TEST40支',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:photo,kind:'款图'}]});
   document.patternCategoryId=category.priceId;
   if(accessoryId)document.materials.push({...document.materials[0]!,materialId:accessoryId,category:'辅料',label:'TEST 必需纽扣',name:'TEST 必需纽扣',available:false,expectedDate:'2027-01-01'});
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
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},patternRoomOrders:{authenticate,root,service:native,attachments:f.attachments},patternRoomPrices:{authenticate,root,service:prices},digitalIdentity:{authenticate,root,service:identity,creationEnabled:true,developmentQrBase:'https://architecture.invalid/',developmentService:forms,developmentRounds:new DevelopmentRoundService(f.db,true,native),developmentExecution:execution,developmentAttachments:f.attachments,journeys:new DigitalJourneyQuery(f.db),quotationService:new DigitalQuotationService(f.db,true),taskService:tasks,accessService:new DigitalProductionAccessService(f.db),notificationService:new DigitalProductionNotificationService(f.db)}});await app.ready();
  for(const role of ['root','pattern-room-worker','worker-a','pattern-room-supervisor','development-clerk'])tokens.set(role,(await auth.loginMobile(mintAcceptanceLoginCode(role,secret))).token);
  output=await mkdtemp(join(tmpdir(),"dx-development-read-native-"));const previous=process.env.NODE_ENV;
  try{process.env.NODE_ENV="production";await build({root:resolve("apps/web"),configFile:resolve("apps/web/vite.config.ts"),mode:"production",base:"/",build:{outDir:output,emptyOutDir:true}});}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
  const html=await readFile(join(output,"index.html"));
  server=createServer(async(request,response)=>{
   const readerSession=typeof request.headers['x-test-original-reader']==='string'?request.headers['x-test-original-reader']:undefined;
   if(readerSession&&closedReaderSessions.has(readerSession)){response.writeHead(410);response.end();return;}
   let settle:(()=>void)|undefined;const active=readerSession?readerRequests.get(readerSession):undefined;
   if(active){let finish!:()=>void;const pending=new Promise<void>(done=>{finish=done;});active.add(pending);settle=()=>{active.delete(pending);finish();};}
   try{
   const path=request.url??"/";
   if(path.startsWith('/__test-storage?')){const key=new URL(path,'http://TEST.invalid').searchParams.get('key')!,bytes=f.storage.objectBytes.get(key);response.writeHead(bytes?200:404,{'content-type':f.storage.objects.get(key)?.mimeType??'application/octet-stream'});response.end(bytes?Buffer.from(bytes):undefined);return;}
   if(path.startsWith("/api/")){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const payload=Buffer.concat(chunks),headers={...request.headers,host:"architecture.invalid",origin:"https://architecture.invalid"};delete headers["content-length"];
    const reply=await app.inject({method:request.method as "GET"|"POST"|"PATCH"|"DELETE",url:path.slice(4),headers,...(payload.length?{payload}:{})});response.writeHead(reply.statusCode,reply.headers);response.end(reply.rawPayload);return;
   }
   if(path.startsWith("/assets/")){const asset=new URL(path,"http://TEST.invalid").pathname;if(!/^\/assets\/[A-Za-z0-9_.-]+$/.test(asset)){response.writeHead(400);response.end();return;}response.writeHead(200,{"content-type":extname(asset)===".css"?"text/css":"text/javascript"});response.end(await readFile(join(output,asset.slice(1))));return;}
   response.writeHead(200,{"content-type":"text/html;charset=utf-8"});response.end(html);
  }catch{response.writeHead(500);response.end();}finally{settle?.();}});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();if(!address||typeof address==="string")throw Error("Owned native loopback required");base="http://127.0.0.1:"+address.port;
  const grant=f.storage.createDownloadGrant.bind(f.storage);
  f.storage.createDownloadGrant=async(key,options)=>({...await grant(key,options),downloadUrl:base+'/__test-storage?key='+encodeURIComponent(key)});
  const {chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??"playwright-core");browser=await chromium.launch({headless:true,...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{}),args:["--no-sandbox"]});await mkdir(evidence,{recursive:true});
 });
 afterAll(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await app?.close();await f?.dispose();if(output)await rm(output,{recursive:true,force:true});});

 it('reads an exact original development revision as the real designer without editable controls, latest fallback or business writes',async()=>{
  const designer=f.people['sample-designer']!,clerk=f.people['development-clerk']!,forms=new DigitalDevelopmentService(f.db,true),amendments=new DevelopmentAmendmentService(f.db,true);
  const pdf=new PDFDocument({size:'A4'}),chunks:Buffer[]=[],finished=new Promise<Buffer>((done,reject)=>{pdf.on('data',chunk=>chunks.push(Buffer.from(chunk)));pdf.on('end',()=>done(Buffer.concat(chunks)));pdf.on('error',reject);});pdf.text('TEST original paper-pattern making record - generic PDF');pdf.end();
  const pdfBytes=await finished,pdfId=randomUUID(),pdfKey=`TEST-original-reader/${pdfId}`,pdfHash=createHash('sha256').update(pdfBytes).digest('hex');
  await f.storage.writeImmutable(pdfKey,pdfBytes,{mimeType:'application/pdf',sha256:pdfHash});
  await f.db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-legacy-original.pdf','application/pdf',$3,$4,$5,'ready',CURRENT_TIMESTAMP)",[pdfId,pdfKey,pdfBytes.length,pdfHash,designer.actorId]);
  const own=await prepareDevelopment(),originalImage=(await forms.read(designer,own.id)).document!.files[0]!.attachmentId;
  const native=new PatternRoomOrderService(f.db,new RootAwareTodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
  const link=(await f.db.query('SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1',[own.id])).rows[0]!;
  const adopted=await native.get(designer,link.order_id);
  expect(adopted.note).toBe('TEST S1 原制作说明');expect(adopted.attachments.map(file=>file.attachmentId)).toEqual([originalImage]);
  // An existing legacy shape has no technical PLT version. Its own generic PDF
  // remains an original PDF; it must not acquire another source/round's PLT.
  const legacyPdfId=pdfId;
  const price=(await f.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled AND amount IS NOT NULL LIMIT 1")).rows[0]!;
  const legacy=await createHistoricalPatternFixture(native,designer,{styleNo:'TEST-LEGACY-ORIGINAL-'+randomUUID(),categoryId:price.price_id,priceVersion:price.version,quantity:1,attachmentIds:[legacyPdfId],note:'TEST 历史纸样原说明'},randomUUID());
  const before=await execution.read(clerk,own.id),check=before.tasks.find(task=>task.taskKind==='development_materials')!;
  const entries=[{materialId:own.materialId,usage:'use' as const,physical:true,quantity:true,color:true,specification:false,note:'TEST原规格需补正',confirmedWith:''}],issues:DevelopmentReturnIssue[]=[{materialId:own.materialId,field:'specification',reason:'TEST原规格待更正'},{materialId:null,field:'files',reason:'TEST本轮附件资料待更正'},{materialId:null,field:'instructions',reason:'TEST制作说明待更正'}];
  const verified=await execution.saveMaterials(clerk,own.id,{taskId:check.taskId,expectedVersion:before.materialVerification!.version,expectedDocumentVersion:before.sheet.version,entries,result:'缺项退回',returnIssues:issues},randomUUID());
  await execution.check(clerk,own.id,{taskId:check.taskId,expectedVerificationVersion:verified.version,result:'缺项退回',note:'TEST真实文员退回规格',returnIssues:issues,items:entries.map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))},randomUUID());
  const supply=(await execution.read(designer,own.id)).tasks.find(task=>task.taskKind==='development_material_supply'&&task.state==='ready')!;
  const prior=await amendments.read(designer,own.id,supply.taskId),document=structuredClone(prior.document),newImage=await f.image(designer);document.materials[0]!.specification='TEST42支';document.instructions='TEST 新修订制作说明';document.files=[{attachmentId:newImage,kind:'款图'}];
  const draft=await amendments.save(designer,own.id,{taskId:supply.taskId,roundNumber:1,expectedDocumentVersion:prior.documentVersion,expectedDraftVersion:0,document,reason:'TEST仅更正原退回规格'},randomUUID());
  await amendments.submit(designer,own.id,{taskId:supply.taskId,roundNumber:1,expectedDocumentVersion:prior.documentVersion,expectedDraftVersion:draft.draftVersion},randomUUID());
  const current=await forms.read(designer,own.id),snapshot=await f.db.query('SELECT to_jsonb(d) AS value FROM digital_development_documents d WHERE source_id=$1',[own.id]);
  const readerSession=randomUUID(),active=new Set<Promise<void>>();
  const context=await browser.newContext({viewport:{width:1165,height:747},extraHTTPHeaders:{'x-test-original-reader':readerSession}});readerRequests.set(readerSession,active);
  await context.addInitScript(()=>{
   const replace=history.replaceState;
   history.replaceState=function(data,unused,url){
    const saved=(data as {dxInternalRestoreScroll?:{path:string;top:number}}|null)?.dxInternalRestoreScroll;
    // Record the original router's actual departure point, after route loading
    // preparation. A pre-click sample can precede pending old-page layout.
    if(saved?.path===location.pathname+location.search&&new URLSearchParams(location.search).get('workspace')==='designer')
     (window as unknown as {testOriginalDepartureTop:number}).testOriginalDepartureTop=saved.top;
    replace.call(this,data,unused,url);
   };
  });
  await context.addCookies([{name:'dx_rework_session',value:await loginRole('sample-designer'),url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  const writes:string[]=[],reads:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/')){if(!['GET','HEAD','OPTIONS'].includes(request.method()))writes.push(request.method()+' '+url.pathname);else reads.push(url.pathname+url.search);}});
  const open=async(version:number)=>page.goto(base+`/ui/digital-production?development=${own.id}&round=1&developmentDocumentVersion=${version}`);
  try{
   const workspace=base+`/ui/digital-production?${new URLSearchParams({workspace:'designer',section:'workspace',development:own.id,round:'1',area:'records',selected:own.id,page:'1'})}`;
   await page.goto(workspace);const firstOriginal=page.getByRole('region',{name:'开发资料原版本',exact:true}).getByRole('button',{name:`开发单 · 第1轮 · 资料版本 ${prior.documentVersion} · 已发布`,exact:true});await firstOriginal.waitFor();await firstOriginal.scrollIntoViewIfNeeded();
   const search=page.getByRole('region',{name:'本单原单据目录',exact:true}).getByLabel('搜索原单与版本',{exact:true});
   await search.fill('资料版本 '+prior.documentVersion);await firstOriginal.waitFor();
   await expect.poll(()=>new URL(page.url()).searchParams.get('originalSearch')).toBe('资料版本 '+prior.documentVersion);
   expect(reads.some(path=>/\/development\/versions\/\d+\?/.test(path))).toBe(false);
   await firstOriginal.click();const original=page.getByRole('region',{name:'开发原单精确版本',exact:true});await original.waitFor();const originalTop=await page.evaluate(()=>(window as unknown as {testOriginalDepartureTop:number}).testOriginalDepartureTop);expect(Number.isFinite(originalTop)).toBe(true);
   expect(await page.locator(`#development-${own.materialId}-specification`).textContent()).toBe('TEST40支');
   expect(await page.locator('.dx-doc-status').textContent()).toContain('资料版本 '+prior.documentVersion);
   const oldFile=`/sources/${own.id}/development/versions/${prior.documentVersion}/attachments/${originalImage}`;
   expect(await original.locator(`img[src*="${oldFile}"]`).count()).toBeGreaterThan(0);expect(await original.locator(`img[src*="${newImage}"]`).count()).toBe(0);
   expect(await page.locator('.order-document-layout > nav').count()).toBe(0);expect(await page.locator('input[type="file"]').count()).toBe(0);
   for(const name of ['保存草稿','发布开发单','发起实际修改 / 复版'])expect(await page.getByRole('button',{name,exact:true}).count()).toBe(0);
   await page.goBack();await firstOriginal.waitFor();await expect.poll(async()=>Math.abs(await page.evaluate(()=>window.scrollY)-originalTop)).toBeLessThanOrEqual(2);
   expect(new URL(page.url()).searchParams.get('selected')).toBe(own.id);expect(new URL(page.url()).searchParams.get('area')).toBe('records');
   expect(await search.inputValue()).toBe('资料版本 '+prior.documentVersion);
   await firstOriginal.click();await original.waitFor();
   const width=await original.boundingBox();await page.getByRole('button',{name:'切换单据',exact:true}).click();const chooser=page.getByRole('dialog',{name:'切换单据',exact:true});await chooser.waitFor();
   await chooser.getByRole('button',{name:`开发单 · 第1轮 · 资料版本 ${current.version} · 已发布`,exact:true}).waitFor();
   expect((await original.boundingBox())?.width).toBe(width?.width);await page.keyboard.press('Escape');await chooser.waitFor({state:'hidden'});
   expect(await page.getByRole('button',{name:'切换单据',exact:true}).evaluate(element=>element===document.activeElement)).toBe(true);
   await page.getByRole('button',{name:'切换单据',exact:true}).click();await chooser.getByLabel('搜索原单与版本',{exact:true}).fill('资料版本 '+current.version);
   await expect.poll(()=>chooser.getByRole('button',{name:/开发单 · 第1轮/}).count()).toBe(1);
   await chooser.getByRole('button',{name:`开发单 · 第1轮 · 资料版本 ${current.version} · 已发布`,exact:true}).click();await chooser.waitFor({state:'hidden'});
   await expect.poll(()=>page.locator(`#development-${own.materialId}-specification`).textContent()).toBe('TEST42支');
   expect(await page.locator('.dx-doc-status').textContent()).toContain('资料版本 '+current.version);
   expect(await original.locator(`img[src*="/versions/${current.version}/attachments/${newImage}"]`).count()).toBeGreaterThan(0);expect(await original.locator(`img[src*="${originalImage}"]`).count()).toBe(0);
   await page.goBack();await expect.poll(()=>page.locator(`#development-${own.materialId}-specification`).textContent()).toBe('TEST40支');
   expect((await native.get(designer,link.order_id)).note).toBe(adopted.note);expect((await native.get(designer,link.order_id)).attachments).toEqual(adopted.attachments);
   const currentUrl=new URL(page.url()),returnTo=currentUrl.pathname+currentUrl.search;
   const priorReads=reads.length;
   const legacyReply=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/pattern-room/orders/${legacy.orderId}`&&response.request().method()==='GET');
   await page.goto(base+`/ui/pattern-room/orders/${legacy.orderId}?${new URLSearchParams({round:legacy.currentRoundId,readOnly:'history',returnTo})}`);
   const legacyResponse=await legacyReply;expect(legacyResponse.status()).toBe(200);expect(await legacyResponse.json()).toMatchObject({orderId:legacy.orderId,currentRoundId:legacy.currentRoundId});
   await expect.poll(()=>page.locator('.page-heading h1').innerText()).toContain(legacy.styleNo);await page.getByText(legacy.note!,{exact:false}).first().waitFor();
   expect(await page.getByText('TEST 新修订制作说明',{exact:false}).count()).toBe(0);
   const pdfReply=page.waitForResponse(response=>response.url().includes('/pattern-room/attachments/'+legacyPdfId+'/download')&&response.request().method()==='GET');
   await page.getByRole('button',{name:'预览 TEST-legacy-original.pdf',exact:true}).click();expect((await pdfReply).status()).toBe(302);
   const response=await context.request.get(base+'/api/pattern-room/attachments/'+legacyPdfId+'/download?mode=preview');expect(response.headers()['content-type']).toContain('application/pdf');expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(pdfHash);
   const preview=page.getByRole('dialog',{name:'制作资料预览',exact:true});expect(await preview.locator('iframe[title="TEST-legacy-original.pdf"]').count()).toBe(1);await preview.getByRole('button',{name:'关闭',exact:true}).click();
   expect(reads.slice(priorReads).some(path=>path.includes('/technical/')||path.includes('.plt'))).toBe(false);expect((await native.get(designer,legacy.orderId)).attachments.map(file=>file.attachmentId)).toEqual([legacyPdfId]);
   expect(await page.locator('input[type="file"]').count()).toBe(0);expect(await page.getByRole('button',{name:'更新任务资料',exact:true}).count()).toBe(0);
   await page.getByRole('link',{name:'返回来源列表',exact:true}).click();await original.waitFor();expect(new URL(page.url()).searchParams.get('development')).toBe(own.id);expect(new URL(page.url()).searchParams.get('developmentDocumentVersion')).toBe(String(prior.documentVersion));
   await page.getByRole('button',{name:'返回来源',exact:true}).click();await firstOriginal.waitFor();expect(new URL(page.url()).searchParams.get('selected')).toBe(own.id);expect(new URL(page.url()).searchParams.get('area')).toBe('records');
   await open(current.version+100);await page.getByRole('alert').filter({hasText:'原记录不存在或当前不可见'}).waitFor();expect(await original.count()).toBe(0);
   expect(writes).toEqual([]);expect((await forms.read(designer,own.id)).version).toBe(current.version);
   expect((await f.db.query('SELECT to_jsonb(d) AS value FROM digital_development_documents d WHERE source_id=$1',[own.id])).rows).toEqual(snapshot.rows);
  }catch(error){await writeFile(join(evidence,'original-reader-failure.json'),JSON.stringify({url:page.url(),body:await page.locator('body').innerText(),position:await page.evaluate(()=>({actual:window.scrollY,departed:(window as unknown as {testOriginalDepartureTop?:number}).testOriginalDepartureTop,history:window.history.state})),reads,writes},null,2));throw error;}
  finally{closedReaderSessions.add(readerSession);await context.close();while(active.size)await Promise.allSettled([...active]);readerRequests.delete(readerSession);}
 });
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
  let attempts=0,failNextRead=false,holdFinalPeople=false;const commands:Array<{key:string|undefined;body:unknown}>=[];
  let releaseFinalPeople!:()=>void,finalPeopleRequested!:()=>void;
  const finalPeopleHold=new Promise<void>(done=>{releaseFinalPeople=done;}),finalPeopleStarted=new Promise<void>(done=>{finalPeopleRequested=done;});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(holdFinalPeople&&url.origin===base&&request.method()==='GET'&&url.pathname==='/api/digital-production/access/candidates'){
    finalPeopleRequested();await finalPeopleHold;return route.continue();
   }
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
   holdFinalPeople=true;await page.getByRole('button',{name:'重新读取办理状态',exact:true}).click();
   await finalPeopleStarted;
   await page.getByText('本任务已完成',{exact:true}).waitFor();
   // Native task state renders before the original candidate read finishes.
   // Keep that read pending to prove completion feedback has not settled yet.
   const originalFailure=page.getByRole('button',{name:'移除失败附件 TEST-original-rejected.plt',exact:true});
   expect(await originalFailure.count()).toBe(1);expect(await page.getByRole('button',{name:'重新读取办理状态',exact:true}).isDisabled()).toBe(true);
   releaseFinalPeople();await originalFailure.waitFor({state:'detached'});
   expect(await page.getByRole('button',{name:'移除失败附件 TEST-original-rejected.plt',exact:true}).count()).toBe(0);
   const later=page.getByRole('button',{name:'移除失败附件 TEST-later-rejected.plt',exact:true});await later.waitFor();expect(await leavingBlocked()).toBe(true);
   await later.click();await later.waitFor({state:'detached'});await expect.poll(()=>page.locator('.task-workbench-sample footer').innerText()).toContain('已提交');await expect.poll(leavingBlocked).toBe(false);expect(attempts).toBe(3);
   expect(commands[1]!.key).toBeTruthy();expect(commands[2]).toEqual(commands[1]);
   const final=await execution.read(f.root,externalSourceId),record=final.externalPatterns.find(row=>row.requestId===externalRequestId)!;
   expect(record.receivedAt).toBeTruthy();expect(record.attachmentIds).toHaveLength(1);expect(final.externalPatterns).toHaveLength(1);
   const original=(await f.db.query('SELECT status,object_key FROM attachments WHERE attachment_id=$1',[record.attachmentIds[0]])).rows[0]!;
   expect(original.status).toBe('ready');expect(f.storage.objectBytes.has(original.object_key)).toBe(true);expect(f.storage.deleted).not.toContain(original.object_key);
   await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(evidence,'completed-external-paper-390.png'),fullPage:true});
  }catch(error){await page.screenshot({path:join(evidence,'failed-preview-regression.png'),fullPage:true});await writeFile(join(evidence,'failed-preview-regression.txt'),await page.locator('body').innerText());await writeFile(join(evidence,'failed-preview-error.txt'),String(error));throw error;}finally{releaseFinalPeople();await context.close();}
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
 it('opens the six workbench areas and returns from the authorized original task to the same order',async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:747}});
  const token=await loginRole('sample-designer');
  await context.addCookies([{name:'dx_rework_session',value:token,url:base}]);
  const page=await context.newPage(),requests:{method:string;path:string}[]=[];
  page.on('request',request=>requests.push({method:request.method(),path:new URL(request.url()).pathname}));
  try {
   const source=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0]!.design_style_no;
   const filters=new URLSearchParams({workspace:'designer',section:'workspace',search:source});
   const list=await app.inject({method:'GET',url:`/digital-production/workspaces/designer?layout=workbench&search=${source}&handling=waiting`,headers:{cookie:`dx_rework_session=${token}`}});
   expect(list.statusCode).toBe(200);
   expect(list.json()).toMatchObject({total:1,items:[{journey:{sourceId},handling:{complete:false,items:expect.arrayContaining([expect.objectContaining({id:paperId,kind:'waiting'})])}}]});
   await new JourneyFactRepository(f.db).buildOne({kind:'source',id:sourceId});
   const indexed=new DevelopmentWorkspaceQuery(new DigitalJourneyQuery(f.db,{listReadMode:'indexed'}),new DigitalProductionNotificationService(f.db));
   const matched=await indexed.designer(f.people['sample-designer']!,DevelopmentWorkspaceFilterSchema.parse({layout:'workbench',search:source,handling:'waiting'}));
   expect(matched.items.map(item=>item.handling)).toEqual(list.json().items.map((item:{handling:unknown})=>item.handling));
   expect(matched.total).toBe(1);
   const denied=await get('development-clerk',`/digital-production/workspaces/designer?layout=workbench&search=${source}`);
   expect(denied.statusCode).toBe(403);
   await page.goto(`${base}/ui/digital-production?${filters}`);
   const row=page.locator(`#development-open-${sourceId}`);
   await row.click();
   await page.getByRole('heading',{name:source,exact:true}).waitFor();
   const nav=page.getByRole('navigation',{name:'本单区域'});
   expect(await nav.getByRole('link').allTextContents()).toEqual(['版单资料','开发办理','客户与报价','交接与协同','订单相关单据','操作记录']);
   expect(await nav.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
   await page.setViewportSize({width:390,height:747});
   expect(await nav.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
   await page.setViewportSize({width:1165,height:747});
   const lazyPaths=[`/sources/${sourceId}/quotation`,`/sources/${sourceId}/production-readiness`,`/journeys/${sourceId}`];
   expect(requests.filter(request=>lazyPaths.some(path=>request.path.endsWith(path)))).toEqual([]);
   await nav.getByRole('link',{name:'客户与报价',exact:true}).focus();
   await page.keyboard.press('Enter');
   const customer=page.getByRole('region',{name:'客户与报价',exact:true});
   await customer.getByText('客户报价协作',{exact:true}).click();
   await customer.getByText('客户当前确认版：',{exact:false}).waitFor();
   expect(requests.filter(request=>request.path.endsWith(lazyPaths[0]!))).toHaveLength(1);
   await nav.getByRole('link',{name:'订单相关单据',exact:true}).click();
   const originalDirectory=page.getByRole('region',{name:'本单原单据目录',exact:true});
   await originalDirectory.getByLabel('搜索原单与版本',{exact:true}).fill('资料版本');
   await expect.poll(()=>new URL(page.url()).searchParams.get('originalSearch')).toBe('资料版本');
   await expect.poll(()=>originalDirectory.getByRole('status').filter({hasText:/^正在(?:读取|核对)/}).count()).toBe(0);
   await nav.getByRole('link',{name:'客户与报价',exact:true}).click();
   expect(new URL(page.url()).searchParams.get('originalSearch')).toBe('资料版本');
   const nativeTask=page.getByRole('region',{name:'当前办理'}).getByRole('link',{name:/等别人.*纸样/});
   const target=new URL((await nativeTask.getAttribute('href'))!,page.url());
   expect(target.searchParams.get('task')).toBe(paperId);
   expect(target.searchParams.get('taskView')).toBe('read');
   expect(new URL(target.searchParams.get('returnTo')!,page.url()).searchParams.get('originalSearch')).toBe('资料版本');
   await nativeTask.click();
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await nav.getByRole('link',{name:'开发办理',exact:true}).waitFor();
   expect(new URL(page.url()).searchParams.get('area')).toBe('development');
   expect(new URL(page.url()).searchParams.get('originalSearch')).toBe('资料版本');
   expect(new URL(page.url()).searchParams.get('development')).toBe(sourceId);
   expect(new URL(page.url()).searchParams.get('search')).toBe(source);
   expect(requests.filter(request=>request.method!=='GET'&&request.path.startsWith(`/api/digital-production/sources/${sourceId}`))).toEqual([]);
  } finally {await context.close();}
 });
 it('lets the original designer update only the required accessory forecast from the workbench',async()=>{
  const accessoryId=randomUUID(),prepared=await prepareDevelopment(true,accessoryId);
  const context=await browser.newContext({viewport:{width:1165,height:1003}});
  await context.addCookies([{name:'dx_rework_session',value:await loginRole('sample-designer'),url:base}]);
  const page=await context.newPage();
  try {
   await page.goto(`${base}/ui/digital-production?workspace=designer&section=workspace&development=${prepared.id}`);
   await page.getByRole('button',{name:'轮次与记录',exact:true}).click();
   const fabric=page.locator(`#material-${prepared.materialId}`),accessory=page.locator(`#material-${accessoryId}`);
   await fabric.waitFor();
   expect(await fabric.getByRole('button',{name:'修改辅料预计到料日期'}).count()).toBe(0);
   const edit=accessory.getByRole('button',{name:'修改辅料预计到料日期',exact:true});
   await edit.click();
   const date=accessory.getByLabel('辅料预计到料日期',{exact:true});
   expect(await date.inputValue()).toBe('2027-01-01');
   expect(await accessory.getByLabel('实际发生时间').count()).toBe(0);
   await date.fill('2027-01-03');
   const receipt=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/materials/${accessoryId}/events`));
   await accessory.getByRole('button',{name:'保存预计日期',exact:true}).click();
   const response=await receipt;
   expect(response.status()).toBe(200);
   expect(response.request().postDataJSON()).toEqual({action:'修改预计日期',expectedRound:1,expectedVersion:2,expectedMaterialRevision:0,expectedDate:'2027-01-03',note:''});
   expect(await response.json()).toMatchObject({sourceId:prepared.id,materialEvents:[{materialId:accessoryId,action:'修改预计日期',expectedDate:'2027-01-03',occurredAt:null,occurredDate:null}]});
   await accessory.getByText('修改预计日期 · 2027-01-03',{exact:false}).waitFor();
   await expect.poll(()=>edit.evaluate(element=>element===document.activeElement)).toBe(true);
   await edit.click();
   expect(await date.inputValue()).toBe('2027-01-03');
   await accessory.getByRole('button',{name:'取消',exact:true}).click();
   await expect.poll(()=>edit.evaluate(element=>element===document.activeElement)).toBe(true);
  } finally {await context.close();}
 });
 it('keeps reserved draft facts and published revision edits separate from actual material receipt',async()=>{
  const actor=f.people['sample-designer']!,token=await loginRole('sample-designer');
  const identity=new DigitalProductionIdentityService(f.db,true);
  const {sourceId:draft}=await identity.createSource(actor,{developmentType:'头版',designStyleNo:'TEST-DRAFT-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
  const command=(path:string,input:object)=>app.inject({method:'PUT',url:`/digital-production/sources/${path}`,headers:{cookie:`dx_rework_session=${token}`,'idempotency-key':randomUUID()},payload:input});
  const document=initialDevelopmentDocument(),fabric={...document.materials[0]!,name:'TEST面料'};
  const accessory={...fabric,materialId:randomUUID(),category:'辅料' as const,label:'辅料',name:'TEST辅料',auxiliaryKind:'普通辅料' as const};
  const physical=await command(`${draft}/development`,{expectedVersion:0,document:{...document,materials:[{...fabric,available:true},accessory]}});
  expect(physical.statusCode).toBe(400);expect(physical.body).toContain('不能登记或改写实到');
  const fabricForecast=await command(`${draft}/development`,{expectedVersion:0,document:{...document,materials:[{...fabric,expectedDate:'2027-01-03'},accessory]}});
  expect(fabricForecast.statusCode).toBe(400);expect(fabricForecast.body).toContain('预计到料日期只可填在辅料资料');
  const response=await command(`${draft}/development`,{expectedVersion:0,document:{...document,materials:[fabric,{...accessory,expectedDate:'2027-01-03'}]}});
  expect(response.statusCode,response.body).toBe(200);
  expect(response.json()).toMatchObject({sourceId:draft,status:'draft',version:1,materialEvents:[],document:{materials:[{available:false,expectedDate:null},{available:false,expectedDate:'2027-01-03'}]}});
  const tally=await app.inject({method:'GET',url:'/digital-production/sources/drafts?view=count&search=TEST-DRAFT-',headers:{cookie:`dx_rework_session=${token}`}});
  expect(tally.statusCode).toBe(200);
  expect(tally.json()).toEqual({items:[],page:1,total:1,hasNext:false});
  const prepared=await prepareDevelopment(true,randomUUID());
  const original=await new DigitalDevelopmentService(f.db,true).read(actor,prepared.id);
  const materials=original.document!.materials.map(material=>material.category==='辅料'?{...material,available:true}:material);
  const revise=await command(`${prepared.id}/development/round-draft`,{expectedDraftVersion:0,revision:{basedOnRound:1,document:{...original.document,materials},origin:'内部发现',customerComment:'',internalProblem:'TEST actual material stays with clerk',explanation:'TEST intact receipt',categories:['版型'],affectedNodes:['纸样'],outputKind:'整件样板'}});
  expect(revise.statusCode,revise.body).toBe(400);
  expect(revise.body).toContain('不能登记或改写实到');
  expect((await new DevelopmentRoundService(f.db,true).read(actor,prepared.id)).draft).toBeNull();
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

  const context=await browser.newContext({viewport:{width:1165,height:1003}});
  await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);
  const page=await context.newPage(),writes:string[]=[];
  page.on('request',request=>{if(request.method()!=='GET'&&new URL(request.url()).pathname.startsWith(`/api/digital-production/sources/${sourceId}/development`))writes.push(request.method());});
  try {
   const detail=`${base}/ui/digital-production?workspace=designer&section=workspace&development=${sourceId}`;
   const historical=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith(`/sources/${sourceId}/development`)&&new URL(response.url()).searchParams.get('round')==='1');
   await page.goto(`${detail}&round=1`);
   expect(await (await historical).json()).toMatchObject({sourceId,roundNumber:1,latestRoundNumber:2,version:old.version,canEdit:false,document:old.document});
   await page.getByRole('button',{name:'轮次与记录',exact:true}).click();
   expect(await page.getByLabel('查看轮次').inputValue()).toBe('1');
   expect(await page.getByRole('button',{name:/编辑版单|发起实际修改|继续复版草稿|保存草稿/}).count()).toBe(0);
   await page.getByLabel('查看轮次').selectOption('2');
   await page.getByRole('button',{name:'编辑版单',exact:true}).waitFor();
   expect(new URL(page.url()).searchParams.get('round')).toBe('2');
   expect(writes).toEqual([]);
  } finally {await context.close();}
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
 it('restores an original completed occurrence without truncating seconds or milliseconds in the native correction form',async()=>{
  const tasks=new DigitalProductionTaskService(f.db),history=await tasks.history(f.root,uploadPaperId),completed=history.events.find(event=>event.kind==='completed')!;
  expect(completed.occurredAt).toBeTruthy();const originalAt=new Date(completed.occurredAt!).toISOString();
  const context=await browser.newContext({viewport:{width:1165,height:1000}});await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);
  const page=await context.newPage();
  try{
   await page.goto(base+`/ui/digital-production?task=${uploadPaperId}&taskView=correct`);
   await page.getByText('任务状态、问题反馈与记录',{exact:true}).click();
   await page.getByText('历史记录与核实',{exact:true}).click();
   const form=page.locator('form').filter({has:page.locator(`input[name="reason"]`)}).filter({has:page.getByRole('button',{name:'填入原记录时间',exact:true})}).last();
   // Match the original immutable completion event, not a later correction.
   const original=page.locator('details > div').filter({has:page.locator('p').filter({hasText:/^完成 · 发生/})}).filter({has:page.locator('form input[name="reason"]')});
   const completionForm=await original.count()===1?original.locator('form'):form;
   const input=completionForm.locator('input[name="at"]');expect(await input.getAttribute('step')).toBe('0.001');
   await completionForm.locator('input[name="reason"]').fill('TEST explicitly mark original completion time unknown');
   let response=page.waitForResponse(reply=>reply.request().method()==='POST'&&reply.url().endsWith('/time-corrections'));
   await completionForm.getByRole('button',{name:'保存核实',exact:true}).click();expect((await response).status()).toBe(200);
   await expect.poll(async()=>(await tasks.read(f.root,uploadPaperId)).completedAt).toBeNull();
   await page.getByText('TEST explicitly mark original completion time unknown',{exact:true}).waitFor({state:'attached'});
   if(!await page.getByText('历史记录与核实',{exact:true}).isVisible())await page.getByText('任务状态、问题反馈与记录',{exact:true}).click();
   if(!await input.isVisible())await page.getByText('历史记录与核实',{exact:true}).click();
   await completionForm.getByRole('button',{name:'填入原记录时间',exact:true}).click();
   expect(new Date((await input.inputValue())+'+08:00').toISOString()).toBe(originalAt);
   await completionForm.locator('input[name="reason"]').fill('TEST restore the original occurrence with full precision');
   response=page.waitForResponse(reply=>reply.request().method()==='POST'&&reply.url().endsWith('/time-corrections'));
   await completionForm.getByRole('button',{name:'保存核实',exact:true}).click();expect((await response).status()).toBe(200);
   await expect.poll(async()=>(await tasks.read(f.root,uploadPaperId)).completedAt).toBe(originalAt);
   await page.getByText('TEST restore the original occurrence with full precision',{exact:true}).waitFor({state:'attached'});
   if(!await page.getByText('历史记录与核实',{exact:true}).isVisible())await page.getByText('任务状态、问题反馈与记录',{exact:true}).click();
   if(!await input.isVisible())await page.getByText('历史记录与核实',{exact:true}).click();
   const precise=new Date(Math.floor((Date.now()-2000)/1000)*1000+850).toISOString();
   // Chromium normalizes .850 to .85; this is identical precision, not truncation.
   await input.fill(new Date(Date.parse(precise)+8*3600000).toISOString().slice(0,-2));
   await completionForm.locator('input[name="reason"]').fill('TEST explicit .850 correction through the original input');
   await page.screenshot({path:join(evidence,'time-correction-precision-1165.png'),fullPage:true});
   response=page.waitForResponse(reply=>reply.request().method()==='POST'&&reply.url().endsWith('/time-corrections'));
   await completionForm.getByRole('button',{name:'保存核实',exact:true}).click();expect((await response).status()).toBe(200);
   await expect.poll(async()=>(await tasks.read(f.root,uploadPaperId)).completedAt).toBe(precise);
   const after=await tasks.history(f.root,uploadPaperId);expect(after.events.find(event=>event.eventId===completed.eventId)).toEqual(completed);
  }finally{await context.close();}
 });

 it('renders the real shipping date and native unknown then verified correction in the authenticated workbench',async()=>{
  const [made]=await exerciseDevelopmentSlaNative(f.db,new RootAwareTodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,undefined,[['无','免洗']],{fixedCraftSteps:[],routeActualTime:kind=>kind==='development_confirmation'?{precision:'instant',at:businessNow().toISOString()}:undefined});
  const current=await execution.read(f.root,made!.sourceId),shipping=current.tasks.find(task=>task.taskKind==='development_shipping')!,date=beijingCalendarDate(businessNow());
  await execution.route(f.root,made!.sourceId,{taskId:shipping.taskId,result:'通过',note:'TEST actual date-only shipping',craftExecution:null,nextAssigneeId:null,sentDate:date,trackingNo:'TEST-NATIVE-DATE'},randomUUID());
  const tasks=new DigitalProductionTaskService(f.db),original=(await tasks.history(f.root,shipping.taskId)).events.find(event=>event.kind==='completed')!;
  const context=await browser.newContext({viewport:{width:1165,height:1000}});await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);const page=await context.newPage();
  const open=async(id=shipping.taskId)=>{await page.goto(base+`/ui/digital-production?task=${id}&taskView=read`);await page.locator('.task-workbench-sample>header').waitFor();};
  try{
   // The existing task's completion belongs to its own header; the separate
   // current-plan section also has a header and plan-revision metadata.
   const actual=page.locator('.task-workbench-sample>header small');
   const paper=current.tasks.find(task=>task.taskKind==='development_pattern')!,reported=current.tasks.find(task=>task.taskKind==='development_confirmation')!;
   await open(paper.taskId);expect((await tasks.read(f.root,paper.taskId)).actualCompletion?.quality).toBe('verified');expect(await actual.textContent()).not.toContain('待核');
   await open(reported.taskId);expect((await tasks.read(f.root,reported.taskId)).actualCompletion).toMatchObject({precision:'instant',quality:'unverified'});await expect.poll(()=>actual.textContent()).toContain('时间待核');
   await open();
   await expect.poll(()=>actual.textContent()).toContain(date+'（仅日期 · 时间待核）');expect(await actual.textContent()).not.toContain('00:00');
   await tasks.correctTime(f.root,shipping.taskId,{eventId:original.eventId,occurredAt:null,reason:'TEST explicit original unknown'},randomUUID());
   await open();await expect.poll(()=>actual.textContent()).toContain('实际完成 时间未知');
   const at=businessNow().toISOString();await tasks.correctTime(f.root,shipping.taskId,{eventId:original.eventId,occurredAt:at,reason:'TEST original actual verified'},randomUUID());
   await open();await expect.poll(()=>actual.textContent()).not.toContain('时间未知');expect(await actual.textContent()).not.toContain('待核');
   expect((await tasks.read(f.root,shipping.taskId)).actualCompletion).toMatchObject({precision:'instant',at,quality:'verified'});
   expect((await tasks.history(f.root,shipping.taskId)).events.filter(event=>event.kind==='completed')).toEqual([original]);
  }finally{await context.close();}
 });
});
