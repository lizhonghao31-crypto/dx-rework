import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {DigitalTaskCompletionSchema} from '@dx-rework/contracts/digital-production-tasks';
import {installAcceptanceClockReader} from '../../apps/api/src/acceptance-clock/business-time.js';
import type {Pool} from 'pg';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original task completion precision, trust and correction evidence',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);});
 afterAll(async()=>{if(f)await f.dispose();});
 it('reads a native shipping date, preserves the original fact and follows exact unknown then verified corrections in task and Journey',async()=>{
  const tasks=new DigitalProductionTaskService(f.db),journeys=new DigitalJourneyQuery(f.db);
  const [made]=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,undefined,[['无','免洗']]);
  const execution=new DevelopmentExecutionService(f.db,true),sourceId=made!.sourceId,sheet=await execution.read(f.root,sourceId),shipping=sheet.tasks.find(task=>task.taskKind==='development_shipping')!,date=beijingCalendarDate(businessNow());
  const paper=sheet.tasks.find(task=>task.taskKind==='development_pattern')!,before=await tasks.read(f.root,paper.taskId);
  expect(before.actualCompletion).toMatchObject({precision:'instant',at:before.completedAt,quality:'verified'});
  await execution.route(f.root,sourceId,{taskId:shipping.taskId,result:'通过',note:'TEST actual shipping day',craftExecution:null,nextAssigneeId:null,sentDate:date,trackingNo:'TEST-SHIPPING-DATE'},randomUUID());
  const fact=(await f.db.query('SELECT fact_id,payload FROM digital_development_route_facts WHERE source_id=$1 AND task_id=$2 AND route_version=$3 ORDER BY sequence DESC LIMIT 1',[sourceId,shipping.taskId,shipping.routeVersion])).rows[0]!;
  const read=async()=>tasks.read(f.root,shipping.taskId),node=async(compact=false)=>(await journeys.read(f.root,sourceId,undefined,compact)).stages.flatMap(stage=>stage.nodes).find(value=>value.instanceId===shipping.taskId)!;
  const summaryNode=async(scope?:'development')=>{
   const list=await journeys.list(f.root,JourneyFilterSchema.parse({scope}),true,undefined,{details:false});
   return list.items.find(item=>item.id===sourceId)!.stages.flatMap(stage=>stage.nodes).find(value=>value.instanceId===shipping.taskId)!;
  };
  const dated=await read();expect(dated.completedAt).toBeNull();expect(DigitalTaskCompletionSchema.parse(dated.actualCompletion)).toMatchObject({precision:'date',date,at:null,quality:'unverified',sourceRef:`development-route-fact:${fact.fact_id}`});
  for(const compact of [false,true])expect(await node(compact)).toMatchObject({state:'completed',actualAt:null,actualDate:date,actualQuality:'unverified'});
  for(const scope of [undefined,'development'] as const)expect(await summaryNode(scope)).toMatchObject({state:'completed',actualAt:null,actualDate:date,actualQuality:'unverified'});
  const original=(await tasks.history(f.root,shipping.taskId)).events.find(event=>event.kind==='completed')!;
  await tasks.correctTime(f.root,shipping.taskId,{eventId:original.eventId,occurredAt:null,reason:'TEST original occurrence explicitly unknown'},randomUUID());
  expect((await read()).actualCompletion).toMatchObject({precision:'unknown',at:null,date:null,quality:'missing'});
  for(const compact of [false,true])expect(await node(compact)).toMatchObject({actualAt:null,actualDate:null,actualQuality:'missing'});
  for(const scope of [undefined,'development'] as const)expect(await summaryNode(scope)).toMatchObject({actualAt:null,actualDate:null,actualQuality:'missing'});
  const at=businessNow().toISOString();
  await tasks.correctTime(f.root,shipping.taskId,{eventId:original.eventId,occurredAt:at,reason:'TEST verify real shipping instant'},randomUUID());
  const verified=await read();expect(verified.completedAt).toBe(at);expect(verified.actualCompletion).toMatchObject({precision:'instant',at,date:null,quality:'verified'});
  for(const compact of [false,true])expect(await node(compact)).toMatchObject({actualAt:at,actualDate:null,actualQuality:'verified'});
  for(const scope of [undefined,'development'] as const)expect(await summaryNode(scope)).toMatchObject({actualAt:at,actualDate:null,actualQuality:'verified'});
  // Earlier observation must not erase the known future native instant and
  // turn a chronology contradiction into a merely missing timestamp.
  const scoped={query:f.db.query.bind(f.db),connect:f.db.connect.bind(f.db)} as unknown as Pool;
  installAcceptanceClockReader(scoped,{read:async()=>({now:new Date(Date.parse(at)-1).toISOString(),scenarioId:null,revision:0}),nativeScenario:async()=>null});
  const earlier=(await new DigitalJourneyQuery(scoped).read(f.root,sourceId,undefined,true)).stages.flatMap(stage=>stage.nodes).find(value=>value.instanceId===shipping.taskId)!;
  expect(earlier).toMatchObject({actualAt:at,actualDate:null,actualQuality:'verified'});
  expect((await f.db.query('SELECT fact_id,payload FROM digital_development_route_facts WHERE fact_id=$1',[fact.fact_id])).rows).toEqual([fact]);
  expect((await tasks.history(f.root,shipping.taskId)).events.filter(event=>event.kind==='completed')).toHaveLength(1);
  await expect(tasks.read({...f.people['pattern-room-worker']!,actorId:randomUUID()},shipping.taskId)).rejects.toMatchObject({statusCode:404});
 });
});
