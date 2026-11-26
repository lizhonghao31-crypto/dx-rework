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
import {readPendingReceivingNativeReceipts,receivingFactoryAllocationKey} from '../../apps/api/src/receiving/pending-receiving-native-receipts.js';
import {pendingReceivingForAuthorizedOrders} from '../../apps/api/src/receiving/pending-receiving-original-allocation.js';
import {GarmentQualityService,garmentQuality} from '../../apps/api/src/production-platform/garment-quality.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {readWorkbenchFactoryCommunication} from '../../apps/api/src/production-platform/workbench-factory-communication.js';
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
import {ShipSampleService} from '../../apps/api/src/production-platform/ship-sample-service.js';
import {OperationEventRepository} from '../../apps/api/src/tools/repositories.js';
import {linkDigitalReceipt} from '../../apps/api/src/production-platform/receiving-link-adapter.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';


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
 const prepare=async(run:<T>(work:()=>Promise<T>)=>Promise<T>,poCount=1,withSourcingTodos=false,quantity=10,dispatchParts?:readonly number[])=>run(async()=>{
  const commands=withSourcingTodos?new SourcingService(f.db,undefined,undefined,new TodoProjectionService(new TodoService(f.db)),f.contracts):f.sourcing;
  const r=await f.bulkReady('无',undefined,poCount,commands,{quantity}),cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[r.caseId])).rows;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of cuts)await r.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:quantity,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db);
  for(const part of dispatchParts??[null]){
   const state=await flow.read(f.root,r.id);
   await flow.dispatch(f.people.warehouse!,r.id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST date-only logistics',
    ...(part===null?{}:{lines:[{lineId:state.lines[0]!.lineId,quantity:part}]})},randomUUID());
  }
  const productionId=(await f.db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1',[r.caseId])).rows[0]?.production_order_id as string;
  if(!productionId&&dispatchParts?.length!==0)throw Error('TEST original production should exist after dispatch');
  return {...r,productionId,cuts,day:beijingCalendarDate(businessNow())};
 });
 let sundayScene:string,sundayReady:Awaited<ReturnType<typeof prepare>>;
 beforeAll(async()=>{sundayScene=await f.scene('2026-12-06T05:00:00.000Z');sundayReady=await prepare(work=>f.runtime.run(sundayScene,f.root,work));},120000);
 it('reads the exact assigned process communication in the workbench without moving any cut pieces',async()=>{
  const scene=await f.scene('2026-11-20T05:00:00Z');
  await f.runtime.run(scene,f.root,async()=>{
   const original=await f.bulkReady('印花'),cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[original.caseId])).rows[0]!;
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await original.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   const flow=new FactoryFlowService(f.db),existing=await flow.read(f.root,original.id),task=existing.tasks.find(row=>row.taskKind==='process_logistics')!;
   const operator=Object.values(f.people).find(person=>person.actorId!==f.root.actorId&&person.actorRoles.includes(task.requiredRole))!;
   await new DigitalProductionTaskService(f.db).reassign(f.root,task.taskId,operator.actorId,randomUUID());
   const scope={orderId:original.id,preparationId:existing.preparationId!,taskId:task.taskId,stepRef:task.stepRef??null};
   const before=await readWorkbenchFactoryCommunication(flow,operator,scope);expect(before).toMatchObject({canRecord:true,facts:[]});
   const note='TEST 实际工艺沟通，不产生实物出入库',at=businessNow().toISOString();
   await flow.logistics(operator,original.id,{expectedRevision:before.expectedRevision,kind:'工艺沟通',note,occurredAt:at,supplier:'TEST 工艺厂',
    ...(scope.stepRef?{stepRef:scope.stepRef}:{})},randomUUID());
   const result=await readWorkbenchFactoryCommunication(flow,operator,scope);
   expect(result).toMatchObject({scope,facts:[{note,occurredAt:at,supplier:'TEST 工艺厂'}]});
   await expect(readWorkbenchFactoryCommunication(flow,operator,{...scope,taskId:randomUUID()})).rejects.toMatchObject({statusCode:404});
   await expect(readWorkbenchFactoryCommunication(flow,operator,{...scope,preparationId:randomUUID()})).rejects.toMatchObject({statusCode:404});
   expect((await flow.read(operator,original.id)).facts.map(row=>row.kind)).toEqual(['工艺沟通']);
   const merch={...f.people.merchandiser!,authorizationCapability:'todo:view',authorizationCapabilities:['todo:view']};
   const todos=new TodoService(f.db),search=(await f.db.query('SELECT design_style_no FROM digital_production_orders WHERE production_order_id=$1',[original.id])).rows[0].design_style_no;
   const waiting=await todos.merchandiserActionPage(merch,{state:'waiting',search,page:1});
   expect(waiting.items).toContainEqual(expect.objectContaining({state:'waiting',itemId:task.taskId,route:{routeName:'digital_production_task',entityId:task.taskId,todoId:task.taskId},responsibleName:expect.any(String)}));
   const byOrder=await todos.merchandiserActionPage(merch,{state:'waiting',search:original.id,page:1});
   expect(byOrder.items).toContainEqual(expect.objectContaining({itemId:task.taskId,originalOrderId:original.id,orderNumber:null,styleNo:search}));
   const wrong={...f.people.warehouse!,authorizationCapability:'todo:view',authorizationCapabilities:['todo:view']};
   await expect(todos.merchandiserActionPage(wrong,{state:'waiting',search,page:1})).rejects.toMatchObject({statusCode:403});
   const previous=await todos.merchandiserActionPage(merch,{state:'completed',kind:'delivery',search,page:1});
   expect(previous).toEqual({page:1,items:[],total:0});
   const shipSample=new ShipSampleService(f.db);
   await shipSample.record(merch,original.id,{occurredAt:at,trackingNumber:'TEST-SAMPLE-FOLLOWUP',note:'TEST original parcel for all POs'},randomUUID());
   const shipped=(await f.db.query("SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_ship_sample'",[original.id])).rows[0].task_id;
   const completed={page:1,total:1,items:[{itemId:shipped,state:'completed',route:{entityId:shipped},originalOrderId:original.id,orderNumber:null,styleNo:search}]};
   expect(await todos.merchandiserActionPage(merch,{state:'completed',kind:'delivery',search,page:1})).toMatchObject(completed);
   expect(await todos.merchandiserActionPage(merch,{state:'completed',kind:'delivery',search:original.id,page:1})).toMatchObject(completed);
   expect((await todos.merchandiserActionPage(merch,{state:'waiting',search,page:1})).items.map(row=>row.itemId)).not.toContain(shipped);
  });
 });
 it('does not treat earlier native factory QC as production completion',async()=>f.runtime.run(sundayScene,f.root,async()=>{
  const factory=new FactoryFlowService(f.db),dispatched=await factory.read(f.root,sundayReady.id),lineId=dispatched.batchTotals![0]!.lineId;
  await factory.productionQc(f.root,sundayReady.id,{expectedRevision:dispatched.revision,factoryDecisionId:null,occurredAt:businessNow().toISOString(),checks:[{lineId,result:'合格',problem:''}],note:'TEST QC before native production completion'},randomUUID());
  const before=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'order',id:sundayReady.id,range:'delivery'}});
  expect(before.context.graph.anchors[`${lineId}/factory_production_finished`]).toBeUndefined();expect(before.current.rows.find(n=>n.id===`${lineId}/factory_finished`)!.end.at).toBeNull();
  const timeline=await nativeFactoryTimeline(f.db,sundayReady.id);
  expect(timeline).toHaveLength(1);expect(timeline[0]).toMatchObject({lineId,completedDate:null,completionTransitionRef:null});
  const factoryName=(await f.db.query('SELECT supplier_name_snapshot FROM sourcing_production_factory_orders WHERE production_order_id=$1',[sundayReady.productionId])).rows[0]?.supplier_name_snapshot;
  expect(factoryName).toEqual(expect.any(String));
  const merch={...f.people.merchandiser!,authorizationCapability:'todo:view',authorizationCapabilities:['todo:view','sourcing:view']};
  const orders=new TodoService(f.db);
  expect(await orders.merchandiserOrderPage(merch,{search:factoryName,page:1})).toMatchObject({total:1,items:[{id:sundayReady.id,factories:[factoryName]}]});
  expect(await orders.merchandiserOrderPage({...merch,authorizationCapabilities:['todo:view']},{search:factoryName,page:1})).toEqual({items:[],page:1,total:0});
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
  const ctx=await context('2026-11-24T09:00:00.000Z'),r=await prepare(ctx.run,1,false,1000,[200,300]);
  const supplier=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:`TEST-${randomUUID().slice(0,8).toUpperCase()}`,supplierType:'factory',supplierName:'TEST nonpilot transfer factory',address:'TEST',contractEntityName:'TEST',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0002',bankName:'TEST',changeReason:'TEST receipt factory isolation'}));
  await ctx.run(async()=>{
   const closure=new ProductionClosureService(f.db),reports=new ProductionReportingService(f.db),receiver={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},service=new ReceivingService(f.db,undefined,undefined,closure);
   await closure.setPilot(f.root,{supplierId:f.supplierId,enabled:false});
   await reports.report(f.root,r.productionId,{position:1,businessDate:r.day,quantity:500},randomUUID());
   await f.sourcing.requestFactoryChange(f.people['production-management']!,r.caseId,{supplierId:supplier.supplierId,unitPrice:'6',changeReason:'TEST transfer remaining 500'},randomUUID());
   const request=(await f.sourcing.getCurrentFactoryChange({...f.root,authorizationCapability:'sourcing:view'},r.caseId)).item!;
   const changed=await f.sourcing.decideFactoryChange(f.people.owner!,r.caseId,request.factoryChangeRequestId,{decision:'approved',verificationReason:'TEST receipt split scope'},randomUUID()),factoryDecisionId=changed.value.decision!.sourcingDecisionId;
   await reports.execute(f.root,r.productionId,'complete',{factoryDecisionId:null,businessDate:r.day,confirmed:true},randomUUID());
   await reports.execute(f.root,r.productionId,'ship',{factoryDecisionId:null,businessDate:r.day,confirmed:true},randomUUID());
   const flow=new FactoryFlowService(f.db),currentFactory=await flow.read(f.root,r.id);
   await flow.dispatch(f.people.warehouse!,r.id,{expectedRevision:currentFactory.revision,occurredAt:businessNow().toISOString(),supplierId:supplier.supplierId,note:'TEST factory B own dispatch',
    lines:[{lineId:currentFactory.lines[0]!.lineId,quantity:500}]},randomUUID());
   await ship(r,factoryDecisionId,[500]);
   expect((await closure.expected(receiver,{cuttingOrderId:r.cuts[0].cutting_order_id})).items.map(row=>row.factoryDecisionId)).toEqual(expect.arrayContaining([null,factoryDecisionId]));
   const body={cuttingOrderId:r.cuts[0].cutting_order_id,documentQuantity:280,actualQuantity:280,attachmentIds:[await f.image(receiver)]};
   await expect(service.create(receiver,body,randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(service.create(receiver,{...body,productionOrderId:r.productionId,factoryDecisionId:randomUUID()},randomUUID())).rejects.toMatchObject({statusCode:409});
   expect((await f.db.query('SELECT 1 FROM sourcing_production_receipt_links WHERE production_order_id=$1',[r.productionId])).rowCount).toBe(0);
   const firstBalance=await pendingReceivingForAuthorizedOrders(f.db,[r.id]);
   const list=await service.pending(receiver,{page:1,search:currentFactory.lines[0]!.poNumber,status:'open'});
   expect(list.total).toBe(2);
   const aScope=list.items.find(row=>row.factoryDecisionId===null)!,bScope=list.items.find(row=>row.factoryDecisionId===factoryDecisionId)!;
   await expect(service.pending(f.people['cutting-worker']!,{page:1,search:'',status:'all'})).rejects.toMatchObject({statusCode:403});
   const chosen=await service.pendingSelection(receiver,aScope.id);
   expect(chosen).toMatchObject({orderId:r.id,cuttingOrderId:body.cuttingOrderId,factoryDecisionId:null,remaining:500,receivingBatchId:null});
   await expect(service.create(receiver,{...body,productionOrderId:r.productionId,factoryDecisionId,pendingAllocation:aScope.id},randomUUID())).rejects.toMatchObject({statusCode:409});
   const payload={...body,productionOrderId:r.productionId,factoryDecisionId:null,pendingAllocation:aScope.id},key=randomUUID();
   const original=await service.create(receiver,payload,key);
   await expect(service.create(receiver,payload,key)).resolves.toMatchObject({reused:true,value:{receiptId:original.value.receiptId}});
   await expect(service.create(receiver,payload,randomUUID())).rejects.toMatchObject({statusCode:409});
   const received=await pendingReceivingForAuthorizedOrders(f.db,[r.id]);
   const a=received.find(row=>row.factoryDecisionId===null),b=received.find(row=>row.factoryDecisionId===factoryDecisionId);
   expect(a).toMatchObject({expectedQuantity:500,balance:{actualDispatched:500,received:280,remaining:220,
    receipts:[{receiptId:original.value.receiptId,actualQuantity:280}]}});
   expect(a!.balance.dispatches.map(row=>row.dispatchedQuantity).sort((left,right)=>left-right)).toEqual([200,300]);
   expect(a!.balance.receipts[0]).not.toHaveProperty('dispatchFactId');
   expect(b).toMatchObject({expectedQuantity:500,balance:{actualDispatched:500,received:0,remaining:500}});
   expect(b).toEqual(firstBalance.find(row=>row.factoryDecisionId===factoryDecisionId));
   const selectionB=await service.pendingSelection(receiver,bScope.id);
   expect(selectionB).toMatchObject({receivingBatchId:original.value.receivingBatchId,factoryDecisionId,remaining:500});
   const current=await service.createRepeated(receiver,{cuttingOrderId:r.cuts[0].cutting_order_id,receivingBatchId:original.value.receivingBatchId,source:'other_factory',documentQuantity:100,actualQuantity:100,productionOrderId:r.productionId,factoryDecisionId,pendingAllocation:bScope.id},randomUUID());
   expect((await closure.receiptSummary(f.root,r.productionId,null)).shipment?.receipts.map(row=>row.receiptId)).toEqual([original.value.receiptId]);
   expect((await closure.receiptSummary(f.root,r.productionId,factoryDecisionId)).shipment?.receipts.map(row=>row.receiptId)).toEqual([current.value.receiptId]);
   const exact=(await readPendingReceivingNativeReceipts(f.db,[r.id])).get(r.id)!;
   expect(exact).toHaveLength(2);
   expect(exact.find(row=>row.receiptId===original.value.receiptId)?.identity).toMatchObject({productionId:r.productionId,
    cuttingOrderId:r.cuts[0].cutting_order_id,factoryAllocationKey:receivingFactoryAllocationKey(r.productionId,null)});
   expect(exact.find(row=>row.receiptId===current.value.receiptId)?.identity).toMatchObject({productionId:r.productionId,
    cuttingOrderId:r.cuts[0].cutting_order_id,factoryAllocationKey:receivingFactoryAllocationKey(r.productionId,factoryDecisionId)});
   const receiveA=original.value.receiptId,receiveB=current.value.receiptId,quality=new GarmentQualityService(f.db);
   const inspections=()=>garmentQuality(f.db,r.id);
   const initial=(await inspections()).find(row=>row.receiptId===receiveA)!;
   const qc={receiptId:receiveA,quantityVersion:initial.quantityVersion,qualifiedQuantity:280,problem:'',occurredAt:businessNow().toISOString()};
   await quality.record(f.root,r.id,qc,randomUUID());
   expect((await inspections()).find(row=>row.receiptId===receiveA)).toMatchObject({inspected:true,quantity:280});
   const bBefore=(await inspections()).find(row=>row.receiptId===receiveB),version=Number((await f.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[original.value.receivingBatchId])).rows[0].version);
   await service.correctReceipt({...f.root,authorizationCapability:'receiving:correct',authorizationCapabilities:['receiving:correct']},receiveA,{expectedVersion:version,documentQuantity:280,actualQuantity:275,defectiveQuantity:0});
   const revised=(await inspections()).find(row=>row.receiptId===receiveA)!;
   expect(revised).toMatchObject({quantity:275,inspected:false,priorInspection:true});
   expect(revised.quantityVersion).not.toBe(qc.quantityVersion);
   expect((await inspections()).find(row=>row.receiptId===receiveB)).toEqual(bBefore);
   await expect(quality.record(f.root,r.id,qc,randomUUID())).rejects.toMatchObject({statusCode:409});
   await quality.record(f.root,r.id,{...qc,quantityVersion:revised.quantityVersion,qualifiedQuantity:275},randomUUID());
   expect((await inspections()).find(row=>row.receiptId===receiveA)).toMatchObject({quantity:275,inspected:true,quantityVersion:revised.quantityVersion});
  });
 });
 it('Acceptance R5 rejects the original no-selection receiving route before native dispatch and shipment',async()=>{
  const ctx=await context('2026-11-25T09:00:00.000Z'),r=await prepare(ctx.run,1,false,500,[]);
  // This isolated WIP fixture deliberately starts from an existing old
  // logistics setup. Declare the exact new-chain adoption marker before
  // exercising R5, without inventing any dispatch or factory return.
  await f.db.query('UPDATE digital_production_orders SET order_time_managed=true WHERE production_order_id=$1',[r.id]);
  await ctx.run(async()=>{
   const closure=new ProductionClosureService(f.db),service=new ReceivingService(f.db,undefined,undefined,closure,{allowLegacyStyleInput:true});
   const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
   const cut=r.cuts[0].cutting_order_id as string;
   const style=(await f.db.query('SELECT formal_style_no FROM current_cutting_style_options WHERE cutting_order_id=$1',[cut])).rows[0]!.formal_style_no;
   const body={documentQuantity:280,actualQuantity:280,attachmentIds:[await f.image(warehouse)]};
   const counts=async()=>(await f.db.query(`SELECT (SELECT count(*)::int FROM receiving_receipts WHERE cutting_order_id=$1) AS receipts,
    (SELECT count(*)::int FROM sourcing_production_receipt_links JOIN receiving_receipts USING(receipt_id) WHERE cutting_order_id=$1) AS links`,[cut])).rows[0];
   await expect(service.create(warehouse,{...body,styleNo:style},randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(service.create(warehouse,{...body,cuttingOrderId:cut},randomUUID())).rejects.toMatchObject({statusCode:409});
   expect(await counts()).toEqual({receipts:0,links:0});
   const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,r.id);
   await flow.dispatch(warehouse,r.id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST native actual dispatch'},randomUUID());
   await expect(service.create(warehouse,{...body,cuttingOrderId:cut},randomUUID())).rejects.toMatchObject({statusCode:409});
   expect(await counts()).toEqual({receipts:0,links:0});
   const productionId=(await flow.read(f.root,r.id)).currentProduction!.productionId;
   await ship({productionId,day:r.day},null,[500]);
   const receipt=await service.create(warehouse,{...body,cuttingOrderId:cut,productionOrderId:productionId,factoryDecisionId:null},randomUUID());
   expect(await counts()).toEqual({receipts:1,links:1});
   expect(await pendingReceivingForAuthorizedOrders(f.db,[r.id])).toMatchObject([{balance:{received:280,remaining:220}}]);
   const pending=await service.pending(warehouse,{page:1,search:'',status:'open'});
   expect(pending.items).toContainEqual(expect.objectContaining({identity:expect.objectContaining({orderId:r.id}),balance:expect.objectContaining({received:280,remaining:220})}));
   const update={cuttingOrderId:cut,receivingBatchId:receipt.value.receivingBatchId,source:'jiashun' as const,actualQuantity:220};
   await expect(service.createRepeated(warehouse,{...update,productionOrderId:productionId,factoryDecisionId:randomUUID()},randomUUID())).rejects.toMatchObject({statusCode:409});
   const last=await service.createRepeated(warehouse,{...update,productionOrderId:productionId,factoryDecisionId:null},randomUUID());
   expect(await counts()).toEqual({receipts:2,links:2});
   expect((await garmentQuality(f.db,r.id)).map(row=>row.receiptId).sort()).toEqual([receipt.value.receiptId,last.value.receiptId].sort());
   expect((await service.pending(warehouse,{page:1,search:'',status:'collected'})).items.find(item=>item.identity.orderId===r.id)?.balance)
    .toMatchObject({received:500,remaining:0});
  });
 },testExecutionConfig.correctnessTimeoutMs);
 it('Acceptance R5 shows a historical premature receipt as pending proof on both original views without adopting it',async()=>{
  const ctx=await context('2026-11-25T09:00:00.000Z'),r=await prepare(ctx.run,1,false,500,[]);
  await f.db.query('UPDATE digital_production_orders SET order_time_managed=true WHERE production_order_id=$1',[r.id]);
  await ctx.run(async()=>{
   const production=new ProductionClosureService(f.db),service=new ReceivingService(f.db,undefined,undefined,production,{allowLegacyStyleInput:true});
   const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
   const cut=r.cuts[0]!.cutting_order_id as string,receiptId=randomUUID(),batchId=randomUUID();
   const style=(await f.db.query('SELECT formal_style_no FROM current_cutting_style_options WHERE cutting_order_id=$1',[cut])).rows[0]!.formal_style_no;
   // In this disposable historical fixture, reproduce the original ledger
   // transaction as it was before admission, with all original DB guards on.
   // There is no shipment, dispatch or inferred production relation.
   const db=await f.db.connect();
   try{
    await db.query('BEGIN');
    await db.query('INSERT INTO receiving_batches(receiving_batch_id,style_no,cutting_order_id,created_by,delivery_note_quantity) VALUES($1,$2,$3,$4,280)',[batchId,style,cut,warehouse.actorId]);
    const event=await new OperationEventRepository().append(db,warehouse,{action:'receiving.receipt.create',entityType:'receiving_receipt',
     entityId:receiptId,after:{receivingBatchId:batchId,cuttingOrderId:cut,styleNo:style,documentQuantity:280,actualQuantity:280,defectiveQuantity:0}});
    await db.query("SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",[event,warehouse.requestId]);
    await db.query(`INSERT INTO receiving_receipts(receipt_id,receiving_batch_id,cutting_order_id,style_no,document_quantity,actual_quantity,
      defective_quantity,receiving_source,received_by,operation_event_id,request_id,received_at) VALUES($1,$2,$3,$4,280,280,0,'initial',$5,$6,$7,$8)`,
     [receiptId,batchId,cut,style,warehouse.actorId,event,warehouse.requestId,businessNow().toISOString()]);
    expect(await linkDigitalReceipt(db,receiptId,batchId)).toMatchObject({id:r.id});
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
   const original=async()=>(await f.db.query('SELECT to_jsonb(r) AS receipt FROM receiving_receipts r WHERE receipt_id=$1',[receiptId])).rows[0]!.receipt;
   const untouched=await original(),closure=new OrderClosureService(f.db);
   const legacy=await service.board(r.day,r.day,style);
   const originalRow=legacy.rows.find(row=>row.receivingBatchId===batchId)!;
   expect(originalRow).toMatchObject({currentActualQuantity:280,
    nativeQualification:{effectiveQuantity:null,pendingReceiptCount:1},
    receivingHistory:[{receiptId,actualQuantity:280,pendingQualification:'原裁单、PO或工厂执行关联待核'}]});
   const formal=await closure.read(f.root,r.id);
   expect(formal.lines).toMatchObject([{actualQuantity:0,receivingBatchId:batchId,
    receivingExceptions:[{receiptId,quantityVersion:receiptId,quantity:280,reason:'原裁单、PO或工厂执行关联待核'}]}]);
   expect(await garmentQuality(f.db,r.id)).toEqual([]);
   expect((await new DigitalProductionTaskService(f.db).qualityDirectory(f.root,'garment',{kind:'garment',status:'open',page:1,search:style})).items)
    .not.toContainEqual(expect.objectContaining({id:receiptId}));
   expect(await closure.cockpitReceipts.read(f.root,r.id)).toMatchObject({status:'数量待核',totals:{received:null},
    lines:[{status:'实收待核',pendingQualification:[{receiptId,quantity:280}]}]});
   await expect(service.recordPacking({...f.root,authorizationCapability:'receiving:packing_manage'},{
    receivingBatchId:batchId,expectedVersion:originalRow.version,expectedPackingRevisionId:null,packingQuantity:280,
   },randomUUID())).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('待核')});
   await expect(service.resolveDifference({...f.root,authorizationCapability:'receiving:resolve_difference'},{
    receivingBatchId:batchId,expectedVersion:originalRow.version,expectedPackingRevisionId:null,expectedActualQuantity:280,
    expectedDocumentQuantity:280,differenceType:'receiving',result:'TEST 原签收仍不能作为正式回货',
   },randomUUID())).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('待核')});
   const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,r.id);
   await flow.dispatch(warehouse,r.id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST later real dispatch'},randomUUID());
   const productionId=(await flow.read(f.root,r.id)).currentProduction!.productionId;
   await ship({productionId,day:r.day},null,[500]);
   expect(await pendingReceivingForAuthorizedOrders(f.db,[r.id])).toMatchObject([{balance:{status:'unresolved',received:null,provenReceived:0,
    receipts:[]}}]);
   expect(await original()).toEqual(untouched);
   expect((await f.db.query('SELECT receipt_id FROM sourcing_production_receipt_links WHERE receipt_id=$1',[receiptId])).rowCount).toBe(0);
  });
 },testExecutionConfig.correctnessTimeoutMs);
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
