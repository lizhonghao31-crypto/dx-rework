import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {bulkPreshrinkCorrectionFixture} from '../helpers/bulk-preshrink-correction-fixture.js';
import {completeBulkRangeFixture} from '../helpers/production-readiness-fixture.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {readBulkPreshrinkRequirement} from '../../apps/api/src/production-platform/bulk-preshrink-requirement.js';
import {bulkSlaEvidence} from '../../apps/api/src/production-platform/bulk-sla-evidence.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {journeyTaskSummaries} from '../../apps/api/src/production-platform/journey-task-summary.js';
import {DigitalCockpitQuery} from '../../apps/api/src/production-platform/cockpit-query.js';
import {SeriesPlanService} from '../../apps/api/src/production-platform/series-plan-service.js';
import {productionReadiness} from '../../apps/api/src/production-platform/production-readiness-repository.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
type Fixture=Awaited<ReturnType<typeof bulkPreshrinkCorrectionFixture>>;
async function footprint(f:Fixture){
 const data:Record<string,unknown>={};
 for(const table of ['digital_bulk_preparations','digital_instruction_versions','digital_instruction_documents','digital_bulk_work_ranges','digital_bulk_preparation_facts',
  'digital_production_tasks','digital_production_task_events','digital_production_event_intents','digital_production_task_conditions','digital_production_task_dependencies',
  'digital_production_deadline_revisions','production_order_node_clocks','digital_sla_order_snapshots','digital_sla_plans','digital_sla_node_facts','audit_events','digital_production_commands',
  'digital_bulk_preshrink_corrections','digital_bulk_preshrink_correction_ranges','digital_preparation_windows','digital_bulk_dispatch']){
  data[table]=(await f.db.query(`SELECT coalesce(jsonb_agg(row_data ORDER BY row_data::text),'[]'::jsonb) AS value FROM (SELECT to_jsonb(t) AS row_data FROM ${table} t) rows`)).rows[0].value;
 }
 return data;
}
const immutableTables=['digital_bulk_preparations','digital_instruction_versions','digital_instruction_documents','digital_bulk_work_ranges','digital_sla_order_snapshots','digital_sla_plans','digital_sla_node_facts','digital_preparation_windows','digital_bulk_dispatch'] as const;
async function legacyPreshrinkObservation(f:Fixture){
 const sla=new SlaOrderService(f.db),view=await sla.read(f.root,f.id);
 if(view.status!=='planned')throw Error('TEST requires the original enrolled plan');
 // Reproduce an append-only observation from the former implementation. The
 // current command API has no generic fact writer and this is an owned schema.
 await f.db.query(`INSERT INTO digital_sla_node_facts(fact_id,production_order_id,node_id,revision,plan_id,fact_json,business_time,created_by,reason,request_key)
  VALUES($1,$2,'warehouse_preshrink',1,$3,$4,$5,$6,'TEST retained legacy SLA observation',$7)`,
 [randomUUID(),f.id,view.current.planId,JSON.stringify({businessCompleted:true,completedAt:view.time.now,evidence:'TEST:obsolete-preshrink-observation'}),JSON.stringify(view.time),f.root.actorId,randomUUID()]);
 return sla;
}
(url?describe:describe.skip)('scoped original-v3 preshrink correction (owned PostgreSQL schema)',()=>{
 it('binds original facts and ranges, rejects stale/unauthorized requests, rolls back every stage and replays atomically',async()=>{
  const f=await bulkPreshrinkCorrectionFixture(url!);
  try{
   const sla=await legacyPreshrinkObservation(f),uncorrected=await sla.read(f.root,f.id);
   if(uncorrected.status!=='planned')throw Error('TEST requires the original enrolled plan');
   expect(uncorrected.evaluationPlan.nodes.find(n=>n.id==='warehouse_preshrink')?.applicable).toBe('yes');
   expect(uncorrected.facts.warehouse_preshrink?.evidence).toBe(`task:${f.target.preshrinkTaskId}`);
   const initialFootprint=await footprint(f);
   const tasks=new DigitalProductionTaskService(f.db),initial=await f.service.preview(f.root,f.id,f.target);
   expect(initial.target.instructionVersion).toBe(3);expect(initial.target.ranges.map(r=>[r.kind,r.version])).toEqual(expect.arrayContaining([['唛架完成',1],['纸样完成',1],['纸样完成',2]]));expect(initial.target.ranges).toHaveLength(3);
   expect((await f.service.preview(f.root,f.id,f.target)).expectedFingerprint).toBe(initial.expectedFingerprint);
   expect(await footprint(f)).toEqual(initialFootprint);
   await expect(f.service.preview(f.people.warehouse!,f.id,f.target)).rejects.toMatchObject({statusCode:403});
   await expect(f.service.preview({...f.people.warehouse!,actorRoles:['root_superuser']},f.id,f.target)).rejects.toMatchObject({statusCode:403});
   await expect(f.service.preview(f.root,randomUUID(),f.target)).rejects.toMatchObject({statusCode:409});
   await expect(f.service.preview(f.root,f.id,{...f.target,preshrinkTaskId:randomUUID()})).rejects.toMatchObject({statusCode:409});
   const input={target:initial.target,expectedFingerprint:initial.expectedFingerprint,reason:'TEST 原v3及原局部至全色事实的受限纠正'};
   await expect(f.service.apply(f.people.warehouse!,f.id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
   await expect(f.service.apply(f.root,f.id,{...input,target:{...input.target,patternFactId:randomUUID()}},randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(f.service.apply(f.root,f.id,{...input,target:{...input.target,sourceRound:input.target.sourceRound+1}},randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(f.service.apply(f.root,f.id,{...input,target:{...input.target,ranges:input.target.ranges.map((r,i)=>i? r:{...r,version:r.version+1})}},randomUUID())).rejects.toMatchObject({statusCode:409});
   await tasks.prioritize(f.root,f.target.preshrinkTaskId,'urgent',randomUUID());
   await expect(f.service.apply(f.root,f.id,input,randomUUID())).rejects.toMatchObject({statusCode:409});
   const preview=await f.service.preview(f.root,f.id,f.target),request={...input,target:preview.target,expectedFingerprint:preview.expectedFingerprint},key=randomUUID();
   const before=await footprint(f);
   for(const [table,when] of [
    ['digital_production_task_events',"NEW.event_kind='cancelled'"],['digital_production_event_intents',"NEW.event_kind='cancelled'"],
    ['digital_bulk_preparation_facts',"NEW.kind='无需预缩'"],['audit_events',"NEW.action='digital_bulk_preshrink_corrected'"],
    ['digital_bulk_preshrink_corrections','true'],['digital_bulk_preshrink_correction_ranges','true'],['digital_production_commands','true'],
   ] as const){
    await f.db.query(`CREATE FUNCTION test_preshrink_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST forced preshrink stage failure'; END $$;
     CREATE TRIGGER test_preshrink_rollback AFTER INSERT ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION test_preshrink_rollback()`);
    try{await expect(f.service.apply(f.root,f.id,request,key)).rejects.toThrow('TEST forced preshrink stage failure');}
    finally{await f.db.query(`DROP TRIGGER test_preshrink_rollback ON ${table}; DROP FUNCTION test_preshrink_rollback()`);}
    expect(await footprint(f)).toEqual(before);
   }
   const series=new SeriesPlanService(f.db,'TEST scoped preshrink series preview secret '.repeat(2));
   const version=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[f.id])).rows[0].version;
   const seriesInput={expectedOrderVersion:version,expectedPlanRevision:0,plannedShippingDate:'2027-02-15'};
   const oldSeries=await series.preview(f.root,f.id,seriesInput);
   const [result,replay]=await Promise.all([f.service.apply(f.root,f.id,request,key),f.service.apply(f.root,f.id,request,key)]);
   expect(replay).toEqual(result);
   const after=await footprint(f);
   for(const table of immutableTables)expect(after[table]).toEqual(before[table]);
   const originalIds=preview.basis.tasks.map(row=>row.task_id as string);
   expect((await f.db.query('SELECT * FROM digital_production_deadline_revisions WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,revision_id',[originalIds])).rows).toEqual(preview.basis.deadlines);
   expect((await f.db.query('SELECT * FROM production_order_node_clocks WHERE node_instance_id=ANY($1::uuid[]) ORDER BY node_instance_id',[originalIds])).rows).toEqual(preview.basis.clocks);
   const retired=(await f.db.query('SELECT * FROM digital_production_tasks WHERE task_id=$1',[f.target.preshrinkTaskId])).rows[0],original=preview.basis.tasks.find(t=>t.task_id===retired.task_id)!;
   expect(retired.state).toBe('cancelled');expect(retired.completed_at).toBeNull();expect(retired.entered_at).toEqual(original.entered_at);
   const linked=(await f.db.query(`SELECT c.*,e.event_kind,i.event_kind AS intent_kind,a.action FROM digital_bulk_preshrink_corrections c
    JOIN digital_production_task_events e ON e.event_id=c.cancellation_event_id JOIN digital_production_event_intents i ON i.event_id=e.event_id
    JOIN audit_events a ON a.id=c.audit_event_id WHERE c.preparation_id=$1`,[f.target.preparationId])).rows;
   expect(linked).toHaveLength(1);expect(linked[0]).toMatchObject({correction_id:result.correctionId,pattern_fact_id:preview.target.patternFactId,marker_fact_id:preview.target.markerFactId,event_kind:'cancelled',intent_kind:'cancelled',action:'digital_bulk_preshrink_corrected'});
   expect((await f.db.query('SELECT count(*)::int AS n FROM digital_bulk_preshrink_correction_ranges WHERE correction_id=$1',[result.correctionId])).rows[0].n).toBe(preview.target.ranges.length);
   expect((await f.bulk.read(f.root,f.id)).preshrink).toBe('无需预缩');expect((await bulkSlaEvidence(f.db,f.id)).preshrink).toBe('无需预缩');
   const correctedSla=await sla.read(f.root,f.id);
   if(correctedSla.status!=='planned')throw Error('TEST requires the original enrolled plan');
   expect(correctedSla.facts.warehouse_preshrink).toBeUndefined();
   expect(correctedSla.nodes.find(n=>n.id==='warehouse_preshrink')?.status).toBe('not_applicable');
   expect(correctedSla.evaluationPlan.nodes.find(n=>n.id==='bulk_cutting')?.dependsOn).not.toContain('warehouse_preshrink');
   expect(correctedSla.evaluationPlan.nodes.find(n=>n.id==='bulk_cutting')?.dependsOn).toContain('fabric_inspection');
   expect(correctedSla.history).toEqual(uncorrected.history);
   expect(correctedSla.facts.bulk_pattern).toEqual(uncorrected.facts.bulk_pattern);
   const readBefore=await footprint(f);await sla.read(f.root,f.id);expect(await footprint(f)).toEqual(readBefore);
   const detail=await tasks.read(f.root,f.patternId),summary=(await journeyTaskSummaries(f.db,[f.patternId,f.target.preshrinkTaskId])).get(f.patternId)!;
   expect(summary.routeProgress).toEqual(detail.routeProgress);expect(detail.routeProgress.cancelled).toBe(0);
   const journey=await new DigitalJourneyQuery(f.db).read(f.root,f.id),node=journey.stages.flatMap(s=>s.nodes).find(n=>n.instanceId===f.target.preshrinkTaskId)!;
   expect(node.state).toBe('not_applicable');expect(node.countsInProgress).toBe(false);expect(node.records.some(r=>r.id===f.target.preshrinkTaskId)).toBe(true);
   const compact=await new DigitalJourneyQuery(f.db).read(f.root,f.id,undefined,true);expect(compact.progress).toEqual(journey.progress);
   const cockpit=await new DigitalCockpitQuery(f.db).list(f.root,{page:1,search:preview.basis.order.design_style_no,stage:'bulk'});expect(cockpit.items.some(row=>row.orderId===f.id)).toBe(true);
   const newSeries=await series.preview(f.root,f.id,seriesInput);
   expect(newSeries.sourceRevisionSet.instructionRef).toMatchObject({preshrink:'无需预缩',correctionId:result.correctionId});
   await expect(series.apply(f.root,f.id,{...oldSeries.input,previewToken:oldSeries.previewToken,reason:'TEST reject pre-correction preview',acceptSuggestedDate:true},randomUUID())).rejects.toMatchObject({statusCode:409,message:'预览已变化或失效，请重新预览后应用'});
   await expect(tasks.complete(f.root,f.target.preshrinkTaskId,{note:'TEST stale legacy completion'},randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(f.bulk.complete(f.root,f.id,{preparationId:f.target.preparationId,kind:'预缩完成'},randomUUID())).rejects.toMatchObject({statusCode:409});
   const occurrence=Number((await f.db.query("SELECT coalesce(max(t.occurrence),0)+1 AS n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind='warehouse_preshrink'",[f.id])).rows[0].n);
   const client=await f.db.connect();try{await client.query('BEGIN');await expect(tasks.createWithClient(client,f.root,{resource:{kind:'order',id:f.id},kind:'warehouse_preshrink',routeId:f.target.preparationId,routeVersion:3,occurrence,assigneeId:f.people.warehouse!.actorId})).rejects.toMatchObject({statusCode:409,message:'本制单未要求预缩，不能创建预缩任务'});}finally{await client.query('ROLLBACK');client.release();}
   const beforeReplay=await footprint(f);expect(await f.service.apply(f.root,f.id,request,key)).toEqual(result);expect(await footprint(f)).toEqual(beforeReplay);
   await expect(f.service.apply(f.root,f.id,{...request,reason:'TEST changed payload'},key)).rejects.toMatchObject({statusCode:409});
   await expect(f.service.apply(f.root,f.id,request,randomUUID())).rejects.toMatchObject({statusCode:409});
   await f.db.query('UPDATE identity_mappings SET employed=false WHERE user_id=$1',[f.root.actorId]);
   try{await expect(f.service.apply(f.root,f.id,request,key)).rejects.toMatchObject({statusCode:403});}finally{await f.db.query('UPDATE identity_mappings SET employed=true WHERE user_id=$1',[f.root.actorId]);}
  }finally{await f.dispose();}
 },120000);

 it('preserves genuinely required preshrink and refuses a new general exemption',async()=>{
  const f=await bulkPreshrinkCorrectionFixture(url!,'需要预缩');
  try{
   const before=await footprint(f);await expect(f.service.preview(f.root,f.id,f.target)).rejects.toMatchObject({statusCode:409});expect(await footprint(f)).toEqual(before);
   const prep=(await f.db.query('SELECT * FROM digital_bulk_preparations WHERE preparation_id=$1',[f.target.preparationId])).rows[0];
   expect((await readBulkPreshrinkRequirement(f.db,prep)).requirement).toBe('需要预缩');
   await completeBulkRangeFixture(f.db,f.people.warehouse!,f.id,f.target.preparationId,'预缩完成');
   expect((await new DigitalProductionTaskService(f.db).read(f.root,f.target.preshrinkTaskId)).state).toBe('completed');
   const view=await (await legacyPreshrinkObservation(f)).read(f.root,f.id);
   if(view.status!=='planned')throw Error('TEST requires the original enrolled plan');
   expect(view.evaluationPlan.nodes.find(n=>n.id==='warehouse_preshrink')?.applicable).toBe('yes');
   expect(view.facts.warehouse_preshrink).toMatchObject({businessCompleted:true,evidence:`task:${f.target.preshrinkTaskId}`});
  }finally{await f.dispose();}
 },120000);

 it('refuses to erase actual preshrink completion even where the published v3 says no preshrink',async()=>{
  const f=await bulkPreshrinkCorrectionFixture(url!);
  try{
   const preview=await f.service.preview(f.root,f.id,f.target);
   await completeBulkRangeFixture(f.db,f.people.warehouse!,f.id,f.target.preparationId,'预缩完成');
   const before=await footprint(f);
   await expect(f.service.apply(f.root,f.id,{target:preview.target,expectedFingerprint:preview.expectedFingerprint,reason:'TEST no actual erasure'},randomUUID())).rejects.toMatchObject({statusCode:409});
   expect(await footprint(f)).toEqual(before);
   const view=await (await legacyPreshrinkObservation(f)).read(f.root,f.id);
   if(view.status!=='planned')throw Error('TEST requires the original enrolled plan');
   expect(view.evaluationPlan.nodes.find(n=>n.id==='warehouse_preshrink')?.applicable).toBe('yes');
   expect(view.facts.warehouse_preshrink).toMatchObject({businessCompleted:true,evidence:`task:${f.target.preshrinkTaskId}`});
  }finally{await f.dispose();}
 },120000);

 it('does not treat a standalone no-preshrink fact as a structured correction in the actual SLA reader',async()=>{
  const f=await bulkPreshrinkCorrectionFixture(url!);
  try{
   const sla=await legacyPreshrinkObservation(f);
   await f.db.query("INSERT INTO digital_bulk_preparation_facts(fact_id,preparation_id,kind,actor_id) VALUES($1,$2,'无需预缩',$3)",[randomUUID(),f.target.preparationId,f.root.actorId]);
   const before=await footprint(f),view=await sla.read(f.root,f.id);
   if(view.status!=='planned')throw Error('TEST requires the original enrolled plan');
   expect((await bulkSlaEvidence(f.db,f.id)).preshrinkCorrection).toBeNull();
   expect(view.evaluationPlan.nodes.find(n=>n.id==='warehouse_preshrink')?.applicable).toBe('yes');
   expect(view.facts.warehouse_preshrink?.evidence).toBe(`task:${f.target.preshrinkTaskId}`);
   expect(await footprint(f)).toEqual(before);
  }finally{await f.dispose();}
 },120000);

 it('retains the real fabric permission and waits for its original quality decision before cutting',async()=>{
  const f=await bulkPreshrinkCorrectionFixture(url!);
  try{
   const original=await f.service.preview(f.root,f.id,f.target),readiness=await productionReadiness(f.db,f.id),sheet=await f.bulk.read(f.root,f.id);
   await f.bulk.reportFabric(f.people.warehouse!,f.id,{expectedReportId:sheet.fabric!.report!.reportId,expectedReceiptVersion:readiness.receipt!.version,
    material:'TEST failed original fabric',arrivedAt:readiness.receipt!.occurredAt,inspectedAt:businessNow().toISOString(),result:'不合格',note:'TEST original quality gate remains required'},randomUUID());
   await expect(f.service.apply(f.root,f.id,{target:original.target,expectedFingerprint:original.expectedFingerprint,reason:'TEST stale fabric basis'},randomUUID())).rejects.toMatchObject({statusCode:409});
   const preview=await f.service.preview(f.root,f.id,f.target),fabric=(await f.bulk.read(f.root,f.id)).fabric,before=await footprint(f);
   await f.service.apply(f.root,f.id,{target:preview.target,expectedFingerprint:preview.expectedFingerprint,reason:'TEST correction does not grant fabric permission'},randomUUID());
   const corrected=await f.bulk.read(f.root,f.id),after=await footprint(f);
   expect(corrected.fabric).toEqual(fabric);expect(corrected.fabric!.usable).toBe(false);
   expect(corrected.tasks.some(task=>['bulk_cutting','bulk_cutting_external'].includes(task.taskKind))).toBe(false);
   for(const table of immutableTables)expect(after[table]).toEqual(before[table]);
   await f.bulk.decideFabric(f.root,f.id,{reportId:fabric!.report!.reportId,expectedDecisionId:fabric!.decision?.decisionId??null,allowUse:true,note:'TEST separate original quality authority'},randomUUID());
   const released=await f.bulk.read(f.root,f.id);expect(released.fabric!.usable).toBe(true);expect(released.tasks.some(task=>task.taskKind==='bulk_cutting')).toBe(true);
  }finally{await f.dispose();}
 },120000);

 it('rejects a preview whose published instruction has moved from the original v3',async()=>{
  const f=await bulkPreshrinkCorrectionFixture(url!);
  try{
   const preview=await f.service.preview(f.root,f.id,f.target),order=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[f.id])).rows[0];
   const document=(await f.db.query('SELECT document FROM digital_instruction_versions WHERE production_order_id=$1 AND version=3',[f.id])).rows[0].document;
   // Only this isolated conflict fixture advances the document; correction code never publishes a version.
   await f.instruction.save(f.people.merchandiser!,f.id,{expectedVersion:3,orderVersion:order.version,sourceRound:1,document:{...document,comments:'TEST later native instruction'}},randomUUID());
   await f.instruction.publish(f.people.merchandiser!,f.id,{expectedVersion:4,orderVersion:order.version,expectedReadinessRevision:(await productionReadiness(f.db,f.id)).revision},randomUUID());
   const before=await footprint(f);
   await expect(f.service.apply(f.root,f.id,{target:preview.target,expectedFingerprint:preview.expectedFingerprint,reason:'TEST reject changed published version'},randomUUID())).rejects.toMatchObject({statusCode:409});
   expect(await footprint(f)).toEqual(before);
  }finally{await f.dispose();}
 },120000);
});
