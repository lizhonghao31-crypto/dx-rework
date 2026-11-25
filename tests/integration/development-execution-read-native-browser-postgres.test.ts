import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID,createHash} from "node:crypto";
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import {createServer,type Server} from "node:http";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {join,resolve,extname} from "node:path";
import {tmpdir} from "node:os";
import {build} from "vite";
import type {Browser,Route,chromium as Chromium} from "playwright-core";
import {loadConfig} from "@dx-rework/config";
import {buildApp} from "../../apps/api/src/app.js";
import {CuttingSourceService} from '../../apps/api/src/cutting/cutting-source-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {BulkWashingService} from '../../apps/api/src/production-platform/bulk-washing-service.js';
import {QcProductionProgressService} from '../../apps/api/src/production-platform/qc-production-progress-service.js';
import {ReworkInitiationService} from '../../apps/api/src/rework/service.js';
import {ReworkBusinessDetailService} from '../../apps/api/src/rework/rework-business-detail-service.js';
import {SourcingContractReturnService} from '../../apps/api/src/sourcing/sourcing-contract-return-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {ExportJobService} from '../../apps/api/src/tools/exports.js';
import {SubmitQcProgressSchema} from '@dx-rework/contracts/qc-production-progress';
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
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {DevelopmentDocumentSchema,type DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {QuotationConfirmationSchema} from '@dx-rework/contracts/digital-quotation';
import {CreateSupplierSchema,type PackingTimeInput} from '@dx-rework/contracts';
import type {DevelopmentReturnIssue} from '@dx-rework/contracts/digital-development-amendments';
import {PatternRoomOrderService} from "../../apps/api/src/pattern-room/order-service.js";
import {PATTERN_HOURLY_PRICE_ID,PatternRoomPriceService} from "../../apps/api/src/pattern-room/price-service.js";
import {RootAwareTodoProjectionService} from "../../apps/api/src/todos/root-aware-projection-service.js";
import {TodoService} from "../../apps/api/src/todos/service.js";
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {arrangeTestRound} from "../helpers/development-arrangement-fixture.js";
import {businessAnchorFixture} from "../helpers/business-anchor-fixture.js";
import {failedFrameworkWashingFixture,prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {createHistoricalPatternFixture} from '../helpers/historical-pattern-fixture.js';
import {physicalCuttingLabelsFixture} from '../helpers/production-readiness-fixture.js';
import {completeInspectionReport} from '../inspection-report-fixture.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("S1 development read through original App and native signed identity",()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,app:ReturnType<typeof buildApp>,browser:Browser,server:Server,output:string,base:string;
 let prepareDevelopment:(published?:boolean,accessoryId?:string,completeHandover?:boolean,nativeDraft?:boolean)=>Promise<{id:string;materialId:string}>;
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
  const prepare=prepareDevelopment=async(published=true,accessoryId?:string,completeHandover=false,nativeDraft=false)=>{
   const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:'TEST-S1-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID(),nativeDraft);
   const materialId=randomUUID(),photo=await f.image(designer);
   const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[],template:'上衣',quantity:1,sampleSize:'',orderDate:null,returnDate:null,unit:'cm',sizes:[],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST S1 原制作说明',craft:'无',washing:'免洗',materials:[{materialId,category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'',color:'黑',specification:'TEST40支',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:photo,kind:'款图'}]});
   document.patternCategoryId=category.priceId;
   if(completeHandover)document.materials[0]!.quantityUnit='米';
   // A native reserved draft declares the material only. Actual warehouse or
   // development-clerk availability must not be fabricated in its version.
   if(nativeDraft){
    document.materials[0]={...document.materials[0]!,category:'辅料',label:'辅料',name:'TEST 扣件',quantityUnit:'件',available:false,
     expectedDate:beijingCalendarDate(new Date(businessNow().getTime()+86400000))};
   }
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
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},patternRoomOrders:{authenticate,root,service:native,attachments:f.attachments},patternRoomPrices:{authenticate,root,service:prices},
   cutting:{authenticate,root,service:new CuttingSourceService(f.db),attachments:f.attachments},
   rework:{authenticate,root,service:new ReworkInitiationService(f.db,'anchor-test'),businessDetailService:new ReworkBusinessDetailService(f.db),attachments:f.attachments},
   sourcing:{authenticate,root,service:f.sourcing,contracts:f.contracts,reporting:new ProductionReportingService(f.db)},
   tools:{authenticate,isRootUser:id=>root.isRootUser(id),attachments:f.attachments,exports:new ExportJobService(f.db),
    canDownloadBoundAttachment:async(actor,binding)=>{
     if(binding.entityType==='receiving_difference_resolution')return binding.mimeType.startsWith('image/')&&(actor.actorRoles.length>0||await root.isRootUser(actor.actorId));
     return f.sourcing.canDownloadBoundAttachment({actorId:actor.actorId,actorRoles:actor.actorRoles,
      authorizationCapability:'sourcing:view',authorizationCapabilities:actor.capabilities,requestId:randomUUID()},binding);
    }},
   digitalIdentity:{authenticate,root,service:identity,creationEnabled:true,developmentQrBase:'https://architecture.invalid/',developmentService:forms,developmentRounds:new DevelopmentRoundService(f.db,true,native),developmentExecution:execution,developmentAttachments:f.attachments,readinessService:new ProductionReadinessService(f.db),bulkPreparationService:new BulkPreparationService(f.db),closureService:new OrderClosureService(f.db),factoryFlowService:new FactoryFlowService(f.db),bulkWashing:new BulkWashingService(f.db),qcProgress:new QcProductionProgressService(f.db),journeys:new DigitalJourneyQuery(f.db),quotationService:new DigitalQuotationService(f.db,true),budgetService:new DigitalBudgetService(f.db,true),taskService:tasks,accessService:new DigitalProductionAccessService(f.db),notificationService:new DigitalProductionNotificationService(f.db)}});await app.ready();
  for(const role of ['root','pattern-room-worker','worker-a','worker-b','pattern-room-supervisor','development-clerk'])tokens.set(role,(await auth.loginMobile(mintAcceptanceLoginCode(role,secret))).token);
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

 it('submits current revision inputs without a prior draft save and prints only the adopted original opinion as the signed pattern role',async()=>{
  const own=await prepareDevelopment(),designer=f.people['sample-designer']!,forms=new DigitalDevelopmentService(f.db,true);
  const original=await forms.read(designer,own.id),technical=execution.technicalEvidenceService();
  const imageA=await f.image(designer),imageB=await f.image(designer);
  for(const image of [imageA,imageB])await execution.recordUploadPurpose(designer,own.id,image,'客户评语依据');
  const authorToken=await loginRole('sample-designer');
  const post=(url:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url,payload,
   headers:{cookie:`dx_rework_session=${authorToken}`,'idempotency-key':key}});
  const commentPath=`/digital-production/sources/${own.id}/execution/technical/comments`;
  const comment=(text:string,attachmentId:string,expectedVersion:number)=>({roundNumber:1,scopeRef:'整款',expectedVersion,isFinal:false,
   decision:'changes_required',text,evidenceRefs:[attachmentId],evidenceNote:'TEST 原客户修改意见',occurredAt:null});
  const a=await post(commentPath,comment('TEST 确认采用原评语 A',imageA,0));
  expect(a.statusCode,a.body).toBe(200);
  const ref={sourceId:own.id,roundNumber:1,scopeRef:'整款',commentId:a.json().commentId,version:a.json().version};
  const current={expectedDraftVersion:0,basedOnRound:1,revision:{basedOnRound:1,origin:'客户新增要求',customerComment:'TEST 不采用表单伪造文字',internalProblem:'',
   customerCommentRef:ref,explanation:'TEST 当前未保存修改',categories:['尺寸'],affectedNodes:['纸样'],outputKind:'整件样板',
   document:{...original.document!,instructions:'TEST 本次未保存的制作说明'}}};
  const submitPath=`/digital-production/sources/${own.id}/development/round-publish`;
  const wrong=await post(submitPath,{...current,revision:{...current.revision,customerCommentRef:{...ref,scopeRef:'另一范围'}}});
  expect([400,409]).toContain(wrong.statusCode);
  const author=await browser.newContext({viewport:{width:1165,height:840}});
  await author.addCookies([{name:'dx_rework_session',value:authorToken,url:base}]);
  const editor=await author.newPage(),writes:string[]=[];
  editor.on('request',request=>{if(request.method()==='PUT'||request.method()==='POST')writes.push(new URL(request.url()).pathname);});
  let submitted:{sourceId:string;roundNumber:number};
  try{
   await editor.goto(base+`/ui/digital-production?workspace=designer&section=workspace&area=development&development=${own.id}`);
   await editor.getByRole('button',{name:'编辑版单',exact:true}).click();
   await editor.getByRole('combobox',{name:'采用本轮原客户评语',exact:true}).click();
   await editor.getByRole('option',{name:/TEST 确认采用原评语 A/}).click();
   await editor.getByLabel('制作说明（选填）',{exact:true}).fill(current.revision.document.instructions);
   const requests:Array<{key:string|undefined;body:string|null}>=[];
   let storedStatus:number|undefined;
   await editor.route(base+'/api'+submitPath,async route=>{
    requests.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
    if(requests.length!==1)return route.continue();
    storedStatus=(await route.fetch()).status();
    return route.abort('failed');
   });
   await editor.getByRole('button',{name:/建立独立复版单|正式发布本轮修改/}).click();
   const recover=editor.getByRole('button',{name:'使用原内容核对复版提交',exact:true});
   await recover.waitFor();
   expect(storedStatus).toBe(200);
   expect(requests).toHaveLength(1);
   const response=editor.waitForResponse(res=>new URL(res.url()).pathname==='/api'+submitPath&&res.request().method()==='POST');
   await recover.click();
   const result=await response;
   expect(result.status(),await result.text()).toBe(200);
   expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);
   submitted=await result.json();
   expect(writes).not.toContain('/api'+submitPath.replace('round-publish','round-draft'));
   const payload=result.request().postDataJSON(),idem=result.request().headers()['idempotency-key']!;
   expect(payload).toMatchObject({expectedDraftVersion:0,revision:{customerCommentRef:ref,document:{instructions:current.revision.document.instructions}}});
   expect(idem).toBeTruthy();
   expect((await post(submitPath,payload,idem)).json()).toEqual(submitted);
   expect((await post(submitPath,payload)).statusCode).toBe(409);
  }finally{await author.close();}
  const {sourceId:revisionId,roundNumber}=submitted,b=await post(commentPath,comment('TEST 后录不能混入的评语 B',imageB,ref.version));
  expect(b.statusCode,b.body).toBe(200);
  expect((await technical.read(designer,own.id,1,'整款')).comments.map(row=>row.commentId)).toEqual(expect.arrayContaining([ref.commentId,b.json().commentId]));
  let saved=await forms.read(designer,revisionId,undefined,roundNumber);
  if(saved.status==='draft'){
   const category=saved.document!.patternCategoryId!;
   const price=await new PatternRoomPriceService(f.db).quote(f.root,'category',category);
   const published=await post(`/digital-production/sources/${revisionId}/development/publish`,{expectedVersion:saved.version,patternOrder:{categoryId:category,priceVersion:price.version}});
   expect(published.statusCode,published.body).toBe(200);
   saved=await forms.read(designer,revisionId,undefined,roundNumber);
  }
  expect(saved).toMatchObject({document:{instructions:'TEST 本次未保存的制作说明'},status:'published'});
  const version=`/api/digital-production/sources/${revisionId}/development/versions/${saved.version}`;
  const context=await browser.newContext({viewport:{width:1165,height:840}});
  await context.addCookies([{name:'dx_rework_session',value:await loginRole('pattern-room-supervisor'),url:base}]);
  const page=await context.newPage();
  try{
   await page.addInitScript(()=>{
    const watch=new MutationObserver(entries=>{for(const entry of entries)for(const node of entry.addedNodes){
     if(!(node instanceof HTMLIFrameElement)||node.title!=='版单 A4 打印预览'||!node.contentWindow)continue;
     node.contentWindow.print=()=>{
      const paper=node.contentDocument!;
      document.body.dataset.testExactRevisionPrint=JSON.stringify([...paper.querySelectorAll<HTMLElement>('.development-print-page')].map(sheet=>({
       document:sheet.dataset.printDocument,text:sheet.textContent,images:[...sheet.querySelectorAll('img')].map(img=>({url:img.src,decoded:img.naturalWidth>0})),
      })));
      node.contentWindow?.dispatchEvent(new Event('afterprint'));
     };
    }});
    watch.observe(document,{childList:true,subtree:true});
   });
   const snapshot=await page.request.get(base+version+`?round=${roundNumber}`);expect(snapshot.status(),await snapshot.text()).toBe(200);
   const exact=await snapshot.json();
   expect(exact.document.files.some((row:{attachmentId:string})=>[imageA,imageB].includes(row.attachmentId))).toBe(false);
   expect(exact.printFeedback).toMatchObject({text:'TEST 确认采用原评语 A',version:ref.version,images:[{attachmentId:imageA}]});
   const wrongAttachment=await page.request.get(base+version+`/attachments/${imageB}?round=${roundNumber}`,{maxRedirects:0});
   expect(wrongAttachment.status()).toBe(404);
   const finance=await loginRole('factory-payables');
   expect((await app.inject({method:'GET',url:version.slice(4)+`/attachments/${imageA}?round=${roundNumber}`,
    headers:{cookie:`dx_rework_session=${finance}`}})).statusCode).toBe(404);
   await page.goto(base+`/ui/digital-production?development=${revisionId}&round=${roundNumber}&developmentDocumentVersion=${saved.version}`);
   await page.getByRole('button',{name:'打印 / 保存 PDF',exact:true}).click();
   await expect.poll(()=>page.locator('body').getAttribute('data-test-exact-revision-print')).toBeTruthy();
   const printed=JSON.parse((await page.locator('body').getAttribute('data-test-exact-revision-print'))!) as Array<{document:string;text:string;images:Array<{url:string;decoded:boolean}>}>;
   const feedback=printed.filter(row=>row.document==='客户评语单'),main=printed.filter(row=>row.document!=='客户评语单');
   expect(main.length).toBeGreaterThan(0);expect(printed[0]?.document).not.toBe('客户评语单');
   expect(main.every(row=>!row.text.includes('TEST 确认采用原评语 A'))).toBe(true);
   expect(feedback.map(row=>row.text).join(' ')).toContain('TEST 确认采用原评语 A');
   expect(feedback.flatMap(row=>row.images)).toEqual([{url:base+version+`/attachments/${imageA}?round=${roundNumber}`,decoded:true}]);
   expect(JSON.stringify(printed)).not.toContain(imageB);
  }finally{await context.close();}
 });

 it('C5 rejects cross-order revision comment and attachment access for real unrelated signed identities',async()=>{
  const designer=f.people['sample-designer']!,forms=new DigitalDevelopmentService(f.db,true);
  const own=await prepareDevelopment(),foreign=await prepareDevelopment();
  const headers={cookie:`dx_rework_session=${await loginRole('sample-designer')}`};
  const post=(url:string,payload:object)=>app.inject({method:'POST',url,payload,headers:{...headers,'idempotency-key':randomUUID()}});
  async function original(sourceId:string,label:string){
   const imageId=await f.image(designer);
   await execution.recordUploadPurpose(designer,sourceId,imageId,'客户评语依据');
   const saved=await post(`/digital-production/sources/${sourceId}/execution/technical/comments`,{roundNumber:1,scopeRef:'整款',expectedVersion:0,
    isFinal:false,decision:'changes_required',text:label,evidenceRefs:[imageId],evidenceNote:'TEST 原客户修改意见',occurredAt:null});
   expect(saved.statusCode,saved.body).toBe(200);
   return {imageId,ref:{sourceId,roundNumber:1,scopeRef:'整款',commentId:saved.json().commentId,version:saved.json().version}};
  }
  const a=await original(own.id,'TEST 本单真实评语'),b=await original(foreign.id,'TEST 另一独立订单评语');
  const sheet=await forms.read(designer,own.id);
  const url=`/digital-production/sources/${own.id}/development/round-publish`;
  const submit=(ref:typeof a.ref)=>post(url,{expectedDraftVersion:0,basedOnRound:1,revision:{basedOnRound:1,origin:'客户新增要求',
   customerComment:'不能用本表单文字替代原评语',internalProblem:'',customerCommentRef:ref,explanation:'TEST 验证本单原评语范围',
   categories:['尺寸'],affectedNodes:['纸样'],outputKind:'整件样板',document:sheet.document!}});
  for(const ref of [b.ref,{...b.ref,sourceId:own.id}]){
   const wrong=await submit(ref);expect(wrong.statusCode).toBe(409);
   expect(wrong.body).not.toContain('TEST 另一独立订单评语');
  }
  expect((await f.db.query(`SELECT 1 FROM digital_development_revision_comment_adoptions WHERE based_on_source_id IN ($1,$2)`,[own.id,foreign.id])).rowCount).toBe(0);
  const published=await submit(a.ref);expect(published.statusCode,published.body).toBe(200);
  const {sourceId,roundNumber}=published.json();
  let revision=await forms.read(designer,sourceId,undefined,roundNumber);
  if(revision.status==='draft'){
   const categoryId=revision.document!.patternCategoryId!,price=await new PatternRoomPriceService(f.db).quote(f.root,'category',categoryId);
   const issued=await post(`/digital-production/sources/${sourceId}/development/publish`,{expectedVersion:revision.version,patternOrder:{categoryId,priceVersion:price.version}});
   expect(issued.statusCode,issued.body).toBe(200);revision=await forms.read(designer,sourceId,undefined,roundNumber);
  }
  const pattern=await loginRole('pattern-room-supervisor'),finance=await loginRole('factory-payables');
  const get=(path:string,token:string)=>app.inject({method:'GET',url:path,headers:{cookie:`dx_rework_session=${token}`}});
  const version=(id:string,v:number)=>`/digital-production/sources/${id}/development/versions/${v}`;
  const exact=version(sourceId,revision.version),foreignVersion=version(foreign.id,(await forms.read(designer,foreign.id)).version);
  const attachment=(path:string,imageId:string,round:number)=>`${path}/attachments/${imageId}?round=${round}`;
  const allowed=await get(`${exact}?round=${roundNumber}`,pattern);
  expect(allowed.statusCode,allowed.body).toBe(200);
  expect(allowed.json().printFeedback).toMatchObject({text:'TEST 本单真实评语',images:[{attachmentId:a.imageId}]});
  expect((await get(`${foreignVersion}?round=1`,pattern)).statusCode).toBe(200);
  const ownDownload=await get(attachment(exact,a.imageId,roundNumber),pattern);
  expect(ownDownload.statusCode).toBe(302);expect(ownDownload.headers.location).toBeTruthy();
  for(const [path,token] of [[attachment(exact,b.imageId,roundNumber),pattern],[attachment(foreignVersion,a.imageId,1),pattern],
   [attachment(exact,a.imageId,roundNumber),finance],[`${exact}?round=${roundNumber}`,finance]] as const){
   const denied=await get(path,token);expect(denied.statusCode).toBe(404);expect(denied.headers.location).toBeUndefined();
   expect(denied.body).not.toMatch(/本单真实评语|另一独立订单评语|__test-storage/);
  }
 });

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
  const prices=new PatternRoomPriceService(f.db),hourly=await prices.quote(f.root,'hourly',PATTERN_HOURLY_PRICE_ID);
  const miscPrice=await prices.change(f.root,'hourly',PATTERN_HOURLY_PRICE_ID,{version:hourly.version,amount:'12.000',enabled:true,reason:'TEST 原杂事目录分页'},randomUUID());
  const miscInput={priceVersion:miscPrice.version,styleNo:adopted.styleNo,association:{kind:'source',id:own.id}};
  const linkedMisc=[];
  for(let index=1;index<=21;index++){
   linkedMisc.push(await native.createMisc(designer,{...miscInput,taskName:`TEST 原杂事 ${index}`,note:`TEST 本轮杂事原备注 ${index}`},randomUUID()));
  }
  const unrelatedMisc=await native.createMisc(designer,{...miscInput,association:undefined,styleNo:'',taskName:linkedMisc[0]!.taskName},randomUUID());
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
   // The authorized original entry prepares a real isolated A4 frame. Capture
   // the moment it requests native print, without opening a system dialog in CI.
   await page.evaluate(()=>{
    const watcher=new MutationObserver(entries=>{
     for(const entry of entries)for(const node of entry.addedNodes){
      if(!(node instanceof HTMLIFrameElement)||node.title!=="版单 A4 打印预览"||!node.contentWindow)continue;
      node.contentWindow.print=()=>{
       const paper=node.contentDocument!;
       document.body.setAttribute('data-test-original-print',JSON.stringify({
        pages:[...paper.querySelectorAll<HTMLElement>('.development-print-page')].map(sheet=>sheet.dataset.printDocument),
        images:[...paper.querySelectorAll('img')].map(img=>({url:img.src,decoded:img.naturalWidth>0})),
        text:paper.body.textContent,
       }));
       node.contentWindow?.dispatchEvent(new Event('afterprint'));
      };
      watcher.disconnect();
     }
    });
    watcher.observe(document.body,{childList:true});
   });
   await original.getByRole('button',{name:'打印 / 保存 PDF',exact:true}).click();
   await page.waitForFunction(()=>document.body.hasAttribute('data-test-original-print'));
   const printed=JSON.parse((await page.locator('body').getAttribute('data-test-original-print'))!) as {pages:string[];images:{url:string;decoded:boolean}[];text:string};
   expect(printed.pages.length).toBeGreaterThan(0);expect(printed.pages.every(page=>page==='版单')).toBe(true);
   expect(printed.images.some(image=>image.url.includes(oldFile)&&image.decoded)).toBe(true);
   expect(printed.images.some(image=>image.url.includes(newImage))).toBe(false);
   expect(printed.text).toContain('TEST S1 原制作说明');
   expect(printed.text).not.toContain('TEST 新修订制作说明');
   expect(await page.locator('.order-document-layout > nav').count()).toBe(0);expect(await page.locator('input[type="file"]').count()).toBe(0);
   for(const name of ['保存草稿','发布开发单','发起实际修改 / 复版'])expect(await page.getByRole('button',{name,exact:true}).count()).toBe(0);
   await page.goBack();await firstOriginal.waitFor();await expect.poll(async()=>Math.abs(await page.evaluate(()=>window.scrollY)-originalTop)).toBeLessThanOrEqual(2);
   expect(new URL(page.url()).searchParams.get('selected')).toBe(own.id);expect(new URL(page.url()).searchParams.get('area')).toBe('records');
   expect(await search.inputValue()).toBe('资料版本 '+prior.documentVersion);
   const singleDirectory=page.getByRole('region',{name:'订单单据',exact:true});
   expect(await singleDirectory.count()).toBe(1);
   const stages=singleDirectory.getByRole('tablist',{name:'单据流程节点'});
   expect(await stages.getByRole('tab').allTextContents()).toEqual(['订单','开发','产前','开裁','工艺','生产','回货']);
   await stages.getByRole('tab',{name:'开发',exact:true}).click();
   const originalPattern=page.getByRole('button',{name:'打板执行单',exact:true});
   const relatedResponse=(number:string)=>page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/pattern-room/related-orders'&&url.searchParams.get('sourceId')===own.id&&(url.searchParams.get('page')??'1')===number;
   });
   const firstRelated=relatedResponse('1'),secondRelated=relatedResponse('2');
   await originalPattern.click();
   const [related,nextRelated]=await Promise.all([firstRelated,secondRelated]);
   expect(related.status(),await related.text()).toBe(200);
   expect(nextRelated.status(),await nextRelated.text()).toBe(200);
   const firstDirectory=await related.json(),secondDirectory=await nextRelated.json();
   expect(firstDirectory.nextPage).toBe(2);
   expect(secondDirectory.nextPage).toBeNull();
   const visibleIds=[...firstDirectory.items,...secondDirectory.items].map(item=>item.orderId).sort();
   expect(visibleIds).toEqual([link.order_id,...linkedMisc.map(item=>item.orderId)].sort());
   const patternLink=page.locator(`a[href*="/ui/pattern-room/orders/${link.order_id}"][href*="readOnly=history"]`);
   await patternLink.waitFor();
   expect(new URL((await patternLink.getAttribute('href'))!,page.url()).searchParams.get('round')).toBe(adopted.currentRoundId);
   await patternLink.click();await page.getByText('历史记录 · 只读',{exact:true}).waitFor();
   await page.getByText(adopted.note!,{exact:false}).first().waitFor();
   await page.goBack();await patternLink.waitFor();
   expect(new URL(page.url()).searchParams.get('originalCategory')).toBe('pattern');
   expect(new URL(page.url()).searchParams.get('development')).toBe(own.id);
   await page.getByRole('button',{name:'关联打板杂事单',exact:true}).click();
   const secondPageMisc=linkedMisc.find(item=>secondDirectory.items.some(entry=>entry.orderId===item.orderId))!;
   const miscLink=page.locator(`a[href*="/ui/pattern-room/orders/${secondPageMisc.orderId}"][href*="readOnly=history"]`);
   await miscLink.waitFor();
   expect(await page.locator(`a[href*="/ui/pattern-room/orders/${unrelatedMisc.orderId}"]`).count()).toBe(0);
   expect(new URL((await miscLink.getAttribute('href'))!,page.url()).searchParams.get('round')).toBe(secondPageMisc.currentRoundId);
   await miscLink.click();await page.getByText('历史记录 · 只读',{exact:true}).waitFor();
   await expect.poll(()=>page.locator('.page-heading h1').innerText()).toContain(secondPageMisc.taskName!);
   await page.getByText(`备注：${secondPageMisc.note}`,{exact:true}).waitFor();
   await page.getByRole('link',{name:'返回来源列表',exact:true}).click();await miscLink.waitFor();
   expect(new URL(page.url()).searchParams.get('originalCategory')).toBe('misc');
   expect(new URL(page.url()).searchParams.get('selected')).toBe(own.id);
   await singleDirectory.getByRole('button',{name:'查看更多 ›',exact:true}).click();
   const directoryChooser=page.getByRole('dialog',{name:'全部相关单据',exact:true});
   await directoryChooser.getByLabel('搜索单据类别',{exact:true}).fill('开发原单');
   await directoryChooser.getByRole('button',{name:'开发原单与轮次',exact:true}).click();
   await directoryChooser.waitFor({state:'hidden'});
   expect(new URL(page.url()).searchParams.get('originalCategory')).toBe('development');
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
   const author=await browser.newContext({viewport:{width:1165,height:747}});
   try{
    await author.addCookies([{name:'dx_rework_session',value:await loginRole('sample-designer'),url:base}]);
    const source=await author.newPage();source.setDefaultTimeout(12000);
    const technicalHistory:string[]=[];
    source.on('request',request=>{
     const url=new URL(request.url());
     if(url.pathname===`/api/digital-production/sources/${uploadSourceId}/execution/technical/history`&&url.searchParams.get('kind')==='artifacts'){
      technicalHistory.push(url.searchParams.get('version')??'directory');
     }
    });
    await source.goto(base+'/ui/digital-production?'+new URLSearchParams({workspace:'designer',section:'workspace',development:uploadSourceId,
     area:'records',originalStage:'development',originalCategory:'development_plt'}));
    const directory=source.getByLabel('按阶段读取原单据',{exact:true});
    const href=directory.locator(`a[href*="originalTechnicalId=${artifact.artifactSetId}"]`);
    const loadedFile=directory.getByRole('link',{name:'PLT纸样原件 1',exact:true});
    await loadedFile.waitFor();
    expect(await loadedFile.getAttribute('href')).toContain(artifact.body.pltAttachmentIds[0]);
    expect(technicalHistory).toEqual(['directory',String(artifact.version)]);
    await directory.getByRole('button',{name:'尺寸表',exact:true}).click();
    await href.waitFor();
    expect(technicalHistory).toEqual(['directory',String(artifact.version)]);
    await directory.getByRole('button',{name:'纸样PLT',exact:true}).click();
    await loadedFile.waitFor();
    expect(technicalHistory).toEqual(['directory',String(artifact.version)]);
    await Promise.all([source.waitForURL(target=>target.searchParams.get('originalTechnicalId')===artifact.artifactSetId),href.click()]);
    const target=new URL(source.url());
    expect(target.searchParams.get('originalTechnicalVersion')).toBe(String(artifact.version));
    await source.getByRole('heading',{name:`原技术成果 · 第 1 轮 v${artifact.version} · 只读`,exact:true}).waitFor();
    const original=source.getByRole('link',{name:'PLT纸样原件 1',exact:true});
    expect(await original.getAttribute('href')).toContain(artifact.body.pltAttachmentIds[0]);
    await source.getByText('1.5 米',{exact:true}).waitFor();
    await source.getByText('胸围',{exact:true}).waitFor();
    expect(await source.getByRole('button',{name:'发布技术成果',exact:true}).count()).toBe(0);
    await source.getByRole('button',{name:'返回来源',exact:true}).click();await href.waitFor();
    expect(new URL(source.url()).searchParams.get('originalCategory')).toBe('development_plt');
    target.searchParams.set('originalTechnicalId',randomUUID());await source.goto(target.href);
    await source.getByRole('alert').filter({hasText:'找不到所选技术历史版本'}).waitFor();
    expect(await original.count()).toBe(0);
   }finally{await author.close();}
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
   const designer=await browser.newContext({viewport:{width:1165,height:747}});
   try{
    await designer.addCookies([{name:'dx_rework_session',value:await loginRole('sample-designer'),url:base}]);
    const workbench=await designer.newPage(),writes:string[]=[];
    workbench.on('request',request=>{
     if(request.method()!=='GET'&&new URL(request.url()).pathname.includes('/technical/comment'))
      writes.push(request.method());
    });
    await workbench.goto(base+`/ui/digital-production?workspace=designer&section=workspace&development=${commentSourceId}&area=customer`);
    const feedback=workbench.getByRole('region',{name:'客户意见',exact:true});
    await feedback.getByText('TEST original customer approval without an invented time',{exact:true}).waitFor();
    expect(await feedback.getByText(/实际发生：2026-11-09/).isVisible()).toBe(true);
    expect(await feedback.getByRole('textbox',{name:'评语原意',exact:true}).isVisible()).toBe(true);
    expect(await workbench.getByText('录客户意见',{exact:true}).count()).toBe(0);
    expect(await workbench.getByText('客户评语与最终批复',{exact:true}).count()).toBe(0);
    expect(writes).toEqual([]);
    expect(await feedback.getByLabel('反馈性质',{exact:true}).count()).toBe(0);
    expect(await feedback.getByLabel('确认依据与原记录位置',{exact:true}).count()).toBe(0);
    expect(await feedback.getByLabel('客户实际反馈时间',{exact:true}).count()).toBe(0);
    const feedbackInput=feedback.getByRole('textbox',{name:'评语原意',exact:true});
    const commentPath=`/sources/${commentSourceId}/execution`;
    let breakRead=false,hasBrokenRead=false;
    await workbench.route(url=>url.pathname.endsWith(commentPath),async route=>{
     if(route.request().method()==='GET'&&breakRead&&!hasBrokenRead){
      hasBrokenRead=true;await route.fulfill({status:502,contentType:'application/json',body:'{}'});
     }else await route.continue();
    });
    const ordinaryText='TEST 本轮普通意见，不触发尺寸复核';
    await feedbackInput.fill(ordinaryText);breakRead=true;
    await feedback.getByRole('button',{name:'保存意见',exact:true}).click();
    const reload=workbench.getByRole('button',{name:'重试读取客户意见',exact:true});
    await reload.waitFor();expect(await feedbackInput.inputValue()).toBe(ordinaryText);expect(hasBrokenRead).toBe(true);
    expect(writes).toEqual(['POST']);
    const readComments=()=>f.db.query(`SELECT version,is_final,decision,text_value,occurred_at,recorded_at
      FROM digital_development_final_comments WHERE source_id=$1 ORDER BY version`,[commentSourceId]);
    const intermediate=(await readComments()).rows;expect(intermediate).toHaveLength(2);
    expect(intermediate[1]).toMatchObject({version:2,is_final:false,decision:'noted',text_value:ordinaryText,occurred_at:null,recorded_at:expect.any(Date)});
    expect((await f.db.query('SELECT * FROM digital_development_size_review_requests WHERE source_id=$1',[commentSourceId])).rows).toEqual(before);
    await reload.click();await feedback.getByText(ordinaryText,{exact:true}).waitFor();
    await expect.poll(()=>feedbackInput.inputValue()).toBe('');expect(writes).toEqual(['POST']);

    const finalText='TEST 本轮最终批复，客户确实要求修改';
    await feedbackInput.fill(finalText);
    const finalButton=feedback.getByRole('button',{name:'确认本轮最终批复',exact:true});
    await finalButton.click();
    let confirmation=workbench.getByRole('dialog',{name:'确认本轮最终批复',exact:true});
    await confirmation.getByRole('button',{name:'取消',exact:true}).click();
    await confirmation.waitFor({state:'hidden'});expect(await feedbackInput.inputValue()).toBe(finalText);expect(writes).toEqual(['POST']);
    await finalButton.click();confirmation=workbench.getByRole('dialog',{name:'确认本轮最终批复',exact:true});
    await confirmation.getByRole('button',{name:'客户要求修改',exact:true}).click();
    await feedback.getByText('本轮最终批复已登记',{exact:true}).waitFor();
    await feedback.getByText(finalText,{exact:true}).waitFor();
    const updated=(await readComments()).rows;
    expect(updated).toHaveLength(3);expect(updated.slice(0,2)).toEqual(intermediate);
    expect(updated[2]).toMatchObject({version:3,is_final:true,decision:'changes_required',text_value:finalText,occurred_at:null,recorded_at:expect.any(Date)});
    expect(writes).toEqual(['POST','POST']);
    expect((await f.db.query('SELECT final_comment_version FROM digital_development_size_review_requests WHERE source_id=$1 ORDER BY final_comment_version',[commentSourceId])).rows)
     .toEqual([{final_comment_version:1},{final_comment_version:3}]);
    await workbench.screenshot({path:join(evidence,'c5-customer-feedback-two-actions-1165.png'),fullPage:true});
   }finally{await designer.close();}
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
 it('opens the seven approved workbench regions and returns from the authorized original task to the same order',async()=>{
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
   const readinessResponse=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith(`/sources/${sourceId}/production-readiness`));
   await row.click();
   expect((await readinessResponse).status()).toBe(200);
   await page.getByRole('heading',{name:source,exact:true}).waitFor();
   expect(await page.getByRole('navigation',{name:'本单区域'}).count()).toBe(0);
   expect(await page.getByRole('region',{name:'当前办理',exact:true}).count()).toBe(0);
   expect(await page.getByRole('region',{name:'开发进度',exact:true}).count()).toBe(0);
   const headings=page.locator('.designer-order-area > h2');
   expect(await headings.allTextContents()).toEqual(['版单资料','交资料','客户意见','报价','样衣寄出','订单单据','操作记录']);
   await page.setViewportSize({width:390,height:747});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.setViewportSize({width:1165,height:747});
   await page.getByRole('region',{name:'报价',exact:true}).getByText('客户当前确认版：',{exact:false}).waitFor();
   const originalDirectory=page.getByRole('region',{name:'本单原单据目录',exact:true});
   await originalDirectory.getByLabel('搜索原单与版本',{exact:true}).waitFor();
   const overviewPaths=[`/sources/${sourceId}/quotation`,`/sources/${sourceId}/production-readiness`,`/journeys/${sourceId}`];
   for(const path of overviewPaths)expect(requests.filter(request=>request.path.endsWith(path))).toHaveLength(1);
   await originalDirectory.getByLabel('搜索原单与版本',{exact:true}).fill('资料版本');
   await expect.poll(()=>new URL(page.url()).searchParams.get('originalSearch')).toBe('资料版本');
   await expect.poll(()=>originalDirectory.getByRole('status').filter({hasText:/^正在(?:读取|核对)/}).count()).toBe(0);
   expect(await originalDirectory.getByRole('navigation',{name:/版本分页/}).count()).toBe(0);
   const records=page.getByRole('region',{name:'订单单据',exact:true});
   await records.getByRole('tab',{name:'开发',exact:true}).click();
   await records.getByRole('button',{name:'本阶段关联原记录',exact:true}).click();
   const developmentRecords=records.getByRole('list',{name:'本阶段关联原记录',exact:true});
   const paperDocument=developmentRecords.locator(`a[href*="task=${paperId}"]`);
   const paperDocumentPath=new URL((await paperDocument.getAttribute('href'))!,page.url());
   expect(paperDocumentPath.searchParams.get('task')).toBe(paperId);
   expect(paperDocumentPath.searchParams.get('taskView')).toBe('read');
   const paperReturn=new URL(paperDocumentPath.searchParams.get('returnTo')!,page.url()).searchParams;
   expect(paperReturn.get('area')).toBe('records');
   expect(paperReturn.get('development')).toBe(sourceId);
   expect(paperReturn.get('originalStage')).toBe('development');
   expect(paperReturn.get('originalCategory')).toBe('related_records');
   expect(paperReturn.get('originalSearch')).toBe('资料版本');
   expect(new URL(page.url()).searchParams.get('originalSearch')).toBe('资料版本');
   for(const path of overviewPaths)expect(requests.filter(request=>request.path.endsWith(path))).toHaveLength(1);
   await paperDocument.click();
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await paperDocument.waitFor();
   expect(new URL(page.url()).searchParams.get('originalCategory')).toBe('related_records');
   expect(new URL(page.url()).searchParams.get('originalSearch')).toBe('资料版本');
   expect(new URL(page.url()).searchParams.get('development')).toBe(sourceId);
   expect(new URL(page.url()).searchParams.get('search')).toBe(source);
   // Old routed bookmarks stay valid, but land at the original document
   // instead of reconstructing a second general process/todo surface.
   const alias=new URL(page.url());alias.searchParams.set('area','development');
   await page.goto(alias.toString());
   await page.getByRole('heading',{name:'版单资料',exact:true}).waitFor();
   await expect.poll(()=>page.evaluate(()=>document.activeElement?.id)).toBe('designer-order-document');
   const handover=page.getByRole('region',{name:'交资料',exact:true});
   await handover.getByText('原设计资料交接',{exact:false}).waitFor();
   expect(await handover.getByRole('button',{name:'刷新交接记录',exact:true}).isVisible()).toBe(true);
   expect(await handover.locator('[data-preparation-kind]').evaluateAll(items=>items.map(item=>item.getAttribute('data-preparation-kind')))).toEqual(['design_handover']);
   expect(requests.filter(request=>request.method!=='GET'&&request.path.startsWith(`/api/digital-production/sources/${sourceId}`))).toEqual([]);
  } finally {await context.close();}
 });
 it('opens exact native cutting, receiving, ship-sample, QC and production-report originals from the authorized workbench',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{accessory:true}),cutting=new CuttingSourceService(f.db);
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  const [order]=await cutting.listSources({...f.root,authorizationCapability:'cutting:orders:view'}).then(result=>result.items.filter(item=>item.sourcingCaseId===ready.caseId));
  if(!order)throw Error('TEST cut must be linked to the original approved sourcing case');
  const originalPhoto=await f.image(cutter);
  await cutting.record(cutter,order.cuttingOrderId,{pieceCount:3,actualCutCount:10,attachmentIds:[originalPhoto]},randomUUID());
  const qcReady=await f.bulkReady('无'),[qcCut]=await cutting.listSources({...f.root,authorizationCapability:'cutting:orders:view'}).then(result=>result.items.filter(item=>item.sourcingCaseId===qcReady.caseId));
  if(!qcCut)throw Error('TEST QC shipment requires the original cutting order');
  await physicalCuttingLabelsFixture(f.db,f.root,qcCut.cuttingOrderId,10);
  await cutting.record(cutter,qcCut.cuttingOrderId,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),warehouse=f.people.warehouse!,beforeDispatch=await flow.read(warehouse,qcReady.id);
  await flow.dispatch(warehouse,qcReady.id,{expectedRevision:beforeDispatch.revision,supplierId:f.supplierId,occurredAt:businessNow().toISOString(),note:'TEST original warehouse dispatch'},randomUUID());
  const qcService=new QcProductionProgressService(f.db),qc=f.people.qc!;
  const qcTask=(await flow.read(f.root,qcReady.id)).tasks.find(task=>task.taskKind==='factory_production_qc')!;
  await new DigitalProductionTaskService(f.db).reassign(f.root,qcTask.taskId,qc.actorId,randomUUID());
  const qcExecution=(await qcService.read(qc,qcReady.id)).executions[0]!;
  const qcInput={factoryDecisionId:qcExecution.factoryDecisionId,expectedScopeRevision:qcExecution.scopeRevision};
  const firstQcPhoto=await f.image(qc);
  await qcService.registerUpload(qc,qcReady.id,qcExecution.factoryDecisionId,qcExecution.scopeRevision,firstQcPhoto);
  const observe=(revision:number,percent:number,note:string)=>qcService.submit(qc,qcReady.id,SubmitQcProgressSchema.parse({
   ...qcInput,submissionId:randomUUID(),kind:'progress',expectedProgressRevision:revision,collectedAt:businessNow().toISOString(),
   observations:[{lineId:qcExecution.lines[0]!.lineId,state:'working',cuttingPercent:percent,sewingPercent:null,ironingPercent:null,
    ...(revision===0?{additionalFinishedQuantity:2}:{})}],attachmentIds:revision===0?[firstQcPhoto]:[],note,
  }));
  const qcOriginal=await observe(0,35,'TEST 原现场进度');
  const photo=await f.image(qc);
  await qcService.registerUpload(qc,qcReady.id,qcExecution.factoryDecisionId,qcExecution.scopeRevision,photo);
  await qcService.submit(qc,qcReady.id,SubmitQcProgressSchema.parse({...qcInput,submissionId:randomUUID(),kind:'photos',
   expectedProgressRevision:1,relatedProgressRecordId:qcOriginal.recordId,collectedAt:null,observations:[],attachmentIds:[photo],note:'TEST 只补原次照片'}));
  const laterQc=await observe(2,70,'TEST 后来的独立进度');
  await cutting.correct({...f.root,authorizationCapability:'cutting:records:correct'},order.cuttingOrderId,{expectedVersion:1,pieceCount:5,actualCutCount:9,reason:'TEST 保留原裁数的订正'},randomUUID());
  const receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  const receiving=new ReceivingService(f.db),receiptPhoto=await f.image(receiver);
  const receipt=(await receiving.create(receiver,{cuttingOrderId:order.cuttingOrderId,documentQuantity:8,actualQuantity:8,attachmentIds:[receiptPhoto]},randomUUID())).value;
  const date=beijingCalendarDate(businessNow());
  const [batch]=(await receiving.board(date,date,ready.input.lineItems[0]!.styleNo!)).rows;
  if(!batch||batch.receivingBatchId!==receipt.receivingBatchId)throw Error('TEST receiving must use the exact original batch');
  await receiving.correctReceipt({...f.root,authorizationCapability:'receiving:correct'},receipt.receiptId,{expectedVersion:batch.version,documentQuantity:8,actualQuantity:7,defectiveQuantity:1});
  const correctedReceipt=(await receiving.documentHistory(receipt.receivingBatchId)).corrections.find(item=>item.receiptId===receipt.receiptId)!;
  const closure=new OrderClosureService(f.db),quality=(await closure.read(f.root,ready.id)).quality!.find(item=>item.receiptId===receipt.receiptId)!;
  const garmentCheck=await closure.recordQuality(f.root,ready.id,{receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,
   timeMode:'now',qualifiedQuantity:6,problem:'TEST 原成衣质量问题'},randomUUID());
  const currentBatch=async()=>{
   const row=(await receiving.board(date,date,ready.input.lineItems[0]!.styleNo!)).rows.find(item=>item.receivingBatchId===receipt.receivingBatchId);
   if(!row)throw Error('TEST original packing must match the received cutting batch');
   return row;
  };
  const pack=async(quantity:number,packingTime:PackingTimeInput)=>{
   const row=await currentBatch();
   return (await receiving.recordPacking({...f.root,authorizationCapability:'receiving:packing_manage'},{receivingBatchId:row.receivingBatchId,
    expectedVersion:row.version,expectedPackingRevisionId:row.packingRevisionId,packingQuantity:quantity,packingTime},randomUUID())).value;
  };
  const originalPacking=await pack(6,{mode:'date',value:date}),latestPacking=await pack(5,{mode:'unknown'}),differenceBatch=await currentBatch();
  const resolutionText='TEST 原装箱差异处理，保留实际数量';
  const resolutionPhoto=await f.image(ready.primary);
  const resolution=(await receiving.resolveDifference({...ready.primary,authorizationCapability:'receiving:resolve_difference'},{
   receivingBatchId:differenceBatch.receivingBatchId,expectedVersion:differenceBatch.version,expectedDocumentQuantity:differenceBatch.documentQuantity,
   expectedActualQuantity:differenceBatch.cumulativeActualQuantity,expectedPackingRevisionId:latestPacking.packingRevisionId,
   differenceType:'packing',result:resolutionText,attachmentIds:[resolutionPhoto],
  },randomUUID())).value;
  const preparation=new BulkPreparationService(f.db),preparationSheet=await preparation.read(warehouse,ready.id),materials=preparationSheet.materials!;
  const preshrink=preparationSheet.tasks.find(task=>task.taskKind==='warehouse_preshrink')!;
  expect(preshrink.state).toBe('completed');
  const issueNotes=['TEST 第一次实际发出','TEST 第二次实际发出'];
  for(const [index,note] of issueNotes.entries()){
   await preparation.dispatchMaterials(warehouse,ready.id,{instructionVersion:materials.instructionVersion!,supplierId:materials.supplierId!,
    occurredAt:businessNow().toISOString(),note,items:[{materialId:materials.items[0]!.id,quantity:index?5:3,unit:'粒'}]},randomUUID());
  }
  const issues=(await preparation.read(warehouse,ready.id)).materials!.history;
  const issueIds=issueNotes.map(note=>issues.find(issue=>issue.note===note)!.eventId);
  const fabricHistory=await preparation.documentHistory(f.root,ready.id);
  expect(fabricHistory.items.every(item=>item.kind!=='bulk_materials_dispatched')).toBe(true);
  const fabricReport=fabricHistory.items.find(item=>item.kind==='bulk_fabric_report')!;
  expect(fabricReport.payload.note).toBe('TEST native quality prerequisite');
  const current=await flow.read(ready.primary,ready.id);
  const tracked=await flow.followup(ready.primary,ready.id,{expectedRevision:current.revision,kind:'船样寄出',lineIds:[current.lines[0]!.lineId],
   occurredAt:businessNow().toISOString(),trackingNumber:'TEST 真实船样 N01',note:'TEST 只读原件使用真实寄出事实'},randomUUID());
  const shipment=tracked.shipSamples?.find(item=>item.trackingNumber==='TEST 真实船样 N01');
  if(!shipment)throw Error('TEST ship-sample command must produce one exact original shipment');
  const context=await browser.newContext({viewport:{width:1165,height:747}});
  await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const source='/ui/digital-production?'+new URLSearchParams({workspace:'designer',section:'workspace',development:ready.sourceId,area:'records',originalStage:'cutting',originalCategory:'cutting'});
  try{
   await page.goto(base+source);
   const directory=page.getByLabel('按阶段读取原单据',{exact:true});
   await directory.getByRole('button',{name:'读取此记录',exact:true}).click();
   const openVersion=(version:number)=>directory.locator(`a[href*="cuttingVersion=${version}"]`).click();
   await openVersion(1);
   await page.getByRole('heading',{name:'原实裁登记',exact:true}).waitFor();
   const record=page.locator('.cutting-record-panel');
   expect(await record.getByText('10 件',{exact:true}).count()).toBe(1);
   expect(await record.getByText('9 件',{exact:true}).count()).toBe(0);
   const original=record.getByRole('link',{name:'TEST.png',exact:true});
   expect(await original.getAttribute('href')).toContain(originalPhoto);
   await expect.poll(()=>original.getByRole('img').evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
   expect(await record.getByRole('button',{name:'修正',exact:true}).count()).toBe(0);
   await page.locator('header a[href*="originalCategory=cutting"],a.dx-breadcrumb-back[href*="originalCategory=cutting"]').first().click();
   await directory.getByRole('button',{name:'读取此记录',exact:true}).click();
   await openVersion(2);
   await page.getByRole('heading',{name:'实裁修正 · 第 2 版',exact:true}).waitFor();
   expect(await record.getByText('9 件',{exact:true}).count()).toBe(1);
   expect(await record.getByText('TEST 保留原裁数的订正',{exact:true}).count()).toBe(1);
   expect(await record.getByRole('img').count()).toBe(0);
   const missing=new URL(page.url());missing.searchParams.set('cuttingVersion','99');await page.goto(missing.href);
   await page.getByRole('alert').filter({hasText:'找不到所选裁床原记录或版本'}).waitFor();
   expect(await record.count()).toBe(0);
   const receivingOrigin=new URL(source,base);receivingOrigin.searchParams.set('originalStage','receiving');receivingOrigin.searchParams.set('originalCategory','receiving');
   let receivingReads=0;
   const receivingHistory=(url:URL)=>url.pathname===`/api/digital-production/orders/${ready.id}/receipt-summary`&&url.searchParams.get('documentBindings')==='true';
   const captureDirectory=async(route:Route)=>{
    receivingReads++;
    if(receivingReads===1){await route.fulfill({status:503,json:{error:{message:'TEST 收货原单暂不可用'}}});return;}
    await route.continue();
   };
   await page.route(receivingHistory,captureDirectory);
   await page.goto(receivingOrigin.href);
   await directory.getByRole('button',{name:'重新读取收货原单',exact:true}).click();
   const originalReceiptLink=directory.locator(`a[href*="originalReceivingId=${receipt.receiptId}"]`);
   await originalReceiptLink.waitFor();
   await directory.getByRole('button',{name:'装箱与数量差异',exact:true}).click();
   await directory.locator(`a[href*="originalReceivingId=${originalPacking.packingRevisionId}"]`).waitFor();
   const selectOriginalStage=async(label:string)=>{
    await directory.getByRole('tab',{name:label,exact:true}).click();
   };
   await selectOriginalStage('开发');
   await directory.getByRole('button',{name:'尺寸表',exact:true}).click();
   await directory.getByRole('button',{name:'纸样PLT',exact:true}).waitFor();
   await selectOriginalStage('回货');
   await directory.getByRole('button',{name:'真实回货与成衣QC',exact:true}).click();
   await originalReceiptLink.waitFor();
   expect(receivingReads).toBe(2);
   await page.reload();
   await originalReceiptLink.waitFor();
   expect(receivingReads).toBe(3);
   await page.unroute(receivingHistory,captureDirectory);
   const otherReceiving=new URL(receivingOrigin.href);otherReceiving.searchParams.set('development',qcReady.sourceId);
   const [otherReceipt]=await Promise.all([
    page.waitForResponse(result=>new URL(result.url()).pathname===`/api/digital-production/orders/${qcReady.id}/receipt-summary`),
    page.goto(otherReceiving.href),
   ]);
   expect(otherReceipt.status()).toBe(200);
   expect((await otherReceipt.json()).orderId).toBe(qcReady.id);
   await directory.getByText('暂无相关收货原记录。',{exact:true}).waitFor();
   expect(await originalReceiptLink.count()).toBe(0);
   await page.goto(receivingOrigin.href);
   await page.getByText('原收货批次凭证',{exact:true}).click();
   expect(await directory.locator(`a[href*="${receiptPhoto}"]`).count()).toBe(1);
   await directory.locator(`a[href*="originalReceivingId=${receipt.receiptId}"]`).click();
   await page.getByRole('heading',{name:'原收货 · 只读',exact:true}).waitFor();
   expect(await page.locator('dd').allTextContents()).toEqual(['8 件','8 件','0 件']);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="originalReceivingId=${correctedReceipt.id}"]`).click();
   await page.getByRole('heading',{name:'收货更正 · 只读',exact:true}).waitFor();
   expect(await page.locator('dd').allTextContents()).toEqual(['8 件','7 件','1 件']);
   const selected=new URL(page.url());
   expect(selected.searchParams.get('closure')).toBe(ready.id);
   const signedDesigner=await browser.newContext();
   try{
    await signedDesigner.addCookies([{name:'dx_rework_session',value:await loginRole('sample-designer'),url:base}]);
    const denied=await signedDesigner.newPage();denied.setDefaultTimeout(12000);
    const [refusal]=await Promise.all([denied.waitForResponse(result=>new URL(result.url()).pathname.endsWith('/receipt-summary')),denied.goto(selected.href)]);
    expect(refusal.status()).toBe(404);
    await denied.getByRole('alert').waitFor();expect(await denied.locator('dd').count()).toBe(0);
    const [directoryRefusal]=await Promise.all([
     denied.waitForResponse(result=>receivingHistory(new URL(result.url()))),denied.goto(receivingOrigin.href),
    ]);
    expect(directoryRefusal.status()).toBe(404);
    const deniedDirectory=denied.getByLabel('按阶段读取原单据',{exact:true});
    await deniedDirectory.getByRole('button',{name:'重新读取收货原单',exact:true}).waitFor();
    expect(await deniedDirectory.locator(`a[href*="originalReceivingId=${receipt.receiptId}"]`).count()).toBe(0);
    const bulkPath=`/api/digital-production/orders/${ready.id}/bulk-preparation`;
    const originalBulk=await signedDesigner.request.get(base+bulkPath);
    expect(originalBulk.status()).toBe(200);
    const allowedDispatch=(await originalBulk.json()).materials.history.find(event=>event.eventId===issueIds[0]);
    const selectedDispatch=await signedDesigner.request.get(base+bulkPath+`/history?eventId=${issueIds[0]}`);
    expect(selectedDispatch.status()).toBe(200);
    expect((await selectedDispatch.json()).items[0].payload).toEqual({note:allowedDispatch.note,items:allowedDispatch.items});
   }finally{await signedDesigner.close();}
   const warehouseIssuePath=`/digital-production/orders/${ready.id}/bulk-preparation`;
   const [originalDenied,issueDenied]=await Promise.all([
    get('worker-b',warehouseIssuePath),get('worker-b',warehouseIssuePath+`/history?eventId=${issueIds[0]}`),
   ]);
   expect([403,404]).toContain(originalDenied.statusCode);
   expect(issueDenied.statusCode).toBe(originalDenied.statusCode);
   const readEntry=(label:string)=>directory.getByText(label,{exact:true}).locator('..').getByRole('button',{name:'读取此记录',exact:true});
   await page.goto(receivingOrigin.href);
   await readEntry('到仓成衣检查历史（展开读取）').click();
   await directory.locator(`a[href*="originalEvent=${garmentCheck.eventId}"]`).click();
   await page.getByRole('heading',{name:'原到仓成衣检查 · 只读',exact:true}).waitFor();
   expect(await page.locator('dd').getByText('TEST 原成衣质量问题',{exact:true}).count()).toBe(1);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.getByText('到仓成衣检查历史（展开读取）',{exact:true}).waitFor();
   const packingOrigin=new URL(receivingOrigin.href);packingOrigin.searchParams.set('originalCategory','packing');
   await page.goto(packingOrigin.href);
   await directory.locator(`a[href*="originalReceivingId=${originalPacking.packingRevisionId}"]`).click();
   await page.getByRole('heading',{name:'装箱记录 · 只读',exact:true}).waitFor();
   expect(await page.locator('dd').allTextContents()).toEqual(['6 件']);
   await page.getByText(`${date}（仅日期）`,{exact:false}).waitFor();
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="originalReceivingId=${latestPacking.packingRevisionId}"]`).click();
   await page.getByRole('heading',{name:'装箱记录 · 只读',exact:true}).waitFor();
   expect(await page.locator('dd').allTextContents()).toEqual(['5 件']);
   await page.getByText('实际时间未登记',{exact:false}).waitFor();
   await page.getByText(/^登记时间 ·/).waitFor();
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="originalReceivingId=${resolution.resolutionId}"]`).click();
   await page.getByRole('heading',{name:'装箱差异处理 · 只读',exact:true}).waitFor();
   await page.getByText(resolutionText,{exact:true}).waitFor();
   await page.getByText('本次差异处理凭证',{exact:true}).click();
   const evidenceHref=await page.locator(`a[href*="${resolutionPhoto}"]`).getAttribute('href');
   const originalEvidence=await context.request.get(new URL(evidenceHref!,base).href);
   expect(originalEvidence.status()).toBe(200);expect((await sharp(await originalEvidence.body()).metadata()).width).toBeGreaterThan(0);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="originalReceivingId=${resolution.resolutionId}"]`).waitFor();
   expect(new URL(page.url()).searchParams.get('development')).toBe(ready.sourceId);
   const preparationOrigin=new URL(source,base);preparationOrigin.searchParams.set('originalStage','preparation');preparationOrigin.searchParams.set('originalCategory','preparation');
   await page.goto(preparationOrigin.href);
   const preshrinkLink=directory.locator(`a[href*="task=${preshrink.taskId}"][href*="taskView=read"]`);
   const taskPath=`/api/digital-production/tasks/${preshrink.taskId}`;
   const [preshrinkResponse]=await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname===taskPath),
    preshrinkLink.click(),
   ]);
   expect(preshrinkResponse.status()).toBe(200);
   expect(await preshrinkResponse.json()).toMatchObject({taskId:preshrink.taskId,orderId:ready.id,taskKind:'warehouse_preshrink',state:'completed'});
   await page.getByText('原任务记录 · 只读',{exact:true}).waitFor();
   await page.getByText('历史记录与核实',{exact:true}).click();
   await page.getByText(/^完成 · 发生/).waitFor();
   expect(await page.getByRole('link',{name:'打开大货产前办理',exact:true}).count()).toBe(0);
   const ungrantedTask=await get('worker-b',taskPath.replace('/api',''));
   expect([403,404]).toContain(ungrantedTask.statusCode);
   await page.getByRole('button',{name:'返回',exact:true}).click();
   await preshrinkLink.waitFor();
   expect(new URL(page.url()).searchParams.get('development')).toBe(ready.sourceId);
   const firstIssue=directory.locator(`a[href*="originalEvent=${issueIds[0]}"]`);
   await firstIssue.click();
   await page.getByRole('heading',{name:'原辅料发出记录 · 只读',exact:true}).waitFor();
   await page.getByText(issueNotes[0]!,{exact:true}).waitFor();
   expect(await page.getByText(issueNotes[1]!,{exact:true}).count()).toBe(0);
   expect(await page.locator('dd').getByText('3 粒',{exact:true}).count()).toBe(1);
   const foreignIssue=await context.request.get(base+`/api/digital-production/orders/${qcReady.id}/bulk-preparation/history?eventId=${issueIds[0]}`);
   expect(foreignIssue.status()).toBe(404);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await firstIssue.waitFor();
   expect(new URL(page.url()).searchParams.get('development')).toBe(ready.sourceId);
   await directory.locator(`a[href*="originalEvent=${issueIds[1]}"]`).click();
   await page.getByText(issueNotes[1]!,{exact:true}).waitFor();
   expect(await page.locator('dd').getByText('5 粒',{exact:true}).count()).toBe(1);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await readEntry('验布报告与质量决定历史').click();
   await directory.locator(`a[href*="originalEvent=${fabricReport.eventId}"]`).click();
   await page.getByRole('heading',{name:'原验布报告 · 只读',exact:true}).waitFor();
   await page.getByText('TEST native quality prerequisite',{exact:true}).waitFor();
   const wrongFamily=new URL(page.url());wrongFamily.searchParams.set('originalEvent',garmentCheck.eventId);
   const [outside]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).searchParams.get('eventId')===garmentCheck.eventId),page.goto(wrongFamily.href)]);
   expect(outside.status()).toBe(404);
   await page.getByRole('alert').waitFor();
   const shipOrigin=new URL(source,base);shipOrigin.searchParams.set('originalStage','production');shipOrigin.searchParams.set('originalCategory','ship_sample');
   await page.goto(shipOrigin.href);
   await directory.locator(`a[href*="originalFactoryId=${shipment.eventId}"]`).click();
   await page.getByRole('heading',{name:'船样寄出 · 只读',exact:true}).waitFor();
   expect(await page.locator('dd').allTextContents()).toEqual(['TEST 真实船样 N01']);
   expect(await page.getByRole('button',{name:'记录已寄出',exact:true}).count()).toBe(0);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="originalFactoryId=${shipment.eventId}"]`).waitFor();
   expect(new URL(page.url()).searchParams.get('originalCategory')).toBe('ship_sample');
   const qcOrigin=new URL(source,base);qcOrigin.searchParams.set('development',qcReady.sourceId);qcOrigin.searchParams.set('originalStage','production');qcOrigin.searchParams.set('originalCategory','qc_progress');
   await page.goto(qcOrigin.href);
   await directory.locator(`a[href*="originalFactoryId=${qcOriginal.recordId}"]`).click();
   await page.getByRole('heading',{name:'QC进度 · 第 1 版 · 只读',exact:true}).waitFor();
   await page.getByText('TEST 原现场进度',{exact:true}).waitFor();
   expect(await page.getByText('TEST 后来的独立进度',{exact:true}).count()).toBe(0);
   await page.getByText('裁剪 35%',{exact:false}).waitFor();
   await page.getByText('TEST 只补原次照片',{exact:true}).waitFor();
   const qcPhoto=page.locator(`a[href*="${photo}"]`),photoHref=await qcPhoto.getAttribute('href');
   expect(await page.locator(`a[href*="${firstQcPhoto}"]`).count()).toBe(1);
   expect(photoHref).toContain(photo);
   const image=await context.request.get(new URL(photoHref!,base).href);
   expect(image.ok()).toBe(true);expect((await sharp(await image.body()).metadata()).width).toBeGreaterThan(0);
   const scopedQcUrl=new URL(page.url());
   expect(scopedQcUrl.searchParams.get('qcProductionId')).toBe(qcExecution.productionId);
   const wrongDecision=new URL(scopedQcUrl);wrongDecision.searchParams.set('qcDecisionId',randomUUID());
   await page.goto(wrongDecision.href);
   await page.getByRole('alert').filter({hasText:'找不到所选厂单的QC原记录或版本'}).waitFor();
   expect(await qcPhoto.count()).toBe(0);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="originalFactoryId=${laterQc.recordId}"]`).click();
   await page.getByRole('heading',{name:'QC进度 · 第 3 版 · 只读',exact:true}).waitFor();
   await page.getByText('TEST 后来的独立进度',{exact:true}).waitFor();
   expect(await qcPhoto.count()).toBe(0);
   const reportId=qcOriginal.reportIds[0];expect(reportId).toBeTruthy();
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await readEntry('本厂单原生产填报').click();
   const report=directory.locator(`a[href*="originalReport=${reportId}"]`);
   await report.click();
   await page.getByRole('heading',{name:'生产填报 · 第 1 版 · 只读',exact:true}).waitFor();
   await page.locator('dd').getByText('2 件',{exact:true}).waitFor();
   expect(new URL(page.url()).pathname).toBe(`/ui/production-reporting/${qcExecution.productionId}`);
   expect(await page.getByRole('button',{name:'保存上报',exact:true}).count()).toBe(0);
   expect(await page.getByRole('button',{name:'Root 修正',exact:true}).count()).toBe(0);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await readEntry('本厂单原生产填报').waitFor();
   const adoptionReady=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true});
   const beforeBasis=await new BulkPreparationService(f.db).read(f.root,adoptionReady.id);
   const frozen=beforeBasis.publishedBasis?.technicalArtifact;
   if(!frozen||frozen.roundNumber!==1)throw Error('TEST original instruction must have adopted a real round-one technical artifact');
   const historical=await new DigitalDevelopmentService(f.db,true).read(f.root,adoptionReady.sourceId);
   const rounds=new DevelopmentRoundService(f.db,true);
   const draft=await rounds.save(f.root,adoptionReady.sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:historical.document!,origin:'内部发现',
    customerComment:'',internalProblem:'TEST 第二轮修改纸样',explanation:'TEST 已发布制单只能打开原采用成果',categories:['版型'],
    affectedNodes:['纸样','裁板','车板'],outputKind:'整件样板'}},randomUUID());
   await rounds.publish(f.root,adoptionReady.sourceId,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID());
   expect((await new DigitalDevelopmentService(f.db,true).read(f.root,adoptionReady.sourceId)).roundNumber).toBe(2);
   expect((await new BulkPreparationService(f.db).read(f.root,adoptionReady.id)).publishedBasis).toEqual(beforeBasis.publishedBasis);
   const technicalOrigin=new URL(preparationOrigin.href);technicalOrigin.searchParams.set('development',adoptionReady.sourceId);technicalOrigin.searchParams.set('originalCategory','technical');
   await page.goto(technicalOrigin.href);
   await readEntry('已发布制单第 1 版的采用资料 · 开发第 1 轮').click();
   const adoptedLink=directory.locator(`a[href*="originalTechnicalId=${frozen.id}"]`);
   const adoptedTarget=new URL((await adoptedLink.getAttribute('href'))!,base);
   expect(adoptedTarget.searchParams.get('round')).toBe('1');
   expect(adoptedTarget.searchParams.get('originalTechnicalVersion')).toBe(String(frozen.version));
   await adoptedLink.click();
   await page.getByRole('heading',{name:`原技术成果 · 第 1 轮 v${frozen.version} · 只读`,exact:true}).waitFor();
   await page.getByText('袖长',{exact:true}).waitFor();
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await readEntry('已发布制单第 1 版的采用资料 · 开发第 1 轮').waitFor();
   expect(new URL(page.url()).searchParams.get('development')).toBe(adoptionReady.sourceId);
  }finally{await context.close();}
 });

 it('opens the explicitly linked rework node and exact original revision without revealing ungranted history',async()=>{
  const ready=await f.bulkReady('无'),cutting=new CuttingSourceService(f.db);
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  const [cut]=await cutting.listSources({...f.root,authorizationCapability:'cutting:orders:view'}).then(result=>result.items.filter(item=>item.sourcingCaseId===ready.caseId));
  if(!cut)throw Error('TEST rework requires its own original received order');
  await cutting.record(cutter,cut.cuttingOrderId,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  const receipt=await new ReceivingService(f.db).create(warehouse,{cuttingOrderId:cut.cuttingOrderId,documentQuantity:10,actualQuantity:10,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const qc={...f.people.qc!,authorizationCapability:'rework:initiate',authorizationCapabilities:['rework:initiate']};
  const initiation=new ReworkInitiationService(f.db,'anchor-test');
  const draft=await initiation.createDraft(qc,{receivingBatchId:receipt.value.receivingBatchId,
   styleNo:ready.input.lineItems[0]!.styleNo!,orderQuantity:10,merchandiserUserId:f.people.merchandiser!.actorId,
   processingFactory:{type:'supplier',supplierId:f.supplierId},tailInspectionRequired:false,inspectionReport:completeInspectionReport(),
   problemPart:'袖口',problemDescription:'TEST 原返工问题',reworkQuantity:10,attachmentIds:[await f.image(qc)]},randomUUID());
  const id=draft.value.reworkOrderId;
  await initiation.submit(qc,id,{expectedVersion:draft.value.version},randomUUID());
  const original=(await new ReworkBusinessDetailService(f.db).get(f.root,id,true)).originalNodeEntries?.find(entry=>entry.node==='initiation');
  if(!original)throw Error('TEST rework has no exact original initiation event');
  const denied=await app.inject({method:'GET',url:`/rework-orders/${id}/business-detail?originalNodes=true`,
   headers:{cookie:`dx_rework_session=${await loginRole('sample-designer')}`}});
  expect([403,404]).toContain(denied.statusCode);
  expect(denied.body).not.toContain(original.entryId);
  expect(denied.body).not.toContain('TEST 原返工问题');
  const baseline=await get('root',`/rework-orders/${id}/business-detail`);
  expect(baseline.statusCode).toBe(200);expect(baseline.json()).not.toHaveProperty('originalNodeEntries');
  const context=await browser.newContext({viewport:{width:1165,height:747}});
  await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);
  try{
   const source='/ui/digital-production?'+new URLSearchParams({workspace:'designer',section:'workspace',development:ready.sourceId,
    area:'records',originalStage:'receiving',originalCategory:'rework'});
   await page.goto(base+source);
   const directory=page.getByLabel('按阶段读取原单据',{exact:true});
   await directory.getByRole('button',{name:'读取此记录',exact:true}).click();
   const href=directory.locator(`a[href*="entryId=${original.entryId}"][href*="node=initiation"]`);
   const [response]=await Promise.all([page.waitForResponse(result=>new URL(result.url()).pathname.endsWith(`/rework-orders/${id}/history/initiation`)),href.click()]);
   expect(response.ok()).toBe(true);
   const detail=await response.json();
   expect(detail).toMatchObject({orderId:id,node:'initiation',entry:{id:original.entryId},
    fields:expect.arrayContaining([{label:'问题描述',value:'TEST 原返工问题'}])});
   const originalStyle=detail.fields.find((field:{label:string;value:string|null})=>field.label==='款号').value;
   expect(originalStyle.toLowerCase()).toBe(ready.input.lineItems[0]!.styleNo!.toLowerCase());
   const originalHeader=page.locator('.rework-history-readonly header');
   await originalHeader.getByText('历史节点 · 只读',{exact:true}).waitFor();
   await originalHeader.getByRole('heading',{name:originalStyle,exact:true}).waitFor();
   expect(new URL(page.url()).pathname).toBe(`/ui/tasks/${id}`);
   await page.getByRole('link',{name:'返回这张订单',exact:true}).click();
   await directory.getByRole('button',{name:'读取此记录',exact:true}).waitFor();
   const returned=new URL(page.url());
   expect(returned.searchParams.get('development')).toBe(ready.sourceId);
   expect(returned.searchParams.get('originalCategory')).toBe('rework');
  }finally{await context.close();}
 });

 it('opens the original approved contract PDF and its signed revision without borrowing the latest version',async()=>{
  const ready=await f.bulkReady('无'),root=f.root;
  const initial=(await f.contracts.getCurrent(root,ready.caseId)).item;
  if(!initial?.pdfAttachmentId)throw Error('TEST owner approval needs its original produced contract');
  const signedAttachment=await f.image(root),returns=new SourcingContractReturnService(f.db);
  const signed=await returns.submit(root,ready.caseId,[signedAttachment],randomUUID(),initial.sourcingContractDocumentId);
  expect(signed.versions).toEqual(expect.arrayContaining([expect.objectContaining({signedContractDocumentId:initial.sourcingContractDocumentId})]));
  const template=(await f.contracts.management.templates(root)).item;
  await f.contracts.management.saveTemplate(root,{...template,expectedVersion:template.templateVersion,
   terms:{...template.terms,payment:'TEST 修订合同付款条件'}},randomUUID());
  const preview=await f.contracts.management.previewInformation(root,ready.caseId);
  const revision=await f.contracts.management.refreshInformation(root,ready.caseId,preview,randomUUID());
  const current=(await f.contracts.generateIfReady(root,ready.caseId,revision)).item;
  expect(current?.contractVersion).toBe(initial.contractVersion+1);
  expect(current?.pdfAttachmentId).not.toBe(initial.pdfAttachmentId);
  const context=await browser.newContext({viewport:{width:1165,height:747}});
  await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);
  try{
   const source='/ui/digital-production?'+new URLSearchParams({workspace:'designer',section:'workspace',development:ready.sourceId,
    area:'records',originalStage:'preparation',originalCategory:'contract'});
   await page.goto(base+source);
   const directory=page.getByLabel('按阶段读取原单据',{exact:true});
   await directory.locator(`a[href*="originalContract=${initial.sourcingContractDocumentId}"]`).click();
   await page.getByRole('heading',{name:`系统合同 · 第 ${initial.contractVersion} 版 · 只读`,exact:true}).waitFor();
   await page.getByText(initial.contractNumber,{exact:true}).waitFor();
   const pdfLink=page.getByRole('link',{name:'预览所选合同 PDF',exact:true}),pdfHref=await pdfLink.getAttribute('href');
   expect(pdfHref).toContain(initial.pdfAttachmentId);
   const response=await context.request.get(new URL(pdfHref!,base).href);
   expect(response.ok()).toBe(true);expect((await response.body()).subarray(0,4).toString()).toBe('%PDF');
   expect(await page.locator(`a[href*="${signedAttachment}"]`).count()).toBe(1);
   expect(await page.locator(`a[href*="${current!.pdfAttachmentId}"]`).count()).toBe(0);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="originalContract=${revision}"]`).click();
   await page.getByRole('heading',{name:`系统合同 · 第 ${current!.contractVersion} 版 · 只读`,exact:true}).waitFor();
   expect(await page.locator(`a[href*="${signedAttachment}"]`).count()).toBe(0);
   const other=new URL(page.url());other.searchParams.set('originalContract',randomUUID());await page.goto(other.href);
   await page.getByRole('alert').filter({hasText:'找不到所选合同版本'}).waitFor();
   expect(await pdfLink.count()).toBe(0);
   const factory=await f.access.createSupplier(root,CreateSupplierSchema.parse({supplierCode:'TEST-'+randomUUID().slice(0,8).toUpperCase(),supplierType:'factory',
    supplierName:'TEST 原转厂单据',address:'TEST',contractEntityName:'TEST',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0010',bankName:'TEST',changeReason:'TEST 外发原单据'}));
   const requestReason='TEST 转厂只读时须保留的原申请理由';
   await f.sourcing.requestFactoryChange(f.people['production-management']!,ready.caseId,{supplierId:factory.supplierId,unitPrice:'6',changeReason:requestReason},randomUUID());
   const timeline=(await f.sourcing.listTimeline({...root,authorizationCapability:'sourcing:view'},ready.caseId)).items;
   const owner=timeline.find(record=>record.kind==='owner_decision')!,transfer=timeline.find(record=>record.kind==='factory_change_request')!;
   expect(transfer.reason).toBe(requestReason);
   const sourcingUrl=new URL(base+source);sourcingUrl.searchParams.set('originalCategory','sourcing_history');
   await page.goto(sourcingUrl.href);
   await directory.locator(`a[href*="entryId=${owner.entryId}"]`).click();
   await page.getByRole('heading',{name:'最终审批',exact:true}).first().waitFor();
   expect(new URL(page.url()).searchParams.get('entryId')).toBe(owner.entryId);
   await page.getByRole('link',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="relatedEntryId=${transfer.entryId}"]`).click();
   const selected=page.getByRole('region',{name:'所选外发记录',exact:true});
   await selected.getByText(requestReason,{exact:true}).waitFor();
   expect(new URL(page.url()).pathname.endsWith(ready.caseId)).toBe(true);
   await page.getByRole('link',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="relatedEntryId=${transfer.entryId}"]`).waitFor();
   expect(new URL(page.url()).searchParams.get('development')).toBe(ready.sourceId);
   const mismatch=new URL((await directory.locator(`a[href*="relatedEntryId=${transfer.entryId}"]`).getAttribute('href'))!,base);
   mismatch.searchParams.set('relatedEntryId',owner.entryId);await page.goto(mismatch.href);
   await page.getByRole('alert').filter({hasText:'找不到所选的外发原记录'}).waitFor();
   expect(await selected.count()).toBe(0);

   const financeReady=await f.bulkReady('无');
   const financeContract=(await f.contracts.getCurrent(root,financeReady.caseId)).item;
   expect(financeContract?.contractNumber).toBeTruthy();
   const finance=await loginRole('factory-payables'),management=await loginRole('production-management');
   const moneyPath=`/sourcing/cases/${financeReady.caseId}`;
   const submit=(token:string,path:string,payload:object)=>app.inject({
    method:'POST',url:moneyPath+path,payload,
    headers:{cookie:`dx_rework_session=${token}`,'idempotency-key':randomUUID()},
   });
   const reason='TEST 第一轮财务发现原合同总额差异';
   const difference=await submit(finance,'/finance-reconciliations',{result:'difference',differenceFields:['total_amount'],differenceReason:reason});
   expect(difference.statusCode,difference.body).toBe(201);
   const reopen=await submit(management,'/exception-decisions',{resolution:'reconcile_again',resolutionReason:'TEST 回原财务重新核对'});
   expect(reopen.statusCode,reopen.body).toBe(201);
   const match=await submit(finance,'/finance-reconciliations',{result:'match'});
   expect(match.statusCode,match.body).toBe(201);
   const reconciliations=(await f.sourcing.listTimeline({...root,authorizationCapability:'sourcing:view'},financeReady.caseId)).items.filter(record=>record.kind==='finance_reconciliation');
   expect(reconciliations.map(item=>[item.version,item.result])).toEqual([[1,'difference'],[2,'match']]);
   const [firstFinance,lastFinance]=reconciliations;
   const financeOrigin=new URL(sourcingUrl);
   financeOrigin.searchParams.set('development',financeReady.sourceId);
   await page.goto(financeOrigin.href);
   const financeLink=directory.locator(`a[href*="entryId=${firstFinance!.entryId}"]`);
   await financeLink.click();
   await page.getByText('正在回看：财务核对',{exact:true}).waitFor();
   const readValue=(label:string)=>page.getByText(label,{exact:true}).locator('..').locator('input, textarea').inputValue();
   expect(await readValue('核对结果')).toBe('发现不一致');
   expect(await readValue('核对说明')).toBe(reason);
   expect(await readValue('对应合同')).toBe(financeContract!.contractNumber);
   const exactHistory=moneyPath+`/history/finance?entryId=${firstFinance!.entryId}`;
   const [financeOriginal,ungrantedFinance,foreignFinance]=await Promise.all([
    app.inject({method:'GET',url:exactHistory,headers:{cookie:`dx_rework_session=${finance}`}}),
    get('worker-b',exactHistory),
    get('root',exactHistory.replace(financeReady.caseId,ready.caseId)),
   ]);
   expect(financeOriginal.statusCode).toBe(200);
   expect(financeOriginal.json()).toMatchObject({contractReference:financeContract!.contractNumber,entry:{entryId:firstFinance!.entryId,version:1,result:'difference',reason}});
   expect([403,404]).toContain(ungrantedFinance.statusCode);
   expect(foreignFinance.statusCode).toBe(404);
   await page.getByRole('link',{name:'返回来源',exact:true}).click();
   await financeLink.waitFor();
   expect(new URL(page.url()).searchParams.get('development')).toBe(financeReady.sourceId);
   expect(new URL(page.url()).searchParams.get('originalCategory')).toBe('sourcing_history');
   await directory.locator(`a[href*="entryId=${lastFinance!.entryId}"]`).click();
   await page.getByText('正在回看：财务核对',{exact:true}).waitFor();
   expect(await readValue('核对结果')).toBe('确认与合同一致');
   expect(await readValue('核对说明')).not.toBe(reason);
  }finally{await context.close();}
 });

 it('keeps the original sample handover receipt through a recipient change without affecting shipping or clocks',async()=>{
  const {id}=await prepareDevelopment(),designer=f.people['sample-designer']!,first=f.people.merchandiser!,second=f.people.ie!;
  const assignment=await f.access.assignRole(f.root,{userId:second.actorId,roleCode:'order_merchandiser',reason:'TEST alternate design handover recipient'});
  let assignmentActive=true;
  const token=await loginRole('sample-designer'),root=tokens.get('root')!;
  const endpoint=`/digital-production/sources/${id}/production-readiness`,sample=endpoint+'/sample-handover';
  const send=(method:'GET'|'POST',url:string,key:string,payload?:unknown,session=token)=>app.inject({method,url,
   headers:{cookie:`dx_rework_session=${session}`,'idempotency-key':key},...(payload?{payload}:{}),
  });
  const clockAndTasks=async()=>{
   const plans=(await f.db.query('SELECT to_jsonb(p) AS value FROM digital_development_sla_plans p WHERE source_id=$1 ORDER BY revision',[id])).rows;
   const tasks=(await f.db.query(`SELECT t.task_id,t.state,a.assignee_id,t.entered_at,t.completed_at,t.created_at
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 ORDER BY t.task_id`,[id])).rows;
   const events=(await f.db.query('SELECT event_id,event_kind,occurred_at,recorded_at FROM digital_production_task_events WHERE resource_id=$1 ORDER BY event_id',[id])).rows;
   return {plans,tasks,events};
  };
  const context=await browser.newContext({viewport:{width:1165,height:747}});
  try{
   const latest=await new DigitalDevelopmentService(f.db,true).read(designer,id);
   const body={round:latest.roundNumber!,documentVersion:latest.version,recipientId:first.actorId};
   const firstEvidence=await f.image(designer),secondEvidence=await f.image(designer);
   const selectRecipient=(recipientId:string,expectedVersion:number)=>send('POST',endpoint+'/materials',randomUUID(),{
    kind:'design_handover',state:'ready',scopeRef:'whole',expectedVersion,occurredAt:'2026-11-08T00:00:00Z',
    note:expectedVersion?'TEST 重新交接':'TEST 第一次交接', sourceDocumentVersion:latest.version,recipientId,
    evidenceIds:[expectedVersion?secondEvidence:firstEvidence],
   });
   const empty=await send('GET',sample,'');expect(empty.statusCode).toBe(200);
   expect(empty.json()).toMatchObject({recipient:null,canConfirm:false,current:null,history:[]});
   const firstShare=await selectRecipient(first.actorId,0);expect(firstShare.statusCode,firstShare.body).toBe(200);
   const before=await clockAndTasks();expect(before.tasks.length).toBeGreaterThan(0);
   const invalid=await send('POST',sample,randomUUID(),{...body,round:body.round+1});expect(invalid.statusCode).toBe(409);
   const otherRole=await send('POST',sample,randomUUID(),body,root);expect([403,404]).toContain(otherRole.statusCode);
   await context.addCookies([{name:'dx_rework_session',value:token,url:base}]);
   const page=await context.newPage();
   await page.goto(`${base}/ui/digital-production?workspace=designer&section=workspace&development=${id}&area=handover`);
   const panel=page.getByRole('region',{name:'样衣交接',exact:true});
   const result=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(sample));
   await panel.getByRole('button',{name:'确认已交样衣',exact:true}).click();
   const submitted=await result;expect(submitted.status()).toBe(200);expect(submitted.request().postDataJSON()).toEqual(body);
   const key=await submitted.request().headerValue('idempotency-key');expect(key).toBeTruthy();
   const firstReceipt=(await submitted.json()).receipt;
   expect(firstReceipt).toMatchObject({...body,confirmedBy:designer.actorId});
   await panel.getByText(/^已交样衣 ·/).waitFor();
   const repeat=await send('POST',sample,randomUUID(),body);expect(repeat.statusCode).toBe(200);expect(repeat.json().receipt).toEqual(firstReceipt);
   const reassigned=await selectRecipient(second.actorId,1);expect(reassigned.statusCode,reassigned.body).toBe(200);
   const afterReassignment=await send('GET',sample,'');expect(afterReassignment.json()).toMatchObject({recipient:{id:second.actorId},current:null,canConfirm:true,history:[firstReceipt]});
   const stale=await send('POST',sample,randomUUID(),body);expect(stale.statusCode).toBe(409);
   const retry=await send('POST',sample,key!,body);expect(retry.json()).toMatchObject({handover:{recipient:{id:second.actorId},current:null},receipt:firstReceipt});
   const secondBody={...body,recipientId:second.actorId};
   const secondResult=await send('POST',sample,randomUUID(),secondBody);
   expect(secondResult.statusCode).toBe(200);expect(secondResult.json().receipt.eventId).not.toBe(firstReceipt.eventId);
   expect(secondResult.json().handover.history.map((row:{recipientId:string})=>row.recipientId)).toEqual([second.actorId,first.actorId]);
   await f.access.revokeRole(f.root,assignment.assignmentId,'TEST remove the new recipient’s original role');
   assignmentActive=false;
   const revoked=await send('GET',sample,'');
   expect(revoked.json()).toMatchObject({recipient:null,current:null,canConfirm:false,history:[secondResult.json().receipt,firstReceipt]});
   const records=(await f.db.query("SELECT id FROM audit_events WHERE entity_type='digital_development_handover' AND entity_id=$1",[id])).rows;
   expect(records).toHaveLength(2);
   const initialHandover=firstShare.json().history.find((fact:{kind:string})=>fact.kind==='design_handover');
   expect(initialHandover).toMatchObject({version:1,recipientId:first.actorId,evidenceIds:[firstEvidence]});
   const source='/ui/digital-production?'+new URLSearchParams({workspace:'designer',section:'workspace',development:id,
    area:'records',originalStage:'preparation',originalCategory:'preparation'});
   await page.goto(base+source);
   const directory=page.getByLabel('按阶段读取原单据',{exact:true});
   await directory.locator(`a[href*="originalMaterial=${initialHandover.recordId}"][href*="originalMaterialVersion=1"]`).click();
   await page.getByRole('heading',{name:/第 1 版 · 只读/}).waitFor();
   await page.getByText('TEST 第一次交接',{exact:true}).waitFor();
   const signed=page.getByRole('link',{name:'原凭证 1',exact:true}),signedHref=await signed.getAttribute('href');
   expect(signedHref).toContain(firstEvidence);expect(signedHref).not.toContain(secondEvidence);
   const downloaded=await context.request.get(new URL(signedHref!,base).href);
   expect(downloaded.ok()).toBe(true);expect((await sharp(await downloaded.body()).metadata()).width).toBeGreaterThan(0);
   const wrongVersion=new URL(page.url());wrongVersion.searchParams.set('originalMaterialVersion','99');await page.goto(wrongVersion.href);
   await page.getByRole('alert').filter({hasText:'找不到所选物料原记录或版本'}).waitFor();
   expect(await signed.count()).toBe(0);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await directory.locator(`a[href*="originalMaterial=${initialHandover.recordId}"][href*="originalMaterialVersion=1"]`).waitFor();
   expect(await clockAndTasks()).toEqual(before);
  }finally{
   await context.close();
   if(assignmentActive)await f.access.revokeRole(f.root,assignment.assignmentId,'TEST teardown alternate handover recipient');
  }
 });
 it('shares authoritative quantities and quotation versions only after the original authorized writes',async()=>{
  const {id}=await prepareDevelopment(true,undefined,true),designer=f.people['sample-designer']!,recipient=f.people.merchandiser!,worker=f.people['pattern-room-worker']!;
  const forms=new DigitalDevelopmentService(f.db,true),source=await forms.read(designer,id);
  const readiness=new ProductionReadinessService(f.db),resource={kind:'source' as const,id};
  const token=await loginRole('sample-designer'),url=`/digital-production/sources/${id}/production-readiness/sample-handover`;
  const view=async()=>{
   const response=await app.inject({method:'GET',url,headers:{cookie:`dx_rework_session=${token}`}});
   expect(response.statusCode,response.body).toBe(200);
   return response.json();
  };
  const events=async()=> (await f.db.query(`SELECT id,after_state FROM audit_events WHERE entity_type='digital_development_handover'
   AND entity_id=$1 AND action='design_electronic_documents_shared' ORDER BY created_at,id`,[id])).rows;
  await readiness.record(designer,resource,{
   kind:'design_handover',state:'ready',scopeRef:'whole',expectedVersion:0,occurredAt:'2026-11-08T00:00:00Z',note:'TEST original design materials',
   sourceDocumentVersion:source.version,recipientId:recipient.actorId,evidenceIds:[],quantities:[],
  },randomUUID());
  expect((await view()).electronic).toEqual([
   expect.objectContaining({kind:'materials',state:'shared',version:source.version,receipt:expect.objectContaining({recipientId:recipient.actorId})}),
   expect.objectContaining({kind:'order_quantities',state:'not_applicable'}),expect.objectContaining({kind:'quotation',state:'incomplete'}),
  ]);
  expect(await events()).toEqual([]);
  await new DigitalProductionAccessService(f.db).setCustomerDefault(f.root,'PD',recipient.actorId);
  const order=await new DigitalProductionIdentityService(f.db,true).createOrder(designer,DigitalOrderCreateSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:source.designStyleNo,orderDate:beijingCalendarDate(businessNow()),
   lines:[{formalPoNo:source.designStyleNo,color:'黑',customerWarehouseArrivalDate:beijingCalendarDate(new Date(businessNow().getTime()+60*86400000)),
    sizes:[{size:'M',quantity:7},{size:'L',quantity:3}]}],
  }),randomUUID(),id);
  expect((await view()).electronic[1]).toMatchObject({kind:'order_quantities',state:'shared',version:order.version,receipt:{recipientId:recipient.actorId,version:order.version}});
  expect((await view()).electronic[2]).toMatchObject({kind:'quotation',state:'incomplete',version:null});
  const quotes=new DigitalQuotationService(f.db,true),rowId=randomUUID();
  const draft=await quotes.save(designer,resource,{expectedVersion:0,document:{fabricType:'针织',productCategory:'上衣',monthSeries:'',date:'2026-11-08',currency:'人民币',
   rows:[{rowId,section:'主料',category:'',name:'TEST面料',specification:'40支',unit:'米',supplier:'TEST',consumption:'',unitPrice:'8'}],
   freight:'0',cm:'0',salePrice:'',outsourcingScope:'',outsourcingUnitPrice:'0',imageAttachmentIds:[],
  },assignments:[{rowId,technicalAssigneeId:worker.actorId,priceAssigneeId:designer.actorId,priceRole:'sample_designer'}]},randomUUID());
  const priced=await quotes.fillRow(worker,resource,rowId,{expectedVersion:draft.version,consumption:'1'},randomUUID());
  expect((await view()).electronic[2]).toMatchObject({kind:'quotation',state:'incomplete',version:null});
  const confirmed=await quotes.confirm(designer,resource,QuotationConfirmationSchema.parse({
   expectedVersion:priced.version,customerCode:'PD',customerConfirmedTotal:'20',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',
   taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',
   evidenceNote:'TEST 真实业务确认入口及签名',workbenchPricing:{field:'customerUnitPrice',value:'20'},confirmedAt:'2026-11-08T00:00:00Z',
  }),randomUUID());
  expect((await view()).electronic[2]).toMatchObject({kind:'quotation',state:'shared',version:confirmed.confirmedVersion,receipt:{recipientId:recipient.actorId}});
  const history=await events();expect(history).toHaveLength(2);
  expect(history.flatMap(row=>row.after_state.bases).map(row=>[row.kind,row.id,row.version])).toEqual([
   ['order_quantities',order.productionOrderId,order.version],['quotation',confirmed.quoteId,confirmed.confirmedVersion],
  ]);
  await view();expect(await events()).toEqual(history);
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

 it('opens the exact native washing facts for a factory and a receiving batch without writing',async()=>{
  await prepareRewashSettings(f);
  const scenarios=[];
  for(const mode of ['factory','after_receipt'] as const){
   const subject=await failedFrameworkWashingFixture(f,mode);
   const read=()=>f.runtime.run(subject.scene,f.root,()=>subject.washing.read(f.root,subject.orderId));
   const before=await read(),scope=before.scopes.find(item=>item.mode===mode)!;
   const sourceId=(await new DigitalProductionIdentityService(f.db,true).read(f.root,subject.orderId)).sourceId;
   if(!sourceId)throw Error('TEST washing order must have its original development source');
   expect(scope.facts.some(item=>item.id===subject.inspectionId)).toBe(true);
   scenarios.push({mode,subject,read,before,scope,sourceId});
  }
  const context=await browser.newContext({viewport:{width:1165,height:747}});
  await context.addCookies([{name:'dx_rework_session',value:tokens.get('root')!,url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const commands:string[]=[];
  page.on('request',request=>{
   const path=new URL(request.url()).pathname;
   if(path.endsWith('/bulk-washing')&&request.method()!=='GET')commands.push(request.method());
  });
  const logistics=await loginRole('embroidery-washing-merchandiser');
  try{
   for(const {mode,subject,read,before,scope,sourceId} of scenarios){
    const orderPath=`/digital-production/orders/${subject.orderId}/bulk-washing`;
    const origin='/ui/digital-production?'+new URLSearchParams({
     workspace:'designer',section:'workspace',development:sourceId,
     selected:sourceId,area:'records',originalStage:'post_cutting',originalCategory:'factory',
    });
    const [operatorScope,ungranted]=await Promise.all([
     app.inject({method:'GET',url:orderPath,headers:{cookie:`dx_rework_session=${logistics}`}}),
     get('worker-b',orderPath),
    ]);
    expect(operatorScope.statusCode).toBe(200);
    expect(operatorScope.json().scopes).toEqual(expect.arrayContaining([expect.objectContaining({scopeId:scope.scopeId})]));
    expect(operatorScope.json().scopes.some(item=>Object.hasOwn(item,'fee'))).toBe(false);
    expect([403,404]).toContain(ungranted.statusCode);
    await page.goto(base+origin);
    const directory=page.getByRole('region',{name:'洗水原记录',exact:true});
    const link=directory.locator(`a[href*="originalFactoryId=${subject.inspectionId}"]`);
    const href=new URL((await link.getAttribute('href'))!,base);
    expect(href.searchParams.get('factory')).toBe(subject.orderId);
    expect(href.searchParams.get('originalWashingScope')).toBe(scope.scopeId);
    await link.click();
    await page.getByRole('heading',{name:'洗后检查 · 只读',exact:true}).waitFor();
    expect(await page.locator('dd').allTextContents()).toEqual(expect.arrayContaining([scope.label,'2 件','1 件']));
    expect(await page.getByRole('button',{name:'保存',exact:true}).count()).toBe(0);
    await page.getByRole('button',{name:'返回来源',exact:true}).click();
    await link.waitFor();
    expect(new URL(page.url()).searchParams.get('selected')).toBe(sourceId);
    expect(new URL(page.url()).searchParams.get('originalCategory')).toBe('factory');
    const second=scenarios.find(item=>item.mode!==mode)!;
    href.searchParams.set('originalWashingScope',second.scope.scopeId);
    await page.goto(href.href);
    await page.getByRole('alert').filter({hasText:'找不到所选批次的洗水原记录'}).waitFor();
    expect(await page.locator('dd').count()).toBe(0);
    expect((await read()).scopes[0]!.facts).toEqual(before.scopes[0]!.facts);
   }
   expect(commands).toEqual([]);
  }finally{await context.close();}
 });
 it.each(['quotation-last','sample-last'] as const)('C5 completes the formal milestone only on four original receipts with confirmed C6 pricing and preserves history (%s)',async(last)=>{
  await prepareRewashSettings(f);
  const {id}=await prepareDevelopment(true,undefined,true,true),designer=f.people['sample-designer']!,first=f.people.merchandiser!,second=f.people.ie!;
  const worker=f.people['pattern-room-worker']!,source=await new DigitalDevelopmentService(f.db,true).read(designer,id);
  const token=await loginRole('sample-designer'),firstToken=await loginRole('merchandiser');
  const path=`/digital-production/sources/${id}`,sample=`${path}/production-readiness/sample-handover`,quote=`${path}/quotation`;
  const send=(method:'GET'|'POST'|'PUT',url:string,payload?:object,session=token,key=randomUUID())=>app.inject({method,url,
   headers:{cookie:`dx_rework_session=${session}`,'idempotency-key':key},...(payload?{payload}:{})});
  const body=async(response:Awaited<ReturnType<typeof send>>)=>{expect(response.statusCode,response.body).toBe(200);return response.json();};
  const view=async()=>body(await send('GET',sample));
  const material=(recipientId:string,expectedVersion:number)=>({kind:'design_handover',state:'ready',scopeRef:'whole',expectedVersion,
   occurredAt:new Date(businessNow().getTime()-60_000).toISOString(),note:'TEST 原面辅料回执',sourceDocumentVersion:source.version,recipientId,evidenceIds:[],quantities:[]});
  const receipt=(recipientId:string)=>({round:source.roundNumber!,documentVersion:source.version,recipientId});
  const record=async()=> (await f.db.query(`SELECT e.id,e.after_state,p.event_id,p.occurred_at FROM audit_events e
   JOIN digital_series_source_events p ON p.source_record_id=e.id WHERE e.action='design_formal_handover_completed' AND e.entity_id=$1`,[id])).rows;
  await body(await send('POST',`${path}/production-readiness/materials`,material(first.actorId,0)));
  const sampleKey=randomUUID();
  const early=last==='quotation-last'?await body(await send('POST',sample,receipt(first.actorId),token,sampleKey)):null;
  expect((await view()).formal).toBeUndefined();expect(await record()).toEqual([]);
  await new DigitalProductionAccessService(f.db).setCustomerDefault(f.root,'PD',first.actorId);
  const date=beijingCalendarDate(new Date(businessNow().getTime()+90*86400000));
  const formalInput=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:source.designStyleNo,
   orderDate:beijingCalendarDate(businessNow()),contractDeliveryDate:date,requiresColorMatching:false,productionPlanning:{craftSteps:[],preshrink:false},
   lines:[{formalPoNo:source.designStyleNo,color:'黑',customerWarehouseArrivalDate:date,sizes:[{size:'M',quantity:7},{size:'L',quantity:3}]}]});
  const order=last==='quotation-last'?await body(await send('POST',`${path}/confirm`,formalInput)):await (async()=>{
   const service=new OrderTimeRequestService(f.db,orderTimeNativeExecutor(f.db,true));
   const operation={kind:'confirm_order',sourceId:id,input:formalInput};
   const checked=await service.check(designer,operation);
   const requested=await service.submit(designer,{operation,fingerprint:checked.fingerprint,reason:'TEST 原审核路径确认客户订单'},randomUUID());
   const pending=await service.read(f.root,requested.requestId);
   const applied=await service.apply(f.root,pending.requestId,{expectedVersion:pending.version,fingerprint:pending.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   expect(applied.appliedBy?.id).toBe(f.root.actorId);
   return new DigitalProductionIdentityService(f.db,true).read(designer,applied.result!.orderId!);
  })();
  const orderId=order.productionOrderId as string;
  const plan=async()=>new OrderTimePlanRepository(f.db).current({kind:'order',id:orderId});
  const beforePlan=await plan();expect(beforePlan).toBeTruthy();
  const sampleView=await view();expect(sampleView.formal).toEqual({currentComplete:false,historicalCompletion:null});
  if(early)expect(sampleView.current.eventId).toBe(early.receipt.eventId);else expect(sampleView.current).toBeNull();
  expect(sampleView.electronic.map((r:{state:string})=>r.state)).toEqual(['shared','shared','incomplete']);
  if(last==='sample-last'){
   const shared=(await f.db.query('SELECT actor_id FROM audit_events WHERE id=$1',[sampleView.electronic[1].receipt.id])).rows[0];
   expect(shared.actor_id).toBe(f.root.actorId);
  }
  expect((await f.db.query(`SELECT 1 FROM digital_series_source_events WHERE production_order_id=$1 AND node_key='design_handover' AND business_completed`,[orderId])).rowCount).toBe(0);
  const budget=`/digital-production/orders/${orderId}/budget`;
  expect((await body(await send('GET',budget,undefined,firstToken))).canEdit).toBe(false);
  const rowId=randomUUID(),saved=await body(await send('PUT',quote,{expectedVersion:0,document:{fabricType:'针织',productCategory:'上衣',monthSeries:'',date:null,currency:'人民币',
   rows:[{rowId,section:'主料',category:'',name:'TEST 面料',specification:'40支',unit:'米',supplier:'TEST',consumption:'',unitPrice:'8'}],
   freight:'0',cm:'0',salePrice:'',outsourcingScope:'',outsourcingUnitPrice:'0',imageAttachmentIds:[]},assignments:[{rowId,technicalAssigneeId:worker.actorId,priceAssigneeId:designer.actorId,priceRole:'sample_designer'}]}));
  const priced=await body(await send('POST',`${quote}/rows/${rowId}`,{expectedVersion:saved.version,consumption:'1'},tokens.get('pattern-room-worker')!));
  const confirm={expectedVersion:priced.version,customerCode:'PD',customerConfirmedTotal:'20',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',
   taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',
   evidenceNote:'TEST 真实报价交接',confirmedAt:new Date(businessNow().getTime()-1000).toISOString(),workbenchPricing:{field:'customerUnitPrice',value:'20'}};
  const quoteKey=randomUUID(),confirmed=await body(await send('POST',`${quote}/confirm`,confirm,token,quoteKey));
  if(last==='sample-last'){
   expect((await view()).formal).toEqual({currentComplete:false,historicalCompletion:null});expect(await record()).toEqual([]);
  }
  const originalSample=early??await body(await send('POST',sample,receipt(first.actorId),token,sampleKey));
  const after=await view(),original=(await record())[0]!;
  expect(after.formal).toMatchObject({currentComplete:true,historicalCompletion:{eventId:original.event_id}});
  expect(original.after_state).toMatchObject({orderId,sourceId:id,sampleReceiptId:originalSample.receipt.eventId,recipientId:first.actorId,
   receipts:[{kind:'materials',version:source.version},{kind:'order_quantities',version:order.version},{kind:'quotation',version:confirmed.confirmedVersion}]});
  expect(original.occurred_at.toISOString()).toBe(last==='quotation-last'?after.electronic[2].receipt.at:originalSample.receipt.occurredAt);
  expect((await body(await send('GET',budget,undefined,firstToken))).canEdit).toBe(true);
  await body(await send('POST',`${quote}/confirm`,confirm,token,quoteKey));
  await body(await send('POST',sample,receipt(first.actorId),token,sampleKey));
  expect(await record()).toEqual([original]);expect(await plan()).toEqual(beforePlan);
  const pageContext=await browser.newContext({viewport:{width:1165,height:900}});
  await pageContext.addCookies([{name:'dx_rework_session',value:token,url:base}]);
  try{
   const page=await pageContext.newPage();
   await page.goto(`${base}/ui/digital-production?workspace=designer&section=workspace&development=${id}`);
   await page.getByText('交资料—完成',{exact:true}).waitFor();
   await page.screenshot({path:join(evidence,`c5-formal-four-${last}.png`),fullPage:true});
  }finally{await pageContext.close();}
  const assignment=await f.access.assignRole(f.root,{userId:second.actorId,roleCode:'order_merchandiser',reason:'TEST new actual C5 recipient'});
  try{
   await new DigitalProductionAccessService(f.db).assignMerchandiser(f.root,orderId,second.actorId,order.version);
   const changed=await view();expect(changed.formal).toEqual({...after.formal,currentComplete:false});expect(changed.current).toBeNull();
   expect((await send('POST',sample,receipt(first.actorId))).statusCode).toBe(409);
   await body(await send('POST',`${path}/production-readiness/materials`,material(second.actorId,1)));
   expect((await view()).formal.currentComplete).toBe(false);
   const simultaneous=await Promise.all([send('POST',sample,receipt(second.actorId)),send('POST',sample,receipt(second.actorId))]);
   const final=await view();expect(simultaneous.map(r=>r.statusCode)).toEqual([200,200]);
   expect(simultaneous.map(r=>r.json().receipt.eventId)).toEqual([final.current.eventId,final.current.eventId]);
   expect(final.formal).toEqual(after.formal);expect(final.history).toHaveLength(2);
   expect(await record()).toEqual([original]);expect(await plan()).toEqual(beforePlan);
   await body(await send('POST',`${quote}/rows/${rowId}`,{expectedVersion:confirmed.version,unitPrice:'9'}));
   const pendingQuote=await view();
   expect(pendingQuote.electronic[2]).toMatchObject({kind:'quotation',state:'incomplete'});
   expect(pendingQuote.formal).toEqual({...after.formal,currentComplete:false});
   expect(await record()).toEqual([original]);expect(await plan()).toEqual(beforePlan);
  }finally{await f.access.revokeRole(f.root,assignment.assignmentId,'TEST clean up C5 recipient');}
 });

});
