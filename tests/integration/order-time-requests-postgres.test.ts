import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import type {OrderTimeOperation} from '@dx-rework/contracts/order-time-requests';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {TodoTimingService} from '../../apps/api/src/todos/timing-service.js';
import {OperationEventRepository} from '../../apps/api/src/tools/repositories.js';
import * as sourcingTiming from '../../apps/api/src/production-platform/sourcing-todo-sla.js';
import {orderTimeTodos} from '../../apps/api/src/production-platform/order-time-todos.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {arrangementInput} from '../helpers/development-arrangement-fixture.js';
import {slaNotificationPreferences} from '../../apps/api/src/production-platform/sla-notification-preferences.js';
import {DigitalPoDateRepository} from '../../apps/api/src/production-platform/po-date-repository.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {productionReadinessFixture} from '../helpers/production-readiness-fixture.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('R5 native first-effective order time and one request transaction',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,identity:DigitalProductionIdentityService,forms:DigitalDevelopmentService,requests:OrderTimeRequestService,standardId:string,native:PatternRoomOrderService;
 const make=async(date:string,withMaterial=false)=>{
  const original=f.people['sample-designer']!,actor={...original,authorizationCapabilities:[...original.authorizationCapabilities!,'pattern_room:orders:view']},source=await identity.createSource(actor,{developmentType:'头版',designStyleNo:'TEST-R507-'+randomUUID(),temporaryStyleNo:null,customerCode:null},randomUUID());
  const material=withMaterial?{materialId:randomUUID(),category:'主布',label:'TEST主布',supplier:'TEST',name:'TEST 已备主布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}:null;
  const photo=await f.image(actor),document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:date,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST original business source',craft:'无',washing:'免洗',materials:material?[material]:[],files:[{attachmentId:photo,kind:'款图'}]});
  const sheet=await forms.save(actor,source.sourceId,{expectedVersion:0,document},randomUUID()),price=(await f.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0];
  const operation:OrderTimeOperation={kind:'development_publish',sourceId:source.sourceId,input:{expectedVersion:sheet.version,patternOrder:{categoryId:price.price_id,priceVersion:price.version}}};
  return {sourceId:source.sourceId,photo,operation,actor,material};
 };
 const submit=async(row:Awaited<ReturnType<typeof make>>)=>{const check=await requests.check(row.actor,row.operation);return requests.submit(row.actor,{operation:row.operation,fingerprint:check.fingerprint,reason:'TEST 按实际工艺申请本单调整'},randomUUID());};
 const compress=(state:Awaited<ReturnType<typeof submit>>)=>Object.fromEntries(state.check.rows.flatMap(row=>row.rule&&['work','included','forecast'].includes(row.rule.kind)?[[row.parameterKey,{...row.rule,minutes:row.rule.kind==='included'?2:10} as OrderTimeRule]]:[]));
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);identity=new DigitalProductionIdentityService(f.db,true);
  native=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});forms=new DigitalDevelopmentService(f.db,true,native);requests=new OrderTimeRequestService(f.db,orderTimeNativeExecutor(f.db,true,native));
  const standard=await new OrderTimeSettingsService(f.db).save(f.root,{expectedVersion:0,values:r5OneHourConfiguration()},randomUUID());standardId=standard.record.id;
  expect((await f.db.query("SELECT current_setting('is_superuser') AS value")).rows[0].value).toBe('off');
 });
 afterAll(async()=>{await f?.dispose();});
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
  await new OrderTimeSettingsService(f.db).save(f.root,{expectedVersion:1,values:changed},randomUUID());
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
  const standards=new OrderTimeSettingsService(f.db),current=await standards.read(f.root);await standards.save(f.root,{expectedVersion:current.version,values:r5OneHourConfiguration()},randomUUID());
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
   const policy=await new OrderTimePlanRepository(f.db).current({kind:'source',id:row!.sourceId});expect(policy?.input.plan.company.reference).toBe('order-time-company:'+((await new OrderTimeSettingsService(f.db).read(f.root)).record!.id));
   expect(policy?.input.work.some(work=>work.parameterKey==='development_materials')).toBe(false);expect(policy?.input.work.filter(work=>work.parameterKey==='development_printing')).toHaveLength(1);
   expect(policy?.input.work.find(work=>work.parameterKey==='development_pattern')?.canonicalWorkRef).toContain(':round:2:');
   expect((await f.db.query('SELECT entered_at,due_at FROM digital_production_deadline_revisions WHERE task_id=$1 AND entered_at IS NOT NULL ORDER BY revision_id LIMIT 1',[oldPattern!])).rows[0]).toEqual(oldDeadline);
   const history=(await rounds.read(row!.actor,row!.sourceId)).rounds.find(round=>round.roundNumber===2)!;expect(history.inherited).toHaveProperty('development_materials');
  });
 });
 it('keeps the old production route effective while the main merchandiser hands an insufficient saved change to its designer and a manager applies both changes once',async()=>{
  const settings=new OrderTimeSettingsService(f.db),standard=await settings.read(f.root),values=r5OneHourConfiguration();values.nodes.bulk_printing={kind:'work',minutes:2880,calendar:'continuous',reminder:{enabled:true,percent:70}};await settings.save(f.root,{expectedVersion:standard.version,values},randomUUID());
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
});
