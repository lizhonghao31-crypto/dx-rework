import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {unzipSync} from 'fflate';
import Fastify from 'fastify';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {AuthService,AuthDeniedError} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {registerAuthRoutes} from '../../apps/api/src/auth/routes.js';
import {businessActor} from '../../apps/api/src/access/business-authority.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {GarmentQualityService} from '../../apps/api/src/production-platform/garment-quality.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {WholeOrderReviewService} from '../../apps/api/src/rework/whole-order-review-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {DigitalAnalysisQuery} from '../../apps/api/src/production-platform/reporting-query.js';
import {AnalysisResultStore} from '../../apps/api/src/production-platform/analysis-result-store.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {registerDigitalAnalysisRoutes} from '../../apps/api/src/production-platform/reporting-routes.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {factoryProductionScopes} from '../../apps/api/src/production-platform/factory-production-facts.js';
import {addCalendarDays} from '@dx-rework/contracts/series-calendar';
import type {ProductionStatisticsResponse} from '@dx-rework/contracts/production-statistics';
import type {ApplicationError} from '../../apps/api/src/platform/errors.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('M01 production original authenticated PostgreSQL and immutable query result',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,query:DigitalAnalysisQuery,identity:DigitalProductionIdentityService;
 const app=Fastify(),secret='TEST production statistics original signed authentication '.repeat(3);
 const today=()=>beijingCalendarDate(new Date()),filters=()=>DigitalAnalysisFilterSchema.parse({from:today(),to:today(),view:'production'});
 let auth:AuthService,loginIndex=0;
 const login=async(actorId:string)=>{
  const mapping=(await f.db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND corp_id='anchor-test' AND active AND employed",[actorId])).rows[0];
  const response=await app.inject({method:'POST',url:'/auth/mobile',remoteAddress:`127.0.0.${++loginIndex}`,payload:{code:mintAcceptanceLoginCode(mapping.provider_user_id.slice(4),secret)}});expect(response.statusCode).toBe(200);
  const headers=response.headers['set-cookie'],cookie=(Array.isArray(headers)?headers[0]:headers)!.split(';',1)[0]!;expect((await auth.authenticate(cookie.slice('dx_rework_session='.length))).id).toBe(actorId);return cookie;
 };
 const path=(extra:Record<string,string>={})=>'/digital-production/analysis?'+new URLSearchParams({from:today(),to:today(),view:'production',...extra});
 const dedicated=async(roles:string[])=>{
  const actorId=randomUUID();await f.db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[actorId,'TEST production scope '+actorId]);
  await f.db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)",[randomUUID(),actorId,`uat-production-${actorId}`,`uat-union-production-${actorId}`]);
  const root={...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin','master_data:manage']},grants=[];
  for(const roleCode of roles)grants.push(await f.access.assignRole(root,{userId:actorId,roleCode,reason:'TEST dedicated scope and same-session revoke'}));return {actorId,grants,root};
 };
 const make=async(label:string,primaryMerchandiserId:string)=>identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-STATS-'+label+'-'+randomUUID(),orderDate:today(),primaryMerchandiserId,lines:[{formalPoNo:'TEST-PO-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:addCalendarDays(today(),60),sizes:[{size:'M',quantity:100}]}]}),randomUUID());
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);query=new DigitalAnalysisQuery(f.db);identity=new DigitalProductionIdentityService(f.db,true);const root=new RootAuthority(f.db,'anchor-test','uat-root');
  auth=new AuthService(new AcceptanceDingTalkProvider(f.db,'anchor-test',secret),new PostgresAuthStore(f.db,'anchor-test','uat-root'),'anchor-test',3600000,secret);
  registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:'/',corpId:'anchor-test',mobileClientId:'TEST',webClientId:'TEST',qrRedirectUri:'https://acceptance.invalid/auth/qr/callback',isRootUser:id=>root.isRootUser(id)});
  app.setErrorHandler((error,_request,reply)=>{const value=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:value.statusCode??500).send({error:{code:value.code,message:value.message}});});
  registerDigitalAnalysisRoutes(app,{service:identity,creationEnabled:true,root,authenticate:token=>auth.authenticate(token)},query);await app.ready();
 });
 afterAll(async()=>{await app.close();await f?.dispose();});
 it('denies a real worker without report permission and keeps current production notes read-only',async()=>{
  const worker=await login(f.people['cutting-worker']!.actorId),denied=await app.inject({url:path(),headers:{cookie:worker}});expect(denied.statusCode).toBe(403);expect(denied.body).not.toContain('snapshotId');
  const cookie=await login(f.root.actorId),count=async()=>Number((await f.db.query("SELECT count(*) FROM audit_events WHERE action='digital.analysis.recorded'")).rows[0].count),before=await count();
  const note=await app.inject({method:'POST',url:'/digital-production/analysis/notes',headers:{cookie,'idempotency-key':randomUUID()},payload:{filters:filters(),conclusion:'TEST readonly',action:'TEST no write',observeAt:new Date().toISOString(),taskIds:[randomUUID()]}});expect(note.statusCode).toBe(400);expect(await count()).toBe(before);
 });
 it('authorizes before aggregation, deduplicates actual multi-role scope and rejects the same valid session old result after scope-role removal',async()=>{
  const user=await dedicated(['finance_read','order_merchandiser','sample_designer']),visible=await make('VISIBLE',user.actorId),hidden=await make('HIDDEN',f.people.merchandiser!.actorId),cookie=await login(user.actorId),response=await app.inject({url:path(),headers:{cookie}});expect(response.statusCode).toBe(200);
  const result=response.json<ProductionStatisticsResponse>();expect([result.result.metrics.orders.value,result.result.metrics.pos.value,result.result.metrics.demand.value]).toEqual([1,1,100]);expect(result.result.rows.map(row=>row.line.orderId)).toEqual([visible.productionOrderId]);expect(JSON.stringify(result)).not.toContain(hidden.productionOrderId);expect(result.result.rows[0]!.line.designerId).toBeNull();expect(result.canExport).toBe(false);
  const deniedExport=await app.inject({url:path({snapshotId:result.snapshotId}).replace('/analysis?','/analysis/export?'),headers:{cookie}});expect(deniedExport.statusCode).toBe(403);
  await f.access.revokeRole(user.root,user.grants[1]!.assignmentId,'TEST remove scoped technical role but retain report role and login');
  const me=await app.inject({url:'/auth/me',headers:{cookie}});expect(me.statusCode).toBe(200);expect(me.json().status).toBe('authorized');
  const denied=await app.inject({url:path({snapshotId:result.snapshotId}),headers:{cookie}});expect([403,404,409]).toContain(denied.statusCode);expect(denied.body).not.toContain(visible.productionOrderId);expect(denied.body).not.toContain(hidden.productionOrderId);
 });
 it('keeps complete aggregate values across original15-row pages and refuses an unbound second-page read',async()=>{
  const user=await dedicated(['finance_read','order_merchandiser']),made=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-STATS-PAGES-'+randomUUID(),orderDate:today(),primaryMerchandiserId:user.actorId,lines:Array.from({length:16},(_,index)=>({formalPoNo:'TEST-PAGE-'+index+'-'+randomUUID(),color:'TEST色'+index,customerWarehouseArrivalDate:addCalendarDays(today(),60),sizes:[{size:'M',quantity:2}]}))}),randomUUID()),cookie=await login(user.actorId),first=(await app.inject({url:path(),headers:{cookie}})).json<ProductionStatisticsResponse>();
  expect(first.total).toBe(16);expect(first.result.rows).toHaveLength(15);expect(first.result.metrics.demand.value).toBe(32);expect(first.result.metrics.orders.value).toBe(1);
  const second=await app.inject({url:path({snapshotId:first.snapshotId,page:'2'}),headers:{cookie}});expect(second.statusCode).toBe(200);const value=second.json<ProductionStatisticsResponse>();expect(value.result.rows).toHaveLength(1);expect(value.watermark).toBe(first.watermark);expect(value.result.metrics).toEqual(first.result.metrics);expect(new Set([...first.result.rows,...value.result.rows].map(row=>row.line.lineId)).size).toBe(16);expect(value.result.rows[0]!.line.orderId).toBe(made.productionOrderId);
  expect((await app.inject({url:path({page:'2'}),headers:{cookie}})).statusCode).toBe(409);
  const drill=await app.inject({url:path({snapshotId:first.snapshotId,drillLineId:made.lines[15]!.lineId}),headers:{cookie}});expect(drill.statusCode).toBe(200);const detail=drill.json<ProductionStatisticsResponse>();expect([detail.total,detail.result.metrics.demand.value,detail.basis.metrics.demand.value,detail.basis.total]).toEqual([1,2,32,16]);expect(detail.snapshotId).toBe(first.snapshotId);expect(detail.watermark).toBe(first.watermark);expect(detail.result.asOf).toBe(first.result.asOf);
  const outside=await app.inject({url:path({snapshotId:first.snapshotId,drillLineId:randomUUID()}),headers:{cookie}});expect(outside.statusCode).toBe(200);expect(outside.json<ProductionStatisticsResponse>().total).toBe(0);
  expect((await app.inject({url:path({snapshotId:first.snapshotId,lineId:made.lines[15]!.lineId}),headers:{cookie}})).statusCode).toBe(409);
 });
 it('allows original PMC read and full-result export but rejects its old result and download after a real same-session role revocation',async()=>{
  const user=await dedicated(['pmc','finance_read']),cookie=await login(user.actorId),first=await app.inject({url:path(),headers:{cookie}});expect(first.statusCode).toBe(200);const result=first.json<ProductionStatisticsResponse>();expect(result.canExport).toBe(true);
  const exportPath=path({snapshotId:result.snapshotId}).replace('/analysis?','/analysis/export?'),download=await app.inject({url:exportPath,headers:{cookie}});expect(download.statusCode).toBe(200);const sheets=unzipSync(download.rawPayload),xml=Buffer.from(sheets['xl/worksheets/sheet3.xml']!).toString();expect([...xml.matchAll(/<row\s/g)]).toHaveLength(result.total+1);expect(xml).not.toContain('unitPrice');expect(xml).not.toContain('wage');
  await f.access.revokeRole(user.root,user.grants[0]!.assignmentId,'TEST revoke PMC with finance read login retained');expect((await app.inject({url:'/auth/me',headers:{cookie}})).statusCode).toBe(200);
  expect((await app.inject({url:path({snapshotId:result.snapshotId}),headers:{cookie}})).statusCode).toBe(403);expect((await app.inject({url:exportPath,headers:{cookie}})).statusCode).toBe(403);
 });
 it('keeps two real mothers approved to the same factory separated by original overlapping designer and primary-merchandiser permissions',async()=>{
  const user=await dedicated(['finance_read','order_merchandiser','sample_designer']),cookie=await login(user.actorId),original=await auth.authenticate(cookie.slice('dx_rework_session='.length)),root=new RootAuthority(f.db,'anchor-test','uat-root'),designer=await businessActor(root,original,randomUUID(),'pattern_room:orders:create'),primary=await businessActor(root,original,randomUUID(),'sourcing:inquiry:create'),settings=new DigitalProductionAccessService(f.db),old=(await f.db.query("SELECT default_merchandiser_id FROM digital_production_customers WHERE code='PD'")).rows[0].default_merchandiser_id;
  let visible:Awaited<ReturnType<typeof f.bulkReady>>;
  try{await settings.setCustomerDefault(f.root,'PD',user.actorId);visible=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:100,primaryActor:primary,designerActor:designer});}finally{await settings.setCustomerDefault(f.root,'PD',old);}
  const hidden=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:100}),response=await app.inject({url:path({factoryId:f.supplierId}),headers:{cookie}});expect(response.statusCode).toBe(200);const result=response.json<ProductionStatisticsResponse>();expect([result.result.metrics.orders.value,result.result.metrics.pos.value,result.result.metrics.demand.value]).toEqual([1,1,100]);expect(result.result.factories).toHaveLength(1);expect(result.result.factories[0]).toMatchObject({factoryId:f.supplierId,allocated:100,orderIds:[visible!.id]});expect(result.result.rows[0]!.line.designerId).toBe(user.actorId);expect(JSON.stringify(result)).not.toContain(hidden.id);expect(JSON.stringify(result)).not.toContain(hidden.sourceId);
 });
 it('keeps native packing40/60 across S0 page and service-instance reads, while a new complete query shows50/50 after the original Root correction',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:100,accessory:true}),cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0],cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());
  const receiving=new ReceivingService(f.db),receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receipt=(await receiving.create(receiver,{cuttingOrderId:cut.cutting_order_id,documentQuantity:100,actualQuantity:100,attachmentIds:[await f.image(receiver)]},randomUUID())).value;
  const quality=(await new OrderClosureService(f.db).read(f.root,ready.id)).quality!.find(row=>row.receiptId===receipt.receiptId)!;
  await new GarmentQualityService(f.db).record(f.root,ready.id,{receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,occurredAt:new Date().toISOString(),qualifiedQuantity:100,problem:''},randomUUID());
  const packingActor={...f.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},current=async()=>{const row=(await receiving.board(today(),today(),'', 'all',1,15,receipt.receivingBatchId)).rows.find(row=>row.receivingBatchId===receipt.receivingBatchId)!;expect(row).toBeDefined();return {receivingBatchId:receipt.receivingBatchId,expectedVersion:row.version,expectedPackingRevisionId:row.packingRevisionId};};
  await receiving.recordPacking(packingActor,{...await current(),packingQuantity:40},randomUUID());const po=(await identity.read(f.root,ready.id)).lines[0]!,applied={...filters(),lineId:po.lineId},s0=await query.production(f.root,applied);expect([s0.result.metrics.packed.value,s0.result.metrics.remaining.value]).toEqual([40,60]);
  const cookie=await login(f.root.actorId),http0=await app.inject({url:path({lineId:po.lineId}),headers:{cookie}});expect(http0.statusCode).toBe(200);const httpS0=http0.json<ProductionStatisticsResponse>();expect([httpS0.result.metrics.packed.value,httpS0.result.metrics.remaining.value]).toEqual([40,60]);
  await receiving.recordPacking(packingActor,{...await current(),packingQuantity:50},randomUUID());const other=new DigitalAnalysisQuery(f.db),retained=await other.production(f.root,{...applied,snapshotId:s0.snapshotId}),s1=await other.production(f.root,applied);
  expect([retained.result.metrics.packed.value,retained.result.metrics.remaining.value]).toEqual([40,60]);expect(retained.freshness).toBe('previous-query');expect(retained.watermark).toBe(s0.watermark);expect([s1.result.metrics.packed.value,s1.result.metrics.remaining.value]).toEqual([50,50]);expect(s1.snapshotId).not.toBe(s0.snapshotId);expect(s1.result.rows[0]!.line.packingRevision).not.toBe(s0.result.rows[0]!.line.packingRevision);
  const http1=await app.inject({url:path({lineId:po.lineId}),headers:{cookie}});expect(http1.statusCode).toBe(200);const httpS1=http1.json<ProductionStatisticsResponse>(),eventsBefore=(await f.db.query('SELECT count(*)::int AS n FROM digital_production_task_events')).rows[0].n;
  for(const [snapshotId,packed,remaining]of [[httpS0.snapshotId,40,60],[httpS1.snapshotId,50,50]] as const){const detail=await app.inject({url:path({lineId:po.lineId,snapshotId,drillLineId:po.lineId,drillMetric:'backlog'}),headers:{cookie}});expect(detail.statusCode).toBe(200);expect([detail.json<ProductionStatisticsResponse>().result.metrics.packed.value,detail.json<ProductionStatisticsResponse>().result.metrics.remaining.value]).toEqual([packed,remaining]);const exported=await app.inject({url:path({lineId:po.lineId,snapshotId,drillLineId:po.lineId,drillMetric:'backlog'}).replace('/analysis?','/analysis/export?'),headers:{cookie}});expect(exported.statusCode).toBe(200);const files=unzipSync(exported.rawPayload),sheet=new TextDecoder().decode(files['xl/worksheets/sheet3.xml']);expect(sheet).toContain('<c r="M2" s="1" t="n"><v>'+packed+'</v>');expect(sheet).toContain('<c r="N2" s="1" t="n"><v>'+remaining+'</v>');}
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_production_task_events')).rows[0].n).toBe(eventsBefore);
 });
 it('keeps an unfinished sibling in the whole-mother assessment across original two-PO packing, saved drills, fresh PO filters and XLSX export',async()=>{
  const ready=await f.bulkReady('无',undefined,2,f.sourcing,{quantity:1}),cuts=(await f.db.query('SELECT cutting_order_id,sourcing_line_position FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[ready.caseId])).rows,cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};expect(cuts).toHaveLength(2);
  for(const cut of cuts)await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:1,attachmentIds:[await f.image(cutter)]},randomUUID());
  const receiving=new ReceivingService(f.db),receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},packingActor={...f.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']};
  const pack=async(cuttingOrderId:string)=>{
   const receipt=(await receiving.create(receiver,{cuttingOrderId,documentQuantity:1,actualQuantity:1,attachmentIds:[await f.image(receiver)]},randomUUID())).value,current=(await receiving.board(today(),today(),'', 'all',1,15,receipt.receivingBatchId)).rows.find(row=>row.receivingBatchId===receipt.receivingBatchId)!;
   const quality=(await new OrderClosureService(f.db).read(f.root,ready.id)).quality!.find(row=>row.receiptId===receipt.receiptId)!;
   await new GarmentQualityService(f.db).record(f.root,ready.id,{receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,occurredAt:new Date().toISOString(),qualifiedQuantity:1,problem:''},randomUUID());
   await receiving.recordPacking(packingActor,{receivingBatchId:receipt.receivingBatchId,expectedVersion:current.version,expectedPackingRevisionId:current.packingRevisionId,packingQuantity:1},randomUUID());
  };
  await pack(cuts[0]!.cutting_order_id);
  const lineId=(await identity.read(f.root,ready.id)).lines[0]!.lineId,cookie=await login(f.root.actorId),read=async(extra:Record<string,string>)=>{const response=await app.inject({url:path(extra),headers:{cookie}});expect(response.statusCode,response.body).toBe(200);return response.json<ProductionStatisticsResponse>();},s0=await read({drillOrderId:ready.id});
  expect([s0.result.metrics.completedPos.value,s0.result.metrics.completedOrders.value]).toEqual([1,0]);
  const eventsBefore=(await f.db.query('SELECT count(*)::int AS n FROM digital_production_task_events')).rows[0].n;
  for(const drill of [{drillOrderId:ready.id,drillMetric:'completed'},{drillLineId:lineId}]){
   const extra={snapshotId:s0.snapshotId,...drill},result=await read(extra);expect(result.result.rows).toHaveLength(1);expect([result.result.metrics.completedPos.value,result.result.metrics.completedOrders.value]).toEqual([1,0]);expect(result.watermark).toBe(s0.watermark);
   const exported=await app.inject({url:path(extra).replace('/analysis?','/analysis/export?'),headers:{cookie}});expect(exported.statusCode).toBe(200);const xml=new TextDecoder().decode(unzipSync(exported.rawPayload)['xl/worksheets/sheet2.xml']),row=xml.match(/<row\b[^>]*>[^]*?<\/row>/g)?.find(value=>value.includes('已装齐母单'));expect(row).toBeDefined();expect(row).toMatch(/<c r="B\d+"[^>]*t="n"><v>0<\/v>/);
  }
  expect((await read({lineId})).result.metrics.completedOrders.value).toBe(0);expect((await f.db.query('SELECT count(*)::int AS n FROM digital_production_task_events')).rows[0].n).toBe(eventsBefore);
  await pack(cuts[1]!.cutting_order_id);const s1=await read({drillOrderId:ready.id});expect([s1.result.metrics.completedPos.value,s1.result.metrics.completedOrders.value]).toEqual([2,1]);expect((await read({snapshotId:s0.snapshotId,drillLineId:lineId})).result.metrics.completedOrders.value).toBe(0);
 });
 it('reads actual effective per-process rework corrections without leaking wage fields or claiming distinct garments across rounds',async()=>{
  const {ready,id,work,state,worker,own}=await f.reworkReady(),task=state.tasks.find(task=>task.members.some(member=>member.personId===own))!,report=(await work.submitReport(worker,task.workTaskId,{expectedOrderVersion:state.orderVersion,actualQuantity:1,completedAt:new Date().toISOString()},randomUUID())).value;
  const other=state.tasks.find(row=>row.workTaskId!==task.workTaskId)!,current=await work.list(f.root,id),otherReport=(await work.submitReport(worker,other.workTaskId,{expectedOrderVersion:current.orderVersion,actualQuantity:5,completedAt:new Date().toISOString()},randomUUID())).value;
  const review=new WholeOrderReviewService(f.db),auditor={...f.root,authorizationCapability:'submission:audit'},before=await review.get(auditor,id);await review.correctReportQuantity(auditor,report.workReportId,{expectedOrderVersion:before.orderVersion,effectiveQuantity:3,reason:'TEST effective current report is3, original remains1'},randomUUID());
  const result=await query.production(f.root,{...filters(),lineId:(await identity.read(f.root,ready.id)).lines[0]!.lineId}),row=result.result.reworks.find(row=>row.reworkId===id)!;expect(row).toMatchObject({kind:'qc_rework',inputQuantity:10,roundNumber:null,distinctGarments:null,firstPassRate:null,processes:[{reportedQuantity:8,reportIds:expect.arrayContaining([report.workReportId,otherReport.workReportId])}]});expect((await f.db.query('SELECT actual_quantity::int AS original FROM rework_work_reports WHERE work_report_id=$1',[report.workReportId])).rows[0].original).toBe(1);expect(JSON.stringify(result)).not.toContain('unitPrice');expect(JSON.stringify(result)).not.toContain('wageItemCount');
 });
 it('keeps unknown filter mappings specific rather than making unverified category or Root creator look like a complete zero',async()=>{
  const made=await make('UNMAPPED',f.people.merchandiser!.actorId),lineId=made.lines[0]!.lineId,all=await query.production(f.root,{...filters(),lineId}),selected=await query.production(f.root,{...filters(),lineId,category:'上衣'});expect(all.result.metrics.demand.value).toBe(100);expect(selected.result.metrics.demand.value).toBeNull();expect(selected.result.metrics.demand.knownValue).toBe(0);expect(selected.result.unknown.some(row=>row.reason.includes('品类'))).toBe(true);expect(selected.total).toBe(0);
  const reread=await new DigitalAnalysisQuery(f.db).production(f.root,{...filters(),lineId,category:'上衣',snapshotId:selected.snapshotId});expect(reread.result).toEqual(selected.result);expect(all.result.rows[0]!.line.designerId).toBeNull();
 });
 it('projects original split issues30/50/20 with the actual100-piece requirement while keeping accessory units and unverified event times separate',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:100,accessory:true}),cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0],cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());await f.contracts.generateIfReady(f.root,ready.caseId);
  const flow=new FactoryFlowService(f.db),bulk=new BulkPreparationService(f.db),lineId=(await identity.read(f.root,ready.id)).lines[0]!.lineId,material=(await bulk.read(f.root,ready.id)).materials!;
  let first:string|undefined,last:string|undefined;
  for(const [index,quantity]of [30,50,20].entries()){
   const state=await flow.read(f.root,ready.id);await flow.dispatch(f.root,ready.id,{expectedRevision:state.revision,supplierId:f.supplierId,lines:[{lineId,quantity}],note:'TEST original partial cut issue'},randomUUID());
   await bulk.dispatchMaterials(f.root,ready.id,{instructionVersion:material.instructionVersion!,supplierId:f.supplierId,occurredAt:new Date().toISOString(),note:'TEST original accessory issue, no numeric BOM denominator',items:[{materialId:material.items[0]!.id,quantity,unit:'粒'}]},randomUUID());
   const result=await query.production(f.root,{...filters(),lineId,factoryId:f.supplierId});expect(result.result.workload.filter(item=>item.kind==='factory-execution'&&item.factoryId===f.supplierId&&item.active)).toHaveLength(1);const cutPieces=result.result.materials.find(row=>row.requirement.kind==='裁片')!;expect([cutPieces.requirement.required,cutPieces.effectiveQuantity,cutPieces.state]).toEqual([100,[30,80,100][index],index===2?'complete':'partial']);if(index===0)first=cutPieces.first.at!;expect(cutPieces.first.at).toBe(first);last=cutPieces.latest.at!;if(index===2)expect(cutPieces.covered.at).toBe(last);
   const accessory=result.result.materials.find(row=>row.requirement.kind.startsWith('辅料'))!;expect([accessory.requirement.unit,accessory.requirement.required,accessory.effectiveQuantity,accessory.state]).toEqual(['粒',null,[30,80,100][index],'unknown']);expect(accessory.first.at).toBeNull();expect(accessory.requirement.events.every(event=>event.time.quality==='unverified'&&event.time.at!==null)).toBe(true);
  }
 });
 it('preserves effective cumulative2, actual receipt and warehouseQC1, packing2 and special closure as separate original facts',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:2}),cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0],cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:2,attachmentIds:[await f.image(cutter)]},randomUUID());await f.contracts.generateIfReady(f.root,ready.caseId);const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,ready.id);await flow.dispatch(f.root,ready.id,{expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST native I quantity scope'},randomUUID());
  const receiving=new ReceivingService(f.db),receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receipt=(await receiving.create(receiver,{cuttingOrderId:cut.cutting_order_id,documentQuantity:2,actualQuantity:1,attachmentIds:[await f.image(receiver)]},randomUUID())).value,closure=new OrderClosureService(f.db),basis=(await closure.read(f.root,ready.id)).quality!.find(row=>row.receiptId===receipt.receiptId)!;
  await new GarmentQualityService(f.db).record(f.root,ready.id,{receiptId:receipt.receiptId,quantityVersion:basis.quantityVersion,occurredAt:new Date().toISOString(),qualifiedQuantity:1,problem:''},randomUUID());
  const board=async()=>(await receiving.board(today(),today(),'', 'all',1,15,receipt.receivingBatchId)).rows.find(row=>row.receivingBatchId===receipt.receivingBatchId)!;let current=await board();await receiving.correctBatch({...f.root,authorizationCapability:'receiving:correct'},receipt.receivingBatchId,{expectedVersion:current.version,styleNo:current.styleNo,documentQuantity:2,actualQuantity:2});current=await board();await receiving.recordPacking({...f.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:receipt.receivingBatchId,expectedVersion:current.version,expectedPackingRevisionId:current.packingRevisionId,packingQuantity:2},randomUUID());
  const before=await closure.read(f.root,ready.id);await closure.close(f.root,ready.id,{expectedRevision:before.revision,reason:'TEST original special closure keeps actual QC coverage gap'},randomUUID());const lineId=(await identity.read(f.root,ready.id)).lines[0]!.lineId,result=await query.production(f.root,{...filters(),lineId});expect(['received','qualityCovered','qualityMissing','packed','remaining','completedOrders','specialClosureOrders'].map(key=>result.result.metrics[key as keyof typeof result.result.metrics].value)).toEqual([2,1,1,null,null,0,1]);expect(result.result.rows[0]!.line).toMatchObject({packing:2,effectivePacking:null});expect(result.result.problems.some(problem=>problem.kind==='已装齐的到仓检查仍有缺口')).toBe(true);expect(result.result.workload.some(item=>item.active)).toBe(false);expect(Number((await f.db.query('SELECT actual_quantity FROM receiving_receipts WHERE receipt_id=$1',[receipt.receiptId])).rows[0].actual_quantity)).toBe(1);
 });
 it('retains the original zero-share factory as history after a real full transfer while current consumers keep only the new one-piece execution',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:1}),cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0],cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:1,attachmentIds:[await f.image(cutter)]},randomUUID());await f.contracts.generateIfReady(f.root,ready.caseId);const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,ready.id);await flow.dispatch(f.root,ready.id,{expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST original C one-piece execution'},randomUUID());
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:'TEST-'+randomUUID().slice(0,8).toUpperCase(),supplierType:'factory',supplierName:'TEST stats new factory',address:'TEST',contractEntityName:'TEST',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0003',bankName:'TEST',changeReason:'TEST original full remaining transfer'}));
  await f.sourcing.requestFactoryChange(f.people['production-management']!,ready.caseId,{supplierId:supplier.supplierId,unitPrice:'6',changeReason:'TEST full one-piece transfer'},randomUUID());const request=(await f.sourcing.getCurrentFactoryChange({...f.root,authorizationCapability:'sourcing:view'},ready.caseId)).item!;await f.sourcing.decideFactoryChange(f.people.owner!,ready.caseId,request.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST actual zero old share'},randomUUID());
  const lineId=(await identity.read(f.root,ready.id)).lines[0]!.lineId,result=await query.production(f.root,{...filters(),lineId}),old=result.result.factories.find(row=>row.factoryId===f.supplierId)!,current=result.result.factories.find(row=>row.factoryId===supplier.supplierId)!;expect(old).toMatchObject({allocated:0,historicalOnly:true,actual:{received:null,qualified:null,packed:null}});expect(old.excludedReason).toContain('历史');expect(current).toMatchObject({allocated:1,historicalOnly:false});expect(result.result.metrics.unallocated.value).toBe(0);expect(result.result.workload.filter(row=>row.kind==='factory-execution'&&row.active).map(row=>row.factoryId)).toEqual([supplier.supplierId]);expect((await factoryProductionScopes(f.db,ready.id)).map(row=>[row.supplier_id,Number(row.quantity)])).toEqual([[supplier.supplierId,1]]);
 });
 it('persists actual immutable values shared by separate service instances, binds filters and expires explicitly without rewriting business facts',async()=>{
  const first=await query.production(f.root,filters()),other=new DigitalAnalysisQuery(f.db),before=(await f.db.query('SELECT count(*)::int AS n FROM digital_production_task_events')).rows[0].n;
  const same=await other.production(f.root,{...filters(),snapshotId:first.snapshotId});expect(same.result).toEqual(first.result);expect(same.watermark).toBe(first.watermark);expect(same.freshness).toBe('previous-query');
  await expect(f.db.query("UPDATE digital_production_analysis_results SET watermark='changed' WHERE result_id=$1",[first.snapshotId])).rejects.toMatchObject({code:'55000'});
  await expect(other.production(f.root,{...filters(),snapshotId:first.snapshotId,customer:'TEST-DIFFERENT'})).rejects.toMatchObject({statusCode:409});
  const row=(await f.db.query('SELECT extract(epoch FROM expires_at-created_at)::int AS ttl FROM digital_production_analysis_results WHERE result_id=$1',[first.snapshotId])).rows[0];expect(row.ttl).toBe(900);
  const expired=randomUUID();await f.db.query(`INSERT INTO digital_production_analysis_results(result_id,actor_id,filters_hash,permission_hash,rule_version,watermark,payload,created_at,expires_at)
   SELECT $1,actor_id,filters_hash,permission_hash,rule_version,watermark,payload,at.value-interval '20 minutes',at.value-interval '5 minutes' FROM digital_production_analysis_results CROSS JOIN(SELECT clock_timestamp() AS value)at WHERE result_id=$2`,[expired,first.snapshotId]);
  await expect(other.production(f.root,{...filters(),snapshotId:expired})).rejects.toMatchObject({code:'ANALYSIS_RESULT_EXPIRED',statusCode:409});
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_production_task_events')).rows[0].n).toBe(before);
 });
 it('keeps a prior complete result when saving a fresh read fails and bounds retained results per actor',async()=>{
  const before=await query.production(f.root,filters());
  await f.db.query("CREATE FUNCTION test_analysis_save_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST cache insert fault' USING ERRCODE='P0001'; END $$");
  await f.db.query('CREATE TRIGGER test_analysis_save_fault BEFORE INSERT ON digital_production_analysis_results FOR EACH ROW EXECUTE FUNCTION test_analysis_save_fault()');
  try{
   await expect(query.production(f.root,filters())).rejects.toMatchObject({code:'P0001'});
   expect((await query.production(f.root,{...filters(),snapshotId:before.snapshotId})).result).toEqual(before.result);
  }finally{await f.db.query('DROP TRIGGER test_analysis_save_fault ON digital_production_analysis_results');await f.db.query('DROP FUNCTION test_analysis_save_fault()');}
  const stored=(await f.db.query('SELECT filters_hash,permission_hash,payload FROM digital_production_analysis_results WHERE result_id=$1',[before.snapshotId])).rows[0]!,store=new AnalysisResultStore(f.db),ids:string[]=[];
  for(let index=0;index<9;index++)ids.push((await store.save(f.root.actorId,stored.filters_hash,stored.permission_hash,stored.payload)).snapshotId);
  expect(Number((await f.db.query('SELECT count(*) FROM digital_production_analysis_results WHERE actor_id=$1',[f.root.actorId])).rows[0].count)).toBe(8);
  await expect(query.production(f.root,{...filters(),snapshotId:ids[0]})).rejects.toMatchObject({code:'ANALYSIS_RESULT_EXPIRED',statusCode:409});
  expect((await query.production(f.root,{...filters(),snapshotId:ids[8]})).result).toEqual(before.result);
 });
 it('uses original block and unblock episodes for resolution and recurrence without turning free text into a standard cause',async()=>{
  const ready=await f.bulkReady('无'),lineId=(await identity.read(f.root,ready.id)).lines[0]!.lineId,tasks=new DigitalProductionTaskService(f.db),task=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND t.state='ready' ORDER BY t.task_id LIMIT 1",[ready.id])).rows[0];expect(task).toBeDefined();
  await tasks.feedback(f.root,task.task_id,'TEST free text waiting',true,randomUUID());
  const first=(await query.production(f.root,{...filters(),lineId})).result.problems.find(row=>row.kind==='原任务明确阻断')!;expect(first).toMatchObject({state:'current',reasonCode:null,recurrenceOf:null});expect(first.occurred.at).not.toBeNull();expect(first.recorded.at).not.toBeNull();expect(first.observed.at).toBeNull();
  await tasks.feedback(f.root,task.task_id,'TEST explicit resume',false,randomUUID());
  const resolved=(await query.production(f.root,{...filters(),lineId})).result.problems.find(row=>row.id===first.id)!;expect(resolved.state).toBe('resolved');expect(resolved.resolved.at).not.toBeNull();
  await tasks.feedback(f.root,task.task_id,'TEST next independent block',true,randomUUID());
  const result=await query.production(f.root,{...filters(),lineId}),episodes=result.result.problems.filter(row=>row.kind==='原任务明确阻断');expect(episodes).toHaveLength(2);expect(episodes.find(row=>row.state==='current')).toMatchObject({recurrenceOf:first.id,reasonCode:null});expect(result.result.metrics.currentProblems.value).toBe(1);
 });
 it('does not borrow another pool connection for scene isolation inside an owned original statistics transaction',async()=>{
  const made=await make('NO-NESTED',f.people.merchandiser!.actorId),original=f.db.query.bind(f.db),connections=new Set<unknown>(),connect=f.db.connect.bind(f.db);
  const track=(client:PoolClient,release:PoolClient['release'])=>{connections.add(client);const done=(...args:Parameters<typeof release>)=>{connections.delete(client);return release(...args);};client.release=done;return done;};
  const connectSpy=vi.spyOn(f.db,'connect').mockImplementation(((callback?: (error:Error|null,client:PoolClient,release:PoolClient['release'])=>void)=>{if(callback)return connect((error,client,release)=>callback(error,client,error?release:track(client,release)));return connect().then(client=>{track(client,client.release.bind(client));return client;});}) as typeof f.db.connect);
  const querySpy=vi.spyOn(f.db,'query').mockImplementation(((...args:unknown[])=>{if(connections.size)throw Error('Original statistics tried to borrow from its pool while holding a transaction');return (original as (...args:unknown[])=>unknown)(...args);}) as typeof f.db.query);
  try{const first=await query.production(f.root,{...filters(),lineId:made.lines[0]!.lineId});expect(first.result.metrics.demand.value).toBe(100);expect((await query.production(f.root,{...filters(),lineId:made.lines[0]!.lineId,snapshotId:first.snapshotId})).watermark).toBe(first.watermark);}
  finally{querySpy.mockRestore();connectSpy.mockRestore();}
 });
 it('completes simultaneous original authenticated reads at the configured pool limit with separate authorized results',async()=>{
  const user=await dedicated(['finance_read','order_merchandiser']),made=await make('CONCURRENT',user.actorId),cookie=await login(user.actorId),responses=await Promise.all(Array.from({length:f.db.options.max??10},()=>app.inject({url:path({lineId:made.lines[0]!.lineId}),headers:{cookie}})));
  expect(responses.map(response=>({status:response.statusCode,error:response.statusCode===200?null:response.json()}))).toEqual(responses.map(()=>({status:200,error:null})));
  for(const response of responses)expect(response.json<ProductionStatisticsResponse>().result.metrics.demand.value).toBe(100);
 });
});
