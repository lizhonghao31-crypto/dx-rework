import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {SlaCalculationService} from '../../apps/api/src/production-platform/sla-calculation-service.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {JourneyFilterSchema,type OrderJourney,type JourneyResult} from '@dx-rework/contracts/digital-production-journey';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {readWarehouseFactoryDispatchScopes} from '../../apps/api/src/production-platform/warehouse-factory-dispatch-evidence.js';
import {nativeFactoryTimeline} from '../../apps/api/src/production-platform/factory-production-facts.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {SlaConfigurationService} from '../../apps/api/src/production-platform/sla-configuration-service.js';
import {SlaOrderApplicationService} from '../../apps/api/src/production-platform/sla-order-application.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('native factory shipment date ranges in authorized cockpit reads',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 const frames:Array<{name:string;factory:FactoryFlowSheet;detail:OrderJourney;list:OrderJourney;listResult:JourneyResult}>=[];
 const orders:Array<{id:string;scene:string|null;day:string;at:string}>=[];
 beforeAll(async()=>{f=await businessAnchorFixture(url!);await new ProductionClosureService(f.db).setPilot(f.root,{supplierId:f.supplierId,enabled:true});},120000);
 afterAll(async()=>{try{if(process.env.PR4_LOGISTICS_UI_INPUT)await writeFile(process.env.PR4_LOGISTICS_UI_INPUT,JSON.stringify({frames}));}finally{await f?.dispose();}});
 const context=async(at:string|null)=>{
  const scene=at?await f.scene(at):null,run=<T>(work:()=>Promise<T>)=>scene?f.runtime.run(scene,f.root,work):work();return {scene,run};
 };
 const prepare=async(run:<T>(work:()=>Promise<T>)=>Promise<T>,poCount=1,withSourcingTodos=false)=>run(async()=>{
  const commands=withSourcingTodos?new SourcingService(f.db,undefined,undefined,new TodoProjectionService(new TodoService(f.db)),f.contracts):f.sourcing;
  const r=await f.bulkReady('无',undefined,poCount,commands),cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[r.caseId])).rows;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of cuts)await r.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,r.id);
  await flow.dispatch(f.people.warehouse!,r.id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST date-only logistics'},randomUUID());
  const productionId=(await f.db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1',[r.caseId])).rows[0].production_order_id as string;
  return {...r,productionId,cuts,day:beijingCalendarDate(businessNow())};
 });
 let sundayScene:string,sundayReady:Awaited<ReturnType<typeof prepare>>;
 beforeAll(async()=>{sundayScene=await f.scene('2026-12-06T05:00:00.000Z');sundayReady=await prepare(work=>f.runtime.run(sundayScene,f.root,work));},120000);
 it('does not treat earlier native factory QC as production completion',async()=>f.runtime.run(sundayScene,f.root,async()=>{
  const factory=new FactoryFlowService(f.db),dispatched=await factory.read(f.root,sundayReady.id),lineId=dispatched.batchTotals![0]!.lineId;
  await factory.productionQc(f.root,sundayReady.id,{expectedRevision:dispatched.revision,factoryDecisionId:null,occurredAt:businessNow().toISOString(),checks:[{lineId,result:'合格',problem:''}],note:'TEST QC before native production completion'},randomUUID());
  const before=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'order',id:sundayReady.id,range:'delivery'}});
  expect(before.context.graph.anchors[`${lineId}/factory_production_finished`]).toBeUndefined();expect(before.current.rows.find(n=>n.id===`${lineId}/factory_finished`)!.end.at).toBeNull();
  const timeline=await nativeFactoryTimeline(f.db,sundayReady.id);
  expect(timeline).toHaveLength(1);expect(timeline[0]).toMatchObject({lineId,completedDate:null,completionTransitionRef:null});
 }));
 const ship=async(r:{productionId:string;day:string},factoryDecisionId:string|null=null,quantities=[10])=>{
  const reports=new ProductionReportingService(f.db);
  for(const [index,quantity] of quantities.entries())if(quantity)await reports.report(f.root,r.productionId,{position:index+1,factoryDecisionId,businessDate:r.day,quantity},randomUUID());
  await reports.execute(f.root,r.productionId,'complete',{factoryDecisionId,businessDate:r.day,confirmed:true},randomUUID());
  await reports.execute(f.root,r.productionId,'ship',{factoryDecisionId,businessDate:r.day,confirmed:true},randomUUID());
 };
 const reads=async(id:string,name:string)=>{
  const factory=await new FactoryFlowService(f.db).read(f.root,id),sla=await new SlaOrderService(f.db).read(f.root,id),query=new DigitalJourneyQuery(f.db),detail=await query.read(f.root,id,undefined,true),result=await query.list(f.root,JourneyFilterSchema.parse({scope:'production',search:detail.designStyleNo}));
  const list=result.items.find(o=>o.orderId===id)!;expect(list).toBeDefined();
  expect(list.supervision!.nodes.filter(n=>n.id.startsWith('return_logistics:'))).toEqual(detail.supervision!.nodes.filter(n=>n.id.startsWith('return_logistics:')));
  frames.push({name,factory,detail,list,listResult:result});return {factory,sla,detail,list};
 };
 const nativeSnapshot=async()=>{
  const rows=[];for(const table of ['sourcing_production_reports','sourcing_production_transitions','sourcing_production_shipments','receiving_receipts','sourcing_production_receipt_links'])rows.push((await f.db.query(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') AS snapshot FROM ${table} r`)).rows[0].snapshot);return rows;
 };
 const publishAdjustment=async(key:'sourcing_ie'|'garment_inspection')=>{
  const db=await f.db.connect();try{await db.query('BEGIN');const current=(await new SlaConfigurationRepository(db).current())!,values=structuredClone(current.values),value=values[key]!;
   if(value.kind!=='duration')throw Error('Expected the original duration rule');values[key]={...value,minutes:value.minutes+60};
   const saved=await new SlaConfigurationService().publishNewStandard(db,f.root,{expectedVersion:current.version,values,reason:'TEST selected business adjustment',requestKey:randomUUID()});await db.query('COMMIT');return {version:saved.version,minutes:value.minutes+60};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 };
 const applicationSnapshot=async()=>{
  const rows=[];for(const table of ['digital_sla_order_snapshots','digital_sla_plans','digital_sla_node_facts','digital_production_task_events','digital_production_commands','digital_production_tasks','digital_production_deadline_revisions'])rows.push((await f.db.query(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') AS snapshot FROM ${table} r`)).rows[0].snapshot);return rows;
 };
 it('preserves the Sunday shipped date and frozen 48-hour range without an actual midnight or receipt deadline',async()=>{
  const ready=sundayReady,lineId=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[ready.id])).rows[0].line_id as string;
  let completedAnchor:unknown;
  await f.runtime.run(sundayScene,f.root,async()=>{
   const reports=new ProductionReportingService(f.db),day=beijingCalendarDate(businessNow());
   await reports.report(f.root,ready.productionId,{position:1,businessDate:day,quantity:10},randomUUID());
   await reports.execute(f.root,ready.productionId,'complete',{businessDate:day,confirmed:true},randomUUID());
   const completed=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'order',id:ready.id,range:'delivery'}});
   completedAnchor=completed.context.graph.anchors[`${lineId}/factory_production_finished`];
   expect(completedAnchor).toMatchObject({precision:'date',value:'2026-12-06'});expect(completed.current.rows.find(n=>n.id===`${lineId}/factory_finished`)!.end.at).toBeNull();
   await reports.execute(f.root,ready.productionId,'ship',{businessDate:day,confirmed:true},randomUUID());
  });
  const factory=await new FactoryFlowService(f.db).read(f.root,ready.id),expected=factory.returnLogistics![0]!;
  expect(expected).toMatchObject({shippedOn:'2026-12-06',dispatchPrecision:'date',actualDispatchedAt:null,estimatedMinutes:2880,arrivalRange:{fromInclusive:'2026-12-07T16:00:00.000Z',toExclusive:'2026-12-08T16:00:00.000Z'}});
  const sla=await new SlaOrderService(f.db).read(f.root,ready.id),query=new DigitalJourneyQuery(f.db),detail=await query.read(f.root,ready.id,undefined,true),list=await query.list(f.root,JourneyFilterSchema.parse({scope:'production'}));
  const id=`return_logistics:${detail.lines[0]!.id}`,node=sla.nodes!.find(n=>n.id===id)!;
  expect(node).toMatchObject({actualStart:null,actualEnd:null,deadline:{at:null},forecast:{at:null},logisticsWindows:[expected]});
  expect(detail.supervision!.nodes.find(n=>n.id===id)).toMatchObject({logisticsWindows:[expected]});
  expect(list.items.find(o=>o.orderId===ready.id)!.supervision!.nodes.find(n=>n.id===id)).toMatchObject({logisticsWindows:[expected]});
  expect(node.status).not.toMatch(/overdue|completed_on_time|completed_late/);
  const calculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'order',id:ready.id,range:'delivery'}}),estimate=calculation.current.rows.find(n=>n.id.endsWith('/native-logistics:0'))!;expect(estimate.estimateRange).toMatchObject({...expected.arrivalRange!,shippedOn:expected.shippedOn,actualDispatchedAt:null});expect(estimate.start.at).toBeNull();expect(estimate.end.at).toBeNull();expect(calculation.current.overall.spanMs).toBeNull();expect(calculation.context.graph.anchors[`${lineId}/factory_production_finished`]).toEqual(completedAnchor);
 });
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: native ranges match factory, list and detail; exact facts and read-only state do not change`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-7:mode==='future'?7:0)*86400000).toISOString(),ctx=await context(mode==='ordinary'?null:at),r=await prepare(ctx.run);
  const before=await reads(r.id,mode+' before shipment');expect(before.sla.nodes!.filter(n=>n.id.startsWith('return_logistics:')).every(n=>!n.logisticsWindows&&n.forecast.at===null)).toBe(true);
  await ctx.run(()=>ship(r));const snapshot=await nativeSnapshot(),result=await reads(r.id,mode+' shipped');
  const windows=result.factory.returnLogistics!;expect(windows).toHaveLength(1);expect(windows[0]).toMatchObject({shippedOn:r.day,dispatchPrecision:'date',actualDispatchedAt:null,estimatedMinutes:2880});
  const midnight=Date.parse(r.day+'T00:00:00+08:00');expect(windows[0]!.arrivalRange).toEqual({fromInclusive:new Date(midnight+2*86400000).toISOString(),toExclusive:new Date(midnight+3*86400000).toISOString()});
  const node=result.sla.nodes!.find(n=>n.id.startsWith('return_logistics:'))!;expect(node.logisticsWindows).toEqual(windows);expect(node).toMatchObject({actualStart:null,actualEnd:null,deadline:{at:null},forecast:{at:null},planOverdue:false});
  expect(node.status).not.toMatch(/overdue|completed_on_time|completed_late/);expect(await nativeSnapshot()).toEqual(snapshot);
  if(ctx.scene)expect(result.detail.supervision!.asOf).toBe(at);else expect(Math.abs(Date.parse(result.detail.supervision!.asOf)-Date.now())).toBeLessThan(60000);
  orders.push({id:r.id,scene:ctx.scene,day:r.day,at});
 },testExecutionConfig.correctnessTimeoutMs);
 it('uses each scene at the exclusive range boundary ±1ms; advancing time never creates a receipt or hard overdue',async()=>{
  const ctx=await context('2026-12-06T15:59:59.999Z'),r=await prepare(ctx.run);await ctx.run(()=>ship(r));
  const original=await reads(r.id,'Sunday date before boundary'),window=original.factory.returnLogistics![0]!,end=Date.parse(window.arrivalRange!.toExclusive),snapshot=await nativeSnapshot();
  await f.advance(ctx.scene!,'2026-12-06T16:00:00.000Z');expect((await reads(r.id,'Beijing next day')).factory.returnLogistics![0]!.shippedOn).toBe('2026-12-06');
  for(const offset of [-1,0,1]){
   await f.advance(ctx.scene!,new Date(end+offset).toISOString());const result=await reads(r.id,`range boundary ${offset}`),node=result.sla.nodes!.find(n=>n.id.startsWith('return_logistics:'))!;
   expect(node.logisticsWindows![0]).toMatchObject({estimateExpired:offset>=0,arrivalRange:window.arrivalRange,actualDispatchedAt:null});expect(node.deadline.at).toBeNull();expect(node.planOverdue).toBe(false);expect(node.status).not.toMatch(/overdue|completed/);
  }
  expect(await nativeSnapshot()).toEqual(snapshot);
  await expect(f.runtime.run(ctx.scene!,f.root,()=>new SlaOrderService(f.db).read(f.root,orders[0]!.id))).rejects.toMatchObject({code:'ACCEPTANCE_CLOCK_CONFLICT'});
  const list=await new DigitalJourneyQuery(f.db).list(f.root,JourneyFilterSchema.parse({scope:'production'}));
  for(const order of orders){const item=list.items.find(i=>i.orderId===order.id)!;expect(item.supervision!.nodes.find(n=>n.id.startsWith('return_logistics:'))!.logisticsWindows![0]!.shippedOn).toBe(order.day);if(order.scene)expect(item.supervision!.asOf).toBe(order.at);}
 },testExecutionConfig.correctnessTimeoutMs);
 it('matches shared cutting receipts to the explicit shipped factory even when both supplier pilots are off',async()=>{
  const ctx=await context('2026-11-24T09:00:00.000Z'),r=await prepare(ctx.run);
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:`TEST-${randomUUID().slice(0,8).toUpperCase()}`,supplierType:'factory',supplierName:'TEST nonpilot transfer factory',address:'TEST',contractEntityName:'TEST',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0002',bankName:'TEST',changeReason:'TEST receipt factory isolation'}));
  await ctx.run(async()=>{
   const closure=new ProductionClosureService(f.db),reports=new ProductionReportingService(f.db),receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},service=new ReceivingService(f.db,undefined,undefined,closure);
   await closure.setPilot(f.root,{supplierId:f.supplierId,enabled:false});
   await reports.report(f.root,r.productionId,{position:1,businessDate:r.day,quantity:2},randomUUID());
   await f.sourcing.requestFactoryChange(f.people['production-management']!,r.caseId,{supplierId:supplier.supplierId,unitPrice:'6',changeReason:'TEST transfer remaining eight'},randomUUID());
   const request=(await f.sourcing.getCurrentFactoryChange({...f.root,authorizationCapability:'sourcing:view'},r.caseId)).item!;
   const changed=await f.sourcing.decideFactoryChange(f.people.owner!,r.caseId,request.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST receipt split scope'},randomUUID()),factoryDecisionId=changed.value.decision!.sourcingDecisionId;
   await reports.execute(f.root,r.productionId,'complete',{factoryDecisionId:null,businessDate:r.day,confirmed:true},randomUUID());
   await reports.execute(f.root,r.productionId,'ship',{factoryDecisionId:null,businessDate:r.day,confirmed:true},randomUUID());
   await ship(r,factoryDecisionId,[8]);
   expect((await closure.expected(receiver,{cuttingOrderId:r.cuts[0].cutting_order_id})).items.map(row=>row.factoryDecisionId)).toEqual(expect.arrayContaining([null,factoryDecisionId]));
   const body={cuttingOrderId:r.cuts[0].cutting_order_id,documentQuantity:2,actualQuantity:2,attachmentIds:[await f.image(receiver)]};
   await expect(service.create(receiver,body,randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(service.create(receiver,{...body,productionOrderId:r.productionId,factoryDecisionId:randomUUID()},randomUUID())).rejects.toMatchObject({statusCode:409});
   expect((await f.db.query('SELECT 1 FROM sourcing_production_receipt_links WHERE production_order_id=$1',[r.productionId])).rowCount).toBe(0);
   const original=await service.create(receiver,{...body,productionOrderId:r.productionId,factoryDecisionId:null},randomUUID());
   const current=await service.createRepeated(receiver,{cuttingOrderId:r.cuts[0].cutting_order_id,receivingBatchId:original.value.receivingBatchId,source:'other_factory',documentQuantity:8,actualQuantity:8,productionOrderId:r.productionId,factoryDecisionId},randomUUID());
   expect((await closure.receiptSummary(f.root,r.productionId,null)).shipment?.receipts.map(row=>row.receiptId)).toEqual([original.value.receiptId]);
   expect((await closure.receiptSummary(f.root,r.productionId,factoryDecisionId)).shipment?.receipts.map(row=>row.receiptId)).toEqual([current.value.receiptId]);
  });
 });
 it('R5 exposes the current approved factory after all original allocation is transferred',async()=>{
  const ctx=await context('2026-11-24T09:00:00.000Z'),r=await prepare(ctx.run);
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:`TEST-${randomUUID().slice(0,8).toUpperCase()}`,supplierType:'factory',supplierName:'TEST current factory after full transfer',address:'TEST',contractEntityName:'TEST',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0002',bankName:'TEST',changeReason:'TEST original factory zero allocation'}));
  await ctx.run(async()=>{
   expect((await new FactoryFlowService(f.db).read(f.root,r.id)).currentProduction).toEqual({productionId:r.productionId,factoryDecisionId:null});
   const originalDispatches=await readWarehouseFactoryDispatchScopes(f.db,r.id);
   expect(originalDispatches).toMatchObject([{productionId:r.productionId,factoryDecisionId:null,cuttingOrderId:r.cuts[0]!.cutting_order_id,quantity:10}]);
   await f.sourcing.requestFactoryChange(f.people['production-management']!,r.caseId,{supplierId:supplier.supplierId,unitPrice:'6',changeReason:'TEST transfer all unstarted quantities'},randomUUID());
   const request=(await f.sourcing.getCurrentFactoryChange({...f.root,authorizationCapability:'sourcing:view'},r.caseId)).item!;
   const changed=await f.sourcing.decideFactoryChange(f.people.owner!,r.caseId,request.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST exact current factory'},randomUUID());
   const state=await new FactoryFlowService(f.db).read(f.root,r.id);
   expect(state.supplierName).toBe('TEST current factory after full transfer');
   expect(state.currentProduction).toEqual({productionId:r.productionId,factoryDecisionId:changed.value.decision!.sourcingDecisionId});
   const original=(await f.db.query('SELECT quantity FROM sourcing_production_factory_orders WHERE production_order_id=$1 AND factory_decision_id IS NULL',[r.productionId])).rows;
   expect(original.map(row=>Number(row.quantity))).toEqual([0]);
   const factoryDecision=changed.value.decision!.sourcingDecisionId,document=(await f.db.query('SELECT sourcing_contract_document_id FROM sourcing_contract_documents WHERE sourcing_decision_id=$1 ORDER BY contract_version DESC LIMIT 1',[factoryDecision])).rows[0].sourcing_contract_document_id;
   await f.sourcing.requestPriceReapplication(f.people['production-management']!,r.caseId,{unitPrice:'6.1',changeReason:'TEST price update retains native factory scope',expectedDecisionId:factoryDecision,expectedContractDocumentId:document},randomUUID());
   const price=(await f.sourcing.getCurrentPriceReapplication({...f.root,authorizationCapability:'sourcing:view'},r.caseId)).item!;
   const repriced=await f.sourcing.decidePriceReapplication(f.people.owner!,r.caseId,price.priceRequestId,{decision:'approved',verificationReason:'TEST same native execution'},randomUUID());
   expect(repriced.value.decision!.sourcingDecisionId).not.toBe(factoryDecision);
   expect((await new FactoryFlowService(f.db).read(f.root,r.id)).currentProduction).toEqual({productionId:r.productionId,factoryDecisionId:factoryDecision});
   expect(await readWarehouseFactoryDispatchScopes(f.db,r.id)).toEqual(originalDispatches);

  });
 });
 it('keeps native factory transfer executions and two PO allocations separate',async()=>{
  const ctx=await context('2026-11-24T09:00:00.000Z'),r=await prepare(ctx.run,2),reports=new ProductionReportingService(f.db);
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:`TEST-${randomUUID().slice(0,8).toUpperCase()}`,supplierType:'factory',supplierName:'TEST separate logistics factory',address:'TEST',contractEntityName:'TEST',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0002',bankName:'TEST',changeReason:'TEST native factory scopes'}));
  let decision:string;
  await ctx.run(async()=>{
   await reports.report(f.root,r.productionId,{position:1,businessDate:r.day,quantity:4},randomUUID());
   await f.sourcing.requestFactoryChange(f.people['production-management']!,r.caseId,{supplierId:supplier.supplierId,unitPrice:'6',changeReason:'TEST only remaining quantities'},randomUUID());
   const current=(await f.sourcing.getCurrentFactoryChange({...f.root,authorizationCapability:'sourcing:view'},r.caseId)).item!;
   const changed=await f.sourcing.decideFactoryChange(f.people.owner!,r.caseId,current.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST original allocations'},randomUUID());decision=changed.value.decision!.sourcingDecisionId;
   await reports.execute(f.root,r.productionId,'complete',{businessDate:r.day,confirmed:true},randomUUID());await reports.execute(f.root,r.productionId,'ship',{businessDate:r.day,confirmed:true},randomUUID());
  });
  await f.advance(ctx.scene!,'2026-11-25T09:00:00.000Z');await ctx.run(()=>ship({...r,day:'2026-11-25'},decision!,[6,10]));
  const result=await reads(r.id,'two PO transferred factory scopes'),lines=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[r.id])).rows;
  expect(result.factory.currentProduction).toEqual({productionId:r.productionId,factoryDecisionId:decision!});
  const first=result.sla.nodes!.find(n=>n.id===`return_logistics:${lines[0].line_id}`)!,second=result.sla.nodes!.find(n=>n.id===`return_logistics:${lines[1].line_id}`)!;
  expect(first.logisticsWindows).toHaveLength(2);expect(first.logisticsWindows!.map(w=>w.factoryDecisionId)).toEqual([null,decision!]);expect(second.logisticsWindows).toHaveLength(1);expect(second.logisticsWindows![0]!.factoryDecisionId).toBe(decision!);
  expect(first.logisticsWindows![0]!.shippedOn).toBe('2026-11-24');expect(second.logisticsWindows![0]!.shippedOn).toBe('2026-11-25');
  const timeline=await nativeFactoryTimeline(f.db,r.id);
  expect(timeline.map(scope=>({factory:scope.factoryDecisionId,line:scope.lineId,quantity:scope.quantity,day:scope.completedDate}))).toEqual([
   {factory:null,line:lines[0].line_id,quantity:4,day:'2026-11-24'},
   {factory:decision!,line:lines[0].line_id,quantity:6,day:'2026-11-25'},
   {factory:decision!,line:lines[1].line_id,quantity:10,day:'2026-11-25'}
  ]);
  expect(timeline.every(scope=>scope.startTransitionRef&&scope.completionTransitionRef)).toBe(true);
 },testExecutionConfig.correctnessTimeoutMs);
 it('retains received logistics ranges through explicit standard application and later clock observations',async()=>{
  const ctx=await context('2026-11-20T09:00:00.000Z'),r=await prepare(ctx.run);await ctx.run(()=>ship(r));
  await f.advance(ctx.scene!,'2026-11-21T09:00:00.000Z');
  await ctx.run(async()=>{const actor={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};await new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db)).create(actor,{cuttingOrderId:r.cuts[0].cutting_order_id,productionOrderId:r.productionId,factoryDecisionId:null,documentQuantity:10,actualQuantity:10,attachmentIds:[await f.image(actor)]},randomUUID());});
  const before=await reads(r.id,'actual receipt before standard change'),window=before.factory.returnLogistics![0]!,snapshot=await nativeSnapshot();expect(window.hasReceived).toBe(true);
  const client=await f.db.connect();let version:number;
  try{await client.query('BEGIN');const current=await new SlaConfigurationRepository(client).current();const values=structuredClone(current!.values);values.return_logistics={kind:'estimate',minutes:4320};const saved=await new SlaConfigurationService().publishNewStandard(client,f.root,{expectedVersion:current!.version,values,reason:'TEST future standard does not rewrite completed logistics',requestKey:randomUUID()});version=saved.version;await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  expect((await reads(r.id,'global standard only')).factory.returnLogistics![0]).toEqual(window);
  await ctx.run(async()=>{const service=new SlaOrderApplicationService(f.db,'TEST-only-logistics-preview-'.repeat(3)),input={orderId:r.id,configurationVersion:version!,parameterKeys:['return_logistics'],reason:'TEST completed window retained'},preview=await service.preview(f.root,input);await service.apply(f.root,{...input,previewToken:preview.token},randomUUID());});
  await f.advance(ctx.scene!,'2026-12-20T09:00:00.000Z');const after=await reads(r.id,'received retained after application');expect(after.factory.returnLogistics![0]).toEqual(window);expect(after.sla.nodes!.find(n=>n.id.startsWith('return_logistics:'))!.logisticsWindows).toEqual([window]);expect(await nativeSnapshot()).toEqual(snapshot);
 },testExecutionConfig.correctnessTimeoutMs);
 it('does not expose order logistics to an unrelated worker or manufacture missing shipment evidence',async()=>{
  const ctx=await context('2026-11-18T09:00:00.000Z'),r=await prepare(ctx.run);
  await expect(new SlaOrderService(f.db).read(f.people['worker-b']!,r.id)).rejects.toMatchObject({statusCode:404});
  await expect(new DigitalJourneyQuery(f.db).list(f.people['worker-b']!,JourneyFilterSchema.parse({scope:'production'}))).rejects.toMatchObject({statusCode:403});
  const result=await reads(r.id,'missing shipment evidence');
  expect(result.factory.returnLogistics).toEqual([]);for(const node of result.sla.nodes!.filter(n=>n.id.startsWith('return_logistics:'))){expect(node.logisticsWindows).toBeUndefined();expect(node.actualStart).toBeNull();expect(node.forecast.at).toBeNull();}
 },testExecutionConfig.correctnessTimeoutMs);
 it('presentation-only logistics cannot manufacture an application change when every selected node is completed',async()=>{
  const ctx=await context('2026-11-18T09:00:00.000Z'),r=await prepare(ctx.run,1,true);await ctx.run(()=>ship(r));
  const before=await new SlaOrderService(f.db).read(f.root,r.id);expect(before.facts!.sourcing_ie!.businessCompleted).toBe(true);expect(before.nodes!.find(n=>n.id.startsWith('return_logistics:'))!.logisticsWindows).toHaveLength(1);
  const revision=before.current!.revision,snapshot=before.current!.snapshotId,native=await nativeSnapshot(),configuration=await publishAdjustment('sourcing_ie'),state=await applicationSnapshot();
  const service=new SlaOrderApplicationService(f.db,'TEST-only-presentation-boundary-'.repeat(3)),input={orderId:r.id,configurationVersion:configuration.version,parameterKeys:['sourcing_ie'],reason:'TEST already completed IE only'};
  await ctx.run(async()=>{
   const db=await f.db.connect();try{await db.query('BEGIN READ ONLY');const strict=await new SlaOrderService(f.db).readWithClient(f.root,r.id,db);expect(strict.nodes!.every(n=>!n.logisticsWindows)).toBe(true);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
   await expect(service.preview(f.root,input)).rejects.toMatchObject({statusCode:409,message:'所选节点均已完成或不适用，没有未完成节点可调整'});
   await expect(service.apply(f.root,{...input,previewToken:'TEST-no-issued-preview'},randomUUID())).rejects.toMatchObject({statusCode:409,message:'所选节点均已完成或不适用，没有未完成节点可调整'});
  });
  const after=await new SlaOrderService(f.db).read(f.root,r.id);expect(after.current).toMatchObject({revision,snapshotId:snapshot});expect(after.history).toEqual(before.history);expect(after.applications).toEqual(before.applications);expect(await nativeSnapshot()).toEqual(native);expect(await applicationSnapshot()).toEqual(state);
 },testExecutionConfig.correctnessTimeoutMs);
 it('a legitimate unfinished duration adjustment excludes unrelated logistics presentation and still applies normally',async()=>{
  const ctx=await context('2026-11-18T09:00:00.000Z'),r=await prepare(ctx.run,1,true);await ctx.run(()=>ship(r));
  const before=await new SlaOrderService(f.db).read(f.root,r.id),window=before.nodes!.find(n=>n.id.startsWith('return_logistics:'))!.logisticsWindows,configuration=await publishAdjustment('garment_inspection');
  const service=new SlaOrderApplicationService(f.db,'TEST-only-presentation-boundary-'.repeat(3)),input={orderId:r.id,configurationVersion:configuration.version,parameterKeys:['garment_inspection'],reason:'TEST legitimate unfinished quality window'};
  await ctx.run(async()=>{const preview=await service.preview(f.root,input);expect(preview.changes.length).toBeGreaterThan(0);expect(preview.changes.some(c=>c.nodeId.startsWith('return_logistics:'))).toBe(false);expect(preview.changes.some(c=>c.parameterKey==='garment_inspection'&&c.afterMinutes===configuration.minutes)).toBe(true);
   const applied=await service.apply(f.root,{...input,previewToken:preview.token},randomUUID());expect(applied.changedNodes).toBe(preview.changes.length);
  });
  const after=await new SlaOrderService(f.db).read(f.root,r.id);expect(after.current!.revision).toBe(before.current!.revision+1);expect(after.current!.plan.nodes.find(n=>n.parameterKey==='garment_inspection')!.minutes).toBe(configuration.minutes);expect(after.nodes!.find(n=>n.id.startsWith('return_logistics:'))!.logisticsWindows).toEqual(window);expect(after.facts!.sourcing_ie).toMatchObject(before.facts!.sourcing_ie!);
 },testExecutionConfig.correctnessTimeoutMs);
});
