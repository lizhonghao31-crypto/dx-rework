import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {SeriesPlanService} from '../../apps/api/src/production-platform/series-plan-service.js';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema,initialCustomerOrderInput} from '@dx-rework/contracts/digital-production';
import {SpecialCraftLibraryService} from '../../apps/api/src/production-platform/special-craft-library.js';
import type {OrderTimeOperation} from '@dx-rework/contracts/order-time-requests';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {OrderTimeScopeRecoveryService} from '../../apps/api/src/production-platform/order-time-scope-recovery.js';
import {readInitialTimelineInput} from '../../apps/api/src/production-platform/fixed-timeline-initial-input.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {TodoTimingService} from '../../apps/api/src/todos/timing-service.js';
import {OperationEventRepository} from '../../apps/api/src/tools/repositories.js';
import * as sourcingTiming from '../../apps/api/src/production-platform/sourcing-todo-sla.js';
import {orderTimeTodos} from '../../apps/api/src/production-platform/order-time-todos.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {arrangementInput} from '../helpers/development-arrangement-fixture.js';
import {publishedTechnicalFixture} from '../helpers/development-technical-fixture.js';
import {taskResult} from '../helpers/development-task-result-fixture.js';
import {slaNotificationPreferences} from '../../apps/api/src/production-platform/sla-notification-preferences.js';
import {DigitalPoDateRepository} from '../../apps/api/src/production-platform/po-date-repository.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {materialInvestmentRiskHistory} from '../../apps/api/src/production-platform/material-investment-risk-history.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {PoCustomerDateService} from '../../apps/api/src/production-platform/po-customer-date-service.js';
import {productionReadinessFixture} from '../helpers/production-readiness-fixture.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('R5 native first-effective order time and one request transaction',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,identity:DigitalProductionIdentityService,forms:DigitalDevelopmentService,requests:OrderTimeRequestService,standardId:string,native:PatternRoomOrderService;
 const make=async(date:string|null,withMaterial=false,washing:'免洗'|'内洗'|'外洗'='免洗')=>{
  const original=f.people['sample-designer']!,actor={...original,authorizationCapabilities:[...original.authorizationCapabilities!,'pattern_room:orders:view']},source=await identity.createSource(actor,{developmentType:'头版',designStyleNo:'TEST-R507-'+randomUUID(),temporaryStyleNo:null,customerCode:null},randomUUID());
  const material=withMaterial?{materialId:randomUUID(),category:'主布',label:'TEST主布',supplier:'TEST',name:'TEST 已备主布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}:null;
  const photo=await f.image(actor),document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:date,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST original business source',craft:'无',washing,materials:material?[material]:[],files:[{attachmentId:photo,kind:'款图'}]});
  const sheet=await forms.save(actor,source.sourceId,{expectedVersion:0,document},randomUUID()),price=(await f.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0];
  const operation:OrderTimeOperation={kind:'development_publish',sourceId:source.sourceId,input:{expectedVersion:sheet.version,patternOrder:{categoryId:price.price_id,priceVersion:price.version}}};
  return {sourceId:source.sourceId,photo,operation,actor,material};
 };
 const submit=async(row:Awaited<ReturnType<typeof make>>)=>{const check=await requests.check(row.actor,row.operation);return requests.submit(row.actor,{operation:row.operation,fingerprint:check.fingerprint,reason:'TEST 按实际工艺申请本单调整'},randomUUID());};
 const compress=(state:Awaited<ReturnType<typeof submit>>)=>Object.fromEntries(state.check.rows.flatMap(row=>row.rule&&['work','included','forecast'].includes(row.rule.kind)?[[row.parameterKey,{...row.rule,minutes:row.rule.kind==='included'?2:10} as OrderTimeRule]]:[]));
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);identity=new DigitalProductionIdentityService(f.db,true);
  native=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});forms=new DigitalDevelopmentService(f.db,true,native);requests=new OrderTimeRequestService(f.db,orderTimeNativeExecutor(f.db,true,native));
  // These cases exercise orders frozen under the pre-framework company version.
  // Explicit historical setup avoids silently publishing a different standard.
  const standard=await new OrderTimeSettingsService(f.db,true,false).save(f.root,{expectedVersion:0,values:r5OneHourConfiguration()},randomUUID());standardId=standard.record.id;
  expect((await f.db.query("SELECT current_setting('is_superuser') AS value")).rows[0].value).toBe('off');
 });
 afterAll(async()=>{await f?.dispose();});
 it.each(['内洗','外洗'] as const)('reads the adopted source washing duration for %s without rewriting enrollment or native clocks',async washing=>{
  const scene=await f.scene('2027-01-04T00:00:00.000Z');
  const sourceId=await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-01-20',false,washing);if(row.operation.kind!=='development_publish')throw Error('TEST source operation');
   await forms.publish(row.actor,row.sourceId,1,randomUUID(),row.operation.input.patternOrder);
   const resource={kind:'source' as const,id:row.sourceId},operation={kind:'arrangement' as const,resource};
   const journey=new DigitalJourneyQuery(f.db),repo=new OrderTimePlanRepository(f.db);
   const read=()=>journey.read(f.root,row.sourceId,undefined,true);
   const washingTiming=(item:Awaited<ReturnType<typeof read>>)=>item.supervision!.nodes.find(node=>node.id==='development_washing')!;
   const taskService=new DigitalProductionTaskService(f.db);
   const snapshot=async()=>({
    enrollment:(await f.db.query('SELECT revision,plan_json FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision',[row.sourceId])).rows,
    tasks:await Promise.all((await f.db.query('SELECT task_id FROM digital_production_task_access WHERE source_id=$1 ORDER BY task_id',[row.sourceId])).rows.map(async ({task_id})=>{
     const {enteredAt,dueAt,completedAt}=await taskService.read(f.root,task_id);return {task_id,enteredAt,dueAt,completedAt};
    })),
   });
   const first=(await repo.current(resource))!,before=await read(),original=washingTiming(before);
   expect(first.input.work.find(work=>work.id===original.id)?.canonicalWorkRef).toBe(`source:${row.sourceId}:round:1:work:${original.id}`);
   expect(original).toMatchObject({actualStart:null,actualEnd:null,forecastBasis:'plan'});
   expect(original.current.at).toBe('2027-01-04T06:00:00.000Z');
   expect(original.forecast.at).toBe('2027-01-04T06:00:00.000Z');
   const frozen=await snapshot(),rule=first.input.plan.company.nodes.development_washing!;
   if(rule.kind!=='work')throw Error('TEST washing work rule');
   const overrides={development_washing:{...rule,minutes:rule.minutes+1440}};
   const preview=await requests.check(f.root,operation,overrides);
   await requests.arrange(f.root,{resource,overrides,fingerprint:preview.fingerprint,acceptLate:false},randomUUID());
   const adopted=(await repo.current(resource))!,after=await read(),actual=washingTiming(after);
   expect(adopted.revision).toBe(first.revision+1);
   expect(adopted.input.work.find(work=>work.id==='development_washing_dispatch')?.includedIn).toBe(original.id);
   expect(await snapshot()).toEqual(frozen);
   expect(actual).toMatchObject({original:original.original,actualStart:null,actualEnd:null,target:original.target,forecastBasis:'plan'});
   // Five predecessor hours, then 25 hours of wash time. The included
   // 30 minute dispatch stays inside washing and never extends the route.
   expect(actual.current.at).toBe('2027-01-05T06:00:00.000Z');
   expect(actual.forecast.at).toBe('2027-01-05T06:00:00.000Z');
   expect(after.supervision!.nodes.find(node=>node.id==='development_washing_dispatch')?.current.at).toBe('2027-01-04T05:30:00.000Z');
   expect(after.supervision!.currentRevision).toBe(adopted.revision);
   expect(after.stages.flatMap(stage=>stage.nodes).find(node=>node.current&&node.key==='development_washing')?.timing).toEqual(actual);
   return row.sourceId;
  });
  await f.advance(scene,'2027-01-05T07:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const after=await new DigitalJourneyQuery(f.db).read(f.root,sourceId,undefined,true);
   expect(after.supervision!.nodes.find(node=>node.id==='development_washing')).toMatchObject({
    current:{at:'2027-01-05T06:00:00.000Z'},forecast:{at:null},forecastBasis:'unknown',actualStart:null,actualEnd:null,
   });
  });
 });
 it('publishes an undated independent sample with real node quotas and no invented promise, while retaining required-input guards',async()=>{
  const scene=await f.scene('2027-01-08T00:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make(null),checked=await requests.check(row.actor,row.operation);
   expect(checked).toMatchObject({feasibility:'not_applicable',availableMinutes:null,lateMinutes:null,requiredMinutes:300,customerDates:[{po:'样板',date:null}],coverage:[]});
   const key=randomUUID(),sheet=await forms.publish(row.actor,row.sourceId,1,key,row.operation.kind==='development_publish'?row.operation.input.patternOrder:undefined);
   expect(sheet).toMatchObject({status:'published',document:{returnDate:null}});
   expect((await forms.publish(row.actor,row.sourceId,1,key,row.operation.kind==='development_publish'?row.operation.input.patternOrder:undefined)).version).toBe(sheet.version);
   const task=await new DigitalProductionTaskService(f.db).read(row.actor,sheet.taskId!);
   expect(task).toMatchObject({slaHours:1,enteredAt:'2027-01-08T00:00:00.000Z',dueAt:'2027-01-08T01:00:00.000Z'});
   const saved=(await new OrderTimePlanRepository(f.db).current({kind:'source',id:row.sourceId}))!;
   expect(saved.input.scopes[0]!.customerGoal.precision).toBe('unknown');
   expect(Object.values(saved.targets).flatMap(scope=>Object.values(scope)).every(target=>target.start.at===null&&target.end.at===null)).toBe(true);
   expect((await f.db.query("SELECT after_state FROM audit_events WHERE entity_id=$1 AND action='order_time_activated'",[row.sourceId])).rows[0].after_state.lateMinutes).toBeNull();
   expect((await f.db.query('SELECT 1 FROM digital_order_time_requests WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
   const missing=await make(null,true),before=await forms.read(missing.actor,missing.sourceId);
   const document={...before.document!,materials:before.document!.materials.map(material=>({...material,available:false,expectedDate:null}))};
   const draft=await forms.save(missing.actor,missing.sourceId,{expectedVersion:before.version,document},randomUUID());
   await expect(forms.publish(missing.actor,missing.sourceId,draft.version,randomUUID(),missing.operation.kind==='development_publish'?missing.operation.input.patternOrder:undefined)).rejects.toMatchObject({code:'ORDER_TIME_INPUT_REQUIRED'});
   expect((await forms.read(missing.actor,missing.sourceId)).status).toBe('draft');
   const unknownPo=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',requiresColorMatching:false,designStyleNo:'TEST-missing-client-date-'+randomUUID(),orderDate:'2027-01-08',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-Po-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:null,sizes:[{size:'M',quantity:1}]}]});
   expect((await requests.check(row.actor,{kind:'direct_order',input:unknownPo,route:{craftSteps:[],preshrink:false}})).feasibility).toBe('unknown');
  });
 });
 it('delivers one captured pre-deadline reminder through the real bounded todo scheduler, preserving later reminder counters and mute',async()=>{
  const scene=await f.scene('2027-01-06T00:00:00.000Z');let sourceId='',todoId='';
  await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-01-10');sourceId=row.sourceId;
   const client=await f.db.connect();
   try{
    await client.query('BEGIN');const event=await new OperationEventRepository().append(client,f.root,{action:'todo.create',entityType:'digital_production_source',entityId:sourceId});
    // Controlled SLA adapter input; creation, locks, SQL selection, recipient
    // revalidation, immutable events and outbox below are the real PG services.
    const timing=vi.spyOn(sourcingTiming,'sourcingTodoSla').mockResolvedValue({dueAt:new Date('2027-01-06T01:00:00.000Z'),snapshotId:null,orderTime:{version:1,eventRef:event,planRef:'TEST captured original',enteredAt:'2027-01-06T00:00:00.000Z',minutes:60,calendarRef:'continuous',warningAt:'2027-01-06T00:30:00.000Z',warningPercent:50,notificationEnabled:true}});
    try{
     const input={todoType:'business_action' as const,category:'TEST R507 warning',sourceEventId:event,sourceAction:'todo.create',entityType:'digital_production_source',entityId:sourceId,recipientUserId:f.people.owner!.actorId,requiredRole:'owner_group',requiredCapability:'sourcing:owner:approve',policyKey:'general' as const,route:{routeName:'production_detail' as const,entityId:sourceId},dedupeKey:'TEST R507 '+event};
     todoId=(await new TodoService(f.db).createInTransaction(client,f.root,input))!.todoId;
     const captured=await sourcingTiming.sourcingTodoSla(client,{category:input.category,entityType:input.entityType,entityId:sourceId,sourceEventId:event});
     timing.mockResolvedValue({...captured!,orderTime:{...captured!.orderTime!,notificationEnabled:false,eventRef:event+':muted'}});
     await new TodoService(f.db).createInTransaction(client,f.root,{...input,category:'TEST R507 muted warning',dedupeKey:input.dedupeKey+':muted'});
    }finally{timing.mockRestore();}
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   expect((await new TodoTimingService(f.db).runOnce(f.root)).reminders).toBe(0);
  });
  await f.advance(scene,'2027-01-06T00:30:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   expect((await new TodoTimingService(f.db).runOnce(f.root)).reminders).toBe(1);
   expect((await new TodoTimingService(f.db).runOnce(f.root)).reminders).toBe(0);
   expect((await f.db.query('SELECT reminder_count FROM rework_todos WHERE todo_id=$1',[todoId])).rows[0].reminder_count).toBe(0);
   expect((await f.db.query("SELECT count(*)::int AS count FROM operation_events WHERE entity_id=$1 AND action='todo.remind' AND after_state->>'stage'='warning'",[todoId])).rows[0].count).toBe(1);
  });
  await f.advance(scene,'2027-01-06T01:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   // Pre-warning does not consume the separate existing overdue allowance.
   expect((await new TodoTimingService(f.db).runOnce(f.root)).reminders).toBe(2);
   expect((await f.db.query('SELECT reminder_count FROM rework_todos WHERE todo_id=$1',[todoId])).rows[0].reminder_count).toBe(1);
  });
 });
 it('keeps a new draft inactive, then adopts one company counterpart and real native task quota only at sufficient publication',async()=>{
  const scene=await f.scene('2027-01-07T00:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-01-10');expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=$1',[row.sourceId])).rows[0].effective).toBe(false);
   expect((await f.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
   const checked=await requests.check(row.actor,row.operation);expect(checked).toMatchObject({feasibility:'sufficient',requiredMinutes:300});
   const published=await forms.publish(row.actor,row.sourceId,row.operation.kind==='development_publish'?row.operation.input.expectedVersion:0,randomUUID(),row.operation.kind==='development_publish'?row.operation.input.patternOrder:undefined);
   const saved=await new OrderTimePlanRepository(f.db).current({kind:'source',id:row.sourceId});expect(saved?.input.plan.company.reference).toBe('order-time-company:'+standardId);
   const task=await new DigitalProductionTaskService(f.db).read(row.actor,published.taskId!);expect(task.slaHours).toBe(1);expect(task.enteredAt).toBe('2027-01-07T00:00:00.000Z');expect(task.dueAt).toBe('2027-01-07T01:00:00.000Z');
   expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=$1',[row.sourceId])).rows[0].effective).toBe(true);
  });
 });
 it('keeps an insufficient source inactive and lets the genuine director apply a fifty-minute per-order plan once without designer reconfirmation',async()=>{
  const scene=await f.scene('2027-01-07T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-01-07');
   await expect(forms.publish(row.actor,row.sourceId,1,randomUUID(),row.operation.kind==='development_publish'?row.operation.input.patternOrder:undefined)).rejects.toMatchObject({code:'ORDER_TIME_REQUEST_REQUIRED'});
   expect((await f.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
   const request=await submit(row);expect(request.check).toMatchObject({requiredMinutes:300,availableMinutes:60,lateMinutes:240});
   for(const approver of [f.root,f.people.owner!,f.people['production-management']!])expect((await orderTimeTodos(f.db,approver)).some(todo=>todo.todoId===request.requestId)).toBe(true);
   expect((await orderTimeTodos(f.db,f.people['pattern-room-worker']!)).some(todo=>todo.todoId===request.requestId)).toBe(false);
   const manager=f.people['production-management']!,overrides=compress(request),preview=await requests.read(manager,request.requestId,overrides);
   expect(preview.check).toMatchObject({feasibility:'sufficient',requiredMinutes:50});
   const body={expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides,acceptLate:false},key=randomUUID(),applied=await requests.apply(manager,request.requestId,body,key);
   expect(applied).toMatchObject({state:'applied',appliedBy:{id:manager.actorId},requestedBy:{id:row.actor.actorId}});
   expect(await requests.apply(manager,request.requestId,body,key)).toEqual(applied);
   expect((await orderTimeTodos(f.db,f.root)).some(todo=>todo.todoId===request.requestId)).toBe(false);
   expect((await f.db.query('SELECT 1 FROM digital_development_pattern_links WHERE source_id=$1',[row.sourceId])).rowCount).toBe(1);
   const taskId=(await f.db.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_materials'",[row.sourceId])).rows[0].task_id;
   expect(await new DigitalProductionTaskService(f.db).read(row.actor,taskId)).toMatchObject({slaHours:1/6,dueAt:'2027-01-07T15:10:00.000Z'});
   expect((await new OrderTimePlanRepository(f.db).current({kind:'source',id:row.sourceId}))?.input.plan.company.reference).toBe('order-time-company:'+standardId);
   await expect(forms.publish(manager,row.sourceId,1,randomUUID(),row.operation.kind==='development_publish'?row.operation.input.patternOrder:undefined)).rejects.toMatchObject({statusCode:403});
  });
 });
 it('requires explicit late confirmation, retains the real risk and preserves the original draft and key after an unknown receipt',async()=>{
  const scene=await f.scene('2027-01-07T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-01-07'),request=await submit(row),manager=f.people['production-management']!,preview=await requests.read(manager,request.requestId);
   const base={expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{}};
   await expect(requests.apply(manager,request.requestId,{...base,acceptLate:false},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_LATE_CONFIRMATION'});
   expect((await requests.read(row.actor,request.requestId)).state).toBe('pending');expect((await f.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
   const body={...base,acceptLate:true},key=randomUUID(),first=await requests.apply(manager,request.requestId,body,key);
   expect(first.result?.lateMinutes).toBe(240);expect(first.state).toBe('applied');expect(await requests.apply(manager,request.requestId,body,key)).toEqual(first);
   expect((await f.db.query('SELECT 1 FROM digital_development_pattern_links WHERE source_id=$1',[row.sourceId])).rowCount).toBe(1);
   expect((await forms.read(row.actor,row.sourceId)).document?.files).toEqual([{attachmentId:row.photo,kind:'款图'}]);
  });
 });
 it('returns and withdraws the same saved proposal without losing files, then rechecks elapsed approval time on designer resubmission',async()=>{
  const scene=await f.scene('2027-02-01T15:00:00.000Z');let row:Awaited<ReturnType<typeof make>>,id:string;
  await f.runtime.run(scene,f.root,async()=>{
   row=await make('2027-02-01');const requested=await submit(row);id=requested.requestId;
   const returned=await requests.close(f.people['production-management']!,id,{expectedVersion:requested.version,reason:'TEST 原单保留，先核实安排'},randomUUID(),'returned');
   expect(returned).toMatchObject({state:'returned',returnReason:'TEST 原单保留，先核实安排'});
   const withdrawn=await requests.close(row.actor,id,{expectedVersion:returned.version},randomUUID(),'withdrawn');expect(withdrawn.state).toBe('withdrawn');
   expect((await forms.read(row.actor,row.sourceId)).document?.files).toEqual([{attachmentId:row.photo,kind:'款图'}]);
  });
  await f.advance(scene,'2027-02-02T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const latest=await requests.read(row!.actor,id!),again=await requests.resubmit(row!.actor,id!,{expectedVersion:latest.version,operation:latest.operation,fingerprint:latest.check.fingerprint,reason:'TEST 按最新资料接续原申请'},randomUUID());
   expect(again.requestId).toBe(id!);expect(again.state).toBe('pending');expect(again.check.lateMinutes).toBe(1680);
   expect((await forms.read(row!.actor,row!.sourceId)).developmentCreatedDate).toBe('2027-02-01');
   expect((await f.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[row!.sourceId])).rowCount).toBe(0);
   const manager=f.people['production-management']!,preview=await requests.read(manager,id!);
   await requests.apply(manager,id!,{expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const material=(await f.db.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_materials'",[row!.sourceId])).rows[0];
   expect(await new DigitalProductionTaskService(f.db).read(f.root,material.task_id)).toMatchObject({enteredAt:'2027-02-02T15:00:00.000Z',dueAt:'2027-02-02T16:00:00.000Z'});
   const journey=await new DigitalJourneyQuery(f.db).read(f.root,row!.sourceId,undefined,true);
   expect(journey.fixedSchedule?.durationSummary).toMatchObject({actualStart:{precision:'instant',at:'2027-02-01T15:00:00.000Z'},elapsedSpanMinutes:{minimum:1440,maximum:1440},planSpanMinutes:300,finalActualSpanMinutes:null});
   expect(journey.fixedSchedule?.scopes[0]?.nodes.find(node=>node.canonicalWorkRef==='creation:source:'+row!.sourceId)).toMatchObject({businessCompleted:true});
  });
 });
 it('lets only one current manager finish a pending request while another stale decision cannot duplicate native business',async()=>{
  const scene=await f.scene('2027-02-03T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-02-03'),request=await submit(row),manager=f.people['production-management']!,preview=await requests.read(manager,request.requestId),body={expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:true};
   const settled=await Promise.allSettled([requests.apply(manager,request.requestId,body,randomUUID()),requests.apply(f.root,request.requestId,body,randomUUID())]);
   expect(settled.filter(value=>value.status==='fulfilled')).toHaveLength(1);expect(settled.filter(value=>value.status==='rejected')).toHaveLength(1);
   expect((settled.find(value=>value.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'ORDER_TIME_STALE'});
   expect((await f.db.query('SELECT 1 FROM digital_development_pattern_links WHERE source_id=$1',[row.sourceId])).rowCount).toBe(1);
  });
 });
 it('inherits an independent development policy and its fixed goals when confirming real POs after the company standard changes',async()=>{
  const scene=await f.scene('2027-03-01T00:00:00.000Z');let row:Awaited<ReturnType<typeof make>>,original:NonNullable<Awaited<ReturnType<OrderTimePlanRepository['current']>>>;
  await f.runtime.run(scene,f.root,async()=>{
   row=await make('2027-03-10',true);if(row.operation.kind!=='development_publish')throw Error('TEST source operation');
   await forms.publish(row.actor,row.sourceId,row.operation.input.expectedVersion,randomUUID(),row.operation.input.patternOrder);
   original=(await new OrderTimePlanRepository(f.db).current({kind:'source',id:row.sourceId}))!;
  });
  const changed=r5OneHourConfiguration();for(const rule of Object.values(changed.nodes))if(rule.minutes&&rule.kind!=='included')rule.minutes*=2;
  await new OrderTimeSettingsService(f.db,true,false).save(f.root,{expectedVersion:1,values:changed},randomUUID());
  await f.advance(scene,'2027-03-01T00:30:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const sheet=await forms.read(row!.actor,row!.sourceId),input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:sheet.designStyleNo,orderDate:'2027-03-01',productionPlanning:{craftSteps:[],preshrink:false},lines:[{formalPoNo:'TEST-R507-FORMAL-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-03-31',sizes:[{size:'M',quantity:1}]}]});
   const order=await identity.createOrder(row!.actor,input,randomUUID(),row!.sourceId),saved=(await new OrderTimePlanRepository(f.db).current({kind:'order',id:order.productionOrderId}))!;
   const sample=(await f.db.query("SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_ship_sample'",[order.productionOrderId])).rows[0];
   expect(await new DigitalProductionTaskService(f.db).read(f.root,sample.task_id)).toMatchObject({dueAt:'2027-03-21T16:00:00.000Z',enteredAt:null});
   expect(saved.input.plan.company.reference).toBe('order-time-company:'+standardId);expect(saved.input.plan.company.nodes.development_materials!.minutes).toBe(60);
   const oldTargets=Object.values(original!.targets)[0]!,newTargets=Object.values(saved.targets)[0]!;
   let retained=0;for(const work of original!.input.work){const same=saved.input.work.find(next=>next.canonicalWorkRef===work.canonicalWorkRef);
    if(same){expect(newTargets[same.id]).toEqual({...oldTargets[work.id],id:same.id});retained++;}
    else expect(work.parameterKey).toBe('development_shipping');
   }expect(retained).toBeGreaterThanOrEqual(5);
   expect((await forms.read(row!.actor,row!.sourceId)).developmentCreatedDate).toBe('2027-03-01');
   const operation={kind:'arrangement' as const,resource:{kind:'order' as const,id:order.productionOrderId}},overrides={development_pattern:{kind:'work' as const,minutes:120,calendar:'continuous' as const,reminder:{enabled:true,percent:80}}};
   const check=await requests.check(f.root,operation,overrides),body={resource:operation.resource,overrides,fingerprint:check.fingerprint,acceptLate:false},key=randomUUID();
   await requests.arrange(f.root,body,key);await requests.arrange(f.root,body,key);
   const inherited=(await new OrderTimePlanRepository(f.db).current({kind:'source',id:row!.sourceId}))!;
   expect(inherited.input.plan.overrides.development_pattern).toEqual(overrides.development_pattern);
   expect(inherited.input.plan.company.nodes.development_pattern!.minutes).toBe(60);expect(inherited.revision).toBe(2);
   const execute=new DevelopmentExecutionService(f.db,true),clerk=f.people['development-clerk']!,worker=f.people['pattern-room-worker']!.actorId,state=await execute.read(f.root,row!.sourceId),material=state.tasks.find(task=>task.taskKind==='development_materials')!,verification=state.materialVerification!;
   await execute.configureFixedCutting(f.root,row!.sourceId,{expectedVersion:state.fixedCutting!.version,assigneeId:worker,reason:'TEST 原固定裁板配置'},randomUUID());
   const items=[{materialId:row!.material!.materialId,physical:true,quantity:true,color:true,specification:true}];
   await execute.saveMaterials(clerk,row!.sourceId,{taskId:material.taskId,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:items.map(item=>({...item,usage:'use',note:'',confirmedWith:''})),note:'TEST 本单物料齐备',result:'通过'},randomUUID());
   await execute.check(clerk,row!.sourceId,{taskId:material.taskId,expectedVerificationVersion:verification.version+1,result:'通过',note:'TEST 本单物料齐备',items},randomUUID());
   await execute.arrange(clerk,row!.sourceId,await arrangementInput(f.db,execute,clerk,row!.sourceId,worker),randomUUID());
   expect((await execute.read(f.root,row!.sourceId)).tasks.find(task=>task.taskKind==='development_pattern')).toMatchObject({slaHours:2,enteredAt:'2027-03-01T00:30:00.000Z',dueAt:'2027-03-01T02:30:00.000Z'});
   expect(await new DigitalProductionTaskService(f.db).read(f.root,material.taskId)).toMatchObject({slaHours:1,enteredAt:'2027-03-01T00:00:00.000Z',dueAt:'2027-03-01T01:00:00.000Z'});
  });
 });
 it('refreshes native per-PO ship-sample deadlines inside a manager-approved first formal activation',async()=>{
  const scene=await f.scene('2027-08-01T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const designer=f.people['sample-designer']!,input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-R507-APPLIED-'+randomUUID(),orderDate:'2027-08-01',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-R507-SAMPLE-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-08-01',sizes:[{size:'M',quantity:1}]},{formalPoNo:'TEST-R507-SAMPLE-'+randomUUID(),color:'白',customerWarehouseArrivalDate:'2027-08-02',sizes:[{size:'M',quantity:1}]}]}),operation={kind:'direct_order' as const,input,route:{craftSteps:[],preshrink:false}};
   const checked=await requests.check(designer,operation);expect(checked.feasibility,JSON.stringify({coverage:checked.coverage,rows:checked.rows.map(row=>[row.parameterKey,row.rule])})).toBe('insufficient');const requested=await requests.submit(designer,{operation,fingerprint:checked.fingerprint,reason:'TEST 两PO真实路线时间不足'},randomUUID()),manager=f.people.owner!,preview=await requests.read(manager,requested.requestId),body={expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:true},key=randomUUID(),applied=await requests.apply(manager,requested.requestId,body,key),orderId=applied.result!.orderId!;
   const taskId=(await f.db.query("SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_ship_sample'",[orderId])).rows[0].task_id;
   expect(await new DigitalProductionTaskService(f.db).read(f.root,taskId)).toMatchObject({dueAt:'2027-07-22T16:00:00.000Z',enteredAt:null});
   const revision=(await f.db.query('SELECT sla_basis FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id DESC LIMIT 1',[taskId])).rows[0];
   expect(revision.sla_basis.targets.map((target:{dueAt:string})=>target.dueAt).sort()).toEqual(['2027-07-22T16:00:00.000Z','2027-07-23T16:00:00.000Z']);
   const count=(await f.db.query('SELECT count(*)::int AS count FROM digital_production_deadline_revisions WHERE task_id=$1',[taskId])).rows[0].count;
   expect(await requests.apply(manager,requested.requestId,body,key)).toEqual(applied);expect((await f.db.query('SELECT count(*)::int AS count FROM digital_production_deadline_revisions WHERE task_id=$1',[taskId])).rows[0].count).toBe(count);
   const line=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position LIMIT 1',[orderId])).rows[0];
   await expect(new DigitalPoDateRepository(f.db).applyWithClient(manager,orderId,'initial_po',[{lineId:line.line_id,date:'2027-09-01',expectedVersion:1}],randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  });
 });
 it.each(['owner','production-management'] as const)('lets the actual %s apply an internal sewing revision after native work completion without gaining general remake permission',async(role)=>{
  const scene=await f.scene('2027-07-01T00:00:00.000Z');let row:Awaited<ReturnType<typeof make>>,order:Awaited<ReturnType<PatternRoomOrderService['get']>>;
  await f.runtime.run(scene,f.root,async()=>{
   row=await make('2027-07-01');if(row.operation.kind!=='development_publish')throw Error('TEST source operation');await forms.publish(row.actor,row.sourceId,1,randomUUID(),row.operation.input.patternOrder);
   const link=(await f.db.query('SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1',[row.sourceId])).rows[0],person=(await f.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active',[f.people['pattern-room-worker']!.actorId])).rows[0];
   order=await native.get(f.root,link.order_id);order=await native.assign(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId,personId:person.person_id},randomUUID());order=await native.complete(f.root,order.orderId,{version:order.version,roundId:order.currentRoundId},randomUUID());
   expect(order.status).toBe('pending_confirmation');
  });
  await f.advance(scene,'2027-07-02T00:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const sheet=await forms.read(row!.actor,row!.sourceId),rounds=new DevelopmentRoundService(f.db,true,native),revision={basedOnRound:1,document:sheet.document!,origin:'内部发现' as const,customerComment:'',internalProblem:'TEST 已完工后须重新车缝',explanation:'TEST 原单保留计价及历史',categories:['其他' as const],affectedNodes:['车板' as const],outputKind:'整件样板' as const};
   const draft=await rounds.save(row!.actor,row!.sourceId,{expectedDraftVersion:0,revision},randomUUID()),operation={kind:'development_revision' as const,sourceId:row!.sourceId,input:{expectedDraftVersion:draft.draftVersion,basedOnRound:1}},check=await requests.check(row!.actor,operation);
   const requested=await requests.submit(row!.actor,{operation,fingerprint:check.fingerprint,reason:'TEST 原生完工后复做申请'},randomUUID()),manager=f.people[role]!,preview=await requests.read(manager,requested.requestId),body={expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:true},key=randomUUID();
   expect(manager.actorRoles).not.toContain('pattern_room_supervisor');expect(manager.actorRoles).not.toContain('sample_designer');
   const applied=await requests.apply(manager,requested.requestId,body,key);expect(applied.state).toBe('applied');expect(await requests.apply(manager,requested.requestId,body,key)).toEqual(applied);
   const current=await native.get(f.root,order!.orderId);expect(current.status).toBe('pending_assignment');expect(current.rounds.filter(round=>round.roundType==='rework')).toHaveLength(1);
   expect((await f.db.query('SELECT requested_by FROM pattern_room_rounds WHERE round_id=$1',[current.currentRoundId])).rows[0].requested_by).toBe(manager.actorId);
   expect((await f.db.query('SELECT created_by FROM digital_development_rounds WHERE source_id=$1 AND round_number=2',[row!.sourceId])).rows[0].created_by).toBe(manager.actorId);
   await expect(native.requestRework(manager,order!.orderId,{roundId:current.currentRoundId,version:current.version,reason:'TEST 无独立返做权限',reasonCategory:'other',attachmentIds:[]},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  });
 });
 it('keeps the original active quota and fixed target while the next native task adopts this order calendar and disabled reminder',async()=>{
  const standards=new OrderTimeSettingsService(f.db,true,false),current=await standards.read(f.root);await standards.save(f.root,{expectedVersion:current.version,values:r5OneHourConfiguration()},randomUUID());
  const scene=await f.scene('2027-01-09T15:00:00.000Z');let row:Awaited<ReturnType<typeof make>>;
  await f.runtime.run(scene,f.root,async()=>{
   row=await make('2027-01-20',true);const pattern=row.operation.kind==='development_publish'?row.operation.input.patternOrder:undefined;
   await forms.publish(row.actor,row.sourceId,1,randomUUID(),pattern);
   const original=await new OrderTimePlanRepository(f.db).current({kind:'source',id:row.sourceId}),operation={kind:'arrangement' as const,resource:{kind:'source' as const,id:row.sourceId}},overrides={development_pattern:{kind:'work',minutes:120,calendar:'beijing_sunday_excluded',reminder:{enabled:false,percent:80}} as OrderTimeRule};
   const check=await requests.check(f.root,operation,overrides);await requests.arrange(f.root,{resource:operation.resource,overrides,fingerprint:check.fingerprint,acceptLate:false},randomUUID());
   const changed=await new OrderTimePlanRepository(f.db).current(operation.resource);expect(changed?.targets).toEqual(original?.targets);
   const material=(await f.db.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_materials'",[row.sourceId])).rows[0];
   expect(await new DigitalProductionTaskService(f.db).read(f.root,material.task_id)).toMatchObject({enteredAt:'2027-01-09T15:00:00.000Z',dueAt:'2027-01-09T16:00:00.000Z',slaHours:1});
   await expect(requests.check(f.root,operation,{development_materials:{kind:'work',minutes:10,calendar:'continuous',reminder:{enabled:true,percent:70}}})).rejects.toMatchObject({code:'ORDER_TIME_CONFLICT'});
  });
  await f.advance(scene,'2027-01-09T15:30:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const execute=new DevelopmentExecutionService(f.db,true),clerk=f.people['development-clerk']!,worker=f.people['pattern-room-worker']!.actorId;
   const state=await execute.read(f.root,row!.sourceId),material=state.tasks.find(task=>task.taskKind==='development_materials')!,verification=state.materialVerification!;
   await execute.configureFixedCutting(f.root,row!.sourceId,{expectedVersion:state.fixedCutting!.version,assigneeId:worker,reason:'TEST 原固定裁板配置'},randomUUID());
   const items=[{materialId:row!.material!.materialId,physical:true,quantity:true,color:true,specification:true}];
   await execute.saveMaterials(clerk,row!.sourceId,{taskId:material.taskId,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:items.map(item=>({...item,usage:'use',note:'',confirmedWith:''})),note:'TEST 原主布实物核配',result:'通过'},randomUUID());
   await execute.check(clerk,row!.sourceId,{taskId:material.taskId,expectedVerificationVersion:verification.version+1,result:'通过',note:'TEST 本单实物齐备',items},randomUUID());
   await execute.arrange(clerk,row!.sourceId,await arrangementInput(f.db,execute,clerk,row!.sourceId,worker),randomUUID());
   const pattern=(await execute.read(f.root,row!.sourceId)).tasks.find(task=>task.taskKind==='development_pattern')!;
   expect(pattern).toMatchObject({state:'ready',enteredAt:'2027-01-09T15:30:00.000Z',dueAt:'2027-01-10T17:30:00.000Z',slaHours:2,warningAt:'2027-01-10T17:06:00.000Z'});
   const basis=(await f.db.query('SELECT sla_basis FROM digital_production_deadline_revisions WHERE task_id=$1 AND entered_at IS NOT NULL ORDER BY revision_id LIMIT 1',[pattern.taskId])).rows[0].sla_basis;
   expect(basis).toMatchObject({calendarRef:'beijing_sunday_excluded',notificationEnabled:false});
   expect((await slaNotificationPreferences(f.db,[{task_id:pattern.taskId,task_kind:'development_pattern',source_id:row!.sourceId,production_order_id:null,sla_basis:basis,due_at:pattern.dueAt}])).get(pattern.taskId)?.warning).toBe(false);
  });
  await f.advance(scene,'2027-01-10T17:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const journey=await new DigitalJourneyQuery(f.db).read(f.root,row!.sourceId,undefined,true),pattern=journey.fixedSchedule?.scopes[0]?.nodes.find(node=>node.canonicalWorkRef===`source:${row!.sourceId}:round:1:work:development_pattern`);
   // Ninety counted minutes on this order's two-hour window: the original
   // one-hour company value must not reappear through a legacy display basis.
   expect(pattern?.ownSla).toMatchObject({state:'within',overdueMinutes:{minimum:0,maximum:0}});
  });
 });
 it('keeps a customer revision as an independent inactive draft and checks its real first publication without altering the parent',async()=>{
  const scene=await f.scene('2027-04-01T00:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-04-10');if(row.operation.kind!=='development_publish')throw Error('TEST source operation');
   await forms.publish(row.actor,row.sourceId,1,randomUUID(),row.operation.input.patternOrder);
   const parent=await new OrderTimePlanRepository(f.db).current({kind:'source',id:row.sourceId}),sheet=await forms.read(row.actor,row.sourceId),rounds=new DevelopmentRoundService(f.db,true,native);
   const saved=await rounds.save(row.actor,row.sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:sheet.document!,origin:'客户新增要求',customerComment:'TEST 客户新增工艺，另立复版草稿',internalProblem:'',explanation:'TEST 保留原单事实',categories:['其他'],affectedNodes:['车板'],outputKind:'整件样板'}},randomUUID());
   const key=randomUUID(),body={expectedDraftVersion:saved.draftVersion,basedOnRound:1},result=await rounds.publish(row.actor,row.sourceId,body,key);
   expect(result.sourceId).not.toBe(row.sourceId);expect(await rounds.publish(row.actor,row.sourceId,body,key)).toEqual(result);
   expect((await forms.read(row.actor,result.sourceId)).status).toBe('draft');
   expect((await f.db.query('SELECT effective,created_business_time FROM digital_order_time_subjects WHERE source_id=$1',[result.sourceId])).rows[0]).toMatchObject({effective:false,created_business_time:{now:'2027-04-01T00:00:00.000Z'}});
   expect((await f.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[result.sourceId])).rowCount).toBe(0);
   expect(await new OrderTimePlanRepository(f.db).current({kind:'source',id:result.sourceId})).toBeNull();
   expect(await new OrderTimePlanRepository(f.db).current({kind:'source',id:row.sourceId})).toEqual(parent);
   const checked=await requests.check(row.actor,{kind:'development_publish',sourceId:result.sourceId,input:{expectedVersion:1,patternOrder:row.operation.input.patternOrder}});expect(checked.feasibility).toBe('sufficient');
   await forms.publish(row.actor,result.sourceId,1,randomUUID(),row.operation.input.patternOrder);
   expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=$1',[result.sourceId])).rows[0].effective).toBe(true);
   expect((await f.db.query('SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1',[row.photo])).rows[0]).toEqual({entity_type:'digital_development',entity_id:row.sourceId});
   expect((await f.db.query('SELECT DISTINCT order_id FROM pattern_room_attachment_bindings WHERE attachment_id=$1',[row.photo])).rowCount).toBe(2);
  });
 });
 it('applies a saved internal craft change and its per-order quota together while retaining the real completed material and old responsibility',async()=>{
  const scene=await f.scene('2027-05-01T00:00:00.000Z');let row:Awaited<ReturnType<typeof make>>,oldPattern:string,oldDeadline:unknown,operation:OrderTimeOperation;
  await f.runtime.run(scene,f.root,async()=>{
   row=await make('2027-05-01',true);if(row.operation.kind!=='development_publish')throw Error('TEST source operation');
   await forms.publish(row.actor,row.sourceId,1,randomUUID(),row.operation.input.patternOrder);
  });
  await f.advance(scene,'2027-05-01T01:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const execute=new DevelopmentExecutionService(f.db,true),clerk=f.people['development-clerk']!,state=await execute.read(f.root,row!.sourceId),material=state.tasks.find(task=>task.taskKind==='development_materials')!,verification=state.materialVerification!;
   const items=[{materialId:row!.material!.materialId,physical:true,quantity:true,color:true,specification:true}];
   await execute.saveMaterials(clerk,row!.sourceId,{taskId:material.taskId,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:items.map(item=>({...item,usage:'use',note:'',confirmedWith:''})),note:'TEST 实物核配',result:'通过'},randomUUID());
   await execute.check(clerk,row!.sourceId,{taskId:material.taskId,expectedVerificationVersion:verification.version+1,result:'通过',note:'TEST 实物通过',items},randomUUID());
   oldPattern=(await f.db.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_pattern'",[row!.sourceId])).rows[0].task_id;
   oldDeadline=(await f.db.query('SELECT entered_at,due_at FROM digital_production_deadline_revisions WHERE task_id=$1 AND entered_at IS NOT NULL ORDER BY revision_id LIMIT 1',[oldPattern])).rows[0];
  });
  await f.advance(scene,'2027-05-01T13:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const sheet=await forms.read(row!.actor,row!.sourceId),rounds=new DevelopmentRoundService(f.db,true,native),revision={basedOnRound:1,document:{...sheet.document!,craft:'印花' as const,craftSteps:[{craftKind:'printing' as const,sequence:1}]},origin:'内部发现' as const,customerComment:'',internalProblem:'TEST 新增印花',explanation:'TEST 保留已完成核配',categories:['工艺' as const],affectedNodes:['工艺' as const],outputKind:'整件样板' as const};
   const saved=await rounds.save(row!.actor,row!.sourceId,{expectedDraftVersion:0,revision},randomUUID());operation={kind:'development_revision',sourceId:row!.sourceId,input:{expectedDraftVersion:saved.draftVersion,basedOnRound:1}};
   const checked=await requests.check(row!.actor,operation);expect(checked.feasibility).toBe('insufficient');expect(checked.rows.some(node=>node.parameterKey==='development_materials')).toBe(false);expect(checked.rows.some(node=>node.parameterKey==='development_printing')).toBe(true);
   await expect(rounds.publish(row!.actor,row!.sourceId,operation.input,randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_REQUEST_REQUIRED'});
   expect((await forms.read(row!.actor,row!.sourceId)).latestRoundNumber).toBe(1);
   const requested=await requests.submit(row!.actor,{operation,fingerprint:checked.fingerprint,reason:'TEST 本单新增工艺需调时效'},randomUUID()),manager=f.people['production-management']!,overrides=compress(requested),preview=await requests.read(manager,requested.requestId,overrides);
   expect(preview.check.feasibility).toBe('sufficient');
   await requests.apply(manager,requested.requestId,{expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides,acceptLate:false},randomUUID());
   expect((await forms.read(row!.actor,row!.sourceId)).latestRoundNumber).toBe(2);
   const policy=await new OrderTimePlanRepository(f.db).current({kind:'source',id:row!.sourceId});expect(policy?.input.plan.company.reference).toBe('order-time-company:'+((await new OrderTimeSettingsService(f.db,true,false).read(f.root)).record!.id));
   expect(policy?.input.work.some(work=>work.parameterKey==='development_materials')).toBe(false);expect(policy?.input.work.filter(work=>work.parameterKey==='development_printing')).toHaveLength(1);
   expect(policy?.input.work.find(work=>work.parameterKey==='development_pattern')?.canonicalWorkRef).toContain(':round:2:');
   expect((await f.db.query('SELECT entered_at,due_at FROM digital_production_deadline_revisions WHERE task_id=$1 AND entered_at IS NOT NULL ORDER BY revision_id LIMIT 1',[oldPattern!])).rows[0]).toEqual(oldDeadline);
   const history=(await rounds.read(row!.actor,row!.sourceId)).rounds.find(round=>round.roundNumber===2)!;expect(history.inherited).toHaveProperty('development_materials');
  });
 });
 it('preserves approved PO goal evidence when publishing a version-two instruction and arranging the same order again',async()=>{
  const scene=await f.scene('2027-07-01T00:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-10-31',true);
   if(row.operation.kind!=='development_publish')throw Error('TEST source operation');
   await forms.publish(row.actor,row.sourceId,1,randomUUID(),row.operation.input.patternOrder);
   const order=await identity.createOrder(row.actor,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:(await forms.read(row.actor,row.sourceId)).designStyleNo,orderDate:'2027-07-01',primaryMerchandiserId:f.people.merchandiser!.actorId,productionPlanning:{craftSteps:[],preshrink:false},lines:[
    {formalPoNo:'TEST-R5-DATE-RED-'+randomUUID(),color:'红',customerWarehouseArrivalDate:'2027-09-30',sizes:[{size:'M',quantity:1}]},
    {formalPoNo:'TEST-R5-DATE-GREEN-'+randomUUID(),color:'绿',customerWarehouseArrivalDate:'2027-10-10',sizes:[{size:'M',quantity:1}]}
   ]}),randomUUID(),row.sourceId);
   const resource={kind:'order' as const,id:order.productionOrderId},repo=new OrderTimePlanRepository(f.db),main=f.people.merchandiser!,instruction=new ProductionInstructionService(f.db,true);
   const initial=await instruction.read(main,order.productionOrderId),document={...initial.document,styleName:'TEST approved PO date',category:'上衣',date:'2027-07-01',preshrink:'无需预缩' as const,secondaryCraft:'无' as const,craftSteps:[]};
   await instruction.save(main,order.productionOrderId,{expectedVersion:0,orderVersion:order.version,sourceRound:1,document},randomUUID());
   await instruction.save(main,order.productionOrderId,{expectedVersion:1,orderVersion:order.version,document:{...document,styleName:'TEST retained version-two draft'}},randomUUID());
   await productionReadinessFixture(f.db,f.root,order.productionOrderId,f.people['pattern-room-worker']!.actorId,f.people.warehouse!);
   const before=(await repo.current(resource))!,red=order.lines[0]!.lineId,green=order.lines[1]!.lineId;
   const stale=await requests.check(f.root,{kind:'arrangement',resource}),dates=new PoCustomerDateService(f.db),dateState=await dates.read(f.root,order.productionOrderId);
   const currentOrder=await identity.read(f.root,order.productionOrderId);
   const request=await dates.request(main,order.productionOrderId,{orderVersion:currentOrder.version,changes:[{lineId:red,date:'2027-10-02',expectedVersion:dateState.customerPoDates.find(line=>line.lineId===red)!.version}],reason:'TEST native approved red PO date'},randomUUID()) as {requestId:string};
   await dates.decide(f.root,order.productionOrderId,request.requestId,true,randomUUID());
   const approved=(await repo.current(resource))!,redScope=approved.input.scopes.find(scope=>scope.lineId===red)!,greenScope=approved.input.scopes.find(scope=>scope.lineId===green)!;
   const change=(await f.db.query("SELECT change_id FROM digital_po_date_changes WHERE production_order_id=$1 AND line_id=$2 AND source='approved_customer_change'",[order.productionOrderId,red])).rows[0];
   expect(redScope.customerGoal).toEqual({precision:'date',value:'2027-10-02',source:'digital_po_date_changes:'+change.change_id});
   expect(greenScope).toEqual(before.input.scopes.find(scope=>scope.lineId===green));
   expect(approved.targets[greenScope.scopeRef]).toEqual(before.targets[greenScope.scopeRef]);
   await expect(requests.arrange(f.root,{resource,overrides:{},fingerprint:stale.fingerprint,acceptLate:false},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_STALE'});
   expect(await repo.current(resource)).toEqual(approved);
   const draft=await instruction.read(main,order.productionOrderId);
   expect(draft.version).toBe(2);expect(draft.publishedVersion).toBeNull();
   const body={expectedVersion:2,orderVersion:draft.currentOrderVersion,expectedReadinessRevision:draft.readiness?.revision},key=randomUUID();
   const published=await instruction.publish(main,order.productionOrderId,body,key);
   expect(published.publishedVersion).toBe(2);
   expect(await instruction.publish(main,order.productionOrderId,body,key)).toEqual(published);
   const after=(await repo.current(resource))!;
   expect(after.revision).toBe(approved.revision+1);
   for(const old of approved.input.scopes){
    const scope=after.input.scopes.find(scope=>scope.lineId===old.lineId)!;
    expect(scope.customerGoal).toEqual(old.customerGoal);
    for(const id of old.customerGoalIds)expect(scope.goals[id]).toEqual(old.goals[id]);
    for(const [id,target]of Object.entries(approved.targets[old.scopeRef]!))expect(after.targets[scope.scopeRef]![id]).toEqual(target);
   }
   expect((await f.db.query('SELECT version FROM digital_instruction_versions WHERE production_order_id=$1',[order.productionOrderId])).rows).toEqual([{version:2}]);
   const check=await requests.check(f.root,{kind:'arrangement',resource}),arrangeBody={resource,overrides:{},fingerprint:check.fingerprint,acceptLate:false},arrangeKey=randomUUID();
   const arranged=await requests.arrange(f.root,arrangeBody,arrangeKey);
   expect(await requests.arrange(f.root,arrangeBody,arrangeKey)).toEqual(arranged);
   const latest=(await repo.current(resource))!;
   expect(latest.revision).toBe(after.revision+1);
   expect(latest.input.scopes.map(scope=>scope.customerGoal)).toEqual(after.input.scopes.map(scope=>scope.customerGoal));
   expect(latest.targets).toEqual(after.targets);
  });
 });
 it('keeps the old production route effective while the main merchandiser hands an insufficient saved change to its designer and a manager applies both changes once',async()=>{
  const settings=new OrderTimeSettingsService(f.db,true,false),standard=await settings.read(f.root),values=r5OneHourConfiguration();values.nodes.bulk_printing={kind:'work',minutes:2880,calendar:'continuous',reminder:{enabled:true,percent:70}};await settings.save(f.root,{expectedVersion:standard.version,values},randomUUID());
  const scene=await f.scene('2027-06-01T00:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-06-02',true);if(row.operation.kind!=='development_publish')throw Error('TEST source operation');
   await forms.publish(row.actor,row.sourceId,1,randomUUID(),row.operation.input.patternOrder);
   const input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:(await forms.read(row.actor,row.sourceId)).designStyleNo,orderDate:'2027-06-01',primaryMerchandiserId:f.people.merchandiser!.actorId,productionPlanning:{craftSteps:[],preshrink:false},lines:[{formalPoNo:'TEST-R507-ROUTE-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-06-02',sizes:[{size:'M',quantity:1}]}]}),order=await identity.createOrder(row.actor,input,randomUUID(),row.sourceId),main=f.people.merchandiser!,instruction=new ProductionInstructionService(f.db,true);
   const initial=await instruction.read(main,order.productionOrderId),document={...initial.document,styleName:'TEST 本单变更',category:'上衣',date:beijingCalendarDate(new Date('2027-06-01T00:00:00.000Z')),preshrink:'无需预缩' as const,secondaryCraft:'无' as const,craftSteps:[]};
   await instruction.save(main,order.productionOrderId,{expectedVersion:0,orderVersion:order.version,sourceRound:1,document},randomUUID());
   const readiness=await productionReadinessFixture(f.db,f.root,order.productionOrderId,f.people['pattern-room-worker']!.actorId,f.people.warehouse!);
   expect((await f.db.query("SELECT minutes,due_at-started_at AS span FROM digital_preparation_windows WHERE production_order_id=$1 AND kind='final'",[order.productionOrderId])).rows[0].minutes).toBe(60);
   await instruction.publish(main,order.productionOrderId,{expectedVersion:1,orderVersion:order.version,expectedReadinessRevision:readiness.revision},randomUUID());
   const resource={kind:'order' as const,id:order.productionOrderId},before=await new OrderTimePlanRepository(f.db).current(resource),active=await instruction.read(main,order.productionOrderId);
   await instruction.save(main,order.productionOrderId,{expectedVersion:active.version,orderVersion:order.version,document:{...active.document,secondaryCraft:'印花',craftSteps:[{craftKind:'printing',sequence:1}]}},randomUUID());
   const ordinary=await requests.check(main,{kind:'arrangement',resource});expect(ordinary.rows.some(node=>node.parameterKey==='bulk_printing')).toBe(false);
   const operation:OrderTimeOperation={kind:'instruction_publish',orderId:order.productionOrderId,input:{expectedVersion:2,orderVersion:order.version}},check=await requests.check(main,operation);expect(check).toMatchObject({feasibility:'insufficient',canRequest:false,canApply:false});
   const handoff=await requests.submit(main,{operation,fingerprint:check.fingerprint,reason:'TEST 主跟单提出印花变更，原设计师接续'},randomUUID());expect(handoff.state).toBe('needs_designer');
   await expect(requests.resubmit(main,handoff.requestId,{expectedVersion:handoff.version,operation,fingerprint:handoff.check.fingerprint,reason:'TEST 跟单不能代申请'},randomUUID())).rejects.toMatchObject({statusCode:403});
   expect((await instruction.read(main,order.productionOrderId)).publishedVersion).toBe(1);expect(await new OrderTimePlanRepository(f.db).current(resource)).toEqual(before);
   const designView=await requests.read(row.actor,handoff.requestId),pending=await requests.resubmit(row.actor,handoff.requestId,{expectedVersion:designView.version,operation:designView.operation,fingerprint:designView.check.fingerprint,reason:'TEST 原设计师按保存资料申请'},randomUUID());expect(pending.requestId).toBe(handoff.requestId);expect(pending.state).toBe('pending');
   const manager=f.people['production-management']!,overrides={bulk_printing:{...values.nodes.bulk_printing,minutes:60}},preview=await requests.read(manager,pending.requestId,overrides);expect(preview.check.feasibility).toBe('sufficient');
   const key=randomUUID(),body={expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides,acceptLate:false},applied=await requests.apply(manager,pending.requestId,body,key);expect(await requests.apply(manager,pending.requestId,body,key)).toEqual(applied);
   expect((await instruction.read(main,order.productionOrderId)).publishedVersion).toBe(2);
   const after=await new OrderTimePlanRepository(f.db).current(resource);expect(after?.input.plan.overrides.bulk_printing?.minutes).toBe(60);expect(after?.input.work.filter(work=>work.parameterKey==='bulk_printing')).toHaveLength(1);
   const scope=after!.input.scopes[0]!,oldScope=before!.input.scopes[0]!;expect(after?.targets[scope.scopeRef]!.bulk_cutting).toEqual(before?.targets[oldScope.scopeRef]!.bulk_cutting);
   expect((await orderTimeTodos(f.db,f.root)).some(todo=>todo.todoId===pending.requestId)).toBe(false);
  });
 });
 it('adopts intermediate-gap framework and washing in the same original manager transaction without inventing ready events',async()=>{
  const settings=new OrderTimeSettingsService(f.db),old=await settings.read(f.root);
  const historical=(await f.db.query('SELECT plan_version_id,input_snapshot,fixed_targets FROM digital_order_time_plan_versions ORDER BY plan_version_id')).rows;
  expect(historical.length).toBeGreaterThan(0);
  expect(historical.every(row=>!row.input_snapshot.plan.company.framework)).toBe(true);
  const published=await settings.save(f.root,{expectedVersion:old.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  expect(published.record.standard.framework).toBeDefined();
  expect(published.record.standard.nodes.development_confirmation?.minutes).toBe(120);
  expect((await f.db.query('SELECT plan_version_id,input_snapshot,fixed_targets FROM digital_order_time_plan_versions ORDER BY plan_version_id')).rows).toEqual(historical);
  const scene=await f.scene('2027-08-01T00:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const designer=f.people['sample-designer']!,input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',requiresColorMatching:false,designStyleNo:'TEST-FRAMEWORK-'+randomUUID(),orderDate:'2027-08-01',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-FRAMEWORK-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-08-15',sizes:[{size:'M',quantity:10}]}]});
   const development=await make('2027-08-15');
   const developmentCheck=await requests.check(development.actor,development.operation);
   // Five original hour-long tasks + the adopted final-design2h; positioning
   // is not applicable without a craft. No blanket addition to old orders.
   expect(developmentCheck.requiredMinutes).toBe(420);
   const operation={kind:'direct_order' as const,input,route:{craftSteps:[],preshrink:false}};
   await expect(requests.check(designer,{...operation,input:{...input,requiresColorMatching:null}})).rejects.toThrow('请在原单确认是否需要对色');
   const check=await requests.check(designer,operation);
   expect(check.framework?.milestones).toHaveLength(8);
   expect(check.feasibility,JSON.stringify(check.coverage)).toBe('insufficient');
   const pending=await requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST intermediate milestone gaps'},randomUUID());
   const manager=f.people.owner!,preview=await requests.read(manager,pending.requestId);
   await expect(requests.apply(manager,pending.requestId,{expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:false},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_LATE_CONFIRMATION'});
   const applied=await requests.apply(manager,pending.requestId,{expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const resource={kind:'order' as const,id:applied.result!.orderId!},repo=new OrderTimePlanRepository(f.db),before=(await repo.current(resource))!;
   expect(Object.values(before.input.frameworkPlans??{})).toHaveLength(1);
   expect(Object.values(before.input.frameworkPlans!)[0]!.milestones).toHaveLength(8);
   const lineId=before.input.scopes[0]!.lineId!,duration={minutes:120,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
   const washing=[{lineId,expectedVersion:0,document:{arrangement:{mode:'after_receipt' as const,reference:'TEST original order change',revision:1,accounting:'additional' as const,washing:duration,inspection:duration},staff:{logisticsId:f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:f.people.qc!.actorId},fee:{kind:'pending' as const},sourceRef:'TEST original management adjustment'}}];
   const originalTasks=(await f.db.query('SELECT task_id,entered_at,completed_at FROM digital_production_tasks WHERE task_id IN (SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1) ORDER BY task_id',[resource.id])).rows;
   const operation2={kind:'arrangement' as const,resource},next=await requests.check(manager,operation2,{},washing);
   expect((await f.db.query('SELECT 1 FROM digital_bulk_washing_plans WHERE production_order_id=$1',[resource.id])).rowCount).toBe(0);
   const body={resource,fingerprint:next.fingerprint,overrides:{},washing,acceptLate:true},key=randomUUID();
   const saved=await requests.arrange(manager,body,key);expect(await requests.arrange(manager,body,key)).toEqual(saved);
   expect(saved.check.washing?.find(row=>row.lineId===lineId)?.version).toBe(1);
   expect((await f.db.query('SELECT 1 FROM digital_bulk_washing_plans WHERE production_order_id=$1',[resource.id])).rowCount).toBe(1);
   expect((await repo.current(resource))!.input.work.filter(work=>work.parameterKey==='bulk_return_washing')).toHaveLength(1);
   expect((await f.db.query('SELECT task_id,entered_at,completed_at FROM digital_production_tasks WHERE task_id IN (SELECT task_id FROM digital_production_task_access WHERE production_order_id=$1) ORDER BY task_id',[resource.id])).rows).toEqual(originalTasks);
   await expect(requests.arrange(manager,body,randomUUID())).rejects.toMatchObject({statusCode:409});
   const persisted=saved.check.washing!.find(row=>row.lineId===lineId)!;
   const editAgain=[{lineId,expectedVersion:persisted.version,document:{...persisted.document!,arrangement:{...persisted.document!.arrangement,washing:{...duration,minutes:180}}}}];
   const secondPreview=await requests.check(manager,operation2,{},editAgain);
   const second=await requests.arrange(manager,{resource,fingerprint:secondPreview.fingerprint,overrides:{},washing:editAgain,acceptLate:true},randomUUID());
   expect(second.check.washing?.find(row=>row.lineId===lineId)?.version).toBe(2);
   const journey=await new DigitalJourneyQuery(f.db).read(manager,resource.id,undefined,true);
   expect(journey.fixedSchedule?.framework?.scopes[0]?.milestones).toHaveLength(8);
   const executionRows=journey.stages.flatMap(stage=>stage.nodes),washingRows=executionRows.filter(node=>node.key.startsWith('bulk_return_washing'));
   expect(washingRows.map(node=>node.key).sort()).toEqual(['bulk_return_washing','bulk_return_washing_inspection']);
   const shipment=journey.fixedSchedule!.framework!.scopes[0]!.milestones.find(row=>row.key==='planned_shipment')!;
   const dispatch=journey.fixedSchedule!.framework!.scopes[0]!.milestones.find(row=>row.key==='processing_dispatch')!;
   for(const node of washingRows){
    expect(node).toMatchObject({stage:'receiving',current:true,state:'pending',progressApplicability:'applicable',actualAt:null,enteredAt:null});
    expect(node.records[0]).toMatchObject({url:`/ui/digital-production?factory=${resource.id}`,lineId});
    expect(node.fixedTargets!.every(target=>target.lineId===lineId&&shipment.relatedWorkIds!.includes(target.progress.id)&&!dispatch.relatedWorkIds!.includes(target.progress.id))).toBe(true);
    expect(journey.businessProgress!.requirements.find(row=>row.key===node.key)).toMatchObject({applicability:'applicable',completed:false});
   }
   expect(executionRows.find(node=>node.key==='warehouse_accessories')).toMatchObject({label:'辅料实物备齐',planningOnly:true,state:'pending',actualAt:null});
   const adopted=(await repo.current(resource))!,forward=Object.values(adopted.input.frameworkPlans!)[0]!;
   const projected=journey.fixedSchedule!.scopes[0]!;
   // This direct order has no effective material handover to support a deadline.
   expect(adopted.input.materialInvestmentScope).toBeNull();
   const preparation=await new ProductionReadinessService(f.db).read(manager,resource);
   expect(preparation.facts.some(fact=>fact.kind==='material_investment'||fact.kind==='design_handover'&&fact.valid&&fact.investmentScopeBasis)).toBe(false);
   expect(preparation.materialInvestmentReminder).toBeUndefined();
   expect(await materialInvestmentRiskHistory(f.db,resource.id,journey.fixedSchedule!.asOf)).toEqual([]);
   const investment=projected.nodes.find(work=>work.id==='material_investment');
   expect(investment).toMatchObject({businessCompleted:false,goalDelta:{kind:'unknown',targetAt:null,actual:{precision:'unknown'}},ownSla:{deadlineAt:null,overdueMinutes:null}});
   expect(investment?.currentTarget?.at??null).toBeNull();
   expect(investment?.state).not.toBe('late');
   expect(investment?.ownSla.warning??false).toBe(false);
   // B handover is June12 for an August15 delivery. The July18 budget
   // constraint excludes five downstream hours from the end of that day.
   const eventDeadlines:Record<string,string>={design_handover:'2027-06-12T16:00:00.000Z',customer_confirmation:'2027-07-18T11:00:00.000Z',budget:'2027-07-18T11:00:00.000Z'};
   for(const work of projected.nodes){
    if(work.id==='material_investment')continue;
    const arranged=forward.arranged.find(row=>row.id===work.id)?.end.at;
    expect(work.currentTarget?.at??work.goalDelta.targetAt,work.id).toBe(eventDeadlines[work.id]??arranged);
    if(eventDeadlines[work.id]){
     expect(arranged).toBe('2027-08-01T00:00:00.000Z');
     expect(work.goalDelta.kind).toBe('late');
     expect(work.ownSla.deadlineAt).toBeNull();
    }
   }
   expect(projected.nodes.filter(work=>eventDeadlines[work.id])).toHaveLength(3);
   expect((await repo.current(resource))!.input.frameworkPlans).toEqual(adopted.input.frameworkPlans);
   expect(projected.nodes.find(work=>work.id.startsWith('bulk_return_washing:'))?.businessCompleted).toBe(false);
   expect(journey.visualProgress?.expected.at).toBe('2027-08-15');
   const facts=new JourneyFactRepository(f.db),model=await facts.buildOne(resource);
   const reader=await f.db.connect();
   try{
    const stored=await facts.readStoredWithClient(reader,resource);
    expect(stored.status).toBe('ready');
    const scope=stored.model?.fixedSchedule?.scopes[0];
    expect(scope?.work.find(work=>work.id==='material_investment')?.eventTarget).toMatchObject({end:null});
    expect(scope?.facts.material_investment).toMatchObject({businessCompleted:false,completed:{precision:'unknown'}});
    expect(stored.model?.fixedSchedule?.materialInvestmentTiming).toBeUndefined();
   }finally{reader.release();}
   expect(model.model.nodes.filter(node=>node.key.startsWith('bulk_return_washing')).map(node=>node.key).sort()).toEqual(washingRows.map(node=>node.key).sort());
   expect(model.model.nodes.find(node=>node.key==='warehouse_accessories')).toMatchObject({planningOnly:true,state:'pending'});
   expect(model.model.fixedSchedule?.framework).toHaveLength(1);
   for(const work of model.model.fixedSchedule!.scopes[0]!.work)if(eventDeadlines[work.id]){
    expect(work.end).toBe('2027-08-01T00:00:00.000Z');
    expect(work.eventTarget?.end).toBe(eventDeadlines[work.id]);
   }
   expect(model.model.fixedSchedule?.scopes[0]?.plannedReadiness).toBe(true);
   const series=new SeriesPlanService(f.db,'TEST framework series shared date '.repeat(3));
   const same=await series.read(f.root,resource.id);
   expect(same.framework?.scopes[0]?.customerDate).toBe('2027-08-15');
   expect(same.framework?.reference).toBe((await repo.current(resource))!.id);
   await expect(series.preview(f.root,resource.id,{expectedOrderVersion:same.orderVersion,expectedPlanRevision:same.current?.revision??0,plannedShippingDate:'2027-08-20',plannedDurations:{},selectedNodeIds:null})).rejects.toMatchObject({statusCode:409});
   const dates=new PoCustomerDateService(f.db),dateSheet=await dates.read(f.root,resource.id),orderVersion=(await f.db.query('SELECT version FROM digital_production_orders WHERE production_order_id=$1',[resource.id])).rows[0].version;
   const dateRequest=await dates.request(f.root,resource.id,{orderVersion,changes:[{lineId,date:'2027-08-20',expectedVersion:dateSheet.customerPoDates.find(line=>line.lineId===lineId)!.version}],reason:'TEST same real approved date'},randomUUID()) as {requestId:string};
   await dates.decide(f.root,resource.id,dateRequest.requestId,true,randomUUID());
   const afterDate=(await repo.current(resource))!,seriesAfter=await series.read(f.root,resource.id);
   expect(seriesAfter.framework?.reference).toBe(afterDate.id);
   expect(seriesAfter.framework?.scopes[0]?.customerDate).toBe('2027-08-20');
   expect(seriesAfter.framework?.scopes[0]?.dateSource).toMatch(/^digital_po_date_changes:/);
   expect(seriesAfter.framework?.scopes[0]?.milestones.find(row=>row.key==='planned_shipment')?.date).toBe('2027-08-20');
   expect(Object.values(before.input.frameworkPlans!)[0]!.input.customerDelivery.date).toBe('2027-08-15');
   const beforeFactory=await requests.check(manager,operation2),customerSnapshot=structuredClone(afterDate.input.frameworkPlans);
   expect(beforeFactory.factoryCommitments).toEqual([]);
   const approveFactory=async(date:string,expectedVersion:number)=>{
    const client=await f.db.connect();try{
     await client.query('BEGIN');const eventId=randomUUID(),oldDate=(await client.query('SELECT factory_delivery_date::text AS date FROM digital_production_po_lines WHERE line_id=$1',[lineId])).rows[0].date;
     await client.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'digital_po_factory_dates_approved','digital_production',$4,$5)",[eventId,f.root.requestId,f.root.actorId,resource.id,JSON.stringify({reason:'TEST original approved factory-date adapter',dateChanges:[{lineId,date,expectedVersion,oldDate,dateKind:'factory'}]})]);
     await new DigitalPoDateRepository(client).applyWithClient(f.root,resource.id,'approved_factory_change',[{lineId,date,expectedVersion}],eventId);
     await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   };
   await approveFactory('2027-08-02',0);
   const constrained=await requests.check(manager,operation2);
   expect(constrained.factoryCommitments?.[0]).toMatchObject({lineId,date:'2027-08-02',version:1,status:'insufficient'});
   expect(constrained.fingerprint).not.toBe(beforeFactory.fingerprint);
   await approveFactory('2027-08-19',1);
   const later=await requests.check(manager,operation2);
   expect(later.factoryCommitments?.[0]).toMatchObject({lineId,date:'2027-08-19',version:2});
   expect(later.factoryCommitments?.[0]?.plannedReceipt).toBe(constrained.factoryCommitments?.[0]?.plannedReceipt);
   expect((await repo.current(resource))!.input.frameworkPlans).toEqual(customerSnapshot);
   expect(later.customerDates).toEqual(constrained.customerDates);

  });
 });

 it('keeps an optional sample date empty after framework publication and preserves native windows through later source arrangement',async()=>{
  const scene=await f.scene('2027-09-01T00:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make(null),checked=await requests.check(row.actor,row.operation);
   expect(checked.plan.company.framework).toBeDefined();expect(checked).toMatchObject({feasibility:'not_applicable',lateMinutes:null,requiredMinutes:420});
   const sheet=await forms.publish(row.actor,row.sourceId,1,randomUUID(),row.operation.kind==='development_publish'?row.operation.input.patternOrder:undefined);
   const task=await new DigitalProductionTaskService(f.db).read(row.actor,sheet.taskId!),resource={kind:'source' as const,id:row.sourceId};
   const model=await new JourneyFactRepository(f.db).buildOne(resource);
   expect(model.model.nodes.find(node=>node.key==='development_materials')?.enteredAt).toBe(task.enteredAt);
   const preview=await requests.check(f.root,{kind:'arrangement',resource});expect(preview.feasibility).toBe('not_applicable');
   await requests.arrange(f.root,{resource,fingerprint:preview.fingerprint,overrides:{},acceptLate:false},randomUUID());
   expect(await new DigitalProductionTaskService(f.db).read(row.actor,sheet.taskId!)).toMatchObject({enteredAt:task.enteredAt,dueAt:task.dueAt});
   expect((await forms.read(row.actor,row.sourceId)).document!.returnDate).toBeNull();
   const saved=(await new OrderTimePlanRepository(f.db).current(resource))!;expect(saved.input.scopes.every(scope=>scope.customerGoal.precision==='unknown')).toBe(true);expect(saved.input.frameworkPlans).toBeUndefined();
  });
 });

 it('publishes incomplete ordering as development without inventing PO deadlines or silently creating a formal order',async()=>{
  const settings=new OrderTimeSettingsService(f.db,true,true),standard=await settings.read(f.root);
  await settings.save(f.root,{expectedVersion:standard.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  const scene=await f.scene('2027-10-01T00:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   for(const partial of [false,true]){
    const row=await make(null),before=await forms.read(row.actor,row.sourceId);
    const ordering=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:before.designStyleNo,orderDate:'2027-10-01',contractDeliveryDate:null,requiresColorMatching:false,
     lines:[{formalPoNo:'TEST-undated-'+randomUUID(),color:'黑',deliveryDate:null,customerWarehouseArrivalDate:null,sizes:[{size:'M',quantity:'2'}]},...(partial?[{formalPoNo:'TEST-dated-'+randomUUID(),color:'蓝',deliveryDate:null,customerWarehouseArrivalDate:'2028-02-01',sizes:[{size:'M',quantity:'2'}]}]:[])]});
    const saved=await forms.save(row.actor,row.sourceId,{expectedVersion:before.version,document:{...before.document!,productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal',order:ordering}}},randomUUID());
    const operation:OrderTimeOperation={...row.operation,input:{...(row.operation.kind==='development_publish'?row.operation.input:{}),expectedVersion:saved.version}} as OrderTimeOperation;
    const check=await requests.check(row.actor,operation);
    expect(check).toMatchObject({feasibility:'not_applicable',customerDates:[{po:'样板',date:null}]});expect(check.framework).toBeUndefined();
    // Use the original request/application transaction as well as ordinary
    // publication: the native executor must share the same readiness boundary.
    const pending=await requests.submit(row.actor,{operation,fingerprint:check.fingerprint,reason:'TEST retain incomplete customer information'},randomUUID());
    const preview=await requests.read(f.root,pending.requestId);
    const result=await requests.apply(f.root,pending.requestId,{expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:false},randomUUID());
    expect(result).toMatchObject({state:'applied',result:{orderId:null}});
    const published=await forms.read(row.actor,row.sourceId);expect(published.status).toBe('published');expect(published.document!.customerOrderDraft!.order).toEqual(ordering);
    expect((await f.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
    const adopted=(await new OrderTimePlanRepository(f.db).current({kind:'source',id:row.sourceId}))!;
    expect(adopted.input.scopes.every(scope=>scope.customerGoal.precision==='unknown')).toBe(true);expect(adopted.input.frameworkPlans).toBeUndefined();
    const formal={...initialCustomerOrderInput(ordering),productionPlanning:{craftSteps:[],preshrink:false}};
    const formalCheck=await requests.check(row.actor,{kind:'confirm_order',sourceId:row.sourceId,input:formal});
    expect(formalCheck.feasibility).toBe('unknown');expect(formalCheck.coverage.join('；')).toContain('客户交期尚未填写');
    if(partial)expect(formalCheck.framework!.milestones).toHaveLength(8);
    else expect(formalCheck.framework).toBeUndefined();
    await expect(identity.createOrder(row.actor,formal,randomUUID(),row.sourceId)).rejects.toMatchObject({code:'ORDER_TIME_INPUT_REQUIRED'});
    expect((await f.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
   }
  });
 });

 it('projects the complete first adopted serial craft route before starting the sample sewing forecast',async()=>{
  const settings=new OrderTimeSettingsService(f.db,true,true),standard=await settings.read(f.root);
  const values=prepareTimeFrameworkConfiguration(r5OneHourConfiguration());
  const work=(minutes:number)=>({kind:'work' as const,minutes,calendar:'continuous' as const,reminder:{enabled:false,percent:70}});
  await settings.save(f.root,{expectedVersion:standard.version,values:{...values,stageBufferMinutes:0,nodes:{...values.nodes,development_positioning:work(60),development_printing:work(96*60),development_embroidery:work(96*60)}}},randomUUID());
  const library=new SpecialCraftLibraryService(f.db),steps:CraftStepChoice[]=[{craftKind:'printing',sequence:1},{craftKind:'embroidery',sequence:2}];
  for(const [i,hours] of [24,12].entries()){
   const rule={minutes:hours*60,calendar:'continuous' as const,reminder:{enabled:false,percent:70}};
   const snapshot=await library.save(f.root,{id:null,expectedVersion:0,definition:{name:`TEST serial craft ${i}`,enabled:true,development:rule,bulk:rule}},randomUUID());
   steps.push({craftKind:'special',sequence:steps.length+1,specialCraft:snapshot});
  }
  const scene=await f.scene('2027-09-01T00:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   for(const date of ['2027-10-15',null]){
   const row=await make(date),before=await forms.read(row.actor,row.sourceId);
    const draft=await forms.save(row.actor,row.sourceId,{expectedVersion:before.version,document:{...before.document!,craft:'特殊工艺',craftSteps:steps}},randomUUID());
    if(row.operation.kind!=='development_publish')throw Error('TEST original source publication required');
    await forms.publish(row.actor,row.sourceId,draft.version,randomUUID(),row.operation.input.patternOrder);
    const resource={kind:'source' as const,id:row.sourceId},repo=new OrderTimePlanRepository(f.db),saved=(await repo.current(resource))!;
    expect(saved.revision).toBe(1);
    const scope=saved.input.scopes[0]!,crafts=saved.input.work.filter(node=>node.canonicalWorkRef?.endsWith(':work')&&node.canonicalWorkRef.includes(':step:'));
    expect(new Set(crafts.map(node=>node.canonicalWorkRef)).size).toBe(4);
    expect(crafts.slice(1).every((node,i)=>node.dependsOn.includes(crafts[i]!.id))).toBe(true);
    expect(saved.input.work.filter(node=>node.canonicalWorkRef?.includes(':step:')&&node.includedIn).map(node=>node.includedIn).sort()).toEqual(crafts.flatMap(node=>[node.id,node.id]).sort());
    const detail=await new DigitalJourneyQuery(f.db).read(f.root,row.sourceId,undefined,true),current=detail.supervision!.nodes.find(node=>node.id==='development_sewing')!;
    expect(detail.orderId).toBeNull();expect(detail.supervision!.currentRevision).toBe(1);
    if(!date){expect(scope.customerGoal.precision).toBe('unknown');continue;}
    expect(scope.customerGoal).toMatchObject({precision:'date',value:date});
    // Material and pattern each take one hour; cutting and positioning run
    // in parallel for one hour. Four serial crafts then add 228 hours, and
    // the sewing work adds one. Included dispatch/receipt add nothing.
    const expected=new Date(Date.parse('2027-09-01T00:00:00.000Z')+(1+1+1+96+96+24+12+1)*3600000).toISOString();
    expect(current.current.at).toBe(expected);
    expect(current).toMatchObject({actualStart:null,actualEnd:null,forecast:current.current,forecastBasis:'plan'});
    expect((await repo.current(resource))!.identityHash).toBe(saved.identityHash);
   }
  });
 });

 it('re-adopts an older source arrangement with genuine remaining work while preserving the old B and history',async()=>{
  const settings=new OrderTimeSettingsService(f.db,true,false),standard=await settings.read(f.root);
  await settings.save(f.root,{expectedVersion:standard.version,values:r5OneHourConfiguration()},randomUUID());
  const scene=await f.scene('2026-12-01T00:00:00.000Z'),execution=new DevelopmentExecutionService(f.db,true),clerk=f.people['development-clerk']!;
  const row=await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2026-12-05',true);if(row.operation.kind!=='development_publish')throw Error('TEST original publication required');
   const published=await forms.publish(row.actor,row.sourceId,row.operation.input.expectedVersion,randomUUID(),row.operation.input.patternOrder);
   const view=await execution.read(clerk,row.sourceId),verification=view.materialVerification!,items=[{materialId:row.material!.materialId,physical:true,quantity:true,color:true,specification:true}];
   await execution.saveMaterials(clerk,row.sourceId,{taskId:published.taskId!,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:items.map(item=>({...item,usage:'use',note:'',confirmedWith:''}))},randomUUID());
   await execution.check(clerk,row.sourceId,{taskId:published.taskId!,expectedVerificationVersion:verification.version+1,result:'通过',note:'TEST genuine material completion',items},randomUUID());
   return row;
  });
  await f.advance(scene,'2026-12-06T00:00:00.000Z');
  const verified=await f.runtime.run(scene,f.root,async()=>{
   const resource={kind:'source' as const,id:row.sourceId},operation={kind:'arrangement' as const,resource},repo=new OrderTimePlanRepository(f.db),original=(await repo.current(resource))!;
   const cutRule=original.input.plan.company.nodes.development_cutting!;
   expect(cutRule.kind).toBe('work');
   const old=structuredClone(original.input),changed=structuredClone(old);
   changed.plan={...old.plan,revision:old.plan.revision+1,overrides:{development_cutting:{...cutRule,minutes:48*60,calendar:'continuous'}}};
   const client=await f.db.connect();
   try{
    await client.query('BEGIN');
    const time=await new ContextBusinessClock(f.db,client).read(resource),store=new OrderTimePlanRepository(client);
    // Persist the old supported storage shape through its original write,
    // without the newly captured inputs. No historical rows are rewritten.
    for(const [i,value] of [old,changed].entries())await store.confirm({resource,expectedRevision:1+i,value,actorId:f.root.actorId,eventRef:`TEST legacy approved revision ${i+2}`,time,requestKey:randomUUID()});
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   const history=async()=>((await f.db.query('SELECT * FROM digital_order_time_plan_versions WHERE source_id=$1 AND revision<4 ORDER BY revision',[row.sourceId])).rows);
   const retained=await history(),legacy=(await repo.current(resource))!,work=legacy.input.work.find(node=>node.id==='development_cutting')!,scope=legacy.input.scopes[0]!;
   expect(retained).toHaveLength(3);expect(legacy.input.formalTargets).toBeUndefined();
   const baseline=legacy.targets[scope.scopeRef]![work.id]!.end.at;
   expect(baseline).toBe(original.targets[scope.scopeRef]![work.id]!.end.at);
   const taskService=new DigitalProductionTaskService(f.db),source=await execution.read(f.root,row.sourceId),cut=source.tasks.find(task=>task.taskKind==='development_cutting')!,paper=source.tasks.find(task=>task.taskKind==='development_pattern')!;
   expect(cut).toMatchObject({state:'pending',enteredAt:null,completedAt:null});expect(paper.state).toBe('pending');
   const paperWindow=await taskService.read(f.root,paper.taskId);
   expect((await taskService.read(f.root,cut.taskId)).currentPlanTargets).toMatchObject({state:'unknown',planRevision:3,targets:[{endAt:null}]});
   const preview=await requests.check(f.root,operation);
   await requests.arrange(f.root,{resource,fingerprint:preview.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const adopted=(await repo.current(resource))!,arranged=adopted.input.formalTargets![scope.scopeRef]!,planned=arranged[work.id]!.end.at;
   expect(adopted.revision).toBe(4);
   expect(planned,JSON.stringify({cut:arranged[work.id],paper:arranged.development_pattern,progress:Object.fromEntries(Object.entries(adopted.input.formalInputs!.progress).map(([key,fact])=>[key.split(':').at(-1),fact]))})).not.toBeNull();
   expect(Date.parse(planned!)).toBeGreaterThan(Date.parse('2026-12-08T00:00:00.000Z'));
   const query=new DigitalJourneyQuery(f.db),journey=await query.read(f.root,row.sourceId,undefined,true),fixed=journey.fixedSchedule!.scopes[0]!.nodes.find(node=>node.canonicalWorkRef===work.canonicalWorkRef)!;
   expect(fixed).toMatchObject({currentTarget:{at:planned},goalDelta:{targetAt:baseline,actual:{precision:'unknown'}},ownSla:{deadlineAt:null}});
   expect(await taskService.read(f.root,cut.taskId)).toMatchObject({enteredAt:null,completedAt:null,currentPlanTargets:{state:'ready',targets:[{endAt:planned}]}});
   expect(await taskService.read(f.root,paper.taskId)).toMatchObject({enteredAt:paperWindow.enteredAt,dueAt:paperWindow.dueAt,completedAt:paperWindow.completedAt});
   expect(adopted.input.scopes[0]!.customerGoal).toEqual(scope.customerGoal);expect(await history()).toEqual(retained);
   return {cutId:cut.taskId,planned,planId:adopted.id};
  });
  await f.advance(scene,'2026-12-07T00:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const task=await new DigitalProductionTaskService(f.db).read(f.root,verified.cutId);
   expect(task.currentPlanTargets).toMatchObject({planVersionId:verified.planId,targets:[{endAt:verified.planned}]});
  });
 });

 it('requires late approval when an entered but pending predecessor still needs its full duration',async()=>{
  const settings=new OrderTimeSettingsService(f.db,true,false),standard=await settings.read(f.root);
  const values=r5OneHourConfiguration(),work=(hours:number)=>({kind:'work' as const,minutes:hours*60,calendar:'continuous' as const,reminder:{enabled:false,percent:70}});
  await settings.save(f.root,{expectedVersion:standard.version,values:{...values,nodes:{...values.nodes,development_pattern:work(12)}}},randomUUID());
  const start='2026-12-05T23:00:00.000Z',now='2026-12-06T10:00:00.000Z';
  const scene=await f.scene(start),execution=new DevelopmentExecutionService(f.db,true),clerk=f.people['development-clerk']!;
  const row=await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2026-12-08',true);if(row.operation.kind!=='development_publish')throw Error('TEST original source publication required');
   const published=await forms.publish(row.actor,row.sourceId,row.operation.input.expectedVersion,randomUUID(),row.operation.input.patternOrder);
   const view=await execution.read(clerk,row.sourceId),verification=view.materialVerification!,items=[{materialId:row.material!.materialId,physical:true,quantity:true,color:true,specification:true}];
   await execution.saveMaterials(clerk,row.sourceId,{taskId:published.taskId!,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:items.map(item=>({...item,usage:'use',note:'',confirmedWith:''}))},randomUUID());
   await execution.check(clerk,row.sourceId,{taskId:published.taskId!,expectedVerificationVersion:verification.version+1,result:'通过',note:'TEST genuine material completion',items},randomUUID());
   return row;
  });
  await f.advance(scene,now);
  await f.runtime.run(scene,f.root,async()=>{
   const resource={kind:'source' as const,id:row.sourceId},operation={kind:'arrangement' as const,resource};
   const repo=new OrderTimePlanRepository(f.db),before=(await repo.current(resource))!,overrides={development_cutting:work(48)};
   const paper=(await execution.read(f.root,row.sourceId)).tasks.find(task=>task.taskKind==='development_pattern')!;
   const tasks=new DigitalProductionTaskService(f.db);
   expect(await tasks.read(f.root,paper.taskId)).toMatchObject({state:'pending',enteredAt:start,dueAt:'2026-12-06T11:00:00.000Z'});
   const preview=await requests.check(f.root,operation,overrides);
   expect(preview).toMatchObject({feasibility:'insufficient',availableMinutes:54*60,forecastQuality:'conditional'});
   expect(preview.lateMinutes).toBeGreaterThanOrEqual(6*60);
   const body={resource,fingerprint:preview.fingerprint,overrides};
   await expect(requests.arrange(f.root,{...body,acceptLate:false},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_LATE_CONFIRMATION'});
   expect((await repo.current(resource))?.id).toBe(before.id);
   await requests.arrange(f.root,{...body,acceptLate:true},randomUUID());
   const adopted=(await repo.current(resource))!,scope=adopted.input.scopes[0]!,targets=adopted.input.formalTargets![scope.scopeRef]!;
   expect(adopted.revision).toBe(before.revision+1);
   expect(targets.development_pattern).toMatchObject({start:{at:now},end:{at:'2026-12-06T22:00:00.000Z'}});
   expect(Date.parse(targets.development_cutting!.end.at!)).toBeGreaterThanOrEqual(Date.parse(now)+60*3600000);
   expect(scope.terminalIds.map(id=>targets[id]!.end.at!).sort().at(-1)).toBe(preview.expectedEnd);
   expect(await tasks.read(f.root,paper.taskId)).toMatchObject({state:'pending',enteredAt:start,dueAt:'2026-12-06T11:00:00.000Z'});
  });
 });

 it('does not resurrect the same stale legacy P when its original pending task becomes ready',async()=>{
  const settings=new OrderTimeSettingsService(f.db,true,false),standard=await settings.read(f.root);
  await settings.save(f.root,{expectedVersion:standard.version,values:r5OneHourConfiguration()},randomUUID());
  const scene=await f.scene('2026-12-01T00:00:00.000Z'),execution=new DevelopmentExecutionService(f.db,true),clerk=f.people['development-clerk']!,worker=f.people['pattern-room-worker']!.actorId;
  const row=await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2026-12-05',true);if(row.operation.kind!=='development_publish')throw Error('TEST original publication required');
   const published=await forms.publish(row.actor,row.sourceId,row.operation.input.expectedVersion,randomUUID(),row.operation.input.patternOrder);
   const view=await execution.read(clerk,row.sourceId),verification=view.materialVerification!,items=[{materialId:row.material!.materialId,physical:true,quantity:true,color:true,specification:true}];
   await execution.saveMaterials(clerk,row.sourceId,{taskId:published.taskId!,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:items.map(item=>({...item,usage:'use',note:'',confirmedWith:''}))},randomUUID());
   await execution.check(clerk,row.sourceId,{taskId:published.taskId!,expectedVerificationVersion:verification.version+1,result:'通过',note:'TEST original material',items},randomUUID());
   return row;
  });
  const resource={kind:'source' as const,id:row.sourceId},repo=new OrderTimePlanRepository(f.db),tasks=new DigitalProductionTaskService(f.db);
  await f.advance(scene,'2026-12-06T00:00:00.000Z');
  const {version,cutId,originalB,workRef}=await f.runtime.run(scene,f.root,async()=>{
   const first=(await repo.current(resource))!,previous=structuredClone(first.input),legacy=structuredClone(previous);
   legacy.plan={...previous.plan,revision:previous.plan.revision+1,overrides:{development_cutting:{kind:'work',minutes:48*60,calendar:'continuous',reminder:{enabled:false,percent:70}}}};
   const client=await f.db.connect();try{
    await client.query('BEGIN');const repository=new OrderTimePlanRepository(client),time=await new ContextBusinessClock(f.db,client).read(resource);
    for(const [i,value] of [previous,legacy].entries())await repository.confirm({resource,expectedRevision:i+1,value,actorId:f.root.actorId,eventRef:'TEST legacy arrangement '+(i+2),time,requestKey:randomUUID()});
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   const version=(await repo.current(resource))!,cut=(await execution.read(f.root,row.sourceId)).tasks.find(task=>task.taskKind==='development_cutting')!;
   expect(version.input.formalTargets).toBeUndefined();
   expect(await tasks.read(f.root,cut.taskId)).toMatchObject({state:'pending',currentPlanTargets:{state:'unknown',planRevision:3,targets:[{endAt:null}]}});
   return {version,cutId:cut.taskId,originalB:version.targets[version.input.scopes[0]!.scopeRef]!.development_cutting!.end.at,workRef:version.input.work.find(work=>work.id==='development_cutting')!.canonicalWorkRef};
  });
  await f.advance(scene,'2026-12-06T06:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const state=await execution.read(f.root,row.sourceId),sheet=await forms.read(row.actor,row.sourceId),paper=state.tasks.find(task=>task.taskKind==='development_pattern')!;
   await execution.configureFixedCutting(f.root,row.sourceId,{expectedVersion:state.fixedCutting!.version,assigneeId:worker,reason:'TEST original cutting assignment'},randomUUID());
   await execution.arrange(clerk,row.sourceId,await arrangementInput(f.db,execution,clerk,row.sourceId,worker),randomUUID());
   expect((await tasks.read(f.root,paper.taskId)).state).toBe('ready');
   const artifact=await publishedTechnicalFixture(f.db,f.root,row.sourceId,sheet.document!,sheet.version,worker,f.attachments,f.storage);
   await execution.complete(f.root,row.sourceId,{taskId:paper.taskId,note:'TEST real paper completion and cutting handoff',
    attachmentIds:artifact?[]:[await taskResult(f.db,execution,f.root,row.sourceId,paper.taskId,'纸样成果')],...(artifact?{artifactRef:{id:artifact.artifactSetId,version:artifact.version,scopeRef:'整款'}}:{})},randomUUID());
   expect(await tasks.read(f.root,cutId)).toMatchObject({state:'ready',completedAt:null,currentPlanTargets:{state:'unknown',planVersionId:version.id,planRevision:3,targets:[{endAt:null}]}});
   const detail=await new DigitalJourneyQuery(f.db).read(f.root,row.sourceId,undefined,true);
   expect(detail.fixedSchedule?.scopes[0]?.nodes.find(node=>node.canonicalWorkRef===workRef)).toMatchObject({currentTarget:{at:null},goalDelta:{targetAt:originalB,actual:{precision:'unknown'}}});
   expect(await repo.current(resource)).toEqual(version);
  });
 });

 it('adopts an expressly approved new factory duration without altering the existing development freeze',async()=>{
  const settings=new OrderTimeSettingsService(f.db,true,true),standard=await settings.read(f.root);
  await settings.save(f.root,{expectedVersion:standard.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  const scene=await f.scene('2027-08-01T00:00:00.000Z');
  await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-10-01',true);if(row.operation.kind!=='development_publish')throw Error('TEST source publication required');
   const published=await forms.publish(row.actor,row.sourceId,row.operation.input.expectedVersion,randomUUID(),row.operation.input.patternOrder);
   expect(published.document!.customerOrderDraft).toBeUndefined();
   const source={kind:'source' as const,id:row.sourceId},repo=new OrderTimePlanRepository(f.db),original=(await repo.current(source))!;
   expect(original.input.work.some(work=>work.parameterKey==='factory_production_work')).toBe(false);
   const input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:published.designStyleNo,orderDate:'2027-08-01',contractDeliveryDate:'2027-08-15',requiresColorMatching:false,salesYear:2027,salesSeries:'P10',
    lines:[{formalPoNo:`TEST-C6-${randomUUID()}`,color:'黑',customerWarehouseArrivalDate:'2027-08-15',sizes:[{size:'M',quantity:2}]}],productionPlanning:{craftSteps:[],preshrink:false}});
   const operation={kind:'confirm_order' as const,sourceId:row.sourceId,input};
   const preflight=await requests.check(row.actor,operation);
   const pending=await requests.submit(row.actor,{operation,fingerprint:preflight.fingerprint,reason:'TEST approval for added factory work'},randomUUID());
   const overrides={factory_production_work:{kind:'forecast' as const,minutes:20*1440,calendar:'continuous' as const,reminder:{enabled:false,percent:70}}};
   const preview=await requests.read(f.root,pending.requestId,overrides);
   expect(preview.check).toMatchObject({coverage:[],feasibility:'insufficient'});
   const apply={expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides,acceptLate:true};
   const admissions=async()=>((await f.db.query(`SELECT (SELECT count(*) FROM digital_production_orders WHERE source_id=$1) AS orders,
    (SELECT count(*) FROM audit_events WHERE entity_id=$1::text AND action='order_time_activated') AS activations`,[source.id])).rows[0]);
   const before=await admissions();
   await expect(requests.apply(f.root,pending.requestId,{...apply,acceptLate:false},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_LATE_CONFIRMATION'});
   await expect(requests.apply(f.root,pending.requestId,{...apply,expectedVersion:apply.expectedVersion+1},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_STALE'});
   const altered={...overrides,development_cutting:{kind:'work' as const,minutes:120,calendar:'continuous' as const,reminder:{enabled:false,percent:70}}};
   const alteredPreview=await requests.read(f.root,pending.requestId,altered);
   await expect(requests.apply(f.root,pending.requestId,{...apply,overrides:altered,fingerprint:alteredPreview.check.fingerprint},randomUUID())).rejects.toThrow('正式订单须沿本单当前已确认的时间方案');
   expect(await admissions()).toEqual(before);
   expect((await requests.read(f.root,pending.requestId)).state).toBe('pending');expect(await repo.current(source)).toEqual(original);
   const key=randomUUID(),applied=await requests.apply(f.root,pending.requestId,apply,key),orderId=applied.result!.orderId!;
   expect(applied.state).toBe('applied');expect(orderId).toBeTruthy();
   const order={kind:'order' as const,id:orderId},initial=(await readInitialTimelineInput(f.db,order))!,effective=(await repo.current(order))!;
   expect(initial.data.orderTimePlan).toEqual(effective.input.plan);
   expect(effective.input.plan.company).toEqual(original.input.plan.company);
   expect(effective.input.plan.overrides).toEqual({...original.input.plan.overrides,...overrides});
   expect(effective.input.work.filter(work=>work.parameterKey==='factory_production_work')).toMatchObject([{canonicalWorkRef:expect.stringContaining(`order:${orderId}:`)}]);
   expect(effective.input.scopes[0]!.customerGoal).toMatchObject({precision:'date',value:'2027-08-15'});
   expect(await repo.current(source)).toEqual(original);expect((await admissions()).orders).toBe('1');
   expect(await requests.apply(f.root,pending.requestId,apply,key)).toEqual(applied);
   await expect(requests.apply(f.root,pending.requestId,{...apply,acceptLate:false},key)).rejects.toMatchObject({statusCode:409});
   expect(await repo.current(order)).toEqual(effective);
  });
 });

 it('checks and formally adopts two frozen special steps without leaking internal step IDs into strict choice contracts',async()=>{
   const settings=new OrderTimeSettingsService(f.db,true,true),standard=await settings.read(f.root);
   await settings.save(f.root,{expectedVersion:standard.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
   const library=new SpecialCraftLibraryService(f.db),steps=[];
   for(const [index,name] of ['TEST contract special B','TEST contract special C'].entries()){
    const rule={minutes:60*(index+1),calendar:'continuous' as const,reminder:{enabled:false,percent:70}};
    const snapshot=await library.save(f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:rule,bulk:{...rule,minutes:rule.minutes*2}}},randomUUID());
    steps.push({craftKind:'special' as const,sequence:index+1,specialCraft:snapshot});
   }
  const scene=await f.scene('2027-10-01T00:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   const row=await make(null),before=await forms.read(row.actor,row.sourceId);
   const ordering=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:before.designStyleNo,orderDate:'2027-10-01',contractDeliveryDate:'2028-04-16',requiresColorMatching:false,salesYear:2028,salesSeries:'P04',
    lines:[{formalPoNo:'TEST-special-'+randomUUID(),color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2028-04-16',sizes:[{size:'M',quantity:'2'}]}]});
   const saved=await forms.save(row.actor,row.sourceId,{expectedVersion:before.version,document:{...before.document!,craft:'特殊工艺',craftSteps:steps,productionPlanning:{craftSteps:steps,preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal',order:ordering}}},randomUUID());
   const operation:OrderTimeOperation={...row.operation,input:{...(row.operation.kind==='development_publish'?row.operation.input:{}),expectedVersion:saved.version}} as OrderTimeOperation;
   const check=await requests.check(row.actor,operation);expect(check.framework!.milestones).toHaveLength(8);expect(check.feasibility).not.toBe('unknown');
   const pending=await requests.submit(row.actor,{operation,fingerprint:check.fingerprint,reason:'TEST full special craft ordering'},randomUUID());
   const preview=await requests.read(f.root,pending.requestId),result=await requests.apply(f.root,pending.requestId,{expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   expect(result.state).toBe('applied');expect(result.result!.orderId).toBeTruthy();
   const resource={kind:'order' as const,id:result.result!.orderId!},adopted=(await new OrderTimePlanRepository(f.db).current(resource))!;
   expect(adopted.input.frameworkPlans).toBeDefined();
   const work=adopted.input.work.filter(work=>work.craftStep?.craftKind==='special');expect(work).toHaveLength(4);
   expect(new Set(work.map(work=>work.canonicalWorkRef)).size).toBe(4);
   for(const item of work){expect(Object.keys(item.craftStep!)).not.toContain('stepId');expect(item.craftStep!.specialCraft!.version).toBe(1);expect(item.canonicalWorkRef).toContain(':step:');}
   const read=await requests.check(f.root,{kind:'arrangement',resource});expect(read.framework!.milestones).toHaveLength(8);
   expect((await forms.read(row.actor,row.sourceId)).document!.craftSteps).toEqual(steps);
  });
 });

 it.each([false,true])('connects a same-round material recheck to the original paper R and Sunday-excluded D, framework=%s',async(framework)=>{
  const settings=new OrderTimeSettingsService(f.db),current=await settings.read(f.root),values=framework?prepareTimeFrameworkConfiguration(r5OneHourConfiguration()):r5OneHourConfiguration();
  await settings.save(f.root,{expectedVersion:current.version,values:{...values,nodes:{...values.nodes,development_pattern:{kind:'work',minutes:4320,calendar:'beijing_sunday_excluded',reminder:{enabled:true,percent:80}}}}},randomUUID());
  const scene=await f.scene('2026-11-20T04:00:00.000Z'),execution=new DevelopmentExecutionService(f.db,true),tasks=new DigitalProductionTaskService(f.db),clerk=f.people['development-clerk']!;
  const prepared=await f.runtime.run(scene,f.root,async()=>{
   const row=await make('2027-10-01',true),before=await forms.read(row.actor,row.sourceId);
   const saved=await forms.save(row.actor,row.sourceId,{expectedVersion:before.version,document:{...before.document!,materials:before.document!.materials.map(m=>({...m,available:false,expectedDate:'2026-11-21'})),productionPlanning:{craftSteps:[],preshrink:false}}},randomUUID());
   if(row.operation.kind!=='development_publish')throw Error('TEST original publish required');
   const published=await forms.publish(row.actor,row.sourceId,saved.version,randomUUID(),row.operation.input.patternOrder),taskId=published.taskId!,materialId=row.material!.materialId;
   const entry={materialId,usage:'use' as const,physical:false,quantity:true,color:true,specification:true,note:'',confirmedWith:''},issues=[{materialId,field:'physical' as const,reason:'TEST real missing material',need:'supply' as const}];
   const verification=await execution.saveMaterials(clerk,row.sourceId,{taskId,expectedVersion:0,expectedDocumentVersion:published.version,entries:[entry],result:'缺项退回',returnIssues:issues},randomUUID());
   await execution.check(clerk,row.sourceId,{taskId,expectedVerificationVersion:verification.version,result:'缺项退回',returnIssues:issues,note:'TEST return missing material',items:[entry]},randomUUID());
   const supply=(await execution.read(row.actor,row.sourceId)).tasks.find(t=>t.taskKind==='development_material_supply'&&t.state==='ready')!;
   await expect(forms.materialEvent(row.actor,row.sourceId,materialId,{expectedRound:1,expectedVersion:published.version,expectedMaterialRevision:0,action:'到货',expectedDate:null,note:'TEST designer cannot certify arrival'},randomUUID())).rejects.toMatchObject({statusCode:403});
   const recheck=await execution.resubmit(row.actor,row.sourceId,supply.taskId,randomUUID()) as {taskId:string};
   expect((await tasks.read(clerk,recheck.taskId)).state).toBe('ready');
   expect((await forms.read(row.actor,row.sourceId)).materialEvents).toEqual([]);
   return {...row,initialTaskId:taskId,recheckId:recheck.taskId,materialId};
  });
  await f.advance(scene,'2026-11-21T04:00:00.000Z');
  const passed=await f.runtime.run(scene,f.root,async()=>{
   const view=await execution.read(clerk,prepared.sourceId),verification=view.materialVerification!,entries=[{materialId:prepared.materialId,usage:'use' as const,physical:true,quantity:true,color:true,specification:true,note:'',confirmedWith:''}];
   const saved=await execution.saveMaterials(clerk,prepared.sourceId,{taskId:prepared.recheckId,expectedVersion:verification.version,expectedDocumentVersion:verification.documentVersion,entries,result:'通过'},randomUUID());
   const key=randomUUID(),body={taskId:prepared.recheckId,expectedVerificationVersion:saved.version,result:'通过' as const,note:'TEST current recheck passed',items:entries};
   const result=await execution.check(clerk,prepared.sourceId,body,key),paper=(await execution.read(f.root,prepared.sourceId)).tasks.find(t=>t.taskKind==='development_pattern')!;
   expect(await execution.check(clerk,prepared.sourceId,body,key)).toEqual(result);
   expect((await f.db.query('SELECT predecessor_id FROM digital_production_task_dependencies WHERE task_id=$1',[paper.taskId])).rows).toEqual([{predecessor_id:prepared.recheckId}]);
   expect((await f.db.query("SELECT 1 FROM digital_production_task_events WHERE task_id=$1 AND event_kind='material_returned'",[prepared.initialTaskId])).rowCount).toBe(1);
   expect((await f.db.query('SELECT route_schema_version FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision DESC LIMIT 1',[prepared.sourceId])).rows[0].route_schema_version).toBe(2);
   const nativePaper=await tasks.read(f.root,paper.taskId);
   expect(nativePaper).toMatchObject({enteredAt:'2026-11-21T04:00:00.000Z',dueAt:'2026-11-25T04:00:00.000Z',slaHours:72});
   const detail=await new DigitalJourneyQuery(f.db).read(f.root,prepared.sourceId,undefined,true),projected=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===paper.taskId)!;
   expect(projected.timing).toMatchObject({actualStart:nativePaper.enteredAt,target:{at:nativePaper.dueAt},status:'running'});
   const nativeRecheck=await tasks.read(f.root,prepared.recheckId),rechecked=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===prepared.recheckId)!;
   expect(rechecked.timing).toMatchObject({id:`development_materials:task:${prepared.recheckId}`,actualStart:nativeRecheck.enteredAt,actualEnd:nativeRecheck.completedAt,target:{at:nativeRecheck.dueAt}});
   expect(detail.supervision!.nativeFacts).toContainEqual(expect.objectContaining({id:`development_materials:task:${prepared.recheckId}`,completedAt:nativeRecheck.completedAt,businessCompleted:true}));
   const stored=await new JourneyFactRepository(f.db).buildOne({kind:'source',id:prepared.sourceId});
   expect(stored.model.sla.facts.development_pattern!.responsibilityWindow).toMatchObject({startedAt:nativePaper.enteredAt,deadline:{at:nativePaper.dueAt},warningAt:nativePaper.warningAt,calendar:'beijing_sunday_excluded'});
   return {paperId:paper.taskId,completed:(await tasks.history(f.root,prepared.recheckId)).events.find(e=>e.kind==='completed')!};
  });
  await f.advance(scene,'2026-11-21T06:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
   await execution.arrange(clerk,prepared.sourceId,await arrangementInput(f.db,execution,clerk,prepared.sourceId,f.people['pattern-room-worker']!.actorId),randomUUID());
   expect(await tasks.read(f.root,passed.paperId)).toMatchObject({enteredAt:'2026-11-21T04:00:00.000Z',dueAt:'2026-11-25T04:00:00.000Z'});
   for(const at of ['2026-11-21T05:00:00.000Z',null,'2026-11-21T04:00:00.000Z']){
    await tasks.correctTime(f.root,prepared.recheckId,{eventId:passed.completed.eventId,occurredAt:at,reason:'TEST verify exact predecessor occurrence'},randomUUID());
    expect(await tasks.read(f.root,passed.paperId)).toMatchObject({enteredAt:at,dueAt:at?at.replace('11-21','11-25'):null});
   }
   expect((await f.db.query("SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_pattern'",[prepared.sourceId])).rows[0].n).toBe(1);
  });
 });

 describe('linked source and order first activation',()=>{
  const orderedDraft=async()=>{
   const row=await make('2027-10-01',true),before=await forms.read(row.actor,row.sourceId);
   const ordering=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:before.designStyleNo,orderDate:'2027-10-01',contractDeliveryDate:'2027-10-01',requiresColorMatching:false,salesYear:2027,salesSeries:'P10',
    lines:[{formalPoNo:'TEST-READY-SCOPE-'+randomUUID(),color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2027-10-01',sizes:[{size:'M',quantity:'1'}]}]});
   const saved=await forms.save(row.actor,row.sourceId,{expectedVersion:before.version,document:{...before.document!,productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal',order:ordering}}},randomUUID());
   if(row.operation.kind!=='development_publish')throw Error('TEST development publication required');
   return {...row,operation:{...row.operation,input:{...row.operation.input,expectedVersion:saved.version}}};
  };
  const application=async(row:Awaited<ReturnType<typeof orderedDraft>>)=>{
   const pending=await submit(row),manager=f.people['production-management']!;
   const overrides={development_materials:{kind:'work' as const,minutes:45,calendar:'continuous' as const,reminder:{enabled:true,percent:80}}};
   const preview=await requests.read(manager,pending.requestId,overrides);
   return {pending,manager,body:{expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides,acceptLate:true},key:randomUUID()};
  };
  it.each([false,true])('keeps a source READY task executable after its original order application, framework=%s',async(framework)=>{
   const settings=new OrderTimeSettingsService(f.db),current=await settings.read(f.root);
   await settings.save(f.root,{expectedVersion:current.version,values:framework?prepareTimeFrameworkConfiguration(r5OneHourConfiguration()):r5OneHourConfiguration()},randomUUID());
   const scene=await f.scene('2027-10-01T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
    const unrelated=await make('2027-10-01',true),row=await orderedDraft(),ap=await application(row);
    await expect(forms.publish(row.actor,row.sourceId,row.operation.input.expectedVersion,randomUUID(),row.operation.input.patternOrder)).rejects.toMatchObject({code:'ORDER_TIME_REQUEST_REQUIRED'});
    expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=$1',[row.sourceId])).rows[0].effective).toBe(false);
    expect((await f.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
    const applied=await requests.apply(ap.manager,ap.pending.requestId,ap.body,ap.key),orderId=applied.result!.orderId!;
    const execution=new DevelopmentExecutionService(f.db,true),clerk=f.people['development-clerk']!,view=await execution.read(clerk,row.sourceId);
    const task=view.tasks.find(task=>task.taskKind==='development_materials')!,verification=view.materialVerification!;
    expect(task).toMatchObject({sourceId:row.sourceId,orderId:null,canExecute:true,state:'ready'});
    const items=[{materialId:row.material!.materialId,physical:true,quantity:true,color:true,specification:true}];
    await execution.saveMaterials(clerk,row.sourceId,{taskId:task.taskId,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:items.map(item=>({...item,usage:'use',note:'',confirmedWith:''})),note:'TEST original READY material check',result:'通过'},randomUUID());
    await execution.check(clerk,row.sourceId,{taskId:task.taskId,expectedVerificationVersion:verification.version+1,result:'通过',note:'TEST original READY material check',items},randomUUID());
    expect(await new DigitalProductionTaskService(f.db).read(clerk,task.taskId)).toMatchObject({state:'completed',slaHours:0.75});
    const repo=new OrderTimePlanRepository(f.db),sourcePlan=(await repo.current({kind:'source',id:row.sourceId}))!,orderPlan=(await repo.current({kind:'order',id:orderId}))!;
    expect(sourcePlan).not.toBeNull();expect(orderPlan).not.toBeNull();
    expect(sourcePlan.input.plan.company).toEqual(orderPlan.input.plan.company);
    expect(sourcePlan.input.plan.overrides).toEqual(ap.body.overrides);
    expect(sourcePlan.eventRef).toBe(orderPlan.eventRef);expect(sourcePlan.revision).toBe(1);expect(orderPlan.revision).toBe(1);
    expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=$1 OR production_order_id=$2',[row.sourceId,orderId])).rows).toEqual([{effective:true},{effective:true}]);
    expect(await requests.apply(ap.manager,ap.pending.requestId,ap.body,ap.key)).toEqual(applied);
    expect(await repo.current({kind:'source',id:row.sourceId})).toEqual(sourcePlan);expect(await repo.current({kind:'order',id:orderId})).toEqual(orderPlan);
    expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=$1',[unrelated.sourceId])).rows[0].effective).toBe(false);
    expect(await repo.current({kind:'source',id:unrelated.sourceId})).toBeNull();
    const unrelatedResource={kind:'source' as const,id:unrelated.sourceId},unrelatedCheck=await requests.check(f.root,{kind:'arrangement',resource:unrelatedResource});
    await expect(requests.arrange(f.root,{resource:unrelatedResource,overrides:{},fingerprint:unrelatedCheck.fingerprint,acceptLate:true},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_REQUEST_REQUIRED'});
   });
  });
  it('rolls back both plans, native publication and effectiveness when the order plan cannot commit, then replays once',async()=>{
   const scene=await f.scene('2027-10-01T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
    const row=await orderedDraft(),ap=await application(row),before=await forms.read(row.actor,row.sourceId),confirm=OrderTimePlanRepository.prototype.confirm;
    let sourcePlanWasWritten=false;
    const spy=vi.spyOn(OrderTimePlanRepository.prototype,'confirm').mockImplementation(async function(this:OrderTimePlanRepository,input,refresh){
     if(input.resource.kind==='order')throw Error('TEST order plan persistence failure');
     const saved=await confirm.call(this,input,refresh);sourcePlanWasWritten=true;return saved;
    });
    try{await expect(requests.apply(ap.manager,ap.pending.requestId,ap.body,ap.key)).rejects.toThrow('TEST order plan persistence failure');}finally{spy.mockRestore();}
    expect(sourcePlanWasWritten).toBe(true);
    expect((await forms.read(row.actor,row.sourceId)).version).toBe(before.version);
    expect((await f.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
    expect((await f.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
    expect((await f.db.query('SELECT 1 FROM digital_order_time_plan_versions WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
    expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=$1',[row.sourceId])).rows[0].effective).toBe(false);
    expect((await requests.read(ap.manager,ap.pending.requestId)).state).toBe('pending');
    expect((await f.db.query("SELECT 1 FROM audit_events WHERE action='order_time_activated' AND after_state->>'requestId'=$1",[ap.pending.requestId])).rowCount).toBe(0);
    expect((await f.db.query("SELECT 1 FROM digital_order_time_request_events WHERE request_id=$1 AND action='applied'",[ap.pending.requestId])).rowCount).toBe(0);
    expect((await f.db.query('SELECT 1 FROM digital_production_commands WHERE command=$1 AND key=$2',['order-time:apply:'+ap.pending.requestId,ap.key])).rowCount).toBe(0);
    const applied=await requests.apply(ap.manager,ap.pending.requestId,ap.body,ap.key);
    expect(await requests.apply(ap.manager,ap.pending.requestId,ap.body,ap.key)).toEqual(applied);
    expect((await f.db.query('SELECT 1 FROM digital_order_time_plan_versions WHERE source_id=$1 OR production_order_id=$2',[row.sourceId,applied.result!.orderId])).rowCount).toBe(2);
   });
  });
  it('recovers only an exact original source qualification, preserving frozen plans and task windows with one audited idempotent update',async()=>{
   const scene=await f.scene('2027-10-01T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
    const row=await orderedDraft(),ap=await application(row),applied=await requests.apply(ap.manager,ap.pending.requestId,ap.body,ap.key),orderId=applied.result!.orderId!,recovery=new OrderTimeScopeRecoveryService(f.db,new RootAuthority(f.db,"anchor-test",undefined));
    const frozen=async()=>({plans:(await f.db.query('SELECT * FROM digital_order_time_plan_versions WHERE source_id=$1 OR production_order_id=$2 ORDER BY plan_version_id',[row.sourceId,orderId])).rows,
     tasks:(await f.db.query('SELECT t.*,a.source_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 ORDER BY t.task_id',[row.sourceId])).rows,
     revisions:(await f.db.query('SELECT r.* FROM digital_production_deadline_revisions r JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 ORDER BY revision_id',[row.sourceId])).rows});
    const original=await frozen();await f.db.query('UPDATE digital_order_time_subjects SET effective=false WHERE source_id=$1',[row.sourceId]);
    const clerk=f.people['development-clerk']!,task=(await new DevelopmentExecutionService(f.db,true).read(clerk,row.sourceId)).tasks.find(t=>t.taskKind==='development_materials')!;
    expect(task.canExecute).toBe(false);await expect(new DigitalProductionTaskService(f.db).complete(clerk,task.taskId,{},randomUUID())).rejects.toThrow('尚未生效');
    await expect(recovery.preview(clerk,ap.pending.requestId)).rejects.toMatchObject({statusCode:403});
    await expect(recovery.preview({...clerk,actorRoles:['root_superuser']},ap.pending.requestId)).rejects.toMatchObject({statusCode:403});
    await f.db.query("UPDATE identity_mappings SET active=false WHERE user_id=$1 AND provider='dingtalk'",[f.root.actorId]);
    try{await expect(recovery.preview(f.root,ap.pending.requestId)).rejects.toMatchObject({statusCode:403});}
    finally{await f.db.query("UPDATE identity_mappings SET active=true WHERE user_id=$1 AND provider='dingtalk'",[f.root.actorId]);}
    const preview=await recovery.preview(f.root,ap.pending.requestId);expect(preview).toMatchObject({state:'ready',proof:{sourceId:row.sourceId,orderId,effective:false}});
    const body={requestId:ap.pending.requestId,fingerprint:preview.fingerprint,reason:'TEST recover an existing original approval reference only'},key=randomUUID();
    await expect(recovery.recover(f.root,{...body,fingerprint:'0'.repeat(64)},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_STALE'});
    const [result,concurrent]=await Promise.all([recovery.recover(f.root,body,key),recovery.recover(f.root,body,key)]);expect(concurrent).toEqual(result);expect(result).toMatchObject({sourceId:row.sourceId,changed:true});
    expect(await recovery.recover(f.root,body,key)).toEqual(result);await expect(recovery.recover(f.root,{...body,reason:'different'},key)).rejects.toMatchObject({code:'ORDER_TIME_CONFLICT'});
    expect(await frozen()).toEqual(original);expect(await new DigitalProductionTaskService(f.db).read(clerk,task.taskId)).toMatchObject({canExecute:true});
    const current=await recovery.preview(f.root,ap.pending.requestId);expect(current.state).toBe('already_consistent');
    expect(await recovery.recover(f.root,{...body,fingerprint:current.fingerprint},randomUUID())).toMatchObject({changed:false,auditId:null});
    expect((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='order_time_scope_consistency_recovered'",[row.sourceId])).rows[0].n).toBe(1);
   });
  });
  it('refuses qualification recovery when original source evidence is unavailable, the request is pending or lifecycle is terminated',async()=>{
   const scene=await f.scene('2027-10-01T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
    const row=await orderedDraft(),ap=await application(row),recovery=new OrderTimeScopeRecoveryService(f.db,new RootAuthority(f.db,"anchor-test",undefined));
    expect(await recovery.preview(f.root,ap.pending.requestId)).toMatchObject({state:'blocked',blockers:['原申请不是已生效的批准记录']});
    const applied=await requests.apply(ap.manager,ap.pending.requestId,ap.body,ap.key);await f.db.query('UPDATE digital_order_time_subjects SET effective=false WHERE source_id=$1',[row.sourceId]);
    const current=OrderTimePlanRepository.prototype.current,spy=vi.spyOn(OrderTimePlanRepository.prototype,'current').mockImplementation(async function(this:OrderTimePlanRepository,resource){return resource.kind==='source'?null:current.call(this,resource);});
    try{
     const preview=await recovery.preview(f.root,ap.pending.requestId);expect(preview.state).toBe('blocked');expect(preview.blockers.join()).toContain('缺少原批准开发方案');
     await expect(recovery.recover(f.root,{requestId:ap.pending.requestId,fingerprint:preview.fingerprint,reason:'TEST unavailable original evidence'},randomUUID())).rejects.toMatchObject({code:'ORDER_TIME_RECOVERY_BLOCKED'});
    }finally{spy.mockRestore();}
    await f.db.query("INSERT INTO digital_production_resource_lifecycle(resource_kind,resource_id,state,changed_by) VALUES('source',$1,'cancelled',$2) ON CONFLICT(resource_kind,resource_id) DO UPDATE SET state='cancelled'",[row.sourceId,f.root.actorId]);
    const blocked=await recovery.preview(f.root,ap.pending.requestId);expect(blocked).toMatchObject({state:'blocked',blockers:['资源已暂停、取消或特殊结案，不恢复办理资格']});
    expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=$1',[row.sourceId])).rows[0].effective).toBe(false);
    expect((await f.db.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='order_time_scope_consistency_recovered'",[row.sourceId])).rowCount).toBe(0);
    expect(applied.result!.orderId).toBeTruthy();
   });
  });
  it.each([false,true])('rejects a mismatched or missing native source instead of activating another saved draft, missing=%s',async(missing)=>{
   const scene=await f.scene('2027-10-01T15:00:00.000Z');await f.runtime.run(scene,f.root,async()=>{
    const row=await orderedDraft(),other=await make('2027-10-01',true),ap=await application(row),execute=orderTimeNativeExecutor(f.db,true,native);
    const wrong=new OrderTimeRequestService(f.db,async(...args)=>({...await execute(...args),sourceId:missing?null:other.sourceId}));
    await expect(wrong.apply(ap.manager,ap.pending.requestId,ap.body,ap.key)).rejects.toMatchObject({code:'ORDER_TIME_CONFLICT'});
    expect((await f.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[row.sourceId])).rowCount).toBe(0);
    expect((await f.db.query('SELECT effective FROM digital_order_time_subjects WHERE source_id=ANY($1::uuid[])',[[row.sourceId,other.sourceId]])).rows.every(row=>row.effective===false)).toBe(true);
    expect((await f.db.query('SELECT 1 FROM digital_order_time_plan_versions WHERE source_id=ANY($1::uuid[])',[[row.sourceId,other.sourceId]])).rowCount).toBe(0);
   });
  });
 });

});
