import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {developmentSlaEvidence} from '../../apps/api/src/production-platform/development-sla-evidence.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {orderTimeNativeTiming} from '../../apps/api/src/production-platform/order-time-native-timing.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('development responsibility occurrence provenance on actual isolated schema',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);});afterAll(async()=>{await f?.dispose();});
 it('keeps unverified inner wash readiness unrated, preserves actual completion/history and restores only the explicitly verified original R',async()=>{
  const began=performance.now(),phase=(name:string)=>console.info('RESPONSIBILITY_NATIVE_PHASE',JSON.stringify({case:'unverified-inner-wash',phase:name,elapsedMs:Math.round(performance.now()-began)}));phase('start');
  const at='2027-01-07T22:53:30.123Z',scene=await f.scene(at),tasks=new DigitalProductionTaskService(f.db);
  await f.runtime.run(scene,f.root,async()=>{
   const [made]=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,{read:async()=>({now:businessNow().toISOString(),scenarioId:scene,revision:1})},[['无','内洗']],{fixedCraftSteps:[],routeActualTime:kind=>kind==='development_washing'?{precision:'instant',at}:undefined});
   phase('native-route-complete');
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
   phase('source-corrections-and-reads-complete');
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
   expect((await f.db.query('SELECT revision_id,entered_at,due_at,sla_basis FROM digital_production_deadline_revisions WHERE revision_id=$1',[revision.revision_id])).rows[0]).toEqual(revision);phase('own-verification-concurrency-and-history-complete');
  });
 });
 it('retains the corrected causal start through real completion verification, order arrangement and later native revisions',async()=>{
  const began=performance.now(),phase=(name:string)=>console.info('RESPONSIBILITY_NATIVE_PHASE',JSON.stringify({case:'causal-R-persistence',phase:name,elapsedMs:Math.round(performance.now()-began)}));phase('start');
  const settings=new OrderTimeSettingsService(f.db,true,false),current=await settings.read(f.root);
  const nodes={...current.current.nodes};for(const [key,minutes] of Object.entries({development_materials:240,development_pattern:2880,development_cutting:240,development_sewing:1440,development_pre_wash_check:30,development_washing:1440,development_tail_check:30}))nodes[key]={...nodes[key]!,minutes};
  await settings.save(f.root,{expectedVersion:current.version,values:{...current.current,nodes}},randomUUID());
  const at='2027-01-08T20:00:00.000Z',scene=await f.scene(at),tasks=new DigitalProductionTaskService(f.db);let sourceId='',tailId='',washingId='';
  await f.runtime.run(scene,f.root,async()=>{
   const [made]=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,{read:async()=>({now:businessNow().toISOString(),scenarioId:scene,revision:1})},[['无','内洗']],{fixedCraftSteps:[]});sourceId=made!.sourceId;
   const rows=(await f.db.query("SELECT t.task_id,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind IN ('development_tail_check','development_washing')",[sourceId])).rows;
   tailId=rows.find(row=>row.task_kind==='development_tail_check')!.task_id;washingId=rows.find(row=>row.task_kind==='development_washing')!.task_id;
   expect(await tasks.read(f.root,tailId)).toMatchObject({enteredAt:at,dueAt:'2027-01-08T20:30:00.000Z'});
  });
  phase('native-route-complete');
  await f.advance(scene,'2027-01-08T22:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const tailC=(await tasks.history(f.root,tailId)).events.find(event=>event.kind==='completed')!,washingC=(await tasks.history(f.root,washingId)).events.find(event=>event.kind==='completed')!;
   await tasks.correctTime(f.root,tailId,{eventId:tailC.eventId,occurredAt:'2027-01-08T22:00:00.000Z',reason:'TEST verify actual later tail completion'},randomUUID());
   await tasks.correctTime(f.root,washingId,{eventId:washingC.eventId,occurredAt:'2027-01-08T21:00:00.000Z',reason:'TEST verify actual later upstream completion'},randomUUID());
   const expected={enteredAt:'2027-01-08T21:00:00.000Z',dueAt:'2027-01-08T21:30:00.000Z',completedAt:'2027-01-08T22:00:00.000Z'};
   expect(await tasks.read(f.root,tailId)).toMatchObject(expected);
   await tasks.correctTime(f.root,tailId,{eventId:tailC.eventId,occurredAt:'2027-01-08T22:00:00.000Z',reason:'TEST later verification cannot undo causal R'},randomUUID());
   expect(await tasks.read(f.root,tailId)).toMatchObject(expected);
   phase('source-and-completion-corrections-complete');
   const requests=new OrderTimeRequestService(f.db,orderTimeNativeExecutor(f.db,true)),resource={kind:'source' as const,id:sourceId},operation={kind:'arrangement' as const,resource};
   const overrides={development_tail_check:nodes.development_tail_check!},check=await requests.check(f.root,operation,overrides);
   await requests.arrange(f.root,{resource,fingerprint:check.fingerprint,overrides,acceptLate:true},randomUUID());
   const client=await f.db.connect();try{await client.query('BEGIN');await tasks.refreshDevelopmentDeadlineWithClient(client,f.root,tailId);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   expect(await tasks.read(f.root,tailId)).toMatchObject({...expected,slaHours:.5});
   const revisions=(await f.db.query('SELECT entered_at,sla_basis FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id DESC LIMIT 1',[tailId])).rows[0];expect(new Date(revisions.entered_at).toISOString()).toBe(expected.enteredAt);expect(revisions.sla_basis.seconds).toBe(1800);phase('arrangement-and-native-revision-complete');
  });
 });
 it('does not authenticate an earlier synthetic quota with a later ready event from the same task',async()=>{
  // Historical SQL fixture only: no live event/plan is rewritten. The original
  // order-time adapter below executes its real correlated evidence query.
  const original=(await f.db.query(`SELECT t.*,a.source_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   JOIN digital_order_time_plan_versions p ON p.source_id=a.source_id WHERE a.task_kind='development_tail_check' ORDER BY p.revision DESC LIMIT 1`)).rows[0];
  const at='2027-01-08T20:00:00.000Z',later='2027-01-08T21:00:00.000Z';
  for(const [index,proof] of [{readyAt:later,recordedAt:later,linked:false},{readyAt:at,recordedAt:later,linked:false},{readyAt:at,recordedAt:at,linked:false},{readyAt:at,recordedAt:at,linked:true}].entries()){
  const {readyAt,recordedAt,linked}=proof;
  const taskId=randomUUID(),eventId=randomUUID();
  await f.db.query(`INSERT INTO digital_production_task_access(task_id,task_kind,source_id,required_role,assignee_id,created_by)
   SELECT $1,task_kind,source_id,required_role,assignee_id,created_by FROM digital_production_task_access WHERE task_id=$2`,[taskId,original.task_id]);
  await f.db.query(`INSERT INTO digital_production_tasks(task_id,node_key,route_instance_id,route_version,occurrence) VALUES($1,'development_tail_check',$2,1,$3)`,[taskId,original.route_instance_id,999+index]);
  const prior=(await f.db.query('SELECT * FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id LIMIT 1',[original.task_id])).rows[0];
  const basis={...prior.sla_basis,enteredAt:at,seconds:28800,basis:['order-time:TEST old synthetic'],timeQuality:undefined};
  await f.db.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,recorded_at) VALUES($1,$2,'source',$3,'ready',$4,$5,'现场登记',$6)`,[eventId,taskId,original.source_id,f.root.actorId,readyAt,recordedAt]);
  await f.db.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,changed_by,sla_basis,changed_at,event_id)
   VALUES($1,$2,$3,$4,$4::timestamptz+interval '5 hours',$4::timestamptz+interval '8 hours','activation',$5,$6,$4,$7)`,[taskId,prior.policy_node_key,prior.policy_version,at,f.root.actorId,JSON.stringify(basis),linked?eventId:null]);
  const resolved=await orderTimeNativeTiming(f.db,{task_id:taskId,task_kind:'development_tail_check',source_id:original.source_id,production_order_id:null,order_time_managed:true,entered_quality:'现场登记'},
   {enteredAt:readyAt,seconds:900,warningRatio:.7,basis:[]},at,{at:readyAt,eventId:'TEST verified actual original R'});
  expect(resolved).toMatchObject({enteredAt:readyAt,seconds:linked?28800:1800});expect(resolved?.orderTimePlanRef).toBe(prior.sla_basis.orderTimePlanRef);
  }
 });

});
