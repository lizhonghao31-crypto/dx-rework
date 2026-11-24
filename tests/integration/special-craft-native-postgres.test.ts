import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {developmentSlaEvidence} from '../../apps/api/src/production-platform/development-sla-evidence.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFilterSchema} from '@dx-rework/contracts/digital-production-journey';
import {JOURNEY_FACT_CALCULATION_VERSION} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {arrangementInput} from '../helpers/development-arrangement-fixture.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {productionReadinessFixture} from '../helpers/production-readiness-fixture.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {approveFixtureCraftPrice,bindFixtureCraftApprover} from '../helpers/secondary-craft-approval-fixture.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {SpecialCraftLibraryService} from '../../apps/api/src/production-platform/special-craft-library.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {FixedTimelineAdoptionRepository} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('special crafts through original development commands',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);configureTimelineAdoption(f.db,'fixed_v2');});
 afterAll(async()=>{if(f){configureTimelineAdoption(f.db,'legacy');await f.dispose();}});
 it('assigns and completes multiple distinct special tasks through dispatch, work and return confirmation',async()=>{
  const library=new SpecialCraftLibraryService(f.db),steps:CraftStepChoice[]=[];
  for(const [index,name]of ['TEST 激光','TEST 烫钻'].entries()){
   const saved=await library.save(f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:{minutes:60*(index+1),calendar:'continuous',reminder:{enabled:true,percent:70}},bulk:{minutes:240*(index+1),calendar:'continuous',reminder:{enabled:false,percent:80}}}},randomUUID());
   steps.push({craftKind:'special',sequence:index+1,specialCraft:saved});
  }
  const created=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,undefined,[['特殊工艺','免洗']],{fixedCraftSteps:steps,automaticQuotation:true,onRouteComplete:async(sourceId,kind)=>{
   if(kind!=='development_craft_dispatch')return;
   const pending=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_printing' AND t.state='ready'",[sourceId])).rows[0];
   const todos=await new DigitalProductionNotificationService(f.db).todos(f.people['pattern-room-worker']!);
   const own=todos.find(todo=>todo.todoId===pending.task_id);expect(own).toBeDefined();
   expect(own!.taskTitle).toMatch(/TEST 激光|TEST 烫钻/);
  }});
  const saved=(await new FixedTimelineAdoptionRepository(f.db).existing({kind:'source',id:created[0]!.sourceId},1))!;
  expect(saved.input.craftSteps?.map(step=>step.specialCraft?.definition.name)).toEqual(['TEST 激光','TEST 烫钻']);
  // Both native rich detail and the compact list must retain the captured
  // task/step windows; comparing to native rows detects a shared last-kind R/D.
  const journey=new DigitalJourneyQuery(f.db),sid=created[0]!.sourceId;
  const nativeRows=(await f.db.query(`SELECT t.task_id,a.task_kind,t.entered_at,r.due_at,p.step_id,p.phase
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    JOIN digital_timeline_task_positions p USING(task_id)
    LEFT JOIN LATERAL(SELECT due_at FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)r ON true
    WHERE a.source_id=$1 AND p.phase IN ('dispatch','work','confirmation') ORDER BY p.route_position`,[sid])).rows;
  const detail=await journey.read(f.root,sid),listed=(await journey.list(f.root,JourneyFilterSchema.parse({scope:'development',search:detail.designStyleNo}),true)).items.find(item=>item.sourceId===sid)!;
  for(const item of [detail,listed]){
   const nodes=item.stages.flatMap(stage=>stage.nodes).filter(node=>nativeRows.some(row=>row.task_id===node.instanceId));
   expect(nodes.map(node=>node.instanceId)).toEqual(nativeRows.map(row=>row.task_id));
   for(const row of nativeRows){const node=nodes.find(node=>node.instanceId===row.task_id)!;expect(node.timing?.actualStart).toBe(row.entered_at.toISOString());expect(node.timing?.target.at).toBe(row.due_at.toISOString());expect(node.label).toContain(row.step_id===nativeRows[0]!.step_id?'TEST 激光':'TEST 烫钻');}
  }
  // The original fact builder must carry each instance and invalidate the old
  // calculation version; projection storage must never erase step identity.
  const client=await f.db.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const model=await journey.buildFactsWithClient(client,{kind:'source',id:sid},businessNow().toISOString());expect(model.sla.instances?.filter(instance=>instance.stepRef!==null).map(instance=>instance.taskId).sort()).toEqual(nativeRows.map(row=>row.task_id).sort());
   for(const instance of model.sla.instances??[])expect(model.tasks.some(task=>task.id===instance.taskId&&task.sourceId===instance.sourceId&&task.routeVersion===instance.round&&task.routeInstanceId===instance.routeRef)).toBe(true);
   await client.query('ROLLBACK');}finally{client.release();}
  await new JourneyFactRepository(f.db).buildOne({kind:'source',id:sid});
  expect((await f.db.query('SELECT calculation_version FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2',['source',sid])).rows[0]?.calculation_version).toBe(JOURNEY_FACT_CALCULATION_VERSION);
  const quotes=new DigitalQuotationService(f.db,true),resource={kind:'source' as const,id:created[0]!.sourceId},worker=f.people['pattern-room-worker']!;
  const approver=await bindFixtureCraftApprover(f);
  let quote=await quotes.read(worker,resource);
  const own=quote.rows.filter(row=>row.name==='TEST 激光'||row.name==='TEST 烫钻');
  expect(own).toHaveLength(2);expect(own.map(row=>row.craftBasis)).toEqual(steps.map(step=>({stage:'development',libraryId:step.specialCraft!.id,libraryVersion:1,stepId:expect.any(String)})));expect(own.every(row=>!row.canEditPrice&&row.secondaryCraftEntry&&row.assignment.priceAssigneeId===worker.actorId)).toBe(true);
  for(const [index,row]of own.entries()){
   await approveFixtureCraftPrice(quotes,worker,approver,resource,row.rowId,String(index+3));
   quote=await quotes.read(worker,resource);
  }
  expect(quote.rows.filter(row=>own.some(own=>own.rowId===row.rowId)).map(row=>row.unitPrice)).toEqual(['3','4']);
  expect(quote.rows.some(row=>row.name==='IE加工单价')).toBe(false);
  const ie=(await quotes.read(f.root,resource)).rows.find(row=>row.name==='IE加工单价')!;
  await expect(quotes.fillRow(worker,resource,ie.rowId,{expectedVersion:quote.version,unitPrice:'99'},randomUUID())).rejects.toMatchObject({statusCode:403});

  // Confirmed quote provenance follows the original conversion, without folding
  // special-craft fees into the separate garment-factory contract price.
  let full=await quotes.read(f.root,resource);
  full=await quotes.save(f.root,resource,{expectedVersion:full.version,document:full.document!,assignments:full.assignments.map(a=>a.rowId===ie.rowId?{...a,priceAssigneeId:f.people.ie!.actorId}:a)},randomUUID());
  for(const row of full.rows){
   if(own.some(value=>value.rowId===row.rowId))continue;
   full=await quotes.fillRow(f.root,resource,row.rowId,{expectedVersion:full.version,...(row.section!=='外发工序'?{consumption:'1.5'}:{}),unitPrice:row.section==='外发工序'?'10':'20'},randomUUID());
  }
  expect(full.complete).toBe(true);
  const confirmedVersion=full.version;
  await quotes.confirm(f.root,resource,{expectedVersion:confirmedVersion,customerCode:'PD',customerConfirmedTotal:'50',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST customer confirmed 50; cost 47',confirmedAt:businessNow().toISOString()},randomUUID());
  const identity=new DigitalProductionIdentityService(f.db,true),source=(await f.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[resource.id])).rows[0];
  const order=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:source.design_style_no,orderDate:'2026-11-13',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:100}]}]}),randomUUID(),resource.id);
  const budget=await new DigitalBudgetService(f.db,true).read(f.root,order.productionOrderId);
  expect(budget.comparison).toMatchObject({quoteVersion:confirmedVersion,budgetComparableTotal:'47',confirmedQuoteTotal:'50'});
  expect(budget.document!.outsourcingUnitPrice).toBe('');
  expect(budget.document!.rows.filter(row=>own.some(value=>value.rowId===row.rowId)).map(row=>row.unitPrice)).toEqual(['3','4']);
  const first=steps[0]!.specialCraft!;
  await library.save(f.root,{id:first.id,expectedVersion:first.version,definition:{...first.definition,name:'TEST renamed',enabled:false}},randomUUID());
  const history=await quotes.read(f.root,resource,undefined,confirmedVersion);
  expect(history.rows.filter(row=>row.craftBasis).map(row=>[row.name,row.unitPrice,row.craftBasis!.libraryVersion])).toEqual([['TEST 激光','3',1],['TEST 烫钻','4',1]]);
  expect((await new DigitalBudgetService(f.db,true).read(f.root,order.productionOrderId)).document).toEqual(budget.document);
  const frozenJourney=await journey.read(f.root,order.productionOrderId);expect(frozenJourney.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===nativeRows[0]!.task_id)?.label).toContain('TEST 激光');expect(JSON.stringify(frozenJourney.stages)).not.toContain('TEST renamed');

  const instructions=new ProductionInstructionService(f.db,true),seed=await instructions.read(f.root,order.productionOrderId);
  expect(seed.document.craftSteps?.[0]?.specialCraft).toEqual(first);
  const bulkOnly=await library.save(f.root,{id:null,expectedVersion:0,definition:{name:'TEST 仅大货压花',enabled:true,development:{minutes:30,calendar:'continuous',reminder:{enabled:false,percent:70}},bulk:{minutes:90,calendar:'continuous',reminder:{enabled:true,percent:70}}}},randomUUID());
  const instruction=await instructions.save(f.root,order.productionOrderId,{expectedVersion:0,orderVersion:seed.currentOrderVersion,sourceRound:1,document:{...seed.document,secondaryCraft:'特殊工艺',craftSteps:[...steps,{craftKind:'special',sequence:3,specialCraft:bulkOnly}],styleName:'TEST frozen source',category:'上衣',preshrink:'不需预缩',date:'2026-11-13'}},randomUUID());
  const readyBasis=await productionReadinessFixture(f.db,f.root,order.productionOrderId,worker.actorId,f.people.warehouse!);
  const published=await instructions.publish(f.root,order.productionOrderId,{expectedVersion:instruction.version,orderVersion:instruction.currentOrderVersion,expectedReadinessRevision:readyBasis.revision},randomUUID());
  expect(published.publishedVersion).toBe(instruction.version);
  expect(published.document.craftSteps?.[0]?.specialCraft).toEqual(first);

  // Bulk uses its own price/assignee, while the confirmed development quote
  // and the already-created budget remain unchanged.
  const bulkResource={kind:'order' as const,id:order.productionOrderId};
  let bulkQuote=await quotes.read(f.root,bulkResource);
  const bulkRows=bulkQuote.rows.filter(row=>row.craftBasis?.stage==='bulk');
  expect(bulkRows).toHaveLength(3);
  expect(bulkRows.every(row=>row.unitPrice===''&&row.assignment.priceAssigneeId===null)).toBe(true);
  expect(bulkQuote.priorCraftRows?.map(value=>[value.row.name,value.row.unitPrice])).toEqual(expect.arrayContaining([['TEST 激光','3'],['TEST 烫钻','4']]));
  await expect(quotes.save(f.root,bulkResource,{expectedVersion:bulkQuote.version,document:bulkQuote.document!,assignments:bulkQuote.assignments.map(a=>bulkRows.some(row=>row.rowId===a.rowId)?{...a,priceAssigneeId:f.people.ie!.actorId}:a)},randomUUID())).rejects.toMatchObject({statusCode:409});
  bulkQuote=await quotes.save(f.root,bulkResource,{expectedVersion:bulkQuote.version,document:bulkQuote.document!,assignments:bulkQuote.assignments.map(a=>bulkRows.some(row=>row.rowId===a.rowId)?{...a,priceAssigneeId:worker.actorId}:a)},randomUUID());
  const notifications=new DigitalProductionNotificationService(f.db);
  expect((await notifications.todos(worker)).filter(todo=>bulkRows.some(row=>row.rowId===todo.todoId))).toHaveLength(3);
  for(const [index,row] of bulkRows.entries()){
   const ownBulk=await quotes.read(worker,bulkResource);
   expect(ownBulk.rows.some(value=>value.name==='IE加工单价')).toBe(false);
   await approveFixtureCraftPrice(quotes,worker,approver,bulkResource,row.rowId,String(7+index*2));
  }
  expect((await notifications.todos(worker)).filter(todo=>bulkRows.some(row=>row.rowId===todo.todoId))).toHaveLength(0);
  expect((await quotes.read(f.root,bulkResource)).complete).toBe(true);
  expect((await new DigitalBudgetService(f.db,true).read(f.root,order.productionOrderId)).document).toEqual(budget.document);
  expect((await quotes.read(f.root,resource,undefined,confirmedVersion)).rows.filter(row=>row.craftBasis).map(row=>row.unitPrice)).toEqual(['3','4']);
  const pricedBulk=await quotes.read(f.root,bulkResource);
  await quotes.confirm(f.root,bulkResource,{expectedVersion:pricedBulk.version,customerCode:'PD',customerConfirmedTotal:'70',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST bulk customer confirmed 70; cost 67',confirmedAt:businessNow().toISOString()},randomUUID());
  const budgets=new DigitalBudgetService(f.db,true);
  const unchangedBudget=await budgets.read(f.root,order.productionOrderId);
  expect(unchangedBudget.document).toEqual(budget.document);
  await budgets.adoptQuotation(f.root,order.productionOrderId,{expectedVersion:unchangedBudget.version,sourceQuoteVersion:pricedBulk.version},randomUUID());
  const adoptedBudget=await budgets.read(f.root,order.productionOrderId);
  const revisedBudget=await budgets.save(f.root,order.productionOrderId,{expectedVersion:adoptedBudget.version,document:pricedBulk.document!},randomUUID());
  expect(revisedBudget.comparison).toMatchObject({quoteVersion:pricedBulk.version,budgetComparableTotal:'67',confirmedQuoteTotal:'70'});
  expect(revisedBudget.document!.outsourcingUnitPrice).toBe('');


  const rows=(await f.db.query("SELECT t.state,a.assignee_id,p.step_id,p.phase FROM digital_timeline_task_positions p JOIN digital_production_tasks t USING(task_id) JOIN digital_production_task_access a USING(task_id) WHERE p.adoption_id=$1 AND p.phase IN ('dispatch','work','confirmation') ORDER BY p.route_position",[saved.adoptionId])).rows;
  expect(rows).toHaveLength(6);expect(rows.every(row=>row.state==='completed')).toBe(true);
  expect(new Set(rows.filter(row=>row.phase==='work').map(row=>row.step_id)).size).toBe(2);
  expect(rows.filter(row=>row.phase==='work').map(row=>row.assignee_id)).toEqual([f.people['pattern-room-worker']!.actorId,f.people['pattern-room-worker']!.actorId]);
 });
 it('retains explicitly adopted craft completion when a real later round redoes only sewing',async()=>{
  const standard={minutes:60,calendar:'continuous' as const,reminder:{enabled:false,percent:70}},library=new SpecialCraftLibraryService(f.db),craft=await library.save(f.root,{id:null,expectedVersion:0,definition:{name:'TEST inherited special',enabled:true,development:standard,bulk:standard}},randomUUID());
  const created=await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,f.people['pattern-room-worker']!.actorId,undefined,[['特殊工艺','免洗']],{fixedCraftSteps:[{craftKind:'embroidery',sequence:1},{craftKind:'special',sequence:2,specialCraft:craft}]}),sid=created[0]!.sourceId;
  const time=()=>({now:businessNow().toISOString(),scenarioId:null,revision:0}),before=(await developmentSlaEvidence(f.db,sid,time()))!;
  const forms=new DigitalDevelopmentService(f.db,true),sheet=await forms.read(f.root,sid),native=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true}),rounds=new DevelopmentRoundService(f.db,true,native);
  const draft=await rounds.save(f.root,sid,{expectedDraftVersion:0,revision:{basedOnRound:1,document:sheet.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST only sewing redo',explanation:'TEST preserve original craft facts',categories:['车缝'],affectedNodes:['车板'],outputKind:'整件样板'}},randomUUID());
  await rounds.publish(f.root,sid,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID());
  const adopted=(await f.db.query('SELECT inherited,route_nodes FROM digital_development_rounds WHERE source_id=$1 AND round_number=2',[sid])).rows[0];
  expect(adopted.route_nodes).not.toContain('development_printing');expect(adopted.inherited.development_printing).toMatchObject({taskId:expect.any(String),roundNumber:1});
  const after=(await developmentSlaEvidence(f.db,sid,time()))!;
  for(const key of ['development_printing','development_embroidery','development_craft_return']){expect(after.facts[key]).toMatchObject({businessCompleted:true,completedAt:before.facts[key]!.completedAt});expect(after.facts[key]!.evidence).toContain('adopted:development-round:'+sid+':2');}
  for(const key of Object.keys(before.originalFacts).filter(key=>/^(development_printing|development_embroidery|development_craft_dispatch|development_craft_return)(:|$)/.test(key)))expect(after.originalFacts[key]).toEqual(before.originalFacts[key]);
  for(const old of before.instances)expect(after.instances.find(instance=>instance.taskId===old.taskId&&instance.round===old.round)).toEqual(old);
  const newInstances=after.instances.filter(instance=>!before.instances.some(old=>old.taskId===instance.taskId));
  expect(newInstances).toHaveLength(1);expect(newInstances[0]).toMatchObject({sourceId:sid,taskKind:'development_sewing',round:2,stepRef:null});
  const sewing=(await f.db.query(`SELECT t.entered_at AS physical_entered_at,r.entered_at,r.due_at FROM digital_production_tasks t
   LEFT JOIN LATERAL(SELECT entered_at,due_at FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)r ON true WHERE t.task_id=$1`,[newInstances[0]!.taskId])).rows[0]!;
  // The new round's organization window can precede physical assignment.
  // Match its own captured revision, never a prior round or the task's null handover.
  expect(sewing.physical_entered_at).toBeNull();expect(sewing.entered_at).toBeInstanceOf(Date);expect(sewing.due_at).toBeInstanceOf(Date);
  expect(newInstances[0]!.fact.startedAt).toBe(sewing.entered_at.toISOString());expect(newInstances[0]!.deadline.at).toBe(sewing.due_at.toISOString());
  const current=await new DigitalJourneyQuery(f.db).read(f.root,sid);expect(current.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='development_printing'&&node.current)).toMatchObject({state:'inherited',label:'TEST inherited special（工艺2）'});
 });

 it('keeps built-in printing price and permissions when different artisans start special steps',async()=>{
  const worker=f.people['pattern-room-worker']!,other={...worker,actorId:randomUUID()};
  await f.db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST special quote artisan',true)",[other.actorId]);
  await f.db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)",[randomUUID(),other.actorId,'uat-special-'+other.actorId,'uat-special-union-'+other.actorId]);
  await f.access.assignRole({...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin']},{userId:other.actorId,roleCode:'pattern_room_worker',reason:'TEST isolated craft identity'});
  const library=new SpecialCraftLibraryService(f.db),steps:CraftStepChoice[]=[{craftKind:'printing',sequence:1}];
  for(const [index,name]of ['TEST independent laser','TEST independent stones'].entries()){
   const saved=await library.save(f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:{minutes:60,calendar:'continuous',reminder:{enabled:false,percent:70}},bulk:{minutes:120,calendar:'continuous',reminder:{enabled:false,percent:70}}}},randomUUID());
   steps.push({craftKind:'special',sequence:index+2,specialCraft:saved});
  }
  const quotes=new DigitalQuotationService(f.db,true),approver=await bindFixtureCraftApprover(f);let dispatches=0,printingId='';
  await exerciseDevelopmentSlaNative(f.db,new TodoProjectionService(new TodoService(f.db)),f.root,worker.actorId,undefined,[['特殊工艺','免洗']],{fixedCraftSteps:steps,automaticQuotation:true,onRouteComplete:async(sourceId,kind)=>{
   if(kind!=='development_craft_dispatch')return;
   const resource={kind:'source' as const,id:sourceId};dispatches++;
   if(dispatches===1){
    const quote=await quotes.read(worker,resource),printing=quote.rows.find(row=>row.name==='印花')!;printingId=printing.rowId;
    expect(printing).toMatchObject({canEditPrice:false,secondaryCraftEntry:true});
    await approveFixtureCraftPrice(quotes,worker,approver,resource,printingId,'5');
   }else{
    const pending=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_printing' AND t.state='ready'",[sourceId])).rows[0];
    const execution=new DevelopmentExecutionService(f.db,true),input=await arrangementInput(f.db,execution,f.root,sourceId,worker.actorId);
    input.entries=input.entries.map(entry=>entry.expectedTask?.taskId===pending.task_id?{...entry,assigneeId:other.actorId,reason:'TEST separate special artisan'}:entry);
    await execution.arrange(f.root,sourceId,input,randomUUID());
    const own=await quotes.read(worker,resource),foreign=await quotes.read(other,resource);
    expect(own.rows.find(row=>row.rowId===printingId)).toMatchObject({unitPrice:'5',canEditPrice:false,secondaryCraftEntry:true,assignment:{priceAssigneeId:worker.actorId}});
    expect(foreign.rows.some(row=>row.rowId===printingId&&(row.canEditPrice||row.secondaryCraftEntry))).toBe(false);
    await expect(quotes.fillRow(other,resource,printingId,{expectedVersion:foreign.version,unitPrice:'99'},randomUUID())).rejects.toMatchObject({statusCode:403});
    const special=foreign.rows.find(row=>row.name===steps[dispatches-1]!.specialCraft!.definition.name)!;
    expect(special).toMatchObject({canEditPrice:false,secondaryCraftEntry:true});
    await approveFixtureCraftPrice(quotes,other,approver,resource,special.rowId,String(dispatches));
    expect((await quotes.read(worker,resource)).rows.find(row=>row.rowId===printingId)?.unitPrice).toBe('5');
   }
  }});
  expect(dispatches).toBe(3);
 });
 it('keeps separate bulk clocks and permits dispatch only after the final craft return passes QC',async()=>{
  const library=new SpecialCraftLibraryService(f.db),steps:CraftStepChoice[]=[];
  for(const [index,name]of ['TEST 大货激光','TEST 大货烫钻'].entries()){
   const saved=await library.save(f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:{minutes:60,calendar:'continuous',reminder:{enabled:true,percent:70}},bulk:{minutes:240*(index+1),calendar:'continuous',reminder:{enabled:false,percent:80}}}},randomUUID());
   steps.push({craftKind:'special',sequence:index+1,specialCraft:saved});
  }
  const ready=await f.bulkReady('特殊工艺',undefined,1,f.sourcing,{quantity:100,craftSteps:steps});
  const cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[ready.caseId])).rows;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  for(const cut of cuts)await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:100,attachmentIds:[await f.image(cutter)]},randomUUID());
  const flow=new FactoryFlowService(f.db),tasks=new DigitalProductionTaskService(f.db),read=()=>flow.read(f.root,ready.id);
  const assigned=(await f.db.query("SELECT a.task_id,a.required_role FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind IN ('process_logistics','bulk_qc')",[ready.id])).rows;
  for(const task of assigned){const person=Object.values(f.people).find(person=>person.actorRoles.includes(task.required_role));expect(person).toBeDefined();await tasks.reassign(f.root,task.task_id,person!.actorId,randomUUID());}
  let state=await read();expect(state.craftSteps?.map(step=>step.specialCraft?.definition.name)).toEqual(['TEST 大货激光','TEST 大货烫钻']);
  const lineId=state.lines[0]!.lineId;let prior:string|undefined;
  for(const [index,step]of state.craftSteps!.entries()){
   state=await read();const sendKey=randomUUID(),input={expectedRevision:state.revision,stepRef:step.stepId,kind:'工艺发出' as const,occurredAt:businessNow().toISOString(),supplier:'TEST actual special craft',note:'TEST',lines:[{lineId,quantity:100}],...(prior?{fromReturnId:prior}:{})};
   await flow.logistics(f.root,ready.id,input,sendKey);await flow.logistics(f.root,ready.id,input,sendKey);
   state=await read();const send=state.facts.filter(fact=>fact.kind==='工艺发出'&&fact.payload.stepRef===step.stepId).at(-1)!;
   expect(state.batchWindows?.find(window=>window.stepRef===step.stepId&&window.kind==='process_logistics')).toMatchObject({minutes:240*(index+1),notificationEnabled:false});
   await flow.logistics(f.root,ready.id,{expectedRevision:state.revision,stepRef:step.stepId,kind:'工艺回仓',occurredAt:businessNow().toISOString(),supplier:'TEST',note:'TEST',sendFactId:send.factId,lines:[{lineId,quantity:100}]},randomUUID());
   state=await read();prior=state.facts.filter(fact=>fact.kind==='工艺回仓'&&fact.payload.stepRef===step.stepId).at(-1)!.factId;
   await expect(flow.dispatch(f.root,ready.id,{expectedRevision:state.revision,returnFactId:prior,lines:[{lineId,quantity:1}],supplierId:f.supplierId,note:'TEST no QC'},randomUUID())).rejects.toMatchObject({statusCode:409});
   await flow.qc(f.root,ready.id,{expectedRevision:state.revision,stepRef:step.stepId,returnFactId:prior,note:'TEST',checks:[{lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]}]},randomUUID());
   if(index===0){state=await read();await expect(flow.dispatch(f.root,ready.id,{expectedRevision:state.revision,returnFactId:prior,lines:[{lineId,quantity:1}],supplierId:f.supplierId,note:'TEST intermediate'},randomUUID())).rejects.toMatchObject({statusCode:409});}
  }
  state=await read();await flow.dispatch(f.root,ready.id,{expectedRevision:state.revision,returnFactId:prior!,lines:[{lineId,quantity:100}],supplierId:f.supplierId,note:'TEST terminal'},randomUUID());
  state=await read();expect(state.batchTotals![0]).toMatchObject({quantity:100,sent:100,remaining:0});expect(state.dispatched).toBe(true);
 });

});
