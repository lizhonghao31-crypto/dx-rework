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
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {Browser,Page,chromium as Chromium} from 'playwright-core';
import Fastify from 'fastify';
import {build} from 'vite';
import {AuthService,AuthDeniedError} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {registerAuthRoutes} from '../../apps/api/src/auth/routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import type {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {JOURNEY_COVERAGE_KEYS,type JourneyResult} from '@dx-rework/contracts/digital-production-journey';

/** Full original App/Shell, original signed auth and marked, owned PostgreSQL.
 * All objects are TEST fixtures, not Acceptance site or customer business data. */
export async function cockpitHomeBrowser({databaseUrl,evidence,executablePath,calendar=false}:{databaseUrl:string;evidence:string;executablePath?:string;calendar?:boolean}){
 const out=await mkdtemp(join(tmpdir(),'dx-m01-home-')),app=Fastify(),errors:string[]=[],requests:Array<{path:string;status:number}>=[];
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>|undefined,browser:Browser|undefined,server:Server|undefined;
 const dispose=async()=>{
  try{await mkdir(evidence,{recursive:true});if(browser)for(const [i,page]of browser.contexts().flatMap(c=>c.pages()).entries())await writeFile(join(evidence,`last-page-${i}.txt`),await page.locator('body').innerText().catch(()=>''));await writeFile(join(evidence,'requests.json'),JSON.stringify({requests,errors},null,2));}
  finally{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}await app.close();await f?.dispose();await rm(out,{recursive:true,force:true});}
 };
 try{
  f=await businessAnchorFixture(databaseUrl);const fixture=f,db=f.db,identity=new DigitalProductionIdentityService(db,true),secret='TEST original home browser signed authentication '.repeat(3),root=new RootAuthority(db,'anchor-test','uat-root'),auth=new AuthService(new AcceptanceDingTalkProvider(db,'anchor-test',secret),new PostgresAuthStore(db,'anchor-test','uat-root'),'anchor-test',3600000,secret);
  registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:'/',corpId:'anchor-test',mobileClientId:'TEST',webClientId:'TEST',qrRedirectUri:'https://acceptance.invalid/auth/qr/callback',isRootUser:id=>root.isRootUser(id)});
  app.setErrorHandler((error,_request,reply)=>{const value=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:value.statusCode??500).send({error:{code:value.code,message:value.message}});});
  registerDigitalIdentityRoutes(app,{service:identity,creationEnabled:true,root,authenticate:token=>auth.authenticate(token),qcProgress:new QcProductionProgressService(db),factoryFlowService:new FactoryFlowService(db),closureService:new OrderClosureService(db),quotationService:new DigitalQuotationService(db,true),developmentRounds:new DevelopmentRoundService(db,true),notificationService:new DigitalProductionNotificationService(db),taskService:new DigitalProductionTaskService(db),accessService:new DigitalProductionAccessService(db),developmentService:new DigitalDevelopmentService(db,true),developmentExecution:new DevelopmentExecutionService(db,true),developmentAttachments:f.attachments,budgetService:new DigitalBudgetService(db,true),instructionService:new ProductionInstructionService(db,true),bulkPreparationService:new BulkPreparationService(db),journeys:new DigitalJourneyQuery(db),...(calendar?{deliveryCalendar:new DeliveryCalendarQuery(db)}:{})});
  // The unrelated navigation badge is a labelled TEST adapter, still authenticated.
  app.get('/todos/mine/indicator',async(request,reply)=>{const token=request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18),user=await auth.authenticate(token);reply.header('x-dx-rework-actor-id',user.id);return {pendingCount:0,unreadCount:0};});
  const prefix='TEST-R3-HOME-',scene=await f.scene('2026-08-01T00:00:00Z'),orders:string[]=[];
  await f.runtime.run(scene,f.root,async()=>{for(let i=0;i<31;i++)orders.push((await identity.createOrder(fixture.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:prefix+String(i+1).padStart(2,'0'),orderDate:'2026-08-01',primaryMerchandiserId:fixture.people.merchandiser!.actorId,lines:Array.from({length:i===0?3:2},(_,j)=>({formalPoNo:`TEST-PO-${i+1}-${j+1}${i===0?'-LONG-'.repeat(7):''}`,color:['黑','浅蓝','白'][j],customerWarehouseArrivalDate:`2026-10-0${j+1}`,sizes:[{size:'M',quantity:100+j}]}))}),randomUUID())).productionOrderId);});
  await f.advance(scene,'2026-11-07T00:00:00Z');
  // Original cutting/receiving/packing commands establish real visible receipt debt.
  let updateCalendarPacking:((quantity:number)=>Promise<void>)|undefined;
  const prepareShortage=async()=>{
   const ready=await fixture.bulkReady('无',undefined,1,fixture.sourcing,{quantity:4}),cut=(await db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0],cutter={...fixture.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:4,attachmentIds:[await fixture.image(cutter)]},randomUUID());
  const receiving=new ReceivingService(db),warehouse={...fixture.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receipt=(await receiving.create(warehouse,{cuttingOrderId:cut.cutting_order_id,documentQuantity:2,actualQuantity:2,attachmentIds:[await fixture.image(warehouse)]},randomUUID())).value,day=beijingCalendarDate(businessNow()),batch=(await receiving.board(day,day,'','all',1,15,receipt.receivingBatchId)).rows.find(row=>row.receivingBatchId===receipt.receivingBatchId)!;
  await receiving.recordPacking({...fixture.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:receipt.receivingBatchId,expectedVersion:batch.version,expectedPackingRevisionId:batch.packingRevisionId,packingQuantity:2},randomUUID());
  if(calendar)updateCalendarPacking=async quantity=>{await fixture.runtime.run(scene,fixture.root,async()=>{const current=(await receiving.board(day,day,'','all',1,15,receipt.receivingBatchId)).rows.find(row=>row.receivingBatchId===receipt.receivingBatchId)!;await receiving.recordPacking({...fixture.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:receipt.receivingBatchId,expectedVersion:current.version,expectedPackingRevisionId:current.packingRevisionId,packingQuantity:quantity},randomUUID());});};return identity.read(fixture.root,ready.id);
  };
  const shortage=calendar?await f.runtime.run(scene,fixture.root,prepareShortage):await prepareShortage(),rootAccess={...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin']},pmcId=randomUUID();
  await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[pmcId,'TEST dedicated home PMC']);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)",[randomUUID(),pmcId,'uat-home-'+pmcId,'uat-union-home-'+pmcId]);
  const pmcGrant=await f.access.assignRole(rootAccess,{userId:pmcId,roleCode:'pmc',reason:'TEST home drill dedicated original PMC'});await f.access.assignRole(rootAccess,{userId:pmcId,roleCode:'finance_read',reason:'TEST keep original signed session valid after PMC revocation'});
  let loginIndex=0;const login=async(id:string)=>{const mapping=(await db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND active AND employed",[id])).rows[0],response=await app.inject({method:'POST',url:'/auth/mobile',remoteAddress:`127.0.0.${++loginIndex}`,payload:{code:mintAcceptanceLoginCode(mapping.provider_user_id.slice(4),secret)}});assert.equal(response.statusCode,200,response.body);const headers=response.headers['set-cookie'],token=(Array.isArray(headers)?headers[0]:headers)!.split(';',1)[0]!.slice('dx_rework_session='.length);assert.equal((await auth.authenticate(token)).id,id);return token;};
  await app.ready();await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/m01-cockpit-home-native-ui.tsx'),name:'NativeCockpitHomeUi',formats:['iife']}}});
  const files=await readdir(out),js=await readFile(join(out,files.find(file=>file.endsWith('.js'))!),'utf8'),css=await readFile(join(out,files.find(file=>file.endsWith('.css'))!),'utf8'),html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
  // inject() is lazy: calendar reads must begin inside the guarded clock context.
  // Retain the older home harness path for its existing non-calendar consumers.
  const runHttp=(work:()=>ReturnType<typeof app.inject>)=>calendar?fixture.runtime.run(scene,fixture.root,async()=>await work()):fixture.runtime.run(scene,fixture.root,work);
  const calendarGrants=new Map<string,{key:string;expiresAt:string}>();
  if(calendar){const original=fixture.storage.createDownloadGrant.bind(fixture.storage);fixture.storage.createDownloadGrant=async(key,options)=>{const grant=await original(key,options),id=randomUUID();calendarGrants.set(id,{key,expiresAt:grant.expiresAt});return {...grant,downloadUrl:base+'/api/__calendar-test-storage/'+id};};}
  server=createServer(async(request,response)=>{try{const path=request.url??'/';if(calendar&&path.startsWith('/api/__calendar-test-storage/')){const grant=calendarGrants.get(path.slice('/api/__calendar-test-storage/'.length));if(!grant||Date.parse(grant.expiresAt)<=Date.now()){response.writeHead(403);response.end();return;}const metadata=await fixture.storage.head(grant.key),bytes=await fixture.storage.readBytes(grant.key,1000000);response.writeHead(200,{'content-type':metadata.mimeType,'cache-control':'no-store'});response.end(Buffer.from(bytes));return;}if(!path.startsWith('/api/')){response.setHeader('content-type','text/html;charset=utf-8');response.end(html);return;}const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const payload=Buffer.concat(chunks),result=await runHttp(()=>app.inject({method:(request.method??'GET') as 'GET'|'POST',url:path.slice(4),headers:{cookie:request.headers.cookie??'',...(payload.length?{'content-type':'application/json'}:{})},...(payload.length?{payload}:{})}));requests.push({path,status:result.statusCode});response.writeHead(result.statusCode,{'content-type':result.headers['content-type']??'application/json','cache-control':'no-store',...(calendar&&result.headers.location?{location:result.headers.location}:{}),...(result.headers['x-dx-rework-actor-id']?{'x-dx-rework-actor-id':result.headers['x-dx-rework-actor-id']}:{})});response.end(result.rawPayload);}catch(error){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'TEST_HOME_HTTP',message:(error as Error).message}}));}});
  await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,{chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??'playwright-core');browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
  const path=(extra:Record<string,string>={})=>'/ui/digital-cockpit?'+new URLSearchParams({scope:'production',search:prefix,...extra}),open=async(id=f!.root.actorId,extra:Record<string,string>={},width=1584,scale=1)=>{const context=await browser!.newContext({viewport:{width:Math.round(width/scale),height:Math.round(1003/scale)},deviceScaleFactor:scale});await context.addCookies([{name:'dx_rework_session',value:await login(id),url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base+path(extra));if(extra.workspace==='delivery')await page.locator('.delivery-calendar[aria-busy="false"]').waitFor();else await homeReady(page);return {context,page};};
  const read=async(page:Page,extra:Record<string,string>={})=>{const response=await page.request.get(base+'/api/digital-production/journeys?'+new URLSearchParams({scope:'production',search:prefix,...extra}));assert.equal(response.status(),200,await response.text());return response.json() as Promise<JourneyResult>;};
  return {dispose,open,read,evidence,orders,prefix,pmcId,shortage,errors,path,base,auth,updateCalendarPacking,revokePmc:()=>fixture.access.revokeRole(rootAccess,pmcGrant.assignmentId,'TEST live original home role revocation'),hash:(value:string)=>createHash('sha256').update(value).digest('hex')};
 }catch(error){await dispose();throw error;}
}
export async function homeReady(page:Page){await page.locator('.digital-journey-cockpit[data-view="overview"][aria-busy="false"]').waitFor();await page.locator('.journey-orders[aria-busy="false"]').waitFor();await page.locator('.journey-orders tbody tr').first().waitFor();}
export async function coverageReady(page:Page){await page.locator('.cockpit-coverage-orders[aria-busy="false"]').waitFor();await page.locator('.cockpit-coverage-order-list').waitFor();}
export {JOURNEY_COVERAGE_KEYS};
