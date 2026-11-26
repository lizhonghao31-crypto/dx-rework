import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {craftStepIdentity} from '@dx-rework/contracts/digital-craft';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {ProductionClosureService} from '../../apps/api/src/sourcing/production-closure-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {SpecialCraftLibraryService} from '../../apps/api/src/production-platform/special-craft-library.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {MemberModuleBindingService} from '../../apps/api/src/access/member-module-binding-service.js';
import {readQualityWarehouseCraftOccupation} from '../../apps/api/src/production-platform/quality-warehouse-craft-occupation.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original quality rework through the normal server',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-native-quality-routes-')),{fullApp:true});configureTimelineAdoption(h.db,'fixed_v2');});
 afterAll(async()=>{if(h){try{await h.writeEvidence();}finally{await h.dispose();}}});
 it.each([false,true])('opens exact garment QC rework through normal API startup (second batch: %s)',async(secondBatch)=>{
  const f=h.f,order=await f.bulkReady('无',undefined,1,f.sourcing,{quantity:500}),qc=f.people.qc!,warehouse=f.people.warehouse!;
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[order.caseId])).rows[0]!.cutting_order_id;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await order.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:500,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),before=await flow.read(f.root,order.id),now=businessNow().toISOString(),day=beijingCalendarDate(businessNow());
  await flow.dispatch(warehouse,order.id,{expectedRevision:before.revision,supplierId:f.supplierId,occurredAt:now,note:'TEST original dispatch'},randomUUID());
  const sent=await flow.read(f.root,order.id),production=sent.productionId!,line=sent.lines[0]!,task=sent.tasks.find(row=>row.taskKind==='factory_production_qc')!;
  await new DigitalProductionTaskService(f.db).reassign(f.root,task.taskId,qc.actorId,randomUUID());
  const reports=new ProductionReportingService(f.db);
  await reports.report(f.root,production,{position:1,businessDate:day,quantity:500},randomUUID());
  await reports.execute(f.root,production,'complete',{businessDate:day,confirmed:true},randomUUID());
  await reports.execute(f.root,production,'ship',{businessDate:day,confirmed:true},randomUUID());
  const receiving=new ReceivingService(f.db,undefined,undefined,new ProductionClosureService(f.db)),closure=new OrderClosureService(f.db);
  const receiver={...warehouse,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  const receipt=(await receiving.create(receiver,{cuttingOrderId:cut,productionOrderId:production,factoryDecisionId:null,documentQuantity:280,actualQuantity:280,attachmentIds:[await f.image(receiver)]},randomUUID())).value;
  const record=async(receiptId:string,qualifiedQuantity:number,problem:string)=>closure.recordQuality(qc,order.id,{receiptId,quantityVersion:receiptId,qualifiedQuantity,problem,timeMode:'now'},randomUUID());
  const checked=await record(receipt.receiptId,260,'TEST original twenty affected garments');
  let rest:Awaited<ReturnType<typeof record>>|undefined;
  if(secondBatch){
   const other=(await receiving.createRepeated(receiver,{receivingBatchId:receipt.receivingBatchId,cuttingOrderId:cut,productionOrderId:production,factoryDecisionId:null,source:'other_factory',documentQuantity:220,actualQuantity:220},randomUUID())).value;
   rest=await record(other.receiptId,220,'');
   const version=(await f.db.query('SELECT version FROM receiving_batches WHERE receiving_batch_id=$1',[receipt.receivingBatchId])).rows[0]!.version;
   await receiving.recordPacking({...f.root,authorizationCapability:'receiving:packing_manage'},
    {receivingBatchId:receipt.receivingBatchId,expectedVersion:version,expectedPackingRevisionId:null,packingQuantity:480,packingTime:{mode:'now'},
     packingAllocations:[{receiptId:receipt.receiptId,quantityVersion:receipt.receiptId,quantity:260,packingTime:{mode:'now'}},{receiptId:other.receiptId,quantityVersion:other.receiptId,quantity:220,packingTime:{mode:'now'}}]},randomUUID());
  }
  const facts=async()=>{
   const live=await closure.read(f.root,order.id);
   return {receipts:live.quality.map(row=>[row.receiptId,row.eventId,row.quantity,row.qualifiedQuantity]),
    intake:live.lines.map(row=>[row.actualQuantity,row.packingQuantity,row.packingAllocations]),factory:(await flow.read(f.root,order.id)).productionChecks};
  };
  const preserved=await facts();
  expect(preserved.intake[0]?.slice(0,2)).toEqual([secondBatch?500:280,secondBatch?480:0]);
  expect(preserved.receipts.map(row=>row.slice(2)).sort()).toEqual((secondBatch?[[280,260],[220,220]]:[[280,260]]).sort());
  const path='/api/rework-orders/garment-quality/drafts',body={orderId:order.id,receiptId:receipt.receiptId,quantityVersion:receipt.receiptId,eventId:checked.eventId};
  const directory=`/ui/digital-production?workspace=quality&kind=garment&status=completed&search=${encodeURIComponent(task.identity!.designStyleNo)}`;
  const tab=await h.open(qc.actorId,1165,{},directory,true);
  try{
   const entry=tab.page.getByRole('row').filter({hasText:'280 件'}).getByRole('link',{name:'查看原检查',exact:true});
   await entry.click();
   expect(new URL(tab.page.url()).searchParams.get('qualityReceipt')).toBe(receipt.receiptId);
   const inspect=tab.page.getByRole('region',{name:'本批成衣原返工',exact:true});
   const native=tab.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===path);
   await inspect.getByRole('button',{name:'按本批问题发起返工',exact:true}).click();
   const result=await native;expect(result.status(),await result.text()).toBe(201);
   expect(result.request().postDataJSON()).toEqual(body);
   const key=result.request().headers()['idempotency-key']!,draft=await result.json();
   expect(draft).toMatchObject({receivingBatchId:receipt.receivingBatchId,reworkQuantity:20,status:'draft'});
   const detail=inspect.getByRole('link',{name:'查看原成衣返工单',exact:true});await detail.waitFor();
   const href=await detail.getAttribute('href');expect(href).toContain(`/ui/tasks/${draft.reworkOrderId}`);
   const post=(data:typeof body,idempotencyKey=randomUUID())=>tab.context.request.post(h.base+path,{headers:{'idempotency-key':idempotencyKey},data});
   const replay=await post(body,key);expect(replay.status()).toBe(201);expect(replay.headers()['idempotency-replayed']).toBe('true');
   expect((await replay.json()).reworkOrderId).toBe(draft.reworkOrderId);
   const duplicates=await Promise.all([post(body),post(body)]);
   for(const response of duplicates){expect(response.status()).toBe(201);expect((await response.json()).reworkOrderId).toBe(draft.reworkOrderId);}
   expect((await post({...body,eventId:randomUUID()},key)).status()).toBe(409);
   expect((await post({...body,quantityVersion:randomUUID()})).status()).toBe(409);
   if(rest)expect((await post({...body,receiptId:rest.receiptId,quantityVersion:rest.receiptId,eventId:rest.eventId})).status()).toBe(409);
   const links=(await f.db.query(`SELECT r.rework_order_id,r.source_garment_qc_event_id,r.source_receiving_batch_id,l.line_id
    FROM rework_orders r JOIN digital_production_child_lines l ON l.child_id=r.rework_order_id AND l.module='rework'
    WHERE l.production_order_id=$1`,[order.id])).rows;
   expect(links).toEqual([{rework_order_id:draft.reworkOrderId,source_garment_qc_event_id:checked.eventId,source_receiving_batch_id:receipt.receivingBatchId,line_id:line.lineId}]);
   expect(await facts()).toEqual(preserved);
   await tab.page.getByRole('button',{name:'返回来源',exact:true}).click();await entry.waitFor();
   expect(new URL(tab.page.url()).searchParams.get('search')).toBe(task.identity!.designStyleNo);
  }finally{await tab.close();}
  if(!secondBatch){
   const denied=await h.open(warehouse.actorId,1165,{},'/ui/my-tasks',true);
   try{expect((await denied.context.request.post(h.base+path,{headers:{'idempotency-key':randomUUID()},data:body})).status()).toBe(403);}
   finally{await denied.close();}
   const qcCapability=await h.dedicated('quality_control','TEST normal exact source revoke');
   await f.access.assignRole(h.admin,{userId:qcCapability.id,roleCode:'finance_read',reason:'TEST keep identity through QC revocation'});
   const originalScope=await h.open(qcCapability.id,1165,{},'/ui/my-tasks',true);
   try{
    await f.access.revokeRole(h.admin,qcCapability.assignmentId,'TEST same-cookie exact quality withdrawal');
    const withoutRole=await originalScope.context.request.post(h.base+path,{headers:{'idempotency-key':randomUUID()},data:body});
    expect(withoutRole.status()).toBe(403);
   }finally{await originalScope.close();}
  }
 });
 it('opens original craft rework and keeps the exact physical QC scope and admission on normal startup',async()=>{
  const f=h.f,warehouse=f.people.warehouse!,qc=f.people.qc!,maker=f.people['pattern-room-worker']!,owner=f.people.owner!,quantity=100;
  const approver=await h.dedicated('owner_group','TEST exact craft approver');
  await f.access.ensureOrganizationPolicy();
  await new MemberModuleBindingService(f.db).run(f.root.actorId,{li_zhonghao:owner.actorId,wu_yunfeng:approver.id,li_junyue:f.root.actorId},true);
  const name='TEST original craft routing',rule={minutes:120,calendar:'continuous' as const,reminder:{enabled:false,percent:70}};
  const special=await new SpecialCraftLibraryService(f.db).save(f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:rule,bulk:rule}},randomUUID());
  const craftStep={craftKind:'special' as const,sequence:1,specialCraft:special},order=await f.bulkReady('特殊工艺',undefined,1,f.sourcing,{quantity,craftSteps:[craftStep]});
  // Initial quotation assembly/assignment is fixture setup; all later supplier,
  // approval, warehouse motion, QC and original draft commands are native.
  const rowId=randomUUID(),quote=(await f.db.query('SELECT document,assignments FROM digital_quotation_documents WHERE production_order_id=$1',[order.id])).rows[0]!;
  const existing=Object.fromEntries(quote.document.rows.map((row:{rowId:string})=>[row.rowId,{kind:'material',stage:'development',sourceRef:row.rowId}]));
  await f.db.query('UPDATE digital_quotation_documents SET assembly=$2,document=$3,assignments=$4 WHERE production_order_id=$1',[order.id,
   JSON.stringify({schemaVersion:1,sourceVersion:1,roundNumber:1,fingerprint:'TEST native draft startup basis',rows:{...existing,[rowId]:{kind:'craft',stage:'bulk',sourceRef:`craft:bulk:${craftStepIdentity(craftStep)}`,craftRef:{libraryId:special.id,libraryVersion:special.version}}}}),
   JSON.stringify({...quote.document,rows:[...quote.document.rows,{rowId,section:'外发工序',category:'工艺',name,specification:'TEST',unit:'件',supplier:'',consumption:'1',unitPrice:null}]}),
   JSON.stringify([...quote.assignments,{rowId,technicalAssigneeId:null,priceAssigneeId:maker.actorId,priceRole:'pattern_room_worker'}])]);
  const quotes=new DigitalQuotationService(f.db,true),scope={kind:'order' as const,id:order.id};
  await quotes.writeSecondaryCraft(maker,scope,rowId,'submit',{mode:'outsourced',supplierId:f.supplierId,expectedVersion:0,applicableQuantity:String(quantity),unit:'件',unitPrice:'2',attachmentIds:[],note:'TEST original authorized craft quote'},randomUUID());
  await quotes.writeSecondaryCraft({...owner,actorId:approver.id},scope,rowId,'decision',{expectedVersion:1,decision:'approved'},randomUUID());
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[order.caseId])).rows[0]!.cutting_order_id;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await order.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:quantity,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db,readQualityWarehouseCraftOccupation),initial=await flow.read(f.root,order.id),step=initial.craftSteps![0]!,lineId=initial.lines[0]!.lineId;
  const logistics=initial.tasks.find(task=>task.taskKind==='process_logistics'&&task.stepRef===step.stepId)!;
  const motion={preparationId:order.preparationId,taskId:logistics.taskId,stepRef:step.stepId,factoryId:f.supplierId,lines:[{lineId,quantity}],occurredAt:businessNow().toISOString(),note:'TEST original returned craft pieces'};
  const sent=await flow.warehouseCraftMotion(warehouse,order.id,{...motion,kind:'send',sourceFactId:null,expectedRevision:initial.revision},randomUUID());
  const sendFact=sent.facts.find(fact=>fact.kind==='工艺发出')!;
  const returned=await flow.warehouseCraftMotion(warehouse,order.id,{...motion,kind:'return',sourceFactId:sendFact.factId,expectedRevision:sent.revision},randomUUID());
  const returnedFact=returned.facts.find(fact=>fact.kind==='工艺回仓')!,quality=(await flow.read(f.root,order.id)).tasks.find(task=>task.taskKind==='bulk_qc'&&task.stepRef===step.stepId)!;
  await new DigitalProductionTaskService(f.db).reassign(f.root,quality.taskId,qc.actorId,randomUUID());
  const checked=await flow.qc(qc,order.id,{expectedRevision:(await flow.read(f.root,order.id)).revision,stepRef:step.stepId,returnFactId:returnedFact.factId,note:'TEST original partial failure',
   checks:[{lineId,result:'需处理',problem:'TEST twenty affected pieces',treatment:'',attachmentIds:[],quantityScope:{inspectedQuantity:quantity,qualifiedQuantity:80,problemQuantity:20,unit:'片'}}]},randomUUID());
  const proof=checked.checks.find(row=>row.returnFactId===returnedFact.factId)!;
  const snapshot=async()=>{
   const detail=await flow.read(f.root,order.id);
   return {facts:detail.facts,checks:detail.checks,release:detail.batches?.find(batch=>batch.factId===returnedFact.factId)?.rows};
  };
  const before=await snapshot(),path='/api/rework-orders/craft-quality/drafts';
  const payload={scope:{orderId:order.id,preparationId:order.preparationId,stepRef:step.stepId,returnFactId:returnedFact.factId,lineId,checkId:proof.checkId},execution:'factory',quantity:20};
  const tab=await h.open(qc.actorId,1165,{},'/ui/digital-production?workspace=quality&kind=craft&status=completed',true);
  try{
   await tab.page.locator(`a[href*="qualityReturn=${returnedFact.factId}"]`).filter({hasText:'查看原检查'}).click();
   const panel=tab.page.getByRole('region',{name:'本批原工艺检查',exact:true});
   await panel.getByRole('textbox',{name:'本次实际返工片数',exact:true}).fill('20');
   const sentDraft=tab.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
   await panel.getByRole('button',{name:'打开原返工草稿',exact:true}).click();
   const actual=await sentDraft;expect(actual.status(),await actual.text()).toBe(201);expect(actual.request().postDataJSON()).toEqual(payload);
   const body=await actual.json(),key=actual.request().headers()['idempotency-key']!;
   expect(body).toMatchObject({status:'draft',reworkQuantity:20,processingFactory:{type:'supplier',supplierId:f.supplierId},originalCraftQuality:{checkId:proof.checkId,unit:'片',execution:'factory'}});
   await panel.getByRole('link',{name:'查看原返工单',exact:true}).waitFor();
   const post=(data:typeof payload,idempotencyKey=randomUUID())=>tab.context.request.post(h.base+path,{headers:{'idempotency-key':idempotencyKey},data});
   const replay=await post(payload,key);expect(replay.status()).toBe(201);expect(replay.headers()['idempotency-replayed']).toBe('true');
   expect((await replay.json()).reworkOrderId).toBe(body.reworkOrderId);
   expect((await post({...payload,scope:{...payload.scope,checkId:randomUUID()}})).status()).toBe(409);
   expect((await post({...payload,scope:{...payload.scope,stepRef:randomUUID()}})).status()).toBe(403);
   expect((await f.db.query('SELECT count(*)::int AS count FROM rework_orders WHERE source_craft_qc_check_id=$1',[proof.checkId])).rows[0]!.count).toBe(1);
   expect(await snapshot()).toEqual(before);
   const denied=await h.open(warehouse.actorId,1165,{},'/ui/my-tasks',true);
   try{expect((await denied.context.request.post(h.base+path,{headers:{'idempotency-key':randomUUID()},data:payload})).status()).toBe(403);}
   finally{await denied.close();}
  }finally{await tab.close();}
 });
});
