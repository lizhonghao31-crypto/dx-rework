import { physicalCuttingLabelsFixture } from '../helpers/production-readiness-fixture.js';
import { ProductionReadinessService } from '../../apps/api/src/production-platform/production-readiness-service.js';
import { registerDigitalTaskRoutes } from '../../apps/api/src/production-platform/task-routes.js';
import { withAcceptanceBusinessTime, installAcceptanceClockReader } from '../../apps/api/src/acceptance-clock/business-time.js';
import { reworkSlaEvidence } from '../../apps/api/src/production-platform/rework-sla-evidence.js';
import { linkNewDigitalChild } from '../../apps/api/src/production-platform/child-link-repository.js';
import { registerGarmentReceipt } from '../../apps/api/src/production-platform/garment-quality.js';
import { SlaConfigurationRepository } from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import { SlaConfigurationService } from '../../apps/api/src/production-platform/sla-configuration-service.js';
import { factoryReturnLogistics } from '../../apps/api/src/production-platform/factory-return-logistics.js';
import { factoryProductionFacts } from '../../apps/api/src/production-platform/factory-production-facts.js';
import { shipSampleTargets } from '../../apps/api/src/production-platform/ship-sample-timing.js';
import { shipSampleSlaEvidence } from '../../apps/api/src/production-platform/ship-sample-facts.js';
import { registerFactoryFlowRoutes } from '../../apps/api/src/production-platform/factory-flow-routes.js';
import { BulkPreparationService } from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import { bulkFabricDecisionTodos } from "../../apps/api/src/production-platform/bulk-fabric-todos.js";
import { todoDestination } from "../../packages/contracts/src/todo-destination.js";
import { SlaOrderService } from "../../apps/api/src/production-platform/sla-order-service.js";
import { SeriesPlanService } from "../../apps/api/src/production-platform/series-plan-service.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { registerBulkPreparationRoutes } from "../../apps/api/src/production-platform/bulk-preparation-routes.js";
import { registerCuttingRoutes } from "../../apps/api/src/cutting/cutting-routes.js";
import { PoCustomerDateService } from "../../apps/api/src/production-platform/po-customer-date-service.js";
import { ProductionInstructionService } from "../../apps/api/src/production-platform/production-instruction-service.js";
import Fastify from "fastify";
import { registerDigitalAnalysisRoutes } from "../../apps/api/src/production-platform/reporting-routes.js";
import { DigitalAnalysisFilterSchema } from "@dx-rework/contracts/digital-production-analysis";
import { DigitalAnalysisQuery } from "../../apps/api/src/production-platform/reporting-query.js";
import { DigitalCockpitQuery } from "../../apps/api/src/production-platform/cockpit-query.js";
import { DigitalJourneyQuery } from "../../apps/api/src/production-platform/journey-query.js";
import { OrderClosureService } from "../../apps/api/src/production-platform/order-closure-service.js";
import { ProductionClosureService } from "../../apps/api/src/sourcing/production-closure-service.js";
import { DigitalProductionAccessService } from "../../apps/api/src/production-platform/access-service.js";
import { exerciseOrderClosure } from "../helpers/order-closure-fixture.js";
import { FactoryFlowService } from "../../apps/api/src/production-platform/factory-flow-service.js";
import { exerciseBulkPreparation, exerciseParallelTechnical } from "../helpers/bulk-preparation-fixture.js";
import { exerciseInstructions } from "../helpers/production-instruction-fixture.js";
import { DigitalDevelopmentService } from "../../apps/api/src/production-platform/development-service.js";
import { DevelopmentRoundService } from "../../apps/api/src/production-platform/development-round-service.js";
import { DevelopmentExecutionService } from "../../apps/api/src/production-platform/development-execution-service.js";
import { unzipSync } from "fflate";
import type * as CryptoModule from "node:crypto";
import { ProductionDashboardService } from "../../apps/api/src/sourcing/production-dashboard-service.js";
import { ProductionReportingService } from "../../apps/api/src/sourcing/production-reporting-service.js";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { DigitalBudgetService } from "../../apps/api/src/production-platform/budget-service.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionNotificationService } from "../../apps/api/src/production-platform/notification-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { digitalTodoOrder } from "../../apps/api/src/production-platform/notification-policy.js";
import { CuttingSourceService } from "../../apps/api/src/cutting/cutting-source-service.js";
import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { type TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { sourcingFixture } from "../helpers/sourcing-pr03-fixture.js";
vi.mock("node:crypto",async importOriginal=>{
  const actual=await importOriginal<typeof CryptoModule>();
  return {...actual,randomUUID:vi.fn(actual.randomUUID)};
});


const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("sourcing PR03-PR05 PostgreSQL business chain", () => {
  const { database, contractStorage, attachments, contractService, contractReturns, service, cutting, receiving, production, craftId, merchandiserId, ieId, managerId, ownerId, factoryId, replacementFactoryId, readyCuttingSheet, merchandiserActor, ieActor, managerActor, ownerActor, contractActor, financeActor, readerActor, rootActor, budgetFixture, cycleTodoServices, cycleSnapshot } = sourcingFixture(databaseUrl!);

  const withSla09Standard=async<T,>(action:(tasks:DigitalProductionTaskService,baseline:Awaited<ReturnType<DigitalProductionTaskService['slaSettings']>>)=>Promise<T>)=>{
    const tasks=new DigitalProductionTaskService(database,'TEST settings preview secret'),baseline=await tasks.slaSettings(rootActor());
    const restore=async()=>{
      const db=await database.connect();
      try{
        await db.query('BEGIN');const repo=new SlaConfigurationRepository(db),current=(await repo.current())!;
        await repo.publish({expectedVersion:current.version,values:baseline.values,actorId:merchandiserId,reason:'TEST restore original defaults after isolated settings case',requestKey:randomUUID()});
        await db.query('COMMIT');
      }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
    };
    try{return await action(tasks,baseline);}finally{await restore();}
  };
  it('SLA09 publishes only new-order defaults with strict signed preview, original policy storage and active three-role permissions',async()=>{
    const fixture=await budgetFixture();await withSla09Standard(async(tasks,baseline)=>{
      for(const actor of [rootActor(),managerActor(),ownerActor()])expect((await tasks.slaSettings(actor)).version).toBe(baseline.version);
      await expect(tasks.slaSettings(fixture.designer)).rejects.toMatchObject({statusCode:403});
      const before=(await database.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision',[fixture.order.productionOrderId])).rows;
      const draft={expectedVersion:baseline.version,values:{...baseline.values,production_sheet:{kind:'duration' as const,minutes:5760}},reason:'TEST new standard only'};
      const preview=await tasks.previewSlaSettings(ownerActor(),draft);
      await expect(tasks.publishSlaSettings(managerActor(),{...draft,previewToken:preview.token},randomUUID())).rejects.toMatchObject({statusCode:409});
      await expect(tasks.publishSlaSettings(ownerActor(),{...draft,reason:'tampered',previewToken:preview.token},randomUUID())).rejects.toMatchObject({statusCode:409});
      const key=randomUUID(),body={...draft,previewToken:preview.token},published=await tasks.publishSlaSettings(ownerActor(),body,key);
      expect(published).toMatchObject({version:baseline.version+1,scope:'new_orders',existingOrdersChanged:0});
      expect(await tasks.publishSlaSettings(ownerActor(),body,key)).toEqual(published);
      expect((await database.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision',[fixture.order.productionOrderId])).rows).toEqual(before);
      const newer=await budgetFixture(false,'TEST-SLA09-NEW');
      expect((await database.query('SELECT parameters_json FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision LIMIT 1',[newer.order.productionOrderId])).rows[0].parameters_json.production_sheet.value.minutes).toBe(5760);
      await expect(tasks.publishSlaSettings(ownerActor(),body,randomUUID())).rejects.toMatchObject({statusCode:409});
      const invalid={...draft,expectedVersion:published.version,values:{...draft.values,development_sewing:{kind:'duration' as const,minutes:5}}};
      await expect(tasks.previewSlaSettings(rootActor(),invalid)).rejects.toMatchObject({statusCode:400});
    });
  });
  it('SLA09 explicitly applies selected unfinished windows without changing P0, actual starts, completed targets or unselected parameter provenance',async()=>{
    const fixture=await budgetFixture(false,"TEST-PRE0270-SLA","2026-11-20",true);await withSla09Standard(async(tasks,baseline)=>{
      const ready=await exerciseParallelTechnical(database,fixture,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root:rootActor()});
      const inspected=await ready.bulk.reportFabric(ready.warehouse,ready.id,{expectedReportId:null,material:'TEST whole fabric',arrivedAt:new Date(Date.now()-41*3600000).toISOString(),inspectedAt:new Date(Date.now()-40*3600000).toISOString(),result:'合格',note:'TEST actual original receipt'},randomUUID());
      const oldTask=inspected.tasks.find(t=>t.taskKind==='warehouse_preshrink')!,sla=new SlaOrderService(database),before=await sla.read(rootActor(),ready.id);expect(before.status).toBe('planned');if(before.status!=='planned')throw new Error('missing initial plan');
      const notifications=new DigitalProductionNotificationService(database);await notifications.runOnce();
      const overdueCount=async()=>Number((await database.query("SELECT count(*) n FROM digital_production_notification_events WHERE task_id=$1 AND event_kind='overdue'",[oldTask.taskId])).rows[0].n);expect(await overdueCount()).toBe(1);
      const draft={expectedVersion:baseline.version,values:{...baseline.values,warehouse_preshrink:{kind:'duration' as const,minutes:4320},production_sheet:{kind:'duration' as const,minutes:5760}},reason:'TEST two values, only apply one'};
      const standard=await tasks.previewSlaSettings(rootActor(),draft),published=await tasks.publishSlaSettings(rootActor(),{...draft,previewToken:standard.token},randomUUID());
      expect((await ready.bulk.read(rootActor(),ready.id)).tasks.find(t=>t.taskKind==='warehouse_preshrink')?.dueAt).toBe(oldTask.dueAt);
      const selection={orderId:ready.id,configurationVersion:published.version,parameterKeys:['warehouse_preshrink'],reason:'TEST only selected active window'};
      const preview=await tasks.previewSlaOrder(rootActor(),selection);expect(preview.changes.some(n=>n.nodeId==='warehouse_preshrink')).toBe(true);
      const snapshotsBefore=(await database.query('SELECT count(*) n FROM digital_sla_order_snapshots WHERE production_order_id=$1',[ready.id])).rows[0].n;
      const failure=vi.spyOn(DigitalProductionTaskService.prototype,'applySlaVersionWithClient').mockRejectedValueOnce(new Error('TEST downstream failure'));
      try{await expect(tasks.applySlaOrder(rootActor(),{...selection,previewToken:preview.token},randomUUID())).rejects.toThrow('downstream failure');}finally{failure.mockRestore();}
      expect((await database.query('SELECT count(*) n FROM digital_sla_order_snapshots WHERE production_order_id=$1',[ready.id])).rows[0].n).toBe(snapshotsBefore);
      const key=randomUUID(),body={...selection,previewToken:preview.token},result=await tasks.applySlaOrder(rootActor(),body,key);expect(await tasks.applySlaOrder(rootActor(),body,key)).toEqual(result);
      const after=await sla.read(rootActor(),ready.id);expect(after.status).toBe('planned');if(after.status!=='planned')throw new Error('missing applied plan');
      expect(after.original).toEqual(before.original);expect(after.current.revision).toBe(before.current.revision+1);
      expect(after.nodes.find(n=>n.id==='warehouse_preshrink')?.actualStart).toBe(before.nodes.find(n=>n.id==='warehouse_preshrink')?.actualStart);
      expect(after.nodes.find(n=>n.id==='production_sheet')).toEqual(before.nodes.find(n=>n.id==='production_sheet'));
      const updated=(await ready.bulk.read(rootActor(),ready.id)).tasks.find(t=>t.taskKind==='warehouse_preshrink')!;
      const supervised=await new DigitalJourneyQuery(database).read(rootActor(),ready.id,undefined,true);
      expect(supervised.supervision?.nodes.find(n=>n.id==='warehouse_preshrink')?.target.at).toBe(updated.dueAt);
      expect(supervised.supervision?.originalRevision).toBe(before.original.revision);expect(supervised.supervision?.currentRevision).toBe(after.current.revision);
      expect(Date.parse(updated.dueAt!)-Date.parse(oldTask.dueAt!)).toBe(36*3600000);
      const snapshot=(await database.query('SELECT parameters_json FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[ready.id])).rows[0].parameters_json;
      expect(snapshot.warehouse_preshrink.sourceVersion).toBe(published.version);expect(snapshot.production_sheet).toEqual((await database.query('SELECT parameters_json FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision LIMIT 1',[ready.id])).rows[0].parameters_json.production_sheet);
      await expect(tasks.applySlaOrder(rootActor(),body,randomUUID())).rejects.toMatchObject({statusCode:409});
      await notifications.runOnce();expect(await overdueCount()).toBe(1);
      const latest=await tasks.slaSettings(rootActor()),shorter={expectedVersion:latest.version,values:{...latest.values,warehouse_preshrink:{kind:'duration' as const,minutes:2160}},reason:'TEST shorten same actual window'},shortPreview=await tasks.previewSlaSettings(rootActor(),shorter),shortPublished=await tasks.publishSlaSettings(rootActor(),{...shorter,previewToken:shortPreview.token},randomUUID());
      const selectedAgain={...selection,configurationVersion:shortPublished.version},previewAgain=await tasks.previewSlaOrder(rootActor(),selectedAgain);
      await tasks.applySlaOrder(rootActor(),{...selectedAgain,previewToken:previewAgain.token},randomUUID());await notifications.runOnce();expect(await overdueCount()).toBe(1);
      const retained=(await database.query("SELECT payload->'previousEvaluations' AS evaluations FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='sla_standard_applied' ORDER BY recorded_at,event_id LIMIT 1",[ready.id])).rows[0].evaluations;
      expect(retained.find((n:{id:string})=>n.id==='warehouse_preshrink').status).toBe('overdue');

      await ready.bulk.complete(ready.warehouse,ready.id,{preparationId:ready.preparationId,kind:'预缩完成'},randomUUID());
      expect((await ready.bulk.read(rootActor(),ready.id)).tasks.find(t=>t.taskKind==='warehouse_preshrink')?.state).toBe('completed');
    });
  });

  it('SLA09 keeps sourcing work area, plan and original todo on the same explicitly applied window across the original return and correction flow',async()=>{
    const fixture=await budgetFixture(),id=fixture.order.productionOrderId,primary=merchandiserActor();
    await withSla09Standard(async(tasks,baseline)=>{
      await fixture.budget.save(fixture.designer,id,{expectedVersion:1,document:fixture.document},randomUUID());await fixture.budget.publish(primary,id,2,randomUUID());
      const prepared=await fixture.budget.prepareSourcing(primary,id,2,attachments),{service:currentService}=await cycleTodoServices();
      const created=await currentService.createCase(primary,{gender:prepared.gender,styleName:prepared.styleName,deliveryDate:'2026-11-10',estimatedCutPieceSendDate:'2026-10-20',daxingUnitPrice:prepared.daxingUnitPrice,attachmentIds:prepared.images.map(i=>i.attachmentId),lineItems:prepared.lineItems.map(({lineId,styleNo,alternateStyleNo,color,quantity})=>({lineId,styleNo,alternateStyleNo,color,quantity,factoryDeliveryDate:'2026-11-10'})),digitalBudget:{productionOrderId:id,budgetVersion:prepared.budgetVersion,orderVersion:prepared.orderVersion}},randomUUID());
      const caseId=created.value.sourcingCaseId,original=(await database.query("SELECT * FROM rework_todos WHERE entity_type='sourcing_case' AND entity_id=$1 AND category='sourcing_ie_quote' ORDER BY created_at,todo_id LIMIT 1",[caseId])).rows[0];
      const reader={...ieActor(),authorizationCapability:'todo:view',authorizationCapabilities:['sourcing:view','sourcing:price:quote','todo:view']},todos=new TodoService(database),before=await todos.getForActor(reader,original.todo_id),sla=new SlaOrderService(database),first=await sla.read(rootActor(),id);
      expect(first.status).toBe('planned');if(first.status!=='planned')throw new Error('missing plan');
      expect(first.nodes.find(n=>n.id==='sourcing_ie')?.deadline.at).toBe(before.dueAt);
      const shifted={connect:database.connect.bind(database),query:database.query.bind(database)} as unknown as pg.Pool;
      let sceneNow=new Date(Date.parse(before.dueAt!)+1800000).toISOString();
      installAcceptanceClockReader(shifted,{read:async scope=>scope.id===id?{now:sceneNow,scenarioId:null,revision:0}:null,nativeScenario:async()=>null});
      const notices=new DigitalProductionNotificationService(shifted),wall=vi.spyOn(Date,'now').mockReturnValue(Date.parse(sceneNow));
      try{await notices.runOnce();}finally{wall.mockRestore();}
      const notice=(await database.query("SELECT * FROM digital_production_notification_events WHERE todo_id=$1 AND event_kind='overdue'",[original.todo_id])).rows[0];expect(notice).toBeTruthy();
      const unreadBefore=(await notices.current(reader,notice.event_id,true)).remainingCount!;expect(unreadBefore).toBeGreaterThan(0);
      const draft={expectedVersion:baseline.version,values:{...baseline.values,sourcing_ie:{kind:'duration' as const,minutes:180}},reason:'TEST IE three hours only'};
      const standard=await tasks.previewSlaSettings(rootActor(),draft),published=await tasks.publishSlaSettings(rootActor(),{...draft,previewToken:standard.token},randomUUID()),selection={orderId:id,configurationVersion:published.version,parameterKeys:['sourcing_ie'],reason:'TEST selected IE native window'};
      const preview=await tasks.previewSlaOrder(rootActor(),selection);await tasks.applySlaOrder(rootActor(),{...selection,previewToken:preview.token},randomUUID());
      const after=await todos.getForActor(reader,original.todo_id),evaluation=await sla.read(rootActor(),id);expect(Date.parse(after.dueAt!)-Date.parse(before.dueAt!)).toBe(3600000);
      expect((await notices.current(reader,notice.event_id,true)).remainingCount).toBe(unreadBefore-1);
      await database.query('UPDATE digital_production_notification_receipts SET shown_at=CURRENT_TIMESTAMP WHERE event_id=$1 AND recipient_id=$2',[notice.event_id,reader.actorId]);
      expect((await notices.current(reader,notice.event_id)).notification).toBeNull();
      sceneNow=after.dueAt!;expect((await notices.current(reader,notice.event_id)).notification).toMatchObject({eventId:notice.event_id,actionable:true});
      sceneNow=new Date(Date.parse(after.dueAt!)+1).toISOString();expect((await notices.current(reader,notice.event_id)).notification).toMatchObject({eventId:notice.event_id});
      const dueScan=vi.spyOn(Date,'now').mockReturnValue(Date.parse(sceneNow));
      try{await notices.runOnce();await notices.runOnce();}finally{dueScan.mockRestore();}
      expect((await database.query("SELECT * FROM digital_production_notification_events WHERE todo_id=$1 AND event_kind='overdue'",[original.todo_id])).rows).toEqual([notice]);
      expect((await notices.current({...reader,authorizationCapabilities:['todo:view','sourcing:view']},notice.event_id)).notification).toBeNull();
      expect((await notices.current({...reader,actorId:randomUUID()},notice.event_id)).notification).toBeNull();
      expect(evaluation.status).toBe('planned');if(evaluation.status!=='planned')throw new Error('missing applied plan');
      expect(evaluation.nodes.find(n=>n.id==='sourcing_ie')?.deadline.at).toBe(after.dueAt);expect(evaluation.nodes.find(n=>n.id==='sourcing_ie')?.actualStart).toBe(first.nodes.find(n=>n.id==='sourcing_ie')?.actualStart);
      const supervised=await new DigitalJourneyQuery(database).read(rootActor(),id,undefined,true);
      expect(supervised.supervision?.nodes.find(n=>n.id==='sourcing_ie')?.target.at).toBe(after.dueAt);
      expect(after.timing?.warningAt).toBe(new Date(Date.parse(first.nodes.find(n=>n.id==='sourcing_ie')!.actualStart!)+(Date.parse(after.dueAt!)-Date.parse(first.nodes.find(n=>n.id==='sourcing_ie')!.actualStart!))*0.7).toISOString());
      expect((await database.query('SELECT due_at,reminder_count FROM rework_todos WHERE todo_id=$1',[original.todo_id])).rows[0]).toMatchObject({due_at:original.due_at,reminder_count:original.reminder_count});
      // Ordinary reassignment/read must not replace the selected application or reset the responsibility window.
      await tasks.slaSettings(rootActor());expect((await todos.getForActor(reader,original.todo_id)).dueAt).toBe(after.dueAt);
      const prices=prepared.lineItems.map((_,i)=>({position:i+1,unitPrice:'5.25'})),quoted=await currentService.quoteIePrice(ieActor(),caseId,{linePrices:prices},randomUUID());
      const returned=await currentService.returnToMerchandiser(ownerActor(),caseId,{expectedVersion:quoted.value.version,reason:'TEST retain applied deadline'},randomUUID());
      await currentService.correctCase(primary,caseId,{gender:prepared.gender,styleName:prepared.styleName,deliveryDate:'2026-11-10',estimatedCutPieceSendDate:'2026-10-20',attachmentIds:prepared.images.map(i=>i.attachmentId),lineItems:prepared.lineItems.map(({lineId,styleNo,alternateStyleNo,color,quantity})=>({lineId,styleNo,alternateStyleNo,color,quantity,factoryDeliveryDate:'2026-11-10'})),expectedVersion:returned.value.version,reason:'TEST original correction'},randomUUID());
      const nextTodo=(await database.query("SELECT * FROM rework_todos WHERE entity_id=$1 AND category='sourcing_ie_quote' AND status='pending' ORDER BY created_at DESC LIMIT 1",[caseId])).rows[0];
      expect(nextTodo.due_at.toISOString()).toBe(after.dueAt);expect((await todos.getForActor(reader,nextTodo.todo_id)).dueAt).toBe(after.dueAt);
      const retried=await sla.read(rootActor(),id);if(retried.status!=='planned')throw new Error('missing retry plan');
      expect(retried.nodes.find(n=>n.id==='sourcing_ie')).toMatchObject({actualStart:first.nodes.find(n=>n.id==='sourcing_ie')!.actualStart,actualEnd:null,deadline:{at:after.dueAt}});

    });
  });

  it('SLA09 rejects stale native facts and serializes concurrent commands without partial snapshots or changing business gates',async()=>{
    const fixture=await budgetFixture(false,"TEST-PRE0270-SLA","2026-11-20",true);await withSla09Standard(async(tasks,baseline)=>{
      const ready=await exerciseParallelTechnical(database,fixture,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root:rootActor()});
      const draft={expectedVersion:baseline.version,values:{...baseline.values,warehouse_preshrink:{kind:'duration' as const,minutes:4320}},reason:'TEST frozen preview'};
      const standard=await tasks.previewSlaSettings(rootActor(),draft),published=await tasks.publishSlaSettings(rootActor(),{...draft,previewToken:standard.token},randomUUID()),selection={orderId:ready.id,configurationVersion:published.version,parameterKeys:['warehouse_preshrink'],reason:'TEST stale actual evidence'};
      const preview=await tasks.previewSlaOrder(rootActor(),selection);
      await ready.bulk.reportFabric(ready.warehouse,ready.id,{expectedReportId:null,material:'TEST shared actual fabric',arrivedAt:new Date(Date.now()-3600000).toISOString(),inspectedAt:new Date(Date.now()-1800000).toISOString(),result:'合格',note:'TEST changed original facts'},randomUUID());
      await expect(tasks.applySlaOrder(rootActor(),{...selection,previewToken:preview.token},randomUUID())).rejects.toMatchObject({statusCode:409});
      const fresh=await tasks.previewSlaOrder(rootActor(),selection),body={...selection,previewToken:fresh.token},key=randomUUID();
      const results=await Promise.allSettled([tasks.applySlaOrder(rootActor(),body,key),tasks.applySlaOrder(rootActor(),body,key)]);
      expect(results.some(r=>r.status==='fulfilled')).toBe(true);for(const r of results)if(r.status==='rejected')expect(r.reason).toMatchObject({statusCode:409});
      const response=await tasks.applySlaOrder(rootActor(),body,key);expect(response.orderId).toBe(ready.id);
      expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='sla_standard_applied'",[ready.id])).rows[0].n).toBe(1);
      // No trustworthy cutter receipt is created, and applying a standard does not complete any task.
      const current=await ready.bulk.read(rootActor(),ready.id);expect(current.tasks.find(t=>t.taskKind==='warehouse_preshrink')?.state).toBe('ready');
      expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='cutting_fabric_actually_received'",[ready.id])).rows[0].n).toBe(0);
      const disabled={...managerActor()};await database.query('UPDATE identity_mappings SET active=false WHERE user_id=$1',[disabled.actorId]);
      try{await expect(tasks.previewSlaOrder(disabled,selection)).rejects.toMatchObject({statusCode:403});}finally{await database.query('UPDATE identity_mappings SET active=true WHERE user_id=$1',[disabled.actorId]);}
    });
  });

  it('SLA09 HTTP routes enforce authentication, active role, typed inputs, signed previews and exact idempotent publication',async()=>{
    await cycleTodoServices();await withSla09Standard(async(tasks,baseline)=>{
      const app=Fastify();app.setErrorHandler((error,_request,reply)=>{const known=error as ApplicationError;reply.code(known.statusCode??500).send({code:known.code,message:known.message});});
      registerDigitalTaskRoutes(app,{service:new DigitalProductionIdentityService(database,true),creationEnabled:true,authenticate:async token=>{
        if(token!=='owner'&&token!=='manager'&&token!=='ordinary')throw new ApplicationError('UNAUTHORIZED','请登录',401);
        return {id:token==='owner'?ownerId:token==='manager'?managerId:merchandiserId,displayName:'TEST HTTP actor',businessRoles:[token==='owner'?'owner_group':token==='manager'?'production_management':'order_merchandiser'],capabilities:[]};
      }},tasks);
      try{
        await app.ready();const headers={cookie:'dx_rework_session=owner'},base='/digital-production/sla-settings';
        expect((await app.inject({method:'GET',url:base})).statusCode).toBe(401);
        expect((await app.inject({method:'GET',url:base,headers:{cookie:'dx_rework_session=ordinary'}})).statusCode).toBe(403);
        expect((await app.inject({method:'GET',url:base,headers:{cookie:'dx_rework_session=manager'}})).statusCode).toBe(200);
        const draft={expectedVersion:baseline.version,values:{...baseline.values,warning_ratio:{kind:'ratio',percent:80}},reason:'TEST typed HTTP standard'};
        for(const value of [{...draft,values:{...draft.values,warning_ratio:{kind:'ratio',percent:0}}},{...draft,values:{...draft.values,production_sheet:{kind:'duration',minutes:-1}}},{...draft,unexpected:true}])expect((await app.inject({method:'POST',url:base+'/preview',headers,payload:value})).statusCode).toBe(400);
        const preview=await app.inject({method:'POST',url:base+'/preview',headers,payload:draft});expect(preview.statusCode).toBe(200);const body={...draft,previewToken:preview.json().token},writeHeaders={...headers,'idempotency-key':randomUUID()};
        expect((await app.inject({method:'POST',url:base+'/publish',headers,payload:body})).statusCode).toBe(400);
        const published=await app.inject({method:'POST',url:base+'/publish',headers:writeHeaders,payload:body});expect(published.statusCode).toBe(200);expect((await app.inject({method:'POST',url:base+'/publish',headers:writeHeaders,payload:body})).json()).toEqual(published.json());
        const historicalVersion=baseline.version||published.json().version,historical=await app.inject({method:'GET',url:`${base}?version=${historicalVersion}`,headers});expect(historical.statusCode).toBe(200);expect(historical.json().values).toEqual(baseline.version?baseline.values:draft.values);
        expect((await app.inject({method:'GET',url:base+'?version=-1',headers})).statusCode).toBe(400);
      }finally{await app.close();}
    });
  });


  it('SLA09 rejects an invalid partial included target as a known validation failure without opening another business gate',async()=>{
    const fixture=await budgetFixture();await withSla09Standard(async(tasks,baseline)=>{
      const draft={expectedVersion:baseline.version,values:{...baseline.values,development_sewing:{kind:'duration' as const,minutes:10},development_sewing_transfer:{kind:'included' as const,minutes:5}},reason:'TEST internally valid future standard'};
      const preview=await tasks.previewSlaSettings(rootActor(),draft),published=await tasks.publishSlaSettings(rootActor(),{...draft,previewToken:preview.token},randomUUID());
      await expect(tasks.previewSlaOrder(rootActor(),{orderId:fixture.order.productionOrderId,configurationVersion:published.version,parameterKeys:['development_sewing'],reason:'TEST invalid subset keeps old 30-minute included target'})).rejects.toMatchObject({statusCode:400,code:'VALIDATION_ERROR'});
      expect((await database.query('SELECT count(*)::int n FROM digital_sla_order_snapshots WHERE production_order_id=$1',[fixture.order.productionOrderId])).rows[0].n).toBe(1);
    });
  });
  it('R2 task document directory preserves independent budget rights and exact development round',async()=>{
    const fixture=await budgetFixture(false,"TEST-R2"),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true}))!;
    const tasks=new DigitalProductionTaskService(database),worker=ready.people.pattern_room_worker!,client=await database.connect();let taskId:string;
    try{await client.query('BEGIN');
      // The new technical prerequisite already creates this exact round's paper task.
      // Reuse it rather than inventing a duplicate task to test its document rights.
      const existing=(await client.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_pattern' AND t.route_version=1 AND t.occurrence=1",[ready.sourceId])).rows[0];
      taskId=existing?.task_id??(await tasks.createWithClient(client,root,{resource:{kind:'source',id:ready.sourceId},kind:'development_pattern',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:worker.actorId})).taskId;
      await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const full=await tasks.documents(root,taskId);
    expect(full).toMatchObject({development:{state:'published',id:ready.sourceId,version:1},instruction:{state:'published',id:ready.id,version:1},budget:{state:'published',id:ready.id,version:2}});
    const limited=await tasks.documents(worker,taskId);
    expect(limited.development).toEqual(full.development);
    expect((await new DigitalDevelopmentService(database,true).read(worker,ready.sourceId)).sourceId).toBe(ready.sourceId);
    expect(limited.budget).toEqual({state:'unavailable'});expect(JSON.stringify(limited)).not.toMatch(/salePrice|unitPrice|attachmentId/);
    const stranger=await budgetFixture();await expect(tasks.documents(stranger.designer,taskId)).rejects.toMatchObject({statusCode:404});
    expect(await tasks.resourceDocuments(root,'source',ready.sourceId)).toEqual({development:{state:'available',id:ready.sourceId},instruction:{state:'available',id:ready.id},budget:{state:'available',id:ready.id}});
    expect((await tasks.resourceDocuments(worker,'source',ready.sourceId)).budget).toEqual({state:'unavailable'});
    await expect(tasks.resourceDocuments(stranger.designer,'source',ready.sourceId)).rejects.toMatchObject({statusCode:404});
    await expect(tasks.resourceDocuments(stranger.designer,'order',ready.id)).rejects.toMatchObject({statusCode:404});
    await expect(fixture.budget.read(worker,ready.id)).rejects.toMatchObject({statusCode:404});
    const draftClient=await database.connect();
    try{
      await draftClient.query('BEGIN');
      const second=await tasks.createWithClient(draftClient,root,{resource:{kind:'source',id:ready.sourceId},kind:'development_pattern',routeId:randomUUID(),routeVersion:2,occurrence:2,assigneeId:worker.actorId});
      await draftClient.query('UPDATE digital_instruction_documents SET source_round=2,version=version+1 WHERE production_order_id=$1',[ready.id]);
      const {taskDocuments}=await import('../../apps/api/src/production-platform/task-documents.js');
      expect((await taskDocuments(draftClient,root,second.taskId)).instruction).toEqual({state:'draft'});
      expect((await taskDocuments(draftClient,root,taskId)).instruction).toEqual(full.instruction);
      await draftClient.query('UPDATE digital_instruction_documents SET source_round=3 WHERE production_order_id=$1',[ready.id]);
      expect((await taskDocuments(draftClient,root,second.taskId)).instruction).toEqual({state:'missing'});
    }finally{await draftClient.query('ROLLBACK');draftClient.release();}
    if(process.env.R2_WORKBENCH_EVIDENCE){
      await database.query("UPDATE app_users SET display_name='TEST-R2 纸样师傅' WHERE id=$1",[worker.actorId]);
      const imageBytes=await sharp({create:{width:240,height:160,channels:3,background:'#4073a4'}}).png().toBuffer();
      const sourceFiles=(await new DigitalDevelopmentService(database,true).read(root,ready.sourceId)).document!.files;
      for(const file of sourceFiles){const row=(await database.query('SELECT object_key FROM attachments WHERE attachment_id=$1',[file.attachmentId])).rows[0];await contractStorage.writeImmutable(row.object_key,imageBytes,{mimeType:'image/png',sha256:createHash('sha256').update(imageBytes).digest('hex')});}
      const readyClient=await database.connect();try{await readyClient.query('BEGIN');for(const row of (await readyClient.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND stage='activation'",[taskId])).rows)await tasks.setConditionWithClient(readyClient,root,taskId,row.condition_key,true);await readyClient.query('COMMIT');}catch(error){await readyClient.query('ROLLBACK');throw error;}finally{readyClient.release();}
      const identity=new DigitalProductionIdentityService(database,true),forms=new DigitalDevelopmentService(database,true);
      const standalone=await identity.createSource(fixture.designer,{developmentType:'头版',designStyleNo:`TEST-R2-NO-ORDER-${randomUUID()}`,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
      const picture=randomUUID(),bytes=await sharp({create:{width:80,height:80,channels:3,background:'#2855a0'}}).png().toBuffer(),objectKey=`tests/r2/${picture}.png`,digest=createHash('sha256').update(bytes).digest('hex');
      await contractStorage.writeImmutable(objectKey,bytes,{mimeType:'image/png',sha256:digest});
      await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-r2.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)",[picture,objectKey,bytes.length,digest,fixture.designer.actorId]);
      const original=(await forms.read(root,ready.sourceId)).document!;
      const syntheticFiles:Array<{attachmentId:string;kind:'款图'}>=[{attachmentId:picture,kind:'款图'}];
      for(let index=1;index<8;index++){const attachmentId=randomUUID(),key=`tests/r2/${attachmentId}.png`;await contractStorage.writeImmutable(key,bytes,{mimeType:'image/png',sha256:digest});await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-R2.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)",[attachmentId,key,bytes.length,digest,fixture.designer.actorId]);syntheticFiles.push({attachmentId,kind:'款图'});}

      await forms.save(fixture.designer,standalone.sourceId,{expectedVersion:0,document:{...original,materials:Array.from({length:8},(_,i)=>({...original.materials[0]!,materialId:randomUUID(),name:`TEST分页材料${i+1}`,label:`TEST分页材料${i+1}`,requiredThisRound:true,available:true})),sizes:['XS','S','M','L','XL','2XL','3XL','4XL'],measurements:Array.from({length:40},(_,index)=>({name:`TEST 尺寸 ${index+1}`,values:['1','2','3','4','5','6','7','8']})),files:syntheticFiles}},randomUUID());await forms.publish(fixture.designer,standalone.sourceId,1,randomUUID());
      const extra=await database.connect();let sewingTaskId:string,standaloneTaskId:string;
      try{await extra.query('BEGIN');sewingTaskId=(await tasks.createWithClient(extra,root,{resource:{kind:'source',id:ready.sourceId},kind:'development_sewing',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:worker.actorId})).taskId;standaloneTaskId=(await tasks.createWithClient(extra,root,{resource:{kind:'source',id:standalone.sourceId},kind:'development_pattern',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:worker.actorId})).taskId;await extra.query('COMMIT');}catch(error){await extra.query('ROLLBACK');throw error;}finally{extra.release();}
      expect(await tasks.documents(root,standaloneTaskId)).toMatchObject({development:{state:'published',id:standalone.sourceId,version:1},instruction:{state:'not_applicable'},budget:{state:'not_applicable'}});
      for(let index=0;index<12;index++)await tasks.prioritize(root,taskId,index%2?'normal':'urgent',randomUUID());
      const {workbenchBrowser}=await import('../acceptance/r2-workbench-browser.mjs');await workbenchBrowser({database,attachments,storage:contractStorage,root,worker,taskId,sewingTaskId,standaloneTaskId,processActors:{...ready.people,sample_designer:fixture.designer},processSourceId:standalone.sourceId,bulkTaskId:(await ready.bulk.read(root,ready.id)).tasks.find(t=>t.taskKind==='bulk_pattern')?.taskId});}
  },240000);

  it('analysis separates frozen development rounds from preparation and factory instruction versions', async () => {
    const fixture = await budgetFixture(false,"TEST-LEGACY-ROUNDS","2026-11-20",true), primary = merchandiserActor(), root = rootActor();
    const ready = (await exerciseBulkPreparation(database, fixture, service, attachments,
      { primary, manager: managerActor(), owner: ownerActor(), ie: ieActor(), root },
      factoryId, craftId('净色车缝'), 'none', { cuttingProcess: 'in_house', stopAtReady: true, legacyDevelopment: true }))!;
    const { id, sourceId, instruction, bulk, people } = ready;
    for (const version of [2, 3, 4]) {
      const sheet = await instruction.read(primary, id);
      await instruction.save(primary, id, { expectedVersion: sheet.version, orderVersion: sheet.order.version, document: { ...sheet.document!, comments: `TEST制单版本${version}` } }, randomUUID());
      await instruction.publish(primary, id, { expectedVersion: version, orderVersion: sheet.order.version }, randomUUID());
    }
    const forms = new DigitalDevelopmentService(database, true), rounds = new DevelopmentRoundService(database, true);
    const development = await forms.read(fixture.designer, sourceId);
    const draft = await rounds.save(fixture.designer, sourceId, { expectedDraftVersion: 0, revision: {
      basedOnRound: 1, document: { ...development.document!, instructions: 'TEST原开发第2轮' },
      origin: '客户新增要求', customerComment: 'TEST第2轮确认', internalProblem: '', explanation: '',
      categories: ['尺寸'], affectedNodes: ['纸样'], outputKind: '整件样板',
    } }, randomUUID());
    const publishedRound=await rounds.publish(fixture.designer, sourceId, { expectedDraftVersion: draft.draftVersion, basedOnRound: 1 }, randomUUID());
    expect(publishedRound).toEqual({sourceId,roundNumber:2});
    await database.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,2,'最终设计确认','{}',$3)", [randomUUID(), sourceId, fixture.designer.actorId]);
    await new DevelopmentExecutionService(database, true).customerSample(fixture.designer, sourceId, { routeVersion: 2, note: 'TEST第2轮客户确认' }, randomUUID());
    const fourth = await instruction.read(primary, id);
    expect(fourth.sourceComparison).toMatchObject({sourceRound:2});
    const comparison=fourth.sourceComparison!;await instruction.reviewSource(primary,id,{expectedVersion:fourth.version,orderVersion:fourth.order.version,sourceRound:comparison.sourceRound,sourceVersion:comparison.sourceVersion,document:{...fourth.document,comments:'TEST制单v5核对开发第2轮'},decisions:comparison.groups.map(group=>({group,action:'retain' as const}))},randomUUID());
    await instruction.publish(primary, id, { expectedVersion: 5, orderVersion: fourth.order.version }, randomUUID());
    let prep = await bulk.read(primary, id);
    await bulk.dispatch(people.development_clerk!, id, { expectedVersion: prep.dispatch.version, patternWorkerId: people.pattern_room_worker!.actorId, deliverPattern: true }, randomUUID());
    prep = await bulk.read(primary, id);
    for (const kind of ['纸样完成', '唛架完成'] as const) await bulk.complete(people.pattern_room_worker!, id, { preparationId: prep.preparationId!, kind }, randomUUID());
    // This newly published preparation still requires its original warehouse preshrink fact before cutting.
    if(prep.preshrink==='需要预缩')await bulk.complete(people.warehouse_receiver!,id,{preparationId:prep.preparationId!,kind:'预缩完成'},randomUUID());
    const cuttingIds = (await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position', [ready.caseId])).rows;
    for (const { cutting_order_id: cuttingId } of cuttingIds) {
      const image = randomUUID();
      await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-analysis-cut.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)", [image, `TEST/analysis/${image}`, 'c'.repeat(64), root.actorId]);
      await ready.cutting.record({ ...root, authorizationCapability: 'cutting:records:create' }, cuttingId, { pieceCount: 1, actualCutCount: 10, attachmentIds: [image] }, randomUUID());
    }
    const flow = await new FactoryFlowService(database).read(people.warehouse_receiver!, id);
    const warehouseTask = flow.tasks.find(task => task.taskKind === 'warehouse_dispatch')!;
    const filters = DigitalAnalysisFilterSchema.parse({ from: '2020-01-01', to: '2080-01-01', scope: 'snapshot' });
    const analysis = new DigitalAnalysisQuery(database), result = await analysis.list(people.warehouse_receiver!, filters);
    const row = result.rows.find(row => row.taskId === warehouseTask.taskId)!;
    expect(row).toMatchObject({ sourceId, sourceRound: 2, instructionVersion: 5, round: 5 });
    expect((await forms.read(root, sourceId, database, 2)).roundNumber).toBe(2);
    await expect(forms.read(root, sourceId, database, 5)).rejects.toMatchObject({ statusCode: 404 });
    await expect(forms.read(people.warehouse_receiver!, sourceId, database, 2)).rejects.toMatchObject({ statusCode: 404 });
    expect(row.canReadSourceRound).toBe(false);

    const client = await database.connect();
    let missingTaskId: string;
    try {
      await client.query('BEGIN');
      missingTaskId = (await new DigitalProductionTaskService(database).createWithClient(client, root, {
        resource: { kind: 'order', id }, kind: 'production_sheet', routeId: randomUUID(), routeVersion: 5,
        occurrence: 99, assigneeId: primary.actorId,
      })).taskId;
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

    const taskSnapshot = (await database.query('SELECT task_id,route_version,route_instance_id,state,entered_at,completed_at FROM digital_production_tasks WHERE task_id IN (SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 OR source_id=$2) ORDER BY task_id', [id, sourceId])).rows;
    const all = await analysis.list(root, { ...filters, scope: 'created' });
    expect(all.rows.find(row => row.taskId === warehouseTask.taskId)?.canReadSourceRound).toBe(true);
    const old = all.rows.find(row => row.orderId === id && row.round === 4)!;
    expect(old).toMatchObject({ sourceRound: 1, instructionVersion: 4 });
    const developmentTasks = all.rows.filter(row => row.orderId === null && row.sourceId === sourceId && row.round === 2);
    expect(developmentTasks.length).toBeGreaterThan(0);
    expect(developmentTasks.every(row => row.sourceRound === 2 && row.instructionVersion === null)).toBe(true);
    // Source-task read authorization survives analysis date/role/assignee filters.
    const sourceTask = developmentTasks[0]!;
    // Stored historical digital grants are retained, but no longer grant source-round reading.
    const historical=randomUUID();
    await database.query("INSERT INTO digital_production_delegations(delegation_id,task_id,delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,'technical',$4,CURRENT_TIMESTAMP+interval '1 hour')",[historical,sourceTask.taskId,people.warehouse_receiver!.actorId,root.actorId]);
    const scoped = await analysis.list(people.warehouse_receiver!, { ...filters, assigneeId: people.warehouse_receiver!.actorId, role: 'warehouse_receiver' });
    expect(scoped.rows.some(row => row.taskId === sourceTask.taskId)).toBe(false);
    expect(scoped.rows.find(row => row.taskId === warehouseTask.taskId)?.canReadSourceRound).toBe(false);
    await expect(forms.read(people.warehouse_receiver!, sourceId, database, 2)).rejects.toMatchObject({statusCode:404});
    expect((await database.query("SELECT delegation_id FROM digital_production_delegations WHERE delegation_id=$1",[historical])).rows).toHaveLength(1);

    expect(all.rows.find(row => row.taskId === missingTaskId)).toMatchObject({ round: 5, sourceRound: null, instructionVersion: null });
    const revisions = await analysis.list(root, { ...filters, scope: 'revisions', origin: '客户新增要求' });
    expect(revisions.rows.some(row => row.taskId === warehouseTask.taskId)).toBe(true);
    expect(revisions.rows.some(row => row.taskId === old.taskId)).toBe(false);
    expect(revisions.rows.some(row => row.taskId === missingTaskId)).toBe(false);
    expect(revisions.rows.every(row => row.sourceRound === 2)).toBe(true);
    const workbook = unzipSync(await analysis.export(root, { ...filters, scope: 'revisions', origin: '客户新增要求' }));
    const xml = new TextDecoder().decode(workbook['xl/worksheets/sheet2.xml']);
    expect(xml).toContain('开发轮次'); expect(xml).toContain('制单版本');
    const warehouseXml = xml.match(/<row\b[^>]*>.*?<\/row>/g)!.find(value => value.includes(warehouseTask.taskId))!;
    expect(warehouseXml).toMatch(/<c r="I\d+"[^>]*><v>2<\/v>/);
    expect(warehouseXml).toMatch(/<c r="J\d+"[^>]*><v>5<\/v>/);
    expect((await database.query('SELECT task_id,route_version,route_instance_id,state,entered_at,completed_at FROM digital_production_tasks WHERE task_id IN (SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 OR source_id=$2) ORDER BY task_id', [id, sourceId])).rows).toEqual(taskSnapshot);
  });

  it('P16 keeps a source-backed analysis and improvement loop inside scope and original export rights',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true}))!;
    const analysis=new DigitalAnalysisQuery(database),filters=DigitalAnalysisFilterSchema.parse({from:'2020-01-01',to:'2030-12-31',customer:'PD',designer:fixture.designer.actorId,category:'上衣'});
    const result=await analysis.list(fixture.designer,filters);
    expect(result.total).toBeGreaterThan(0);expect(result.summary.newStyles).toBe(1);expect(result.rows.every(row=>row.styleNo===fixture.order.designStyleNo)).toBe(true);
    expect(result.canExport).toBe(false);expect(result.canRecord).toBe(false);
    await expect(analysis.export(fixture.designer,filters)).rejects.toMatchObject({statusCode:403});
    const stranger=await budgetFixture();expect((await analysis.list(stranger.designer,filters)).total).toBe(0);
    const worker=ready.people.pattern_room_worker!,workerResult=await analysis.list(worker,filters);
    expect(workerResult.rows.every(row=>row.assigneeId===worker.actorId||row.orderId===ready.id)).toBe(true);
    const taskId=result.rows.find(row=>row.state==='ready')!.taskId;
    const taskService=new DigitalProductionTaskService(database);await taskService.feedback(root,taskId,'TEST交接资料待核实',true,randomUUID());
    expect((await analysis.list(root,filters)).rows.find(row=>row.taskId===taskId)?.events.some(event=>event.kind==='blocked')).toBe(true);
    const note={filters,taskIds:[taskId],conclusion:'TEST发现交接条件滞留，已回看原任务，无法推断净工时',action:'TEST主管核对交接登记并记录下一次观察；不修改工资或真实权限',observeAt:new Date(Date.now()+86400000).toISOString()};
    await expect(analysis.record(fixture.designer,note,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(analysis.record(root,{...note,taskIds:[randomUUID()]},randomUUID())).rejects.toMatchObject({statusCode:404});
    const key=randomUUID(),saved=await analysis.record(root,note,key);expect(await analysis.record(root,note,key)).toEqual(saved);
    await expect(analysis.record(root,{...note,conclusion:'TEST不同结论'},key)).rejects.toMatchObject({statusCode:409});
    const followup=await analysis.list(root,filters);expect(followup.notes.find(item=>item.id===saved.id)).toMatchObject({conclusion:note.conclusion,action:note.action,taskIds:[taskId],ruleVersion:'digital-production-p16-v2'});
    await taskService.feedback(root,taskId,'TEST回看原单后交接资料已核实',false,randomUUID());
    const observed=(await analysis.list(root,filters)).rows.find(row=>row.taskId===taskId)!;expect(observed.state).toBe('ready');expect(observed.events.some(event=>event.kind==='unblocked')).toBe(true);expect(observed.waitingSeconds).toBeGreaterThanOrEqual(0);
    const conditionTask=observed.taskId,connection=await database.connect();
    try{
      const condition=(await connection.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 LIMIT 1",[conditionTask])).rows[0].condition_key;
      await connection.query('BEGIN');await taskService.setConditionWithClient(connection,root,conditionTask,condition,false,null,'TEST前置失效发生时间未知');await connection.query('COMMIT');
      expect((await analysis.list(root,filters)).rows.find(row=>row.taskId===conditionTask)).toMatchObject({state:'blocked',unknownWaiting:1});
      await connection.query('BEGIN');await taskService.setConditionWithClient(connection,root,conditionTask,condition,true,new Date().toISOString(),'TEST前置恢复');await taskService.refreshBusinessConditionsWithClient(connection,root,conditionTask);await connection.query('COMMIT');
      const restored=(await analysis.list(root,filters)).rows.find(row=>row.taskId===conditionTask)!;
      expect(restored.state).toBe('ready');expect(restored.unknownWaiting).toBe(1);expect(restored.pendingConditions).toEqual([]);
    }finally{await connection.query('ROLLBACK');connection.release();}
    const workbook=await analysis.export(root,filters);expect(workbook.subarray(0,2).toString()).toBe('PK');
    expect((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='digital.analysis.recorded' AND id=$1",[saved.id])).rows[0].n).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/salePrice|unitPrice|budget_amount|wageAmount/);
    const app=Fastify();app.setErrorHandler((error,_request,reply)=>{const problem=error as {statusCode?:number;message:string};reply.code(problem.statusCode??500).send({error:problem.message});});
    registerDigitalAnalysisRoutes(app,{service:new DigitalProductionIdentityService(database,true),creationEnabled:true,authenticate:async()=>({id:fixture.designer.actorId,displayName:'TEST设计师',businessRoles:['sample_designer'],capabilities:[]})},analysis);
    try{
      const query=new URLSearchParams(Object.entries(filters).map(([key,value])=>[key,String(value)])).toString();
      expect((await app.inject({method:'GET',url:`/digital-production/analysis?${query}`})).statusCode).toBe(200);
      expect((await app.inject({method:'GET',url:`/digital-production/analysis/export?${query}`})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:'/digital-production/analysis/notes',payload:note,headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(403);
      expect((await app.inject({method:'GET',url:'/digital-production/analysis?from=bad&to=bad'})).statusCode).toBe(400);
    }finally{await app.close();}

  });
  it("P09 preserves published budgets, rejects technical readers and stale or unauthorized writes", async () => {
    const { order, designer, document, imageId, budget } = await budgetFixture(), id = order.productionOrderId;
    // The confirmed quotation already created this draft: disabling new creation does not revoke an existing shared draft.
    expect((await new DigitalBudgetService(database,false).read(designer,id)).canEdit).toBe(true);
    expect((await database.query("SELECT count(*)::int AS n FROM digital_budget_documents WHERE production_order_id=$1",[id])).rows[0].n).toBe(1);
    const key = randomUUID();
    const saved = await budget.save(designer, id, { expectedVersion: 1, document }, key);
    expect((await budget.save(designer, id, { expectedVersion: 1, document }, key)).version).toBe(saved.version);
    await expect(budget.save(designer, id, { expectedVersion: 1, document: { ...document, cm: "9" } }, key)).rejects.toMatchObject({ statusCode: 409 });
    expect((await budget.read(merchandiserActor(),id)).canEdit).toBe(true);
    await expect(budget.publish(designer,id,2,randomUUID())).rejects.toMatchObject({statusCode:403});
    const technical = { ...ieActor(), actorRoles: ["pattern_room_supervisor"], authorizationCapability: "digital_production:view" };
    await expect(budget.read(technical, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(budget.canDownload(technical, id, imageId)).rejects.toMatchObject({ statusCode: 404 });
    expect(await budget.canDownload(designer, id, imageId)).toBe(true);
    const publishKey = randomUUID();
    const published = await Promise.all([budget.publish(merchandiserActor(), id, 2, publishKey), budget.publish(merchandiserActor(), id, 2, publishKey)]);
    expect(published.map(value => value.status)).toEqual(["published", "published"]);
    const task = (await database.query("SELECT p.task_id,t.state,a.assignee_id FROM digital_budget_preparations p JOIN digital_production_tasks t USING(task_id) JOIN digital_production_task_access a USING(task_id) WHERE p.production_order_id=$1", [id])).rows[0];
    expect(task).toMatchObject({ state: "ready", assignee_id: merchandiserId });
    await expect(new DigitalProductionTaskService(database).complete(merchandiserActor(), task.task_id, { note: "不能直接完成" }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await expect(budget.prepareSourcing(merchandiserActor(),id,0,attachments)).rejects.toMatchObject({statusCode:409,message:expect.stringMatching(/预算已更新.*本次未发起外发.*主跟单.*预算页/)});
    const disabled = new DigitalBudgetService(database, false);
    await expect(disabled.save(designer, id, { expectedVersion: 1, document: { ...document, cm: "9" } }, randomUUID())).rejects.toMatchObject({statusCode:409});
    expect((await budget.read(designer, id, undefined, 2)).document?.cm).toBe("8.3");
    expect((await budget.prepareSourcing(merchandiserActor(), id, 2, attachments)).budgetVersion).toBe(2);
    await expect(database.query("UPDATE digital_budget_versions SET document='{}' WHERE production_order_id=$1", [id])).rejects.toThrow("immutable");
    expect((await database.query("SELECT count(*)::int AS n FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='sourcing_preparation'", [id])).rows[0].n).toBe(1);
  });

  it("Mother PR03 freezes three PO factory promises and preserves original correction, contract, return and finance boundaries",async()=>{
    const fixture=await budgetFixture(true),id=fixture.order.productionOrderId;
    await fixture.budget.save(fixture.designer,id,{expectedVersion:1,document:fixture.document},randomUUID());
    await fixture.budget.publish(merchandiserActor(),id,2,randomUUID());
    const prepared=await fixture.budget.prepareSourcing(merchandiserActor(),id,2,attachments);
    const dates=["2026-11-05","2026-11-08","2026-11-11"];
    const input={gender:prepared.gender,styleName:prepared.styleName,deliveryDate:dates[0]!,estimatedCutPieceSendDate:"2026-10-20",daxingUnitPrice:prepared.daxingUnitPrice,
      attachmentIds:prepared.images.map(image=>image.attachmentId),lineItems:prepared.lineItems.map((line,index)=>({lineId:line.lineId,alternateStyleNo:line.alternateStyleNo,color:line.color,quantity:line.quantity,factoryDeliveryDate:dates[index]!,styleNo:index===0?`TEST-VERIFY-${id}`:line.styleNo})),
      digitalBudget:{productionOrderId:id,budgetVersion:prepared.budgetVersion,orderVersion:prepared.orderVersion}};
    await expect(service.createCase(merchandiserActor(),{...input,lineItems:input.lineItems.map((line,index)=>index===1?{...line,factoryDeliveryDate:"2026-10-19"}:line)},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(service.createCase(merchandiserActor(),{...input,lineItems:input.lineItems.map((line,index)=>index===1?{...line,factoryDeliveryDate:"2026-11-21"}:line)},randomUUID())).rejects.toMatchObject({statusCode:409});
    const beforeMissingIds=await fixture.budget.read(fixture.designer,id);
    await expect(service.createCase(merchandiserActor(),{...input,lineItems:input.lineItems.map(line=>({...line,lineId:undefined}))},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(service.createCase(merchandiserActor(),{...input,lineItems:input.lineItems.map((line,index)=>({...line,lineId:input.lineItems[(index+1)%input.lineItems.length]!.lineId}))},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(await fixture.budget.read(fixture.designer,id)).toEqual(beforeMissingIds);
    const created=(await service.createCase(merchandiserActor(),input,randomUUID())).value,caseId=created.sourcingCaseId;
    expect(created.lineItems.map(line=>line.factoryDeliveryDate)).toEqual([null,null,null]);
    expect(created.lineItems.map(line=>line.proposedFactoryDeliveryDate)).toEqual(dates);
    expect((await database.query("SELECT po_number,formal_style_no,line_id FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position",[id])).rows[0])
      .toMatchObject({po_number:input.lineItems[0]!.styleNo,formal_style_no:input.lineItems[0]!.styleNo,line_id:prepared.lineItems[0]!.lineId});
    const returned=(await service.returnToMerchandiser(ownerActor(),caseId,{expectedVersion:created.version,reason:"TEST原审批前核实编号和交期"},randomUUID())).value;
    const corrected={gender:input.gender,styleName:input.styleName,deliveryDate:input.deliveryDate,estimatedCutPieceSendDate:input.estimatedCutPieceSendDate,attachmentIds:input.attachmentIds,expectedVersion:returned.version,reason:"TEST保留原款色数量只纠正编号和逐 PO 日期",lineItems:input.lineItems.map((line,index)=>index===0?{...line,styleNo:`TEST-CORRECT-${id}`,factoryDeliveryDate:"2026-11-06"}:line)};
    await expect(service.correctCase(merchandiserActor(),caseId,{...corrected,lineItems:corrected.lineItems.map((line,index)=>index===0?{...line,color:"非法改色"}:line)},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(service.correctCase(merchandiserActor(),caseId,{...corrected,lineItems:corrected.lineItems.slice(1)},randomUUID())).rejects.toMatchObject({statusCode:409});
    const beforeMissingCorrectionIds=await cycleSnapshot(caseId);
    await expect(service.correctCase(merchandiserActor(),caseId,{...corrected,lineItems:corrected.lineItems.map(line=>({...line,lineId:undefined}))},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(service.correctCase(merchandiserActor(),caseId,{...corrected,lineItems:corrected.lineItems.map((line,index)=>({...line,lineId:corrected.lineItems[(index+1)%corrected.lineItems.length]!.lineId}))},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(await cycleSnapshot(caseId)).toEqual(beforeMissingCorrectionIds);
    const good=(await service.correctCase(merchandiserActor(),caseId,corrected,randomUUID())).value;
    expect(good.status).toBe("pending_ie_quote");
    expect((await database.query("SELECT po_number,formal_style_no FROM digital_production_po_lines WHERE line_id=$1",[prepared.lineItems[0]!.lineId])).rows[0])
      .toEqual({po_number:corrected.lineItems[0]!.styleNo,formal_style_no:corrected.lineItems[0]!.styleNo});
    const prices=prepared.lineItems.map((_,index)=>({position:index+1,unitPrice:"5.50"}));
    await service.quoteIePrice(ieActor(),caseId,{linePrices:prices},randomUUID());
    await service.recordManagementDecision(managerActor(),caseId,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:prices,cuttingProcess:"in_house"},randomUUID());
    const customerDates=new PoCustomerDateService(database),root=rootActor();
    const setCustomer=async(date:string)=>{
      const current=(await database.query("SELECT version FROM digital_production_orders WHERE production_order_id=$1",[id])).rows[0];
      const line=(await database.query("SELECT customer_date_version FROM digital_production_po_lines WHERE line_id=$1",[prepared.lineItems[0]!.lineId])).rows[0];
      const request=await customerDates.request(root,id,{orderVersion:current.version,reason:"TEST真实逐PO客户日期命令",changes:[{lineId:prepared.lineItems[0]!.lineId,expectedVersion:line.customer_date_version,date}]},randomUUID());
      await customerDates.decide(root,id,request.requestId,true,randomUUID());
    };
    await setCustomer("2026-10-25");
    const ownerFacts=await cycleSnapshot(caseId);
    await expect(service.decideOwner(ownerActor(),caseId,{decision:"approved"},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(await cycleSnapshot(caseId)).toEqual(ownerFacts);
    expect((await database.query("SELECT count(*)::int AS n FROM digital_po_date_changes WHERE production_order_id=$1 AND date_kind='factory'",[id])).rows[0].n).toBe(0);
    await setCustomer("2026-11-20");
    await expect(service.decideOwner({...ownerActor(),actorId:merchandiserId},caseId,{decision:"approved"},randomUUID())).rejects.toMatchObject({statusCode:403});
    const approvalKey=randomUUID();
    const approved=(await service.decideOwner(ownerActor(),caseId,{decision:"approved"},approvalKey)).value;
    expect((await service.decideOwner(ownerActor(),caseId,{decision:"approved"},approvalKey)).reused).toBe(true);
    expect(approved.lineItems.map(line=>line.factoryDeliveryDate)).toEqual(["2026-11-06","2026-11-08","2026-11-11"]);
    expect(approved.approvalSnapshot!.linePrices.map(line=>line.factoryDeliveryDate)).toEqual(["2026-11-06","2026-11-08","2026-11-11"]);
    const poCuttingIds=(await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[caseId])).rows.map(row=>row.cutting_order_id);
    expect(await Promise.all(poCuttingIds.map(async cuttingId=>(await cutting.get(root,cuttingId)).deliveryDate))).toEqual(["2026-11-06","2026-11-08","2026-11-11"]);
    const original=(await contractService.getCurrent(root,caseId)).item!;
    expect(original.status).toBe("ready");
    const originalRow=(await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[original.sourcingContractDocumentId])).rows[0];
    expect(originalRow.approval_snapshot.lines.map((line:{deliveryDate:string})=>line.deliveryDate)).toEqual(["2026-11-06","2026-11-08","2026-11-11"]);
    const approvalRow=(await database.query("SELECT * FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$1",[original.sourcingApprovalSnapshotId])).rows[0];
    const file=await readyCuttingSheet(merchandiserId);
    await contractReturns.submit(contractActor(),caseId,[file],randomUUID());
    const signatures=(await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1 ORDER BY submitted_at",[caseId])).rows;
    const monitor=(await database.query("SELECT contract_generated_at,contract_return_due_at,contract_returned_at FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[caseId])).rows[0];
    const edit=await contractService.content.get(root,caseId);
    expect(edit.poFactoryDates).toHaveLength(3);
    const revised={...edit,poFactoryDates:edit.poFactoryDates!.map((line,index)=>index===1?{...line,factoryDeliveryDate:"2026-11-09"}:line),
      content:{...edit.content,terms:{...edit.content.terms,payment:"TEST保留原Root合同文字功能"},lines:edit.content.lines.map((line,index)=>index===1?{...line,deliveryDate:"2026-11-09"}:line)}};
    for(const actor of [contractActor(),managerActor(),financeActor()])await expect(contractService.content.save(actor,caseId,revised,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(contractService.content.save(root,caseId,{...edit,content:{...edit.content,deliveryDate:"2026-11-15"}},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(contractService.content.save(root,caseId,{...revised,poFactoryDates:revised.poFactoryDates.map((line,index)=>index===1?{...line,factoryDeliveryDate:"2026-11-21"}:line)},randomUUID())).rejects.toMatchObject({statusCode:409});
    const journeyQuery=new DigitalJourneyQuery(database);
    const beforeJourney=await journeyQuery.read(root,id);
    const taskClocks=(await database.query("SELECT to_jsonb(t) AS task,(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.revision_id) FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id) AS deadlines FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 ORDER BY task_id",[id])).rows;
    const key=randomUUID(),document=await contractService.content.save(root,caseId,revised,key);
    expect(await contractService.content.save(root,caseId,revised,key)).toBe(document);
    await contractService.generateIfReady(root,caseId,document);
    const current=await contractService.content.get(root,caseId);
    expect(current.content.lines.map(line=>line.deliveryDate)).toEqual(["2026-11-06","2026-11-09","2026-11-11"]);
    expect(await Promise.all(poCuttingIds.map(async cuttingId=>(await cutting.get(root,cuttingId)).deliveryDate))).toEqual(["2026-11-06","2026-11-09","2026-11-11"]);
    expect(current.content.terms.payment).toBe(revised.content.terms.payment);
    const afterJourney=await journeyQuery.read(root,id);
    expect(afterJourney.poDeliveryDates!.map(line=>line.factoryDeliveryDate)).toEqual(["2026-11-06","2026-11-09","2026-11-11"]);
    expect(afterJourney.poDeliveryDates!.map(line=>[line.customerWarehouseArrivalDate,line.sampleTargetDate])).toEqual(Array(3).fill(["2026-11-20","2026-11-10"]));
    expect(afterJourney.poDeliveryDates!.map(line=>line.lineId)).toEqual(prepared.lineItems.map(line=>line.lineId));
    expect(afterJourney.progress).toEqual(beforeJourney.progress);
    const listed=(await service.listCases({...root,authorizationCapability:"sourcing:view",authorizationCapabilities:["sourcing:view"]},corrected.lineItems[0]!.styleNo!)).items.find(row=>row.sourcingCaseId===caseId)!;
    expect(listed.lineItems.map(line=>[line.lineId,line.customerWarehouseArrivalDate,line.factoryDeliveryDate]))
      .toEqual(afterJourney.poDeliveryDates!.map(line=>[line.lineId,line.customerWarehouseArrivalDate,line.factoryDeliveryDate]));

    const clocks=(value:typeof afterJourney)=>value.stages.flatMap(stage=>stage.nodes).map(node=>[node.instanceId,node.enteredAt,node.expectedAt,node.actualAt,node.sla,node.completionResult]);
    expect(clocks(afterJourney)).toEqual(clocks(beforeJourney));
    expect((await database.query("SELECT to_jsonb(t) AS task,(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.revision_id) FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id) AS deadlines FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 ORDER BY task_id",[id])).rows).toEqual(taskClocks);
    expect(JSON.stringify(afterJourney.poDeliveryDates)).not.toMatch(/unitPrice|salePrice|completedQuantity|productionQuantity/);
    expect((await new DigitalCockpitQuery(database).list(root,{page:1,search:fixture.order.designStyleNo,stage:"bulk"})).items.find(row=>row.orderId===id)!.poDeliveryDates).toEqual(afterJourney.poDeliveryDates);

    expect((await database.query("SELECT customer_warehouse_arrival_date::text AS customer,factory_delivery_date::text AS factory FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position",[id])).rows)
      .toEqual(["2026-11-06","2026-11-09","2026-11-11"].map(factory=>({customer:"2026-11-20",factory})));
    expect((await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[original.sourcingContractDocumentId])).rows[0]).toEqual(originalRow);
    expect((await database.query("SELECT * FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$1",[original.sourcingApprovalSnapshotId])).rows[0]).toEqual(approvalRow);
    expect((await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1 ORDER BY submitted_at",[caseId])).rows).toEqual(signatures);
    expect((await database.query("SELECT contract_generated_at,contract_return_due_at,contract_returned_at FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[caseId])).rows[0]).toEqual(monitor);
    const styled=(await service.reviseStyles(root,caseId,{expectedRevision:0,lines:good.lineItems.map(line=>({position:line.position,styleNo:`TEST-AFTER-APPROVAL-${id}-${line.position}`,alternateStyleNo:line.alternateStyleNo}))},randomUUID())).value;
    expect(styled.lineItems.map(line=>line.factoryDeliveryDate)).toEqual(["2026-11-06","2026-11-09","2026-11-11"]);
    expect(styled.approvalSnapshot!.linePrices.map(line=>line.factoryDeliveryDate)).toEqual(["2026-11-06","2026-11-08","2026-11-11"]);
    expect((await contractService.content.get(root,caseId)).content.lines.map(line=>line.deliveryDate)).toEqual(["2026-11-06","2026-11-09","2026-11-11"]);
    expect((await database.query("SELECT po_number=formal_style_no AS same,line_id FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position",[id])).rows).toEqual(prepared.lineItems.map(line=>({same:true,line_id:line.lineId})));
    await contractReturns.submit(root,caseId,[await readyCuttingSheet(merchandiserId)],randomUUID());
    await service.recordFinanceReconciliation(financeActor(),caseId,{result:"match"},randomUUID());
    await expect(contractService.content.save(root,caseId,current,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(contractService.content.preview(root,caseId,current)).rejects.toMatchObject({statusCode:403});
    expect((await database.query("SELECT quantity::int FROM sourcing_decision_lines WHERE sourcing_decision_id=$1 ORDER BY position",[approved.decision!.sourcingDecisionId])).rows.map(line=>line.quantity)).toEqual([137,63,40]);
    // Read an isolated incomplete-date fixture without persisting invalid business facts.
    const missingDate=await database.connect();
    try{
      await missingDate.query('BEGIN');
      await missingDate.query('ALTER TABLE digital_production_po_lines DISABLE TRIGGER digital_po_date_effective_guard');
      await missingDate.query('UPDATE digital_production_po_lines SET factory_delivery_date=NULL WHERE line_id=$1',[prepared.lineItems[2]!.lineId]);
      const scopedCutting=new CuttingSourceService(missingDate as unknown as pg.Pool);
      expect(await Promise.all(poCuttingIds.map(async cuttingId=>(await scopedCutting.get(root,cuttingId)).deliveryDate))).toEqual(["2026-11-06","2026-11-09",null]);
    }finally{await missingDate.query('ROLLBACK');missingDate.release();}
  });

  it("SLA05 preserves a historical version-one route without retroactive fabric or preshrink gates",async()=>{
    const root=rootActor(),ready=(await exerciseBulkPreparation(database,await budgetFixture(false,"TEST-P09","2026-11-20",true),service,attachments,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true}))!;
    const client=await database.connect();
    try{
      await client.query('BEGIN');
      // Initialize only this owned test transaction as an already-existing pre-upgrade route.
      // Runtime commands never rewrite route history, and the transaction is rolled back.
      const approval=(await client.query('SELECT sourcing_approval_snapshot_id FROM sourcing_approval_snapshots WHERE sourcing_case_id=$1 ORDER BY approved_at DESC LIMIT 1',[ready.caseId])).rows[0];
      await client.query('ALTER TABLE digital_bulk_preparations DISABLE TRIGGER digital_bulk_preparation_immutable');
      await client.query("UPDATE digital_bulk_preparations SET workflow_version=1,sla_snapshot_id=NULL,preshrink='无需预缩',approval_snapshot_id=$2 WHERE preparation_id=$1",[ready.preparationId,approval.sourcing_approval_snapshot_id]);
      await client.query('ALTER TABLE digital_bulk_preparations ENABLE TRIGGER digital_bulk_preparation_immutable');
      const before=(await client.query('SELECT task_id,state,entered_at,completed_at FROM digital_production_tasks WHERE route_instance_id=$1 ORDER BY task_id',[ready.preparationId])).rows;
      const state=await ready.bulk.read(root,ready.id,client);
      expect(state.preshrink).toBe('无需预缩');expect(state.fabric).toBeUndefined();
      await ready.bulk.sync(client,root,ready.id);
      expect((await ready.bulk.gates(client,ready.id)).reasons).toEqual([]);
      expect((await client.query('SELECT task_id,state,entered_at,completed_at FROM digital_production_tasks WHERE route_instance_id=$1 ORDER BY task_id',[ready.preparationId])).rows).toEqual(before);
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it("SLA05 HTTP quality decisions preserve original failure, deduplicate retries and serialize competing decisions",async()=>{
    const ready=await exerciseParallelTechnical(database,await budgetFixture(),{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root:rootActor()});
    const app=Fastify();
    app.setErrorHandler((error,_request,reply)=>reply.code((error as ApplicationError).statusCode??500).send({error:error.message}));
    const actors=[ready.warehouse,ready.worker,managerActor(),ownerActor(),rootActor()];
    registerBulkPreparationRoutes(app,{service:new DigitalProductionIdentityService(database,true),creationEnabled:true,root:new RootAuthority(database,'corp',`ding-${merchandiserId}`),authenticate:async token=>{
      const actor=actors.find(a=>a.actorId===token);if(!actor)throw new ApplicationError('UNAUTHORIZED','TEST session required',401);
      const roles=(await database.query('SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL',[token])).rows.map(r=>r.role_code as string);
      return {id:token!,displayName:'TEST isolated quality',businessRoles:roles,capabilities:['digital_production:view']};
    }},ready.bulk);
    await app.ready();
    const post=(suffix:string,body:unknown,actor?:TrustedActorContext,key=randomUUID())=>app.inject({method:'POST',url:`/digital-production/orders/${ready.id}/bulk-preparation/${suffix}`,headers:{...(actor?{cookie:`dx_rework_session=${actor.actorId}`} : {}),'idempotency-key':key},payload:body as Record<string,unknown>});
    try{
      const native=await new ProductionReadinessService(database).read(rootActor(),{kind:'order',id:ready.id}),receipt=native.facts.find(f=>f.kind==='fabric_receipt')!,previous=(await ready.bulk.read(rootActor(),ready.id)).fabric!.report;
      const priorCount=Number((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='bulk_fabric_report'",[ready.id])).rows[0].n);
      const input={expectedReportId:previous?.reportId??null,expectedReceiptVersion:receipt.version,material:'TEST并发整批布',arrivedAt:receipt.occurredAt,inspectedAt:new Date().toISOString(),result:'不合格',note:'TEST保留原色差'};
      expect((await post('fabric-report',input)).statusCode).toBe(401);
      expect((await post('fabric-report',input,ready.worker)).statusCode).toBe(403);
      const key=randomUUID(),responses=await Promise.all([post('fabric-report',input,ready.warehouse,key),post('fabric-report',input,ready.warehouse,key)]);
      expect(responses.map(r=>r.statusCode)).toEqual([200,200]);
      const reportId=responses[0]!.json().fabric.report.reportId;
      expect(responses[1]!.json().fabric.report.reportId).toBe(reportId);
      for(const actor of [managerActor(),ownerActor(),rootActor()]){
        const items=(await bulkFabricDecisionTodos(database,actor)).filter(t=>t.entityId===ready.id);
        expect(items).toHaveLength(1);expect(items[0]!.todoId).toBe(reportId);
        expect((await new DigitalProductionNotificationService(database).todos(actor)).filter(t=>t.category==='digital_bulk_fabric_decision'&&t.entityId===ready.id)).toHaveLength(1);
        expect(todoDestination(items[0]!.route)).toContain(`bulk=${ready.id}`);
        expect((await bulkFabricDecisionTodos(database,actor)).filter(t=>t.entityId===ready.id)).toEqual(items);
      }
      expect(await bulkFabricDecisionTodos(database,ready.worker)).toEqual([]);
      const decision={reportId,expectedDecisionId:null,allowUse:false,note:'TEST先处理'};
      expect((await post('fabric-decision',decision,ready.warehouse)).statusCode).toBe(403);
      const racing=await Promise.all([post('fabric-decision',decision,ownerActor()),post('fabric-decision',{...decision,allowUse:true},managerActor())]);
      expect(racing.map(r=>r.statusCode).sort()).toEqual([200,409]);
      const result=(await ready.bulk.read(rootActor(),ready.id)).fabric!;
      expect(result.report!.result).toBe('不合格');
      for(const actor of [managerActor(),ownerActor(),rootActor()])expect((await bulkFabricDecisionTodos(database,actor)).some(t=>t.entityId===ready.id)).toBe(false);
      const rootKey=randomUUID(),next={reportId,expectedDecisionId:result.decision!.decisionId,allowUse:true,note:'TEST root按原事实准用'};
      expect((await post('fabric-decision',next,rootActor(),rootKey)).statusCode).toBe(200);
      expect((await post('fabric-decision',next,rootActor(),rootKey)).statusCode).toBe(200);
      expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='bulk_fabric_report'",[ready.id])).rows[0].n).toBe(priorCount+1);
      expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='bulk_fabric_decision'",[ready.id])).rows[0].n).toBe(2);
    }finally{await app.close();}
  });
  it("SLA05 allows real technical preparation before pricing while preserving warehouse and cutting gates",async()=>{
    const fixture=await budgetFixture(false,"TEST-PRE0270-SLA","2026-11-20",true);
    const ready=await exerciseParallelTechnical(database,fixture,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root:rootActor()});
    const {bulk,id,warehouse,worker,preparationId}=ready;
    const input={expectedReportId:null,material:'TEST本单整批面料',arrivedAt:'2026-10-22T00:00:00Z',inspectedAt:'2026-10-22T12:00:00Z',result:'不合格' as const,note:'TEST色差'};
    await expect(bulk.reportFabric(worker,id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    const reported=await bulk.reportFabric(warehouse,id,input,randomUUID());
    expect(reported.fabric?.usable).toBe(false);
    const evaluation=await new SlaOrderService(database).read(rootActor(),id);
    expect(evaluation.status).toBe('planned');
    if(evaluation.status==='planned')expect(evaluation.nodes.find(n=>n.id==='production_sheet')?.actualStart).toBeTruthy();
    if(evaluation.status==='planned')expect(evaluation.nodes.find(n=>n.id==='fabric_inspection')).toMatchObject({actualStart:input.arrivedAt,actualEnd:input.inspectedAt,deadline:{at:'2026-10-23T00:00:00.000Z'}});
    if(process.env.SLA_BULK_UI_INPUT)await writeFile(process.env.SLA_BULK_UI_INPUT,JSON.stringify({warehouse:reported,owner:await bulk.read(ownerActor(),id),readonly:await bulk.read(rootActor(),id)}));

    expect(reported.tasks.find(t=>t.taskKind==='warehouse_preshrink')?.state).toBe('pending');
    const reportId=reported.fabric!.report!.reportId;
    await expect(bulk.decideFabric(warehouse,id,{reportId,expectedDecisionId:null,allowUse:true,note:'TEST越权'},randomUUID())).rejects.toMatchObject({statusCode:403});
    const held=await bulk.decideFabric(ownerActor(),id,{reportId,expectedDecisionId:null,allowUse:false,note:'TEST先处理'},randomUUID());
    await expect(bulk.complete(warehouse,id,{preparationId,kind:'预缩完成'},randomUUID())).rejects.toMatchObject({statusCode:409});
    const released=await bulk.decideFabric(rootActor(),id,{reportId,expectedDecisionId:held.fabric!.decision!.decisionId,allowUse:true,note:'TEST确认继续使用'},randomUUID());
    const preshrink=released.tasks.find(t=>t.taskKind==='warehouse_preshrink')!;
    expect(preshrink.state).toBe('ready');
    expect(Date.parse(preshrink.dueAt!)-Date.parse(released.fabric!.usableAt!)).toBe(36*3600000);
    expect(released.fabric!.report!.result).toBe('不合格');
    const paused=await bulk.decideFabric(ownerActor(),id,{reportId,expectedDecisionId:released.fabric!.decision!.decisionId,allowUse:false,note:'TEST处理中暂停'},randomUUID());
    const resumed=await bulk.decideFabric(rootActor(),id,{reportId,expectedDecisionId:paused.fabric!.decision!.decisionId,allowUse:true,note:'TEST处理后继续'},randomUUID());
    expect(resumed.tasks.find(t=>t.taskKind==='warehouse_preshrink')?.dueAt).toBe(preshrink.dueAt);
    await bulk.complete(warehouse,id,{preparationId,kind:'预缩完成'},randomUUID());
    expect((await bulk.read(rootActor(),id)).tasks.some(t=>['bulk_cutting','bulk_cutting_external'].includes(t.taskKind))).toBe(false);
    const primary=merchandiserActor();
    await fixture.budget.save(fixture.designer,id,{expectedVersion:1,document:fixture.document},randomUUID());
    await fixture.budget.publish(primary,id,2,randomUUID());
    const prepared=await fixture.budget.prepareSourcing(primary,id,2,attachments);
    const created=await service.createCase(primary,{gender:prepared.gender,styleName:prepared.styleName,deliveryDate:'2026-11-10',estimatedCutPieceSendDate:'2026-10-20',daxingUnitPrice:prepared.daxingUnitPrice,
      attachmentIds:prepared.images.map(i=>i.attachmentId),lineItems:prepared.lineItems.map(({lineId,styleNo,alternateStyleNo,color,quantity})=>({lineId,styleNo,alternateStyleNo,color,quantity,factoryDeliveryDate:'2026-11-10'})),digitalBudget:{productionOrderId:id,budgetVersion:prepared.budgetVersion,orderVersion:prepared.orderVersion}},randomUUID());
    const caseId=created.value.sourcingCaseId,prices=prepared.lineItems.map((_,i)=>({position:i+1,unitPrice:'5.50'}));
    await service.quoteIePrice(ieActor(),caseId,{linePrices:prices},randomUUID());
    await service.recordManagementDecision(managerActor(),caseId,{supplierId:factoryId,craftIds:[craftId('净色车缝')],linePrices:prices,cuttingProcess:'in_house'},randomUUID());
    await service.decideOwner(ownerActor(),caseId,{decision:'approved'},randomUUID());
    const cut=(await bulk.read(rootActor(),id)).tasks.find(t=>t.taskKind==='bulk_cutting');
    expect(cut).toMatchObject({state:'ready',enteredAt:null,dueAt:null});
    expect((await database.query('SELECT count(*)::int n FROM production_order_node_clocks WHERE node_instance_id=$1',[cut!.taskId])).rows[0].n).toBe(0);


  });
  it.each(["owner", "root"] as const)("SLA04 binds original approval todos to frozen two-hour windows without resetting on return (%s)",async(approver)=>{
    const {service:currentService}=await cycleTodoServices();
    const {order,designer,document,budget}=await budgetFixture(false,"TEST-PRE0270-SLA","2026-11-20",true),id=order.productionOrderId;
    const additionalId=randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST SLA第二跟单',true)",[additionalId]);
    await database.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
      VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,[randomUUID(),additionalId,`ding-${additionalId}`,`union-${additionalId}`]);
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
    try {await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'order_merchandiser',$3,'TEST isolated SLA recipient')",[randomUUID(),additionalId,merchandiserId]);}
    finally {await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation");}
    const secondary={...merchandiserActor(),actorId:additionalId};
    const general=(await database.query("SELECT * FROM todo_policies WHERE policy_key='general'")).rows;
    await budget.save(designer,id,{expectedVersion:1,document},randomUUID());
    await budget.publish(merchandiserActor(),id,2,randomUUID());
    const prepared=await budget.prepareSourcing(merchandiserActor(),id,2,attachments);
    const input={additionalMerchandiserUserId:additionalId,gender:prepared.gender,styleName:prepared.styleName,deliveryDate:'2026-11-10',estimatedCutPieceSendDate:'2026-10-20',daxingUnitPrice:prepared.daxingUnitPrice,
      attachmentIds:prepared.images.map(i=>i.attachmentId),lineItems:prepared.lineItems.map(({lineId,styleNo,alternateStyleNo,color,quantity})=>({lineId,styleNo,alternateStyleNo,color,quantity,factoryDeliveryDate:'2026-11-10'})),digitalBudget:{productionOrderId:id,budgetVersion:prepared.budgetVersion,orderVersion:prepared.orderVersion}};
    await expect(currentService.createCase(merchandiserActor(),{...input,digitalBudget:{...input.digitalBudget,budgetVersion:3}},randomUUID())).rejects.toMatchObject({statusCode:409});
    const created=await currentService.createCase(merchandiserActor(),input,randomUUID()),caseId=created.value.sourcingCaseId;
    const todo=async(category:string)=>(await database.query(`SELECT t.*,s.transitioned_at,creation.after_state->'slaTiming' AS sla_timing FROM rework_todos t
      JOIN operation_events creation ON creation.event_id=t.created_operation_event_id
      JOIN sourcing_case_transitions s ON s.operation_event_id=t.source_event_id AND s.sourcing_case_id=$1::uuid
      WHERE t.entity_id=$1::text AND t.category=$2 ORDER BY t.created_at,t.todo_id`,[caseId,category])).rows;
    const first=(await todo('sourcing_ie_quote'))[0];expect(first).toBeTruthy();expect(first.due_at.getTime()-first.transitioned_at.getTime()).toBe(7200000);
    const frozenSnapshot=(await database.query('SELECT snapshot_id FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision LIMIT 1',[id])).rows[0].snapshot_id;
    expect(first.sla_timing).toEqual({snapshotId:frozenSnapshot,dueAt:first.due_at.toISOString()});
    expect((await todo('sourcing_ie_quote')).every(t=>t.recipient_user_id===ieId)).toBe(true);
    const prices=input.lineItems.map((_,i)=>({position:i+1,unitPrice:'5.25'}));
    await expect(currentService.quoteIePrice(merchandiserActor(),caseId,{linePrices:prices},randomUUID())).rejects.toMatchObject({statusCode:403});
    const quoted=await currentService.quoteIePrice(ieActor(),caseId,{linePrices:prices},randomUUID());
    const management=(await todo('sourcing_management_decision'))[0];expect(management.due_at.getTime()-management.transitioned_at.getTime()).toBe(7200000);
    const originalSnapshot=(await database.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0];
    const changedParameters=structuredClone(originalSnapshot.parameters_json);
    for(const key of ['sourcing_ie','sourcing_selection'])changedParameters[key].value.minutes=180;
    // Isolated persisted-version fixture: no business configuration API is bypassed outside this test schema.
    await database.query(`INSERT INTO digital_sla_order_snapshots(snapshot_id,production_order_id,revision,configuration_id,rule_version,parameters_json,created_by,reason,request_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,'TEST later frozen standard', $8)`,[randomUUID(),id,originalSnapshot.revision+1,originalSnapshot.configuration_id,originalSnapshot.rule_version,changedParameters,rootActor().actorId,randomUUID()]);
    const returned=await currentService.returnToMerchandiser(ownerActor(),caseId,{expectedVersion:quoted.value.version,reason:'TEST核实原资料'},randomUUID());
    expect((await database.query("SELECT recipient_user_id,todo_type FROM rework_todos WHERE entity_id=$1 AND category='sourcing_merchandiser_correction' ORDER BY todo_type",[caseId])).rows).toEqual([
      {recipient_user_id:merchandiserId,todo_type:'business_action'},{recipient_user_id:additionalId,todo_type:'information'}]);
    await expect(budget.save(secondary,id,{expectedVersion:1,document},randomUUID())).rejects.toMatchObject({statusCode:404});
    const correction={gender:input.gender,styleName:input.styleName,deliveryDate:input.deliveryDate,estimatedCutPieceSendDate:input.estimatedCutPieceSendDate,attachmentIds:input.attachmentIds,lineItems:input.lineItems};
    await expect(currentService.correctCase(secondary,caseId,{...correction,expectedVersion:returned.value.version,reason:'TEST非主跟单拒绝'},randomUUID())).rejects.toMatchObject({statusCode:403});
    await currentService.correctCase(merchandiserActor(),caseId,{...correction,expectedVersion:returned.value.version,reason:'TEST沿原修改入口重新提交'},randomUUID());
    expect((await todo('sourcing_ie_quote')).every(t=>t.due_at.getTime()===first.due_at.getTime())).toBe(true);
    expect((await todo('sourcing_ie_quote')).every(t=>t.sla_timing.snapshotId===frozenSnapshot&&t.sla_timing.dueAt===first.due_at.toISOString())).toBe(true);
    await currentService.quoteIePrice(ieActor(),caseId,{linePrices:prices},randomUUID());
    expect((await todo('sourcing_management_decision')).every(t=>t.due_at.getTime()===management.due_at.getTime())).toBe(true);
    const bases=(await database.query(`SELECT e.after_state->'slaTiming'->>'snapshotId' AS basis FROM rework_todos t
      JOIN operation_events e ON e.event_id=t.created_operation_event_id WHERE t.entity_id=$1
      AND t.category IN ('sourcing_ie_quote','sourcing_management_decision')`,[caseId])).rows;
    expect(bases.length).toBeGreaterThanOrEqual(4);
    expect(bases.every(row=>row.basis===originalSnapshot.snapshot_id)).toBe(true);

    await currentService.recordManagementDecision(managerActor(),caseId,{supplierId:factoryId,craftIds:[craftId('净色车缝')],linePrices:prices,cuttingProcess:'in_house'},randomUUID());
    const owner=(await todo('sourcing_owner_approval'))[0];expect(owner.due_at.getTime()-owner.transitioned_at.getTime()).toBe(7200000);
    await expect(currentService.decideOwner(merchandiserActor(),caseId,{decision:'approved'},randomUUID())).rejects.toMatchObject({statusCode:403});
    await currentService.decideOwner(approver==="owner"?ownerActor():{...rootActor(),authorizationCapability:"sourcing:owner:approve"},caseId,{decision:'approved'},randomUUID());
    expect((await database.query("SELECT * FROM todo_policies WHERE policy_key='general'")).rows).toEqual(general);
    expect((await budget.read(designer,id,undefined,2)).document).toEqual(document);
    const dates=new PoCustomerDateService(database),root=rootActor();
    const version=(await database.query("SELECT version FROM digital_production_orders WHERE production_order_id=$1",[id])).rows[0].version;
    const line=(await database.query("SELECT line_id,customer_date_version FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position LIMIT 1",[id])).rows[0];
    const request=await dates.request(root,id,{orderVersion:version,reason:'TEST SLA客户日期权限',changes:[{lineId:line.line_id,expectedVersion:line.customer_date_version,date:'2026-11-21'}]},randomUUID());
    expect((await dates.read(ownerActor(),id)).canApproveDate).toBe(true);
    expect((await database.query(`SELECT r.recipient_id FROM digital_production_notification_receipts r
      JOIN digital_production_notification_events e USING(event_id) WHERE e.source_key=$1`,[`po-customer-request:${request.requestId}`])).rows.map(r=>r.recipient_id)).toContain(ownerActor().actorId);
    await expect(dates.decide(designer,id,request.requestId,true,randomUUID())).rejects.toMatchObject({statusCode:403});
    await dates.decide(approver==='owner'?ownerActor():root,id,request.requestId,true,randomUUID());
    expect((await dates.read(root,id)).dateRequests.find(r=>r.requestId===request.requestId)?.status).toBe('已批准');
  });
  it("P09 carries all PO quantities and owned image copies into exactly one original sourcing case", async () => {
    const { order, designer, document, imageId, budget } = await budgetFixture(), id = order.productionOrderId;
    await budget.save(designer, id, { expectedVersion: 1, document }, randomUUID());
    await budget.publish(merchandiserActor(), id, 2, randomUUID());
    const prepared = await budget.prepareSourcing(merchandiserActor(), id, 2, attachments);
    expect(prepared.lineItems.map(line => line.quantity)).toEqual([137, 63]);
    expect(prepared.daxingUnitPrice).toBe("5.25");
    expect(prepared.contractDeliveryDate).toBe("2026-11-20");
    expect(prepared.images[0]!.attachmentId).not.toBe(imageId);
    expect((await budget.prepareSourcing(merchandiserActor(), id, 2, attachments)).images).toEqual(prepared.images);
    const input = {
      gender: prepared.gender, styleName: prepared.styleName, deliveryDate: "2026-11-10",
      estimatedCutPieceSendDate: "2026-10-20", daxingUnitPrice: prepared.daxingUnitPrice,
      attachmentIds: prepared.images.map(image => image.attachmentId),
      lineItems: prepared.lineItems.map(({ lineId, styleNo, alternateStyleNo, color, quantity }) => ({ lineId, styleNo, alternateStyleNo, color, quantity, factoryDeliveryDate:"2026-11-10" })),
      digitalBudget: { productionOrderId: id, budgetVersion: prepared.budgetVersion, orderVersion: prepared.orderVersion },
    };
    await expect(service.createCase(merchandiserActor(), { ...input, lineItems: input.lineItems.slice(0, 1) }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.createCase(merchandiserActor(), { ...input, daxingUnitPrice: "8.30" }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const key = randomUUID();
    const results = await Promise.all([service.createCase(merchandiserActor(), input, key), service.createCase(merchandiserActor(), input, key)]);
    const caseId = results[0]!.value.sourcingCaseId;
    expect(results[1]!.value.sourcingCaseId).toBe(caseId);
    expect(results[0]!.value.status).toBe("pending_ie_quote");
    expect(results[0]!.value.deliveryDate).toBe("2026-11-10");
    expect((await database.query("SELECT workflow_generation FROM sourcing_cases WHERE sourcing_case_id=$1", [caseId])).rows[0].workflow_generation).toBe("digital_production_v1");
    expect((await database.query("SELECT count(*)::int AS n FROM digital_production_child_lines WHERE child_id=$1", [caseId])).rows[0].n).toBe(2);
    expect((await database.query("SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1", [imageId])).rows[0]).toEqual({ entity_type: "digital_budget", entity_id: id });
    expect((await database.query("SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1", [input.attachmentIds[0]])).rows[0]).toEqual({ entity_type: "sourcing_case", entity_id: caseId });
    expect((await database.query("SELECT t.state FROM digital_budget_preparations p JOIN digital_production_tasks t USING(task_id) WHERE p.production_order_id=$1", [id])).rows[0].state).toBe("completed");
    expect(await digitalTodoOrder(database, { routeName: "sourcing_detail", entityId: caseId })).toBe(id);
    await expect(service.createCase(merchandiserActor(), input, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await expect(budget.save(designer, id, { expectedVersion: 1, document }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    // Corrupt only this owned test schema to prove a missing mapping never falls back to legacy.
    const corruption = await database.connect();
    try {
      await corruption.query("BEGIN");
      await corruption.query("ALTER TABLE digital_production_child_lines DISABLE TRIGGER digital_production_child_lines_immutable");
      await corruption.query("ALTER TABLE digital_production_child_links DISABLE TRIGGER digital_production_child_links_immutable");
      await corruption.query("DELETE FROM digital_production_child_lines WHERE child_id=$1", [caseId]);
      await corruption.query("DELETE FROM digital_production_child_links WHERE child_id=$1", [caseId]);
      await expect(digitalTodoOrder(corruption, { routeName: "sourcing_detail", entityId: caseId })).rejects.toMatchObject({ code: "DIGITAL_LINK_MISSING" });
    } finally { await corruption.query("ROLLBACK"); corruption.release(); }
  });


  it("receiving source regression keeps distinct PO receipts mapped and rejects cross-source repeats", async () => {
    const fixture = await budgetFixture(false,"TEST-LEGACY-ROUNDS","2026-11-20",true), primary = merchandiserActor(), root = rootActor();
    const ready = (await exerciseBulkPreparation(database, fixture, service, attachments,
      { primary, manager: managerActor(), owner: ownerActor(), ie: ieActor(), root },
      factoryId, craftId("净色车缝"), "none", { cuttingProcess: "in_house", stopAtReady: true }))!;
    const identity = new DigitalProductionIdentityService(database, true, service);
    const formal = `TEST-RECEIVING-SOURCE-${randomUUID().slice(0, 8)}`;
    for (const [index, line] of fixture.order.lines.entries()) {
      const current = await identity.read(root, ready.id);
      await identity.correctNumbers(root, ready.id, line.lineId,
        { expectedVersion: current.version, formalPoNo: `${formal}-${index + 1}` }, randomUUID());
    }
    const ids = (await database.query("SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position", [ready.caseId])).rows.map(row => row.cutting_order_id);
    expect(ids).toHaveLength(2);
    const image = async () => {
      const id = randomUUID();
      await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-source.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)", [id, `TEST/receiving-source/${id}`, "c".repeat(64), root.actorId]);
      return id;
    };
    for (const [index, id] of ids.entries()) await ready.cutting.record(
      { ...root, authorizationCapability: "cutting:records:create" }, id,
      { pieceCount: 1, actualCutCount: index === 0 ? 60 : 40, attachmentIds: [await image()] }, randomUUID());
    const receiver = { ...root, authorizationCapability: "receiving:create" };
    const blue = await receiving.create(receiver, { cuttingOrderId: ids[0], documentQuantity: 60, actualQuantity: 60, attachmentIds: [await image()] }, randomUUID());
    // Concurrent red first receipts with different request keys must produce one receipt.
    const redImage = await image();
    const redInput = { cuttingOrderId: ids[1], documentQuantity: 40, actualQuantity: 40, attachmentIds: [redImage] };
    const attempted = await Promise.allSettled([receiving.create(receiver, redInput, randomUUID()), receiving.create(receiver, redInput, randomUUID())]);
    expect(attempted.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempted.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "REPEAT_RECEIVING_REQUIRED" });
    const red = (attempted.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof receiving.create>>>).value;
    expect(red.value.receivingBatchId).not.toBe(blue.value.receivingBatchId);
    await expect(receiving.createRepeated(receiver, { receivingBatchId: blue.value.receivingBatchId, cuttingOrderId: ids[1], source: "other_factory", documentQuantity: 40, actualQuantity: 40 }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
    for (const [receipt, cuttingId] of [[blue.value, ids[0]], [red.value, ids[1]]] as const) {
      const expectedLine = (await database.query("SELECT line_id FROM digital_production_child_lines WHERE module='cutting' AND child_id=$1", [cuttingId])).rows[0].line_id;
      expect((await database.query("SELECT line_id FROM digital_production_child_lines WHERE module='receiving' AND child_id=$1", [receipt.receiptId])).rows.map(row => row.line_id)).toEqual([expectedLine]);
    }
    const rows = (await receiving.board(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), undefined, formal)).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map(row => [row.actualCutCount, row.actualQuantity]).sort()).toEqual([[40, 40], [60, 60]]);
  });

  it("synchronizes both digital PO aliases through the original approved sourcing revision without rewriting facts", async () => {
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,
      {primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),"none",
      {cuttingProcess:"in_house",stopAtReady:true}))!;
    const identity=new DigitalProductionIdentityService(database,true),before=await identity.read(root,ready.id);
    expect(before.lines.every(line=>line.poNumber&&line.poNumber===line.formalStyleNo)).toBe(true);
    const sourceBefore=await service.getCase(readerActor(),ready.caseId);
    const snapshot=async()=>({
      tasks:(await database.query("SELECT t.* FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 ORDER BY t.task_id",[ready.id])).rows,
      published:(await database.query("SELECT * FROM digital_instruction_versions WHERE production_order_id=$1 ORDER BY version",[ready.id])).rows,
      cutting:(await database.query("SELECT * FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY cutting_order_id",[ready.caseId])).rows,
      dates:(await database.query("SELECT * FROM digital_po_date_changes WHERE production_order_id=$1 ORDER BY change_id",[ready.id])).rows,
    });
    const factsBefore=await snapshot(),number=`TEST-PO-REVISION-${randomUUID()}`;
    const changes=sourceBefore.lineItems.map(line=>({position:line.position,styleNo:`${number}-${line.position}`,alternateStyleNo:line.alternateStyleNo}));
    const key=randomUUID(),input={expectedRevision:sourceBefore.identityRevision??0,lines:changes};
    const revised=await service.reviseStyles(primary,ready.caseId,input,key);
    expect((await service.reviseStyles(primary,ready.caseId,input,key)).reused).toBe(true);
    const after=await identity.read(root,ready.id);
    expect(after.version).toBe(before.version+1);
    expect(after.lines.map(line=>[line.lineId,line.poNumber,line.formalStyleNo,line.sizes,line.customerWarehouseArrivalDate,line.factoryDeliveryDate]))
      .toEqual(before.lines.map((line,index)=>[line.lineId,changes[index]!.styleNo,changes[index]!.styleNo,line.sizes,line.customerWarehouseArrivalDate,line.factoryDeliveryDate]));
    expect(revised.value.approvalSnapshot).toEqual(sourceBefore.approvalSnapshot);
    expect(await snapshot()).toEqual(factsBefore);
    await expect(service.reviseStyles(primary,ready.caseId,{expectedRevision:revised.value.identityRevision!,lines:changes.map(line=>({...line,styleNo:`${number}-DUP`}))},randomUUID())).rejects.toMatchObject({code:"23505"});
    expect(await identity.read(root,ready.id)).toEqual(after);
    expect((await service.getCase(readerActor(),ready.caseId)).identityRevision).toBe(revised.value.identityRevision);
    expect(await snapshot()).toEqual(factsBefore);
  });

  it("P10 keeps technical versions, units, date approval and budget boundaries independent", async () => {
    const fixture=await budgetFixture(false,"TEST-P10-HISTORICAL","2026-11-20",true);
    expect(await new ProductionReadinessService(database).read(rootActor(),{kind:"order",id:fixture.order.productionOrderId})).toMatchObject({enrolled:false});
    await fixture.budget.save(fixture.designer,fixture.order.productionOrderId,{expectedVersion:1,document:fixture.document},randomUUID());
    await exerciseInstructions(database,fixture.order,merchandiserActor(),fixture.designer,managerActor("TEST P10"),fixture.imageId);
  });

  describe("C05 terminal preassignment boundary",()=>{
    const app=Fastify();
    const request=(person:TrustedActorContext,input:unknown,commandKey:string)=>app.inject({method:'PUT',url:`/digital-production/orders/${ready.id}/bulk-preparation/dispatch`,headers:{cookie:`dx_rework_session=${person.actorId}`,'idempotency-key':commandKey},payload:input as Record<string,unknown>});
    afterAll(()=>app.close());
    let ready:NonNullable<Awaited<ReturnType<typeof exerciseBulkPreparation>>>,clerk:TrustedActorContext,tech:TrustedActorContext,key:string,body:{expectedVersion:number;patternWorkerId:string;deliverPattern:boolean};
    const snapshot=async()=>({
      dispatch:(await database.query("SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1",[ready.id])).rows,
      audits:(await database.query("SELECT * FROM audit_events WHERE entity_id=$1 ORDER BY id",[ready.id])).rows,
      commands:(await database.query("SELECT * FROM digital_production_commands WHERE command LIKE $1 ORDER BY actor_id,command,key",[`bulk:${ready.id}:%`])).rows,
      tasks:(await database.query("SELECT t.*,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 ORDER BY t.task_id",[ready.id])).rows,
      wages:(await database.query("SELECT count(*)::int n FROM rework_wage_items")).rows,
    });
    beforeAll(async()=>{
    {const stageStart=performance.now();let stageStatus='failed';try {

      ready=(await exerciseBulkPreparation(database,await budgetFixture(false,"TEST-C05"),service,attachments,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root:rootActor()},factoryId,craftId("净色车缝"),'none',{cuttingProcess:'in_house',stopAtReady:true}))!;
      clerk=ready.people.development_clerk!;
      await database.query("INSERT INTO digital_production_resource_lifecycle(resource_kind,resource_id,state,changed_by,reason) VALUES('order',$1,'active',$2,'TEST isolated initial active lifecycle') ON CONFLICT(resource_kind,resource_id) DO NOTHING",[ready.id,managerId]);
      // Independent synthetic identity initialization; tested runtime guards remain enabled.
      const id=randomUUID();await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST C05 supervisor',true)",[id]);
      await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$2::uuid::text,$2::uuid::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id]);
      await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
      try{await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'pattern_room_supervisor',$3,'isolated C05 initial identity')",[randomUUID(),id,ownerId]);}finally{await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation");}
      tech={actorId:id,actorRoles:['pattern_room_supervisor'],authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view'],requestId:randomUUID()};
      expect((await ready.bulk.gates(database,ready.id)).reasons).toEqual([]);
      app.setErrorHandler((error,_req,reply)=>{const known=error as ApplicationError;reply.code(known.statusCode??500).send({error:{code:known.code,message:known.message}});});
      registerBulkPreparationRoutes(app,{service:new DigitalProductionIdentityService(database,true),creationEnabled:true,authenticate:async token=>{
        if(![clerk.actorId,tech.actorId,ready.people.pattern_room_worker!.actorId].includes(token??''))throw new ApplicationError('UNAUTHORIZED','TEST session required',401);
        const user=(await database.query('SELECT display_name FROM app_users WHERE id=$1 AND enabled',[token])).rows[0];if(!user)throw new ApplicationError('UNAUTHORIZED','TEST inactive session',401);
        const roles=(await database.query('SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL',[token])).rows.map(row=>row.role_code as string);
        const capabilities=(await database.query('SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])',[roles])).rows.map(row=>row.capability as string);
        return {id:token!,displayName:user.display_name,businessRoles:roles,capabilities};
      }},ready.bulk);await app.ready();

      stageStatus='completed';
    }finally {process.stdout.write(JSON.stringify({suite:'sourcing-pr03-postgres',phase:'fixture_c05_ms',ms:Math.round(performance.now()-stageStart),status:stageStatus})+'\n');}}
},20000);
    it("keeps active preassignment insert/update/replay, denies unauthorized writes and rolls back an audit failure",async()=>{
      const sheet=await ready.bulk.read(clerk,ready.id);key=randomUUID();body={expectedVersion:sheet.dispatch.version,patternWorkerId:ready.people.pattern_room_worker!.actorId,deliverPattern:false};
      const response=await request(clerk,body,key);expect(response.statusCode).toBe(200);const saved=response.json();expect(saved.dispatch.version).toBe(body.expectedVersion+1);
      let before=await snapshot();expect(await ready.bulk.dispatch(clerk,ready.id,body,key)).toEqual(JSON.parse(JSON.stringify(saved)));expect(await snapshot()).toEqual(before);
      await expect(ready.bulk.dispatch(ready.people.pattern_room_worker!,ready.id,{...body,expectedVersion:saved.dispatch.version},randomUUID())).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);
      expect((await request(ready.people.pattern_room_worker!,{...body,expectedVersion:saved.dispatch.version},randomUUID())).statusCode).toBe(403);expect(await snapshot()).toEqual(before);
      const updated=await ready.bulk.dispatch(tech,ready.id,{...body,expectedVersion:saved.dispatch.version},randomUUID());expect(updated.dispatch.version).toBe(saved.dispatch.version+1);
      before=await snapshot();
      await database.query(`CREATE FUNCTION test_c05_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='${ready.id}' AND NEW.action='dispatch' THEN RAISE EXCEPTION 'TEST C05 audit failure'; END IF; RETURN NEW; END $$`);
      await database.query("CREATE TRIGGER test_c05_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_c05_audit_failure()");
      try{await expect(ready.bulk.dispatch(clerk,ready.id,{...body,expectedVersion:updated.dispatch.version},randomUUID())).rejects.toThrow('TEST C05 audit failure');expect(await snapshot()).toEqual(before);}
      finally{await database.query("DROP TRIGGER test_c05_audit_failure ON audit_events");await database.query("DROP FUNCTION test_c05_audit_failure()");}
    });
    it("rejects closed-but-lifecycle-active preassignment and formal dispatch with closure as the only unmet gate, including a queued command",async()=>{
      expect((await ready.bulk.gates(database,ready.id)).reasons).toEqual([]);
      const client=await database.connect();let pending:Promise<unknown>|undefined;
      try{
        await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
        // Initialize an audited historical special closure; never disable its role/audit guards.
        const event=randomUUID();await client.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,'TEST C05 historical closure',$2,'digital.order.special_close','digital_production_order',$3,'{}')",[event,managerId,ready.id]);
        await client.query("INSERT INTO digital_order_closures(production_order_id,reason,outstanding,source_revision,closed_by,audit_event_id) VALUES($1,'TEST terminal boundary','[\"fixture\"]',$2,$3,$4)",[ready.id,'a'.repeat(64),managerId,event]);
        const version=(await client.query('SELECT version FROM digital_bulk_dispatch WHERE production_order_id=$1',[ready.id])).rows[0].version;
        pending=ready.bulk.dispatch(clerk,ready.id,{...body,expectedVersion:version},randomUUID());const rejected=expect(pending).rejects.toMatchObject({statusCode:409});
        const holder=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);let blocked=false;
        for(let n=0;n<100&&!blocked;n++){blocked=Boolean((await database.query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[holder])).rowCount);if(!blocked)await new Promise(done=>setTimeout(done,5));}
        await client.query('COMMIT');await rejected;expect(blocked).toBe(true);

      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      const gates=await ready.bulk.gates(database,ready.id);expect(gates.reasons).toEqual(['母单已特殊结案，原实绩及历史继续保留']);
      expect((await database.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1",[ready.id])).rows).toEqual([{state:'active'}]);
      const before=await snapshot(),version=before.dispatch[0]!.version;
      for(const person of [clerk,tech])for(const deliverPattern of [false,true]){
        const rejected=await request(person,{...body,expectedVersion:version,deliverPattern},randomUUID());expect(rejected.statusCode).toBe(409);expect(rejected.json().error.message).toContain('已特殊结案');expect(await snapshot()).toEqual(before);
        const sheet=await ready.bulk.read(person,ready.id);expect(sheet.canDispatchPattern).toBe(false);expect(sheet.dispatch.patternWorkerId).toBe(body.patternWorkerId);
      }
      await ready.bulk.dispatch(clerk,ready.id,body,key);expect(await snapshot()).toEqual(before); // historical receipt, zero writes
      expect(before.dispatch).toHaveLength(1); // existing history is retained
    });
    it("also rejects a cancelled source or order before preassignment without new commands, audits or wages",async()=>{
      const fixture=await budgetFixture(false,'TEST-C05-CANCEL'),id=fixture.order.productionOrderId;
      const identity=new DigitalProductionIdentityService(database,true),source=await identity.createSource(fixture.designer,{developmentType:'头版',designStyleNo:fixture.order.designStyleNo,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
      await identity.attachSource(fixture.designer,id,source.sourceId,randomUUID());
      for(const [kind,resource] of [['source',source.sourceId],['order',id]] as const){
        await database.query("INSERT INTO digital_production_resource_lifecycle(resource_kind,resource_id,state,changed_by,reason) VALUES($1,$2,'cancelled',$3,'TEST initial cancelled resource') ON CONFLICT(resource_kind,resource_id) DO UPDATE SET state='cancelled'",[kind,resource,ownerId]);
        const before=(await database.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1",[id])).rows;
        await expect(ready.bulk.dispatch(clerk,id,{...body,expectedVersion:0},randomUUID())).rejects.toMatchObject({statusCode:409});
        expect((await database.query("SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1",[id])).rows).toEqual([]);expect((await database.query("SELECT * FROM digital_production_commands WHERE command LIKE $1",[`bulk:${id}:%`])).rows).toEqual([]);expect((await database.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1",[id])).rows).toEqual(before);
      }
    });
  });

  it("ERP V3-039 searches and displays the order customer when its development source has no customer",async()=>{
    await exerciseBulkPreparation(database,await budgetFixture(),service,attachments,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root:rootActor()},factoryId,craftId("净色车缝"),'none',{cuttingProcess:'in_house',stopAtReady:true,sourceCustomerCode:null});
  });
  it('SLA03 independent customer revision preserves the linked mother order and keeps worker access to its instruction',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true}))!;
    const {id,sourceId,instruction,bulk,people}=ready,worker=people.pattern_room_worker!;
    const forms=new DigitalDevelopmentService(database,true),rounds=new DevelopmentRoundService(database,true),identity=new DigitalProductionIdentityService(database,true);
    const original=await forms.read(fixture.designer,sourceId),beforeOrder=await identity.read(primary,id),beforeInstruction=await instruction.read(worker,id),beforePreparation=await bulk.read(primary,id);
    const frozen=async()=>({
      instructions:(await database.query('SELECT * FROM digital_instruction_versions WHERE production_order_id=$1 ORDER BY version',[id])).rows,
      preparations:(await database.query('SELECT * FROM digital_bulk_preparations WHERE production_order_id=$1 ORDER BY preparation_id',[id])).rows,
      tasks:(await database.query('SELECT t.* FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 OR a.source_id=$2 ORDER BY t.task_id',[id,sourceId])).rows,
      plans:(await database.query('SELECT * FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision',[sourceId])).rows,
    });
    const before=await frozen();
    const draft=await rounds.save(fixture.designer,sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:{...original.document!,instructions:'TEST独立客户复版'},origin:'客户新增要求',customerComment:'TEST独立复版不改原母单',internalProblem:'',explanation:'',categories:['尺寸'],affectedNodes:['纸样'],outputKind:'整件样板'}},randomUUID());
    const revision=await rounds.publish(fixture.designer,sourceId,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID());
    expect(revision.sourceId).not.toBe(sourceId);expect(revision).toMatchObject({roundNumber:1,revisionNumber:1,status:'draft'});
    expect(await forms.read(fixture.designer,revision.sourceId)).toMatchObject({status:'draft',productionOrderId:null,roundNumber:1});
    expect(await forms.read(fixture.designer,sourceId)).toMatchObject({version:original.version,roundNumber:1,productionOrderId:id});
    expect(await identity.read(primary,id)).toMatchObject({sourceId,version:beforeOrder.version,lines:beforeOrder.lines});
    expect(await instruction.read(worker,id)).toMatchObject({version:beforeInstruction.version,sourceRound:1,latestSourceRound:1,document:beforeInstruction.document,canEdit:false});
    expect((await instruction.read(primary,id)).sourceComparison).toBeUndefined();
    expect(await bulk.read(primary,id)).toMatchObject({preparationId:beforePreparation.preparationId,instructionValid:true,customerConfirmed:true});
    expect(await frozen()).toEqual(before);
    await expect(forms.read(worker,revision.sourceId)).rejects.toMatchObject({statusCode:404});
    await expect(new DigitalJourneyQuery(database).read(worker,revision.sourceId)).rejects.toMatchObject({statusCode:404});
  });
  it.each(['none','pattern-first','preshrink-first','concurrent'] as const)("P11 releases exactly one whole-order cutting task with %s preparation",async mode=>{
    await exerciseBulkPreparation(database,await budgetFixture(false,"TEST-P09","2026-11-20",mode==='none'),service,attachments,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root:rootActor()},factoryId,craftId("净色车缝"),mode,mode==='none'?{cuttingProcess:'in_house',stopAtReady:false,legacyDevelopment:true}:undefined);
  });

  it('P11 freezes no-preshrink at publication and preserves facts, tasks and P0 across reads, sync and a different unpublished draft',async()=>{
    const primary=merchandiserActor(),root=rootActor(),fixture=await budgetFixture();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true}))!;
    const {id,bulk,instruction,preparationId}=ready;
    const frozen=async()=>({
      instructions:(await database.query('SELECT * FROM digital_instruction_versions WHERE production_order_id=$1 ORDER BY version',[id])).rows,
      preparations:(await database.query('SELECT * FROM digital_bulk_preparations WHERE production_order_id=$1 ORDER BY preparation_id',[id])).rows,
      facts:(await database.query('SELECT * FROM digital_bulk_preparation_facts WHERE preparation_id=$1 ORDER BY fact_id',[preparationId])).rows,
      tasks:(await database.query('SELECT t.* FROM digital_production_tasks t WHERE route_instance_id=$1 ORDER BY task_id',[preparationId])).rows,
      events:(await database.query('SELECT e.* FROM digital_production_task_events e JOIN digital_production_tasks t USING(task_id) WHERE t.route_instance_id=$1 ORDER BY event_id',[preparationId])).rows,
      plans:(await database.query('SELECT * FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision',[id])).rows,
      snapshots:(await database.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision',[id])).rows,
    });
    const before=await frozen();
    expect(before.preparations).toHaveLength(1);
    expect(before.preparations[0]).toMatchObject({workflow_version:2,preshrink:'无需预缩'});
    expect(before.facts.filter(f=>f.kind==='无需预缩')).toHaveLength(1);
    const read=await new SlaOrderService(database).read(root,id);
    if(read.status!=='planned')throw Error('missing no-preshrink SLA plan');
    expect(read.nodes.find(n=>n.id==='warehouse_preshrink')?.status).toBe('not_applicable');
    expect(read.nodes.find(n=>n.id==='bulk_cutting')).toMatchObject({actualStart:null,actualEnd:null});
    expect(read.current.plan.nodes.find(n=>n.id==='warehouse_preshrink')?.applicable).toBe('yes');
    expect((await new DigitalJourneyQuery(database).read(root,id)).stages.flatMap(s=>s.nodes).find(n=>n.key==='warehouse_preshrink')?.state).toBe('not_applicable');
    const current=await instruction.read(primary,id);
    const plans=new SeriesPlanService(database,'TEST-preshrink-preview-not-live');
    const preview=await plans.preview(root,id,{expectedOrderVersion:current.order.version,expectedPlanRevision:0});
    expect(preview.sourceRevisionSet.instructionRef).toMatchObject({preparationId,preshrink:'无需预缩'});
    expect(preview.planningGraph.some(n=>n.id==='fabric_preshrink')).toBe(false);
    for(const node of preview.planningGraph.filter(n=>n.id.startsWith('cutting:')))expect(node.dependsOn).toContain('fabric_inspection');
    await instruction.save(primary,id,{expectedVersion:current.version,orderVersion:current.order.version,document:{...current.document,preshrink:'需要预缩'}},randomUUID());
    const client=await database.connect();
    try{await client.query('BEGIN');await bulk.sync(client,root,id);await bulk.sync(client,root,id);await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    expect(await bulk.read(root,id)).toMatchObject({preparationId,preshrink:'无需预缩'});
    expect((await plans.preview(root,id,{expectedOrderVersion:current.order.version,expectedPlanRevision:0})).planningGraph).toEqual(preview.planningGraph);
    expect(await frozen()).toEqual(before);
    await expect(bulk.complete(root,id,{preparationId,kind:'预缩完成'},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(await frozen()).toEqual(before);
  });

  it("V2 hides deleted native sourcing decisions and dead record links from Journey",async()=>{
    const fixture=await budgetFixture(),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'pattern-first',{cuttingProcess:'in_house',stopAtReady:true}))!;
    const query=new DigitalJourneyQuery(database),before=await query.read(root,ready.id);
    expect(before.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='sourcing_owner')?.state).toBe('completed');
    expect(before.links.some(link=>link.domain==='sourcing'&&link.id===ready.caseId)).toBe(true);
    await service.deleteByRoot(root,ready.caseId,randomUUID());
    await expect(service.getCase({...root,authorizationCapability:'sourcing:view'},ready.caseId)).rejects.toMatchObject({statusCode:404});
    const after=await query.read(root,ready.id),nodes=after.stages.flatMap(stage=>stage.nodes).filter(node=>['sourcing_preparation','sourcing_ie','sourcing_director','sourcing_owner'].includes(node.key));
    expect(nodes).toHaveLength(4);
    for(const node of nodes.filter(node=>node.key!=='sourcing_preparation'))expect(node).toMatchObject({state:'uncreated',owner:null,operator:null,actualAt:null,records:[]});
    // Original digital preparation task evidence survives; deleted native approvals do not.
    expect(nodes.find(node=>node.key==='sourcing_preparation')?.records.every(record=>record.domain==='task')).toBe(true);
    expect(after.links.some(link=>link.domain==='sourcing')).toBe(false);
    expect(JSON.stringify(after)).not.toContain(ready.caseId);
    expect((await ready.bulk.read(root,ready.id)).ownerApproved).toBe(false);
  });

  it.each(['in_house','outsourced'] as const)('P12 aggregates all original PO cutting facts and syncs numbers without restarting %s',async mode=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'none',{cuttingProcess:mode,stopAtReady:true}))!;
    const {id,caseId,people,cutting,bulk,instruction}=ready;
    const ids=(await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[caseId])).rows.map(r=>r.cutting_order_id);
    const internal={...people.cutting_worker!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create','cutting:orders:view']};
    const external={...primary,authorizationCapability:'cutting:records:create'};
    const recorder=mode==='in_house'?internal:external,wrong=mode==='in_house'?external:internal;
    const uploadApp=Fastify();let uploading=recorder;
    uploadApp.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ApplicationError?error.statusCode:500).send({error:{message:error.message}}));
    const intent=vi.spyOn(attachments,"createUploadIntent").mockResolvedValue({attachmentId:randomUUID(),objectKey:"TEST/P12-upload",uploadMethod:"POST",uploadUrl:"https://example.invalid/TEST",uploadFields:{},expiresAt:new Date().toISOString()});
    registerCuttingRoutes(uploadApp,{authenticate:async()=>({id:uploading.actorId,displayName:"TEST P12 uploader",businessRoles:uploading.actorRoles,capabilities:["cutting:orders:view","tools:user",...(mode==='in_house'?["cutting:records:create"]:[])]}),service:cutting,attachments});
    try {
      const payload={filename:"TEST-P12.png",mimeType:"image/png",sizeBytes:100,sha256:"c".repeat(64)};
      const url=`/cutting/orders/${ids[0]}/attachments/upload-intents`;
      const allowed=await uploadApp.inject({method:"POST",url,payload});expect(allowed.statusCode,allowed.body).toBe(201);expect(intent).toHaveBeenCalledOnce();
      uploading=wrong;expect((await uploadApp.inject({method:"POST",url,payload})).statusCode).toBe(403);expect(intent).toHaveBeenCalledOnce();
    }finally{await uploadApp.close();intent.mockRestore();}
    const photo=async(actor:typeof recorder)=>{const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-P12.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/P12/${image}`,'c'.repeat(64),actor.actorId]);return image;};
    await expect(cutting.record(wrong,ids[0],{pieceCount:2,actualCutCount:99,attachmentIds:[await photo(wrong)]},randomUUID())).rejects.toMatchObject({statusCode:403});
    await physicalCuttingLabelsFixture(database,root,ids[0],98);
    await expect(cutting.record(recorder,ids[0],{pieceCount:2,actualCutCount:99,attachmentIds:[await photo(recorder)]},randomUUID())).rejects.toMatchObject({statusCode:409});
    await physicalCuttingLabelsFixture(database,root,ids[0],99);
    await cutting.record(recorder,ids[0],{pieceCount:2,actualCutCount:99,attachmentIds:[await photo(recorder)]},randomUUID());
    expect((await bulk.read(primary,id)).cutting.completed).toBe(false);
    expect((await database.query('SELECT 1 FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rowCount).toBe(0);
    const cockpit=new DigitalCockpitQuery(database),cockpitInput={stage:'bulk' as const,page:1,search:fixture.order.designStyleNo};
    const partialProgress=(await cockpit.list(primary,cockpitInput)).items.find(row=>row.orderId===id)!;
    expect((await cockpit.list(recorder,cockpitInput)).items.some(row=>row.orderId===id)).toBe(true);
    const outsider={...fixture.designer,actorId:randomUUID()};
    expect((await cockpit.list(outsider,cockpitInput)).total).toBe(0);
    expect(partialProgress.lines).toHaveLength(2);// This published instruction explicitly excludes preshrink.
    const partialPreparation=await bulk.read(primary,id);
    expect(partialPreparation.preshrink).toBe('无需预缩');
    expect(partialPreparation.tasks.some(t=>t.taskKind==='warehouse_preshrink')).toBe(false);
    expect(partialPreparation.facts.some(f=>f.kind==='预缩完成')).toBe(false);
    expect(partialProgress.progress).toEqual({applicable:6,completed:1});
    const before=(await bulk.read(primary,id)).tasks.find(t=>t.taskKind.startsWith('bulk_cutting'))!;
    const identity=new DigitalProductionIdentityService(database,true,service),current=await identity.read(primary,id);
    const formal=`TEST-P12-${randomUUID().slice(0,8)}`;
    await identity.correctNumbers(primary,id,current.lines[0]!.lineId,{expectedVersion:current.version,formalPoNo:formal},randomUUID());
    expect((await cutting.get(root,ids[0])).formalStyleNo).toBe(formal);
    expect((await instruction.read(root,id,database,1)).order.lines[0]!.formalStyleNo).toBe(formal);
    expect((await database.query('SELECT max(identity_version)::int AS n FROM sourcing_contract_documents WHERE sourcing_case_id=$1',[caseId])).rows[0].n).toBe(1);
    const after=(await bulk.read(primary,id)).tasks.find(t=>t.taskKind.startsWith('bulk_cutting'))!;
    expect([after.taskId,after.enteredAt,after.dueAt]).toEqual([before.taskId,before.enteredAt,before.dueAt]);
    const beforeSla=await new SlaOrderService(database).read(root,id);expect(beforeSla.status).toBe('planned');
    if(beforeSla.status==='planned'){expect(beforeSla.nodes.find(n=>n.id==='bulk_cutting')!.actualEnd).toBeNull();expect(beforeSla.progress.stages.find(stage=>stage.stage===4)!.completed).toBe(0);}
    const input={pieceCount:3,actualCutCount:101,attachmentIds:[await photo(recorder)]},key=randomUUID();
    await physicalCuttingLabelsFixture(database,root,ids[1],input.actualCutCount);
    await cutting.record(recorder,ids[1],input,key);await cutting.record(recorder,ids[1],input,key);
    expect((await bulk.read(primary,id)).cutting.completed).toBe(true);
    const afterSla=await new SlaOrderService(database).read(root,id);expect(afterSla.status).toBe('planned');
    if(afterSla.status==='planned'){
      const cuttingNode=afterSla.nodes.find(n=>n.id==='bulk_cutting')!;
      expect(cuttingNode.actualEnd).not.toBeNull();expect(cuttingNode.planOverdue).toBe(false);
      expect(afterSla.progress.stages.find(stage=>stage.stage===4)!.completed).toBe(1);
      if(mode==='outsourced'){expect(cuttingNode.actualStart).toBeNull();expect(cuttingNode.deadline.at).toBeNull();expect(cuttingNode.status).toBe('completed_unrated');}
    }
    expect((await cockpit.list(primary,cockpitInput)).items.find(row=>row.orderId===id)!.progress).toEqual({applicable:6,completed:2});
    expect((await database.query('SELECT 1 FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rowCount).toBe(1);
    await cutting.correct({...root,authorizationCapability:'cutting:records:correct'},ids[0],{expectedVersion:1,pieceCount:4,actualCutCount:103,reason:'TEST真实实绩更正'},randomUUID());
    const final=await bulk.read(primary,id);expect(final.cutting.lines[0]).toMatchObject({orderQuantity:137,actualCutCount:103,pieceCount:4,corrected:true});
    expect(final.tasks.find(t=>t.taskId===before.taskId)).toMatchObject({state:'completed',enteredAt:before.enteredAt,dueAt:before.dueAt});
    expect((await database.query('SELECT 1 FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rowCount).toBe(1);
  });

  it("P14 reads empty receipt/packing facts before cutting for authorized users", async () => {
    const { order, designer } = await budgetFixture();
    const closure = new OrderClosureService(database);
    for (const actor of [designer, managerActor(), merchandiserActor()]) {
      const sheet = await closure.read(actor, order.productionOrderId);
      expect(sheet).toMatchObject({ stage: "等待回货与装箱", productionId: null, canClose: false, closed: null });
      expect(sheet.lines).toHaveLength(2);
      expect(sheet.lines.map(line => line.orderedQuantity)).toEqual([137, 63]);
      for (const line of sheet.lines) expect(line).toMatchObject({
        cuttingId: null, receivingBatchId: null, actualQuantity: 0, documentQuantity: 0,
        defectiveQuantity: 0, receiptCount: 0, packingQuantity: null, receipts: [], reworks: [],
      });
      expect(sheet.outstanding).toContain(`${order.lines[0]!.formalStyleNo} 黑：尚无原收货事实`);
      expect(sheet.outstanding).toContain(`${order.lines[1]!.formalStyleNo} 白：尚无原装箱事实`);
    }
    await expect(closure.read({ ...designer, actorId: randomUUID() }, order.productionOrderId))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('SLA07 records factory inspection completion separately from quality and reporter status without a ship-sample gate',async()=>{
    const primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database);
    const configClient=await database.connect(),config=new SlaConfigurationService(),repo=new SlaConfigurationRepository(configClient);
    const before=await(async()=>{await configClient.query('BEGIN');try{const result=await repo.initialStandard(root.actorId);await configClient.query('COMMIT');return result;}catch(e){await configClient.query('ROLLBACK');configClient.release();throw e;}})();
    const publish=async(values:typeof before.values)=>{await configClient.query('BEGIN');try{const current=await repo.initialStandard(root.actorId);await config.publishNewStandard(configClient,root,{expectedVersion:current.version,values,reason:'TEST船样冻结标准',requestKey:randomUUID()});await configClient.query('COMMIT');}catch(e){await configClient.query('ROLLBACK');throw e;}};
    let fixture:Awaited<ReturnType<typeof budgetFixture>>;
    try{await publish({...before.values,ship_sample_advance:{kind:'offset',days:12}});fixture=await budgetFixture();}finally{try{await publish(before.values);}finally{configClient.release();}}
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft:'无'}))!;
    for(const row of (await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows){const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-qc.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/factory-qc/${image}`,'d'.repeat(64),root.actorId]);await physicalCuttingLabelsFixture(database,root,row.cutting_order_id,100);await ready.cutting.record({...root,authorizationCapability:'cutting:records:create'},row.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[image]},randomUUID());}
    let state=await flow.read(ready.people.warehouse_receiver!,ready.id);
    state=await flow.dispatch(ready.people.warehouse_receiver!,ready.id,{expectedRevision:state.revision,supplierId:factoryId,occurredAt:new Date().toISOString(),note:'TEST无船样照原流程发厂'},randomUUID());
    expect(state.shipSamples).toHaveLength(0);
    const task=(await flow.read(root,ready.id)).tasks.find(t=>t.taskKind==='factory_production_qc')!,qc=ready.people.quality_control!;
    await new DigitalProductionTaskService(database).reassign(root,task.taskId,qc.actorId,randomUUID());
    state=await flow.read(qc,ready.id);expect(state.canProductionQc).toBe(true);
    const input={expectedRevision:state.revision,factoryDecisionId:null,occurredAt:new Date().toISOString(),note:'TEST检查完但质量需处理',checks:state.productionChecks!.map(c=>({lineId:c.lineId,result:'需处理' as const,problem:'TEST缝线问题'}))};
    await expect(flow.productionQc(ready.people.warehouse_receiver!,ready.id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    const key=randomUUID();state=await flow.productionQc(qc,ready.id,input,key);await flow.productionQc(qc,ready.id,input,key);
    expect(state.productionChecks!.every(c=>c.inspected&&c.result==='需处理')).toBe(true);
    expect((await factoryProductionFacts(database,ready.id)).complete).toBe(true);
    expect(state.tasks.find(t=>t.taskKind==='factory_production_qc')?.state).toBe('completed');
    expect((await database.query('SELECT sourcing_factory_order_status($1) AS status',[state.productionId])).rows[0].status).toBe('in_production');
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='factory_garment_qc'",[ready.id])).rows[0].n).toBe(1);
    expect(state.shipSamples).toHaveLength(0);
    expect((await new OrderClosureService(database).read(root,ready.id)).outstanding.some(reason=>reason.includes('船样'))).toBe(false);
    expect(state.sampleTargetDate).toBe('2026-11-08');
    const reporting=new ProductionReportingService(database),detail=await reporting.detail(root,state.productionId!);
    expect(detail.order.poDeliveryDates!.every(l=>l.sampleTargetDate==='2026-11-08')).toBe(true);
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    for(const line of detail.order.lines)await reporting.report(root,state.productionId!,{position:line.position,businessDate:day,quantity:line.quantity},randomUUID());
    await reporting.execute(root,state.productionId!,'complete',{businessDate:day,confirmed:true},randomUUID());
    await reporting.execute(root,state.productionId!,'ship',{businessDate:day,confirmed:true},randomUUID());
    const logistics=await factoryReturnLogistics(database,ready.id,new Date(Date.now()+4*86400000));
    expect(logistics[0]).toMatchObject({dispatchPrecision:'date',actualDispatchedAt:null,shippedOn:day,estimatedMinutes:2880,estimateExpired:true,firstReceivedAt:null});
    expect(Date.parse(logistics[0]!.arrivalRange!.toExclusive)-Date.parse(logistics[0]!.arrivalRange!.fromInclusive)).toBe(86400000);
    // Read-only trusted-clock fixture: native shipment facts above stay untouched.
    const closure=new OrderClosureService(database),boundary=Date.parse(logistics[0]!.arrivalRange!.toExclusive);
    for(const offset of [-1,0,1]){
      const [factory,receiving]=await withAcceptanceBusinessTime({scenarioId:'TEST-logistics-clock',configurationId:'TEST-read-only',time:{scenarioId:'TEST-logistics-clock',revision:1,now:new Date(boundary+offset).toISOString()},assertScope:async scope=>{expect(scope).toEqual({kind:'order',id:ready.id});},acceptsActor:async userId=>[root.actorId,qc.actorId].includes(userId),registerCreated:async()=>{throw new Error('TEST read-only clock must not create business data');}},()=>Promise.all([flow.read(qc,ready.id),closure.read(root,ready.id)]));
      expect(factory.returnLogistics![0]!.estimateExpired).toBe(offset>=0);
      expect(receiving.receivingForecast!.state).toBe(offset<0?'estimated':'unknown');
      expect(receiving.collection!.received).toBe(0);
    }
    // Leaving the scene restores real-time reads; changing time creates no receipt.
    expect((await flow.read(qc,ready.id)).returnLogistics![0]!.estimateExpired).toBe(false);
    expect((await closure.read(root,ready.id)).receivingForecast!.state).toBe('estimated');
    expect((await new SlaOrderService(database).read(root,ready.id)).nodes!.filter(n=>n.id.startsWith('return_logistics:')).every(n=>n.actualStart===null&&n.deadline.at===null)).toBe(true);
    state=await flow.read(qc,ready.id);
    if(process.env.SLA_FACTORY_QC_UI_INPUT)await writeFile(process.env.SLA_FACTORY_QC_UI_INPUT,JSON.stringify({productionQc:state}));
  });

  it('SLA08 keeps collected, original packing and receipt corrections independent without a sample gate',async()=>{
    const primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database);
    const configClient=await database.connect(),config=new SlaConfigurationService(),repo=new SlaConfigurationRepository(configClient);
    const before=await(async()=>{await configClient.query('BEGIN');try{const result=await repo.initialStandard(root.actorId);await configClient.query('COMMIT');return result;}catch(e){await configClient.query('ROLLBACK');configClient.release();throw e;}})();
    const publish=async(values:typeof before.values)=>{await configClient.query('BEGIN');try{const current=await repo.initialStandard(root.actorId);await config.publishNewStandard(configClient,root,{expectedVersion:current.version,values,reason:'TEST船样冻结标准',requestKey:randomUUID()});await configClient.query('COMMIT');}catch(e){await configClient.query('ROLLBACK');throw e;}};
    let fixture:Awaited<ReturnType<typeof budgetFixture>>;
    try{await publish({...before.values,ship_sample_advance:{kind:'offset',days:12}});fixture=await budgetFixture();}finally{try{await publish(before.values);}finally{configClient.release();}}
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft:'无'}))!;
    for(const row of (await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows){const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-qc.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/factory-qc/${image}`,'d'.repeat(64),root.actorId]);await physicalCuttingLabelsFixture(database,root,row.cutting_order_id,100);await ready.cutting.record({...root,authorizationCapability:'cutting:records:create'},row.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[image]},randomUUID());}
    let state=await flow.read(ready.people.warehouse_receiver!,ready.id);
    state=await flow.dispatch(ready.people.warehouse_receiver!,ready.id,{expectedRevision:state.revision,supplierId:factoryId,occurredAt:new Date().toISOString(),note:'TEST无船样照原流程发厂'},randomUUID());
    expect(state.shipSamples).toHaveLength(0);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) SELECT $1,$2::uuid,'dingtalk','corp',$2::text,$2::text,true,true,CURRENT_TIMESTAMP WHERE NOT EXISTS(SELECT 1 FROM identity_mappings WHERE user_id=$2)",[randomUUID(),root.actorId]);
    await database.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) SELECT true,$1,i.provider_user_id,i.corp_id FROM identity_mappings i WHERE i.user_id=$1 AND i.active LIMIT 1 ON CONFLICT DO NOTHING",[root.actorId]);
    const identity=new DigitalProductionIdentityService(database,true,service),receiving=new ReceivingService(database),closure=new OrderClosureService(database);
    let order=await identity.read(primary,ready.id);
    for(const line of order.lines)order=await identity.correctNumbers(primary,ready.id,line.lineId,{expectedVersion:order.version,formalStyleNo:`TEST-SLA08-${randomUUID().slice(0,8)}`},randomUUID());
    const receivedDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(Date.now()-86_400_000));
    const receipts=[];
    for(const line of (await closure.read(root,ready.id)).lines){
      const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-receipt.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/receipt/${image}`,'a'.repeat(64),root.actorId]);
      const input={cuttingOrderId:line.cuttingId!,documentQuantity:line.orderedQuantity,actualQuantity:line.orderedQuantity,defectiveQuantity:0,attachmentIds:[image],receivedDate},key=randomUUID();
      const receipt=await receiving.create({...root,authorizationCapability:'receiving:create'},input,key);
      await receiving.create({...root,authorizationCapability:'receiving:create'},input,key);receipts.push(receipt.value);
    }
    const notices=new DigitalProductionNotificationService(database);
    const qcTodos=async()=> (await notices.todos(root)).filter(t=>t.entityId===ready.id&&t.category==='digital_garment_quality');
    expect(await qcTodos()).toHaveLength(2);
    expect((await qcTodos()).every(t=>t.timing?.status==='unknown'&&t.timing.elapsedSeconds===null)).toBe(true);
    let sheet=await closure.read(root,ready.id);
    expect(sheet.collection).toMatchObject({expected:200,received:200,status:'已收齐',shipmentQuantity:0});
    expect(sheet.stage).toBe('等待回货与装箱');
    expect(sheet.lines.flatMap(l=>l.receipts).every(r=>r.receivedAt===null&&r.receivedDate===receivedDate)).toBe(true);
    const first=sheet.lines[0]!,style=order.lines.find(l=>l.lineId===first.lineId)!.formalStyleNo!;
    let board=(await receiving.board('2000-01-01','2999-12-31',style)).rows[0]!;
    const quality=sheet.quality!.find(q=>q.lineId===first.lineId)!,qualityInput={receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,occurredAt:new Date().toISOString(),qualifiedQuantity:40,problem:'TEST其余待返工'},qcKey=randomUUID();
    await expect(closure.recordQuality(ready.people.warehouse_receiver!,ready.id,qualityInput,randomUUID())).rejects.toMatchObject({statusCode:403});
    const lifecycle=new DigitalProductionTaskService(database),qc=ready.people.quality_control!;
    const qcTask=(await flow.read(root,ready.id)).tasks.find(t=>t.taskKind==='factory_production_qc')!;
    await lifecycle.reassign(root,qcTask.taskId,qc.actorId,randomUUID());
    await lifecycle.controlResource(root,{kind:'source',id:ready.sourceId},'pause','TEST来源暂停，母单仍活动',randomUUID());
    expect(await qcTodos()).toHaveLength(0);
    for(const viewer of [root,qc])await expect(closure.recordQuality(viewer,ready.id,qualityInput,randomUUID())).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('开发来源')});
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='garment_receipt_qc'",[ready.id])).rows[0].n).toBe(0);
    expect((await closure.read(root,ready.id)).quality!.find(q=>q.receiptId===quality.receiptId)?.inspected).toBe(false);
    await lifecycle.controlResource(root,{kind:'source',id:ready.sourceId},'resume','TEST来源恢复，原检查继续',randomUUID());
    expect(await qcTodos()).toHaveLength(2);
    await closure.recordQuality(qc,ready.id,qualityInput,qcKey);await closure.recordQuality(qc,ready.id,qualityInput,qcKey);
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='garment_receipt_qc'",[ready.id])).rows[0].n).toBe(1);
    expect(await qcTodos()).toHaveLength(1);
    const sla=await new SlaOrderService(database).read(root,ready.id);expect(sla.garments!.windows.find(w=>w.receiptId===quality.receiptId)).toMatchObject({complete:true,startedAt:null,deadline:null});
    await receiving.recordPacking({...root,authorizationCapability:'receiving:packing_manage'},{receivingBatchId:board.receivingBatchId,expectedVersion:board.version,expectedPackingRevisionId:null,packingQuantity:40},randomUUID());
    sheet=await closure.read(root,ready.id);expect(sheet.collection).toMatchObject({status:'已收齐',shipmentQuantity:40});
    expect(sheet.shipmentStatus).toBe('按有效装箱记录');expect(state.shipSamples).toHaveLength(0);
    board=(await receiving.board('2000-01-01','2999-12-31',style)).rows[0]!;
    const correction={expectedVersion:board.version,source:'jiashun' as const,documentQuantity:first.documentQuantity,actualQuantity:first.actualQuantity-1,defectiveQuantity:0};
    const results=await Promise.allSettled([receiving.correctReceipt({...root,authorizationCapability:'receiving:correct'},receipts[0]!.receiptId,correction),receiving.correctReceipt({...root,authorizationCapability:'receiving:correct'},receipts[0]!.receiptId,{...correction,actualQuantity:first.actualQuantity-2})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(await reworkSlaEvidence(database,ready.id)).toMatchObject({facts:{},windows:[]});
    const corrected=await closure.read(root,ready.id);expect(corrected.collection!.status).toBe('待收齐');expect(corrected.collection!.remaining).toBeGreaterThan(0);expect(corrected.collection!.shipmentQuantity).toBe(40);expect(corrected.receivingSpan!.history.map(h=>h.state)).toEqual(['已收齐','待收齐']);expect(corrected.receivingSpan!.elapsedHours).toBeNull();
    expect(await qcTodos()).toHaveLength(2);
    expect(corrected.quality!.find(q=>q.receiptId===quality.receiptId)).toMatchObject({inspected:false,priorInspection:true});
    await expect(closure.recordQuality(root,ready.id,qualityInput,randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(corrected.lines[0]!.packingRevisionId).toBe(sheet.lines[0]!.packingRevisionId);
    expect((await database.query('SELECT count(*)::int n FROM receiving_receipt_corrections WHERE receipt_id=$1',[receipts[0]!.receiptId])).rows[0].n).toBe(1);
    await lifecycle.controlResource(root,{kind:'source',id:ready.sourceId},'cancel','TEST取消来源保留旧质检',randomUUID());
    expect((await database.query("SELECT coalesce((SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1),'active') AS state",[ready.id])).rows[0].state).toBe('active');
    const remainingQuality=corrected.quality!.find(q=>q.receiptId!==quality.receiptId)!,nextInput={receiptId:remainingQuality.receiptId,quantityVersion:remainingQuality.quantityVersion,occurredAt:new Date().toISOString(),qualifiedQuantity:remainingQuality.quantity,problem:''};
    for(const viewer of [root,qc])await expect(closure.recordQuality(viewer,ready.id,nextInput,randomUUID())).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('开发来源')});
    expect(await qcTodos()).toHaveLength(0);
    expect((await closure.read(root,ready.id)).quality).toEqual(corrected.quality);
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='garment_receipt_qc'",[ready.id])).rows[0].n).toBe(1);
    const finalSheet=await closure.read(root,ready.id);
    if(process.env.SLA_CLOSURE_UI_INPUT)await writeFile(process.env.SLA_CLOSURE_UI_INPUT,JSON.stringify(corrected));
    await expect(closure.close(ready.people.warehouse_receiver!,ready.id,{reason:'TEST普通仓库不能审批结案',expectedRevision:finalSheet.revision},randomUUID())).rejects.toMatchObject({statusCode:403});
    expect((await closure.read(ownerActor(),ready.id)).canClose).toBe(true);
    const closed=await closure.close(ownerActor(),ready.id,{reason:'TEST老板保留未清质量/数量事项特殊结案',expectedRevision:finalSheet.revision},randomUUID());
    expect(closed.closed).not.toBeNull();expect(closed.collection!.status).toBe('待收齐');expect(closed.lines[0]!.packingRevisionId).toBe(corrected.lines[0]!.packingRevisionId);
  });

  it('SLA08 accepts standalone historical receipt QC without borrowing an unrelated source lifecycle',async()=>{
    const fixture=await budgetFixture(false,'TEST-SLA08-STANDALONE'),root=rootActor(),id=fixture.order.productionOrderId;
    expect((await database.query('SELECT source_id FROM digital_production_orders WHERE production_order_id=$1',[id])).rows[0].source_id).toBeNull();
    const identity=new DigitalProductionIdentityService(database,true),unrelated=await identity.createSource(fixture.designer,{developmentType:'头版',designStyleNo:`TEST-UNRELATED-${randomUUID()}`,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
    await new DigitalProductionTaskService(database).controlResource(root,{kind:'source',id:unrelated.sourceId},'cancel','TEST无关来源不影响独立母单',randomUUID());
    const receipt=await receiving.create({...root,authorizationCapability:'receiving:create'},{styleNo:fixture.order.designStyleNo,documentQuantity:3,actualQuantity:3,defectiveQuantity:0,attachmentIds:[await readyCuttingSheet(root.actorId)]},randomUUID());
    // Isolated legacy-import fixture: seed a stable original child association;
    // never remove/rebind a source or expose an arbitrary legacy-linking endpoint.
    const client=await database.connect();try{await client.query('BEGIN');await linkNewDigitalChild(client,{module:'receiving',childId:receipt.value.receiptId,productionOrderId:id,lines:[{childLineKey:'record',lineId:fixture.order.lines[0]!.lineId}]});await registerGarmentReceipt(client,id,receipt.value.receiptId);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const closure=new OrderClosureService(database),quality=(await closure.read(root,id)).quality![0]!,input={receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,occurredAt:new Date().toISOString(),qualifiedQuantity:3,problem:''};
    await expect(closure.recordQuality(merchandiserActor(),id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    await closure.recordQuality(root,id,input,randomUUID());
    expect((await closure.read(root,id)).quality![0]).toMatchObject({receiptId:receipt.value.receiptId,inspected:true,qualifiedQuantity:3});
  });

  it('SLA07 projects transferred factory scope as pending without erasing prior inspection history',async()=>{
    const primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database);
    const configClient=await database.connect(),config=new SlaConfigurationService(),repo=new SlaConfigurationRepository(configClient);
    const before=await(async()=>{await configClient.query('BEGIN');try{const result=await repo.initialStandard(root.actorId);await configClient.query('COMMIT');return result;}catch(e){await configClient.query('ROLLBACK');configClient.release();throw e;}})();
    const publish=async(values:typeof before.values)=>{await configClient.query('BEGIN');try{const current=await repo.initialStandard(root.actorId);await config.publishNewStandard(configClient,root,{expectedVersion:current.version,values,reason:'TEST船样冻结标准',requestKey:randomUUID()});await configClient.query('COMMIT');}catch(e){await configClient.query('ROLLBACK');throw e;}};
    let fixture:Awaited<ReturnType<typeof budgetFixture>>;
    try{await publish({...before.values,ship_sample_advance:{kind:'offset',days:12}});fixture=await budgetFixture();}finally{try{await publish(before.values);}finally{configClient.release();}}
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft:'无'}))!;
    for(const row of (await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows){const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-qc.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/factory-qc/${image}`,'d'.repeat(64),root.actorId]);await physicalCuttingLabelsFixture(database,root,row.cutting_order_id,100);await ready.cutting.record({...root,authorizationCapability:'cutting:records:create'},row.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[image]},randomUUID());}
    let state=await flow.read(ready.people.warehouse_receiver!,ready.id);
    state=await flow.dispatch(ready.people.warehouse_receiver!,ready.id,{expectedRevision:state.revision,supplierId:factoryId,occurredAt:new Date().toISOString(),note:'TEST无船样照原流程发厂'},randomUUID());
    expect(state.shipSamples).toHaveLength(0);
    const task=(await flow.read(root,ready.id)).tasks.find(t=>t.taskKind==='factory_production_qc')!,qc=ready.people.quality_control!;
    await new DigitalProductionTaskService(database).reassign(root,task.taskId,qc.actorId,randomUUID());
    state=await flow.read(qc,ready.id);expect(state.canProductionQc).toBe(true);
    const input={expectedRevision:state.revision,factoryDecisionId:null,occurredAt:new Date().toISOString(),note:'TEST检查完但质量需处理',checks:state.productionChecks!.map(c=>({lineId:c.lineId,result:'需处理' as const,problem:'TEST缝线问题'}))};
    await expect(flow.productionQc(ready.people.warehouse_receiver!,ready.id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    const key=randomUUID();state=await flow.productionQc(qc,ready.id,input,key);await flow.productionQc(qc,ready.id,input,key);
    expect(state.productionChecks!.every(c=>c.inspected&&c.result==='需处理')).toBe(true);
    expect((await factoryProductionFacts(database,ready.id)).complete).toBe(true);
    expect(state.tasks.find(t=>t.taskKind==='factory_production_qc')?.state).toBe('completed');
    expect((await database.query('SELECT sourcing_factory_order_status($1) AS status',[state.productionId])).rows[0].status).toBe('in_production');
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='factory_garment_qc'",[ready.id])).rows[0].n).toBe(1);
    expect(state.shipSamples).toHaveLength(0);
    expect((await new OrderClosureService(database).read(root,ready.id)).outstanding.some(reason=>reason.includes('船样'))).toBe(false);
    expect(state.sampleTargetDate).toBe('2026-11-08');
    const changed=await service.requestFactoryChange(ownerActor(),ready.caseId,{supplierId:replacementFactoryId,unitPrice:'12.0000',changeReason:'TEST已检后转厂'},randomUUID());
    expect(changed.value.decision?.supplierId).toBe(replacementFactoryId);
    const tasks=new DigitalProductionTaskService(database),notices=new DigitalProductionNotificationService(database);
    expect((await tasks.read(qc,task.taskId)).state).toBe('ready');
    expect((await factoryProductionFacts(database,ready.id)).complete).toBe(false);
    expect((await notices.todos(qc)).some(t=>t.todoId===task.taskId&&t.status==='pending')).toBe(true);
    expect((await notices.todos(qc)).find(t=>t.todoId===task.taskId)?.timing).toMatchObject({exclusive:true,elapsedSeconds:null});
    expect((await new OrderClosureService(database).read(root,ready.id)).outstanding.some(reason=>reason.includes('工厂'))).toBe(true);
    await expect(tasks.reassign(ready.people.warehouse_receiver!,task.taskId,qc.actorId,randomUUID())).rejects.toMatchObject({statusCode:403});
    // Isolated fixture: an unavailable assignee must route to the existing assignment action.
    await database.query('UPDATE digital_production_task_access SET assignee_id=NULL WHERE task_id=$1',[task.taskId]);
    expect((await notices.todos(qc)).some(t=>t.todoId===task.taskId)).toBe(false);
    expect((await notices.todos(root)).find(t=>t.todoId===task.taskId)).toMatchObject({todoType:'recipient_routing_exception',status:'blocked_recipient'});
    await tasks.reassign(root,task.taskId,qc.actorId,randomUUID());
    state=await flow.read(qc,ready.id);
    const pending=state.productionChecks!.filter(c=>!c.inspected);
    expect(pending.length).toBeGreaterThan(0);
    state=await flow.productionQc(qc,ready.id,{expectedRevision:state.revision,factoryDecisionId:pending[0]!.factoryDecisionId,occurredAt:new Date().toISOString(),note:'TEST新厂独立检查',checks:pending.map(c=>({lineId:c.lineId,result:'合格' as const,problem:''}))},randomUUID());
    expect((await tasks.read(qc,task.taskId)).state).toBe('completed');
    expect((await factoryProductionFacts(database,ready.id)).history).toHaveLength(2);
    expect((await notices.todos(qc)).some(t=>t.todoId===task.taskId)).toBe(false);
    expect((await tasks.reassign(root,task.taskId,qc.actorId,randomUUID())).assigneeId).toBe(qc.actorId); // QC quality completion does not end ongoing production supervision.
  });

  it('SLA07 records ship samples before cutting with original permissions and immutable PO facts',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),flow=new FactoryFlowService(database),id=fixture.order.productionOrderId;
    let state=await flow.read(primary,id);expect(state.allCut).toBe(false);expect(state.canRecordShipSample).toBe(true);
    const lineIds=state.lines.map(l=>l.lineId);expect(lineIds.length).toBeGreaterThan(0);
    expect((await shipSampleTargets(database,id)).lines[0]).toMatchObject({targetDate:'2026-11-10',dueAt:'2026-11-10T16:00:00.000Z'});
    expect(state.tasks.find(t=>t.taskKind==='bulk_ship_sample')?.dueAt).toBe('2026-11-10T16:00:00.000Z');
    if(process.env.SLA_SAMPLE_UI_INPUT)await writeFile(process.env.SLA_SAMPLE_UI_INPUT,JSON.stringify({sample:state}));
    const input={expectedRevision:state.revision,kind:'船样寄出' as const,lineIds,occurredAt:new Date(Date.now()-3600000).toISOString(),trackingNumber:'TEST-SAMPLE-07',note:'TEST生产前寄样'};
    await expect(flow.followup(ieActor(),id,input,randomUUID())).rejects.toMatchObject({statusCode:404});
    await expect(flow.followup(primary,id,{...input,trackingNumber:''},randomUUID())).rejects.toMatchObject({statusCode:409});
    const key=randomUUID();state=await flow.followup(primary,id,input,key);await flow.followup(primary,id,input,key);
    expect(state.allCut).toBe(false);expect(state.shipSamples).toHaveLength(1);expect(state.shipSamples![0]).toMatchObject({lineIds,occurredAt:input.occurredAt,trackingNumber:input.trackingNumber});
    expect(state.tasks.find(t=>t.taskKind==='bulk_ship_sample')?.state).toBe('completed');
    expect((await shipSampleSlaEvidence(database,id))[`ship_sample:${lineIds[0]}`]).toMatchObject({businessCompleted:true,completedAt:input.occurredAt});
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='ship_sample_sent'",[id])).rows[0].n).toBe(1);
    expect((await database.query('SELECT count(*)::int n FROM digital_factory_routes WHERE production_order_id=$1',[id])).rows[0].n).toBe(0);
  });

  it('SLA07 preserves date-only deadline boundaries and duration constraints without inventing a start',async()=>{
    const fixture=await budgetFixture(false,"TEST-SAMPLE-BOUNDARY","2026-11-25"),primary=merchandiserActor(),flow=new FactoryFlowService(database),id=fixture.order.productionOrderId;
    const state=await flow.read(primary,id),task=state.tasks.find(t=>t.taskKind==='bulk_ship_sample')!;
    expect(task.enteredAt).toBeNull();expect(task.warningAt).toBeNull();
    const notices=new DigitalProductionNotificationService(database),now=vi.spyOn(Date,'now');
    const count=async()=>Number((await database.query("SELECT count(*)::int n FROM digital_production_notification_events WHERE task_id=$1 AND event_kind='overdue'",[task.taskId])).rows[0].n);
    try{
      now.mockReturnValue(Date.parse(task.dueAt!)-1);await notices.runOnce();expect(await count()).toBe(0);
      now.mockReturnValue(Date.parse(task.dueAt!));await notices.runOnce();await notices.runOnce();expect(await count()).toBe(1);
    }finally{now.mockRestore();}
    await expect(database.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,due_at,reason,changed_by)
      SELECT task_id,policy_node_key,policy_version,due_at,'policy',changed_by FROM digital_production_deadline_revisions WHERE task_id=$1 LIMIT 1`,[task.taskId])).rejects.toMatchObject({code:'23514'});
    await expect(database.query(`UPDATE digital_production_deadline_revisions SET due_at=due_at+interval '1 day' WHERE task_id=$1`,[task.taskId])).rejects.toBeDefined();
    const input={expectedRevision:state.revision,kind:'船样寄出' as const,occurredAt:new Date(Date.now()-3600000).toISOString(),trackingNumber:'TEST-PARTIAL-SAMPLE',note:''};
    const first=await flow.followup(primary,id,{...input,lineIds:[state.lines[0]!.lineId]},randomUUID());
    expect(first.tasks.find(t=>t.taskKind==='bulk_ship_sample')).toMatchObject({state:'ready',dueAt:'2026-11-15T16:00:00.000Z'});
    expect((await database.query('SELECT due_at FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id LIMIT 1',[task.taskId])).rows[0].due_at.toISOString()).toBe(task.dueAt);
    const second=await flow.followup(primary,id,{...input,lineIds:[state.lines[1]!.lineId],occurredAt:new Date(Date.parse(input.occurredAt)-3600000).toISOString()},randomUUID());
    expect(second.tasks.find(t=>t.taskKind==='bulk_ship_sample')).toMatchObject({state:'completed',completedAt:input.occurredAt});
    expect(second.shipSamples).toHaveLength(2);
  });

  it('SLA06 serializes Root cutting correction against stale partial dispatch and keeps the opened deadline',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database);
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft:'无'}))!;
    const cutRows=(await database.query("SELECT c.cutting_order_id,l.line_id FROM cutting_orders c JOIN digital_production_child_lines l ON l.module='cutting' AND l.child_id=c.cutting_order_id WHERE c.sourcing_case_id=$1 ORDER BY c.sourcing_line_position",[ready.caseId])).rows;
    for(const row of cutRows){const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-race.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/race/${image}`,'c'.repeat(64),root.actorId]);await physicalCuttingLabelsFixture(database,root,row.cutting_order_id,100);await ready.cutting.record({...root,authorizationCapability:'cutting:records:create'},row.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[image]},randomUUID());}
    const warehouse=ready.people.warehouse_receiver!,lineId=cutRows[0]!.line_id,cutId=cutRows[0]!.cutting_order_id;
    let state=await flow.read(warehouse,ready.id);
    const deadline=state.batchWindows!.find(w=>w.lineId===lineId&&w.kind==='warehouse_dispatch')!.dueAt;
    state=await flow.dispatch(warehouse,ready.id,{expectedRevision:state.revision,lines:[{lineId,quantity:40}],supplierId:factoryId,occurredAt:new Date().toISOString(),note:'TEST先发40'},randomUUID());
    expect(state.batchWindows!.find(w=>w.lineId===lineId&&w.kind==='warehouse_dispatch')!.dueAt).toBe(deadline);
    const locked=Promise.withResolvers<number>(),resume=Promise.withResolvers<void>();
    const cutter=ready.cutting as unknown as {lockActiveOrder(client:pg.PoolClient,id:string):Promise<void>},original=cutter.lockActiveOrder.bind(cutter);
    const barrier=vi.spyOn(cutter,'lockActiveOrder').mockImplementation(async(client,id)=>{await original(client,id);locked.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await resume.promise;});
    const correction=ready.cutting.correct({...root,authorizationCapability:'cutting:records:correct'},cutId,{expectedVersion:1,pieceCount:1,actualCutCount:80,reason:'TEST纠正实裁为80'},randomUUID());
    void correction.catch(error=>locked.reject(error));
    let outcome:Promise<{ok:boolean;error?:unknown}>|undefined;
    try{
      const pid=await locked.promise;
      outcome=flow.dispatch(warehouse,ready.id,{expectedRevision:state.revision,lines:[{lineId,quantity:60}],supplierId:factoryId,occurredAt:new Date().toISOString(),note:'TEST旧余量60'},randomUUID()).then(()=>({ok:true}),error=>({ok:false,error}));
      let waiting=false;for(let i=0;i<40&&!waiting;i++){waiting=Boolean((await database.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND $1=ANY(pg_blocking_pids(pid))",[pid])).rowCount);if(!waiting)await new Promise(resolve=>setTimeout(resolve,5));}
      expect(waiting).toBe(true);resume.resolve();await correction;
      expect(await outcome).toMatchObject({ok:false,error:{statusCode:409}});
    }finally{resume.resolve();await Promise.allSettled([correction,...(outcome?[outcome]:[])]);barrier.mockRestore();}
    await expect(ready.cutting.correct({...root,authorizationCapability:'cutting:records:correct'},cutId,{expectedVersion:1,pieceCount:1,actualCutCount:100,reason:'TEST过期版本'},randomUUID())).rejects.toMatchObject({statusCode:409});
    state=await flow.read(warehouse,ready.id);expect(state.batchTotals!.find(l=>l.lineId===lineId)).toMatchObject({quantity:80,sent:40,remaining:40});
    expect(state.batchWindows!.find(w=>w.lineId===lineId&&w.kind==='warehouse_dispatch')!.dueAt).toBe(deadline);
    await expect(flow.dispatch(warehouse,ready.id,{expectedRevision:state.revision,lines:[{lineId,quantity:40}],supplierId:randomUUID(),occurredAt:new Date().toISOString(),note:'TEST非当前批准厂'},randomUUID())).rejects.toMatchObject({statusCode:409});
    state=await flow.dispatch(warehouse,ready.id,{expectedRevision:state.revision,lines:[{lineId,quantity:40}],supplierId:factoryId,occurredAt:new Date().toISOString(),note:'TEST按更正后余量发出'},randomUUID());
    expect(state.batchTotals!.find(l=>l.lineId===lineId)).toMatchObject({quantity:80,sent:80,remaining:0});
    expect((await database.query('SELECT count(*)::int n FROM sourcing_production_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].n).toBe(1);
    expect((await database.query("SELECT count(*)::int n FROM digital_factory_facts WHERE preparation_id=$1 AND kind='仓库实际发厂'",[state.preparationId])).rows[0].n).toBe(2);
  });

  it('SLA06 retains historical whole-order dispatch without adopting batch facts or fake QC',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database);
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft:'无'}))!;
    // Isolated fixture models a preparation persisted before the additive migrations.
    const legacyApproval=(await new BulkPreparationService(database).gates(database,ready.id)).approval.sourcing_approval_snapshot_id;
    const client=await database.connect();try{await client.query('BEGIN');await client.query('ALTER TABLE digital_bulk_preparations DISABLE TRIGGER USER');await client.query("UPDATE digital_bulk_preparations SET workflow_version=1,sla_snapshot_id=NULL,approval_snapshot_id=$2 WHERE production_order_id=$1",[ready.id,legacyApproval]);await client.query('ALTER TABLE digital_bulk_preparations ENABLE TRIGGER USER');await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    for(const row of (await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows){const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-legacy-batch.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/legacy-batch/${image}`,'c'.repeat(64),root.actorId]);await physicalCuttingLabelsFixture(database,root,row.cutting_order_id,100);await ready.cutting.record({...root,authorizationCapability:'cutting:records:create'},row.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[image]},randomUUID());}
    let state=await flow.read(ready.people.warehouse_receiver!,ready.id);expect(state.batchMode).toBe(false);expect(state.tasks.some(t=>t.taskKind==='bulk_qc')).toBe(false);
    const beforeDispatch=Date.now(),input={expectedRevision:state.revision,supplierId:factoryId,note:'TEST旧路线'},key=randomUUID();
    state=await flow.dispatch(ready.people.warehouse_receiver!,ready.id,input,key);await flow.dispatch(ready.people.warehouse_receiver!,ready.id,input,key);
    const occurred=Date.parse(state.facts.find(f=>f.kind==='仓库实际发厂')!.occurredAt!);expect(occurred).toBeGreaterThanOrEqual(beforeDispatch);expect(occurred).toBeLessThanOrEqual(Date.now());
    expect((await database.query("SELECT count(*)::int n FROM digital_factory_facts WHERE preparation_id=$1 AND kind='仓库实际发厂'",[state.preparationId])).rows[0].n).toBe(1);
    expect(state.dispatched).toBe(true);expect(state.facts.find(f=>f.kind==='仓库实际发厂')!.payload.lines).toBeUndefined();expect(state.checks).toHaveLength(0);
  });

  it('SLA06 keeps QC upload eligibility on returned batch A while later batch B is in transit',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database),tasks=new DigitalProductionTaskService(database);
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft:'印花'}))!;
    const {id,caseId,people,cutting}=ready,logistics=people.embroidery_washing_merchandiser!,qc=people.quality_control!,warehouse=people.warehouse_receiver!;
    for(const row of (await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[caseId])).rows){await physicalCuttingLabelsFixture(database,root,row.cutting_order_id,100);await cutting.record({...root,authorizationCapability:'cutting:records:create'},row.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[await readyCuttingSheet(root.actorId)]},randomUUID());}
    let state=await flow.read(root,id);
    const noWindow=state.tasks.find(t=>t.taskKind==='bulk_qc')!;
    const pendingTodo=(await new DigitalProductionNotificationService(database).todos(managerActor())).find(t=>t.todoId===noWindow.taskId)!;
    expect(pendingTodo).toMatchObject({status:'blocked_recipient',dueAt:null,timing:{status:'unknown',elapsedSeconds:null}});

    for(const [kind,actor] of [['process_logistics',logistics],['bulk_qc',qc]] as const)await tasks.reassign(root,state.tasks.find(t=>t.taskKind===kind)!.taskId,actor.actorId,randomUUID());
    await expect(flow.authorizeUpload(qc,id)).rejects.toMatchObject({statusCode:403});
    const firstLine=state.batchTotals![0]!.lineId,a=[{lineId:firstLine,quantity:40}],b=state.batchTotals!.map(row=>({lineId:row.lineId,quantity:row.quantity-(row.lineId===firstLine?40:0)}));
    state=await flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺发出',lines:a,occurredAt:new Date().toISOString(),supplier:'TEST A',note:''},randomUUID());
    const sendA=state.facts.at(-1)!.factId;
    state=await flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺回仓',sendFactId:sendA,lines:a,occurredAt:new Date().toISOString(),supplier:'TEST A',note:''},randomUUID());
    const returnedA=state.facts.at(-1)!.factId;
    const openedTodo=(await new DigitalProductionNotificationService(database).todos(qc)).find(t=>t.todoId===noWindow.taskId)!;
    expect(openedTodo.dueAt).toBeTruthy();expect(openedTodo.timing?.status).toBe('normal');

    state=await flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺发出',lines:b,occurredAt:new Date().toISOString(),supplier:'TEST B',note:''},randomUUID());
    expect(state.currentReturn).toBeNull();expect(state.batches!.find(batch=>batch.factId===returnedA)!.rows[0]!.available).toBe(40);
    const app=Fastify(),sessions=new Map([['qc',qc],['warehouse',warehouse],['logistics',logistics],['root',root]]);
    app.setErrorHandler((error,_req,reply)=>{const e=error as ApplicationError;reply.code(e.statusCode??500).send({error:{message:e.message}});});
    registerFactoryFlowRoutes(app,{service:new DigitalProductionIdentityService(database,true),creationEnabled:true,root:new RootAuthority(database,'corp',`ding-${merchandiserId}`),authenticate:async token=>{const actor=sessions.get(token??'');if(!actor)throw new ApplicationError('UNAUTHORIZED','TEST',401);return {id:actor.actorId,displayName:'TEST upload',businessRoles:actor.actorRoles,capabilities:['digital_production:view']};}},flow,attachments);
    const path=`/digital-production/orders/${id}/factory-flow`,headers=(role:string)=>({cookie:`dx_rework_session=${role}`});
    const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#445566'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex');
    const payload={filename:'TEST-batch-A.png',mimeType:'image/png',sizeBytes:bytes.byteLength,sha256};
    try{
      for(const role of ['warehouse','logistics']){
        expect((await app.inject({method:'GET',url:path+'/upload-limits',headers:headers(role)})).statusCode).toBe(403);
        expect((await app.inject({method:'POST',url:path+'/upload-intents',headers:headers(role),payload})).statusCode).toBe(403);
      }
      expect((await app.inject({method:'GET',url:`/digital-production/orders/${randomUUID()}/factory-flow/upload-limits`,headers:headers('qc')})).statusCode).toBe(404);
      for(const role of ['qc','root'])expect((await app.inject({method:'GET',url:path+'/upload-limits',headers:headers(role)})).statusCode).toBe(200);
      const created=await app.inject({method:'POST',url:path+'/upload-intents',headers:headers('qc'),payload});expect(created.statusCode,created.body).toBe(200);
      const intent=created.json();await contractStorage.writeImmutable(intent.objectKey,bytes,{mimeType:'image/png',sha256});
      const finalize=path+`/attachments/${intent.attachmentId}/finalize`;
      expect((await app.inject({method:'POST',url:finalize,headers:headers('warehouse')})).statusCode).toBe(403);
      const completed=await app.inject({method:'POST',url:finalize,headers:headers('qc')});expect(completed.statusCode,completed.body).toBe(200);
      state=await flow.qc(qc,id,{expectedRevision:state.revision,returnFactId:returnedA,checks:[{lineId:firstLine,result:'合格',problem:'',treatment:'',attachmentIds:[intent.attachmentId]}],note:''},randomUUID());
      const check=state.checks.find(row=>row.returnFactId===returnedA)!;
      expect(check.attachmentIds).toEqual([intent.attachmentId]);expect((await database.query('SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1',[intent.attachmentId])).rows).toEqual([{entity_type:'digital_factory_qc',entity_id:check.checkId}]);
      state=await flow.dispatch(warehouse,id,{expectedRevision:state.revision,returnFactId:returnedA,lines:a,supplierId:factoryId,occurredAt:new Date().toISOString(),note:'TEST A先发，B仍在途'},randomUUID());
      expect(state.dispatched).toBe(false);expect(state.batches!.find(batch=>batch.factId===returnedA)!.rows[0]!.available).toBe(0);
      expect((await app.inject({method:'GET',url:path+'/upload-limits',headers:headers('qc')})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:path+'/upload-intents',headers:headers('qc'),payload})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:finalize,headers:headers('qc')})).statusCode).toBe(403);
    }finally{await app.close();}
  });

  it('SLA06 dispatches released partial batches without losing failed QC, duplicating production, or over-sending',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database),tasks=new DigitalProductionTaskService(database);
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft:'印花',accessory:true}))!;
    const {id,caseId,people,cutting}=ready;
    const bulk=new BulkPreparationService(database),materialSheet=await bulk.read(people.warehouse_receiver!,id),material=materialSheet.materials!.items[0]!;
    const materialInput={instructionVersion:materialSheet.instructionVersion!,supplierId:factoryId,occurredAt:new Date().toISOString(),note:'TEST辅料先发，不表示收到',items:[{materialId:material.id,quantity:20,unit:'条'}]},materialKey=randomUUID();
    await expect(bulk.dispatchMaterials(primary,id,materialInput,randomUUID())).rejects.toMatchObject({statusCode:403});
    await Promise.all([bulk.dispatchMaterials(people.warehouse_receiver!,id,materialInput,materialKey),bulk.dispatchMaterials(people.warehouse_receiver!,id,materialInput,materialKey)]);
    expect((await bulk.read(primary,id)).materials!.history).toHaveLength(1);
    if(process.env.SLA_MATERIALS_UI_INPUT)await writeFile(process.env.SLA_MATERIALS_UI_INPUT,JSON.stringify({warehouse:await bulk.read(people.warehouse_receiver!,id),readonly:await bulk.read(primary,id)}));
    expect((await database.query("SELECT 1 FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='factory_arrived'",[id])).rowCount).toBe(0);
    for(const row of (await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[caseId])).rows){const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-batch.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/batch/${image}`,'c'.repeat(64),root.actorId]);await physicalCuttingLabelsFixture(database,root,row.cutting_order_id,100);await cutting.record({...root,authorizationCapability:'cutting:records:create'},row.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[image]},randomUUID());}
    const logistics=people.embroidery_washing_merchandiser!,qc=people.quality_control!,warehouse=people.warehouse_receiver!;
    let state=await flow.read(root,id);expect(state.batchMode).toBe(true);
    for(const [kind,actor] of [['process_logistics',logistics],['bulk_qc',qc]] as const)await tasks.reassign(root,state.tasks.find(t=>t.taskKind===kind)!.taskId,actor.actorId,randomUUID());
    const lines=state.batchTotals!.map(l=>({lineId:l.lineId,quantity:100}));
    state=await flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺发出',lines,occurredAt:new Date().toISOString(),supplier:'TEST印花厂',note:''},randomUUID());
    const sendFactId=state.facts.at(-1)!.factId;
    const first=[{lineId:lines[0]!.lineId,quantity:40}];
    state=await flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺回仓',sendFactId,lines:first,occurredAt:new Date().toISOString(),supplier:'TEST印花厂',note:''},randomUUID());
    let returnFactId=state.facts.at(-1)!.factId;expect(state.inTransit).toBe(true);
    state=await flow.qc(qc,id,{expectedRevision:state.revision,returnFactId,checks:[{lineId:first[0]!.lineId,result:'需处理',problem:'TEST首次需返工',treatment:'重新处理',attachmentIds:[]}],note:''},randomUUID());
    expect(state.canPartialDispatch).toBe(false);
    state=await flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺发出',fromReturnId:returnFactId,lines:first,occurredAt:new Date().toISOString(),supplier:'TEST印花厂',note:'TEST本批重新处理'},randomUUID());
    const redoSend=state.facts.at(-1)!.factId;
    await expect(flow.authorizeUpload(qc,id)).rejects.toMatchObject({statusCode:403});
    const originalWindow=state.batchWindows!.find(w=>w.key===sendFactId)!,redoWindow=state.batchWindows!.find(w=>w.key===redoSend)!;expect(redoWindow.enteredAt).toBe(originalWindow.enteredAt);expect(redoWindow.dueAt).toBe(originalWindow.dueAt);
    state=await flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺回仓',sendFactId:redoSend,lines:first,occurredAt:new Date().toISOString(),supplier:'TEST印花厂',note:''},randomUUID());
    returnFactId=state.facts.at(-1)!.factId;
    const check={lineId:first[0]!.lineId,result:'需处理' as const,problem:'TEST有色差',treatment:'TEST客户同意先发该批，余量继续处理',allowDispatch:true,dispatchReason:'TEST本批可先发',attachmentIds:[]};
    await expect(flow.qc(warehouse,id,{expectedRevision:state.revision,returnFactId,checks:[check],note:''},randomUUID())).rejects.toMatchObject({statusCode:403});
    state=await flow.qc(qc,id,{expectedRevision:state.revision,returnFactId,checks:[check],note:''},randomUUID());
    expect(state.batches!.find(b=>b.factId===returnFactId)!.rows[0]).toMatchObject({result:'需处理',allowDispatch:true});
    const uiStates=process.env.SLA_FACTORY_UI_INPUT?{warehouse:await flow.read(warehouse,id),qc:await flow.read(qc,id),logistics:await flow.read(logistics,id),readonly:await flow.read(primary,id)}:null;
    const partial={expectedRevision:state.revision,returnFactId,lines:[{lineId:first[0]!.lineId,quantity:20}],occurredAt:new Date().toISOString(),supplierId:factoryId,note:'TEST部分先发'},key=randomUUID();
    const app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as ApplicationError;reply.code(e.statusCode??500).send({error:{message:e.message}});});
    const sessions=new Map([['warehouse',warehouse],['qc',qc],['primary',primary]]);
    registerFactoryFlowRoutes(app,{service:new DigitalProductionIdentityService(database,true),creationEnabled:true,root:new RootAuthority(database,'corp',`ding-${merchandiserId}`),authenticate:async token=>{const a=sessions.get(token??'');if(!a)throw new ApplicationError('UNAUTHORIZED','TEST未登录',401);return {id:a.actorId,displayName:'TEST factory actor',businessRoles:a.actorRoles,capabilities:['digital_production:view']};}},flow,attachments);
    const post=(role:string,input:unknown,requestKey:string)=>app.inject({method:'POST',url:`/digital-production/orders/${id}/factory-flow/dispatch`,headers:{cookie:`dx_rework_session=${role}`,'idempotency-key':requestKey},payload:input as Record<string,unknown>});
    let results:Awaited<ReturnType<typeof flow.dispatch>>[];
    try{
     expect((await post('qc',partial,randomUUID())).statusCode).toBe(403);
     expect((await post('warehouse',{...partial,lines:[{lineId:first[0]!.lineId,quantity:-1}]},randomUUID())).statusCode).toBe(400);
     const responses=await Promise.all([post('warehouse',partial,key),post('warehouse',partial,key)]);expect(responses.map(r=>r.statusCode)).toEqual([200,200]);results=responses.map(r=>r.json());
    }finally{await app.close();}
    state=results[0]!;
    expect(state.batchWindows!.find(w=>w.kind==='bulk_qc')!.minutes).toBe(2880);expect(state.batchWindows!.find(w=>w.kind==='warehouse_dispatch')!.minutes).toBe(1440);expect(state.batchWindows!.find(w=>w.kind==='process_logistics')!.minutes).toBe(5760);expect(state.dispatched).toBe(false);expect(state.productionId).toBeTruthy();expect(state.batchTotals![0]!.sent).toBe(20);expect(state.facts.find(f=>f.kind==='仓库实际发厂')!.payload.releaseCheckIds).toEqual([{lineId:first[0]!.lineId,checkId:state.checks.filter(c=>c.returnFactId===returnFactId).at(-1)!.checkId}]);
    const partialSla=await new SlaOrderService(database).read(root,id);expect(partialSla.status).toBe('planned');if(partialSla.status==='planned'){expect(partialSla.nodes.find(n=>n.id==='warehouse_dispatch')!.actualEnd).toBeNull();expect(partialSla.factory!.facts.warehouse_dispatch!.businessCompleted).toBe(false);}
    expect((await database.query("SELECT count(*)::int n FROM digital_factory_facts WHERE preparation_id=$1 AND kind='仓库实际发厂'",[state.preparationId])).rows[0].n).toBe(1);
    await expect(flow.dispatch(warehouse,id,{...partial,expectedRevision:state.revision,lines:[{lineId:first[0]!.lineId,quantity:21}]},randomUUID())).rejects.toMatchObject({statusCode:409});
    const remainingInput={...partial,expectedRevision:state.revision,occurredAt:new Date().toISOString()};
    const race=await Promise.allSettled([flow.dispatch(warehouse,id,remainingInput,randomUUID()),flow.dispatch(warehouse,id,remainingInput,randomUUID())]);
    expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(race.filter(r=>r.status==='rejected')).toHaveLength(1);state=(race.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<typeof state>).value;
    state=await flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺回仓',sendFactId,lines:[{lineId:lines[0]!.lineId,quantity:60},lines[1]!],occurredAt:new Date().toISOString(),supplier:'TEST印花厂',note:''},randomUUID());
    const secondReturn=state.facts.at(-1)!.factId;
    state=await flow.qc(qc,id,{expectedRevision:state.revision,returnFactId:secondReturn,checks:lines.map(l=>({lineId:l.lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]})),note:''},randomUUID());
    state=await flow.dispatch(warehouse,id,{expectedRevision:state.revision,returnFactId:secondReturn,lines:[{lineId:lines[0]!.lineId,quantity:60},lines[1]!],occurredAt:new Date().toISOString(),supplierId:factoryId,note:''},randomUUID());
    const fullSla=await new SlaOrderService(database).read(root,id);if(fullSla.status==='planned')expect(fullSla.factory!.facts.warehouse_dispatch!.businessCompleted).toBe(true);
    expect(state.dispatched).toBe(true);expect(state.batchTotals!.every(l=>l.sent===100&&l.remaining===0)).toBe(true);
    expect((await database.query('SELECT count(*)::int n FROM sourcing_production_orders WHERE sourcing_case_id=$1',[caseId])).rows[0].n).toBe(1);
    expect((await database.query("SELECT count(*)::int n FROM digital_production_child_links WHERE production_order_id=$1 AND module='production'",[id])).rows[0].n).toBe(1);
    expect((await database.query("SELECT result,allow_dispatch FROM digital_factory_qc WHERE return_fact_id=$1",[returnFactId])).rows[0]).toMatchObject({result:'需处理',allow_dispatch:true});
    if(process.env.SLA_FACTORY_UI_INPUT)await writeFile(process.env.SLA_FACTORY_UI_INPUT,JSON.stringify({...uiStates,partial:results[0],complete:state}));
  });

  describe.each(['无','印花','仓库主管'] as const)('P13/P14 whole-order %s flow links native receiving and preserves closure facts',variant=>{
    const secondaryCraft=variant==='仓库主管'?'无':variant;
    let continuation:{primary:ReturnType<typeof merchandiserActor>;root:ReturnType<typeof rootActor>;ready:NonNullable<Awaited<ReturnType<typeof exerciseBulkPreparation>>>;ids:string[];fixture:Awaited<ReturnType<typeof budgetFixture>>}|undefined;
    it('keeps original cutting and QC gates before actual dispatch',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database),tasks=new DigitalProductionTaskService(database);
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft,...(variant==='仓库主管'?{warehouseRole:'warehouse_supervisor' as const}:{})}))!;
    const {id,caseId,people,cutting}=ready;
    const ids=(await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[caseId])).rows.map(r=>r.cutting_order_id);
    for(const cuttingId of ids){const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-P13-cut.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/P13/${image}`,'c'.repeat(64),root.actorId]);await physicalCuttingLabelsFixture(database,root,cuttingId,100);await cutting.record({...root,authorizationCapability:'cutting:records:create'},cuttingId,{pieceCount:1,actualCutCount:100,attachmentIds:[image]},randomUUID());}
    let state=await flow.read(primary,id);expect(state).toMatchObject({allCut:true,secondaryCraft,dispatched:false,sampleTargetDate:'2026-11-10'});
    expect(state.tasks.some(t=>t.taskKind==='factory_material_count')).toBe(false);
    const instruction=new ProductionInstructionService(database,true),before=await instruction.read(primary,id);
    expect(before.cutStarted).toBe(true);
    const frozen=async()=>({
      versions:(await database.query("SELECT * FROM digital_instruction_versions WHERE production_order_id=$1 ORDER BY version",[id])).rows,
      tasks:(await database.query("SELECT t.* FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 ORDER BY t.task_id",[id])).rows,
      contracts:(await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_case_id=$1 ORDER BY contract_version",[caseId])).rows,
      sizes:(await database.query("SELECT s.* FROM digital_production_po_sizes s JOIN digital_production_po_lines l USING(line_id) WHERE l.production_order_id=$1 ORDER BY s.line_id,s.size",[id])).rows,
      cutting:(await database.query("SELECT r.* FROM cutting_records r JOIN cutting_orders c USING(cutting_order_id) WHERE c.sourcing_case_id=$1 ORDER BY r.cutting_record_id",[caseId])).rows,
    });
    const originalFacts=await frozen(),target=before.customerPoDates![0]!;
    const request=await instruction.requestDate(primary,id,{orderVersion:before.currentOrderVersion,reason:'TEST实裁后明确PO客户交期',changes:[{lineId:target.lineId,expectedVersion:target.version,date:'2026-11-25'}]},randomUUID());
    const pending=request.dateRequests.find(row=>row.status==='待批准')!;
    const approved=await instruction.decideDate(root,id,pending.requestId,true,randomUUID());
    expect(approved.customerPoDates!.map(line=>line.date)).toEqual(['2026-11-25','2026-11-20']);
    expect(await frozen()).toEqual(originalFacts);
    await expect(instruction.save(primary,id,{expectedVersion:before.version,orderVersion:approved.currentOrderVersion,document:before.document},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(instruction.publish(primary,id,{expectedVersion:before.version,orderVersion:approved.currentOrderVersion},randomUUID())).rejects.toMatchObject({statusCode:409});
    const dateTargets=await flow.read(primary,id);expect(dateTargets.sampleTargetDate).toBe('2026-11-10');
    expect(dateTargets.lines.map(line=>line.sampleTargetDate)).toEqual(['2026-11-15','2026-11-10']);

    const original=(await contractService.getCurrent(root,caseId)).item!;expect(original.status).toBe('ready');
    await expect(production.dispatch(root,caseId,{sourcingContractDocumentId:original.sourcingContractDocumentId,confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:409});
    const warehouse=people.warehouse_receiver!,logistics=people.embroidery_washing_merchandiser!,qc=people.quality_control!,tail=people.pattern_room_tail_inspector!;
    if(secondaryCraft!=='无'){
      for(const [kind,actor] of [['process_logistics',logistics],['bulk_qc',qc]] as const)await tasks.reassign(root,state.tasks.find(t=>t.taskKind===kind)!.taskId,actor.actorId,randomUUID());
      const movement=async(kind:'工艺发出'|'工艺回仓')=>{state=await flow.read(logistics,id);return flow.logistics(logistics,id,{expectedRevision:state.revision,kind,occurredAt:new Date().toISOString(),supplier:'TEST印花厂',note:'TEST整款'},randomUUID());};
      await expect(flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺发出',occurredAt:'2000-01-01T00:00:00Z',supplier:'TEST印花厂',note:'TEST不允许早于实裁'},randomUUID())).rejects.toMatchObject({statusCode:409});
      await movement('工艺发出');await movement('工艺回仓');state=await flow.read(qc,id);
      const firstReturn=state.currentReturn!.factId;expect(state.currentReturn).toMatchObject({factId:state.facts.filter(f=>f.kind==='工艺回仓').at(-1)!.factId});
      const staleRevision=state.revision;
      const qcImage=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-P13-QC.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[qcImage,`TEST/P13/QC/${qcImage}`,'d'.repeat(64),qc.actorId]);
      const checks=state.lines.map((l,i)=>({lineId:l.lineId,result:i===0?'合格' as const:'需处理' as const,problem:i===0?'':'TEST印花错位，请重做',treatment:'',attachmentIds:i===0?[qcImage]:[]}));
      await expect(flow.qc(logistics,id,{expectedRevision:state.revision,checks,note:''},randomUUID())).rejects.toMatchObject({statusCode:403});
      await expect(flow.qc(tail,id,{expectedRevision:state.revision,checks,note:''},randomUUID())).rejects.toMatchObject({statusCode:404});
      state=await flow.qc(qc,id,{expectedRevision:state.revision,checks,note:''},randomUUID());expect(state.allQc).toBe(false);
      expect(await flow.canDownload(primary,id,qcImage)).toBe(true);expect(await flow.canDownload(logistics,id,qcImage)).toBe(true);expect(await flow.canDownload(tail,id,qcImage)).toBe(false);expect(await flow.canDownload(primary,randomUUID(),qcImage)).toBe(false);
      await expect(flow.qc(qc,id,{expectedRevision:state.revision,checks:[checks[0]!],note:''},randomUUID())).rejects.toMatchObject({statusCode:409});

      await expect(flow.dispatch(warehouse,id,{expectedRevision:state.revision,occurredAt:new Date().toISOString(),supplierId:factoryId,note:''},randomUUID())).rejects.toMatchObject({statusCode:409,message:expect.stringMatching(/PO .*问题待处理及复查.*请QC.*仓库/)});
      await movement('工艺发出');await movement('工艺回仓');state=await flow.read(qc,id);expect(state.lines.every(l=>l.result===null)).toBe(true);expect(state.currentReturn!.factId).not.toBe(firstReturn);expect(state.checks.every(check=>check.returnFactId===firstReturn)).toBe(true);
      await expect(flow.qc(qc,id,{expectedRevision:staleRevision,checks:[{...checks[0]!,attachmentIds:[]}],note:''},randomUUID())).rejects.toMatchObject({statusCode:409});
      state=await flow.qc(qc,id,{expectedRevision:state.revision,checks:state.lines.map(l=>({lineId:l.lineId,result:'合格',problem:'',treatment:'TEST已重做复查合格',attachmentIds:[]})),note:''},randomUUID());expect(state.allQc).toBe(true);
      // New issue before actual dispatch must block the entire order again.
      const qcTask=state.tasks.find(t=>t.taskKind==='bulk_qc')!;expect(qcTask.state).toBe('ready');
      state=await flow.qc(qc,id,{expectedRevision:state.revision,checks:[{lineId:state.lines[0]!.lineId,result:'需处理',problem:'TEST发厂前发现问题',treatment:'',attachmentIds:[]}],note:''},randomUUID());expect(state.allQc).toBe(false);
      state=await flow.qc(qc,id,{expectedRevision:state.revision,checks:[{lineId:state.lines[0]!.lineId,result:'合格',problem:'',treatment:'TEST复查已处理',attachmentIds:[]}],note:''},randomUUID());
      expect(state.tasks.every(t=>t.assigneeId===qc.actorId)).toBe(true);
      const warehouseTask=(await flow.read(warehouse,id)).tasks.find(t=>t.taskKind==='warehouse_dispatch')!;
      expect(warehouseTask.state).toBe('ready');
      await expect(tasks.read(qc,warehouseTask.taskId)).rejects.toMatchObject({statusCode:404});
      await expect(tasks.history(qc,warehouseTask.taskId)).rejects.toMatchObject({statusCode:404});
    }
    continuation={primary,root,ready,ids,fixture};
    });
    it('dispatches through native services and preserves original receiving and closure facts',async()=>{
    expect(continuation).toBeDefined();
    const {primary,root,ready,ids,fixture}=continuation!;
    const {id,caseId,people}=ready,flow=new FactoryFlowService(database);
    const warehouse=people.warehouse_receiver!,qc=people.quality_control!;
    let state=await flow.read(warehouse,id);await expect(flow.dispatch(warehouse,id,{expectedRevision:state.revision,occurredAt:'2000-01-01T00:00:00Z',supplierId:factoryId,note:'TEST不允许早于实裁/QC'},randomUUID())).rejects.toMatchObject({statusCode:409});
    if(secondaryCraft!=='无'){const beforeQc=new Date(Math.max(...state.checks.map(c=>new Date(c.checkedAt).getTime()))-1).toISOString();expect(new Date(beforeQc).getTime()).toBeGreaterThan(new Date(state.facts.filter(f=>f.kind==='工艺回仓').at(-1)!.occurredAt!).getTime());await expect(flow.dispatch(warehouse,id,{expectedRevision:state.revision,occurredAt:beforeQc,supplierId:factoryId,note:'TEST不能倒填至当前QC之前'},randomUUID())).rejects.toMatchObject({statusCode:409});}
    state=await flow.read(warehouse,id);const dispatchedAt=new Date().toISOString(),input={expectedRevision:state.revision,occurredAt:dispatchedAt,supplierId:factoryId,note:'TEST整款已实际发厂'},key=randomUUID();
    const dispatched=await flow.dispatch(warehouse,id,input,key);await flow.dispatch(warehouse,id,input,key);expect(dispatched.dispatched).toBe(true);expect(dispatched.productionId).toBeTruthy();
    expect((await database.query('SELECT count(*)::int n FROM sourcing_production_orders WHERE sourcing_case_id=$1',[caseId])).rows[0].n).toBe(1);
    expect(new Date((await database.query('SELECT dispatched_at FROM sourcing_production_orders WHERE sourcing_case_id=$1',[caseId])).rows[0].dispatched_at).toISOString()).toBe(dispatchedAt);
    expect((await database.query("SELECT count(*)::int n FROM digital_production_child_lines WHERE module='production' AND child_id=$1",[dispatched.productionId])).rows[0].n).toBe(2);
    expect((await database.query('SELECT 1 FROM receiving_receipts WHERE style_no=$1',[fixture.order.designStyleNo])).rowCount).toBe(0);
    state=await flow.read(primary,id);expect(state.tasks.some(t=>t.taskKind==='factory_material_count')).toBe(false);
    for(const kind of ['工厂到料','到料清点'] as const)await expect(flow.followup(primary,id,{expectedRevision:state.revision,kind,occurredAt:null,trackingNumber:'',note:'TEST retired input'},randomUUID())).rejects.toMatchObject({statusCode:410});
    state=await flow.followup(primary,id,{expectedRevision:state.revision,kind:'船样寄出',occurredAt:new Date().toISOString(),trackingNumber:'TEST-SF-001',note:'TEST齐色船样已寄出'},randomUUID());
    expect(state.tasks.filter(t=>t.taskKind==='bulk_ship_sample').every(t=>t.state==='completed')).toBe(true);
    expect((await database.query('SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1',[caseId])).rowCount).toBe(0);
    const replacementId=randomUUID();await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST新主跟单',true)",[replacementId]);await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','corp',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),replacementId]);
    await database.query('ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation');try{await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'order_merchandiser',$3,'TEST P13换主跟单')",[randomUUID(),replacementId,root.actorId]);}finally{await database.query('ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation');}
    const access=new DigitalProductionAccessService(database),identity=new DigitalProductionIdentityService(database,true),replacement={...primary,actorId:replacementId};
    const assigned=await access.assignMerchandiser(root,id,replacementId,(await identity.read(root,id)).version);
    expect((await production.get(replacement,dispatched.productionId!)).productionOrderId).toBe(dispatched.productionId);
    expect((await production.list(replacement)).items.some(x=>x.productionOrderId===dispatched.productionId)).toBe(true);
    expect((await production.list(primary)).items.some(x=>x.productionOrderId===dispatched.productionId)).toBe(false);
    await expect(production.get(primary,dispatched.productionId!)).rejects.toMatchObject({statusCode:404});
    const reporting=new ProductionReportingService(database),dashboard=new ProductionDashboardService(database,reporting);
    expect((await dashboard.detail(replacement,dispatched.productionId!)).detail.order.productionOrderId).toBe(dispatched.productionId);
    await expect(dashboard.detail(primary,dispatched.productionId!)).rejects.toMatchObject({statusCode:404});
    const nativeOrder=await production.get(replacement,dispatched.productionId!);
    const productionDates=(await dashboard.detail(replacement,dispatched.productionId!)).detail.order.poDeliveryDates!;
    const journeyDates=(await new DigitalJourneyQuery(database).read(root,id)).poDeliveryDates!;
    expect(productionDates.map(line=>[line.lineId,line.customerWarehouseArrivalDate,line.factoryDeliveryDate,line.sampleTargetDate]))
      .toEqual(journeyDates.map(line=>[line.lineId,line.customerWarehouseArrivalDate,line.factoryDeliveryDate,line.sampleTargetDate]));
    expect(nativeOrder.lines.map(line=>[line.quantity,line.completedQuantity])).toEqual([[137,0],[63,0]]);
    expect(JSON.stringify(productionDates)).not.toMatch(/unitPrice|salePrice|completedQuantity|productionQuantity/);
    await reporting.report(root,dispatched.productionId!,{position:1,businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),quantity:1},randomUUID());
    const reminders=new ProductionClosureService(database,undefined,()=>new Date(Date.now()+4*86400000));await reminders.setPilot(root,{supplierId:factoryId,enabled:true});
    const todoActor=(actor:typeof primary)=>({...actor,authorizationCapabilities:[...(actor.authorizationCapabilities??[]),'todo:view']});
    expect((await reminders.todos(todoActor(replacement))).some(t=>t.entityId===dispatched.productionId)).toBe(true);expect((await reminders.todos(todoActor(primary))).some(t=>t.entityId===dispatched.productionId)).toBe(false);
    await access.assignMerchandiser(root,id,primary.actorId,assigned.version);

    // Future read clock makes the registered earliest PO overdue without altering stored dates or clocks.
    const futureDb=new Proxy(database,{get(target,key){if(key!=="connect")return Reflect.get(target,key);return async()=>{
      const client=await target.connect();return new Proxy(client,{get(c,k){if(k!=="query")return Reflect.get(c,k);
        return async(text:string,values?:unknown[])=>text==="SELECT CURRENT_TIMESTAMP AS as_of"?{rows:[{as_of:new Date("2027-01-15T00:00:00Z")}]}:c.query(text,values);}});};}});
    const futureJourneys=new DigitalJourneyQuery(futureDb);
    for(const viewer of [root,fixture.designer,warehouse])expect((await futureJourneys.read(viewer,id)).deliveryRisks!.some(risk=>risk.kind==='factory')).toBe(true);
    await reporting.execute(root,dispatched.productionId!,"complete",{businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),confirmed:true},randomUUID());
    expect((await database.query("SELECT sourcing_factory_order_status($1) AS status",[dispatched.productionId])).rows[0].status).toBe("production_completed");
    expect((await futureJourneys.read(root,id)).deliveryRisks!.some(risk=>risk.kind==='factory')).toBe(true);
    const qcSheet=await flow.read(root,id);
    await flow.productionQc(root,id,{expectedRevision:qcSheet.revision,factoryDecisionId:null,occurredAt:new Date().toISOString(),note:'TEST工厂检查完成',checks:qcSheet.productionChecks!.map(c=>({lineId:c.lineId,result:'合格' as const,problem:''}))},randomUUID());
    for(const viewer of [root,fixture.designer,warehouse]){
      const completed=await futureJourneys.read(viewer,id);
      expect(completed.deliveryRisks!.filter(risk=>risk.kind==='factory')).toEqual([]);
      if(viewer!==root){
        expect(completed.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='production_reporting')).toMatchObject({state:'unavailable',records:[]});
        expect(completed.links.some(link=>link.domain==='production')).toBe(false);
      }
    }
    await exerciseOrderClosure(database,service,id,ids,{root,primary,manager:managerActor(),warehouse,qc},secondaryCraft==='无');
    });
  });
});
