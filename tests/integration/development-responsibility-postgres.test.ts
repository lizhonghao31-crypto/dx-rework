import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {developmentSlaEvidence} from '../../apps/api/src/production-platform/development-sla-evidence.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('development responsibility occurrence provenance on actual isolated schema',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);});afterAll(async()=>{await f?.dispose();});
 it('keeps unverified inner wash readiness unrated, preserves actual completion/history and restores only the explicitly verified original R',async()=>{
  const at='2027-01-07T22:53:30.123Z',scene=await f.scene(at),tasks=new DigitalProductionTaskService(f.db);
  await f.runtime.run(scene,f.root,async()=>{
   const [made]=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,{read:async()=>({now:businessNow().toISOString(),scenarioId:scene,revision:1})},[['无','内洗']],{fixedCraftSteps:[],routeActualTime:kind=>kind==='development_washing'?{precision:'instant',at}:undefined});
   const tail=(await f.db.query("SELECT t.task_id,t.entered_quality FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_tail_check'",[made!.sourceId])).rows[0]!;
   expect(tail.entered_quality).toBe('补报未核实');
   // A precisely scoped historical fixture represents the old synthetic revision.
   // No actual occurrence is fabricated and original events remain untouched.
   const revision=(await f.db.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by,sla_basis)
    SELECT task_id,policy_node_key,policy_version,$2,$2::timestamptz+interval '21 minutes',$2::timestamptz+interval '30 minutes','completion',event_id,changed_by,
    jsonb_set(jsonb_set(sla_basis,'{enteredAt}',to_jsonb($2::text)),'{timeQuality}','"现场登记"'::jsonb)-'timeQuality'
    FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id DESC LIMIT 1 RETURNING revision_id,entered_at,due_at,sla_basis`,[tail.task_id,at])).rows[0];
   const read=await tasks.read(f.root,tail.task_id);expect(read).toMatchObject({state:'completed',enteredAt:null,dueAt:null,completedAt:at});
   const observed=()=>({now:businessNow().toISOString(),scenarioId:scene,revision:1});
   const legacy=(await developmentSlaEvidence(f.db,made!.sourceId,observed()))!;
   expect(legacy.facts.development_tail_check).toMatchObject({businessCompleted:true,completedAt:at,completedDeadline:{at:null}});expect(legacy.facts.development_tail_check.startedAt).toBeUndefined();
   const journey=await new DigitalJourneyQuery(f.db).read(f.root,made!.sourceId,undefined,true),node=journey.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===tail.task_id)!;
   expect(node.actualAt).toBe(at);expect(node.timing?.status,JSON.stringify({key:node.key,current:node.current,supervision:journey.supervision?.nodes.filter(row=>row.id.includes('tail'))})).toBe('completed_unrated');expect(node.timing?.target.at).toBeNull();
   const washing=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_washing'",[made!.sourceId])).rows[0].task_id as string;
   const completedWash=(await tasks.history(f.root,washing)).events.find(event=>event.kind==='completed')!;
   const tailEventsBefore=(await tasks.history(f.root,tail.task_id)).events;
   // Verifying the source occurrence rebuilds its dependent window without
   // requiring another handover, changing the actual tail A or making ready.
   for(const occurredAt of [at,null]){
    await tasks.correctTime(f.root,washing,{eventId:completedWash.eventId,occurredAt,reason:'TEST verify only original upstream washing C'},randomUUID());
    expect(await tasks.read(f.root,tail.task_id)).toMatchObject({state:'completed',completedAt:at,enteredAt:occurredAt,dueAt:occurredAt?'2027-01-07T23:23:30.123Z':null});
    expect((await tasks.history(f.root,tail.task_id)).events).toEqual(tailEventsBefore);
    const currentFacts=(await developmentSlaEvidence(f.db,made!.sourceId,observed()))!.facts.development_tail_check;expect(currentFacts.startedAt??null).toBe(occurredAt);expect(currentFacts.completedAt).toBe(at);
    const derived=(await new DigitalJourneyQuery(f.db).read(f.root,made!.sourceId,undefined,true)).stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===tail.task_id)!;expect(derived.timing?.status).toBe(occurredAt?'completed_on_time':'completed_unrated');expect(derived.actualAt).toBe(at);
   }
   const ready=(await tasks.history(f.root,tail.task_id)).events.find(event=>event.kind==='ready')!;
   await expect(tasks.correctTime(f.people['pattern-room-worker']!,tail.task_id,{eventId:ready.eventId,occurredAt:at,reason:'TEST no authority'},randomUUID())).rejects.toMatchObject({statusCode:403});
   for(const value of [at,null,at]){
    const result=await tasks.correctTime(f.root,tail.task_id,{eventId:ready.eventId,occurredAt:value,reason:'TEST verify the actual original tail readiness only'},randomUUID());
    expect(await tasks.read(f.root,tail.task_id)).toMatchObject({enteredAt:value,dueAt:value?'2027-01-07T23:23:30.123Z':null,completedAt:at});
    const event=(await tasks.history(f.root,tail.task_id)).events.find(event=>event.eventId===result.eventId)!;expect(event).toMatchObject({kind:'time_corrected',correctsEventId:ready.eventId});expect(event.occurredAt===null?null:new Date(event.occurredAt).toISOString()).toBe(value);
   }
   await tasks.correctTime(f.root,washing,{eventId:completedWash.eventId,occurredAt:null,reason:'TEST independent verified own R is not replaced'},randomUUID());
   expect(await tasks.read(f.root,tail.task_id)).toMatchObject({enteredAt:at,dueAt:'2027-01-07T23:23:30.123Z',completedAt:at});
   // Concurrent authorized corrections retain both events and the actual
   // serialized row, rather than choosing transaction start time as truth.
   await Promise.all([null,at].map(occurredAt=>tasks.correctTime(f.root,tail.task_id,{eventId:ready.eventId,occurredAt,reason:'TEST concurrent original time verification'},randomUUID())));
   const current=(await f.db.query('SELECT entered_at FROM digital_production_tasks WHERE task_id=$1',[tail.task_id])).rows[0].entered_at as Date|null;
   expect((await tasks.read(f.root,tail.task_id)).enteredAt).toBe(current?.toISOString()??null);
   expect((await f.db.query('SELECT revision_id,entered_at,due_at,sla_basis FROM digital_production_deadline_revisions WHERE revision_id=$1',[revision.revision_id])).rows[0]).toEqual(revision);
  });
 });
});
