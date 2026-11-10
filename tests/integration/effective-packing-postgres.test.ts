import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DeliveryCalendarQuery} from '../../apps/api/src/production-platform/delivery-calendar-query.js';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {DeliveryCalendarFiltersSchema} from '@dx-rework/contracts/delivery-calendar';
import type {PackingTimeInput} from '@dx-rework/contracts';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {ProductionStatisticsQuery} from '../../apps/api/src/production-platform/production-statistics-query.js';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
import {packingSlaEvidence} from '../../apps/api/src/production-platform/packing-sla-evidence.js';
import {readPackingQualityCoverage,effectivePackingQuantity,effectivePackingQuantitySql} from '../../apps/api/src/production-platform/packing-quality-coverage.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('effective native packing across receiving batches',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,receiving:ReceivingService,closure:OrderClosureService;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);receiving=new ReceivingService(f.db);closure=new OrderClosureService(f.db);});
 afterAll(async()=>{await f?.dispose();});
 const packer=()=>({...f.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']});
 const corrector=()=>({...f.root,authorizationCapability:'receiving:correct',authorizationCapabilities:['receiving:correct']});
 const receiver=()=>({...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']});
 const row=async(id:string)=>(await receiving.board('2026-11-01','2026-11-30','','all',1,15,id)).rows[0]!;
 const pack=async(id:string,quantity:number,packingTime?:PackingTimeInput)=>{const current=await row(id);return receiving.recordPacking(packer(),{receivingBatchId:id,expectedVersion:current.version,expectedPackingRevisionId:current.packingRevisionId,packingQuantity:quantity,...(packingTime?{packingTime}:{})},randomUUID());};
 const ready=async(quantity=100)=>{
  const made=await f.bulkReady('无',undefined,1,f.sourcing,{quantity,accessory:true});
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[made.caseId])).rows[0]!.cutting_order_id as string;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await made.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:quantity,attachmentIds:[await f.image(cutter)]},randomUUID());
  return {...made,cut};
 };
 it('keeps 80 through a new empty batch, then100 and a Root decrease90 in all original readers, without inventing A',async()=>{
  const scene=await f.scene('2026-11-09T08:00:00+08:00'),run=<T>(work:()=>Promise<T>)=>f.runtime.run(scene,f.root,work);
  const made=await run(ready),identity=new DigitalProductionIdentityService(f.db,true),order=await run(()=>identity.read(f.root,made.id));
  const filters=DeliveryCalendarFiltersSchema.parse({search:order.designStyleNo}),due=order.lines[0]!.customerWarehouseArrivalDate!,calendar=new DeliveryCalendarQuery(f.db);
  const day=()=>calendar.day(f.root,filters,due);
  const before=await run(day);expect(before.items[0]!.rawPackedQty).toBe(0);expect(before.daySummary.pendingQty).toBe(100);
  expect((await f.db.query('SELECT count(*)::int n FROM receiving_packing_revisions')).rows[0]!.n).toBe(0);
  const first=(await run(async()=>receiving.create({...f.root,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},{cuttingOrderId:made.cut,documentQuantity:80,actualQuantity:80,receivedDate:'2026-11-08',attachmentIds:[await f.image(f.root)]},randomUUID()))).value;
  await run(async()=>{const q=(await closure.read(f.root,made.id)).quality!.find(q=>q.receiptId===first.receiptId)!;await closure.recordQuality(f.root,made.id,{receiptId:q.receiptId,quantityVersion:q.quantityVersion,occurredAt:'2026-11-09T08:00:00+08:00',qualifiedQuantity:q.quantity,problem:''},randomUUID());});
  await run(()=>pack(first.receivingBatchId,80));const stale=await run(()=>row(first.receivingBatchId));
  const second=(await run(async()=>receiving.create(receiver(),{cuttingOrderId:made.cut,documentQuantity:20,actualQuantity:20,attachmentIds:[await f.image(receiver())]},randomUUID()))).value;
  await run(async()=>{const q=(await closure.read(f.root,made.id)).quality!.find(q=>q.receiptId===second.receiptId)!;await closure.recordQuality(f.root,made.id,{receiptId:q.receiptId,quantityVersion:q.quantityVersion,occurredAt:'2026-11-09T08:00:00+08:00',qualifiedQuantity:q.quantity,problem:''},randomUUID());});
  expect(second.receivingBatchId).not.toBe(first.receivingBatchId);
  expect((await run(()=>row(second.receivingBatchId))).packingQuantity).toBe(80);const style=(await run(()=>row(second.receivingBatchId))).styleNo;expect((await run(()=>receiving.board('2026-11-01','2026-11-30',style,'all'))).totalCount).toBe(1);expect((await run(()=>receiving.board('2026-11-01','2026-11-30',style,'missing_packing'))).totalCount).toBe(0);
  expect((await run(()=>closure.read(f.root,made.id))).lines[0]!.packingQuantity).toBe(80);
  expect((await run(day)).daySummary).toMatchObject({orderedQty:100,packedQty:80,pendingQty:20});
  await run(()=>pack(second.receivingBatchId,100));
  await expect(run(()=>receiving.recordPacking(packer(),{receivingBatchId:first.receivingBatchId,expectedVersion:stale.version,expectedPackingRevisionId:stale.packingRevisionId,packingQuantity:90},randomUUID()))).rejects.toMatchObject({statusCode:409});
  const current=await run(()=>row(second.receivingBatchId));
  await expect(run(()=>receiving.recordPacking({...receiver(),authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:second.receivingBatchId,expectedVersion:current.version,expectedPackingRevisionId:current.packingRevisionId,packingQuantity:90},randomUUID()))).rejects.toMatchObject({statusCode:403});
  const input={receivingBatchId:second.receivingBatchId,expectedVersion:current.version,expectedPackingRevisionId:current.packingRevisionId,packingQuantity:90},key=randomUUID();
  await run(()=>receiving.recordPacking(packer(),input,key));await run(()=>receiving.recordPacking(packer(),input,key));
  const sheet=await run(()=>closure.read(f.root,made.id));expect(sheet.lines).toHaveLength(1);expect(sheet.lines[0]).toMatchObject({orderedQuantity:100,packingQuantity:90});
  expect((await run(()=>row(first.receivingBatchId))).packingQuantity).toBe(90);
  expect((await run(day)).daySummary).toMatchObject({orderedQty:100,packedQty:90,pendingQty:10});const analysis=await run(async()=>receiving.analysis(packer(),{startDate:'2026-11-01',endDate:'2026-11-30',q:(await row(second.receivingBatchId)).styleNo}));expect(analysis.items[0]).toMatchObject({packingQuantity:'90',packingDifference:'-10'});
  const debt=await run(()=>calendar.day(f.root,filters,'2099-01-01'));expect(debt.overdueAsOfTodaySummary.pendingQty!+debt.pendingBeforeSelectedNotYetOverdueSummary.pendingQty!).toBe(10);
  expect((await f.db.query('SELECT count(*)::int n FROM receiving_packing_revisions')).rows[0]!.n).toBe(3);
  expect(packingSlaEvidence(sheet).facts['garment_packing:'+order.lines[0]!.lineId]?.completedAt).toBeUndefined();
  // Removing a source receipt is not evidence that packing was revoked. Keep
  // its head identity unknown, never resurrect80 or fabricate a new zero.
  const removing=await run(()=>row(second.receivingBatchId));await run(()=>receiving.deleteBatch(corrector(),second.receivingBatchId,removing.version));
  expect(await run(()=>row(first.receivingBatchId))).toMatchObject({packingRevisionId:sheet.lines[0]!.packingRevisionId,packingQuantity:null,packingScopeUnresolved:true});
  expect((await run(day)).daySummary).toMatchObject({packedQty:null,pendingQty:null,unknownQuantityPoCount:1});
  expect((await run(()=>closure.read(f.root,made.id))).collection).toMatchObject({shipmentQuantity:null,unknownPackingLineCount:1});
  const statistics=await run(()=>new ProductionStatisticsQuery(f.db).list(f.root,DigitalAnalysisFilterSchema.parse({from:'2026-11-09',to:'2026-11-09',view:'production',lineId:order.lines[0]!.lineId})));
  expect(statistics.result.rows[0]).toMatchObject({line:{packing:null},remaining:null,quantityComplete:null});expect(statistics.result.metrics.packed.value).toBeNull();expect(statistics.result.unknown.some(value=>value.key==='packed'&&value.lineId===order.lines[0]!.lineId)).toBe(true);
  await run(()=>pack(first.receivingBatchId,80));expect((await run(day)).daySummary).toMatchObject({packedQty:80,pendingQty:20});
  const last=await run(()=>row(first.receivingBatchId));await run(()=>receiving.deleteBatch(corrector(),first.receivingBatchId,last.version));
  expect((await run(day)).daySummary).toMatchObject({packedQty:null,pendingQty:null,unknownQuantityPoCount:1});

 });
 it('keeps actual instant/date distinct from recording and does not turn pre-QC packing into a later actual completion',async()=>{
  const scene=await f.scene('2026-11-10T08:00:00+08:00'),run=<T>(work:()=>Promise<T>)=>f.runtime.run(scene,f.root,work),made=await run(ready);
  const receipt=(await run(async()=>receiving.create(receiver(),{cuttingOrderId:made.cut,documentQuantity:100,actualQuantity:100,attachmentIds:[await f.image(receiver())]},randomUUID()))).value;
  await run(()=>pack(receipt.receivingBatchId,100,{mode:'now'}));
  await f.advance(scene,'2026-11-10T09:00:00+08:00');
  await run(async()=>{const sheet=await closure.read(f.root,made.id),quality=sheet.quality![0]!;await closure.recordQuality(f.root,made.id,{receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,occurredAt:'2026-11-10T09:00:00+08:00',qualifiedQuantity:quality.quantity,problem:''},randomUUID());});
  let sheet=await run(()=>closure.read(f.root,made.id));const fact=()=>packingSlaEvidence(sheet).facts['garment_packing:'+sheet.lines[0]!.lineId]!;
  expect(fact().businessCompleted).toBe(true);expect(fact().completedAt).toBeUndefined();
  await f.advance(scene,'2026-11-10T10:00:00+08:00');await run(()=>pack(receipt.receivingBatchId,100,{mode:'instant',value:'2026-11-10T09:30:00+08:00'}));
  sheet=await run(()=>closure.read(f.root,made.id));expect(fact().completedAt).toBe('2026-11-10T01:30:00.000Z');expect(sheet.lines[0]!.packingRecordedAt).toBe('2026-11-10T02:00:00.000Z');
  await run(()=>pack(receipt.receivingBatchId,100,{mode:'date',value:'2026-11-10'}));sheet=await run(()=>closure.read(f.root,made.id));expect(fact().completedAt).toBeUndefined();expect(fact().completedDate).toBe('2026-11-10');
  await run(()=>pack(receipt.receivingBatchId,90));sheet=await run(()=>closure.read(f.root,made.id));expect(fact().businessCompleted).toBe(false);expect(fact().completedAt).toBeUndefined();expect(fact().completedDate).toBeUndefined();
 });
 it('retains an ambiguous TEST cut reference as unknown and counts each PO demand once',async()=>{
  const scene=await f.scene('2026-11-11T08:00:00+08:00'),run=<T>(work:()=>Promise<T>)=>f.runtime.run(scene,f.root,work);
  const made=await run(()=>f.bulkReady('无',undefined,2,f.sourcing,{quantity:100}));
  const identity=new DigitalProductionIdentityService(f.db,true),order=await run(()=>identity.read(f.root,made.id));
  const second=(await f.db.query("SELECT child_id FROM digital_production_child_lines WHERE production_order_id=$1 AND line_id=$2 AND module='cutting'",[made.id,order.lines[1]!.lineId])).rows[0]!.child_id;
  const originalCut=(await f.db.query("SELECT child_id FROM digital_production_child_lines WHERE production_order_id=$1 AND line_id=$2 AND module='cutting'",[made.id,order.lines[0]!.lineId])).rows[0]!.child_id;
  await run(async()=>{const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};await made.cutting.record(cutter,originalCut,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());await receiving.create(receiver(),{cuttingOrderId:originalCut,documentQuantity:100,actualQuantity:100,attachmentIds:[await f.image(receiver())]},randomUUID());});
  // Deliberately malformed extra historical reference in this isolated TEST
  // schema. It is not a claimed native disjoint-allocation business command.
  await f.db.query("INSERT INTO digital_production_child_lines(module,child_id,child_line_key,production_order_id,line_id) VALUES('cutting',$1,'TEST-ambiguous-scope',$2,$3)",[second,made.id,order.lines[0]!.lineId]);
  const sheet=await run(()=>closure.read(f.root,made.id));expect(sheet.lines).toHaveLength(2);expect(sheet.lines.reduce((n,line)=>n+line.orderedQuantity,0)).toBe(200);
  expect(sheet.lines[0]).toMatchObject({cutScope:'unresolved',cuttingId:null,packingQuantity:null,actualQuantity:100});expect(sheet.outstanding.join('；')).toContain('原开裁范围尚不能唯一对应本PO');
  const filters=DeliveryCalendarFiltersSchema.parse({search:order.designStyleNo}),day=await run(()=>new DeliveryCalendarQuery(f.db).day(f.root,filters,order.lines[0]!.customerWarehouseArrivalDate!));
  expect(day.total).toBe(2);expect(day.daySummary).toMatchObject({orderedQty:200,packedQty:null,unknownQuantityPoCount:1});
  expect(day.items.find(row=>row.lineId===order.lines[0]!.lineId)!.rawPackedQty).toBeNull();expect(day.items.find(row=>row.lineId===order.lines[1]!.lineId)!.rawPackedQty).toBe(0);
 });
 it('proves native no-cut/no-receipt zero without a packing revision and keeps a matching unconfirmed legacy source unknown',async()=>{
  const scene=await f.scene('2026-11-12T08:00:00+08:00'),run=<T>(work:()=>Promise<T>)=>f.runtime.run(scene,f.root,work),po='TEST-ZERO-'+randomUUID();
  const made=await run(()=>new DigitalProductionIdentityService(f.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-ZERO-'+randomUUID(),orderDate:'2026-11-12',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:po,color:'蓝',customerWarehouseArrivalDate:'2027-02-01',sizes:[{size:'M',quantity:2}]}]}),randomUUID()));
  const count=Number((await f.db.query('SELECT count(*)::int n FROM receiving_packing_revisions')).rows[0]!.n),calendar=new DeliveryCalendarQuery(f.db),filters=DeliveryCalendarFiltersSchema.parse({search:made.designStyleNo});
  const day=await run(()=>calendar.day(f.root,filters,'2027-02-01'));expect(day.items[0]).toMatchObject({orderedQty:2,packedQty:0,pendingQty:2,packingRevision:null});
  expect((await run(()=>closure.read(f.root,made.productionOrderId))).collection).toMatchObject({shipmentQuantity:0,shipmentStatus:'尚无装箱记录'});
  expect((await f.db.query('SELECT count(*)::int n FROM receiving_packing_revisions')).rows[0]!.n).toBe(count);
  const repository=new JourneyFactRepository(f.db),scope={kind:'order' as const,id:made.productionOrderId};await run(()=>repository.buildOne(scope));
  const stored=()=>run(async()=>{const client=await f.db.connect();try{return await repository.readStoredWithClient(client,scope);}finally{client.release();}});
  expect((await stored()).status).toBe('ready');
  const legacy=new ReceivingService(f.db,undefined,undefined,undefined,{allowLegacyStyleInput:true});
  const receipt=(await run(async()=>legacy.create(receiver(),{styleNo:po,documentQuantity:2,actualQuantity:2,attachmentIds:[await f.image(receiver())]},randomUUID()))).value;
  expect((await stored()).status).toBe('pending');await run(()=>repository.buildOne(scope));expect((await stored()).model!.quantities!.lines[0]!.packed).toBeNull();
  const uncertain=await run(()=>calendar.day(f.root,filters,'2027-02-01'));expect(uncertain.items[0]!.rawPackedQty).toBeNull();expect(uncertain.daySummary.unknownQuantityPoCount).toBe(1);
  const original=await run(()=>row(receipt.receivingBatchId));await run(()=>legacy.deleteBatch(corrector(),receipt.receivingBatchId,original.version));expect((await stored()).status).toBe('pending');await run(()=>repository.buildOne(scope));expect((await stored()).model!.quantities!.lines[0]!.packed).toBe(0);
 });
 it('keeps two original legacy packing scopes unresolved after a typo merge until Root confirms one new current cumulative value',async()=>{
  const scene=await f.scene('2026-11-13T08:00:00+08:00'),run=<T>(work:()=>Promise<T>)=>f.runtime.run(scene,f.root,work),legacy=new ReceivingService(f.db,undefined,undefined,undefined,{allowLegacyStyleInput:true});
  const create=(styleNo:string)=>run(async()=>legacy.create(receiver(),{styleNo,documentQuantity:10,actualQuantity:9,attachmentIds:[await f.image(receiver())]},randomUUID()));
  const first=(await create('TEST-MERGE-A-'+randomUUID())).value,second=(await create('TEST-MERGE-B-'+randomUUID())).value;
  const record=async(id:string,quantity:number)=>{const current=await row(id);return legacy.recordPacking(packer(),{receivingBatchId:id,expectedVersion:current.version,expectedPackingRevisionId:current.packingRevisionId,packingQuantity:quantity},randomUUID());};
  await run(()=>record(first.receivingBatchId,8));await run(()=>record(second.receivingBatchId,9));
  const source=await run(()=>row(first.receivingBatchId)),target=await run(()=>row(second.receivingBatchId));
  await run(()=>legacy.correctBatch(corrector(),first.receivingBatchId,{expectedVersion:source.version,styleNo:target.styleNo,documentQuantity:10,actualQuantity:9,defectiveQuantity:0}));
  const merged=await run(()=>row(second.receivingBatchId));expect(merged).toMatchObject({packingQuantity:null,packingScopeUnresolved:true});
  await expect(run(()=>legacy.recordPacking({...receiver(),authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:merged.receivingBatchId,expectedVersion:merged.version,expectedPackingRevisionId:merged.packingRevisionId,packingQuantity:17},randomUUID()))).rejects.toMatchObject({statusCode:403});
  await run(()=>record(second.receivingBatchId,17));expect(await run(()=>row(second.receivingBatchId))).toMatchObject({packingQuantity:17,packingScopeUnresolved:false});
 });

 it('keeps recorded four distinct from unknown qualified delivery, and refreshes the stored facts after a real QC correction',async()=>{
  const scene=await f.scene('2026-11-14T08:00:00+08:00'),run=<T>(work:()=>Promise<T>)=>f.runtime.run(scene,f.root,work),made=await run(()=>ready(4));
  const first=(await run(async()=>receiving.create(receiver(),{cuttingOrderId:made.cut,documentQuantity:4,actualQuantity:2,attachmentIds:[await f.image(receiver())]},randomUUID()))).value;
  const second=(await run(()=>receiving.createRepeated(receiver(),{cuttingOrderId:made.cut,receivingBatchId:first.receivingBatchId,source:'jiashun',actualQuantity:2,defectiveQuantity:0},randomUUID()))).value;
  const inspect=async(receiptId:string,qualifiedQuantity:number)=>run(async()=>{
   const q=(await closure.read(f.root,made.id)).quality!.find(q=>q.receiptId===receiptId)!;
   return closure.recordQuality(f.root,made.id,{receiptId,quantityVersion:q.quantityVersion,qualifiedQuantity,occurredAt:'2026-11-14T08:00:00+08:00',problem:qualifiedQuantity===2?'':'TEST一件需处理'},randomUUID());
  });
  await inspect(first.receiptId,1);await inspect(second.receiptId,2);await run(()=>pack(second.receivingBatchId,4,{mode:'now'}));
  const sheet=await run(()=>closure.read(f.root,made.id)),line=sheet.lines[0]!;
  expect(line).toMatchObject({orderedQuantity:4,actualQuantity:4,packingQuantity:4,effectivePackingQuantity:null});
  expect(sheet.stage).toBe('等待回货与装箱');expect(sheet.outstanding.join('；')).toContain('有效合格3');
  expect(sheet.collection!.shipmentQuantity).toBeNull();expect(packingSlaEvidence(sheet).facts['garment_packing:'+line.lineId]?.businessCompleted).toBe(false);
  const identity=await run(()=>new DigitalProductionIdentityService(f.db,true).read(f.root,made.id));
  const calendar=new DeliveryCalendarQuery(f.db),filters=DeliveryCalendarFiltersSchema.parse({search:identity.designStyleNo}),due=identity.lines[0]!.customerWarehouseArrivalDate!;
  const day=await run(()=>calendar.day(f.root,filters,due));expect(day.items[0]).toMatchObject({rawPackedQty:4,effectivePackedQty:null,packedQty:null,pendingQty:null,riskStatus:'unknown'});
  expect(day.daySummary).toMatchObject({orderedQty:4,packedQty:null,pendingQty:null,unknownQuantityPoCount:1});
  expect((await run(()=>readPackingQualityCoverage(f.db,[made.id]))).get(line.lineId)).toEqual({received:4,inspected:4,qualified:3});
  const repository=new JourneyFactRepository(f.db),scope={kind:'order' as const,id:made.id};await run(()=>repository.buildOne(scope));
  const stored=()=>run(async()=>{const client=await f.db.connect();try{return await repository.readStoredWithClient(client,scope);}finally{client.release();}});
  const before=await stored();expect(before.status).toBe('ready');expect(before.model!.quantities!.lines[0]!.packed).toBeNull();
  await inspect(first.receiptId,2);expect((await stored()).status).toBe('pending');
  await run(()=>repository.buildOne(scope));const updated=await stored();expect(updated.status).toBe('ready');expect(updated.model!.quantities!.lines[0]!.packed).toBe(4);
  expect((await run(()=>closure.read(f.root,made.id))).collection!.shipmentQuantity).toBe(4);
  const fresh=await run(()=>calendar.day(f.root,filters,due));expect(fresh.daySummary).toMatchObject({orderedQty:4,packedQty:4,pendingQty:0,unknownQuantityPoCount:0});
  expect((await run(()=>row(second.receivingBatchId))).packingQuantity).toBe(4);
 });

 it('uses identical scalar delivery quantities in SQL debt counters and the current PO reader',async()=>{
  const cases:Array<{packed:number|null;received:number|null;inspected:number|null;qualified:number|null;expected:number|null}>=[
   {packed:0,received:null,inspected:null,qualified:null,expected:0},
   {packed:4,received:4,inspected:4,qualified:3,expected:null},
   {packed:4,received:4,inspected:4,qualified:4,expected:4},
   {packed:4,received:4,inspected:2,qualified:2,expected:null},
   {packed:4,received:3,inspected:3,qualified:3,expected:null},
   {packed:null,received:4,inspected:4,qualified:4,expected:null},
  ];
  for(const value of cases){
   const sql=(await f.db.query(`SELECT ${effectivePackingQuantitySql('$1::numeric','$2::numeric','$3::numeric','$4::numeric')} AS quantity`,[value.packed,value.received,value.inspected,value.qualified])).rows[0]!.quantity;
   expect(sql===null?null:Number(sql)).toBe(value.expected);
   expect(effectivePackingQuantity(value.packed,value.received??0,value.received===null?null:{received:value.received,inspected:value.inspected!,qualified:value.qualified!})).toBe(value.expected);
  }
 });

});
