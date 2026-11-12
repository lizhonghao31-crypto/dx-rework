import {listMiscAssociations} from '../../apps/api/src/pattern-room/misc-associations.js';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {PatternRoomPriceService,PATTERN_HOURLY_PRICE_ID} from '../../apps/api/src/pattern-room/price-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {linkNewDigitalChild} from '../../apps/api/src/production-platform/child-link-repository.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {WholeOrderDeletionService} from '../../apps/api/src/production-platform/whole-order-deletion-service.js';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('Root whole-order deletion',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);},120000);
 afterAll(async()=>{await f?.dispose();});
 it('deletes the native bulk/receiving/rework chain together while retaining records',async()=>{
  const chain=await f.reworkReady(),service=new WholeOrderDeletionService(f.db);
  const unrelated=await f.bulkReady('无');
  const preview=await service.preview(f.root,{ids:[chain.ready.id,chain.ready.sourceId]});
  expect(preview.orders).toHaveLength(1);
  expect((await listMiscAssociations(f.db,f.root,preview.orders[0]!.label)).map(row=>row.kind)).toEqual(expect.arrayContaining(['source','po']));
  expect(preview.orders[0]!.counts.rework).toBe(1);
  expect(preview.orders[0]!.counts.receiving_batch).toBe(1);
  const result=await service.remove(f.root,{orders:preview.orders.map(({id,revision})=>({id,revision}))},randomUUID());
  expect(result.results).toEqual([{id:chain.ready.id,status:'deleted'}]);
  expect(await listMiscAssociations(f.db,f.root,preview.orders[0]!.label)).toEqual([]);
  expect((await f.sourcing.getCase({...f.root,authorizationCapability:'sourcing:view'},unrelated.caseId)).sourcingCaseId).toBe(unrelated.caseId);
  expect((await f.db.query('SELECT 1 FROM supplier_catalog_items WHERE supplier_id=$1',[f.supplierId])).rowCount).toBe(1);
  expect((await f.db.query("SELECT 1 FROM message_outbox WHERE topic='rework.deleted' AND aggregate_id=$1",[chain.id])).rowCount).toBe(1);
  await expect(new DigitalJourneyQuery(f.db).read(f.root,chain.ready.id)).rejects.toMatchObject({statusCode:404});
  await expect(f.sourcing.getCase({...f.root,authorizationCapability:'sourcing:view'},chain.ready.caseId)).rejects.toMatchObject({statusCode:404});
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[chain.ready.caseId])).rows[0];
  await expect(chain.ready.cutting.get(f.root,cut.cutting_order_id)).rejects.toMatchObject({statusCode:404});
  expect(await new JourneyFactRepository(f.db).buildOne({kind:'order',id:chain.ready.id},{retireMissing:true})).toMatchObject({retired:true});
  expect((await f.db.query('SELECT status FROM rework_orders WHERE rework_order_id=$1',[chain.id])).rows[0].status).toBe('deleted');
  expect((await f.db.query('SELECT deleted_at FROM sourcing_cases WHERE sourcing_case_id=$1',[chain.ready.caseId])).rows[0].deleted_at).not.toBeNull();
  expect((await f.db.query("SELECT count(*)::int n FROM receiving_receipts r JOIN digital_whole_order_deleted_objects d ON d.object_kind='receiving' AND d.object_id=r.receipt_id")).rows[0].n).toBeGreaterThan(0);
 },120000);
 it('refuses an ambiguous legacy shared batch atomically without changing the other receipt',async()=>{
  const ready=await f.bulkReady('无'),receiving=new ReceivingService(f.db,undefined,undefined,undefined,{allowLegacyStyleInput:true}),service=new WholeOrderDeletionService(f.db);
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create'};
  const style='TEST-SHARED-'+randomUUID();
  const first=await receiving.create(warehouse,{styleNo:style,documentQuantity:10,actualQuantity:5,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const second=await receiving.createRepeated(warehouse,{receivingBatchId:first.value.receivingBatchId,source:'other_factory',documentQuantity:10,actualQuantity:5},randomUUID());
  expect(second.value.receivingBatchId).toBe(first.value.receivingBatchId);
  // Historical explicit ownership is a fixture condition; shared native receipt
  // facts are created through the real receiving commands with all guards on.
  const db=await f.db.connect();try{await db.query('BEGIN');await linkNewDigitalChild(db,{module:'receiving',childId:first.value.receiptId,productionOrderId:ready.id,lines:[]});await db.query('COMMIT');}finally{db.release();}
  const preview=await service.preview(f.root,{ids:[ready.id]});
  const result=await service.remove(f.root,{orders:preview.orders.map(({id,revision})=>({id,revision}))},randomUUID());
  expect(result.results[0]).toMatchObject({status:'failed',message:expect.stringContaining('共用批次')});
  expect((await f.db.query('SELECT 1 FROM digital_whole_order_deletions WHERE production_order_id=$1',[ready.id])).rowCount).toBe(0);
  expect((await f.db.query('SELECT deleted_at FROM receiving_batches WHERE receiving_batch_id=$1',[first.value.receivingBatchId])).rows[0].deleted_at).toBeNull();
  expect((await f.db.query('SELECT count(*)::int n FROM receiving_receipts WHERE receiving_batch_id=$1',[first.value.receivingBatchId])).rows[0].n).toBe(2);
 });
 it('invalidates another active order when deleting its matching legacy receipt alias',async()=>{
  const owner=await f.bulkReady('无'),identity=new DigitalProductionIdentityService(f.db,true),service=new WholeOrderDeletionService(f.db);
  const style='TEST-ALIAS-'+randomUUID();
  const candidate=await identity.createOrder(f.people['sample-designer']!,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-12',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:style,color:'蓝',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID());
  const receiving=new ReceivingService(f.db,undefined,undefined,undefined,{allowLegacyStyleInput:true}),warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create'};
  const receipt=await receiving.create(warehouse,{styleNo:style,documentQuantity:10,actualQuantity:5,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const db=await f.db.connect();try{await db.query('BEGIN');await linkNewDigitalChild(db,{module:'receiving',childId:receipt.value.receiptId,productionOrderId:owner.id,lines:[]});await db.query('COMMIT');}finally{db.release();}
  await f.db.query("DELETE FROM digital_journey_fact_changes WHERE resource_kind='order' AND resource_id=$1",[candidate.productionOrderId]);
  const preview=await service.preview(f.root,{ids:[owner.id]});
  expect((await service.remove(f.root,{orders:preview.orders.map(({id,revision})=>({id,revision}))},randomUUID())).results[0]!.status).toBe('deleted');
  expect((await f.db.query("SELECT 1 FROM digital_journey_fact_changes WHERE resource_kind='order' AND resource_id=$1",[candidate.productionOrderId])).rowCount).toBe(1);
  expect(await new DigitalProductionAccessPolicy(f.db).allowed(f.root,'order',candidate.productionOrderId,'technical')).toBe(true);
 });
 it('deletes a linked native misc order but preserves an unrelated misc order',async()=>{
  const identity=new DigitalProductionIdentityService(f.db,true),service=new WholeOrderDeletionService(f.db);
  const style='TEST-MISC-DELETE-'+randomUUID();
  const source=await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const price=await new PatternRoomPriceService(f.db).change(f.root,'hourly',PATTERN_HOURLY_PRICE_ID,{version:1,amount:'12.000',enabled:true,reason:'TEST deletion fixture'},randomUUID());
  const native=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
  const linked=await native.createMisc(f.root,{taskName:'TEST owned misc',styleNo:style,priceVersion:price.version,association:{kind:'source',id:source.sourceId}},randomUUID());
  const other=await native.createMisc(f.root,{taskName:'TEST unrelated misc',priceVersion:price.version},randomUUID());
  const preview=await service.preview(f.root,{ids:[source.sourceId]});expect(preview.orders[0]!.counts.pattern_room).toBe(1);
  expect((await service.remove(f.root,{orders:preview.orders.map(({id,revision})=>({id,revision}))},randomUUID())).results[0]!.status).toBe('deleted');
  expect(await native.miscAssociations(f.root,style)).toEqual([]);
  await expect(native.get(f.root,linked.orderId)).rejects.toMatchObject({statusCode:404});
  expect((await native.get(f.root,other.orderId)).orderId).toBe(other.orderId);
  expect((await f.db.query('SELECT deleted_at FROM pattern_room_orders WHERE order_id=$1',[linked.orderId])).rows[0].deleted_at).not.toBeNull();
 });
 it('requires current Root, retains source facts and isolates repeated deletion',async()=>{
  const identity=new DigitalProductionIdentityService(f.db,true),service=new WholeOrderDeletionService(f.db);
  const style='TEST-DELETE-'+randomUUID();
  const source=await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  await expect(service.preview(f.people['sample-designer']!,{ids:[source.sourceId]})).rejects.toMatchObject({statusCode:403});
  const preview=await service.preview(f.root,{ids:[source.sourceId,source.sourceId]});
  expect(preview.orders).toHaveLength(1);
  const input={orders:preview.orders.map(({id,revision})=>({id,revision}))},key=randomUUID();
  expect(await service.remove(f.root,input,key)).toEqual({results:[{id:source.sourceId,status:'deleted'}]});
  expect(await service.remove(f.root,input,key)).toEqual({results:[{id:source.sourceId,status:'already_deleted'}]});
  await expect(service.remove(f.root,{orders:[{id:source.sourceId,revision:'0'.repeat(64)}]},key)).rejects.toMatchObject({statusCode:409});
  expect(await new DigitalProductionAccessPolicy(f.db).allowed(f.root,'source',source.sourceId,'technical')).toBe(false);
  expect((await f.db.query('SELECT 1 FROM digital_production_sources WHERE source_id=$1',[source.sourceId])).rowCount).toBe(1);
  expect((await identity.sources(f.root,1,style)).items).toHaveLength(0);
 });
 it('isolates a stale item from a valid batch item and serializes concurrent retries',async()=>{
  const identity=new DigitalProductionIdentityService(f.db,true),service=new WholeOrderDeletionService(f.db);
  const create=()=>identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:'TEST-BATCH-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const a=await create(),b=await create();
  const preview=await service.preview(f.root,{ids:[a.sourceId,b.sourceId]});
  const input={orders:preview.orders.map(({id,revision})=>({id,revision:id===a.sourceId?'0'.repeat(64):revision}))};
  const response=await service.remove(f.root,input,randomUUID());
  expect(response.results.map(row=>row.status)).toEqual(['failed','deleted']);
  const policy=new DigitalProductionAccessPolicy(f.db);
  expect(await policy.allowed(f.root,'source',a.sourceId,'technical')).toBe(true);
  expect(await policy.allowed(f.root,'source',b.sourceId,'technical')).toBe(false);
  const retry={orders:preview.orders.filter(row=>row.id===a.sourceId).map(({id,revision})=>({id,revision}))},key=randomUUID();
  const concurrent=await Promise.all([service.remove(f.root,retry,key),service.remove(f.root,retry,key)]);
  expect(concurrent.flatMap(result=>result.results.map(row=>row.status)).sort()).toEqual(['already_deleted','deleted']);
  expect((await f.db.query('SELECT count(*)::int n FROM digital_whole_order_deletions WHERE source_id=$1',[a.sourceId])).rows[0].n).toBe(1);
 });
 it('rechecks current Root eligibility after preview using the same actor',async()=>{
  const identity=new DigitalProductionIdentityService(f.db,true),service=new WholeOrderDeletionService(f.db);
  const source=await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:'TEST-REVOKE-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const preview=await service.preview(f.root,{ids:[source.sourceId]});
  await f.db.query('UPDATE identity_mappings SET active=false WHERE user_id=$1',[f.root.actorId]);
  try{await expect(service.remove(f.root,{orders:preview.orders.map(({id,revision})=>({id,revision}))},randomUUID())).rejects.toMatchObject({statusCode:403});}
  finally{await f.db.query('UPDATE identity_mappings SET active=true WHERE user_id=$1',[f.root.actorId]);}
  expect((await f.db.query('SELECT 1 FROM digital_whole_order_deletions WHERE source_id=$1',[source.sourceId])).rowCount).toBe(0);
 });

 it('rolls back all deletion marks when a native database guard refuses the operation',async()=>{
  const identity=new DigitalProductionIdentityService(f.db,true),service=new WholeOrderDeletionService(f.db);
  const source=await identity.createSource(f.people['sample-designer']!,{developmentType:'头版',designStyleNo:'TEST-ROLLBACK-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const preview=await service.preview(f.root,{ids:[source.sourceId]});
  await f.db.query(`CREATE FUNCTION test_refuse_whole_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST fail after ledger insert'; END $$;
   CREATE TRIGGER test_refuse_whole_delete BEFORE INSERT ON digital_production_resource_lifecycle FOR EACH ROW EXECUTE FUNCTION test_refuse_whole_delete()`);
  try{
   const result=await service.remove(f.root,{orders:preview.orders.map(({id,revision})=>({id,revision}))},randomUUID());
   expect(result.results[0]!.status).toBe('failed');
   expect((await f.db.query('SELECT 1 FROM digital_whole_order_deletions WHERE source_id=$1',[source.sourceId])).rowCount).toBe(0);
   expect((await f.db.query('SELECT 1 FROM digital_whole_order_deleted_objects WHERE object_id=$1',[source.sourceId])).rowCount).toBe(0);
   expect(await new DigitalProductionAccessPolicy(f.db).allowed(f.root,'source',source.sourceId,'technical')).toBe(true);
  }finally{await f.db.query('DROP TRIGGER test_refuse_whole_delete ON digital_production_resource_lifecycle; DROP FUNCTION test_refuse_whole_delete()');}
 });

});
