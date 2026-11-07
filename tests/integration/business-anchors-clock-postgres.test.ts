import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {WholeOrderReviewService} from '../../apps/api/src/rework/whole-order-review-service.js';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {businessNow,ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {factoryBatchTiming} from '../../apps/api/src/production-platform/factory-batch-timing.js';
import {firstContractBusinessReady} from '../../apps/api/src/production-platform/contract-business-ready.js';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import pg from 'pg';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const nativeIt=(name:string,action:()=>Promise<void>)=>it(name,action,testExecutionConfig.correctnessTimeoutMs);
(url?describe:describe.skip)('native business occurrence anchors with all SQL guards',()=>{
 let fixture:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{fixture=await businessAnchorFixture(url!);},120000);
 afterAll(async()=>{await fixture?.dispose();});
 for(const mode of ['past','present','future','ordinary'] as const)for(const craft of ['无','印花'] as const){
  nativeIt(`${mode} / ${craft}: budget, contract, cutting and QC share the original business domain`,async()=>{
   const f=fixture,wall=Date.now(),initial=new Date(wall+(mode==='past'?-7*86400000:mode==='future'?7*86400000:0)).toISOString();
   const scene=mode==='ordinary'?null:await f.scene(initial);
   const run=<T>(action:()=>Promise<T>)=>scene?f.runtime.run(scene,f.root,action):action();
   const ready=await run(()=>f.bulkReady(craft));
   await run(async()=>{
    const journey=await new DigitalJourneyQuery(f.db).read(f.people.merchandiser!,ready.id,undefined,true);
    expect(journey.businessProgress?.asOf).toBe(journey.supervision?.asOf);
    if(scene)expect(journey.businessProgress?.asOf).toBe(initial);
    if(mode==='ordinary'&&craft==='无'){
     const marker=(await f.db.query("SELECT recorded_at FROM digital_bulk_preparation_facts WHERE preparation_id=$1 AND kind='唛架完成'",[ready.preparationId])).rows[0];
     const sourceTime=new Date(marker.recorded_at).toISOString(),tasks=new DigitalProductionTaskService(f.db);
     expect(journey.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='bulk_marker'&&node.current)).toMatchObject({state:'completed',actualAt:sourceTime});
     await tasks.controlResource(f.root,{kind:'order',id:ready.id},'pause','TEST pause cannot erase marker occurrence',randomUUID());
     try{const paused=await new DigitalJourneyQuery(f.db).read(f.people.merchandiser!,ready.id,undefined,true);expect(paused.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='bulk_marker'&&node.current)).toMatchObject({state:'completed',actualAt:sourceTime});}
     finally{await tasks.controlResource(f.root,{kind:'order',id:ready.id},'resume','TEST return original execution',randomUUID());}
    }
    const preparationWindows=(await f.db.query('SELECT kind,started_at,minutes FROM digital_preparation_windows WHERE production_order_id=$1 ORDER BY kind',[ready.id])).rows;
    expect(preparationWindows).toHaveLength(2);for(const window of preparationWindows){expect(window.minutes).toBe(1440);if(scene)expect(window.started_at.toISOString()).toBe(initial);else expect(window.started_at.getTime()).toBeGreaterThanOrEqual(wall);}
    const budget=(await f.db.query(`SELECT t.completed_at,c.occurred_at FROM digital_budget_preparations p JOIN digital_production_tasks t USING(task_id) JOIN digital_production_task_conditions c ON c.task_id=t.task_id AND c.condition_key='business_recorded' WHERE p.production_order_id=$1`,[ready.id])).rows[0];
    expect(budget.completed_at.toISOString()).toBe(budget.occurred_at.toISOString());
    if(scene)expect(budget.completed_at.toISOString()).toBe(initial);
    expect((await f.db.query('SELECT count(*)::int n FROM sourcing_cases WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].n).toBe(1);
    const contract=await firstContractBusinessReady(f.db,ready.id);expect(contract.kind).toBe('business');
    if(scene)expect(contract.at).toBe(initial);
    const original=(await f.db.query('SELECT * FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1',[ready.caseId])).rows;
    expect(original).toHaveLength(1);expect(original[0].business_time.scenarioId).toBe(scene);
    const pdf=(await f.db.query('SELECT generated_at FROM sourcing_contract_documents WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
    expect(pdf.generated_at.getTime()).toBeGreaterThanOrEqual(wall-1000);
    if(scene&&mode!=='present')expect(pdf.generated_at.toISOString()).not.toBe(initial);
    const orders=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows;
    const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
    for(const row of orders){const attachment=await f.image(cutter),key=randomUUID(),input={pieceCount:1,actualCutCount:10,attachmentIds:[attachment]};
     await ready.cutting.record(cutter,row.cutting_order_id,input,key);
     expect((await ready.cutting.record(cutter,row.cutting_order_id,input,key)).reused).toBe(true);
    }
    const cutting=(await f.db.query(`SELECT c.completed_at,t.completed_at AS task_completed FROM digital_bulk_cutting_completions c JOIN digital_production_tasks t USING(task_id) WHERE c.production_order_id=$1`,[ready.id])).rows[0];
    expect(cutting.completed_at.toISOString()).toBe(cutting.task_completed.toISOString());
    if(scene)expect(cutting.completed_at.toISOString()).toBe(initial);
   });
   if(scene)await f.advance(scene,new Date(Date.parse(initial)+3600000).toISOString());
   await run(async()=>{
    const flow=new FactoryFlowService(f.db),tasks=new DigitalProductionTaskService(f.db);
    let state=await flow.read(f.root,ready.id);
    if(craft==='印花'){
     for(const [kind,actor] of [['process_logistics',f.people['embroidery-washing-merchandiser']!],['bulk_qc',f.people.qc!]] as const)await tasks.reassign(f.root,state.tasks.find(t=>t.taskKind===kind)!.taskId,actor.actorId,randomUUID());
     state=await flow.read(f.root,ready.id);
     const logistics=f.people['embroidery-washing-merchandiser']!,at=businessNow().toISOString();
     state=await flow.logistics(logistics,ready.id,{expectedRevision:state.revision,kind:'工艺发出',occurredAt:at,supplier:'TEST工艺',note:''},randomUUID());
     state=await flow.logistics(logistics,ready.id,{expectedRevision:state.revision,kind:'工艺回仓',occurredAt:at,supplier:'TEST工艺',note:''},randomUUID());
     const returned=state.facts.at(-1)!.factId,line=state.batchTotals![0]!.lineId,qc=f.people.qc!;
     const key=randomUUID(),input={expectedRevision:state.revision,returnFactId:returned,checks:[{lineId:line,result:'需处理' as const,problem:'TEST问题',treatment:'TEST待处理',attachmentIds:[]}],note:''};
     state=await flow.qc(qc,ready.id,input,key);await flow.qc(qc,ready.id,input,key);
     let timing=await factoryBatchTiming(f.db,ready.id);
     expect(timing!.windows.find(w=>w.kind==='bulk_qc')).toMatchObject({complete:true});
     expect(timing!.windows.filter(w=>w.kind==='warehouse_dispatch')).toHaveLength(0);
     const checked=(await f.db.query('SELECT checked_at FROM digital_factory_qc WHERE preparation_id=$1',[ready.preparationId])).rows;
     expect(checked).toHaveLength(1);if(scene)expect(checked[0].checked_at.toISOString()).toBe(at);
     state=await flow.qc(qc,ready.id,{expectedRevision:state.revision,returnFactId:returned,checks:[{lineId:line,result:'需处理',problem:'TEST问题',treatment:'TEST后续安排',allowDispatch:true,dispatchReason:'TEST允许先发',attachmentIds:[]}],note:''},randomUUID());
     timing=await factoryBatchTiming(f.db,ready.id);
     const warehouse=timing!.windows.find(w=>w.kind==='warehouse_dispatch')!;
     expect(warehouse.enteredAt).toBe((await f.db.query('SELECT max(checked_at) AS checked_at FROM digital_factory_qc WHERE preparation_id=$1',[ready.preparationId])).rows[0].checked_at.toISOString());
     expect(Date.parse(warehouse.dueAt!)-Date.parse(warehouse.enteredAt!)).toBe(24*3600000);
    }else{
     const timing=await factoryBatchTiming(f.db,ready.id),cut=(await f.db.query('SELECT completed_at FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[ready.id])).rows[0];
     expect(timing!.windows.find(w=>w.kind==='warehouse_dispatch')!.enteredAt).toBe(cut.completed_at.toISOString());
    }
    const before=await firstContractBusinessReady(f.db,ready.id);
    await f.contracts.generateIfReady(f.root,ready.caseId);await f.contracts.generateIfReady(f.root,ready.caseId);
    expect(await firstContractBusinessReady(f.db,ready.id)).toEqual(before);
    expect((await f.db.query('SELECT count(*)::int n FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].n).toBe(1);
   });
  });
 }
 nativeIt('rolls back a failed first-ready fact with the ready state and retries the same PDF safely',async()=>{
  const f=fixture,scene=await f.scene(new Date(Date.now()-86400000).toISOString());
  // A generation failure is tolerated by native owner approval, then retried explicitly.
  const original=f.contracts.generateIfReady.bind(f.contracts);
  const deferred=vi.spyOn(f.contracts,'generateIfReady').mockRejectedValueOnce(new Error('TEST deferred generation'));
  let ready:Awaited<ReturnType<typeof f.bulkReady>>;
  try{ready=await f.runtime.run(scene,f.root,()=>f.bulkReady('无'));}finally{deferred.mockRestore();}
  expect((await f.db.query('SELECT count(*)::int n FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1',[ready!.caseId])).rows[0].n).toBe(0);
  await f.runtime.run(scene,f.root,async()=>{
   const order=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready!.caseId])).rows[0],cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready!.cutting.record(cutter,order.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   expect((await factoryBatchTiming(f.db,ready!.id))!.windows.find(w=>w.kind==='warehouse_dispatch')).toMatchObject({enteredAt:null,dueAt:null});
  });
  await f.advance(scene,new Date(Date.parse((await f.runtime.repository.row(scene)).business_now.toISOString())+7200000).toISOString());
  await f.db.query(`CREATE FUNCTION test_fail_ready() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST fail ready persistence'; END $$;
   CREATE TRIGGER test_fail_ready AFTER INSERT ON sourcing_contract_business_ready_facts FOR EACH ROW EXECUTE FUNCTION test_fail_ready()`);
  try{await expect(f.runtime.run(scene,f.root,()=>original(f.root,ready!.caseId))).rejects.toThrow('TEST fail ready persistence');}finally{await f.db.query('DROP TRIGGER test_fail_ready ON sourcing_contract_business_ready_facts; DROP FUNCTION test_fail_ready()');}
  expect((await f.db.query('SELECT count(*)::int n FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1',[ready!.caseId])).rows[0].n).toBe(0);
  const document=(await f.db.query('SELECT status,generated_at FROM sourcing_contract_documents WHERE sourcing_case_id=$1',[ready!.caseId])).rows[0];expect(document.generated_at).toBeNull();expect(document.status).not.toBe('ready');
  const clockRow=await f.runtime.repository.row(scene),clock={now:clockRow.business_now.toISOString(),scenarioId:scene,revision:clockRow.version};
  for(const bad of [{...clock,scenarioId:randomUUID()},{...clock,revision:clock.revision-1},{...clock,now:new Date(Date.parse(clock.now)-1).toISOString()}]){
   const miswired=vi.spyOn(ContextBusinessClock.prototype,'read').mockResolvedValueOnce(bad);
   try{await expect(original(f.root,ready!.caseId)).rejects.toThrow();}finally{miswired.mockRestore();}
   expect((await f.db.query('SELECT count(*)::int n FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1',[ready!.caseId])).rows[0].n).toBe(0);
   expect((await f.db.query("SELECT count(*)::int n FROM operation_events WHERE entity_type='sourcing_contract_document' AND entity_id IN (SELECT sourcing_contract_document_id::text FROM sourcing_contract_documents WHERE sourcing_case_id=$1) AND action='sourcing.contract.business_ready'",[ready!.caseId])).rows[0].n).toBe(0);
  }
  // Background resume has no ALS request; the installed guarded resource reader must supply the scene.
  await original(f.root,ready!.caseId);
  const first=await firstContractBusinessReady(f.db,ready!.id),businessAt=(await f.runtime.repository.row(scene)).business_now.toISOString();
  expect(first.at).toBe(businessAt);
  const window=(await factoryBatchTiming(f.db,ready!.id))!.windows.find(w=>w.kind==='warehouse_dispatch')!;
  expect(window).toMatchObject({enteredAt:businessAt,dueAt:new Date(Date.parse(businessAt)+86400000).toISOString()});
  const revisions=(await f.db.query(`SELECT r.entered_at,r.due_at FROM digital_production_deadline_revisions r JOIN digital_production_task_access t USING(task_id) WHERE t.production_order_id=$1 AND t.task_kind='warehouse_dispatch' ORDER BY r.revision_id DESC LIMIT 1`,[ready!.id])).rows[0];
  expect(revisions.entered_at.toISOString()).toBe(window.enteredAt);expect(revisions.due_at.toISOString()).toBe(window.dueAt);
  const replacement=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:`TEST-REPLACEMENT-${randomUUID().slice(0,8).toUpperCase()}`,supplierType:'factory',supplierName:'TEST replacement',address:'TEST',contractEntityName:'TEST factory',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0002',bankName:'TEST',changeReason:'TEST next contract version'}));
  await f.advance(scene,new Date(Date.parse(businessAt)+7200000).toISOString());
  await f.runtime.run(scene,f.root,()=>f.sourcing.requestFactoryChange(f.people['production-management']!,ready!.caseId,{supplierId:replacement.supplierId,unitPrice:'5',changeReason:'TEST next contract must not restart warehouse window'},randomUUID()));
  expect(await firstContractBusinessReady(f.db,ready!.id)).toEqual(first);
  expect((await f.db.query('SELECT is_first_for_case FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1 ORDER BY is_first_for_case DESC',[ready!.caseId])).rows.map(r=>r.is_first_for_case)).toEqual([true,false]);
  expect((await factoryBatchTiming(f.db,ready!.id))!.windows.find(w=>w.kind==='warehouse_dispatch')).toMatchObject({enteredAt:window.enteredAt,dueAt:window.dueAt});
 });
 nativeIt('P02-09: closure keeps original registered quantity separate from effective process reports and rejected history',async()=>{
  const f=fixture,{ready,id,work,state,worker,own}=await f.reworkReady(),closure=new OrderClosureService(f.db);
  const ownTask=state.tasks.find(task=>task.members.some(member=>member.personId===own))!;
  const report=(await work.submitReport(worker,ownTask.workTaskId,{expectedOrderVersion:state.orderVersion,actualQuantity:1,completedAt:new Date().toISOString()},randomUUID())).value;
  const row=(sheet:Awaited<ReturnType<typeof closure.read>>)=>sheet.lines.flatMap(line=>line.reworks).find(value=>value.reworkId===id)!;
  const first=row(await closure.read(f.root,ready.id));
  expect(first).toMatchObject({quantity:10,businessSummary:{kind:'qc_rework',processes:[{reportedQuantity:1,reportIds:[report.workReportId]}]}});
  const other=state.tasks.find(task=>task.workTaskId!==ownTask.workTaskId)!,current=await work.list(f.root,id);
  const otherReport=(await work.submitReport(worker,other.workTaskId,{expectedOrderVersion:current.orderVersion,actualQuantity:5,completedAt:new Date().toISOString()},randomUUID())).value;
  const review=new WholeOrderReviewService(f.db),audit={...f.root,authorizationCapability:'submission:audit'};
  const before=await review.get(audit,id);
  const correctionKey=randomUUID(),correction={expectedOrderVersion:before.orderVersion,effectiveQuantity:3,reason:'TEST P02 original5 corrected to3'};
  const corrected=await review.correctReportQuantity(audit,otherReport.workReportId,correction,correctionKey);
  expect((await review.correctReportQuantity(audit,otherReport.workReportId,correction,correctionKey)).reused).toBe(true);
  expect(corrected.value.processes[0]!.completedQuantity).toBe(4);
  expect(row(await closure.read(f.root,ready.id)).businessSummary!.processes[0]!.reportedQuantity).toBe(4);
  const revised=await review.get(audit,id);
  await review.correctReportQuantity(audit,otherReport.workReportId,{expectedOrderVersion:revised.orderVersion,effectiveQuantity:4,reason:'TEST P02 latest revision wins'},randomUUID());
  const rejection=await review.get(audit,id);
  await review.rejectReport(audit,report.workReportId,{expectedOrderVersion:rejection.orderVersion,rejectedPersonId:own,reason:'TEST P02 quantity evidence returned'},randomUUID());
  expect(row(await closure.read(f.root,ready.id))).toMatchObject({quantity:10,businessSummary:{kind:'qc_rework',processes:[{reportedQuantity:4,reportIds:[otherReport.workReportId]}]}});
  expect(Number((await f.db.query('SELECT actual_quantity FROM rework_work_reports WHERE work_report_id=$1',[report.workReportId])).rows[0].actual_quantity)).toBe(1);
  expect((await f.db.query('SELECT actual_quantity::int AS original,rework_work_report_effective_quantity(work_report_id)::int AS effective FROM rework_work_reports WHERE work_report_id=$1',[otherReport.workReportId])).rows[0]).toEqual({original:5,effective:4});
 });
 for(const mode of ['past','present','future','ordinary'] as const)nativeIt(`${mode}: multi-capability batch reports keep occurrence time, authorization and atomic retry`,async()=>{
  const f=fixture,wall=Date.now(),at=new Date(wall+(mode==='past'?-7*86400000:mode==='future'?7*86400000:0)).toISOString(),scene=mode==='ordinary'?null:await f.scene(at);
  const run=<T>(action:()=>Promise<T>)=>scene?f.runtime.run(scene,f.root,action):action();
  const prepared=await run(()=>f.reworkReady());
  const {id,work,state,worker}=prepared;
  expect((await f.db.query("SELECT production_order_id FROM digital_production_child_links WHERE module='rework' AND child_id=$1",[id])).rows[0].production_order_id).toBe(prepared.ready.id);
  const reports=state.tasks.map(t=>({workTaskId:t.workTaskId,actualQuantity:5,completedAt:at})),input={expectedOrderVersion:state.orderVersion,reports},key=randomUUID();
  const snapshot=async()=>(await f.db.query(`SELECT
   (SELECT count(*) FROM rework_work_reports WHERE rework_order_id=$1)::int reports,
   (SELECT count(*) FROM rework_work_report_member_shares s JOIN rework_work_reports r USING(work_report_id) WHERE r.rework_order_id=$1)::int shares,
   (SELECT count(*) FROM operation_events WHERE entity_id=$1::text AND action='rework.work_report.submit')::int events,
   (SELECT version FROM rework_orders WHERE rework_order_id=$1)::int AS order_version`,[id])).rows[0];
  const before=await snapshot();
  await expect(run(()=>work.submitReportsBatch({...worker,authorizationCapabilities:['work:report']},id,input,randomUUID()))).rejects.toMatchObject({statusCode:403});
  expect(await snapshot()).toEqual(before);
  await f.db.query(`CREATE FUNCTION test_batch_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM operation_events WHERE event_id=current_setting('dx_rework.work_event_id',true)::uuid AND authorization_capability='work:report_for_worker') THEN RAISE EXCEPTION 'TEST second capability group'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER test_batch_fail AFTER INSERT ON rework_work_reports FOR EACH ROW EXECUTE FUNCTION test_batch_fail()`);
  try{await expect(run(()=>work.submitReportsBatch(worker,id,input,key))).rejects.toThrow('TEST second capability group');}finally{await f.db.query('DROP TRIGGER test_batch_fail ON rework_work_reports; DROP FUNCTION test_batch_fail()');}
  expect(await snapshot()).toEqual(before);
  const results=await run(()=>Promise.all([work.submitReportsBatch(worker,id,input,key),work.submitReportsBatch(worker,id,input,key)]));
  expect(results.map(r=>r.reused).sort()).toEqual([false,true]);
  const persisted=(await f.db.query('SELECT completed_at,created_at FROM rework_work_reports WHERE rework_order_id=$1',[id])).rows;
  expect(persisted).toHaveLength(2);expect(new Set(persisted.map(r=>r.completed_at.toISOString())).size).toBe(1);
  if(scene)for(const report of persisted)expect(report.completed_at.toISOString()).toBe(at);
  for(const report of persisted)expect(report.created_at.getTime()).toBeGreaterThanOrEqual(wall-1000);
  expect((await f.db.query("SELECT DISTINCT authorization_capability FROM operation_events WHERE entity_id=$1::text AND action='rework.work_report.submit' ORDER BY authorization_capability",[id])).rows.map(r=>r.authorization_capability)).toEqual(['work:report','work:report_for_worker']);
  expect(await run(()=>work.submitReportsBatch(worker,id,input,key))).toMatchObject({reused:true});
 });
 nativeIt('rolls back budget binding after native task completion, then preserves same-key and different-key protections',async()=>{
  const f=fixture,at=new Date(Date.now()-86400000).toISOString(),scene=await f.scene(at);
  const ready=await f.runtime.run(scene,f.root,()=>f.bulkReady('无',async(input,key,primary)=>{
   const snapshot=async()=>(await f.db.query(`SELECT
    (SELECT count(*) FROM sourcing_cases)::int cases,(SELECT count(*) FROM sourcing_case_lines)::int lines,
    (SELECT count(*) FROM sourcing_case_transitions)::int transitions,(SELECT count(*) FROM digital_production_child_links)::int links,
    (SELECT count(*) FROM idempotency_records)::int receipts,(SELECT count(*) FROM operation_events)::int events,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.task_id) FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1) AS tasks,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.task_id,c.condition_key) FROM digital_production_task_conditions c JOIN digital_production_task_access t USING(task_id) WHERE t.production_order_id=$1) AS conditions`,[input.digitalBudget!.productionOrderId])).rows[0];
   const before=await snapshot(),complete=DigitalProductionTaskService.prototype.completeWithClient;
   const fault=vi.spyOn(DigitalProductionTaskService.prototype,'completeWithClient').mockImplementationOnce(async function(this:DigitalProductionTaskService,...args){await complete.apply(this,args);throw new Error('TEST budget completion rollback');});
   try{await expect(f.sourcing.createCase(primary,input,key)).rejects.toThrow('TEST budget completion rollback');}finally{fault.mockRestore();}
   expect(await snapshot()).toEqual(before);
  }));
  await f.runtime.run(scene,f.root,async()=>{
   expect((await f.sourcing.createCase(ready.primary,ready.input,ready.key)).reused).toBe(true);
   await expect(f.sourcing.createCase(ready.primary,ready.input,randomUUID())).rejects.toMatchObject({statusCode:409});
  });
 });
 for(const mode of ['past','present','future','ordinary'] as const)nativeIt(`${mode}: single worker report and Root proxy preserve business completion and true audit time`,async()=>{
  const f=fixture,wall=Date.now(),at=new Date(wall+(mode==='past'?-7*86400000:mode==='future'?7*86400000:0)).toISOString(),scene=mode==='ordinary'?null:await f.scene(at);
  const run=<T>(action:()=>Promise<T>)=>scene?f.runtime.run(scene,f.root,action):action();
  await run(async()=>{
   const {id,work,state,worker,own}=await f.reworkReady(),ownTask=state.tasks.find(t=>t.members.some(m=>m.personId===own))!,other=state.tasks.find(t=>t.workTaskId!==ownTask.workTaskId)!;
   const input={expectedOrderVersion:state.orderVersion,actualQuantity:5,completedAt:at},key=randomUUID();
   await expect(work.submitReport({...worker,actorId:f.people['worker-b']!.actorId},ownTask.workTaskId,input,randomUUID())).rejects.toMatchObject({statusCode:403});
   const first=await work.submitReport(worker,ownTask.workTaskId,input,key);
   expect((await work.submitReport(worker,ownTask.workTaskId,input,key)).reused).toBe(true);
   const current=await work.list(f.root,id),rootProxy={...f.root,authorizationCapability:'work:report_for_worker',authorizationCapabilities:['work:report_for_worker']};
   const second=await work.submitReport(rootProxy,other.workTaskId,{...input,expectedOrderVersion:current.orderVersion},randomUUID());
   if(scene){expect(first.value.completedAt).toBe(at);expect(second.value.completedAt).toBe(at);}else{expect(Date.parse(first.value.completedAt)).toBeGreaterThanOrEqual(wall);expect(Date.parse(second.value.completedAt)).toBeGreaterThanOrEqual(wall);}
   const rows=(await f.db.query('SELECT created_at FROM rework_work_reports WHERE rework_order_id=$1',[id])).rows;expect(rows).toHaveLength(2);for(const row of rows)expect(row.created_at.getTime()).toBeGreaterThanOrEqual(wall-1000);
  });
 });
 nativeIt('resumes a full ten-connection batch without ALS, extra clock connections or lost scenarios',async()=>{
  const f=fixture,cases:Array<{caseId:string;orderId:string;sceneId:string;at:string}>=[];
  const defer=vi.spyOn(f.contracts,'generateIfReady').mockRejectedValue(new Error('TEST defer until startup recovery'));
  try{
   for(const delta of [-7,7]){
    const at=new Date(Date.now()+delta*86400000).toISOString(),sceneId=await f.scene(at);
    await f.runtime.run(sceneId,f.root,async()=>{for(let i=0;i<5;i++){const ready=await f.bulkReady('无');cases.push({caseId:ready.caseId,orderId:ready.id,sceneId,at});}});
   }
  }finally{defer.mockRestore();}
  const caseIds=cases.map(c=>c.caseId);
  expect((await f.db.query("SELECT count(*)::int n FROM sourcing_contract_documents WHERE sourcing_case_id=ANY($1::uuid[]) AND status='generation_pending'",[caseIds])).rows[0].n).toBe(10);
  // A separate read-only observer does not lend the service pool a connection.
  // Wait for nine actual transaction lock waiters, not merely ten busy queries.
  const observer=new pg.Pool({connectionString:url!,application_name:'TEST-clock-pool-observer',max:1});
  const read=ContextBusinessClock.prototype.read;let heldAtCapacity=false;
  const barrier=vi.spyOn(ContextBusinessClock.prototype,'read').mockImplementation(async function(this:ContextBusinessClock,...args){
   if(!heldAtCapacity){heldAtCapacity=true;await vi.waitFor(async()=>{expect(f.db.totalCount).toBe(10);expect(f.db.idleCount).toBe(0);
    const waiting=(await observer.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock' AND wait_event='advisory' AND xact_start IS NOT NULL",[f.db.options.application_name])).rows[0].n;expect(waiting).toBe(9);
   },{timeout:15000,interval:20});}
   return read.apply(this,args);
  });
  try{await f.contracts.resumePendingContracts();}finally{barrier.mockRestore();await observer.end();}
  expect(heldAtCapacity).toBe(true);
  const documents=(await f.db.query('SELECT status,failure_reason FROM sourcing_contract_documents WHERE sourcing_case_id=ANY($1::uuid[])',[caseIds])).rows;
  expect(documents,JSON.stringify(documents)).toHaveLength(10);
  expect(documents,JSON.stringify(documents)).toEqual(Array.from({length:10},()=>({status:'ready',failure_reason:null})));
  const facts=(await f.db.query('SELECT sourcing_case_id,business_ready_at,business_time FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=ANY($1::uuid[])',[caseIds])).rows;
  expect(facts).toHaveLength(10);
  for(const expected of cases){const fact=facts.find(row=>row.sourcing_case_id===expected.caseId)!;expect(fact.business_ready_at.toISOString()).toBe(expected.at);expect(fact.business_time).toEqual({now:expected.at,scenarioId:expected.sceneId,revision:1});}
  await f.contracts.resumePendingContracts();
  expect((await f.db.query('SELECT count(*)::int n FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=ANY($1::uuid[])',[caseIds])).rows[0].n).toBe(10);
 });
});
