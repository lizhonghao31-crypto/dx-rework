import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {readWarehouseFactoryDispatchScopes} from '../../apps/api/src/production-platform/warehouse-factory-dispatch-evidence.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {journeyTaskSummaries} from '../../apps/api/src/production-platform/journey-task-summary.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {GarmentQualityService,garmentQuality} from '../../apps/api/src/production-platform/garment-quality.js';
import {canReadExactOriginalQualityPhoto} from '../../apps/api/src/production-platform/original-quality-photo.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {readPendingReceivingNativeReceipts,receivingFactoryAllocationKey} from '../../apps/api/src/receiving/pending-receiving-native-receipts.js';
import {pendingReceivingForAuthorizedOrders} from '../../apps/api/src/receiving/pending-receiving-original-allocation.js';
import {pendingReceivingView} from '../../apps/api/src/receiving/pending-receiving-view.js';
import {qualityCenterFactoryDirectory} from '../../apps/api/src/production-platform/quality-center-factory-directory.js';
import {qualityCenterGarmentDirectory} from '../../apps/api/src/production-platform/quality-center-garment-directory.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original production completion and receipt correction facts',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);});afterAll(async()=>{await f?.dispose();});
 const prepare=async(poCount=1)=>{
  const scene=await f.scene('2026-11-20T19:30:00.000Z');
  const ready=await f.runtime.run(scene,f.root,async()=>{
   const r=await f.bulkReady('无',undefined,poCount),cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[r.caseId])).rows;
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   for(const cut of cuts)await r.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db);await flow.read(f.root,r.id);return {...r,cuts};
  });
  await f.advance(scene,'2026-11-20T19:41:46.479Z');return {...ready,scene};
 };
 it('retains each PO dispatch, closes the whole task at the real last occurrence and preserves explicit original corrections',async()=>{
  const r=await prepare(2);await f.runtime.run(r.scene,f.root,async()=>{
   const flow=new FactoryFlowService(f.db),tasks=new DigitalProductionTaskService(f.db),state=await flow.read(f.root,r.id),lineIds=state.lines.map(line=>line.lineId);
   const first=await flow.dispatch(f.people.warehouse!,r.id,{expectedRevision:state.revision,lines:[{lineId:lineIds[0]!,quantity:10}],occurredAt:'2026-11-20T19:38:00.000Z',supplierId:f.supplierId,note:'TEST first real PO dispatch'},randomUUID());
   const firstScope=await readWarehouseFactoryDispatchScopes(f.db,r.id);
   expect(firstScope).toEqual([{orderId:r.id,productionId:first.productionId,factoryDecisionId:null,quantity:10,lineId:lineIds[0],
    cuttingOrderId:r.cuts[0]!.cutting_order_id,factId:first.facts.find(fact=>fact.kind==='仓库实际发厂')!.factId,dispatchedAt:'2026-11-20T19:38:00.000Z'}]);
   const taskId=first.tasks.find(task=>task.taskKind==='warehouse_dispatch')!.taskId;expect((await tasks.read(f.root,taskId)).state).not.toBe('completed');
   const contract=(await f.contracts.getCurrent(f.root,r.caseId)).item!,beforeDecision=(await f.db.query('SELECT sourcing_decision_id FROM sourcing_production_orders WHERE production_order_id=$1',[first.productionId])).rows[0].sourcing_decision_id;
   await f.sourcing.requestPriceReapplication(f.people['production-management']!,r.caseId,{unitPrice:'4.90',changeReason:'TEST同厂改价不另派单',expectedDecisionId:beforeDecision,expectedContractDocumentId:contract.sourcingContractDocumentId},randomUUID());
   const price=(await f.sourcing.getCurrentPriceReapplication({...f.root,authorizationCapability:'sourcing:view'},r.caseId)).item!;
   if(price.status==='pending')await f.sourcing.decidePriceReapplication(f.people.owner!,r.caseId,price.priceRequestId,{decision:'approved',verificationReason:'TEST同厂已批准新价格'},randomUUID());
   const repriced=(await f.contracts.getCurrent(f.root,r.caseId)).item!;
   expect(repriced.sourcingContractDocumentId).not.toBe(contract.sourcingContractDocumentId);
   expect(await readWarehouseFactoryDispatchScopes(f.db,r.id)).toEqual(firstScope);
   const input={expectedRevision:first.revision,lines:[{lineId:lineIds[1]!,quantity:10}],occurredAt:'2026-11-20T19:39:00.123Z',supplierId:f.supplierId,note:'TEST late registration of last real PO dispatch'},key=randomUUID();
   const last=await flow.dispatch(f.people.warehouse!,r.id,input,key);expect((await flow.dispatch(f.people.warehouse!,r.id,input,key))).toEqual(last);
   expect(await readWarehouseFactoryDispatchScopes(f.db,r.id)).toEqual([...firstScope,{orderId:r.id,productionId:first.productionId,
    factoryDecisionId:null,quantity:10,lineId:lineIds[1],cuttingOrderId:r.cuts[1]!.cutting_order_id,
    factId:last.facts.filter(fact=>fact.kind==='仓库实际发厂')[1]!.factId,dispatchedAt:input.occurredAt}]);
   expect(last.facts.filter(fact=>fact.kind==='仓库实际发厂').map(fact=>fact.payload.dispatchEvidence)).toMatchObject([
    {contractDocumentId:contract.sourcingContractDocumentId},{contractDocumentId:repriced.sourcingContractDocumentId},
   ]);
   expect(await tasks.read(f.root,taskId)).toMatchObject({state:'completed',completedAt:input.occurredAt});
   const original=(await tasks.history(f.root,taskId)).events.find(event=>event.kind==='completed')!;
   expect(new Date(original.occurredAt!).toISOString()).toBe(input.occurredAt);
   const reads=async()=>{
    expect((await journeyTaskSummaries(f.db,[taskId])).get(taskId)?.completedAt).toBe(input.occurredAt);
    const item=await new DigitalJourneyQuery(f.db).read(f.root,r.id,undefined,true);
    expect(item.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===taskId)?.actualAt).toBe(input.occurredAt);
   };await reads();
   const audit=(await f.db.query('SELECT terminal_recorded_at FROM digital_production_tasks WHERE task_id=$1',[taskId])).rows[0].terminal_recorded_at;
   expect(audit).toBeInstanceOf(Date);expect(audit.toISOString()).not.toBe(input.occurredAt);
   const facts=await f.db.query("SELECT occurred_at FROM digital_factory_facts WHERE preparation_id=$1 AND kind='仓库实际发厂' ORDER BY sequence",[r.preparationId]);
   expect(facts.rows.map(row=>row.occurred_at.toISOString())).toEqual(['2026-11-20T19:38:00.000Z',input.occurredAt]);
   await expect(tasks.correctTime(f.people.warehouse!,taskId,{eventId:original.eventId,occurredAt:null,reason:'TEST no original correction authority'},randomUUID())).rejects.toMatchObject({statusCode:403});
   await tasks.correctTime(f.root,taskId,{eventId:original.eventId,occurredAt:null,reason:'TEST explicitly unknown whole-task C, never replaced by a physical fallback'},randomUUID());
   expect((await tasks.read(f.root,taskId)).completedAt).toBeNull();expect((await journeyTaskSummaries(f.db,[taskId])).get(taskId)?.completedAt).toBeNull();
   expect((await f.db.query("SELECT occurred_at FROM digital_factory_facts WHERE preparation_id=$1 AND kind='仓库实际发厂' ORDER BY sequence",[r.preparationId])).rows).toEqual(facts.rows);
  });
 });
 it('makes a single original receipt zero across cumulative quantity, effective quality and first delivery without rewriting its occurrence',async()=>{
  const r=await prepare();await f.runtime.run(r.scene,f.root,async()=>{
   const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,r.id);
   expect(await pendingReceivingForAuthorizedOrders(f.db,[r.id])).toEqual([]);
   expect(await pendingReceivingView(f.db,[r.id],{page:1,search:'',status:'open'})).toEqual({page:1,total:0,items:[]});
   await flow.dispatch(f.people.warehouse!,r.id,{expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST native complete dispatch'},randomUUID());
   const assignedQc=f.people.qc!,qcTask=(await flow.read(f.root,r.id)).tasks.find(task=>task.taskKind==='factory_production_qc')!;
   await new DigitalProductionTaskService(f.db).reassign(f.root,qcTask.taskId,assignedQc.actorId,randomUUID());
   const production=(await f.db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1',[r.caseId])).rows[0].production_order_id;
   const factoryQuery={page:1,search:'TEST anchor factory',status:'open' as const};
   const waiting=await qualityCenterFactoryDirectory(f.db,assignedQc,factoryQuery);
   expect(waiting).toMatchObject({total:1,items:[{orderId:r.id,taskId:qcTask.taskId,productionId:production,factoryDecisionId:null,quantity:10,inspected:false}]});
   await expect(qualityCenterFactoryDirectory(f.db,f.people.warehouse!,factoryQuery)).rejects.toMatchObject({statusCode:403});
   const reports=new ProductionReportingService(f.db),day='2026-11-21';await reports.report(f.root,production,{position:1,businessDate:day,quantity:10},randomUUID());
   expect(await pendingReceivingForAuthorizedOrders(f.db,[r.id])).toMatchObject([{factoryDecisionId:null,expectedQuantity:10,
    factoryShipmentRecorded:false,balance:{actualDispatched:10,remaining:10,status:'pending'}}]);
   await reports.execute(f.root,production,'complete',{businessDate:day,confirmed:true},randomUUID());await reports.execute(f.root,production,'ship',{businessDate:day,confirmed:true},randomUUID());
   const process=await flow.read(assignedQc,r.id);
   const factoryPhoto=await f.image(assignedQc),factoryLineId=waiting.items[0]!.lineId;
   const factoryScope={productionId:production,factoryDecisionId:null,lineId:factoryLineId};
   await expect(flow.authorizeProductionQcPhoto(assignedQc,r.id,factoryScope)).resolves.toBeUndefined();
   await expect(flow.authorizeProductionQcPhoto(assignedQc,r.id,{...factoryScope,factoryDecisionId:randomUUID()})).rejects.toMatchObject({statusCode:409});
   await expect(flow.authorizeProductionQcPhoto(f.people.warehouse!,r.id,factoryScope)).rejects.toMatchObject({statusCode:403});
   const recordedFactory=await flow.productionQc(assignedQc,r.id,{expectedRevision:process.revision,factoryDecisionId:null,occurredAt:businessNow().toISOString(),
    checks:[{lineId:factoryLineId,result:'合格',problem:'',attachmentIds:[factoryPhoto]}],note:'TEST original factory inspection'},randomUUID());
   const factoryRef={kind:'factory-inspection' as const,orderId:r.id,eventId:recordedFactory.productionInspectionHistory![0]!.eventId,
    productionId:production,factoryDecisionId:null,lineId:factoryLineId,attachmentId:factoryPhoto};
   await expect(canReadExactOriginalQualityPhoto(f.db,assignedQc,factoryRef)).resolves.toBe(true);
   await expect(canReadExactOriginalQualityPhoto(f.db,assignedQc,{...factoryRef,lineId:randomUUID()})).resolves.toBe(false);
   expect(await qualityCenterFactoryDirectory(f.db,assignedQc,factoryQuery)).toMatchObject({total:0,items:[]});
   expect(await qualityCenterFactoryDirectory(f.db,assignedQc,{...factoryQuery,status:'inspected'})).toMatchObject({total:1,items:[{productionId:production,result:'合格',inspected:true}]});
   const receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receiving=new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db));
   const created=await receiving.create(receiver,{cuttingOrderId:r.cuts[0]!.cutting_order_id,productionOrderId:production,factoryDecisionId:null,documentQuantity:2,actualQuantity:2,attachmentIds:[await f.image(receiver)]},randomUUID());
   const quality=(await garmentQuality(f.db,r.id))[0]!;
   const garmentQuery={page:1,search:'TEST anchor factory',status:'open' as const};
   expect(await qualityCenterGarmentDirectory(f.db,assignedQc,garmentQuery)).toMatchObject({total:1,items:[{orderId:r.id,quantity:2,qualifiedQuantity:null,
    source:{kind:'garment',receiptId:quality.receiptId,quantityVersion:quality.quantityVersion}}]});
   await expect(qualityCenterGarmentDirectory(f.db,receiver,garmentQuery)).rejects.toMatchObject({statusCode:403});
   const unrelated=randomUUID(),initialReceipts=await readPendingReceivingNativeReceipts(f.db,[r.id,unrelated]);
   const scope={orderId:r.id,productionId:production,lineId:quality.lineId,cuttingOrderId:r.cuts[0]!.cutting_order_id,
    factoryAllocationKey:receivingFactoryAllocationKey(production,null)};
   expect(initialReceipts.get(r.id)).toEqual([{receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,actualQuantity:2,identity:scope}]);
   expect(initialReceipts.has(unrelated)).toBe(false);
   expect(await pendingReceivingForAuthorizedOrders(f.db,[r.id,unrelated])).toMatchObject([{identity:scope,expectedQuantity:10,
    factoryShipmentRecorded:true,balance:{actualDispatched:10,received:2,remaining:8}}]);
   const view=await pendingReceivingView(f.db,[r.id,unrelated],{page:1,search:'TEST anchor factory',status:'open'});
   expect(view).toMatchObject({page:1,total:1,items:[{identity:scope,supplierName:'TEST anchor factory',customerCode:'PD',
    actualFactoryDispatchAt:expect.any(String),expectedFactoryReturnDate:expect.stringMatching(/^\d{4}-\d\d-\d\d$/),
    factoryShipmentRecorded:true,balance:{remaining:8}}]});
   expect(await pendingReceivingView(f.db,[r.id],{page:2,search:view.items[0]!.poNumber!,status:'open'})).toEqual({page:2,total:1,items:[]});
   expect(await pendingReceivingView(f.db,[unrelated],{page:1,search:'',status:'all'})).toEqual({page:1,total:0,items:[]});
   const qc=new GarmentQualityService(f.db),inspection={receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,occurredAt:businessNow().toISOString(),qualifiedQuantity:2,problem:''};
   await expect(qc.authorizeUpload(assignedQc,r.id,quality.receiptId,quality.quantityVersion)).resolves.toBeUndefined();
   await expect(qc.authorizeUpload(receiver,r.id,quality.receiptId,quality.quantityVersion)).rejects.toMatchObject({statusCode:403});
   const photo=await f.image(assignedQc),otherPhoto=await f.image(receiver),photoKey=randomUUID(),withPhoto={...inspection,attachmentIds:[photo]};
   await expect(qc.record(assignedQc,r.id,{...inspection,attachmentIds:[otherPhoto]},randomUUID())).rejects.toMatchObject({statusCode:409});
   const originalCheck=await qc.record(assignedQc,r.id,withPhoto,photoKey);
   await expect(qc.record(assignedQc,r.id,withPhoto,photoKey)).resolves.toEqual(originalCheck);
   expect(await qualityCenterGarmentDirectory(f.db,assignedQc,garmentQuery)).toMatchObject({total:0,items:[]});
   expect(await qualityCenterGarmentDirectory(f.db,assignedQc,{...garmentQuery,status:'completed'})).toMatchObject({total:1,items:[{qualifiedQuantity:2,result:'passed'}]});
   const originalPhoto={kind:'garment-receipt' as const,orderId:r.id,receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,eventId:originalCheck.eventId,attachmentId:photo};
   await expect(canReadExactOriginalQualityPhoto(f.db,assignedQc,originalPhoto)).resolves.toBe(true);
   expect((await garmentQuality(f.db,r.id))[0]).toMatchObject({attachmentIds:[photo]});
   const before=(await f.db.query('SELECT * FROM receiving_receipts WHERE receipt_id=$1',[created.value.receiptId])).rows[0],closure=new OrderClosureService(f.db);
   const version=Number((await f.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[created.value.receivingBatchId])).rows[0].version);
   const root={...f.root,authorizationCapability:'receiving:correct',authorizationCapabilities:['receiving:correct']};
   await expect(receiving.correctBatch(receiver,created.value.receivingBatchId,{expectedVersion:version,styleNo:created.value.styleNo,documentQuantity:2,actualQuantity:0,defectiveQuantity:0})).rejects.toThrow('只有Root');
   const corrected=await receiving.correctBatch(root,created.value.receivingBatchId,{expectedVersion:version,styleNo:created.value.styleNo,documentQuantity:2,actualQuantity:0,defectiveQuantity:0});
   expect(corrected.actualQuantity).toBe(0);const after=await closure.read(f.root,r.id);
   expect(after.lines[0]?.actualQuantity).toBe(0);expect(after.lines[0]?.receipts[0]?.actualQuantity).toBe(0);
   expect(after.quality?.[0]).toMatchObject({quantity:0,inspected:false});expect(after.factoryDeliveries?.[0]).toMatchObject({delivered:false,received:0});
   expect((await f.db.query('SELECT * FROM receiving_receipts WHERE receipt_id=$1',[created.value.receiptId])).rows[0]).toEqual(before);
   const correction=(await f.db.query('SELECT * FROM receiving_receipt_corrections WHERE receipt_id=$1',[created.value.receiptId])).rows[0];expect(correction.receiving_source).toBe(before.receiving_source);expect(Number(correction.actual_quantity)).toBe(0);
   expect((await readPendingReceivingNativeReceipts(f.db,[r.id])).get(r.id)).toEqual([
    {receiptId:quality.receiptId,quantityVersion:correction.correction_id,actualQuantity:0,identity:scope},
   ]);
   expect(await pendingReceivingForAuthorizedOrders(f.db,[r.id])).toMatchObject([{balance:{status:'pending',received:0,remaining:10}}]);
   const restored=await receiving.correctReceipt(root,created.value.receiptId,{expectedVersion:corrected.version,documentQuantity:2,actualQuantity:2,defectiveQuantity:0});expect(restored.actualQuantity).toBe(2);
   expect((await closure.read(f.root,r.id)).factoryDeliveries?.[0]).toMatchObject({delivered:true,received:2});
   // Even when the quantity returns to 2, the original inspection is historical. Same quantity is not same version.
   const restoredQuality=(await garmentQuality(f.db,r.id)).find(item=>item.receiptId===quality.receiptId)!;
   expect(restoredQuality).toMatchObject({quantity:2,inspected:false,priorInspection:true,eventId:originalCheck.eventId,packingReadyAt:null});
   expect(restoredQuality.quantityVersion).not.toBe(inspection.quantityVersion);
   expect(await qualityCenterGarmentDirectory(f.db,assignedQc,garmentQuery)).toMatchObject({total:1,items:[{id:quality.receiptId,inspected:false,
    source:{kind:'garment',receiptId:quality.receiptId,quantityVersion:restoredQuality.quantityVersion}}]});
   await expect(qc.authorizeUpload(assignedQc,r.id,quality.receiptId,quality.quantityVersion)).rejects.toMatchObject({statusCode:409});
   expect(restoredQuality.attachmentIds).toBeUndefined();
   await expect(canReadExactOriginalQualityPhoto(f.db,assignedQc,originalPhoto)).resolves.toBe(true);
   await expect(canReadExactOriginalQualityPhoto(f.db,assignedQc,{...originalPhoto,quantityVersion:restoredQuality.quantityVersion})).resolves.toBe(false);
   await expect(qc.record(assignedQc,r.id,inspection,randomUUID())).rejects.toMatchObject({code:'GARMENT_QUALITY_CONFLICT',statusCode:409});
   const rechecked=await qc.record(assignedQc,r.id,{...inspection,quantityVersion:restoredQuality.quantityVersion,timeMode:'now'},randomUUID());
   const repeated=await receiving.createRepeated(receiver,{receivingBatchId:created.value.receivingBatchId,cuttingOrderId:r.cuts[0]!.cutting_order_id,source:'jiashun',actualQuantity:1,defectiveQuantity:0},randomUUID());
   const inspections=await garmentQuality(f.db,r.id);
   expect(inspections.find(item=>item.receiptId===quality.receiptId)).toMatchObject({inspected:true,eventId:rechecked.eventId});
   const repeatedQuality=inspections.find(item=>item.receiptId===repeated.value.receiptId)!;
   expect(repeatedQuality).toMatchObject({quantity:1,inspected:false,packingReadyAt:null});
   await expect(qc.record(assignedQc,r.id,{receiptId:repeatedQuality.receiptId,quantityVersion:restoredQuality.quantityVersion,qualifiedQuantity:1,timeMode:'now',problem:''},randomUUID())).rejects.toMatchObject({code:'GARMENT_QUALITY_CONFLICT',statusCode:409});
   expect((await f.db.query("SELECT count(*)::int AS count FROM digital_production_task_events WHERE resource_id=$1 AND event_kind='garment_receipt_qc'",[r.id])).rows[0].count).toBe(2);
   const repeatedVersion=Number((await f.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[repeated.value.receivingBatchId])).rows[0].version);
   await expect(receiving.correctBatch(root,created.value.receivingBatchId,{expectedVersion:repeatedVersion,styleNo:created.value.styleNo,documentQuantity:2,actualQuantity:0,defectiveQuantity:0})).rejects.toThrow('多笔收货');
   const raced=await Promise.allSettled([0,1].map(actualQuantity=>receiving.correctReceipt({...root,requestId:randomUUID()},repeated.value.receiptId,{expectedVersion:repeatedVersion,documentQuantity:2,actualQuantity,defectiveQuantity:0})));
   expect(raced.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(raced.filter(result=>result.status==='rejected')).toHaveLength(1);
   const current=await closure.read(f.root,r.id);expect(current.lines[0]!.receipts.reduce((sum,receipt)=>sum+receipt.actualQuantity,0)).toBe(current.lines[0]!.actualQuantity);

  });
 });
});
