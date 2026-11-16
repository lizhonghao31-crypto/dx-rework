import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {journeyTaskSummaries} from '../../apps/api/src/production-platform/journey-task-summary.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {GarmentQualityService,garmentQuality} from '../../apps/api/src/production-platform/garment-quality.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
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
   const taskId=first.tasks.find(task=>task.taskKind==='warehouse_dispatch')!.taskId;expect((await tasks.read(f.root,taskId)).state).not.toBe('completed');
   const input={expectedRevision:first.revision,lines:[{lineId:lineIds[1]!,quantity:10}],occurredAt:'2026-11-20T19:39:00.123Z',supplierId:f.supplierId,note:'TEST late registration of last real PO dispatch'},key=randomUUID();
   const last=await flow.dispatch(f.people.warehouse!,r.id,input,key);expect((await flow.dispatch(f.people.warehouse!,r.id,input,key))).toEqual(last);
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
   await flow.dispatch(f.people.warehouse!,r.id,{expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST native complete dispatch'},randomUUID());
   const production=(await f.db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1',[r.caseId])).rows[0].production_order_id;
   const reports=new ProductionReportingService(f.db),day='2026-11-21';await reports.report(f.root,production,{position:1,businessDate:day,quantity:10},randomUUID());
   await reports.execute(f.root,production,'complete',{businessDate:day,confirmed:true},randomUUID());await reports.execute(f.root,production,'ship',{businessDate:day,confirmed:true},randomUUID());
   const receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receiving=new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db));
   const created=await receiving.create(receiver,{cuttingOrderId:r.cuts[0]!.cutting_order_id,productionOrderId:production,factoryDecisionId:null,documentQuantity:2,actualQuantity:2,attachmentIds:[await f.image(receiver)]},randomUUID());
   const quality=(await garmentQuality(f.db,r.id))[0]!;
   await new GarmentQualityService(f.db).record(f.root,r.id,{receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,occurredAt:businessNow().toISOString(),qualifiedQuantity:2,problem:''},randomUUID());
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
   const restored=await receiving.correctReceipt(root,created.value.receiptId,{expectedVersion:corrected.version,documentQuantity:2,actualQuantity:2,defectiveQuantity:0});expect(restored.actualQuantity).toBe(2);
   expect((await closure.read(f.root,r.id)).factoryDeliveries?.[0]).toMatchObject({delivered:true,received:2});
   const repeated=await receiving.createRepeated(receiver,{receivingBatchId:created.value.receivingBatchId,cuttingOrderId:r.cuts[0]!.cutting_order_id,source:'jiashun',actualQuantity:1,defectiveQuantity:0},randomUUID());
   const repeatedVersion=Number((await f.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[repeated.value.receivingBatchId])).rows[0].version);
   await expect(receiving.correctBatch(root,created.value.receivingBatchId,{expectedVersion:repeatedVersion,styleNo:created.value.styleNo,documentQuantity:2,actualQuantity:0,defectiveQuantity:0})).rejects.toThrow('多笔收货');
   const raced=await Promise.allSettled([0,1].map(actualQuantity=>receiving.correctReceipt({...root,requestId:randomUUID()},repeated.value.receiptId,{expectedVersion:repeatedVersion,documentQuantity:2,actualQuantity,defectiveQuantity:0})));
   expect(raced.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(raced.filter(result=>result.status==='rejected')).toHaveLength(1);
   const current=await closure.read(f.root,r.id);expect(current.lines[0]!.receipts.reduce((sum,receipt)=>sum+receipt.actualQuantity,0)).toBe(current.lines[0]!.actualQuantity);

  });
 });
});
