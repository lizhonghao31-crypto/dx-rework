import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {OperationEventRepository} from '../../apps/api/src/tools/repositories.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import Fastify from 'fastify';
import {AuthService,AuthDeniedError} from '../../apps/api/src/auth/service.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {AcceptanceDingTalkProvider} from '../../apps/api/src/auth/acceptance-provider.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {mintAcceptanceControlCode} from '../../apps/api/src/auth/acceptance-control.js';
import {registerAcceptanceClockHooks} from '../../apps/api/src/acceptance-clock/hooks.js';
import {registerProductionReportingRoutes} from '../../apps/api/src/sourcing/production-reporting-routes.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {factoryReturnLogistics} from '../../apps/api/src/production-platform/factory-return-logistics.js';
import pg from 'pg';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('native production reporting business calendar with SQL guards',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,scene:string,id:string,date:string;
 const prepare=async(sceneId:string|null)=>{
  const run=<T>(action:()=>Promise<T>)=>sceneId?f.runtime.run(sceneId,f.root,action):action();
  return run(async()=>{
   const ready=await f.bulkReady('无'),cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,ready.id);
   await flow.dispatch(f.people.warehouse!,ready.id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST native production clock'},randomUUID());
   const productionId=(await f.db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].production_order_id as string;
   return {...ready,productionId,day:beijingCalendarDate(businessNow()),run};
  });
 };
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);await new ProductionClosureService(f.db).setPilot(f.root,{supplierId:f.supplierId,enabled:true});scene=await f.scene(new Date(Date.now()+7*86400000).toISOString());
  const ready=await prepare(scene);id=ready.productionId;date=ready.day;
 },120000);
 afterAll(async()=>{await f?.dispose();});
 it('accepts the original future scenario date through the native reporting command',async()=>{
  const result=await f.runtime.run(scene,f.root,()=>new ProductionReportingService(f.db).report(f.root,id,{position:1,businessDate:date,quantity:1},randomUUID()));
  expect(result.value.history[0]).toMatchObject({businessDate:date,quantity:1});
 },testExecutionConfig.correctnessTimeoutMs);
 it('independently accepts a matching current-transaction event at the SQL date boundary',async()=>{
  await f.runtime.run(scene,f.root,async()=>{
   const client=await f.db.connect();
   try{await client.query('BEGIN');const reportId=randomUUID();
    const event=await new OperationEventRepository().append(client,f.root,{action:'sourcing.production.report',entityType:'sourcing_production_report',entityId:reportId,
     after:{factoryDecisionId:null,productionOrderId:id,rootReportId:reportId,revision:1,position:1,businessDate:date,quantity:1},reason:'TEST SQL native clock'});
    await client.query(`INSERT INTO sourcing_production_reports(report_id,root_report_id,revision,production_order_id,position,business_date,quantity,actor_id,actor_name,operation_event_id)
     SELECT $1,$1,1,$2,1,$3,1,id,display_name,$5 FROM app_users WHERE id=$4`,[reportId,id,date,f.root.actorId,event]);
    expect((await client.query('SELECT business_date::text FROM sourcing_production_reports WHERE report_id=$1',[reportId])).rows[0].business_date).toBe(date);
   }finally{await client.query('ROLLBACK');client.release();}
  });
 },testExecutionConfig.correctnessTimeoutMs);
 for(const mode of ['past','present','future','ordinary'] as const)it(`${mode}: report, append correction, completion and shipment retain dates, guards and real audits`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-7*86400000:mode==='future'?7*86400000:0)).toISOString(),sceneId=mode==='ordinary'?null:await f.scene(at),p=await prepare(sceneId);
  const service=new ProductionReportingService(f.db),reporter={...f.people['production-reporter']!,authorizationCapability:'production-reporting',authorizationCapabilities:['production-reporting']};
  await expect(p.run(()=>service.report(reporter,p.productionId,{position:1,businessDate:p.day,quantity:1},randomUUID()))).rejects.toMatchObject({statusCode:403});
  await service.setScope(f.root,{userId:reporter.actorId,scopeType:'order',scopeId:p.productionId,active:true},randomUUID());
  await p.run(async()=>{
   const detail=await service.detail(reporter,p.productionId);
   expect(detail.businessToday).toBe(p.day);if(sceneId)expect(detail.asOf).toBe(at);
   const tomorrow=new Date(Date.parse(p.day+'T00:00:00Z')+86400000).toISOString().slice(0,10),yesterday=new Date(Date.parse(p.day+'T00:00:00Z')-86400000).toISOString().slice(0,10);
   await expect(service.report(reporter,p.productionId,{position:1,businessDate:tomorrow,quantity:1},randomUUID())).rejects.toMatchObject({statusCode:400});
   await expect(service.report(reporter,p.productionId,{position:1,businessDate:yesterday,quantity:1},randomUUID())).rejects.toMatchObject({statusCode:400});
   await expect(service.report(reporter,p.productionId,{position:1,businessDate:p.day,quantity:11},randomUUID())).rejects.toMatchObject({statusCode:400});
   const key=randomUUID(),input={position:1,businessDate:p.day,quantity:3},one=await service.report(reporter,p.productionId,input,key);
   expect((await service.report(reporter,p.productionId,input,key)).reused).toBe(true);
   await expect(service.report(reporter,p.productionId,{...input,quantity:4},key)).rejects.toMatchObject({statusCode:409});
   const original=one.value.history[0]!,fix={expectedReportId:original.reportId,businessDate:p.day,quantity:4,reason:'TEST original retained'};
   await expect(service.correct(reporter,p.productionId,original.rootReportId,fix,randomUUID())).rejects.toMatchObject({statusCode:403});
   const fixKey=randomUUID(),corrected=await service.correct(f.root,p.productionId,original.rootReportId,fix,fixKey);
   expect(corrected.value.history).toHaveLength(2);expect(corrected.value.history.find(r=>r.reportId===original.reportId)).toMatchObject({quantity:3,effective:false});
   expect((await service.correct(f.root,p.productionId,original.rootReportId,fix,fixKey)).reused).toBe(true);
   await expect(service.correct(f.root,p.productionId,original.rootReportId,fix,randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(service.execute(reporter,p.productionId,'ship',{businessDate:p.day,confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:409});
   const completeKey=randomUUID();await service.execute(reporter,p.productionId,'complete',{businessDate:p.day,confirmed:true},completeKey);
   expect((await service.execute(reporter,p.productionId,'complete',{businessDate:p.day,confirmed:true},completeKey)).reused).toBe(true);
   await expect(service.report(reporter,p.productionId,input,randomUUID())).rejects.toMatchObject({statusCode:409});
   const shipKey=randomUUID(),shipped=await service.execute(reporter,p.productionId,'ship',{businessDate:p.day,confirmed:true},shipKey);
   expect((await service.execute(reporter,p.productionId,'ship',{businessDate:p.day,confirmed:true},shipKey)).reused).toBe(true);
   expect(shipped.value.shipment).toMatchObject({shippedOn:p.day,recordedQuantity:4});
   expect(shipped.value.transitions.map(t=>t.businessDate)).toEqual([p.day,p.day,p.day]);
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[p.caseId])).rows[0],receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
   const receipt=await new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db)).create(receiver,{cuttingOrderId:cut.cutting_order_id,productionOrderId:p.productionId,factoryDecisionId:null,documentQuantity:4,actualQuantity:4,attachmentIds:[await f.image(receiver)]},randomUUID());
   const linked=(await f.db.query(`SELECT receipt.received_at,shipment.shipped_on::text FROM sourcing_production_receipt_links link JOIN receiving_receipts receipt USING(receipt_id)
    JOIN sourcing_production_shipments shipment ON shipment.production_order_id=link.production_order_id AND shipment.factory_decision_id IS NOT DISTINCT FROM link.factory_decision_id WHERE link.receipt_id=$1`,[receipt.value.receiptId])).rows[0];
   expect(linked.shipped_on).toBe(p.day);expect(beijingCalendarDate(linked.received_at)).toBe(p.day);
   const logistics=await factoryReturnLogistics(f.db,p.id,businessNow());expect(logistics).toHaveLength(1);expect(logistics[0]).toMatchObject({shippedOn:p.day,hasReceived:true,dispatchPrecision:'date',actualDispatchedAt:null});
   const audits=(await f.db.query('SELECT created_at FROM sourcing_production_transitions WHERE production_order_id=$1 AND sequence>1',[p.productionId])).rows;
   for(const audit of audits)expect(Math.abs(audit.created_at.getTime()-Date.now())).toBeLessThan(60000);
  });
  if(sceneId)expect((await service.detail(f.root,p.productionId)).asOf).toBe(at); // verified reader without ALS
 },testExecutionConfig.correctnessTimeoutMs);
 it('uses Beijing date at midnight ±1ms and keeps another scene and ordinary orders isolated',async()=>{
  const sceneId=await f.scene('2026-11-05T15:59:59.999Z'),p=await prepare(sceneId),service=new ProductionReportingService(f.db);
  expect((await service.detail(f.root,p.productionId)).businessToday).toBe('2026-11-05');
  await p.run(()=>service.report(f.root,p.productionId,{position:1,businessDate:'2026-11-05',quantity:1},randomUUID()));
  await expect(p.run(()=>service.report(f.root,p.productionId,{position:1,businessDate:'2026-11-06',quantity:1},randomUUID()))).rejects.toMatchObject({statusCode:400});
  await f.advance(sceneId,'2026-11-05T16:00:00.000Z');
  expect((await service.detail(f.root,p.productionId)).businessToday).toBe('2026-11-06');
  await p.run(()=>service.report(f.root,p.productionId,{position:1,businessDate:'2026-11-06',quantity:1},randomUUID()));
  const otherScene=await f.scene('2026-11-07T16:00:00.001Z'),other=await prepare(otherScene),ordinary=await prepare(null);
  await expect(other.run(()=>service.detail(f.root,p.productionId))).rejects.toMatchObject({code:'ACCEPTANCE_CLOCK_CONFLICT'});
  await expect(p.run(()=>service.detail(f.root,ordinary.productionId))).rejects.toMatchObject({code:'ACCEPTANCE_CLOCK_CONFLICT'});
  const [first,second]=await Promise.all([p.run(()=>service.detail(f.root,p.productionId)),other.run(()=>service.detail(f.root,other.productionId))]);
  expect(first.businessToday).toBe('2026-11-06');expect(second.businessToday).toBe('2026-11-08');
 },testExecutionConfig.correctnessTimeoutMs);
 it('resolves reporting HTTP detail and writes through the original production id without a scene header',async()=>{
  const secret=f.runtime.secret,corp='anchor-test',auth=new AuthService(new AcceptanceDingTalkProvider(f.db,corp,secret),new PostgresAuthStore(f.db,corp,'uat-root'),corp,3600000,secret),root=new RootAuthority(f.db,corp,'uat-root');
  const control=await auth.beginAcceptanceControl(mintAcceptanceControlCode(secret)),login=await auth.switchAcceptanceIdentity(control,'root'),cookie=`dx_acceptance_control=${control}; dx_rework_session=${login.token}`;
  const app=Fastify();registerAcceptanceClockHooks(app,f.runtime,auth,root);registerProductionReportingRoutes(app,{authenticate:token=>auth.authenticate(token),root,service:new ProductionReportingService(f.db)});
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof AuthDeniedError?401:error instanceof ApplicationError?error.statusCode:500).send({error:{message:error.message}}));
  try{
   const result=await app.inject({method:'GET',url:`/production-reporting/${id}`,headers:{cookie}});expect(result.statusCode,result.body).toBe(200);expect(result.json().businessToday).toBe(date);expect(result.headers['x-acceptance-clock']).toBe('scenario');
   const posted=await app.inject({method:'POST',url:`/production-reporting/${id}/reports`,headers:{cookie,'idempotency-key':randomUUID()},payload:{position:1,businessDate:date,quantity:1}});expect(posted.statusCode,posted.body).toBe(200);
   const wrong=await app.inject({method:'GET',url:`/production-reporting/${id}`,headers:{cookie,'x-acceptance-scenario':randomUUID()}});expect(wrong.statusCode).toBe(409);
   const global=await app.inject({method:'GET',url:'/production-reporting',headers:{cookie,'x-acceptance-scenario':scene}});expect(global.statusCode).toBe(409);
   expect((await app.inject({method:'GET',url:`/production-reporting/${id}`})).statusCode).toBe(401);
  }finally{await app.close();}
 },testExecutionConfig.correctnessTimeoutMs);
 it('replays an actual legacy success receipt without inventing fresh metadata or repeating its write',async()=>{
  const service=new ProductionReportingService(f.db),original=service.detail.bind(service),key=randomUUID(),input={position:1,businessDate:date,quantity:1};
  // Reproduce the previous response encoder through the real transaction and receipt repository.
  const legacy=vi.spyOn(service,'detail').mockImplementation(async(...args)=>{
   const result=await original(...args);delete result.businessToday;delete result.asOf;return result;
  });
  let first:Awaited<ReturnType<typeof service.report>>;
  try{first=await f.runtime.run(scene,f.root,()=>service.report(f.root,id,input,key));}finally{legacy.mockRestore();}
  const replay=await f.runtime.run(scene,f.root,()=>service.report(f.root,id,input,key));
  expect(replay.reused).toBe(true);expect(replay.value).toEqual(first!.value);expect(replay.value.asOf).toBeUndefined();expect(replay.value.businessToday).toBeUndefined();
  const app=Fastify();registerProductionReportingRoutes(app,{authenticate:async()=>({id:f.root.actorId,displayName:'TEST Root',businessRoles:['root_superuser'],capabilities:['production-reporting']}),service});
  try{const response=await app.inject({method:'POST',url:`/production-reporting/${id}/reports`,headers:{'idempotency-key':key},payload:input});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual(first!.value);}finally{await app.close();}
  expect((await service.detail(f.root,id)).businessToday).toBe(date);
  expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_production_reports WHERE report_id=$1',[first!.value.history[0]!.reportId])).rows[0].n).toBe(1);
 },testExecutionConfig.correctnessTimeoutMs);
 for(const mode of ['past','future','ordinary'] as const)it(`${mode}: a transferred execution uses its own approved business day while retaining real transfer cutoffs`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-6*86400000:6*86400000)).toISOString(),sceneId=mode==='ordinary'?null:await f.scene(at),p=await prepare(sceneId),service=new ProductionReportingService(f.db);
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:`TEST-${randomUUID().slice(0,8).toUpperCase()}`,supplierType:'factory',supplierName:`TEST next factory ${mode}`,address:'TEST',contractEntityName:'TEST factory',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0002',bankName:'TEST',changeReason:'TEST original native transfer'}));
  await p.run(()=>service.report(f.root,p.productionId,{position:1,businessDate:p.day,quantity:2},randomUUID()));
  const next=sceneId?new Date(Date.parse(at)+86400000).toISOString():null;if(sceneId)await f.advance(sceneId,next!);
  await p.run(async()=>{
   const request=await f.sourcing.requestFactoryChange(f.people['production-management']!,p.caseId,{supplierId:supplier.supplierId,unitPrice:'6',changeReason:'TEST transfer business calendar'},randomUUID());
   const current=(await f.sourcing.getCurrentFactoryChange({...f.root,authorizationCapability:'sourcing:view'},p.caseId)).item!;expect(request.value.status).toBe('pending_finance_reconciliation');
   const changed=await f.sourcing.decideFactoryChange(f.people.owner!,p.caseId,current.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST actual remaining quantity'},randomUUID()),factoryDecisionId=changed.value.decision!.sourcingDecisionId;
   const day=beijingCalendarDate(businessNow()),transition=(await f.db.query(`SELECT t.business_date::text,t.created_at,transfer.effective_at FROM sourcing_production_transitions t JOIN sourcing_production_factory_transfers transfer USING(factory_decision_id) WHERE t.production_order_id=$1 AND t.factory_decision_id=$2 AND sequence=1`,[p.productionId,factoryDecisionId])).rows[0];
   expect(transition.business_date).toBe(day);expect(transition.created_at).toEqual(transition.effective_at);expect(Math.abs(transition.effective_at.getTime()-Date.now())).toBeLessThan(60000);
   if(sceneId)expect(transition.effective_at.toISOString()).not.toBe(next);
   else expect(transition.business_date).toBe(beijingCalendarDate(transition.effective_at));
   const detail=await service.detail(f.root,p.productionId,undefined,factoryDecisionId);expect(detail.order.quantity).toBe(8);expect(detail.businessToday).toBe(day);
   if(sceneId)await expect(service.report(f.root,p.productionId,{factoryDecisionId,position:1,businessDate:p.day,quantity:1},randomUUID())).rejects.toMatchObject({statusCode:400});
   const input={factoryDecisionId,position:1,businessDate:day,quantity:8};await service.report(f.root,p.productionId,input,randomUUID());
   await service.execute(f.root,p.productionId,'complete',{factoryDecisionId,businessDate:day,confirmed:true},randomUUID());
   expect((await service.execute(f.root,p.productionId,'ship',{factoryDecisionId,businessDate:day,confirmed:true},randomUUID())).value.shipment).toMatchObject({shippedOn:day,recordedQuantity:8});
  });
 },testExecutionConfig.correctnessTimeoutMs);
 it('refuses an unverified reader and independently requires an active UAT operation actor in SQL',async()=>{
  const unverified=new pg.Pool({...f.db.options});
  try{await expect(new ProductionReportingService(unverified).detail(f.root,id)).rejects.toMatchObject({code:'ACCEPTANCE_ISOLATION'});}finally{await unverified.end();}
  const row=await f.runtime.repository.row(scene),time={now:row.business_now.toISOString(),scenarioId:scene,revision:row.version};
   const client=await f.db.connect();try{await client.query('BEGIN');
    // Stable identity/Root keys remain immutable. Use the supported active flag, never disable their guards.
    await client.query("UPDATE identity_mappings SET active=false WHERE user_id=$1 AND provider='dingtalk'",[f.root.actorId]);
    const reportId=randomUUID(),event=await new OperationEventRepository().append(client,f.root,{action:'sourcing.production.report',entityType:'sourcing_production_report',entityId:reportId,after:{factoryDecisionId:null,productionOrderId:id,rootReportId:reportId,revision:1,position:1,businessDate:date,quantity:1,acceptanceClock:time}});
    await expect(client.query('SELECT sourcing_production_business_date($1,$2)',[id,event])).rejects.toThrow('Production calendar requires');
   }finally{await client.query('ROLLBACK');client.release();}
 },testExecutionConfig.correctnessTimeoutMs);
 it('preserves report, completion, shipment and correction lower bounds after multiple business days',async()=>{
  const sceneId=await f.scene('2026-11-12T10:00:00.000Z'),p=await prepare(sceneId),service=new ProductionReportingService(f.db);
  await f.advance(sceneId,'2026-11-13T10:00:00.000Z');
  const report=await p.run(()=>service.report(f.root,p.productionId,{position:1,businessDate:'2026-11-13',quantity:2},randomUUID())),original=report.value.history[0]!;
  await p.run(async()=>{
   await expect(service.execute(f.root,p.productionId,'complete',{businessDate:'2026-11-12',confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:400});
   await service.execute(f.root,p.productionId,'complete',{businessDate:'2026-11-13',confirmed:true},randomUUID());
   await expect(service.execute(f.root,p.productionId,'ship',{businessDate:'2026-11-12',confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:400});
  });
  await f.advance(sceneId,'2026-11-14T10:00:00.000Z');
  await p.run(async()=>{
   await expect(service.correct(f.root,p.productionId,original.rootReportId,{expectedReportId:original.reportId,businessDate:'2026-11-14',quantity:2,reason:'TEST cannot move beyond completion'},randomUUID())).rejects.toMatchObject({statusCode:400});
   await service.execute(f.root,p.productionId,'ship',{businessDate:'2026-11-14',confirmed:true},randomUUID());
  });
 },testExecutionConfig.correctnessTimeoutMs);
 it('serializes same-key concurrent reports and preserves the original receipt after scene advancement',async()=>{
  const sceneId=await f.scene('2026-11-09T10:00:00.000Z'),p=await prepare(sceneId),service=new ProductionReportingService(f.db),key=randomUUID(),input={position:1,businessDate:p.day,quantity:2};
  const results=await Promise.all([p.run(()=>service.report(f.root,p.productionId,input,key)),p.run(()=>service.report(f.root,p.productionId,input,key))]);
  expect(results.map(r=>r.reused).sort()).toEqual([false,true]);
  await f.advance(sceneId,'2026-11-10T10:00:00.000Z');
  const replay=await p.run(()=>service.report(f.root,p.productionId,input,key));expect(replay.value).toEqual(results[0]!.value);
  expect((await service.detail(f.root,p.productionId)).businessToday).toBe('2026-11-10');
  expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_production_reports WHERE production_order_id=$1',[p.productionId])).rows[0].n).toBe(1);
 },testExecutionConfig.correctnessTimeoutMs);
 it('rejects missing, wrong-scene, stale-version and false-time SQL claims independently of API and GUCs',async()=>{
  const sceneRow=await f.runtime.repository.row(scene),time={now:sceneRow.business_now.toISOString(),scenarioId:scene,revision:sceneRow.version};
  for(const bad of [null,{...time,scenarioId:randomUUID()},{...time,revision:time.revision+1},{...time,now:new Date(Date.parse(time.now)+86400000).toISOString()}]){
   const client=await f.db.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.acceptance_clock',$1,true)",[JSON.stringify(time)]);
    const reportId=randomUUID(),event=await new OperationEventRepository().append(client,f.root,{action:'sourcing.production.report',entityType:'sourcing_production_report',entityId:reportId,
     after:{factoryDecisionId:null,productionOrderId:id,rootReportId:reportId,revision:1,position:1,businessDate:date,quantity:1,...(bad?{acceptanceClock:bad}:{})},reason:'TEST untrusted claim'});
    await expect(client.query(`INSERT INTO sourcing_production_reports(report_id,root_report_id,revision,production_order_id,position,business_date,quantity,actor_id,actor_name,operation_event_id)
     SELECT $1,$1,1,$2,1,$3,1,id,display_name,$5 FROM app_users WHERE id=$4`,[reportId,id,date,f.root.actorId,event])).rejects.toThrow('Production calendar requires');
   }finally{await client.query('ROLLBACK');client.release();}
  }
  const client=await f.db.connect();let reportId:string,event:string;
  try{await client.query('BEGIN');reportId=randomUUID();event=await new OperationEventRepository().append(client,f.root,{action:'sourcing.production.report',entityType:'sourcing_production_report',entityId:reportId,after:{factoryDecisionId:null,productionOrderId:id,rootReportId:reportId,revision:1,position:1,businessDate:date,quantity:1,acceptanceClock:time}});await client.query('COMMIT');
   await client.query('BEGIN');await expect(client.query(`INSERT INTO sourcing_production_reports(report_id,root_report_id,revision,production_order_id,position,business_date,quantity,actor_id,actor_name,operation_event_id)
    SELECT $1,$1,1,$2,1,$3,1,id,display_name,$5 FROM app_users WHERE id=$4`,[reportId,id,date,f.root.actorId,event])).rejects.toThrow('Production calendar requires');
  }finally{await client.query('ROLLBACK');client.release();}
 },testExecutionConfig.correctnessTimeoutMs);
 for(const kind of ['report','correct','complete','ship'] as const)it(`rolls back the whole ${kind} transaction and retries the identical key`,async()=>{
  const sceneId=await f.scene(new Date(Date.now()+5*86400000).toISOString()),p=await prepare(sceneId),service=new ProductionReportingService(f.db);
  await p.run(async()=>{
   const key=randomUUID(),input={position:1,businessDate:p.day,quantity:2};
   const original=kind==='correct'?(await service.report(f.root,p.productionId,input,randomUUID())).value.history[0]!:null;
   if(kind==='ship')await service.execute(f.root,p.productionId,'complete',{businessDate:p.day,confirmed:true},randomUUID());
   const table=kind==='report'||kind==='correct'?'sourcing_production_reports':kind==='complete'?'sourcing_production_transitions':'sourcing_production_shipments';
   const snapshot=async()=>Promise.all(['operation_events','idempotency_records','sourcing_production_reports','sourcing_production_transitions','sourcing_production_shipments'].map(async table=>(await f.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n));
   const before=await snapshot();
   const action=()=>kind==='report'?service.report(f.root,p.productionId,input,key):kind==='correct'?service.correct(f.root,p.productionId,original!.rootReportId,{expectedReportId:original!.reportId,businessDate:p.day,quantity:3,reason:'TEST rollback'},key):service.execute(f.root,p.productionId,kind,{businessDate:p.day,confirmed:true},key);
   await f.db.query(`CREATE FUNCTION test_calendar_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST calendar rollback'; END $$; CREATE TRIGGER test_calendar_fail AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_calendar_fail()`);
   try{await expect(action()).rejects.toThrow('TEST calendar rollback');}finally{await f.db.query(`DROP TRIGGER test_calendar_fail ON ${table}; DROP FUNCTION test_calendar_fail()`);}
   expect(await snapshot()).toEqual(before);
   await action();expect((await action()).reused).toBe(true);
  });
 },testExecutionConfig.correctnessTimeoutMs);
});
