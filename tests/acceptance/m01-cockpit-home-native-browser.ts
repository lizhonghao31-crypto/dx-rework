import {cockpitThumbnailFixture} from './cockpit-thumbnail-fixture.js';
import {PoCustomerDateService} from '../../apps/api/src/production-platform/po-customer-date-service.js';
import {addCalendarDays} from '@dx-rework/contracts/series-calendar';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DeliveryCalendarQuery} from '../../apps/api/src/production-platform/delivery-calendar-query.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {QcProductionProgressService} from '../../apps/api/src/production-platform/qc-production-progress-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {registerSourcingRoutes} from '../../apps/api/src/sourcing/sourcing-routes.js';
import {SourcingProductionService} from '../../apps/api/src/sourcing/sourcing-production-service.js';
import {SourcingContractReturnService} from '../../apps/api/src/sourcing/sourcing-contract-return-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {ProductionDashboardService} from '../../apps/api/src/sourcing/production-dashboard-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {Browser,Page,chromium as Chromium} from 'playwright-core';
import type {PoolClient} from 'pg';
import Fastify from 'fastify';
import {build} from 'vite';
import {AuthService,AuthDeniedError} from '../../apps/api/src/auth/service.js';
import {registerPatternRoomPriceRoutes} from '../../apps/api/src/pattern-room/price-routes.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {registerAuthRoutes} from '../../apps/api/src/auth/routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import type {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JourneyFactRuntime,JourneyFactUpdates} from '../../apps/api/src/production-platform/journey-fact-updates.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {JOURNEY_COVERAGE_KEYS,type JourneyResult} from '@dx-rework/contracts/digital-production-journey';

/** Full original App/Shell, original signed auth and marked, owned PostgreSQL.
 * All objects are TEST fixtures, not Acceptance site or customer business data. */
export async function cockpitHomeBrowser({databaseUrl,evidence,executablePath,calendar=false,indexed=false,orderCount=31,mixedNative=false,productionAssets=false,productionRoot=resolve('apps/web'),photos=false,fixtureProfile='home'}:{databaseUrl:string;evidence:string;executablePath?:string;calendar?:boolean;indexed?:boolean;orderCount?:31|1000|5000;mixedNative?:boolean;productionAssets?:boolean;productionRoot?:string;photos?:boolean;fixtureProfile?:'home'|'navigation'}){
 assert([31,1000,5000].includes(orderCount));
 // Navigation consumers need the original App and auth, not the home dataset.
 // Keep all existing home profiles and their defaults unchanged.
 assert(fixtureProfile==='home'||fixtureProfile==='navigation');
 if(fixtureProfile==='navigation')assert(!calendar&&!indexed&&!mixedNative&&!photos&&orderCount===31,'Navigation profile cannot supply home/calendar/scale fixtures');
 const out=await mkdtemp(join(tmpdir(),'dx-m01-home-')),app=Fastify(),errors:string[]=[],requests:Array<{path:string;status:number}>=[];
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>|undefined,browser:Browser|undefined,server:Server|undefined,factRuntime:JourneyFactRuntime|undefined;
 const resources:Array<{path:string;bytes:number}>=[];
 let assetManifest:Record<string,{file:string;css?:string[];imports?:string[];isEntry?:boolean;isDynamicEntry?:boolean}>|null=null;
 const dispose=async()=>{
  try{await mkdir(evidence,{recursive:true});if(browser)for(const [i,page]of browser.contexts().flatMap(c=>c.pages()).entries())await writeFile(join(evidence,`last-page-${i}.txt`),await page.locator('body').innerText().catch(()=>''));await writeFile(join(evidence,'requests.json'),JSON.stringify({requests,errors},null,2));}
  finally{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}await factRuntime?.stop();await app.close();await f?.dispose();await rm(out,{recursive:true,force:true});}
 };
 try{
  f=await businessAnchorFixture(databaseUrl);const fixture=f,db=f.db,identity=new DigitalProductionIdentityService(db,true),secret='TEST original home browser signed authentication '.repeat(3),root=new RootAuthority(db,'anchor-test','uat-root'),auth=new AuthService(new AcceptanceDingTalkProvider(db,'anchor-test',secret),new PostgresAuthStore(db,'anchor-test','uat-root'),'anchor-test',3600000,secret);
  registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:'/',corpId:'anchor-test',mobileClientId:'TEST',webClientId:'TEST',qrRedirectUri:'https://acceptance.invalid/auth/qr/callback',isRootUser:id=>root.isRootUser(id)});
  registerPatternRoomPriceRoutes(app,{authenticate:token=>auth.authenticate(token),root,service:new PatternRoomPriceService(db)});
  const reporting=new ProductionReportingService(db);
  registerSourcingRoutes(app,{authenticate:token=>auth.authenticate(token),root,service:f.sourcing,contracts:f.contracts,contractReturns:new SourcingContractReturnService(db),production:new SourcingProductionService(db),reporting,dashboard:new ProductionDashboardService(db,reporting)});
  app.setErrorHandler((error,_request,reply)=>{const value=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:value.statusCode??500).send({error:{code:value.code,message:value.message}});});
  registerDigitalIdentityRoutes(app,{service:identity,creationEnabled:true,root,authenticate:token=>auth.authenticate(token),qcProgress:new QcProductionProgressService(db),factoryFlowService:new FactoryFlowService(db),closureService:new OrderClosureService(db),quotationService:new DigitalQuotationService(db,true),developmentRounds:new DevelopmentRoundService(db,true),notificationService:new DigitalProductionNotificationService(db),taskService:new DigitalProductionTaskService(db),accessService:new DigitalProductionAccessService(db),developmentService:new DigitalDevelopmentService(db,true),developmentExecution:new DevelopmentExecutionService(db,true),developmentAttachments:f.attachments,budgetService:new DigitalBudgetService(db,true),instructionService:new ProductionInstructionService(db,true),bulkPreparationService:new BulkPreparationService(db),journeys:new DigitalJourneyQuery(db,{listReadMode:indexed?'indexed':'legacy'}),...(calendar?{deliveryCalendar:new DeliveryCalendarQuery(db)}:{})});
  // The unrelated navigation badge is a labelled TEST adapter, still authenticated.
  app.get('/todos/mine/indicator',async(request,reply)=>{const token=request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18),user=await auth.authenticate(token);reply.header('x-dx-rework-actor-id',user.id);return {pendingCount:0,unreadCount:0};});
  const prefix='TEST-R3-HOME-',scene=await f.scene('2026-08-01T00:00:00Z'),orders:string[]=[];
  const includeNative=mixedNative||orderCount>31;
  if(fixtureProfile==='home')await f.runtime.run(scene,f.root,async()=>{for(let i=0;i<orderCount-(includeNative?3:0);i++){
   orders.push((await identity.createOrder(fixture.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:prefix+String(i+1).padStart(2,'0'),orderDate:'2026-08-01',primaryMerchandiserId:fixture.people.merchandiser!.actorId,lines:Array.from({length:i===0?3:2},(_,j)=>({formalPoNo:`TEST-PO-${i+1}-${j+1}${i===0?'-LONG-'.repeat(7):''}`,color:['黑','浅蓝','白'][j],customerWarehouseArrivalDate:includeNative?'2027-03-01':`2026-10-0${j+1}`,sizes:[{size:'M',quantity:100+j}]}))}),randomUUID())).productionOrderId);
   if(orderCount>31&&(i+1)%250===0)console.log('JOURNEY_SCALE_SETUP '+JSON.stringify({phase:'create',completed:i+1,total:orderCount}));
  }});
  await f.advance(scene,'2026-11-07T00:00:00Z');
  // Original cutting/receiving/packing commands establish real visible receipt debt.
  // A native mother deliberately shares the first numeric style prefix. A
  // substring search must retain it when a different matching model fails;
  // randomized UUID prefixes previously made that valid overlap intermittent.
  if(includeNative)await fixture.runtime.run(scene,fixture.root,async()=>{for(const craft of ['无','印花','印绣花'] as const)orders.push((await fixture.bulkReady(craft,undefined,2,fixture.sourcing,{stylePrefix:prefix+(craft==='无'?'01-':'')})).id);console.log('JOURNEY_SCALE_SETUP '+JSON.stringify({phase:'create',completed:orders.length,total:orderCount,mixedNativeMothers:3}));});
  let updateCalendarPacking:((quantity:number)=>Promise<void>)|undefined;
  const prepareShortage=async()=>{
   const ready=await fixture.bulkReady('无',undefined,1,fixture.sourcing,{quantity:4}),cut=(await db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0],cutter={...fixture.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:4,attachmentIds:[await fixture.image(cutter)]},randomUUID());
  const receiving=new ReceivingService(db),warehouse={...fixture.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receipt=(await receiving.create(warehouse,{cuttingOrderId:cut.cutting_order_id,documentQuantity:2,actualQuantity:2,attachmentIds:[await fixture.image(warehouse)]},randomUUID())).value,day=beijingCalendarDate(businessNow()),batch=(await receiving.board(day,day,'','all',1,15,receipt.receivingBatchId)).rows.find(row=>row.receivingBatchId===receipt.receivingBatchId)!;
  if(calendar){
   // The delivery scenario covers all four received garments with native QC
   // before the original 2 -> 3 packing correction.
   await receiving.createRepeated(warehouse,{cuttingOrderId:cut.cutting_order_id,receivingBatchId:receipt.receivingBatchId,source:'jiashun',actualQuantity:2,defectiveQuantity:0},randomUUID());
   const closure=new OrderClosureService(db);
   for(const check of (await closure.read(fixture.root,ready.id)).quality!)await closure.recordQuality(fixture.root,ready.id,{receiptId:check.receiptId,quantityVersion:check.quantityVersion,occurredAt:businessNow().toISOString(),qualifiedQuantity:check.quantity,problem:''},randomUUID());
  }
  const packingBasis=calendar?(await receiving.board(day,day,'','all',1,15,receipt.receivingBatchId)).rows.find(row=>row.receivingBatchId===receipt.receivingBatchId)!:batch;
  await receiving.recordPacking({...fixture.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:receipt.receivingBatchId,expectedVersion:packingBasis.version,expectedPackingRevisionId:packingBasis.packingRevisionId,packingQuantity:2},randomUUID());
  if(calendar)updateCalendarPacking=async quantity=>{await fixture.runtime.run(scene,fixture.root,async()=>{const current=(await receiving.board(day,day,'','all',1,15,receipt.receivingBatchId)).rows.find(row=>row.receivingBatchId===receipt.receivingBatchId)!;await receiving.recordPacking({...fixture.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:receipt.receivingBatchId,expectedVersion:current.version,expectedPackingRevisionId:current.packingRevisionId,packingQuantity:quantity},randomUUID());});};return identity.read(fixture.root,ready.id);
  };
  const photo=photos?await fixture.runtime.run(scene,fixture.root,()=>cockpitThumbnailFixture(fixture,orders[0]!)):null;
  const servedImages:Array<{key:string;bytes:number;mimeType:string}>=[];
  const shortage=fixtureProfile==='home'?(calendar?await f.runtime.run(scene,fixture.root,prepareShortage):await prepareShortage()):undefined,rootAccess={...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin']},pmcId=randomUUID();
  await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[pmcId,'TEST dedicated home PMC']);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)",[randomUUID(),pmcId,'uat-home-'+pmcId,'uat-union-home-'+pmcId]);
  const pmcGrant=await f.access.assignRole(rootAccess,{userId:pmcId,roleCode:'pmc',reason:'TEST home drill dedicated original PMC'});await f.access.assignRole(rootAccess,{userId:pmcId,roleCode:'finance_read',reason:'TEST keep original signed session valid after PMC revocation'});
  let loginIndex=0;const login=async(id:string)=>{const mapping=(await db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND active AND employed",[id])).rows[0],response=await app.inject({method:'POST',url:'/auth/mobile',remoteAddress:`127.0.0.${++loginIndex}`,payload:{code:mintAcceptanceLoginCode(mapping.provider_user_id.slice(4),secret)}});assert.equal(response.statusCode,200,response.body);const headers=response.headers['set-cookie'],token=(Array.isArray(headers)?headers[0]:headers)!.split(';',1)[0]!.slice('dx_rework_session='.length);assert.equal((await auth.authenticate(token)).id,id);return token;};
  const facts=new JourneyFactRepository(db);
  // Explicit owned TEST setup, never a GET/read-side backfill or user action.
  if(indexed){const resources=(await db.query<{kind:'source'|'order';id:string}>(`SELECT 'order' AS kind,production_order_id AS id FROM digital_production_orders
   UNION ALL SELECT 'source',source_id FROM digital_production_sources s WHERE NOT EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.source_id=s.source_id)`)).rows;
   let next=0,completed=0;const workers=await Promise.allSettled(Array.from({length:2},async()=>{
    for(;;){const resource=resources[next++];if(!resource)return;await facts.buildOne(resource);completed++;
     if(orderCount>31&&completed%250===0)console.log('JOURNEY_SCALE_SETUP '+JSON.stringify({phase:'build',completed,total:resources.length}));}
   }));for(const worker of workers)if(worker.status==='rejected')throw worker.reason;}
  const corruptProjection=async(id:string)=>{assert(indexed&&orders.includes(id));await db.query("UPDATE digital_journey_fact_models SET selection_fingerprint=repeat('0',64) WHERE resource_id=$1",[id]);};
  const repairProjection=async(id:string)=>{assert(indexed&&orders.includes(id));await facts.buildOne({kind:'order',id});};
  if(indexed){factRuntime=new JourneyFactRuntime(new JourneyFactUpdates(db,facts),{warn:(_value,message)=>{errors.push(message);}});factRuntime.start();}
  await app.ready();let html:string;
  if(productionAssets){
   // Real production main/App/module graph, rather than an inlined IIFE fixture.
   // The same native AuthService and guarded business API transport remain below.
   // Vitest itself needs NODE_ENV=test; Vite's client export conditions must
   // still match npm's real production build (including production React).
   const originalNodeEnv=process.env.NODE_ENV;
   try{process.env.NODE_ENV='production';await build({root:productionRoot,configFile:join(productionRoot,'vite.config.ts'),mode:'production',base:'/',build:{outDir:out,emptyOutDir:true,manifest:true}});}
   finally{if(originalNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=originalNodeEnv;}
   html=await readFile(join(out,'index.html'),'utf8');assetManifest=JSON.parse(await readFile(join(out,'.vite/manifest.json'),'utf8'));
  }else{
   await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/m01-cockpit-home-native-ui.tsx'),name:'NativeCockpitHomeUi',formats:['iife']}}});
   const files=await readdir(out),js=await readFile(join(out,files.find(file=>file.endsWith('.js'))!),'utf8'),css=await readFile(join(out,files.find(file=>file.endsWith('.css'))!),'utf8');html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
  }
  // inject() is lazy: the new original sourcing/production APIs must start
  // inside their native TEST clock, like the existing calendar path.
  // Retain the older home-read context for its established legacy consumers.
  const runHttp=(work:()=>ReturnType<typeof app.inject>,native=false)=>calendar||native?fixture.runtime.run(scene,fixture.root,async()=>await work()):fixture.runtime.run(scene,fixture.root,work);
  const calendarGrants=new Map<string,{key:string;expiresAt:string}>();
  if(calendar||photos){const original=fixture.storage.createDownloadGrant.bind(fixture.storage);fixture.storage.createDownloadGrant=async(key,options)=>{const grant=await original(key,options),id=randomUUID();calendarGrants.set(id,{key,expiresAt:grant.expiresAt});return {...grant,downloadUrl:base+'/api/__calendar-test-storage/'+id};};}
  server=createServer(async(request,response)=>{try{const path=request.url??'/';if(productionAssets&&path.startsWith('/assets/')){const pathname=new URL(path,'http://native-test.invalid').pathname;if(!/^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname)){response.writeHead(400);response.end();return;}let bytes:Buffer;try{bytes=await readFile(join(out,pathname.slice(1)));}catch{response.writeHead(404);response.end();return;}resources.push({path:pathname,bytes:bytes.length});const mime:Record<string,string>={'.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf'};response.writeHead(200,{'content-type':mime[extname(pathname)]??'application/octet-stream','content-length':bytes.length,'cache-control':'public,max-age=31536000,immutable'});response.end(bytes);return;}if((calendar||photos)&&path.startsWith('/api/__calendar-test-storage/')){const grant=calendarGrants.get(path.slice('/api/__calendar-test-storage/'.length));if(!grant||Date.parse(grant.expiresAt)<=Date.now()){response.writeHead(403);response.end();return;}const metadata=await fixture.storage.head(grant.key),bytes=await fixture.storage.readBytes(grant.key,1000000);servedImages.push({key:grant.key,bytes:bytes.byteLength,mimeType:metadata.mimeType});response.writeHead(200,{'content-type':metadata.mimeType,'cache-control':'no-store'});response.end(Buffer.from(bytes));return;}if(!path.startsWith('/api/')){response.setHeader('content-type','text/html;charset=utf-8');response.end(html);return;}const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const payload=Buffer.concat(chunks),result=await runHttp(()=>app.inject({method:(request.method??'GET') as 'GET'|'POST',url:path.slice(4),headers:{cookie:request.headers.cookie??'',...(typeof request.headers['idempotency-key']==='string'?{'idempotency-key':request.headers['idempotency-key']}:{}),...(payload.length?{'content-type':'application/json'}:{})},...(payload.length?{payload}:{})}),/^\/api\/(?:sourcing|production-dashboard|production-reporting)(?:\/|\?|$)/.test(path));requests.push({path,status:result.statusCode});response.writeHead(result.statusCode,{'content-type':result.headers['content-type']??'application/json','cache-control':'no-store',...((calendar||photos)&&result.headers.location?{location:result.headers.location}:{}),...(result.headers['x-dx-rework-actor-id']?{'x-dx-rework-actor-id':result.headers['x-dx-rework-actor-id']}:{})});response.end(result.rawPayload);}catch(error){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'TEST_HOME_HTTP',message:(error as Error).message}}));}});
  await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,{chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??'playwright-core');browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
  const requireShortage=()=>{assert(shortage,'Shortage fixture requires the home profile');return shortage;};
  const calendarChangedDates=()=>fixture.runtime.run(scene,fixture.root,async()=>{const shortage=requireShortage(),second=await prepareShortage(),baseDate=shortage.lines[0]!.customerWarehouseArrivalDate!,selectedDate=addCalendarDays(baseDate,2),dates=new PoCustomerDateService(db);for(const [order,date]of [[shortage,selectedDate],[second,addCalendarDays(baseDate,1)]] as const){const current=await identity.read(fixture.root,order.productionOrderId),sheet=await dates.read(fixture.root,order.productionOrderId),line=sheet.customerPoDates[0]!,request=await dates.request(fixture.root,order.productionOrderId,{orderVersion:current.version,reason:'TEST calendar selected-day history separate from side debt list',changes:[{lineId:line.lineId,expectedVersion:line.version,date}]},randomUUID());await dates.decide(fixture.root,order.productionOrderId,request.requestId,true,randomUUID());}return {selectedDate,primaryId:shortage.productionOrderId,secondId:second.productionOrderId};});
  const path=(extra:Record<string,string>={})=>'/ui/digital-cockpit?'+new URLSearchParams({scope:'production',search:prefix,...extra}),open=async(id=f!.root.actorId,extra:Record<string,string>={},width=1584,scale=1)=>{const context=await browser!.newContext({viewport:{width:Math.round(width/scale),height:Math.round(1003/scale)},deviceScaleFactor:scale});await context.addCookies([{name:'dx_rework_session',value:await login(id),url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base+path(extra));if(extra.workspace==='delivery')await page.locator('.delivery-calendar[aria-busy="false"]').waitFor();else if(fixtureProfile==='navigation'){
   // A completed, genuinely empty native home is valid here. Do not weaken
   // homeReady(), fabricate rows, or accept a loading/error state as ready.
   await page.locator('.digital-journey-cockpit[data-view="overview"][aria-busy="false"]').waitFor();
   await page.getByText('当前授权和筛选范围没有订单。',{exact:true}).waitFor();
   const result=await read(page,extra);assert.equal(result.total,0);assert.equal(result.items.length,0);assert.equal(result.freshness,undefined);
   assert.equal(await page.locator('.journey-orders tbody tr').count(),0);
  }else await homeReady(page);return {context,page};};
  const read=async(page:Page,extra:Record<string,string>={})=>{const response=await page.request.get(base+'/api/digital-production/journeys?'+new URLSearchParams({scope:'production',search:prefix,...extra}));assert.equal(response.status(),200,await response.text());return response.json() as Promise<JourneyResult>;};
  const measureScale=async()=>{
   assert(indexed);await factRuntime?.stop();
   const baseline=Fastify(),token=await login(fixture.root.actorId),cookie=`dx_rework_session=${token}`,query='/digital-production/journeys?'+new URLSearchParams({scope:'production',search:prefix});
   registerDigitalIdentityRoutes(baseline,{service:identity,creationEnabled:true,root,authenticate:token=>auth.authenticate(token),journeys:new DigitalJourneyQuery(db,{listReadMode:'legacy'})});
   await baseline.ready();
   let tracing=false,calls=0,sqlMs=0,poolMs=0;
   const seen=new WeakSet<PoolClient>(),connect=db.connect;
   const costs=new Map<string,{signature:string;template:string;calls:number;aggregateMs:number;maximumMs:number}>();
   let selectionQuery:{text:string;values:unknown[]}|undefined;
   const instrument=(client:PoolClient)=>{
    if(seen.has(client))return;seen.add(client);const original=client.query;
    client.query=function(this:PoolClient,...args:unknown[]){
     if(!tracing)return Reflect.apply(original,this,args);calls++;const start=performance.now();let ended=false;
     const text=typeof args[0]==='string'?args[0]:String((args[0] as {text?:unknown})?.text??'');
     const signature=createHash('sha256').update(text).digest('hex'),cost=costs.get(signature)??{signature,template:text.replace(/\s+/g,' ').slice(0,120),calls:0,aggregateMs:0,maximumMs:0};costs.set(signature,cost);
     if(text.includes('native AS MATERIALIZED')&&text.includes('selection_full_json')&&Array.isArray(args[1]))selectionQuery={text,values:args[1]};
     const end=()=>{if(!ended){const elapsed=performance.now()-start;sqlMs+=elapsed;cost.calls++;cost.aggregateMs+=elapsed;cost.maximumMs=Math.max(cost.maximumMs,elapsed);ended=true;}};
     const callback=args.at(-1);if(typeof callback==='function')args[args.length-1]=function(this:unknown,...values:unknown[]){end();return Reflect.apply(callback,this,values);};
     try{const value=Reflect.apply(original,this,args);if(typeof callback==='function')return value;
      if(value&&typeof value.then==='function')return value.then((result:unknown)=>{end();return result;},(error:unknown)=>{end();throw error;});end();return value;
     }catch(error){end();throw error;}
    } as PoolClient['query'];
   };
   db.connect=function(this:typeof db,callback?:(...args:unknown[])=>unknown){const start=performance.now(),timed=tracing;
    if(callback)return Reflect.apply(connect,this,[function(this:unknown,error:unknown,client:PoolClient|undefined,release:unknown){if(timed)poolMs+=performance.now()-start;if(client)instrument(client);return Reflect.apply(callback,this,[error,client,release]);}]);
    return Reflect.apply(connect,this,[]).then((client:PoolClient)=>{if(timed)poolMs+=performance.now()-start;instrument(client);return client;});
   } as typeof db.connect;
   const normalize=(value:unknown):unknown=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='asOf').sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,normalize(value)])):value;
   let reference='';
   const sample=async(target:typeof app)=>{calls=sqlMs=poolMs=0;costs.clear();tracing=true;const started=performance.now();
    try{const response=await target.inject({url:query,headers:{cookie}});const elapsed=performance.now()-started;tracing=false;assert.equal(response.statusCode,200,response.body);
     const body=response.json() as JourneyResult;assert.equal(body.total,orderCount);assert.equal(body.items.length,15);assert.equal(body.freshness,undefined);
     const comparable=JSON.stringify(normalize(body));if(reference&&comparable!==reference){await writeFile(join(evidence,'scale-difference.json'),JSON.stringify({expected:JSON.parse(reference),actual:JSON.parse(comparable)},null,2));assert.equal(createHash('sha256').update(comparable).digest('hex'),createHash('sha256').update(reference).digest('hex'),'Full normalized native result mismatch; exact TEST-only values saved in scale-difference.json');}else if(!reference)reference=comparable;
     return {requestMs:elapsed,physicalSqlCalls:calls,sqlAggregateMs:sqlMs,poolWaitAggregateMs:poolMs,responseBytes:Buffer.byteLength(response.body),pageNativeSourceMothers:body.items.filter(item=>item.sourceId).length,completeResultHash:createHash('sha256').update(comparable).digest('hex'),topSql:[...costs.values()].sort((a,b)=>b.aggregateMs-a.aggregateMs).slice(0,8)};
    }finally{tracing=false;}
   };
   try{
    const old=[await sample(baseline)];if(old[0]!.requestMs<10000){old.push(await sample(baseline),await sample(baseline));}
    const current=[];for(let i=0;i<7;i++)current.push(await sample(app));
    const sorted=current.map(value=>value.requestMs).sort((a,b)=>a-b),result={fixtureOrders:orderCount,poPerOrder:`2; first mother3;${includeNative?3:0} actual development/procurement/preparation craft mothers; one additional actual receiving mother outside search`,
     scope:'Owned TEST PostgreSQL and real AuthService/Fastify serialization, loopback app.inject; no TCP/site/compression equivalence. Same native data, clock, identity, scope and query; no user DTO or permission result cache. SQL aggregate/pool waits can overlap and are not wall time.',
     sourceFingerprint:process.env.DX_JOURNEY_SCALE_SOURCE??null,baseline:old,indexed:current,indexedMedianMs:sorted[Math.floor(sorted.length/2)],indexedSampleMaximumMs:sorted.at(-1),
     baselineLimit:old.length===1?'Expensive baseline measured once (>10 seconds); deterministic full-result/SQL comparison, not a robust latency percentile.':'3 same-condition baseline observations;7 indexed observations; no P95 claim.'};
    await writeFile(join(evidence,'native-scale-comparison.json'),JSON.stringify(result,null,2)+'\n');console.log('JOURNEY_SCALE_RESULT '+JSON.stringify(result));
    if(selectionQuery&&result.indexedMedianMs>(orderCount===5000?1500:1000)){
     // Diagnose the actual owned TEST-only read after all timed observations.
     // Never EXPLAIN a mutation, live data or a background builder.
     const client=await db.connect();try{await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='90s'");
      const plan=await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+selectionQuery.text,selectionQuery.values);
      const redact=(value:unknown):unknown=>Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redact(item)])):typeof value==='string'&&value.length>300?{omittedBytes:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')}:value;
      await writeFile(join(evidence,'selection-explain.json'),JSON.stringify({scope:'Same owned TEST read after latency measurement; large literals omitted, no onsite statement',plan:redact(plan.rows)},null,2)+'\n');await client.query('COMMIT');
     }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    return result;
   }finally{db.connect=connect;await baseline.close();factRuntime?.start();}
  };
  return {fixture,scene,runInScene:<T,>(work:()=>Promise<T>)=>fixture.runtime.run(scene,fixture.root,work),dispose,open,read,evidence,orders,prefix,photo,servedImages,pmcId,get shortage(){return requireShortage();},errors,path,base,auth,resources,assetManifest,corruptProjection,repairProjection,measureScale,updateCalendarPacking,calendarChangedDates,revokePmc:()=>fixture.access.revokeRole(rootAccess,pmcGrant.assignmentId,'TEST live original home role revocation'),hash:(value:string)=>createHash('sha256').update(value).digest('hex')};
 }catch(error){await dispose();throw error;}
}
export async function homeReady(page:Page){await page.locator('.digital-journey-cockpit[data-view="overview"][aria-busy="false"]').waitFor();await page.locator('.journey-orders[aria-busy="false"]').waitFor();await page.locator('.journey-orders tbody tr').first().waitFor();}
export async function coverageReady(page:Page){
 // The CI worker shares two bounded PG browser jobs. Waiting for an actual
 // completed drill-down may exceed the generic12s locator budget; this does
 // not relax the independent SQL/latency or correctness test limits.
 try{await page.locator('.cockpit-coverage-orders[aria-busy="false"]').waitFor({timeout:30000});await page.locator('.cockpit-coverage-order-list').waitFor();}
 catch(error){console.error('COVERAGE_WAIT_STATE',await page.locator('.cockpit-coverage-orders').innerText().catch(()=> 'coverage panel unavailable'));throw error;}
 finally{console.log('COVERAGE_READ_TIMINGS',JSON.stringify(await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/digital-production/journeys?')&&entry.name.includes('missing=')).map(entry=>({path:new URL(entry.name).pathname+new URL(entry.name).search,durationMs:Math.round(entry.duration)})))));}
}
export {JOURNEY_COVERAGE_KEYS};
