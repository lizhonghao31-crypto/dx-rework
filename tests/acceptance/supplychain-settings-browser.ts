import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {registerProductionClosureRoutes} from '../../apps/api/src/sourcing/production-closure-routes.js';
import {BulkWashingService} from '../../apps/api/src/production-platform/bulk-washing-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {readQualityWarehouseCraftOccupation} from '../../apps/api/src/production-platform/quality-warehouse-craft-occupation.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {Browser,chromium as Chromium} from 'playwright-core';
import Fastify from 'fastify';
import {build} from 'vite';
import {AuthService,AuthDeniedError} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {registerAuthRoutes} from '../../apps/api/src/auth/routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DeliveryCalendarQuery} from '../../apps/api/src/production-platform/delivery-calendar-query.js';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {SeriesPlanService} from '../../apps/api/src/production-platform/series-plan-service.js';
import {ShortLeadService} from '../../apps/api/src/production-platform/short-lead-service.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {registerTodoRoutes} from '../../apps/api/src/todos/routes.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {registerPatternRoomPriceRoutes} from '../../apps/api/src/pattern-room/price-routes.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {registerAcceptanceClockRoutes} from '../../apps/api/src/acceptance-clock/routes.js';
import {mintAcceptanceControlCode} from '../../apps/api/src/auth/acceptance-control.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {AuxiliaryCatalogService} from '../../apps/api/src/access/auxiliary-catalog-service.js';
import {registerAuxiliaryCatalogRoutes} from '../../apps/api/src/access/auxiliary-catalog-routes.js';
import {registerAccessRoutes} from '../../apps/api/src/access/routes.js';
import {registerSourcingRoutes} from '../../apps/api/src/sourcing/sourcing-routes.js';
import {SourcingProductionService} from '../../apps/api/src/sourcing/sourcing-production-service.js';
import {SourcingContractReturnService} from '../../apps/api/src/sourcing/sourcing-contract-return-service.js';
import {registerProcessConfigurationRoutes} from '../../apps/api/src/rework/process-configuration-routes.js';
import {registerReworkRoutes} from '../../apps/api/src/rework/routes.js';
import {ReworkBusinessDetailService} from '../../apps/api/src/rework/rework-business-detail-service.js';
import {ReworkInitiationService} from '../../apps/api/src/rework/service.js';
import {ReworkV2SubmissionService} from '../../apps/api/src/rework/v2-submission-service.js';
import {ReworkV2DraftService} from '../../apps/api/src/rework/v2-draft-service.js';
import {ReworkSupplyContextService} from '../../apps/api/src/rework/supply-context-service.js';
import {WorkReportingService} from '../../apps/api/src/rework/work-reporting-service.js';
import {registerWorkReportingRoutes} from '../../apps/api/src/rework/work-reporting-routes.js';
import {WholeOrderReviewService} from '../../apps/api/src/rework/whole-order-review-service.js';
import {registerWholeOrderReviewRoutes} from '../../apps/api/src/rework/whole-order-review-routes.js';
import {ProcessConfigurationService} from '../../apps/api/src/rework/process-configuration-service.js';
import {ProcessWorkerPlanService} from '../../apps/api/src/rework/process-worker-plan-service.js';
import type {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {readIntegratedIeDirectory} from '../../apps/api/src/production-platform/ie-directory-reader.js';
export type SettingsBrowserFault={losePath?:string;lost?:boolean;failRead?:boolean;afterPublishRead?:boolean;readPath?:string;afterWriteRead?:string};
/** Original full App, original auth routes/store/membership and actual native
 * services. Only DingTalk and named transport faults are TEST adapters. */
export async function supplychainSettingsBrowser(url:string,evidence:string,options?:{fullApp?:boolean;orderTimeModel?:boolean;orderTimeFlow?:boolean;auxiliaryCatalog?:boolean;accessCatalog?:boolean;workbenchNumberedCreation?:boolean;throughVersion?:string;unifiedIeDirectory?:boolean;sourcingFullDetail?:boolean;originalCraftRework?:boolean;merchandiserWorkbench?:boolean}){
 const out=await mkdtemp(join(tmpdir(),'dx-settings-set-')),app=Fastify(),f=await businessAnchorFixture(url,options?.throughVersion?{throughVersion:options.throughVersion}:undefined),db=f.db,secret='TEST paired settings native auth only '.repeat(4),root=new RootAuthority(db,'anchor-test','uat-root');
 const auth=new AuthService(new AcceptanceDingTalkProvider(db,'anchor-test',secret),new PostgresAuthStore(db,'anchor-test','uat-root'),'anchor-test',3600000,secret),errors:string[]=[],faults=new Map<string,SettingsBrowserFault>();
 const requests:Array<{session:string;path:string;method:string;key:string|null;bodyHash:string|null;status:number}>=[];
 const activeRequests=new Map<string,Set<Promise<void>>>(),closedSessions=new Set<string>();
 let browser:Browser|undefined,server:Server|undefined,loginIndex=0,collectionScene:string|undefined;
 const dispose=async()=>{await browser?.close();if(server)await new Promise<void>(r=>server!.close(()=>r()));await app.close();await f.dispose();await rm(out,{recursive:true,force:true});};
 try{
  registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:'/',corpId:'anchor-test',mobileClientId:'TEST',webClientId:'TEST',qrRedirectUri:'https://acceptance.invalid/auth/qr/callback',isRootUser:id=>root.isRootUser(id)});
  if(options?.auxiliaryCatalog)registerAuxiliaryCatalogRoutes(app,{authenticate:token=>auth.authenticate(token),root,service:new AuxiliaryCatalogService(db,root)});
  if(options?.accessCatalog)registerAccessRoutes(app,{authenticate:token=>auth.authenticate(token),root,service:f.access});
  if(options?.unifiedIeDirectory){
   const authenticate=(token:string|undefined)=>auth.authenticate(token);
   registerSourcingRoutes(app,{authenticate,root,service:f.sourcing,contracts:f.contracts,
    ...(options.sourcingFullDetail?{production:new SourcingProductionService(db),contractReturns:new SourcingContractReturnService(db)}:{})});
  }
  if(options?.unifiedIeDirectory||options?.originalCraftRework){
   const authenticate=(token:string|undefined)=>auth.authenticate(token);
   registerProcessConfigurationRoutes(app,{authenticate,root,service:new ProcessConfigurationService(db),workerPlan:new ProcessWorkerPlanService(db)});
  }
  if(options?.originalCraftRework){
   const authenticate=(token:string|undefined)=>auth.authenticate(token);
   registerReworkRoutes(app,{authenticate,root,service:new ReworkInitiationService(db,'anchor-test'),v2DraftService:new ReworkV2DraftService(db,'anchor-test'),
    v2SubmissionService:new ReworkV2SubmissionService(db,'anchor-test'),supplyContextService:new ReworkSupplyContextService(db,'anchor-test'),
    businessDetailService:new ReworkBusinessDetailService(db),originalCraftQuality:true});
   registerWorkReportingRoutes(app,{authenticate,root,service:new WorkReportingService(db)});
   registerWholeOrderReviewRoutes(app,{authenticate,root,service:new WholeOrderReviewService(db)});
  }
  app.setErrorHandler((error,_request,reply)=>{const e=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:e.statusCode??500).send({error:{code:e.code,message:e.message}});});
  const notifications=(options?.orderTimeFlow||options?.merchandiserWorkbench)?new DigitalProductionNotificationService(db):undefined,todos=notifications?new TodoService(db,undefined,undefined,undefined,notifications):undefined,patternOrders=todos?new PatternRoomOrderService(db,new TodoProjectionService(todos),{ordersEnabled:true}):undefined;
  const orderTimeRequests=options?.orderTimeFlow?new OrderTimeRequestService(db,orderTimeNativeExecutor(db,true,patternOrders)):undefined;
  let controlToken:string|undefined;
  if(options?.orderTimeFlow){registerAcceptanceClockRoutes(app,f.runtime,auth,root);controlToken=await auth.beginAcceptanceControl(mintAcceptanceControlCode(secret));registerPatternRoomPriceRoutes(app,{authenticate:token=>auth.authenticate(token),root,service:new PatternRoomPriceService(db)});}
  if(todos)registerTodoRoutes(app,{authenticate:token=>auth.authenticate(token),root,service:todos,merchandiserWorkbench:options?.merchandiserWorkbench});
  registerProductionClosureRoutes(app,{authenticate:token=>auth.authenticate(token),root,service:new ProductionClosureService(db,root)});
  registerDigitalIdentityRoutes(app,{...(options?.unifiedIeDirectory?{readIeDirectory:(actors,input)=>readIntegratedIeDirectory(db,actors,input)}:{}),bulkWashing:options?.fullApp?new BulkWashingService(db):undefined,service:new DigitalProductionIdentityService(db,true),quotationService:options?.fullApp?new DigitalQuotationService(db,true):undefined,budgetService:options?.fullApp?new DigitalBudgetService(db,true):undefined,creationEnabled:true,...(options?.workbenchNumberedCreation?{workbenchNumberedCreation:true}:{}),root,authenticate:token=>auth.authenticate(token),accessService:new DigitalProductionAccessService(db),taskService:new DigitalProductionTaskService(db,secret,options?.orderTimeModel),developmentService:new DigitalDevelopmentService(db,true,patternOrders),developmentExecution:new DevelopmentExecutionService(db,true,patternOrders),developmentAttachments:f.attachments,readinessService:new ProductionReadinessService(db),journeys:new DigitalJourneyQuery(db),...(options?.fullApp?{closureService:new OrderClosureService(db),deliveryCalendar:new DeliveryCalendarQuery(db),factoryFlowService:new FactoryFlowService(db,options?.originalCraftRework?readQualityWarehouseCraftOccupation:undefined),bulkPreparationService:new BulkPreparationService(db)}:{}),seriesPlans:new SeriesPlanService(db,secret),shortLead:new ShortLeadService(db),...(orderTimeRequests?{orderTimeRequests,notificationService:notifications!,instructionService:new ProductionInstructionService(db,true),developmentRounds:new DevelopmentRoundService(db,true,patternOrders)}:{})});
  // Unrelated navigation indicator is a clearly labelled TEST response.
  if(!todos)app.get('/todos/mine/indicator',async(request,reply)=>{const user=await auth.authenticate(request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18));reply.header('x-dx-rework-actor-id',user.id);return {pendingCount:0,unreadCount:0};});
  await app.ready();
  await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},
   build:{outDir:out,lib:{entry:resolve(options?.fullApp?'tests/fixtures/m01-cockpit-home-native-ui.tsx':'tests/fixtures/m01-settings-native-ui.tsx'),name:'NativeSettingsUi',formats:['iife']}}});
  const files=await readdir(out),js=await readFile(join(out,files.find(p=>p.endsWith('.js'))!),'utf8'),css=await readFile(join(out,files.find(p=>p.endsWith('.css'))!),'utf8');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
  server=createServer(async(req,res)=>{
   let settle:(()=>void)|undefined;
   try{
   const path=req.url??'/',session=(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('settings_fixture_session='))?.split('=')[1]??'unowned';
   if(!path.startsWith('/api/')){res.setHeader('content-type','text/html;charset=utf-8');res.end(html);return;}
   if(closedSessions.has(session)){res.writeHead(410);res.end();return;}
   const active=activeRequests.get(session);
   if(active){
    let finish!:()=>void;
    const pending=new Promise<void>(resolve=>{finish=resolve;});
    active.add(pending);
    settle=()=>{active.delete(pending);finish();};
   }
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString(),method=req.method??'GET',key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:null,fault=faults.get(session);
   if(fault?.failRead&&path===(fault.readPath??'/api/digital-production/sla-settings/sets')&&method==='GET'){fault.failRead=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'TEST_READ_FAILURE',message:'TEST 设置读取暂时失败'}}));return;}
   const inject=async()=>await app.inject({method:method as 'GET'|'POST'|'PUT',url:path.slice(4),headers:{cookie:req.headers.cookie??'',...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(key?{'idempotency-key':key}:{})},...(body?{payload:body}:{})});
   // Global collection routes have no resource ID for the ordinary guarded
   // clock hook. This owned TEST harness supplies an explicitly selected scene;
   // authentication, current role and original todo/notification/calendar services run.
   const result=collectionScene&&/^\/api\/(?:todos\/|digital-production\/(?:notifications|delivery-calendar)\/)/.test(path)?await f.runtime.run(collectionScene,f.root,inject):await inject();
   requests.push({session,path,method,key,bodyHash:body?createHash('sha256').update(body).digest('hex'):null,status:result.statusCode});
   if(fault?.afterPublishRead&&path.endsWith('/sets/publish')&&result.statusCode===200)fault.failRead=true;
   if(fault?.afterWriteRead===path&&method==='POST'&&result.statusCode===200)fault.failRead=true;
   if(fault?.losePath===path&&!fault.lost&&method==='POST'&&result.statusCode===200){fault.lost=true;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'TEST_COMMITTED_RECEIPT_LOST',message:'TEST 已提交，回执暂时不可用'}}));return;}
   // Keep the real endpoint's redirects and binary payloads. Converting every
   // response to JSON concealed whether an authorized original image opened.
   res.writeHead(result.statusCode,{'content-type':result.headers['content-type']??'application/json','cache-control':result.headers['cache-control']??'no-store',...(typeof result.headers.location==='string'?{location:result.headers.location}:{}),...(result.headers['x-dx-rework-actor-id']?{'x-dx-rework-actor-id':result.headers['x-dx-rework-actor-id']}:{}),...(result.headers['idempotency-replayed']?{'idempotency-replayed':result.headers['idempotency-replayed']}:{})});res.end(result.rawPayload);
  }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'TEST_NATIVE_HTTP',message:(e as Error).message}}));}
   finally{settle?.();}
  });
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('Owned loopback port missing');const base='http://127.0.0.1:'+address.port;
  const {chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??'playwright-core');browser=await chromium.launch({headless:true,...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{}),args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
  const admin={...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin','master_data:manage']};
  const dedicated=async(role:string,label?:string)=>{const id=randomUUID();await db.query('INSERT INTO app_users(id,display_name,enabled)VALUES($1,$2,true)',[id,label??'TEST settings set '+role]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,'uat-pair-'+id,'uat-union-pair-'+id]);const assignment=await f.access.assignRole(admin,{userId:id,roleCode:role,reason:'TEST isolated settings native identity'});return {id,assignmentId:assignment.assignmentId};};
  const login=async(id:string)=>{const mapping=(await db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND corp_id='anchor-test' AND active AND employed",[id])).rows[0];assert(mapping?.provider_user_id.startsWith('uat-'));const response=await app.inject({method:'POST',url:'/auth/mobile',remoteAddress:'127.0.0.'+(++loginIndex),payload:{code:mintAcceptanceLoginCode(mapping.provider_user_id.slice(4),secret)}});assert.equal(response.statusCode,200,response.statusCode===200?undefined:response.body);const cookie=response.headers['set-cookie'],header=Array.isArray(cookie)?cookie[0]:cookie;assert.equal(typeof header,'string');const token=header!.split(';',1)[0]!.slice('dx_rework_session='.length);assert.equal((await auth.authenticate(token)).id,id);return token;};
  const open=async(id=f.root.actorId,width=1440,fault:SettingsBrowserFault={},path='/ui/digital-cockpit?workspace=settings&fullApp=1')=>{
   const context=await browser!.newContext({viewport:{width,height:960}}),session=randomUUID(),active=new Set<Promise<void>>();
   faults.set(session,fault);activeRequests.set(session,active);
   await context.addCookies([{name:'dx_rework_session',value:await login(id),url:base},{name:'settings_fixture_session',value:session,url:base},...(controlToken?[{name:'dx_acceptance_control',value:controlToken,url:base}]:[])]);
   const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+path);
   const close=async()=>{
    // Closing Chromium does not stop accepted app.inject requests. Drain this
    // session before another case reuses its database identities or clock.
    closedSessions.add(session);
    try{await context.close();}finally{
     await Promise.all(active);
     activeRequests.delete(session);
     faults.delete(session);
    }
   };
   return {context,page,session,close};
  };
  const writeEvidence=()=>writeFile(join(evidence,'requests.json'),JSON.stringify({source:'Original App/AuthService/native services, isolated lowpriv TEST PG, only labelled external provider/transport adapters',requests,errors},null,2));
  return {f,db,auth,base,browser,open,dedicated,admin,requests,faults,errors,evidence,writeEvidence,dispose,patternOrders,orderTimeRequests,setCollectionScene:(id:string|undefined)=>{collectionScene=id;}};
 }catch(e){await dispose();throw e;}
}
