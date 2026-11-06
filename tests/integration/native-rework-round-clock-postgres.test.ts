import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {arrangeTestRound} from '../helpers/development-arrangement-fixture.js';
import {taskResult} from '../helpers/development-task-result-fixture.js';
import {ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import type {PatternOrderDetail} from '@dx-rework/contracts/pattern-orders';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('native rework and original digital revision share the order clock',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 const frames:Array<{mode:string;index:number;detail:PatternOrderDetail}>=[];
 beforeAll(async()=>{f=await businessAnchorFixture(url!);},120000);
 afterAll(async()=>{if(process.env.PR3_HISTORY_UI_INPUT&&frames.length===12)await writeFile(process.env.PR3_HISTORY_UI_INPUT,JSON.stringify({frames}));await f?.dispose();});
 for(const mode of ['past','current','future','ordinary'] as const)it(`${mode}: original plus two native reworks retain publication, 24h sewing, audit, attachments and wages`,async()=>{
  const at=new Date(Date.now()+(mode==='past'?-7:mode==='future'?7:0)*86400000).toISOString(),scene=mode==='ordinary'?null:await f.scene(at);
  const run=<T>(work:()=>Promise<T>)=>scene?f.runtime.run(scene,f.root,work):work();
  const worker={...f.people['pattern-room-worker']!,authorizationCapability:'pattern_room:orders:complete',authorizationCapabilities:['pattern_room:orders:complete','pattern_room:orders:view','digital_production:view']};
  const person=(await f.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active',[worker.actorId])).rows[0].person_id;
  const todos=new TodoProjectionService(new TodoService(f.db)),native=new PatternRoomOrderService(f.db,todos,{ordersEnabled:true}),execution=new DevelopmentExecutionService(f.db,true,native);
  const [created]=await run(()=>exerciseDevelopmentSlaNative(f.db,todos,f.root,worker.actorId,new ContextBusinessClock(f.db),[['无','免洗']]));
  const {sourceId,orderId}=created!;
  let order=await native.get(f.root,orderId);
  const ids=order.attachments.filter(file=>file.roundId===order.currentRoundId&&file.active).map(file=>file.attachmentId);
  const original=(await f.db.query('SELECT to_jsonb(d) AS snapshot FROM digital_development_documents d WHERE source_id=$1',[sourceId])).rows[0];
  const rounds:Array<{id:string;files:string[]}>= [{id:order.currentRoundId,files:[...ids]}];
  const snapshot=async(file:string)=>(await f.db.query(`SELECT jsonb_build_object(
   'order',(SELECT to_jsonb(o) FROM pattern_room_orders o WHERE order_id=$1),
   'rounds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY round_id) FROM pattern_room_rounds r WHERE order_id=$1),
   'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY round_id,attachment_id) FROM pattern_room_attachment_bindings b WHERE order_id=$1),
   'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY round_number) FROM digital_development_rounds r WHERE source_id=$2),
   'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY task_id) FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$2),
   'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM operation_events e WHERE entity_type='pattern_room_order' AND entity_id=$1::text),
   'file',(SELECT to_jsonb(a) FROM attachments a WHERE attachment_id=$3)) AS snapshot`,[orderId,sourceId,file])).rows[0].snapshot;
  for(let index=1;index<=2;index++){
   const file=await f.image(f.root),input={version:order.version,roundId:order.currentRoundId,reason:'TEST native seam correction',reasonCategory:'workmanship',attachmentIds:[file],developmentNodes:['车板'],developmentProblems:['车缝']};
   const unchanged=await snapshot(file);
   await expect(run(()=>native.requestRework(f.root,orderId,{...input,developmentNodes:['工艺']},randomUUID()))).rejects.toMatchObject({statusCode:409});
   expect(await snapshot(file)).toEqual(unchanged);
   await expect(run(()=>native.requestRework(f.people['development-clerk']!,orderId,input,randomUUID()))).rejects.toMatchObject({statusCode:403});
   expect(await snapshot(file)).toEqual(unchanged);
   const oldWages=(await f.db.query('SELECT to_jsonb(s) AS snapshot FROM pattern_room_segments s WHERE round_id=ANY($1::uuid[]) ORDER BY segment_id',[rounds.map(r=>r.id)])).rows;
   const key=randomUUID(),before=Date.now();order=await run(()=>native.requestRework(f.root,orderId,input,key));const after=Date.now();
   ids.push(file);rounds.push({id:order.currentRoundId,files:[...ids]});
   const revision=(await f.db.query('SELECT published_at FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,index+1])).rows[0];
   if(scene)expect(revision.published_at.toISOString()).toBe(at);else{expect(revision.published_at.getTime()).toBeGreaterThanOrEqual(before);expect(revision.published_at.getTime()).toBeLessThanOrEqual(after);}
   await run(()=>native.requestRework(f.root,orderId,input,key));
   await expect(run(()=>native.requestRework(f.root,orderId,input,randomUUID()))).rejects.toMatchObject({statusCode:409});
   expect((await f.db.query('SELECT count(*)::int n FROM digital_development_rounds WHERE source_id=$1',[sourceId])).rows[0].n).toBe(index);
   await run(()=>arrangeTestRound(f.db,execution,f.root,sourceId,worker.actorId));
   order=await native.get(f.root,orderId);order=await run(()=>native.assign(f.root,orderId,{version:order.version,roundId:order.currentRoundId,personId:person,amount:'0'},randomUUID()));
   const current=async(kind:string)=>(await run(()=>execution.read(f.root,sourceId))).tasks.find(t=>t.routeVersion===index+1&&t.taskKind===kind)!;
   const route=async(kind:string)=>{const task=await current(kind),actor=kind==='development_sewing'?worker:f.root;return run(async()=>execution.route(actor,sourceId,{taskId:task.taskId,result:'通过',note:'TEST native round completion',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,...(kind==='development_tail_check'?{measurements:[{name:'胸围',values:['50']}]}:{}),...(['development_sewing','development_tail_check'].includes(kind)?{attachmentIds:[await taskResult(f.db,execution,actor,sourceId,task.taskId,kind==='development_sewing'?'车板成果':'尾查照片')]}:{})},randomUUID()));};
   if((await current('development_sewing_transfer'))?.state==='ready')await route('development_sewing_transfer');
   const waiting=await current('development_sewing');
   if(waiting.state==='pending')await run(()=>new DigitalProductionTaskService(f.db).handover(worker,waiting.taskId,{note:'TEST actual receipt'},randomUUID()));
   const sewing=await current('development_sewing');expect(sewing.state).toBe('ready');expect(sewing.enteredAt).toBeTruthy();
   if(scene)expect(sewing.enteredAt).toBe(at);else expect(Date.parse(sewing.enteredAt!)).toBeGreaterThanOrEqual(before);
   expect(sewing.dueAt).toBe(new Date(Date.parse(sewing.enteredAt!)+24*3600000).toISOString());
   await route('development_sewing');await route('development_tail_check');await route('development_confirmation');order=await native.get(f.root,orderId);expect(order.status).toBe('completed');
   expect((await f.db.query('SELECT to_jsonb(s) AS snapshot FROM pattern_room_segments s WHERE round_id=ANY($1::uuid[]) ORDER BY segment_id',[rounds.slice(0,-1).map(r=>r.id)])).rows).toEqual(oldWages);
   expect(order.rounds.find(r=>r.roundId===order.currentRoundId)!.segments.every(s=>!s.wageEligible&&Number(s.amount)===0)).toBe(true);
  }
  for(const [index,round] of rounds.entries()){
   const detail=await native.get(f.root,orderId,{round:round.id,node:'completed'});expect(detail.attachments.map(file=>file.attachmentId).sort()).toEqual([...round.files].sort());expect(detail.historicalView).toMatchObject({missingFacts:false});expect(Object.values(detail.actions).every(value=>!value)).toBe(true);if(scene)expect(detail.rounds[0]!.completedAt).toBe(at);frames.push({mode,index,detail});
  }
  expect((await f.db.query('SELECT to_jsonb(d) AS snapshot FROM digital_development_documents d WHERE source_id=$1',[sourceId])).rows[0]).toEqual(original);
 },testExecutionConfig.correctnessTimeoutMs);
});
