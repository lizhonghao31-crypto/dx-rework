import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {WholeOrderReviewService} from '../../apps/api/src/rework/whole-order-review-service.js';
import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {businessNow,ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {factoryBatchTiming} from '../../apps/api/src/production-platform/factory-batch-timing.js';
import {firstContractBusinessReady} from '../../apps/api/src/production-platform/contract-business-ready.js';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import Fastify from 'fastify';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {PoolClient} from 'pg';
import {SourcingContractService} from '../../apps/api/src/sourcing/sourcing-contract-service.js';
import {SourcingContractRecovery} from '../../apps/api/src/sourcing/sourcing-contract-recovery.js';
import * as contractPdf from '../../apps/api/src/sourcing/sourcing-contract-pdf.js';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import {AcceptanceObjectStorage,registerAcceptanceStorageRoutes} from '../../apps/api/src/tools/acceptance-storage.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {AuthService} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {registerSourcingRoutes} from '../../apps/api/src/sourcing/sourcing-routes.js';

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
  const docId=(await f.contracts.getCurrent(f.root,ready!.caseId)).item!.sourcingContractDocumentId;
  expect((await f.db.query("SELECT 1 FROM attachments WHERE entity_type='sourcing_contract_document' AND entity_id=$1",[docId])).rowCount).toBe(0);
  const publish=f.attachments.publishContractPdf.bind(f.attachments);
  let committedWithoutAck=false;
  const lostAck=vi.spyOn(f.attachments,'publishContractPdf').mockImplementationOnce(async(client,...args)=>{
   const file=await publish(client,...args);
   const query=client.query.bind(client),release=client.release.bind(client);
   client.query=(async(statement: string, ...params: unknown[])=>{
    const result=await (query as (text: string,...params: unknown[])=>Promise<unknown>)(statement,...params);
    if(statement==='COMMIT'){committedWithoutAck=true;throw new Error('TEST lost acknowledgement after actual COMMIT');}
    return result;
   }) as PoolClient['query'];
   client.release=(error)=>{client.query=query;client.release=release;release(error);};
   return file;
  });
  try{await expect(original(f.root,ready!.caseId)).resolves.toMatchObject({item:{status:'ready',sourcingContractDocumentId:docId}});}
  finally{lostAck.mockRestore();}
  expect(committedWithoutAck).toBe(true);
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
  },1,f.sourcing,{stopBeforeCompletion:true}));
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
 nativeIt('recovers committed documents in bounded pages after listen without overlapping a blocked first PDF',async()=>{
  const f=fixture,cases:Array<{caseId:string;orderId:string;sceneId:string;at:string}>=[];
  const defer=vi.spyOn(f.contracts,'generateIfReady').mockRejectedValue(new Error('TEST defer until startup recovery'));
  try{
   for(const delta of [-7,7]){
    const at=new Date(Date.now()+delta*86400000).toISOString(),sceneId=await f.scene(at);
    await f.runtime.run(sceneId,f.root,async()=>{for(let i=0;i<2;i++){const ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true});cases.push({caseId:ready.caseId,orderId:ready.id,sceneId,at});}});
   }
  }finally{defer.mockRestore();}
  const ids=cases.map(c=>c.caseId);
  const query=()=>f.db.query("SELECT sourcing_case_id,status,generation_attempt_id FROM sourcing_contract_documents WHERE sourcing_case_id=ANY($1::uuid[]) ORDER BY prepared_at,sourcing_contract_document_id",[ids]);
  expect((await query()).rows.map(r=>r.status)).toEqual(Array(4).fill('generation_pending'));
  const release=Promise.withResolvers<void>();
  let storageBlocked=false;
  const write=f.storage.writeImmutable.bind(f.storage);
  const barrier=vi.spyOn(f.storage,'writeImmutable').mockImplementationOnce(async(...args)=>{
   storageBlocked=true;await release.promise;await write(...args);
  });
  const scan=f.contracts.resumePendingContracts.bind(f.contracts),passes=vi.spyOn(f.contracts,'resumePendingContracts');
  passes.mockImplementation((_limit,options)=>scan(1,options));
  const app=Fastify(),root=new RootAuthority(f.db,'anchor-test','uat-root'),secret='TEST local read while contract recovery runs '.repeat(3);
  const auth=new AuthService(new AcceptanceDingTalkProvider(f.db,'anchor-test',secret),new PostgresAuthStore(f.db,'anchor-test','uat-root'),'anchor-test',3600000,secret);
  registerSourcingRoutes(app,{service:f.sourcing,contracts:f.contracts,root,authenticate:token=>auth.authenticate(token)});
  const login=await auth.loginMobile(mintAcceptanceLoginCode('merchandiser',secret));
  const reports:unknown[]=[];
  const log=(value:unknown,message?:string)=>reports.push({value,message});
  const recovery=new SourcingContractRecovery(f.contracts,{info:log,warn:log},true,f.runtime);
  try{
   const origin=await app.listen({host:'127.0.0.1',port:0});
   recovery.start();recovery.start();
   await vi.waitFor(()=>expect(storageBlocked,JSON.stringify(reports)).toBe(true),{timeout:8_000,interval:100});
   const other=cases.at(-1)!;
   const response=await fetch(`${origin}/sourcing/cases/${other.caseId}`,{
    headers:{cookie:`dx_rework_session=${login.token}`},
   });
   const detail=await response.json();
   expect(response.status,JSON.stringify(detail)).toBe(200);
   expect(detail.sourcingCaseId).toBe(other.caseId);
   expect(passes).toHaveBeenCalledTimes(1);
   expect((await query()).rows.filter(r=>r.status==='generating')).toHaveLength(1);
   const stopped=recovery.stop();
   release.resolve();
   await stopped;
   expect((await query()).rows.map(r=>r.status)).toEqual(['ready','generation_pending','generation_pending','generation_pending']);
   const withoutClock=await scan(1,{report:log});
   expect(withoutClock).toMatchObject({candidates:1,advanced:1,ready:0});
   expect(reports).toEqual(expect.arrayContaining([expect.objectContaining({message:'contract recovery requires the verified Acceptance clock'})]));
   let cursor=withoutClock.cursor;
   for(let i=0;i<5;i++){
    const result=await scan(1,{cursor,acceptanceClock:f.runtime});
    expect(result.advanced).toBeLessThanOrEqual(1);cursor=result.cursor;
   }
   expect((await query()).rows.map(r=>r.status)).toEqual(Array(4).fill('ready'));
   const facts=(await f.db.query('SELECT sourcing_case_id,business_ready_at,business_time FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=ANY($1::uuid[])',[ids])).rows;
   expect(facts).toHaveLength(4);
   for(const expected of cases){
    const fact=facts.find(row=>row.sourcing_case_id===expected.caseId)!;
    expect(fact.business_ready_at.toISOString()).toBe(expected.at);
    expect(fact.business_time).toEqual({now:expected.at,scenarioId:expected.sceneId,revision:1});
   }
  }finally{
   release.resolve();await recovery.stop();await app.close();passes.mockRestore();barrier.mockRestore();
  }
 });

 for(const mode of ['same bytes','different bytes','storage failure','late after commit','storage failure after commit'] as const)nativeIt(`G1 ${mode}: a prior owner cannot publish, fail, or project after takeover`,async()=>{
  const f=fixture;
  const defer=vi.spyOn(f.contracts,'generateIfReady').mockRejectedValueOnce(new Error('TEST stop after owner approval'));
  let original:Awaited<ReturnType<typeof f.bulkReady>>;
  try{original=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true});}finally{defer.mockRestore();}
  const {caseId,id:orderId}=original;
  const afterCommit=mode.endsWith('after commit'),oldFails=mode.startsWith('storage failure');
  const document=(await f.contracts.getCurrent(f.root,caseId)).item!;
  const documentId=document.sourcingContractDocumentId;
  const row=async()=>(await f.db.query('SELECT status,pdf_attachment_id,pdf_sha256,snapshot_fingerprint,generated_at,failure_reason,generation_attempt_id FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1',[documentId])).rows[0];
  const attachmentsRows=async()=>(await f.db.query("SELECT attachment_id,object_key,sha256 FROM attachments WHERE entity_type='sourcing_contract_document' AND entity_id=$1",[documentId])).rows;
  const facts=async()=>(await f.db.query('SELECT * FROM sourcing_contract_business_ready_facts WHERE sourcing_case_id=$1',[caseId])).rows;
  const todoRows=async()=>(await f.db.query("SELECT todo_id,recipient_user_id,status,route_descriptor FROM rework_todos WHERE entity_id=$1 AND entity_type='sourcing_case' ORDER BY todo_id",[caseId])).rows;
  const todoBefore=await todoRows();
  const oldEntered=Promise.withResolvers<void>(),oldRelease=Promise.withResolvers<void>();
  const newEntered=Promise.withResolvers<void>(),newRelease=Promise.withResolvers<void>();
  const dir=await mkdtemp(join(tmpdir(),'dx-g1-pdf-')), app=Fastify();
  const objectStore=new AcceptanceObjectStorage(dir,'http://localhost','TEST local object grants for the original contract PDF');
  registerAcceptanceStorageRoutes(app,objectStore);
  const attachments=new AttachmentService(f.db,objectStore,{prefix:'TEST',ttlSeconds:60,maxUploadBytes:1000000});
  const priorWorker=new SourcingContractService(f.db,attachments),nextWorker=new SourcingContractService(f.db,attachments);
  const copyImages=async()=>{
   const images=(await f.db.query("SELECT object_key,mime_type,sha256 FROM attachments WHERE entity_type='sourcing_case' AND entity_id=$1 AND mime_type LIKE 'image/%'",[caseId])).rows;
   for(const image of images)await objectStore.writeImmutable(image.object_key,await f.storage.readBytes(image.object_key,1000000),{mimeType:image.mime_type,sha256:image.sha256});
  };
  try{
   await copyImages();
   const render=contractPdf.renderSourcingContractPdf;
   if(mode==='different bytes')vi.spyOn(contractPdf,'renderSourcingContractPdf').mockImplementationOnce(async snapshot=>
    Buffer.concat([await render(snapshot),Buffer.from('\n% TEST previous attempt differential bytes\n')]));
   const realWrite=objectStore.writeImmutable.bind(objectStore);
   const block=vi.spyOn(objectStore,'writeImmutable')
    .mockImplementationOnce(async(...args)=>{
     if(!oldFails)await realWrite(...args);
     oldEntered.resolve();await oldRelease.promise;
     if(oldFails)throw new Error('TEST stale storage failure');
    }).mockImplementationOnce(async(...args)=>{await realWrite(...args);newEntered.resolve();await newRelease.promise;});
   const former={...f.root,requestId:`TEST-G1-old-${documentId}`},winner={...f.root,requestId:`TEST-G1-new-${documentId}`};
   const old=priorWorker.generateIfReady(former,caseId,documentId);
   void old.catch(oldEntered.reject);
   let next:ReturnType<typeof nextWorker.generateIfReady>|undefined;
   try{
    await oldEntered.promise;
    const previous=(await row()).generation_attempt_id;
    expect(previous).toBeTruthy();
    expect((await f.db.query('SELECT object_key FROM sourcing_contract_generation_staging WHERE generation_attempt_id=$1',[previous])).rowCount).toBe(1);
    expect(await nextWorker.generateIfReady(winner,caseId,documentId)).toMatchObject({item:{status:'generating'}});
    expect(block).toHaveBeenCalledTimes(1);
    await f.db.query("UPDATE sourcing_contract_documents SET generation_lease_until=clock_timestamp()-INTERVAL '1 second' WHERE sourcing_contract_document_id=$1",[documentId]);
    next=nextWorker.generateIfReady(winner,caseId,documentId);
    void next.catch(newEntered.reject);
    await newEntered.promise;
    expect((await row()).generation_attempt_id).not.toBe(previous);
    const staged=(await f.db.query('SELECT sha256 FROM sourcing_contract_generation_staging WHERE sourcing_contract_document_id=$1',[documentId])).rows.map(r=>r.sha256);
    expect(new Set(staged).size).toBe(mode==='different bytes'?2:1);
    if(afterCommit){
     newRelease.resolve();await next;
    }
    oldRelease.resolve();await old;
    expect((await f.db.query('SELECT action FROM operation_events WHERE request_id=$1',[former.requestId])).rows).toEqual([]);
    if(!afterCommit){
     expect(await row()).toMatchObject({status:'generating',pdf_attachment_id:null,generated_at:null,failure_reason:null});
     expect(await attachmentsRows()).toEqual([]);expect(await facts()).toEqual([]);expect(await todoRows()).toEqual(todoBefore);
     expect(await firstContractBusinessReady(f.db,orderId)).toMatchObject({kind:'unknown',at:null});
     newRelease.resolve();await next;
    }
    const published=await row(),files=await attachmentsRows();
    expect(published).toMatchObject({status:'ready',failure_reason:null,generation_attempt_id:null});
    expect(files).toEqual([expect.objectContaining({attachment_id:published.pdf_attachment_id,sha256:published.pdf_sha256})]);
    expect(await facts()).toEqual([expect.objectContaining({pdf_attachment_id:published.pdf_attachment_id,is_first_for_case:true})]);
    expect(await firstContractBusinessReady(f.db,orderId)).toMatchObject({kind:'business'});
    const reader={...f.people.merchandiser!,authorizationCapabilities:['sourcing:view','supplier_contract_data:read']};
    const grant=await attachments.createDownloadIntent(reader,published.pdf_attachment_id,binding=>Promise.resolve(f.sourcing.canDownloadBoundAttachment(reader,binding)));
    const url=new URL(grant.downloadUrl);
    const download=await app.inject({url:url.pathname+url.search});
    expect(download.statusCode).toBe(200);
    expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(published.pdf_sha256);
    const after=await todoRows();
    const relevant=after.filter(r=>r.route_descriptor?.transferContract?.documentId===documentId||r.route_descriptor?.contractReturn?.documentId===documentId);
    expect(new Set(relevant.map(r=>r.recipient_user_id)).size).toBe(relevant.length);
    expect(await nextWorker.generateIfReady(winner,caseId,documentId)).toMatchObject({item:{snapshotFingerprint:published.snapshot_fingerprint}});
    expect(await row()).toEqual(published);expect(await todoRows()).toEqual(after);expect(await facts()).toHaveLength(1);
   }finally{
    oldRelease.resolve();newRelease.resolve();await Promise.allSettled(next?[old,next]:[old]);
   }
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
 });

 for(const checkpoint of ['claim','object'] as const)nativeIt(`G1 hard stop after ${checkpoint} retains recoverable document and leaves no formal file`,async()=>{
  const f=fixture,defer=vi.spyOn(f.contracts,'generateIfReady').mockRejectedValueOnce(new Error('TEST committed owner approval before generation'));
  let ready:Awaited<ReturnType<typeof f.bulkReady>>;
  try{ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true});}finally{defer.mockRestore();}
  const caseId=ready.caseId,documentId=(await f.contracts.getCurrent(f.root,caseId)).item!.sourcingContractDocumentId;
  const directory=await mkdtemp(join(tmpdir(),'dx-g1-crashed-pdf-'));
  const storage=new AcceptanceObjectStorage(directory,'http://localhost','TEST isolated contract crash storage');
  const attachments=new AttachmentService(f.db,storage,{prefix:'TEST',ttlSeconds:60,maxUploadBytes:1000000});
  try{
   const images=(await f.db.query("SELECT object_key,mime_type,sha256 FROM attachments WHERE entity_type='sourcing_case' AND entity_id=$1 AND mime_type LIKE 'image/%'",[caseId])).rows;
   for(const image of images)await storage.writeImmutable(image.object_key,await f.storage.readBytes(image.object_key,1000000),{mimeType:image.mime_type,sha256:image.sha256});
   const child=fork(new URL('../helpers/sourcing-contract-crash-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});
   await new Promise<void>((resolve,reject)=>{
    let expired=false,failure:string|undefined;
    const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},15000);
    child.once('error',reject);
    child.once('message',(message:{error:string})=>{failure=message.error;});
    child.once('close',(_code,signal)=>{
     clearTimeout(timer);
     if(signal==='SIGKILL'&&!expired&&!failure)resolve();
     else reject(new Error(failure??'Isolated worker did not stop at the checkpoint'));
    });
    child.send({connectionString:url,schemaOptions:f.db.options.options,directory,actor:f.root,
     caseId,documentId,checkpoint});
   });
   const state=async()=>(await f.db.query("SELECT status,pdf_attachment_id,generated_at,generation_attempt_id FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[documentId])).rows[0];
   const staged=async()=>(await f.db.query("SELECT generation_attempt_id,object_key,sha256,published_attachment_id FROM sourcing_contract_generation_staging WHERE sourcing_contract_document_id=$1 ORDER BY staged_at",[documentId])).rows;
   const before=await state();
   expect(before).toMatchObject({status:'generating',pdf_attachment_id:null,generated_at:null,generation_attempt_id:expect.any(String)});
   const prior=await staged();
   expect(prior).toHaveLength(checkpoint==='claim'?0:1);
   if(prior[0]){
    expect(prior[0]).toMatchObject({generation_attempt_id:before.generation_attempt_id,published_attachment_id:null});
    expect(await storage.computeSha256(prior[0].object_key)).toBe(prior[0].sha256);
   }
   expect((await f.db.query("SELECT 1 FROM attachments WHERE entity_type='sourcing_contract_document' AND entity_id=$1",[documentId])).rowCount).toBe(0);
   await f.db.query("UPDATE sourcing_contract_documents SET generation_lease_until=clock_timestamp()-INTERVAL '1 second' WHERE sourcing_contract_document_id=$1",[documentId]);
   const next=new SourcingContractService(f.db,attachments);
   expect(await next.generateIfReady(f.root,caseId,documentId)).toMatchObject({item:{sourcingContractDocumentId:documentId,status:'ready'}});
   expect((await staged()).filter(row=>row.published_attachment_id)).toHaveLength(1);
   expect((await f.db.query("SELECT 1 FROM sourcing_contract_business_ready_facts WHERE sourcing_contract_document_id=$1",[documentId])).rowCount).toBe(1);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
});
