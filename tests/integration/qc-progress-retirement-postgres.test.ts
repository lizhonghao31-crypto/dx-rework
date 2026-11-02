import {CreateSupplierSchema} from '@dx-rework/contracts';
import {nodeMaterialsFixture} from '../helpers/node-materials-fixture.js';
import {MemberModuleBindingService} from '../../apps/api/src/access/member-module-binding-service.js';
import {DigitalCockpitQuery} from '../../apps/api/src/production-platform/cockpit-query.js';
import {qcProgressNotices} from '../../apps/api/src/production-platform/qc-progress-todos.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {ProductionDashboardService} from '../../apps/api/src/sourcing/production-dashboard-service.js';
import {randomUUID,createHash} from 'node:crypto';
import Fastify from 'fastify';
import sharp from 'sharp';
import {registerQcProductionProgressRoutes} from '../../apps/api/src/production-platform/qc-production-progress-routes.js';
import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {physicalCuttingLabelsFixture} from '../helpers/production-readiness-fixture.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {QcProductionProgressService} from '../../apps/api/src/production-platform/qc-production-progress-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {factoryProductionFacts} from '../../apps/api/src/production-platform/factory-production-facts.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {QC_PROGRESS_CAPABILITY,SubmitQcProgressSchema,type QcProductionExecution} from '@dx-rework/contracts/qc-production-progress';
import {migrationExecutionSql} from '../../scripts/deploy/migration-execution-compatibility.mjs';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('QC progress native lifecycle and retired factory requirement (TEST_DATABASE_URL)',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,flow:FactoryFlowService,service:QcProductionProgressService,tasks:DigitalProductionTaskService,qc:typeof f.root;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);flow=new FactoryFlowService(f.db);service=new QcProductionProgressService(f.db);tasks=new DigitalProductionTaskService(f.db);
  const person=Object.values(f.people).find(p=>p.actorRoles.includes('quality_control'));if(!person)throw Error('real seeded QC role required');
  expect((await f.db.query("SELECT 1 FROM role_capabilities WHERE role_code='quality_control' AND capability=$1",[QC_PROGRESS_CAPABILITY])).rowCount).toBe(1);
  qc={...person,authorizationCapabilities:[...person.authorizationCapabilities!,QC_PROGRESS_CAPABILITY]};
 });
 afterAll(async()=>{await f?.dispose();});
 const dispatch=async(poCount=1,assign=true)=>{
  const ready=await f.bulkReady('无',undefined,poCount),cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of (await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows){await physicalCuttingLabelsFixture(f.db,f.root,cut.cutting_order_id,10);await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());}
  const before=await flow.read(f.people.warehouse!,ready.id);await flow.dispatch(f.people.warehouse!,ready.id,{expectedRevision:before.revision,supplierId:f.supplierId,occurredAt:businessNow().toISOString(),note:'TEST original warehouse dispatch'},randomUUID());
  const task=(await flow.read(f.root,ready.id)).tasks.find(t=>t.taskKind==='factory_production_qc')!;if(assign)await tasks.reassign(f.root,task.taskId,qc.actorId,randomUUID());
  return {...ready,taskId:task.taskId};
 };
 const input=(e:QcProductionExecution,quantity?:number)=>SubmitQcProgressSchema.parse({submissionId:randomUUID(),factoryDecisionId:e.factoryDecisionId,expectedScopeRevision:e.scopeRevision,expectedProgressRevision:e.progressRevision,kind:'progress',collectedAt:businessNow().toISOString(),observations:[{lineId:e.lines[0]!.lineId,state:'working',cuttingPercent:70,sewingPercent:50,ironingPercent:30,reason:'TEST actual observation',...(quantity===undefined?{}:{additionalFinishedQuantity:quantity})}],criticalEvents:[],attachmentIds:[],note:'TEST same QC records progress and applicable finished quantity'});
 it('records one native quantity increment with the observation, replays lost responses once and keeps quality independent',async()=>{
  const scene=await f.scene('2026-11-02T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const ready=await dispatch(2),sheet=await service.read(qc,ready.id),e=sheet.executions[0]!;
   expect(e.clock).toMatchObject({basis:'start',anchor:businessNow().toISOString(),state:'not_due'});expect(e.canRecord).toBe(true);expect((await new DigitalCockpitQuery(f.db).list(qc,{page:1,search:'',stage:'bulk'})).items.some(row=>row.orderId===ready.id)).toBe(true);
   expect((await flow.read(f.root,ready.id)).tasks.some(t=>t.taskKind==='factory_material_count')).toBe(false);
   await expect(flow.followup(ready.primary,ready.id,{expectedRevision:0,kind:'工厂到料',occurredAt:null,trackingNumber:'',note:'TEST obsolete client'},randomUUID())).rejects.toMatchObject({statusCode:410});
   const photo=await f.image(qc);await service.registerUpload(qc,ready.id,e.factoryDecisionId,e.scopeRevision,photo);
   const body={...input(e,3),attachmentIds:[photo]},first=await service.submit(qc,ready.id,body);const fresh=await service.read(qc,ready.id);expect(fresh.executions[0]!.progressRevision).toBe(1);
   expect(await service.submit(qc,ready.id,body)).toEqual(first);expect((await service.read(qc,ready.id)).executions[0]!.records).toHaveLength(1);
   const native=new ProductionReportingService(f.db),detail=await native.detail(qc,e.productionId,undefined,e.factoryDecisionId);expect(detail.order.completedQuantity).toBe(3);expect(detail.order.lines.filter(l=>l.completedQuantity===3)).toHaveLength(1);
   expect((await factoryProductionFacts(f.db,ready.id)).complete).toBe(false);
   await expect(native.execute(qc,e.productionId,'complete',{businessDate:beijingCalendarDate(businessNow()),confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:403});
   await expect(native.execute(qc,e.productionId,'ship',{businessDate:beijingCalendarDate(businessNow()),confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:403});
   await expect(native.correct(qc,e.productionId,first.reportIds[0]!,{expectedReportId:first.reportIds[0]!,businessDate:beijingCalendarDate(businessNow()),quantity:4,reason:'TEST no QC correction',factoryDecisionId:e.factoryDecisionId},randomUUID())).rejects.toMatchObject({statusCode:403});
   await native.correct(f.root,e.productionId,first.reportIds[0]!,{expectedReportId:first.reportIds[0]!,businessDate:beijingCalendarDate(businessNow()),quantity:4,reason:'TEST original Root correction',factoryDecisionId:e.factoryDecisionId},randomUUID());expect((await native.detail(qc,e.productionId,undefined,e.factoryDecisionId)).order.completedQuantity).toBe(4);
   const current=(await service.read(qc,ready.id)).executions[0]!;await expect(service.submit(qc,ready.id,input(current,7))).rejects.toMatchObject({statusCode:400});
   expect((await service.read(qc,ready.id)).executions[0]!.records).toHaveLength(1);expect((await native.detail(qc,e.productionId,undefined,e.factoryDecisionId)).order.completedQuantity).toBe(4);
  });
 });
 it('retains both factory scopes for one PO after a real remainder transfer instead of overwriting the original row',async()=>{
  const ready=await dispatch(),native=new ProductionReportingService(f.db),initial=(await service.read(f.root,ready.id)).executions[0]!;
  const root={...f.root,authorizationCapability:'production-reporting',authorizationCapabilities:[...(f.root.authorizationCapabilities??[]),'production-reporting','sourcing:view','sourcing:factory_change:request','sourcing:factory_change:verify','sourcing:owner:approve']};
  await native.report(root,initial.productionId,{position:1,businessDate:beijingCalendarDate(businessNow()),quantity:4},randomUUID());
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:'TEST-P08-'+randomUUID().slice(0,6).toUpperCase(),supplierType:'factory',supplierName:'TEST转入工厂',address:'TEST',contractEntityName:'TEST factory',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0001',bankName:'TEST',changeReason:'TEST真实余量转厂范围'}));
  await f.sourcing.requestFactoryChange({...root,authorizationCapability:'sourcing:factory_change:request'},ready.caseId,{supplierId:supplier.supplierId,unitPrice:'12',changeReason:'TEST原厂4件保留，余6件转厂'},randomUUID());
  const reader={...root,authorizationCapability:'sourcing:view'};let change=(await f.sourcing.getCurrentFactoryChange(reader,ready.caseId)).item!;
  if(change.status==='pending_management'){await f.sourcing.decideFactoryChange({...root,authorizationCapability:'sourcing:factory_change:verify'},ready.caseId,change.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST总监核实余量及新厂排期'},randomUUID());change=(await f.sourcing.getCurrentFactoryChange(reader,ready.caseId)).item!;}
  if(change.status==='pending_owner')await f.sourcing.decideFactoryChange({...root,authorizationCapability:'sourcing:owner:approve'},ready.caseId,change.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST老板批准真实余量和合同价格'},randomUUID());
  let all=(await service.read(f.root,ready.id)).executions;expect(all).toHaveLength(2);const incoming=all.find(e=>e.factoryDecisionId!==initial.factoryDecisionId)!;expect(all.map(e=>e.lines[0]!.quantity).sort()).toEqual([4,6]);
  await service.adopt(f.root,ready.id,{factoryDecisionId:incoming.factoryDecisionId,expectedScopeRevision:incoming.scopeRevision,reason:'TEST有权确认转入厂本范围监督'},randomUUID());
  const current=(await service.read(qc,ready.id)).executions.find(e=>e.factoryDecisionId===incoming.factoryDecisionId)!;await service.submit(qc,ready.id,input(current));
  all=(await service.read(f.root,ready.id)).executions;const result=await nodeMaterialsFixture(f.db,f.root,ready.id,'production_reporting'),rows=result.data.rows.filter(r=>r.id.startsWith('qc-'));
  expect(rows).toHaveLength(2);expect(new Set(rows.map(r=>r.id)).size).toBe(2);expect(rows.find(r=>r.id.includes(incoming.factoryDecisionId!))?.state).toBe('present');expect(rows.find(r=>r.id.includes('-original-'))?.state).toBe('missing');expect(new Set(rows.map(r=>r.scope)).size).toBe(2);expect(all.map(e=>e.productionId)).toEqual([initial.productionId,initial.productionId]);
 });
 it('requires exact assigned scope, rejects unauthorized replay, and does not grant another order of the same supplier',async()=>{
  const ready=await dispatch(),e=(await service.read(qc,ready.id)).executions[0]!,body=input(e),result=await service.submit(qc,ready.id,body);
  await expect(service.submit(ready.primary,ready.id,{...body,submissionId:randomUUID()})).rejects.toMatchObject({statusCode:403});
  const other=await dispatch();
  const otherQcId=f.people['worker-a']!.actorId;
  await f.access.assignRole(f.root,{userId:otherQcId,roleCode:'quality_control',reason:'TEST valid second QC for exact order-scope reassignment'});
  await tasks.reassign(f.root,other.taskId,otherQcId,randomUUID());
  const native=new ProductionReportingService(f.db),own=(await service.read(qc,ready.id)).executions[0]!,outside=(await service.read(f.root,other.id)).executions[0]!;
  const assignment=await f.access.assignRole(f.root,{userId:qc.actorId,roleCode:'production_reporter',reason:'TEST real reporter grant followed by revocation'});
  await native.setScope(f.root,{userId:qc.actorId,scopeType:'supplier',scopeId:f.supplierId,active:true},randomUUID());
  const reporter={...qc,actorRoles:[...qc.actorRoles,'production_reporter'],authorizationCapabilities:[...qc.authorizationCapabilities!,'production-reporting']};
  expect((await native.list(reporter)).items.some(row=>row.productionOrderId===outside.productionId)).toBe(true);
  await f.access.revokeRole(f.root,assignment.assignmentId,'TEST revoke reporter while retaining assigned QC');
  // Revocation deliberately retains the native supplier scope; QC must not reuse it.
  expect((await f.db.query('SELECT sourcing_production_factory_reporter_allowed($1,$2,$3) allowed',[qc.actorId,outside.productionId,outside.factoryDecisionId])).rows[0].allowed).toBe(true);
  expect((await native.list(qc)).items.some(row=>row.productionOrderId===outside.productionId)).toBe(false);
  await expect(native.detail(qc,outside.productionId,undefined,outside.factoryDecisionId)).rejects.toMatchObject({statusCode:404});
  const dashboard=new ProductionDashboardService(f.db,native,()=>businessNow());
  expect((await dashboard.list(qc)).items.some(row=>row.order.productionOrderId===outside.productionId)).toBe(false);
  await expect(dashboard.detail(qc,outside.productionId,outside.factoryDecisionId)).rejects.toMatchObject({statusCode:404});
  const analysis=await dashboard.analysis(qc,{});
  expect(analysis.items.some(row=>row.order.productionOrderId===outside.productionId)).toBe(false);
  expect(analysis.items.some(row=>row.order.productionOrderId===own.productionId)).toBe(true);
  expect((await native.detail(qc,own.productionId,undefined,own.factoryDecisionId)).order.productionOrderId).toBe(own.productionId);
  expect((await f.db.query('SELECT digital_qc_report_allowed($1,$2,$3) allowed',[qc.actorId,(await service.read(f.root,other.id)).executions[0]!.productionId,null])).rows[0].allowed).toBe(false);
  await expect(service.read(qc,other.id)).rejects.toMatchObject({statusCode:404});
  // Revocation is checked before serving an old idempotency response.
  await tasks.reassign(f.root,ready.taskId,otherQcId,randomUUID());
  await expect(service.submit(qc,ready.id,body)).rejects.toMatchObject({statusCode:404});
  expect((await service.read(f.root,ready.id)).executions[0]!.records[0]!.recordId).toBe(result.recordId);
 });
 it('keeps first-report and each PO clock through late assignment, other-PO updates, photo supplements and old backfill',async()=>{
  const scene=await f.scene('2026-11-03T00:00:00Z');let ready!:Awaited<ReturnType<typeof dispatch>>;
  await f.runtime.run(scene,f.root,async()=>{ready=await dispatch(2,false);expect((await service.read(f.root,ready.id)).qcUserId).toBeNull();});
  await f.advance(scene,'2026-11-04T23:59:59Z');await f.runtime.run(scene,f.root,async()=>expect((await service.read(f.root,ready.id)).executions[0]!.clock.state).toBe('not_due'));
  await f.advance(scene,'2026-11-05T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   expect((await service.read(f.root,ready.id)).executions[0]!.clock.state).toBe('due');
   await tasks.reassign(f.root,ready.taskId,qc.actorId,randomUUID());
   let e=(await service.read(qc,ready.id)).executions[0]!;expect(e.lineClocks.every(l=>l.clock.state==='due')).toBe(true);
   await service.submit(qc,ready.id,input(e));e=(await service.read(qc,ready.id)).executions[0]!;
   expect(e.lineClocks[0]!.clock.state).toBe('not_due');expect(e.lineClocks[1]!.clock.state).toBe('due');expect(e.clock.state).toBe('due');
   const projected=await nodeMaterialsFixture(f.db,f.root,ready.id,'production_reporting');
   const a=projected.data.rows.find(r=>r.id===`qc-${e.productionId}-${e.factoryDecisionId??'original'}-${e.lines[0]!.lineId}`),b=projected.data.rows.find(r=>r.id===`qc-${e.productionId}-${e.factoryDecisionId??'original'}-${e.lines[1]!.lineId}`);
   expect(a).toMatchObject({state:'present',role:'QC'});expect(b).toMatchObject({state:'missing',role:'QC'});expect(a?.reason).toContain('不代表成衣质检合格');expect(projected.data.rows.some(r=>/船样|到料清点|工厂到料/.test(r.label))).toBe(false);
  });
  await f.advance(scene,'2026-11-06T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   let e=(await service.read(qc,ready.id)).executions[0]!;expect(e.lineClocks[1]!.clock.state).toBe('escalated');
   const original=e.records.find(r=>r.kind==='progress')!,photo=await f.image(qc);await service.registerUpload(qc,ready.id,e.factoryDecisionId,e.scopeRevision,photo);
   await service.submit(qc,ready.id,SubmitQcProgressSchema.parse({submissionId:randomUUID(),factoryDecisionId:e.factoryDecisionId,expectedScopeRevision:e.scopeRevision,expectedProgressRevision:e.progressRevision,kind:'photos',relatedProgressRecordId:original.recordId,collectedAt:null,observations:[],criticalEvents:[],attachmentIds:[photo],note:'TEST photo supplement preserves both PO observation clocks'}));
   e=(await service.read(qc,ready.id)).executions[0]!;expect(e.lineClocks[1]!.clock.state).toBe('escalated');
   const old=input(e);old.collectedAt='2026-11-03T12:00:00Z';old.observations[0]!.lineId=e.lines[1]!.lineId;await service.submit(qc,ready.id,old);
   e=(await service.read(qc,ready.id)).executions[0]!;expect(e.lineClocks[1]!.clock).toMatchObject({state:'due',remindAt:'2026-11-05T12:00:00.000Z',escalateAt:'2026-11-06T12:00:00.000Z'});
   const keys=e.windows.map(w=>w.key).sort(),otherQcId=f.people['worker-a']!.actorId;await f.access.assignRole(f.root,{userId:otherQcId,roleCode:'quality_control',reason:'TEST valid reassignment keeps supervision window'});await tasks.reassign(f.root,ready.taskId,otherQcId,randomUUID());
   expect((await service.read(f.root,ready.id)).executions[0]!.windows.map(w=>w.key).sort()).toEqual(keys);
  });
 });
 it('projects48/72 reminders once per window and recipient, revalidates queued events and unifies stale dashboard rules',async()=>{
  const scene=await f.scene('2026-11-07T00:00:00Z');let ready!:Awaited<ReturnType<typeof dispatch>>;
  const actors=Object.values(f.people).map(p=>p.actorId===qc.actorId?qc:p),notifications=new DigitalProductionNotificationService(f.db);
  await f.runtime.run(scene,f.root,async()=>{ready=await dispatch();await service.settingsCommand(f.root,ready.id,{expectedVersion:0,qualityLeadId:qc.actorId},randomUUID());});
  await f.advance(scene,'2026-11-08T23:59:59Z');await f.runtime.run(scene,f.root,async()=>{
   expect((await qcProgressNotices(f.db,actors,ready.id)).filter(n=>n.recipients.includes(qc.actorId))).toHaveLength(0);
  });
  await f.advance(scene,'2026-11-09T00:00:00Z');let oldEvent!:string;
  await f.runtime.run(scene,f.root,async()=>{
   const pending=(await qcProgressNotices(f.db,actors,ready.id)).filter(n=>n.recipients.includes(qc.actorId));expect(pending).toHaveLength(1);expect(pending[0]!.key.endsWith(':48')).toBe(true);
   await notifications.runOnce();await notifications.runOnce();
   const rows=(await f.db.query("SELECT e.event_id FROM digital_production_notification_events e JOIN digital_production_notification_receipts r USING(event_id) WHERE e.task_id=$1 AND e.event_kind='qc_progress' AND r.recipient_id=$2",[ready.taskId,qc.actorId])).rows;
   expect(rows).toHaveLength(1);oldEvent=rows[0]!.event_id;
   const native=new ProductionReportingService(f.db),e=(await service.read(qc,ready.id)).executions[0]!,dashboard=await new ProductionDashboardService(f.db,native,()=>businessNow()).detail(qc,e.productionId,e.factoryDecisionId);
   expect(dashboard.progress).toMatchObject({progressState:'stale',qcObservation:{state:'due'},completedQuantity:0});
  });
  await f.advance(scene,'2026-11-10T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const pending=(await qcProgressNotices(f.db,actors,ready.id)).filter(n=>n.recipients.includes(qc.actorId));expect(pending).toHaveLength(1);expect(pending[0]!.key.endsWith(':72')).toBe(true);expect(pending[0]!.recipients).toContain(ready.primary.actorId);
   await f.db.query('UPDATE digital_production_notification_receipts SET shown_at=CURRENT_TIMESTAMP WHERE event_id=$1 AND recipient_id=$2',[oldEvent,qc.actorId]);
   expect((await notifications.current(qc,oldEvent)).notification).toBeNull();
   const e=(await service.read(qc,ready.id)).executions[0]!;await service.submit(qc,ready.id,input(e));
   expect((await qcProgressNotices(f.db,actors,ready.id)).filter(n=>n.recipients.includes(qc.actorId))).toHaveLength(0);
   const dashboard=await new ProductionDashboardService(f.db,new ProductionReportingService(f.db),()=>businessNow()).detail(qc,e.productionId,e.factoryDecisionId);
   expect(dashboard.progress).toMatchObject({progressState:'pending_first_report',qcObservation:{state:'not_due'},completedQuantity:0});
  });
 });
 it('uses the real HTTP upload, finalize, private download and same QC quantity transaction without broadening generic uploads',async()=>{
  const ready=await dispatch(),e=(await service.read(qc,ready.id)).executions[0]!,app=Fastify();
  app.setErrorHandler((error,_request,reply)=>reply.code(Number((error as {statusCode?:number}).statusCode??500)).send({error:{message:error.message}}));
  registerQcProductionProgressRoutes(app,{service:undefined as never,creationEnabled:true,authenticate:async token=>{const person=token==='TEST-qc'?qc:ready.primary;return {id:person.actorId,displayName:'TEST original user',businessRoles:person.actorRoles,capabilities:person.authorizationCapabilities!};}},service,f.attachments);
  const url=`/digital-production/orders/${ready.id}/qc-progress`,headers={cookie:'dx_rework_session=TEST-qc'};
  try{
   const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer(),upload={filename:'TEST-QC.png',mimeType:'image/png',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
   const invalid=await app.inject({method:'POST',url:url+'/upload-intents',headers,payload:{factoryDecisionId:e.factoryDecisionId,scopeRevision:e.scopeRevision,upload:{...upload,filename:'TEST.plt',mimeType:'application/octet-stream'}}});expect(invalid.statusCode).toBe(400);
   const intentResponse=await app.inject({method:'POST',url:url+'/upload-intents',headers,payload:{factoryDecisionId:e.factoryDecisionId,scopeRevision:e.scopeRevision,upload}});expect(intentResponse.statusCode).toBe(200);const intent=intentResponse.json();
   await f.storage.writeImmutable(intent.uploadFields.key,bytes,{mimeType:'image/png',sha256:upload.sha256});
   const finalized=await app.inject({method:'POST',url:url+`/attachments/${intent.attachmentId}/finalize`,headers,payload:{}});expect(finalized.statusCode).toBe(200);
   const body={...input(e,1),attachmentIds:[intent.attachmentId]},saved=await app.inject({method:'POST',url,headers,payload:body});expect(saved.statusCode).toBe(200);expect(saved.json()).toMatchObject({committed:true,submissionId:body.submissionId});
   expect((await app.inject({method:'POST',url,headers,payload:body})).json()).toEqual(saved.json());expect((await service.read(qc,ready.id)).executions[0]!.records).toHaveLength(1);
   const download=await app.inject({method:'GET',url:url+`/attachments/${intent.attachmentId}`,headers});expect(download.statusCode).toBe(302);expect(download.headers.location).toContain('https://private.example.test/');
   expect((await app.inject({method:'GET',url:`/digital-production/orders/${randomUUID()}/qc-progress/attachments/${intent.attachmentId}`,headers})).statusCode).toBeGreaterThanOrEqual(400);
   const denied=await app.inject({method:'POST',url,headers:{cookie:'dx_rework_session=TEST-primary'},payload:{...body,submissionId:randomUUID()}});expect(denied.statusCode).toBe(403);
  }finally{await app.close();}
 });
 it('honors real readonly-member policy for management writes, replay and reminder routing while retaining Root',async()=>{
  const manager=f.people['production-management']!,owner=f.people.owner!;
  await f.access.assignRole(f.root,{userId:manager.actorId,roleCode:'owner_group',reason:'TEST isolated readonly owner policy fixture'});
  await f.access.assignRole(f.root,{userId:manager.actorId,roleCode:'quality_control',reason:'TEST isolated combined owner/QC policy fixture'});
  const readonly={...manager,actorRoles:[...new Set([...manager.actorRoles,'owner_group','quality_control'])],authorizationCapabilities:[...manager.authorizationCapabilities!,QC_PROGRESS_CAPABILITY]},scene=await f.scene('2026-11-12T00:00:00Z');
  let ready!:Awaited<ReturnType<typeof dispatch>>,key!:string;
  await f.runtime.run(scene,f.root,async()=>{ready=await dispatch();await tasks.reassign(f.root,ready.taskId,readonly.actorId,randomUUID());key=randomUUID();await service.settingsCommand(readonly,ready.id,{expectedVersion:0,qualityLeadId:readonly.actorId},key);});
  // Original Root-audited binding command, outside the business scenario; no trigger disabling.
  await new MemberModuleBindingService(f.db).run(f.root.actorId,{li_zhonghao:owner.actorId,wu_yunfeng:readonly.actorId,li_junyue:f.root.actorId},true);
  await f.advance(scene,'2026-11-15T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const sheet=await service.read(readonly,ready.id);expect(sheet).toMatchObject({canManage:false,canRecord:false});
   await expect(service.settingsCommand(readonly,ready.id,{expectedVersion:0,qualityLeadId:readonly.actorId},key)).rejects.toMatchObject({statusCode:403});
   const e=(await service.read(f.root,ready.id)).executions[0]!;
   await expect(service.adopt(readonly,ready.id,{factoryDecisionId:e.factoryDecisionId,expectedScopeRevision:e.scopeRevision,reason:'TEST readonly cannot adopt'},randomUUID())).rejects.toMatchObject({statusCode:403});
   const people=[...Object.values(f.people).filter(p=>p.actorId!==readonly.actorId),readonly],notices=await qcProgressNotices(f.db,people,ready.id);
   expect(notices.length).toBeGreaterThan(0);expect(notices.every(n=>!n.recipients.includes(readonly.actorId))).toBe(true);
   await expect(service.settingsCommand(f.root,ready.id,{expectedVersion:1,qualityLeadId:qc.actorId},randomUUID())).resolves.toMatchObject({committed:true,version:2});
  });
 });
 it('retires a genuine previous-schema pending task without completed facts or losing queued/history records',async()=>{
  const old=await businessAnchorFixture(url!,{throughVersion:'0270_production_readiness_materials'});try{
   const primary=old.people.merchandiser!,designer=old.people['sample-designer']!,identity=new DigitalProductionIdentityService(old.db,true),order=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:`TEST-LEGACY-${randomUUID()}`,orderDate:beijingCalendarDate(businessNow()),primaryMerchandiserId:primary.actorId,lines:[{formalPoNo:randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-08-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID());
   const id=randomUUID();await old.db.query("INSERT INTO digital_production_task_access(task_id,production_order_id,task_kind,required_role,assignee_id,created_by) VALUES($1,$2,'factory_material_count','order_merchandiser',$3,$4)",[id,order.productionOrderId,primary.actorId,old.root.actorId]);await old.db.query("INSERT INTO digital_production_tasks(task_id,node_key,state,route_version,occurrence,route_instance_id) VALUES($1,'factory_material_count','pending',1,1,$2)",[id,randomUUID()]);
   const oldEvent=randomUUID();await old.db.query("INSERT INTO digital_production_notification_events(event_id,source_key,task_id,event_kind) VALUES($1,$2,$3,'ready')",[oldEvent,`TEST-retired:${oldEvent}`,id]);await old.db.query('INSERT INTO digital_production_notification_receipts(event_id,recipient_id,source_event_id,shown_at) VALUES($1,$2,$1,CURRENT_TIMESTAMP)',[oldEvent,primary.actorId]);
   const manifest=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8')),row=manifest.migrations.find((m:{version:string})=>m.version==='0271_qc_production_progress'),sql=await readFile(new URL('../../apps/api/migrations/0271_qc_production_progress.sql',import.meta.url),'utf8');
   await old.db.query(migrationExecutionSql({...row,sql},Number((await old.db.query('SHOW server_version_num')).rows[0].server_version_num)));await old.db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[row.version,row.checksum]);
   expect((await old.db.query('SELECT state,completed_at FROM digital_production_tasks WHERE task_id=$1',[id])).rows[0]).toEqual({state:'cancelled',completed_at:null});
   expect((await new DigitalProductionNotificationService(old.db).current(primary,oldEvent)).notification).toBeNull();
   expect((await old.db.query('SELECT previous_state FROM digital_factory_task_retirements WHERE task_id=$1',[id])).rows[0].previous_state).toBe('pending');
   const taskService=new DigitalProductionTaskService(old.db);expect(await taskService.read(old.root,id)).toMatchObject({retiredRule:'20261101.factory-receipt-retired',canExecute:false,dueAt:null});
   expect((await taskService.list(old.root,1)).items.some(t=>t.taskId===id)).toBe(false);
   await expect(taskService.complete(old.root,id,{note:'TEST cannot revive retired action'},randomUUID())).rejects.toMatchObject({statusCode:410});
   await expect(old.db.query("INSERT INTO digital_production_task_access(task_id,production_order_id,task_kind,required_role,created_by) VALUES($1,$2,'factory_material_count','order_merchandiser',$3)",[randomUUID(),order.productionOrderId,old.root.actorId])).rejects.toMatchObject({code:'55000'});
  }finally{await old.dispose();}
 });
});
