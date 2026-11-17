import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {packingSlaEvidence} from '../../apps/api/src/production-platform/packing-sla-evidence.js';
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
  const before=(await service.read(logistics.actor,orderId)).scopes[0]!;expect((await readPackingQualityCoverage(f.db,[orderId])).get(lineId)?.qualified).toBe(0);expect(before.quantity).toBe(30);expect(before.fee).toBeUndefined();
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
  const inspection=await service.record(f.root,ready.id,{...await command(),kind:'inspection',completionId:complete.eventId,quantity:20,qualifiedQuantity:20},randomUUID());
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
  await service.record(f.root,ready.id,{...link,quantity:10},randomUUID());
  const secondLink=await service.record(f.root,ready.id,{...link,...await command(),quantity:10},randomUUID());
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBe(20);
  expect((await readPackingQualityCoverage(f.db,[ready.id])).get(po)).toEqual({received:30,inspected:30,qualified:20});
  expect((await garmentQuality(f.db,ready.id))[0]).toMatchObject({receiptId:receipt.receiptId,quantity:30,receivedAt:receipt.receivedAt});
  expect((await service.read(f.root,ready.id)).scopes[0]!.ledger.complete).toBe(false);
  const originalScope=(await service.read(f.root,ready.id)).scopes[0]!;
  const update=async()=>{const client=await f.db.connect();try{await client.query('BEGIN');const result=await adoptBulkWashingWithClient(client,f.root,ready.id,po,1,{...adoption,fee:{kind:'pending'},staff:{...adoption.staff,inspectorId:f.people.qc!.actorId},arrangement:{...adoption.arrangement,mode:'factory',washing:{minutes:240,calendar:'continuous',reminder:{enabled:true,percent:70}}} as BulkWashingAdoption['arrangement']});await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  const adopted=await Promise.allSettled([update(),update()]);
  expect(adopted.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(adopted.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBe(20);
  expect((await readPackingQualityCoverage(f.db,[ready.id])).get(po)?.qualified).toBe(20);
  expect((await service.read(f.root,ready.id)).scopes[0]!.windows).toEqual(originalScope.windows);
  await service.record(f.root,ready.id,{...await command(),kind:'void',factId:inspection.eventId,reason:'TEST replace overstated QC'},randomUUID());
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBeNull();
  await service.record(f.root,ready.id,{...await command(),kind:'inspection',completionId:complete.eventId,quantity:20,qualifiedQuantity:15},randomUUID());
  // Each10 link fits15 on its own, but their cumulative20 cannot be released.
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBeNull();
  expect((await readPackingQualityCoverage(f.db,[ready.id])).has(po)).toBe(false);
  await service.record(f.root,ready.id,{...await command(),kind:'void',factId:secondLink.eventId,reason:'TEST remove obsolete allocation'},randomUUID());
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBe(10);
  await expect(service.record(f.root,ready.id,{...link,...await command(),quantity:6},randomUUID())).rejects.toMatchObject({statusCode:409});
  await service.record(f.root,ready.id,{...link,...await command(),quantity:5},randomUUID());
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBe(15);
  expect((await readPackingQualityCoverage(f.db,[ready.id])).get(po)?.qualified).toBe(15);
  const batch=(await f.db.query('SELECT b.version FROM receiving_batches b JOIN receiving_receipts r USING(receiving_batch_id) WHERE r.receipt_id=$1',[receipt.receiptId])).rows[0];
  await new ReceivingService(f.db).correctReceipt({...f.root,authorizationCapability:'receiving:correct'},receipt.receiptId,{expectedVersion:batch.version,source:'jiashun',documentQuantity:30,actualQuantity:25,defectiveQuantity:0});
  expect((await readWashingCoverage(f.db,ready.id)).get(receipt.receiptId)).toBeNull();
  expect((await readPackingQualityCoverage(f.db,[ready.id])).has(po)).toBe(false);
  expect((await bulkWashingTodos(f.db,logistics.actor)).some(t=>t.route.entityId===ready.id&&t.taskTitle==='关联工厂洗水与本批收货')).toBe(true);
 });

 it('rejects another PO receipt from the same order and factory without changing either PO coverage',async()=>{
  const ready=await f.bulkReady('无',undefined,2,undefined,{quantity:10}),lines=ready.input.lineItems.map(row=>row.lineId!);
  const cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[ready.caseId])).rows;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of cuts)await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),before=await flow.read(f.root,ready.id);await flow.dispatch(f.root,ready.id,{expectedRevision:before.revision,supplierId:f.supplierId,note:'TEST same-order two-PO dispatch'},randomUUID());
  const db=await f.db.connect();try{await db.query('BEGIN');for(const line of lines)await adoptBulkWashingWithClient(db,f.root,ready.id,line,0,{...adoption,fee:{kind:'pending'},staff:{...adoption.staff,inspectorId:f.people.qc!.actorId},arrangement:{...adoption.arrangement,mode:'factory'} as BulkWashingAdoption['arrangement']});await db.query('COMMIT');}finally{db.release();}
  const command=async()=>{const scope=(await service.read(f.root,ready.id)).scopes.find(scope=>scope.lineId===lines[0])!;return {planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:new Date().toISOString(),note:'TEST cross-PO receipt isolation'};};
  const start=await service.record(f.root,ready.id,{...await command(),kind:'factory_start',quantity:5},randomUUID());
  const complete=await service.record(f.root,ready.id,{...await command(),kind:'factory_complete',startId:start.eventId,quantity:5},randomUUID());
  await service.record(f.root,ready.id,{...await command(),kind:'inspection',completionId:complete.eventId,quantity:5,qualifiedQuantity:5},randomUUID());
  const production=(await flow.read(f.root,ready.id)).productionId!,reporting=new ProductionReportingService(f.db),businessDate=beijingCalendarDate(new Date());
  for(const position of [1,2])await reporting.report(f.root,production,{position,businessDate,quantity:10},randomUUID());
  await reporting.execute(f.root,production,'complete',{businessDate,confirmed:true},randomUUID());await reporting.execute(f.root,production,'ship',{businessDate,confirmed:true},randomUUID());
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},closure=new ProductionClosureService(f.db);
  for(const cut of cuts)await new ReceivingService(f.db,undefined,undefined,closure).create(warehouse,{cuttingOrderId:cut.cutting_order_id,documentQuantity:5,actualQuantity:5,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const receipts=await garmentQuality(f.db,ready.id),own=receipts.find(row=>row.lineId===lines[0])!,other=receipts.find(row=>row.lineId===lines[1])!;
  const scope=(await service.read(f.root,ready.id)).scopes.find(row=>row.lineId===lines[0])!;expect(scope.receipts?.map(row=>row.receiptId)).toEqual([own.receiptId]);
  const link={...await command(),kind:'receipt_link' as const,completionId:complete.eventId,quantity:5};
  await expect(service.record(f.root,ready.id,{...link,receiptId:other.receiptId,receiptQuantityVersion:other.quantityVersion},randomUUID())).rejects.toMatchObject({statusCode:409,message:'请选择本厂本PO有效收货和已检查的洗水批次'});
  expect((await command()).expectedRevision).toBe(link.expectedRevision);expect((await readWashingCoverage(f.db,ready.id)).get(other.receiptId)).toBeNull();
  await service.record(f.root,ready.id,{...link,receiptId:own.receiptId,receiptQuantityVersion:own.quantityVersion},randomUUID());
  const coverage=await readWashingCoverage(f.db,ready.id);expect(coverage.get(own.receiptId)).toBe(5);expect(coverage.get(other.receiptId)).toBe(0);
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

 it.each(['after_receipt','factory'] as const)('preserves real failed checks through two rewash rounds, quantity locks and original receipt coverage on %s',async mode=>{
  const ready=await f.bulkReady('无',undefined,1,undefined,{quantity:4}),id=ready.id;
  const po=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[id])).rows[0].line_id;
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:4,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),before=await flow.read(f.root,id);
  await flow.dispatch(f.root,id,{expectedRevision:before.revision,supplierId:f.supplierId,note:'TEST rewash original factory'},randomUUID());
  const production=(await flow.read(f.root,id)).productionId!,reporting=new ProductionReportingService(f.db),businessDate=beijingCalendarDate(new Date());
  await reporting.report(f.root,production,{position:1,businessDate,quantity:4},randomUUID());
  await reporting.execute(f.root,production,'complete',{businessDate,confirmed:true},randomUUID());await reporting.execute(f.root,production,'ship',{businessDate,confirmed:true},randomUUID());
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  await new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db)).create(warehouse,{cuttingOrderId:cut,documentQuantity:4,actualQuantity:4,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const receipt=(await garmentQuality(f.db,id))[0]!;
  await new GarmentQualityService(f.db).record(f.root,id,{receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:4,occurredAt:new Date().toISOString(),problem:''},randomUUID());
  const qc=await r5RoleFixture(f.db,f.access,{...f.root,requestId:randomUUID()},'quality_control');
  const db=await f.db.connect();try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,id,po,0,{...adoption,fee:{kind:'pending'},staff:{logisticsId:logistics.actor.actorId,inspectorId:qc.actor.actorId},arrangement:{...adoption.arrangement,mode} as BulkWashingAdoption['arrangement']});await db.query('COMMIT');}finally{db.release();}
  const read=async()=>(await service.read(logistics.actor,id)).scopes[0]!;
  const command=async()=>{const own=await read();return {planId:own.planId,scopeId:own.scopeId,quantityVersion:own.quantityVersion,expectedRevision:own.revision,occurredAt:new Date().toISOString(),note:'TEST genuine colour defect, not an entry mistake'};};
  const launch=async(quantity:number,reworkOfInspectionId?:string)=>service.record(logistics.actor,id,{...await command(),kind:mode==='factory'?'factory_start':'send',quantity,...(reworkOfInspectionId?{reworkOfInspectionId}:{})},randomUUID());
  const finish=async(startId:string,quantity:number)=>service.record(logistics.actor,id,{...await command(),...(mode==='factory'?{kind:'factory_complete' as const,startId}:{kind:'return' as const,sendId:startId}),quantity},randomUUID());
  const check=async(completionId:string,quantity:number,qualifiedQuantity:number)=>service.record(qc.actor,id,{...await command(),kind:'inspection',completionId,quantity,qualifiedQuantity},randomUUID());
  const budgets=(await f.db.query('SELECT version,document,totals FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version',[id])).rows;
  const first=await launch(4),done=await finish(first.eventId,4),failed=await check(done.eventId,4,3),original=await read();
  expect(original.ledger).toMatchObject({qualified:3,remaining:1,washed:4,rework:{available:[{inspectionId:failed.eventId,quantity:1,round:1}]}});
  expect((await bulkWashingTodos(f.db,logistics.actor)).some(row=>row.route.entityId===id&&row.taskTitle===(mode==='factory'?'关联工厂洗水与本批收货':'办理不合格返洗'))).toBe(true);
  await expect(launch(2,failed.eventId)).rejects.toMatchObject({statusCode:409});await expect(launch(1,randomUUID())).rejects.toMatchObject({statusCode:409});
  const input={...await command(),kind:mode==='factory'?'factory_start' as const:'send' as const,quantity:1,reworkOfInspectionId:failed.eventId},key=randomUUID();
  await expect(service.record(qc.actor,id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
  const raced=await Promise.allSettled([service.record(logistics.actor,id,input,key),service.record(logistics.actor,id,input,randomUUID())]);
  expect(raced.filter(result=>result.status==='fulfilled')).toHaveLength(1);const winner=raced.find(result=>result.status==='fulfilled')!;
  if(winner.status!=='fulfilled')throw Error('Missing committed rewash');
  if(raced[0]?.status==='fulfilled')expect(await service.record(logistics.actor,id,input,key)).toEqual(winner.value);
  const active=await read();expect(active.windows.filter(window=>original.windows.some(prior=>prior.id===window.id))).toEqual(original.windows);
  expect(active.windows.find(window=>window.id===winner.value.eventId)).toMatchObject({state:'active',minutes:60});
  expect(active.ledger.rework?.available).toEqual([]);await expect(launch(1,failed.eventId)).rejects.toMatchObject({statusCode:409});
  const returned=await finish(winner.value.eventId,1);
  expect((await bulkWashingTodos(f.db,qc.actor)).some(row=>row.route.entityId===id&&row.taskTitle==='办理大货洗后检查')).toBe(true);
  await expect(service.record(logistics.actor,id,{...await command(),kind:'inspection',completionId:returned.eventId,quantity:1,qualifiedQuantity:0},randomUUID())).rejects.toMatchObject({statusCode:403});
  const failedAgain=await check(returned.eventId,1,0),second=await launch(1,failedAgain.eventId),secondReturn=await finish(second.eventId,1);
  await check(secondReturn.eventId,1,1);const final=await read();
  expect(final.ledger).toMatchObject({conflict:false,complete:true,qualified:4,remaining:0,washed:4,rework:{sent:2,washed:2,qualified:1,available:[]}});
  expect(final.ledger.rework?.rounds[second.eventId]).toBe(2);expect(final.facts.find(fact=>fact.id===failed.eventId)).toMatchObject({voided:false,kind:'inspection',qualifiedQuantity:3});
  expect(final.facts.find(fact=>fact.id===failedAgain.eventId)).toMatchObject({voided:false,kind:'inspection',qualifiedQuantity:0});
  expect((await garmentQuality(f.db,id))[0]).toMatchObject({receiptId:receipt.receiptId,quantity:4,receivedAt:receipt.receivedAt});
  if(mode==='factory'){
   const link=async(completionId:string,quantity:number)=>service.record(logistics.actor,id,{...await command(),kind:'receipt_link',completionId,quantity,receiptId:receipt.receiptId,receiptQuantityVersion:receipt.quantityVersion},randomUUID());
   await expect(link(done.eventId,4)).rejects.toMatchObject({statusCode:409});await expect(link(returned.eventId,1)).rejects.toMatchObject({statusCode:409});
   await link(done.eventId,3);await link(secondReturn.eventId,1);
  }
  expect((await readWashingCoverage(f.db,id)).get(receipt.receiptId)).toBe(4);expect((await readPackingQualityCoverage(f.db,[id])).get(po)?.qualified).toBe(4);
  expect((await f.db.query('SELECT version,document,totals FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version',[id])).rows).toEqual(budgets);
  await service.record(f.root,id,{...await command(),kind:'void',factId:failed.eventId,reason:'TEST invalidated original evidence, retain descendants for investigation'},randomUUID());
  expect((await read()).ledger).toMatchObject({conflict:true,qualified:null,complete:false});expect((await readWashingCoverage(f.db,id)).get(receipt.receiptId)).toBeNull();
 });
 it('keeps factory-linked receipt packing windows independent across later and unknown sibling wash checks',async()=>{
  const scene=await f.scene('2026-11-15T08:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const ready=await f.bulkReady('无',undefined,1,undefined,{quantity:4}),id=ready.id;
   const po=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[id])).rows[0].line_id;
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:4,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db),sheet=await flow.read(f.root,id);await flow.dispatch(f.root,id,{expectedRevision:sheet.revision,supplierId:f.supplierId,note:'TEST two real wash completions'},randomUUID());
   const production=(await flow.read(f.root,id)).productionId!,reports=new ProductionReportingService(f.db);
   await reports.report(f.root,production,{position:1,businessDate:'2026-11-15',quantity:4},randomUUID());
   for(const action of ['complete','ship'] as const)await reports.execute(f.root,production,action,{businessDate:'2026-11-15',confirmed:true},randomUUID());
   const db=await f.db.connect();try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,id,po,0,{...adoption,fee:{kind:'pending'},staff:{logisticsId:logistics.actor.actorId,inspectorId:f.people.qc!.actorId},arrangement:{...adoption.arrangement,mode:'factory'} as BulkWashingAdoption['arrangement']});await db.query('COMMIT');}finally{db.release();}
   const command=async(at:string|null)=>{const scope=(await service.read(f.root,id)).scopes[0]!;return {planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:at,note:'TEST exact receipt-linked wash evidence'};};
   const started=await service.record(f.root,id,{...await command('2026-11-15T08:00:00.000Z'),kind:'factory_start',quantity:4},randomUUID());
   await f.advance(scene,'2026-11-15T10:00:00.000Z');return f.runtime.withObservation(scene,async()=>{
   const firstDone=await service.record(f.root,id,{...await command('2026-11-15T08:30:00.000Z'),kind:'factory_complete',startId:started.eventId,quantity:2},randomUUID());
   await service.record(f.root,id,{...await command('2026-11-15T09:00:00.000Z'),kind:'inspection',completionId:firstDone.eventId,quantity:2,qualifiedQuantity:2},randomUUID());
   const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receiving=new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db));
   const first=(await receiving.create(warehouse,{cuttingOrderId:cut,documentQuantity:4,actualQuantity:2,attachmentIds:[await f.image(warehouse)]},randomUUID())).value;
   const receiptA=(await garmentQuality(f.db,id))[0]!;await new GarmentQualityService(f.db).record(f.root,id,{receiptId:receiptA.receiptId,quantityVersion:receiptA.quantityVersion,qualifiedQuantity:2,problem:'',timeMode:'now'},randomUUID());
   await service.record(f.root,id,{...await command('2026-11-15T10:00:00.000Z'),kind:'receipt_link',completionId:firstDone.eventId,receiptId:receiptA.receiptId,receiptQuantityVersion:receiptA.quantityVersion,quantity:2},randomUUID());
   await f.advance(scene,'2026-11-15T16:00:00.000Z');return f.runtime.withObservation(scene,async()=>{
   const secondDone=await service.record(f.root,id,{...await command('2026-11-15T14:00:00.000Z'),kind:'factory_complete',startId:started.eventId,quantity:2},randomUUID());
   const unknown=await service.record(f.root,id,{...await command(null),kind:'inspection',completionId:secondDone.eventId,quantity:2,qualifiedQuantity:2},randomUUID());
   await receiving.createRepeated(warehouse,{receivingBatchId:first.receivingBatchId,cuttingOrderId:cut,source:'jiashun',actualQuantity:2,defectiveQuantity:0},randomUUID());
   const receiptB=(await garmentQuality(f.db,id)).find(q=>q.receiptId!==receiptA.receiptId)!;await new GarmentQualityService(f.db).record(f.root,id,{receiptId:receiptB.receiptId,quantityVersion:receiptB.quantityVersion,qualifiedQuantity:2,problem:'',timeMode:'now'},randomUUID());
   await service.record(f.root,id,{...await command('2026-11-15T16:00:00.000Z'),kind:'receipt_link',completionId:secondDone.eventId,receiptId:receiptB.receiptId,receiptQuantityVersion:receiptB.quantityVersion,quantity:2},randomUUID());
   const closure=new OrderClosureService(f.db);let current=await closure.read(f.root,id);
   const perReceipt=(receiptId:string)=>current.lines[0]!.packingReadiness!.receipts.find(row=>row.receiptId===receiptId)!.readiness;
   expect(perReceipt(receiptA.receiptId).ready).toEqual({precision:'instant',at:'2026-11-15T10:00:00.000Z'});expect(perReceipt(receiptB.receiptId).state).toBe('unknown');
   await service.record(f.root,id,{...await command(null),kind:'void',factId:unknown.eventId,reason:'TEST record true known sibling inspection time'},randomUUID());
   await service.record(f.root,id,{...await command('2026-11-15T15:00:00.000Z'),kind:'inspection',completionId:secondDone.eventId,quantity:2,qualifiedQuantity:2},randomUUID());
   current=await closure.read(f.root,id);expect(perReceipt(receiptA.receiptId).ready).toEqual({precision:'instant',at:'2026-11-15T10:00:00.000Z'});expect(perReceipt(receiptB.receiptId).ready).toEqual({precision:'instant',at:'2026-11-15T16:00:00.000Z'});
   const row=(await receiving.board('2026-11-15','2026-11-15','','all',1,15,first.receivingBatchId)).rows[0]!;
   await receiving.recordPacking({...f.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:first.receivingBatchId,expectedVersion:row.version,expectedPackingRevisionId:row.packingRevisionId,packingQuantity:4,packingTime:{mode:'now'},packingAllocations:[receiptA,receiptB].map((q,i)=>({receiptId:q.receiptId,quantityVersion:q.quantityVersion,quantity:2,packingTime:{mode:'instant' as const,value:i?'2026-11-15T16:00:00.000Z':'2026-11-15T11:00:00.123Z'}}))},randomUUID());
   const fact=packingSlaEvidence(await closure.read(f.root,id)).facts['garment_packing:'+po]!;
   expect(fact.batchWindows!.map(window=>window.startedAt).sort()).toEqual(['2026-11-15T10:00:00.000Z','2026-11-15T16:00:00.000Z']);
   expect((await service.read(f.root,id)).scopes[0]!.facts.find(fact=>fact.id===unknown.eventId)?.voided).toBe(true);
    });
   });
  });
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

 it('keeps a corrected zero receipt as history while two positive qualified washed batches cover real packing in native and scalar readers',async()=>{
  // This scenario owns its fixture; earlier cases deliberately revoke their
  // original actors and must remain revoked in that separate history.
  const isolated=await businessAnchorFixture(url!);
  try{
  const scene=await isolated.scene('2026-11-17T08:00:00.000Z'),washingService=new BulkWashingService(isolated.db);
  await isolated.runtime.run(scene,isolated.root,async()=>{
   const ready=await isolated.bulkReady('无',undefined,1,undefined,{quantity:2}),id=ready.id;
   const po=(await isolated.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[id])).rows[0].line_id;
   const cut=(await isolated.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
   const cutter={...isolated.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:2,attachmentIds:[await isolated.image(cutter)]},randomUUID());
   const warehouse={...isolated.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receiving=new ReceivingService(isolated.db);
   const first=(await receiving.create(warehouse,{cuttingOrderId:cut,documentQuantity:2,actualQuantity:2,attachmentIds:[await isolated.image(warehouse)]},randomUUID())).value;
   const original=(await isolated.db.query('SELECT * FROM receiving_receipts WHERE receipt_id=$1',[first.receiptId])).rows[0];
   const qc=new GarmentQualityService(isolated.db),originalCheck=(await garmentQuality(isolated.db,id))[0]!;
   await qc.record(isolated.root,id,{receiptId:originalCheck.receiptId,quantityVersion:originalCheck.quantityVersion,qualifiedQuantity:2,occurredAt:'2026-11-17T08:00:00.000Z',problem:''},randomUUID());
   const duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}},client=await isolated.db.connect();
   try{await client.query('BEGIN');await adoptBulkWashingWithClient(client,isolated.root,id,po,0,{arrangement:{mode:'after_receipt',reference:'TEST zero history',revision:1,accounting:'additional',washing:duration,inspection:duration},staff:{logisticsId:isolated.people['embroidery-washing-merchandiser']!.actorId,inspectorId:isolated.people.qc!.actorId},fee:{kind:'pending'},sourceRef:'TEST original washing adoption'});await client.query('COMMIT');}finally{client.release();}
   const command=async(scopeId:string)=>{const scope=(await washingService.read(isolated.root,id)).scopes.find(scope=>scope.scopeId===scopeId)!;return {planId:scope.planId,scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:'2026-11-17T08:00:00.000Z',note:'TEST actual batch'};};
   const originalScope='receipt:'+first.receiptId;
   const originalSend=await washingService.record(isolated.root,id,{...await command(originalScope),kind:'send',quantity:2},randomUUID());
   const originalReturn=await washingService.record(isolated.root,id,{...await command(originalScope),kind:'return',sendId:originalSend.eventId,quantity:2},randomUUID());
   const originalInspection=await washingService.record(isolated.root,id,{...await command(originalScope),kind:'inspection',completionId:originalReturn.eventId,quantity:2,qualifiedQuantity:2},randomUUID());
   const version=Number((await isolated.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[first.receivingBatchId])).rows[0].version);
   const corrector={...isolated.root,authorizationCapability:'receiving:correct',authorizationCapabilities:['receiving:correct']};
   await receiving.correctReceipt(corrector,first.receiptId,{expectedVersion:version,documentQuantity:2,actualQuantity:0,defectiveQuantity:0});
   for(let index=0;index<2;index++)await receiving.createRepeated(warehouse,{receivingBatchId:first.receivingBatchId,cuttingOrderId:cut,source:'jiashun',actualQuantity:1,defectiveQuantity:0},randomUUID());
   for(const check of (await garmentQuality(isolated.db,id)).filter(check=>check.quantity>0))await qc.record(isolated.root,id,{receiptId:check.receiptId,quantityVersion:check.quantityVersion,qualifiedQuantity:1,occurredAt:'2026-11-17T08:00:00.000Z',problem:''},randomUUID());
   for(const check of (await garmentQuality(isolated.db,id)).filter(check=>check.quantity>0)){
    const scopeId='receipt:'+check.receiptId,sent=await washingService.record(isolated.root,id,{...await command(scopeId),kind:'send',quantity:1},randomUUID());
    const back=await washingService.record(isolated.root,id,{...await command(scopeId),kind:'return',sendId:sent.eventId,quantity:1},randomUUID());
    await washingService.record(isolated.root,id,{...await command(scopeId),kind:'inspection',completionId:back.eventId,quantity:1,qualifiedQuantity:1},randomUUID());
   }
   const batchVersion=Number((await isolated.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[first.receivingBatchId])).rows[0].version);
   await receiving.recordPacking({...isolated.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:first.receivingBatchId,expectedVersion:batchVersion,expectedPackingRevisionId:null,packingQuantity:2,packingTime:{mode:'now'}},randomUUID());
   const quality=await garmentQuality(isolated.db,id),wash=await readWashingCoverage(isolated.db,id);
   expect(quality.find(check=>check.receiptId===first.receiptId)).toMatchObject({quantity:0,inspected:false});expect(wash.get(first.receiptId)).toBeNull();
   const originalFacts=(await washingService.read(isolated.root,id)).scopes.find(scope=>scope.scopeId===originalScope)!.facts;
   for(const event of [originalSend,originalReturn,originalInspection])expect(originalFacts.find(fact=>fact.id===event.eventId)).toMatchObject({voided:false});
   expect((await isolated.db.query('SELECT * FROM receiving_receipts WHERE receipt_id=$1',[first.receiptId])).rows[0]).toEqual(original);
   expect((await readPackingQualityCoverage(isolated.db,[id])).get(po)).toEqual({received:2,inspected:2,qualified:2});
   const sheet=await new OrderClosureService(isolated.db).read(isolated.root,id),line=sheet.lines.find(line=>line.lineId===po)!;
   expect(line).toMatchObject({actualQuantity:2,packingQuantity:2,effectivePackingQuantity:2});
   expect(packingQualityCoverage(line,quality,wash)).toMatchObject({totals:{received:2,inspected:2,qualified:2},effectiveQuantity:2});
   expect(packingSlaEvidence(sheet).facts['garment_packing:'+po]?.businessCompleted).toBe(true);
  });
  }finally{await isolated.dispose();}
 });

});
