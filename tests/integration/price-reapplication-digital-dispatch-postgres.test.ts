import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {firstContractBusinessReady} from '../../apps/api/src/production-platform/contract-business-ready.js';
import {factoryBatchTiming} from '../../apps/api/src/production-platform/factory-batch-timing.js';
import {SourcingProductionService} from '../../apps/api/src/sourcing/sourcing-production-service.js';
import {SourcingContractReturnService} from '../../apps/api/src/sourcing/sourcing-contract-return-service.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('same-factory price changes preserve digital dispatch execution',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);},120000);
 afterAll(async()=>{await f?.dispose();});
 const reader=()=>({...f.root,authorizationCapability:'sourcing:view'});
 const warehouse=()=>f.people.warehouse!;
 const prepare=async()=>{
  const scene=await f.scene('2026-12-10T01:00:00.000Z');
  const ready=await f.runtime.run(scene,f.root,async()=>{
   const order=await f.bulkReady('无');
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   const cutting=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[order.caseId])).rows[0];
   await order.cutting.record(cutter,cutting.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   return order;
  });
  return {...ready,scene};
 };
 const dispatch=async(orderId:string,quantity:number,key=randomUUID())=>{
  const flow=new FactoryFlowService(f.db),state=await flow.read(warehouse(),orderId);
  const input={expectedRevision:state.revision,supplierId:f.supplierId,occurredAt:businessNow().toISOString(),note:'TEST original warehouse dispatch',lines:[{lineId:state.batchTotals![0]!.lineId,quantity}]};
  return {sheet:await flow.dispatch(warehouse(),orderId,input,key),input,key};
 };
 const request=async(caseId:string,unitPrice:string)=>{
  const contract=(await f.contracts.getCurrent(f.root,caseId)).item!;
  const basis=(await f.db.query('SELECT sourcing_decision_id FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1',[contract.sourcingContractDocumentId])).rows[0];
  await f.sourcing.requestPriceReapplication(f.people['production-management']!,caseId,{unitPrice,changeReason:'TEST price only; original factory and quantities',expectedDecisionId:basis.sourcing_decision_id,expectedContractDocumentId:contract.sourcingContractDocumentId},randomUUID());
   return (await f.sourcing.getCurrentPriceReapplication(reader(),caseId)).item;
 };
 const immutable=async(caseId:string)=>(await f.db.query(`SELECT to_jsonb(p) AS production,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY sequence) FROM sourcing_production_transitions t WHERE t.production_order_id=p.production_order_id) AS transitions,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY position) FROM sourcing_production_lines l WHERE l.production_order_id=p.production_order_id) AS lines
  FROM sourcing_production_orders p WHERE p.sourcing_case_id=$1`,[caseId])).rows;
 it('pending increase changes no approval, supplier, contract or original dispatch facts; manager cannot approve it',async()=>{
  const p=await prepare();await f.runtime.run(p.scene,f.root,async()=>{
   const first=await dispatch(p.id,4),before=await immutable(p.caseId),gate=new BulkPreparationService(f.db),approval=(await gate.gates(f.db,p.id)).approval;
   const pending=(await request(p.caseId,'6'))!;expect(pending.status).toBe('pending');
   await expect(f.sourcing.decidePriceReapplication(f.people['production-management']!,p.caseId,pending.priceRequestId,{decision:'approved',verificationReason:'TEST not owner'},randomUUID())).rejects.toMatchObject({statusCode:403});
   const current=(await gate.gates(f.db,p.id)).approval;
   expect(current.sourcing_approval_snapshot_id).toBe(approval.sourcing_approval_snapshot_id);
   expect((await new FactoryFlowService(f.db).read(warehouse(),p.id)).supplierId).toBe(f.supplierId);
   expect(await immutable(p.caseId)).toEqual(before);
   expect(first.sheet.batchTotals![0]!.sent).toBe(4);
  });
 },60000);
 for(const price of ['6','4'])it(`effective price ${price} retains valid approval, original IE/owner history, and remaining dispatch`,async()=>{
  const p=await prepare();await f.runtime.run(p.scene,f.root,()=>dispatch(p.id,4));
  const before=await immutable(p.caseId),anchor=await firstContractBusinessReady(f.db,p.id);
  const windowBefore=(await factoryBatchTiming(f.db,p.id))!.windows.find(w=>w.kind==='warehouse_dispatch')!;
  const originalJourney=await f.runtime.run(p.scene,f.root,()=>new DigitalJourneyQuery(f.db).read(f.root,p.id));
  await f.advance(p.scene,'2026-12-12T01:31:00.000Z');
  await f.runtime.run(p.scene,f.root,async()=>{
   const pending=(await request(p.caseId,price))!;
   if(price==='6'){
    expect(pending.status).toBe('pending');
    await f.sourcing.decidePriceReapplication(f.people.owner!,p.caseId,pending.priceRequestId,{decision:'approved',verificationReason:'TEST verified increase'},randomUUID());
   }else expect(pending.status).toBe('approved');
   const gate=await new BulkPreparationService(f.db).gates(f.db,p.id);
   expect(gate.ownerApproved).toBe(true);expect(gate.approval.supplier_id).toBe(f.supplierId);
   const contract=(await f.contracts.getCurrent(f.root,p.caseId)).item!;expect(contract.status).toBe('ready');expect(contract.contractVersion).toBe(2);
   const cycle=await new SourcingContractReturnService(f.db).get(reader(),p.caseId);
   expect(cycle.contractGeneratedAt).toBe('2026-12-12T01:31:00.000Z');expect(cycle.contractReturnedAt).toBeNull();
   expect(await firstContractBusinessReady(f.db,p.id)).toEqual(anchor);
   const windowAfter=(await factoryBatchTiming(f.db,p.id))!.windows.find(w=>w.kind==='warehouse_dispatch')!;
   expect([windowAfter.enteredAt,windowAfter.dueAt]).toEqual([windowBefore.enteredAt,windowBefore.dueAt]);
   expect((await f.sourcing.getCase(reader(),p.caseId)).status).toBe('pending_finance_reconciliation');
   const journey=await new DigitalJourneyQuery(f.db).read(f.root,p.id);
   for(const key of ['sourcing_ie','sourcing_director','sourcing_owner']){
    const node=(value:typeof journey)=>value.stages.flatMap(stage=>stage.nodes).find(n=>n.key===key)!;
    expect(node(journey).state).toBe('completed');expect(node(journey).actualAt).toBe(node(originalJourney).actualAt);
   }
   const sent=await dispatch(p.id,6);expect(sent.sheet.dispatched).toBe(true);
   expect(sent.sheet.batchTotals![0]!.sent).toBe(10);
   await new FactoryFlowService(f.db).dispatch(warehouse(),p.id,sent.input,sent.key);
   expect(await immutable(p.caseId)).toEqual(before);
   const id=before[0]!.production.production_order_id;
   expect((await new SourcingProductionService(f.db).get(reader(),id)).productionOrderId).toBe(id);
   expect((await f.db.query("SELECT count(*)::int n FROM digital_production_child_links WHERE production_order_id=$1 AND module='production'",[p.id])).rows[0].n).toBe(1);
   expect((await f.db.query("SELECT count(*)::int n FROM digital_factory_facts f JOIN digital_factory_routes r USING(preparation_id) WHERE r.production_order_id=$1 AND f.kind='仓库实际发厂'",[p.id])).rows[0].n).toBe(2);
  });
 },60000);
 it('equal price is a no-op and the original approval, contract and remaining dispatch remain valid',async()=>{
  const p=await prepare();await f.runtime.run(p.scene,f.root,async()=>{
   await dispatch(p.id,4);const before=await immutable(p.caseId),contract=(await f.contracts.getCurrent(f.root,p.caseId)).item!;
   expect(await request(p.caseId,'5')).toBeNull();
   expect((await f.contracts.getCurrent(f.root,p.caseId)).item!.sourcingContractDocumentId).toBe(contract.sourcingContractDocumentId);
   expect((await dispatch(p.id,6)).sheet.dispatched).toBe(true);expect(await immutable(p.caseId)).toEqual(before);
  });
 },60000);
 it('two distinct-key remaining dispatches at one revision commit only once after approved repricing',async()=>{
  const p=await prepare();await f.runtime.run(p.scene,f.root,async()=>{
   await dispatch(p.id,4);const pending=(await request(p.caseId,'6'))!;
   await f.sourcing.decidePriceReapplication(f.people.owner!,p.caseId,pending.priceRequestId,{decision:'approved',verificationReason:'TEST approved'},randomUUID());
   const flow=new FactoryFlowService(f.db),state=await flow.read(warehouse(),p.id);
   const input={expectedRevision:state.revision,supplierId:f.supplierId,occurredAt:businessNow().toISOString(),note:'TEST race',lines:[{lineId:state.batchTotals![0]!.lineId,quantity:6}]};
   const results=await Promise.allSettled([flow.dispatch(warehouse(),p.id,input,randomUUID()),flow.dispatch(warehouse(),p.id,input,randomUUID())]);
   expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
   expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
   expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{statusCode:409}});
   expect((await flow.read(warehouse(),p.id)).batchTotals![0]!.sent).toBe(10);
  });
 },60000);
 it('a ready price contract before first physical dispatch creates exactly one production execution',async()=>{
  const p=await prepare();await f.runtime.run(p.scene,f.root,async()=>{
   await request(p.caseId,'4');const current=(await f.contracts.getCurrent(f.root,p.caseId)).item!;
   await dispatch(p.id,10);const rows=await immutable(p.caseId);expect(rows).toHaveLength(1);
   expect(rows[0]!.production.sourcing_contract_document_id).toBe(current.sourcingContractDocumentId);
   expect(Date.parse(rows[0]!.production.dispatched_at)).toBe(businessNow().getTime());
  });
 },60000);
 it('contract-not-ready and a mid-dispatch failure leave all original facts and receipts intact; same key can retry',async()=>{
  const p=await prepare();await f.runtime.run(p.scene,f.root,async()=>{
   await dispatch(p.id,4);const before=await immutable(p.caseId),flow=new FactoryFlowService(f.db);
   const generation=vi.spyOn(f.contracts,'generateIfReady').mockRejectedValueOnce(new Error('TEST delayed price PDF'));
   try{await request(p.caseId,'4');}finally{generation.mockRestore();}
   const state=await flow.read(warehouse(),p.id),key=randomUUID(),input={expectedRevision:state.revision,supplierId:f.supplierId,occurredAt:businessNow().toISOString(),note:'TEST rollback',lines:[{lineId:state.batchTotals![0]!.lineId,quantity:6}]};
   await expect(flow.dispatch(warehouse(),p.id,input,key)).rejects.toThrow('当前批准合同未就绪');
   expect((await flow.read(warehouse(),p.id)).revision).toBe(state.revision);
   await f.contracts.generateIfReady(f.root,p.caseId);
   const crash=vi.spyOn(SourcingProductionService.prototype,'dispatchDigitalWithClient').mockRejectedValueOnce(new Error('TEST transactional downstream failure'));
   try{await expect(flow.dispatch(warehouse(),p.id,input,key)).rejects.toThrow('TEST transactional downstream failure');}finally{crash.mockRestore();}
   expect((await flow.read(warehouse(),p.id)).revision).toBe(state.revision);
   expect((await flow.read(warehouse(),p.id)).batchTotals![0]!.sent).toBe(4);
   expect(await immutable(p.caseId)).toEqual(before);
   expect((await flow.dispatch(warehouse(),p.id,input,key)).batchTotals![0]!.sent).toBe(10);
   expect(await immutable(p.caseId)).toEqual(before);
  });
 },60000);
 it('successive effective prices keep the original manufacturing approval history and one execution',async()=>{
  const p=await prepare();await f.runtime.run(p.scene,f.root,async()=>{
   await dispatch(p.id,4);const before=await immutable(p.caseId),query=new DigitalJourneyQuery(f.db),history=await query.read(f.root,p.id);
   for(const price of ['4','3'])await request(p.caseId,price);
   const pending=(await request(p.caseId,'6'))!;
   await f.sourcing.decidePriceReapplication(f.people.owner!,p.caseId,pending.priceRequestId,{decision:'approved',verificationReason:'TEST third price'},randomUUID());
   const current=await query.read(f.root,p.id);
   for(const key of ['sourcing_ie','sourcing_director','sourcing_owner']){
    const node=(value:typeof history)=>value.stages.flatMap(stage=>stage.nodes).find(n=>n.key===key)!;
    expect(node(current).state).toBe('completed');expect(node(current).actualAt).toBe(node(history).actualAt);
    expect(node(current).operator).toEqual(node(history).operator);
   }
   expect((await f.contracts.getCurrent(f.root,p.caseId)).item!.contractVersion).toBe(4);
   expect((await dispatch(p.id,6)).sheet.dispatched).toBe(true);expect(await immutable(p.caseId)).toEqual(before);
  });
 },60000);
});
