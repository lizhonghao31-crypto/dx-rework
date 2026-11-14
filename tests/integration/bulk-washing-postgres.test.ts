import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {bulkWashingTodos} from '../../apps/api/src/production-platform/bulk-washing-todos.js';
import {todoDestination} from '@dx-rework/contracts/todo-destination';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {readPackingQualityCoverage,packingQualityCoverage} from '../../apps/api/src/production-platform/packing-quality-coverage.js';
import {readWashingCoverage} from '../../apps/api/src/production-platform/bulk-washing-coverage.js';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {adoptBulkWashingWithClient} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
import {BulkWashingService} from '../../apps/api/src/production-platform/bulk-washing-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {GarmentQualityService,garmentQuality} from '../../apps/api/src/production-platform/garment-quality.js';
import type {BulkWashingAdoption,BulkWashingCommand} from '@dx-rework/contracts/bulk-washing';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('normal bulk washing original receipts, transactional history and narrow roles',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,orderId:string,lineId:string,service:BulkWashingService;
 let logistics:Awaited<ReturnType<typeof r5RoleFixture>>,inspector:Awaited<ReturnType<typeof r5RoleFixture>>,adoption:BulkWashingAdoption;
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);service=new BulkWashingService(f.db);
  logistics={actor:f.people['embroidery-washing-merchandiser']!,assignmentId:'unused'};inspector=await r5RoleFixture(f.db,f.access,{...f.root,requestId:randomUUID()},'quality_control');
  const feeRow={rowId:randomUUID(),section:'外发工序' as const,category:'洗水',name:'TEST大货洗水',specification:'',unit:'件',supplier:'TEST',consumption:'1',unitPrice:'2'};
  const ready=await f.bulkReady('无',undefined,1,undefined,{quantity:100,budgetRows:[feeRow]});orderId=ready.id;
  lineId=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[orderId])).rows[0].line_id;
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  await new ReceivingService(f.db).create(warehouse,{cuttingOrderId:cut.cutting_order_id,documentQuantity:30,actualQuantity:30,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const receipt=(await garmentQuality(f.db,orderId))[0]!;
  await new GarmentQualityService(f.db).record(f.root,orderId,{receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:30,occurredAt:new Date().toISOString(),problem:''},randomUUID());
  const duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
  adoption={arrangement:{mode:'after_receipt',reference:'TEST frozen washing',revision:1,accounting:'additional',washing:duration,inspection:duration},staff:{logisticsId:logistics.actor.actorId,inspectorId:inspector.actor.actorId},fee:{kind:'budget_row',version:2,rowId:feeRow.rowId},sourceRef:'TEST approved adoption'};
  const db=await f.db.connect();try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,orderId,lineId,0,adoption);await db.query('COMMIT');}finally{db.release();}
 });
 afterAll(async()=>{await f?.dispose();});
 const body=async()=>{const scope=(await service.read(logistics.actor,orderId)).scopes[0]!;return {planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:new Date().toISOString(),note:'TEST original batch'};};
 let sendId:string,returnId:string;
 it('sends only received/qualified30, keeps wash return20 partial and does not disclose budget to logistics',async()=>{
  const before=(await service.read(logistics.actor,orderId)).scopes[0]!;expect((await readPackingQualityCoverage(f.db,[orderId])).has(lineId)).toBe(false);expect(before.quantity).toBe(30);expect(before.fee).toBeUndefined();
  await expect(service.record(logistics.actor,orderId,{...await body(),kind:'send',quantity:31},randomUUID())).rejects.toMatchObject({statusCode:409});
  const sent=await service.record(logistics.actor,orderId,{...await body(),kind:'send',quantity:30},randomUUID());sendId=sent.eventId;
  const returned=await service.record(logistics.actor,orderId,{...await body(),kind:'return',sendId,quantity:20},randomUUID());returnId=returned.eventId;
  const todos=await bulkWashingTodos(f.db,inspector.actor);expect(todos.some(t=>t.route.entityId===orderId&&t.taskTitle==='办理大货洗后检查')).toBe(true);
  expect(todoDestination(todos.find(t=>t.route.entityId===orderId)!.route)).toContain('factoryAction=washing');
  const notices=new DigitalProductionNotificationService(f.db);
  await notices.runOnce();await notices.runOnce();
  const persisted=(await f.db.query("SELECT e.event_id FROM digital_production_notification_events e JOIN digital_production_notification_receipts r USING(event_id) WHERE e.event_kind='bulk_washing' AND r.recipient_id=$1",[inspector.actor.actorId])).rows;
  expect(persisted).toHaveLength(1);
  const claimed=await notices.claim(inspector.actor);expect(claimed.notification?.eventId).toBe(persisted[0].event_id);
  expect(claimed.notification?.route).toMatchObject({routeName:'digital_bulk_washing',entityId:orderId});
  expect((await notices.current(logistics.actor,persisted[0].event_id)).notification).toBeNull();
  const check:BulkWashingCommand={...await body(),kind:'inspection',completionId:returnId,quantity:20,qualifiedQuantity:20};
  await expect(service.record(logistics.actor,orderId,check,randomUUID())).rejects.toMatchObject({statusCode:403});
  await service.record(inspector.actor,orderId,check,randomUUID());
  expect((await bulkWashingTodos(f.db,inspector.actor)).some(t=>t.route.entityId===orderId)).toBe(false);
  expect((await notices.current(inspector.actor,persisted[0].event_id)).notification).toBeNull();
  expect((await service.read(logistics.actor,orderId)).scopes[0]!.ledger).toMatchObject({qualified:20,remaining:10,complete:false});
  expect((await garmentQuality(f.db,orderId))[0]!.quantity).toBe(30);
  const quality=await garmentQuality(f.db,orderId),washing=await readWashingCoverage(f.db,orderId);
  const aggregate=await readPackingQualityCoverage(f.db,[orderId]);
  const local=packingQualityCoverage({lineId,actualQuantity:30,packingQuantity:30,cutScope:'verified'},quality,washing);
  expect(local.effectiveQuantity).toBeNull();
  expect(aggregate.get(lineId)?.qualified??null).toBe(local.totals?.qualified??null);
 });
 it('serializes stale competing submissions and restores the exact idempotent response',async()=>{
  const input:BulkWashingCommand={...await body(),kind:'return',sendId,quantity:5},key=randomUUID();
  const results=await Promise.allSettled([service.record(logistics.actor,orderId,input,key),service.record(logistics.actor,orderId,input,randomUUID())]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const saved=results[0];if(saved?.status==='fulfilled')expect(await service.record(logistics.actor,orderId,input,key)).toEqual(saved.value);
  else expect(results[1]?.status).toBe('fulfilled');
  await expect(service.record(logistics.actor,orderId,{...input,quantity:99},key)).rejects.toMatchObject({statusCode:409});
 });
 it('revocation is checked in the original session and does not permit a forged unchanged role list',async()=>{
  await f.access.revokeRole({...f.root,requestId:randomUUID()},inspector.assignmentId,'TEST washing revocation');
  expect(await bulkWashingTodos(f.db,inspector.actor)).toEqual([]);
  await expect(service.read(inspector.actor,orderId)).rejects.toMatchObject({statusCode:403});
  const scope=(await service.read(f.root,orderId)).scopes[0]!;
  await expect(service.record(inspector.actor,orderId,{planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:null,note:'TEST',kind:'inspection',completionId:returnId,quantity:20,qualifiedQuantity:20},randomUUID())).rejects.toMatchObject({statusCode:403});
 });
 it('Root withdrawal preserves history and removes dependent QC coverage rather than changing receipt quantities',async()=>{
  const scope=(await service.read(f.root,orderId)).scopes[0]!;
  await service.record(f.root,orderId,{planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:null,note:'TEST',kind:'void',factId:returnId,reason:'TEST source withdrawn'},randomUUID());
  const read=(await service.read(f.root,orderId)).scopes[0]!;
  expect(read.ledger).toMatchObject({conflict:true,qualified:null,complete:false});expect(read.facts.find(e=>e.id===returnId)?.voided).toBe(true);
  await expect(f.db.query('DELETE FROM digital_bulk_washing_events WHERE event_id=$1',[returnId])).rejects.toBeTruthy();
  expect((await garmentQuality(f.db,orderId))[0]!.quantity).toBe(30);
  const quality=await garmentQuality(f.db,orderId),washing=await readWashingCoverage(f.db,orderId);
  const aggregate=await readPackingQualityCoverage(f.db,[orderId]);
  const local=packingQualityCoverage({lineId,actualQuantity:30,packingQuantity:30,cutScope:'verified'},quality,washing);
  expect(local.effectiveQuantity).toBeNull();
  expect(aggregate.get(lineId)?.qualified??null).toBe(local.totals?.qualified??null);
 });
 it('factory-washed batches cover only explicitly linked original receipts and retain the first receipt',async()=>{
  const ready=await f.bulkReady('无',undefined,1,undefined,{quantity:100});
  const po=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[ready.id])).rows[0].line_id;
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),before=await flow.read(f.root,ready.id);
  await flow.dispatch(f.root,ready.id,{expectedRevision:before.revision,supplierId:f.supplierId,note:'TEST native dispatch'},randomUUID());
  const db=await f.db.connect();try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,ready.id,po,0,{...adoption,fee:{kind:'pending'},staff:{...adoption.staff,inspectorId:f.people.qc!.actorId},arrangement:{...adoption.arrangement,mode:'factory'} as BulkWashingAdoption['arrangement']});await db.query('COMMIT');}finally{db.release();}
  const command=async()=>{const scope=(await service.read(f.root,ready.id)).scopes[0]!;return {planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:new Date().toISOString(),note:'TEST factory washing'};};
  const start=await service.record(f.root,ready.id,{...await command(),kind:'factory_start',quantity:30},randomUUID());
  const complete=await service.record(f.root,ready.id,{...await command(),kind:'factory_complete',startId:start.eventId,quantity:20},randomUUID());
  await service.record(f.root,ready.id,{...await command(),kind:'inspection',completionId:complete.eventId,quantity:20,qualifiedQuantity:20},randomUUID());
  const production=(await flow.read(f.root,ready.id)).productionId!,reporting=new ProductionReportingService(f.db),businessDate=beijingCalendarDate(new Date());
  await reporting.report(f.root,production,{position:1,businessDate,quantity:30},randomUUID());
  await reporting.execute(f.root,production,'complete',{businessDate,confirmed:true},randomUUID());
  await reporting.execute(f.root,production,'ship',{businessDate,confirmed:true},randomUUID());
  const closure=new ProductionClosureService(f.db);await closure.setPilot(f.root,{supplierId:f.supplierId,enabled:true});
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  await new ReceivingService(f.db,undefined,undefined,closure).create(warehouse,{cuttingOrderId:cut,documentQuantity:30,actualQuantity:30,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const receipt=(await garmentQuality(f.db,ready.id))[0]!;
  await new GarmentQualityService(f.db).record(f.root,ready.id,{receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:30,occurredAt:new Date().toISOString(),problem:''},randomUUID());
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBeNull();
  const link={...await command(),kind:'receipt_link' as const,completionId:complete.eventId,receiptId:receipt.receiptId,receiptQuantityVersion:receipt.quantityVersion,quantity:20};
  await expect(service.record(f.root,ready.id,{...link,quantity:21},randomUUID())).rejects.toMatchObject({statusCode:409});
  await service.record(f.root,ready.id,link,randomUUID());
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBe(20);
  expect((await readPackingQualityCoverage(f.db,[ready.id])).get(po)).toEqual({received:30,inspected:30,qualified:20});
  expect((await garmentQuality(f.db,ready.id))[0]).toMatchObject({receiptId:receipt.receiptId,quantity:30,receivedAt:receipt.receivedAt});
  expect((await service.read(f.root,ready.id)).scopes[0]!.ledger.complete).toBe(false);
  const batch=(await f.db.query('SELECT b.version FROM receiving_batches b JOIN receiving_receipts r USING(receiving_batch_id) WHERE r.receipt_id=$1',[receipt.receiptId])).rows[0];
  await new ReceivingService(f.db).correctReceipt({...f.root,authorizationCapability:'receiving:correct'},receipt.receiptId,{expectedVersion:batch.version,source:'jiashun',documentQuantity:30,actualQuantity:25,defectiveQuantity:0});
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBeNull();
  expect((await readPackingQualityCoverage(f.db,[ready.id])).has(po)).toBe(false);
  expect((await bulkWashingTodos(f.db,logistics.actor)).some(t=>t.route.entityId===ready.id&&t.taskTitle==='关联工厂洗水与本批收货')).toBe(true);
 });

 it('later inspector and duration adoption preserves the started batch clock without restoring revoked access',async()=>{
  const before=(await service.read(f.root,orderId)).scopes[0]!;
  expect(before.fee).toMatchObject({state:'referenced',version:2,name:'TEST大货洗水',unitPrice:'2',consumption:'1'});
  const historical=(await f.db.query('SELECT document,totals FROM digital_budget_versions WHERE production_order_id=$1 AND version=2',[orderId])).rows[0];
  const db=await f.db.connect();try{
   await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,orderId,lineId,1,{...adoption,fee:{kind:'pending'},staff:{logisticsId:logistics.actor.actorId,inspectorId:f.people.qc!.actorId},arrangement:{...adoption.arrangement,washing:{minutes:240,calendar:'continuous',reminder:{enabled:true,percent:70}}} as BulkWashingAdoption['arrangement']});await db.query('COMMIT');
  }finally{db.release();}
  await expect(service.read(inspector.actor,orderId)).rejects.toMatchObject({statusCode:403});
  expect((await bulkWashingTodos(f.db,inspector.actor)).some(t=>t.route.entityId===orderId)).toBe(false);
  const after=(await service.read(logistics.actor,orderId)).scopes[0]!;
  expect((await service.read(f.people.qc!,orderId)).scopes[0]!.canInspect).toBe(true);
  expect(after.planId).toBe(before.planId);expect(after.canLogistics).toBe(true);
  expect(after.windows.map(w=>[w.id,w.startedAt,w.dueAt,w.minutes])).toEqual(before.windows.map(w=>[w.id,w.startedAt,w.dueAt,w.minutes]));
  expect(after.windows.find(w=>w.kind==='washing')?.minutes).toBe(60);
  expect((await service.read(f.root,orderId)).scopes[0]!.fee).toEqual({state:'pending'});
  expect((await f.db.query('SELECT document,totals FROM digital_budget_versions WHERE production_order_id=$1 AND version=2',[orderId])).rows[0]).toEqual(historical);
  expect((await f.db.query('SELECT document FROM digital_bulk_washing_plans WHERE plan_id=$1',[before.planId])).rows[0].document.fee.kind).toBe('budget_row');
 });

 it('exempt orders need no washing assignment and invalid fee references cannot adopt or overwrite history',async()=>{
  const ready=await f.bulkReady('无'),po=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[ready.id])).rows[0].line_id;
  const db=await f.db.connect();try{
   await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,ready.id,po,0,{arrangement:{mode:'none'},fee:{kind:'pending'},sourceRef:'TEST exempt'});await db.query('COMMIT');
   expect((await service.read(f.root,ready.id)).scopes).toEqual([]);
   const budgets=(await f.db.query('SELECT version,document FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version',[ready.id])).rows;
   await db.query('BEGIN');await expect(adoptBulkWashingWithClient(db,f.root,ready.id,po,1,{arrangement:{mode:'none'},fee:{kind:'budget_row',version:budgets[0].version,rowId:randomUUID()},sourceRef:'TEST invalid fee'})).rejects.toMatchObject({statusCode:409});await db.query('ROLLBACK');
   expect((await f.db.query('SELECT version,document FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version',[ready.id])).rows).toEqual(budgets);
   expect((await f.db.query('SELECT count(*)::int n FROM digital_bulk_washing_plans WHERE production_order_id=$1',[ready.id])).rows[0].n).toBe(1);
  }finally{db.release();}
 });

});
